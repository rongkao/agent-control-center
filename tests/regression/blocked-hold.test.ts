import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, ORCHESTRATOR_REACTION_FAILED, Orchestrator, projectEvent, summarizeTask } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { makeEvent, makeRun, makeTask } from '../helpers.js';
import { deferred } from './fakes/deferred.js';
import { busRecorder } from './fakes/event-waiter.js';
import { GatedAgent } from './fakes/gated-agent.js';

/**
 * P0-2 審查問題：編排器出錯後的 BLOCKED 必須“保持住”。
 *
 * 現象（修復前）：編排反應失敗 → run 進入 BLOCKED（ORCHESTRATOR_REACTION_FAILED），但 Claude 會話按設計繼續這一輪；
 * 同一輪裡它再請求一次普通審批，操作員批准後 approval.resolved 的投影把 BLOCKED 直接改回 RUNNING，
 * 這一輪結束後工作流就推進到了 test 步驟——操作員從來沒有對“編排器出錯”做過閘門決定。
 * 另外，阻塞原因寫在 task.currentAction 裡，會被 agent 之後的普通事件覆蓋成“Turn completed; waiting for orchestrator”。
 *
 * 期望：離開 BLOCKED 只能透過人工閘門（resolveGate）、換人接手或停止；審批只移除那條待審批，不改變 BLOCKED；
 * 阻塞原因在 BLOCKED 期間不被 agent 的普通事件覆蓋。
 */

const quiet = () => undefined;

/** Claude（真實 adapter + 假執行時）負責實現、GatedAgent 負責測試的工作流環境；預算反應在看到第一個 tool.started 後拋一次異常。 */
function boot(script: ConstructorParameters<typeof FakeClaudeRuntime>[1]) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), script);
  const tester = new GatedAgent({ id: 'test', kind: 'test', capabilities: ['test'] });
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
  orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet }));
  orchestrator.registerAdapter(tester);
  orchestrator.registerAdapter(codex);

  // 注入一個編排器 bug：預算反應在看到第一個 tool.started 之後拋一次異常
  let sawTool = false;
  bus.subscribe((event) => {
    if (event.type === 'tool.started') sawTool = true;
  });
  const internals = orchestrator as unknown as { enforceBudget(runId: string): Promise<void> };
  const original = internals.enforceBudget.bind(orchestrator);
  let thrown = false;
  internals.enforceBudget = async (runId) => {
    if (sawTool && !thrown) {
      thrown = true;
      throw new Error('injected budget reaction bug');
    }
    return original(runId);
  };
  // 必須在編排器之後訂閱：記錄到某個事件時，編排器對它的反應已經執行完
  const rec = busRecorder(bus);
  return { store, bus, orchestrator, runtime, tester, codex, rec };
}

const isBlocked = (e: UnifiedEvent) => e.type === 'run.status' && e.data.status === 'BLOCKED';

describe('P0-2 審查：ORCHESTRATOR_REACTION_FAILED 之後 BLOCKED 保持住', () => {
  it('編排反應失敗 → BLOCKED；同一輪裡批准一次普通審批後 run 仍為 BLOCKED，test 步驟沒有被派發', async () => {
    const blockedSeen = deferred();
    const env = boot(async (ctx) => {
      if (ctx.resumed) return;
      await ctx.tool({ id: 'read', name: 'Read', input: { file_path: 'src/a.ts' } });
      // 等編排器因為反應失敗進入 BLOCKED 之後，這一輪才繼續請求需要審批的命令
      await blockedSeen.promise;
      await ctx.tool({ id: 'bash', name: 'Bash', input: { command: 'npm run build' }, needsPermission: true });
    });
    const task = await env.orchestrator.createTask({ title: 'impl', prompt: 'implement it', agentId: 'claude', testCommand: 'npm test' });

    await env.rec.waitFor(isBlocked);
    const failure = await env.rec.waitFor((e) => e.type === 'runtime.error' && e.data.code === ORCHESTRATOR_REACTION_FAILED);
    expect(failure.data).toMatchObject({ reaction: 'budget', source: 'orchestrator' });
    blockedSeen.resolve();

    const required = await env.rec.waitFor((e) => e.type === 'approval.required');
    await env.orchestrator.idle();
    const waiting = (await env.store.getRun(task.runId))!;
    // BLOCKED 不允許轉到 WAITING_APPROVAL：仍是 BLOCKED，只多了一條待審批
    expect(waiting.status).toBe('BLOCKED');
    expect(waiting.pendingApprovals.map((a) => a.id)).toEqual([required.data.approvalId]);

    await env.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve');
    await env.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.pendingApprovals).toEqual([]);
    // 工作流沒有被悄悄推進：仍停在 implement，測試執行器從未啟動
    expect(run.workflowState?.step).toBe('implement');
    expect(env.tester.starts).toHaveLength(0);
    expect(env.rec.events.some((e) => e.agentId === 'test' && e.type === 'agent.started')).toBe(false);
    // 批准的那條命令照常執行（操作員對這一個工具的決定）
    expect(env.runtime.queries).toHaveLength(1);

    // 離開 BLOCKED 必須經過人工閘門：帶說明重試後，重試這一輪結束才進入測試步驟
    await env.orchestrator.resolveGate(task.id, 'retry', 'the orchestrator failed, please double-check and finish');
    expect(env.rec.events.some((e) => e.type === 'run.status' && e.data.status === 'RUNNING' && e.data.step === 'workflow:retry')).toBe(true);
    await env.tester.startCalled.promise;
    await env.orchestrator.idle();
    expect(env.tester.starts).toHaveLength(1);
  });

  it('BLOCKED 期間操作員給另一個 agent 發訊息（新會話）不會把工作流 run 改回 RUNNING', async () => {
    const finishTurn = deferred();
    const env = boot(async (ctx) => {
      if (ctx.resumed) return;
      await ctx.tool({ id: 'read', name: 'Read', input: { file_path: 'src/a.ts' } });
      await finishTurn.promise;
    });
    const task = await env.orchestrator.createTask({ title: 'impl', prompt: 'implement it', agentId: 'claude', testCommand: 'npm test' });
    await env.rec.waitFor(isBlocked);
    await env.orchestrator.idle();

    // 操作員想先問問 Codex 發生了什麼：這不是閘門決定
    await env.orchestrator.sendMessage(task.id, 'codex', 'what happened?');
    await env.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('BLOCKED');

    // Claude 這一輪隨後結束：工作流仍不推進
    finishTurn.resolve();
    await env.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.workflowState?.step).toBe('implement');
    expect(env.tester.starts).toHaveLength(0);
  });

  it('阻塞原因如實說明“AI 可能還在完成這一輪”，並且不被 agent 之後的普通事件覆蓋', async () => {
    const finishTurn = deferred();
    const env = boot(async (ctx) => {
      if (ctx.resumed) return;
      await ctx.tool({ id: 'read', name: 'Read', input: { file_path: 'src/a.ts' } });
      await finishTurn.promise;
      // BLOCKED 之後這一輪還在繼續執行不需要審批的工具
      await ctx.tool({ id: 'edit', name: 'Edit', input: { file_path: 'src/b.ts' } });
    });
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await env.rec.waitFor(isBlocked);
    await env.orchestrator.idle();

    const reason = (await env.store.getTask(task.id))?.currentAction ?? '';
    expect(reason).toContain('編排器內部出錯');
    // 不再聲稱“任務已暫停”：說清楚 AI 可能還在完成當前這一輪，要立即停下請按「停止」
    expect(reason).not.toContain('任務已暫停');
    expect(reason).toContain('停止');

    finishTurn.resolve();
    await env.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    const after = (await env.store.getTask(task.id))!;
    expect(after.status).toBe('BLOCKED');
    expect(after.currentAction).toBe(reason);
    // 任務列表摘要裡的阻塞原因同樣保持
    expect(summarizeTask(after, await env.store.getRun(task.runId)).blocker).toBe(reason);
  });
});

describe('P0-2 審查：approval.resolved 投影不會解除 BLOCKED', () => {
  const pending = (id: string, payload: Record<string, unknown> = {}) => ({ id, agentId: 'claude', summary: id, payload, createdAt: 1, status: 'pending' as const });

  it('BLOCKED 時批准最後一條審批：只移除該審批，狀態不變', () => {
    const task = makeTask({ status: 'BLOCKED' });
    const run = makeRun({ status: 'BLOCKED', currentStep: 'blocked:ORCHESTRATOR_REACTION_FAILED', pendingApprovals: [pending('a1')] });
    projectEvent(task, run, makeEvent(10, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'a1', decision: 'approve' } }));
    expect(run.status).toBe('BLOCKED');
    expect(task.status).toBe('BLOCKED');
    expect(run.currentStep).toBe('blocked:ORCHESTRATOR_REACTION_FAILED');
    expect(run.pendingApprovals).toEqual([]);
  });

  it('BLOCKED 時拒絕 agent 的交接請求：同樣不會改回 RUNNING', () => {
    const task = makeTask({ status: 'BLOCKED' });
    const run = makeRun({ status: 'BLOCKED', pendingApprovals: [pending('handoff:1', { kind: 'handoff' })] });
    projectEvent(task, run, makeEvent(10, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'handoff:1', decision: 'decline' } }));
    expect(run.status).toBe('BLOCKED');
    expect(run.pendingApprovals).toEqual([]);
  });

  it('WAITING_APPROVAL 時批准最後一條審批：照常恢復 RUNNING（不影響正常的審批流程）', () => {
    const task = makeTask({ status: 'WAITING_APPROVAL' });
    const run = makeRun({ status: 'WAITING_APPROVAL', currentStep: 'agent:claude', pendingApprovals: [pending('a1')], resumeCursor: { step: 'workflow:implement', reason: 'approval', approvalId: 'a1' } });
    projectEvent(task, run, makeEvent(10, { type: 'approval.resolved', agentId: 'claude', data: { approvalId: 'a1', decision: 'approve' } }));
    expect(run.status).toBe('RUNNING');
    expect(run.currentStep).toBe('workflow:implement');
    expect(run.resumeCursor).toBeUndefined();
  });

  it('BLOCKED 期間 agent 的普通事件不覆蓋阻塞原因；新的錯誤 / 狀態事件可以更新它', () => {
    const task = makeTask({ status: 'BLOCKED', currentAction: 'orchestrator failed' });
    const run = makeRun({ status: 'BLOCKED' });
    projectEvent(task, run, makeEvent(10, { type: 'agent.status', agentId: 'claude', data: { status: 'completed', action: 'Turn completed; waiting for orchestrator' } }));
    projectEvent(task, run, makeEvent(11, { type: 'tool.completed', agentId: 'claude', data: { toolCallId: 't', action: 'Edit completed' } }));
    expect(task.currentAction).toBe('orchestrator failed');
    projectEvent(task, run, makeEvent(12, { type: 'runtime.error', data: { code: 'X', action: 'a newer error' } }));
    expect(task.currentAction).toBe('a newer error');
    // 離開 BLOCKED 之後照常更新
    projectEvent(task, run, makeEvent(13, { type: 'run.status', data: { status: 'RUNNING', action: 'Operator: retry' } }));
    projectEvent(task, run, makeEvent(14, { type: 'agent.status', agentId: 'claude', data: { status: 'coding', action: 'Working' } }));
    expect(task.currentAction).toBe('Working');
  });
});
