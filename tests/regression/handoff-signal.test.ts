import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P0-6（H-9）：工作流裡 agent 主動請求交接時，完成訊號不能丟。
 *
 * 復現（probe 場景 1）：request_handoff 立即返回，agent 把這一輪做完。編排器對工作流任務一律生成審批，run 進入 WAITING_APPROVAL，
 * 這時到達的 agent.status completed 被直接丟棄（onAgentSignal 只在 RUNNING 時處理）。
 * - 批准：codex 以 review 模式啟動，它的完成訊號因為 awaiting 對不上而被忽略；
 * - 拒絕：狀態回到 RUNNING，但沒有任何東西去推進工作流。
 * 兩種結果都是 status=RUNNING、step=implement、測試呼叫次數為 0。
 *
 * 期望：WAITING_APPROVAL 期間，正在等待的那個 agent 的完成 / 失敗訊號連同 stepSeq 快取下來（持久化在快照裡），
 * 審批結束、run 回到 RUNNING 後重放；步驟已經變了（stepSeq 不同）就丟棄。無論批准還是拒絕，工作流都繼續推進。
 */

const quiet = () => undefined;
const TASK: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test' };

function boot(store = new InMemoryControlPlaneStore()) {
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }, [{ kind: 'handoff', to: 'codex', instruction: 'Take a look at my change' }]);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'Looks fine.\nVERDICT: ACCEPT' });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);
  return { store, orchestrator, claude, codex, tester };
}

describe('H-9：交接審批期間完成訊號不丟（probe 場景 1）', () => {
  it('批准交接：Codex 收到轉交內容，工作流照常推進到測試並完成', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    const approval = run.pendingApprovals[0]!;
    expect(approval.payload).toMatchObject({ kind: 'handoff', fromAgentId: 'claude', toAgentId: 'codex' });

    await env.orchestrator.resolveApproval(task.id, approval.id, 'approve');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(env.tester.calls).toHaveLength(1);
    expect(env.codex.calls).toHaveLength(1);
    expect(env.codex.calls[0]).toMatchObject({ via: 'start', mode: 'review' });
    expect(env.codex.calls[0]?.prompt).toContain('at the request of claude, approved by the operator');
    expect(run.workflowState?.history.map((h) => h.outcome)).toEqual(['implementation turn completed', 'tests passed']);
  });

  it('拒絕交接：不交接，工作流照常推進到測試並完成', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const approvalId = (await env.store.getRun(task.runId))!.pendingApprovals[0]!.id;

    await env.orchestrator.resolveApproval(task.id, approvalId, 'decline');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(env.tester.calls).toHaveLength(1);
    expect(env.codex.calls).toHaveLength(0);
  });

  it('快取的訊號持久化在快照裡：重啟之後再處理交接審批，工作流照樣繼續', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store);
    const task = await first.orchestrator.createTask(TASK);
    await first.orchestrator.idle();
    const approvalId = (await store.getRun(task.runId))!.pendingApprovals[0]!.id;
    expect((await store.getRun(task.runId))!.workflowState?.deferredSignal).toMatchObject({ kind: 'agent-completed', agentId: 'claude' });

    // 模擬程序重啟：新的編排器與 adapter，同一個儲存
    const second = boot(store);
    const report = await second.orchestrator.recover();
    expect(report.waiting).toEqual([task.runId]);
    await second.orchestrator.resolveApproval(task.id, approvalId, 'decline');
    await second.orchestrator.idle();
    const run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(second.tester.calls).toHaveLength(1);
    expect(run.workflowState?.deferredSignal).toBeUndefined();
  });
});

describe('H-9：等待別的審批期間，工作流正在等的 agent 完成了', () => {
  it('完成訊號快取下來，審批結束回到 RUNNING 後重放，工作流繼續', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
    for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);

    const task = await orchestrator.createTask(TASK);
    await orchestrator.idle();
    // 操作員另外問了 Codex 一句，Codex 需要審批才能繼續
    await orchestrator.sendMessage(task.id, 'codex', 'What do you think about the plan?');
    await codex.emit('approval.required', { approvalId: 'codex-approval-1', toolName: 'shell', toolInput: { command: 'ls' }, summary: 'List files' }, codex.sessionId, 'warning');
    await orchestrator.idle();
    expect((await store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');

    // 這期間 Claude（工作流正在等它）把實現做完了
    await claude.complete('Implemented the fix.');
    await orchestrator.idle();
    let run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    expect(run.workflowState?.step).toBe('implement');
    expect(tester.calls).toHaveLength(0);

    await orchestrator.resolveApproval(task.id, 'codex-approval-1', 'approve');
    await orchestrator.idle();
    run = (await store.getRun(task.runId))!;
    expect(codex.approvals).toMatchObject([{ approvalId: 'codex-approval-1', decision: 'approve' }]);
    expect(run.status).toBe('COMPLETED');
    expect(tester.calls).toHaveLength(1);
  });

  it('步驟已經變了（例如換人接手）：快取的舊訊號被丟棄，不會把新步驟當成已完成', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
    for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);

    const task = await orchestrator.createTask(TASK);
    await orchestrator.idle();
    await claude.emit('approval.required', { approvalId: 'claude-approval-1', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, summary: 'Remove build' }, claude.sessionId, 'warning');
    await claude.complete();
    await orchestrator.idle();
    expect((await store.getRun(task.runId))?.workflowState?.deferredSignal).toMatchObject({ agentId: 'claude' });

    // 操作員拒絕了這個操作（run 進入 BLOCKED），然後換 Codex 接手：步驟重新開始
    await orchestrator.resolveApproval(task.id, 'claude-approval-1', 'decline');
    await orchestrator.reassign(task.id, 'codex');
    await orchestrator.idle();
    const run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.workflowState).toMatchObject({ step: 'implement', awaitingAgentId: 'codex' });
    expect(run.workflowState?.deferredSignal).toBeUndefined();
    expect(tester.calls).toHaveLength(0);
  });
});
