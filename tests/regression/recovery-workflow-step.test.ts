import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, REVIEW_GATE_INPUT_ID } from '@acc/core';
import type { CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { RETRY_NOTE, blockedBanner, type BlockedInput } from '../../apps/web/src/blocked-ui.js';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P0 第三批審查（M-8 過渡，P1-1 outbox 之前）：工作流“已決定下一步、尚未派發”時程序退出。
 *
 * 現象（修復前）：recover 找不到正在工作的會話時回退到 currentAgentId（剛做完實現的 Claude），以 implement 模式“從中斷處繼續”；
 * 真正要派發的測試直到看門狗閾值（預設 15 分鐘）才派發，閾值為 0 時永遠不派發。
 * 決定的是評審閘門 / 完成、WAITING_INPUT / run.completed 還沒落盤就崩潰：重啟後 run 停在 RUNNING，沒有 awaitingAgentId，
 * 看門狗不管，閘門報錯“not waiting for an operator decision”，介面只剩「停止」。
 *
 * 期望：recover 按 workflowState 重新執行當前步驟的指令——有 awaitingAgentId 就把這一步派給它（它重啟前在工作就續接它）；
 * step 是評審閘門而 run 仍是 RUNNING 就補發 WAITING_INPUT，step 是 done 就補發 run.completed。
 *
 * 另附（P0-6 介面）：續接失敗的不是實現者（例如診斷的 Codex）時，阻塞橫幅按“卡住的 agent”處理：
 * 給出“讓實現者自己繼續”，並且不把任務交給那個續接不了的 agent。
 */

const quiet = () => undefined;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-recover-step-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(store: InMemoryControlPlaneStore, options: { inactivityTimeoutMs?: number } = {}) {
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet, ...options });
  const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
  const tester = new ControlledAgent({ id: 'test', kind: 'test', capabilities: ['test'] });
  for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);
  cleanups.push(() => orchestrator.shutdown());
  return { orchestrator, claude, codex, tester };
}

const workflow = (cwd: string, extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({ title: 'fix', prompt: 'Fix the parser crash', agentId: 'claude', testCommand: 'npm test', cwd, ...extra });

describe('recover 按工作流當前步驟重新驅動', () => {
  it('已決定測試、還沒派發就關閉：重啟後直接派發測試，不去“續跑”剛做完實現的 Claude（看門狗關閉時也一樣）', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store, { inactivityTimeoutMs: 0 });
    const task = await first.orchestrator.createTask(workflow(tempWorkspace()));
    await first.orchestrator.idle();
    // 關閉服務之後 Claude 這一輪的完成訊號才被處理：決定了測試步驟，但因為正在關閉而沒有派發
    await first.orchestrator.shutdown();
    await first.claude.complete('implemented');
    await first.orchestrator.idle();
    let run = (await store.getRun(task.runId))!;
    expect(run.workflowState).toMatchObject({ step: 'test', awaitingAgentId: 'test' });
    expect(first.tester.calls).toEqual([]);

    const second = boot(store, { inactivityTimeoutMs: 0 });
    await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(second.claude.calls).toEqual([]);
    expect(second.tester.calls).toHaveLength(1);
    expect(second.tester.calls[0]).toMatchObject({ via: 'start', mode: 'test' });
    run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.workflowState).toMatchObject({ step: 'test', awaitingAgentId: 'test' });
  });

  it('已決定進入評審閘門、WAITING_INPUT 還沒落盤就崩潰：重啟後補上等待，閘門照常可用', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store);
    const task = await first.orchestrator.createTask(workflow(tempWorkspace(), { reviewGate: true }));
    await first.orchestrator.idle();
    await first.claude.complete('implemented');
    await first.orchestrator.idle();
    await first.tester.emit('agent.status', { status: 'completed', testPassed: true, exitCode: 0, outputTail: 'ok' });
    await first.orchestrator.idle();
    // 把快照退回到“決定已經提交、WAITING_INPUT 事件還沒寫入”的樣子（模擬崩潰視窗）
    const run = (await store.getRun(task.runId))!;
    const record = (await store.getTask(task.id))!;
    expect(run.status).toBe('WAITING_INPUT');
    run.status = 'RUNNING';
    run.pendingInputs = [];
    record.status = 'RUNNING';
    await store.commit({ run, task: record });

    const second = boot(store);
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.waiting).toContain(task.runId);
    const after = (await store.getRun(task.runId))!;
    expect(after.status).toBe('WAITING_INPUT');
    expect(after.pendingInputs.map((x) => x.id)).toEqual([REVIEW_GATE_INPUT_ID]);
    await second.orchestrator.resolveGate(task.id, 'accept');
    expect((await store.getRun(task.runId))!.status).toBe('COMPLETED');
  });

  it('已決定完成、run.completed 還沒落盤就崩潰：重啟後補上完成', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store);
    // 沒有測試命令：實現完成就結束
    const task = await first.orchestrator.createTask(workflow(tempWorkspace(), { testCommand: undefined }));
    await first.orchestrator.idle();
    await first.claude.complete('implemented');
    await first.orchestrator.idle();
    // 把快照退回到“工作流已經走到 done、run.completed 還沒寫入”的樣子（模擬崩潰視窗）
    const run = (await store.getRun(task.runId))!;
    const record = (await store.getTask(task.id))!;
    expect(run.workflowState?.step).toBe('done');
    run.status = 'RUNNING';
    record.status = 'RUNNING';
    await store.commit({ run, task: record });

    const second = boot(store);
    await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect((await store.getRun(task.runId))!.status).toBe('COMPLETED');
    expect(second.claude.calls).toEqual([]);
  });
});

describe('阻塞橫幅：續接失敗的是診斷 / 評審的 agent', () => {
  const AGENTS = [
    { id: 'claude', name: 'Claude', kind: 'claude' },
    { id: 'codex', name: 'Codex', kind: 'codex' },
    { id: 'test', name: 'Test Runner', kind: 'test' },
  ];

  it('Codex 續接時工作目錄對不上：給出“讓 Claude 自己繼續”，不列出「換 Codex 接手」', () => {
    const input: BlockedInput = {
      task: { currentAction: 'Codex resumed thread in another directory' },
      run: {
        status: 'BLOCKED',
        currentStep: 'blocked:ADAPTER_RESUME_FAILED',
        blockedBy: { source: 'runtime', code: 'ADAPTER_RESUME_FAILED', agentId: 'codex' },
        workflowState: { step: 'rescue', agents: { implement: 'claude', review: 'codex', test: 'test' } },
      },
      events: [{ type: 'runtime.error', agentId: 'codex', data: { code: 'ADAPTER_RESUME_FAILED', classifiedAs: 'CODEX_RESUME_CWD_MISMATCH' } }],
      agents: AGENTS,
    };
    const banner = blockedBanner(input)!;
    expect(banner.reason).toContain('Codex');
    const kinds = banner.actions.map((a) => (a.agentId ? `${a.kind}:${a.agentId}` : a.kind));
    expect(kinds).toEqual(['retry', 'stop']);
    expect(banner.actions[0]!.label).toContain('Claude');
    expect(banner.actions[0]!.note).not.toBe(RETRY_NOTE);
    expect(banner.actions[0]!.note).toContain('Codex');
  });

  it('續接失敗的就是實現者：仍然只給換人接手和停止（重試註定失敗）', () => {
    const input: BlockedInput = {
      task: {},
      run: {
        status: 'BLOCKED',
        currentStep: 'blocked:ADAPTER_RESUME_FAILED',
        blockedBy: { source: 'runtime', code: 'ADAPTER_RESUME_FAILED', agentId: 'claude' },
        workflowState: { step: 'implement', agents: { implement: 'claude', review: 'codex', test: 'test' } },
      },
      events: [{ type: 'runtime.error', agentId: 'claude', data: { code: 'ADAPTER_RESUME_FAILED', classifiedAs: 'RESUME_CWD_MISSING' } }],
      agents: AGENTS,
    };
    const banner = blockedBanner(input)!;
    expect(banner.actions.map((a) => (a.agentId ? `${a.kind}:${a.agentId}` : a.kind))).toEqual(['reassign:codex', 'stop']);
  });
});
