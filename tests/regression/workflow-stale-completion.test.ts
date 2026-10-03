import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ClaudeQueryDriver } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P0 第三批審查：舊一輪的完成被當成新派發的完成（M-1 的緩解，P1-3 之前）。
 *
 * 現象（修復前）：
 * - 工作流裡批准 agent 的交接請求：交接內容單獨投遞給實現者，H-9 快取的完成訊號重放後工作流又把 fix 信封派給它——
 *   同一個 agent 收到兩條訊息，第一輪的完成就被當成 fix 完成，測試跑在半成品上；沒有評審閘門時直接 COMPLETED，
 *   實現者的第二輪還在可寫模式下改檔案，沒人停止它（工作流自己 complete 時不停止線上會話）；
 * - 拒絕審批後任務 BLOCKED，但 Claude 還在收尾這一輪（M-18）；一鍵「重試」的說明排在這一輪後面，
 *   舊一輪一結束就被當成重試完成；評審閘門上問 Claude 問題之後按「帶說明重試」同理。
 *
 * 期望：
 * - 工作流任務裡，交接目標是工作流正在等 / 接下來要派發的 agent 時，轉交內容併入工作流下一次給它的信封（只派發一次）；
 * - 工作流自己完成時，和「接受結果」一樣停止全部線上會話；
 * - 人工閘門 / 橫幅重試派發之前，目標 agent 還有進行中的一輪就先停掉它（它的待審批一併作廢），再派發。
 */

const quiet = () => undefined;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-stale-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(agents: { claude?: AgentAdapter; codex?: AgentAdapter; tester?: WorkflowAgent } = {}) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const claude = agents.claude ?? new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = agents.codex ?? new ControlledAgent({ id: 'codex', kind: 'codex' });
  const tester = agents.tester ?? new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);
  const rec = busRecorder(bus);
  cleanups.push(async () => {
    rec.dispose();
    await orchestrator.shutdown();
  });
  return { store, bus, orchestrator, claude, codex, tester, rec };
}

const workflow = (cwd: string, extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({ title: 'fix', prompt: 'Fix the parser crash', agentId: 'claude', testCommand: 'npm test', cwd, ...extra });

describe('工作流裡批准交接請求：實現者只被派發一次', () => {
  it('rescue 裡 Codex 請求交給 Claude：批准後 Claude 只收到一條訊息（fix 信封裡帶上轉交內容），它完成之後才測試', async () => {
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [{ kind: 'test', passed: false }, { kind: 'test', passed: false }], { kind: 'test', passed: true });
    const env = boot({ tester });
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    await claude.complete('first attempt');
    await env.orchestrator.idle();
    await claude.complete('second attempt');
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.workflowState).toMatchObject({ step: 'rescue', awaitingAgentId: 'codex' });

    // Codex（診斷）請求把修復交給 Claude，然後把這一輪做完
    await codex.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'claude', instruction: 'Apply the null check in parser.ts', content: 'Root cause: parse() dereferences a missing token' });
    await env.orchestrator.idle();
    await codex.complete('Diagnosis: parse() dereferences a missing token.');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    const approval = run.pendingApprovals[0]!;

    const before = claude.calls.length;
    await env.orchestrator.resolveApproval(task.id, approval.id, 'approve');
    await env.orchestrator.idle();
    const added = claude.calls.slice(before);
    expect(added).toHaveLength(1);
    // 轉交的內容（agent 寫的，屬於資料）在 fix 信封的資料區塊裡
    const lines = added[0]!.prompt.split('\n');
    expect(lines).toContain('| Apply the null check in parser.ts');
    expect(lines).toContain('| Root cause: parse() dereferences a missing token');
    run = (await env.store.getRun(task.runId))!;
    expect(run.workflowState).toMatchObject({ step: 'fix', awaitingAgentId: 'claude' });
    expect(env.tester.calls).toHaveLength(2);
    const events = await env.store.listEvents(task.runId);
    expect(events.some((e) => e.type === 'runtime.warning' && e.data.code === 'HANDOFF_MERGED_INTO_WORKFLOW')).toBe(true);

    await claude.complete('fixed');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(env.tester.calls).toHaveLength(3);
  });

  it('實現者在做這一步時，別的 agent 請求交給它：同樣不另外派發（併入它下一次的工作流信封）', async () => {
    const env = boot();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    // 操作員問了 Codex 一句；Codex 請求把工作交給正在實現的 Claude
    await env.orchestrator.sendMessage(task.id, 'codex', 'Any concerns?');
    await codex.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'claude', instruction: 'Also handle empty input', content: 'empty input crashes' });
    await env.orchestrator.idle();
    const approval = (await env.store.getRun(task.runId))!.pendingApprovals[0]!;
    const before = claude.calls.length;
    await env.orchestrator.resolveApproval(task.id, approval.id, 'approve');
    await env.orchestrator.idle();
    expect(claude.calls.slice(before)).toEqual([]);
    expect((await env.store.getRun(task.runId))!.workflowState?.pendingHandoffs).toHaveLength(1);
  });
});

describe('工作流自己完成時停止全部線上會話', () => {
  it('測試通過、任務 COMPLETED：操作員另外問過的 Codex 還在工作，也被停下', async () => {
    const env = boot();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'codex', 'Please look at the tests too');
    await env.orchestrator.idle();
    await claude.complete('done');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('COMPLETED');
    expect(codex.cancelled).toHaveLength(1);
    expect(claude.cancelled).toHaveLength(1);
  });
});

describe('人工閘門 / 橫幅重試之前先停掉目標 agent 進行中的一輪', () => {
  it('真實 Claude adapter：拒絕審批後 Claude 仍在收尾，一鍵「重試」先停掉舊的一輪，舊一輪的結果不會被當成重試完成', async () => {
    const driver = new ClaudeQueryDriver();
    const claude = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet });
    const env = boot({ claude });
    const creating = env.orchestrator.createTask(workflow(tempWorkspace()));
    const q1 = await driver.query(1);
    q1.init();
    const task = await creating;
    await q1.nextPrompt();

    // Claude 請求執行命令，操作員拒絕：任務 BLOCKED，但 Claude 這一輪還在進行
    const permission = q1.options.canUseTool!('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'toolu-1', requestId: 'r' } as never);
    await env.rec.waitFor((e) => e.type === 'approval.required');
    await env.orchestrator.idle();
    const approvalId = (await env.store.getRun(task.runId))!.pendingApprovals[0]!.id;
    await env.orchestrator.resolveApproval(task.id, approvalId, 'decline');
    await env.orchestrator.idle();
    expect((await permission)?.behavior).toBe('deny');
    expect((await env.store.getRun(task.runId))!.status).toBe('BLOCKED');

    const gating = env.orchestrator.resolveGate(task.id, 'retry', 'Please continue: skip the cleanup step.');
    const first = await Promise.race([driver.query(2).then(() => 'resumed' as const), gating.then(() => 'gate-returned' as const)]);
    expect(first).toBe('resumed');
    // 舊的一輪被停掉了（CLI 被中止），它遲到的結果不會再被當成任何一步的完成
    expect(q1.options.abortController?.signal.aborted).toBe(true);
    q1.text('old turn wrapping up');
    q1.result();
    const q2 = await driver.query(2);
    q2.init();
    await gating;
    await env.orchestrator.idle();
    expect(env.tester.calls).toHaveLength(0);
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');

    const prompt = await q2.nextPrompt();
    expect(prompt).toContain('Please continue: skip the cleanup step.');
    q2.text('retried');
    q2.result();
    await env.rec.waitFor((e) => e.type === 'run.completed');
    await env.orchestrator.idle();
    expect(env.tester.calls).toHaveLength(1);
  });

  it('評審閘門上問了 Claude 一句（還在回答），接著「帶說明重試」：先停掉回答的那一輪，再派發重試', async () => {
    const env = boot();
    const claude = env.claude as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace(), { reviewGate: true }));
    await env.orchestrator.idle();
    await claude.complete('implemented');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('WAITING_INPUT');

    await env.orchestrator.sendMessage(task.id, 'claude', 'Why did you rename foo?');
    await env.orchestrator.idle();
    const before = claude.calls.length;
    await env.orchestrator.resolveGate(task.id, 'retry', 'rename foo to bar');
    await env.orchestrator.idle();
    expect(claude.cancelled).toHaveLength(1);
    const retry = claude.calls.slice(before);
    expect(retry).toHaveLength(1);
    expect(retry[0]!.via).toBe('resume');
    expect(retry[0]!.prompt).toContain('rename foo to bar');
    expect(env.tester.calls).toHaveLength(1);
  });

  it('等待審批時另一個 agent 被安全策略攔下，按「重試」：實現者的舊審批作廢、舊的一輪停掉，任務回到 RUNNING 時沒有殘留的待審批', async () => {
    const env = boot();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    await claude.emit('approval.required', { approvalId: 'appr-1', toolName: 'Bash', toolInput: { command: 'ls' }, summary: 'List' }, claude.sessionId, 'warning');
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'codex', 'check the logs');
    await codex.emit('safety.blocked', { code: 'CODEX_CYBER_POLICY', action: 'Blocked by provider policy' }, codex.sessionId, 'critical');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!).toMatchObject({ status: 'BLOCKED', pendingApprovals: [{ id: 'appr-1' }] });

    await env.orchestrator.resolveGate(task.id, 'retry', 'Try again');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.pendingApprovals).toEqual([]);
    expect(claude.cancelled).toHaveLength(1);
    const approval = await env.store.getApproval('appr-1');
    expect(approval?.status).toBe('declined');
  });
});
