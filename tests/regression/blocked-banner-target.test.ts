import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { RETRY_NOTE, blockedBanner, type BlockedInput } from '../../apps/web/src/blocked-ui.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';

/**
 * P0 第二批審查（P0-6 介面）：BLOCKED 橫幅的一鍵出路要針對真正失敗 / 卡住的那個 agent 和那一步。
 *
 * 復現（修復前）：測試失敗 → 自動 retry 仍失敗 → rescue（Codex 診斷）時 Codex 登入失效（CODEX_UNAUTHORIZED）→ BLOCKED。
 * 橫幅寫“請先在終端機重新登入 Codex，再按「重試」”，可「重試」總是派給實現者 Claude 的 retry 步驟：
 * 使用者照做之後 Codex 再也不會被呼叫（retry 和 rescue 額度都用掉了，測試一失敗就 TESTS_FAILED）。
 * 另一個按鈕「換 Codex 接手」把實現交給剛剛失敗的那個 agent。看門狗在診斷步驟判定 Codex 卡住時一樣；
 * STEP_INACTIVE 的文案固定寫“自動重啟和請人診斷之後”，即使根本沒有重啟過或診斷過。
 *
 * 期望：失敗 / 卡住的是評審或診斷的 agent 時，「重試」重跑那一步（人工閘門的 rerun），並提供“讓實現者自己繼續”的出路；
 * 「換 X 接手」不列出失敗的那個 agent；STEP_INACTIVE 文案按實際經過（有沒有自動重啟、有沒有請人診斷）來寫。
 */

const quiet = () => undefined;
const AGENTS = [
  { id: 'claude', name: 'Claude', kind: 'claude' },
  { id: 'codex', name: 'Codex', kind: 'codex' },
  { id: 'test', name: 'Test Runner', kind: 'test' },
];

function boot(adapters: AgentAdapter[]) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, orchestrator };
}

const kinds = (banner: ReturnType<typeof blockedBanner>) => banner?.actions.map((a) => (a.agentId ? `${a.kind}:${a.agentId}` : a.kind));

describe('診斷的 agent 失敗：「重試」重跑診斷，不派給實現者', () => {
  it('Codex 診斷時登入失效 → 橫幅讓使用者重新登入 Codex 再按「重試」，重試真的會再請 Codex 診斷', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }, [], { kind: 'reply', text: 'tried a fix' });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [{ kind: 'fail', code: 'CODEX_UNAUTHORIZED', retryable: false }], { kind: 'reply', text: 'Root cause: off-by-one in parse()' });
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: false });
    const env = boot([claude, codex, tester]);
    const task = await env.orchestrator.createTask({ title: 'fix', prompt: 'Fix the parser', agentId: 'claude', testCommand: 'npm test' });
    await env.orchestrator.idle();

    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.workflowState).toMatchObject({ step: 'rescue', lastError: { agentId: 'codex', code: 'CODEX_UNAUTHORIZED' } });
    const input: BlockedInput = { task: (await env.store.getTask(task.id))!, run: run as unknown as BlockedInput['run'], events: await env.store.listEvents(task.runId), agents: AGENTS };
    const banner = blockedBanner(input)!;
    expect(banner.reason).toContain('Codex');
    expect(banner.reason).toContain('再按「重試」');
    expect(kinds(banner)).toEqual(['rerun', 'retry', 'stop']);
    expect(banner.actions[0]).toMatchObject({ label: '重試', note: RETRY_NOTE });
    expect(banner.actions[0]?.title).toContain('Codex');
    expect(banner.actions[1]?.label).toContain('Claude');

    // 使用者重新登入 Codex 之後按「重試」：再請 Codex 診斷（唯讀），之後照常由 Claude 按診斷修復
    const codexCalls = codex.calls.length;
    await env.orchestrator.resolveGate(task.id, 'rerun', RETRY_NOTE);
    await env.orchestrator.idle();
    expect(codex.calls).toHaveLength(codexCalls + 1);
    expect(codex.calls.at(-1)?.prompt).toContain('Do NOT modify any files');
    run = (await env.store.getRun(task.runId))!;
    expect(run.workflowState?.history.some((h) => h.step === 'fix')).toBe(true);
    // 評審輪次不因為重跑而被消耗
    expect(run.budget.reviewRoundsUsed).toBe(0);
  });

  it('沒有可以重跑的步驟（評審閘門）：rerun 返回 409 類錯誤，什麼都不派發', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
    const env = boot([claude, tester]);
    const task = await env.orchestrator.createTask({ title: 'fix', prompt: 'p', agentId: 'claude', testCommand: 'npm test', reviewGate: true });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('WAITING_INPUT');
    await expect(env.orchestrator.resolveGate(task.id, 'rerun')).rejects.toMatchObject({ statusCode: 409 });
    expect((await env.store.getRun(task.runId))?.status).toBe('WAITING_INPUT');
  });
});

function stalled(events: BlockedInput['events'], step = 'rescue'): BlockedInput {
  return {
    task: { currentAction: 'blocked' },
    run: {
      status: 'BLOCKED',
      currentStep: 'workflow:STEP_INACTIVE',
      blockedBy: { source: 'workflow', code: 'STEP_INACTIVE' },
      workflowState: { step, agents: { implement: 'claude', review: 'codex', test: 'test' } },
    },
    events,
    agents: AGENTS,
  };
}

const STALL = (agentId: string, step: string, next: string) => ({ type: 'runtime.error', agentId, data: { code: 'STEP_INACTIVITY_TIMEOUT', step, thresholdMs: 900_000, next } });

describe('看門狗阻塞的橫幅：按實際經過描述，出路針對卡住的 agent', () => {
  it('Claude 卡住 → 重啟 → 請 Codex 診斷 → Codex 也卡住：說明是 Codex 在診斷時卡住；「重試」重跑診斷，不列出「換 Codex 接手」', () => {
    const banner = blockedBanner(stalled([STALL('claude', 'implement', 'retry'), STALL('claude', 'implement', 'rescue'), STALL('codex', 'rescue', 'blocked')]))!;
    expect(banner.reason).toContain('Codex');
    expect(banner.reason).toContain('15 分鐘');
    expect(kinds(banner)).toEqual(['rerun', 'retry', 'stop']);
  });

  it('實現者卡住、重啟過一次、評審者就是同一個 agent（沒有診斷）：文案不寫“請人診斷”', () => {
    const input = stalled([STALL('claude', 'implement', 'retry'), STALL('claude', 'implement', 'blocked')], 'implement');
    input.run.workflowState!.agents.review = 'claude';
    const banner = blockedBanner(input)!;
    expect(banner.reason).toContain('自動重啟之後仍然沒有恢復');
    expect(banner.reason).not.toContain('診斷');
    expect(kinds(banner)).toEqual(['retry', 'reassign:codex', 'stop']);
  });

  it('實現者卡住、重啟過、也請人診斷過：文案如實寫出', () => {
    const banner = blockedBanner(
      stalled([STALL('claude', 'implement', 'retry'), STALL('claude', 'implement', 'rescue'), STALL('claude', 'fix', 'retry'), STALL('claude', 'fix', 'blocked')], 'fix'),
    )!;
    expect(banner.reason).toMatch(/自動重啟和請 Codex 診斷之後仍然沒有恢復/);
    expect(kinds(banner)).toEqual(['retry', 'reassign:codex', 'stop']);
  });
});
