import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter, type ScriptStep } from '../fakes/scripted-adapter.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { deferred, turnEventLoop } from './fakes/deferred.js';
import { GatedAgent } from './fakes/gated-agent.js';

/**
 * P0-5（H-6）：派發與審批路徑在鎖內複核 run 狀態。
 *
 * 復現：
 * - probe 場景 3：在 agent 啟動（等待初始化）期間取消，任務變成 CANCELLED，但 cancelCalls=0，會話隨後被登記為線上；
 * - probe3 場景 D / probe.mts B：取消後批准舊的審批，adapter 走 resume(approval)，agent 被重新拉起並執行工具。
 *
 * 期望：派發前在鎖內要求 run 處於允許派發的狀態；adapter.start / resume 返回後在鎖內再複核（終態或期間發生過停止
 * 就立刻 cancel 並釋放槽位）；終態 run 上的審批一律 409、工具不執行；終態之後才到的 approval.required 自動拒絕。
 */

const quiet = () => undefined;

function boot(options: { now?: () => number } = {}) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet, now: options.now });
  return { store, bus, orchestrator };
}

const APPROVAL_SCRIPT: ScriptStep[] = [
  { kind: 'tool', id: 'tool-A' },
  { kind: 'approval', id: 'approval-B', providerCallId: 'toolu_B', summary: 'Run shell command' },
  { kind: 'tool', id: 'tool-B' },
  { kind: 'complete' },
];

describe('H-6：啟動期間取消（probe 場景 3）', () => {
  it('對話任務：Claude 還在初始化時按「停止」→ 啟動返回後立刻被取消，不登記為線上、槽位釋放', async () => {
    const env = boot();
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    claude.startGate = deferred();
    env.orchestrator.registerAdapter(claude);

    const creating = env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    const input = await claude.startCalled.promise;
    await env.orchestrator.cancelTask(input.taskId);
    expect((await env.store.getRun(input.runId))?.status).toBe('CANCELLED');

    // 初始化完成：adapter.start 返回
    claude.startGate.resolve();
    const task = await creating;
    await env.orchestrator.idle();

    expect(task.id).toBe(input.taskId);
    expect(claude.cancels).toBe(1);
    expect(env.orchestrator.liveAgentIds(input.runId)).toEqual([]);
    expect(env.orchestrator.sessions.get(input.runId, 'claude')).toBeUndefined();
    const run = (await env.store.getRun(input.runId))!;
    expect(run.status).toBe('CANCELLED');
    // 會話仍被記錄（可追溯），狀態是已停止
    expect(run.agentSessions.claude?.status).toBe('cancelled');
    expect(claude.sends).toHaveLength(0);
  });

  it('工作流反應派發的測試步驟正在啟動時取消：啟動返回後立刻被取消', async () => {
    const env = boot();
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const tester = new GatedAgent({ id: 'test', kind: 'test', capabilities: ['test'] });
    tester.startGate = deferred();
    env.orchestrator.registerAdapter(claude);
    env.orchestrator.registerAdapter(tester);

    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test' });
    await tester.startCalled.promise;
    await env.orchestrator.cancelTask(task.id);
    tester.startGate.resolve();
    await env.orchestrator.idle();

    expect(tester.cancels).toBe(1);
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('CANCELLED');
  });

  it('預算停止時另一個 agent 正在啟動：啟動返回後同樣被取消（dispatch epoch），run 保持 BLOCKED', async () => {
    let clock = 1_000_000;
    const env = boot({ now: () => clock });
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new GatedAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    codex.startGate = deferred();
    env.orchestrator.registerAdapter(claude);
    env.orchestrator.registerAdapter(codex);

    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', budget: { maxDurationMs: 5_000 } });
    await env.orchestrator.idle();
    const sending = env.orchestrator.sendMessage(task.id, 'codex', 'please review');
    await codex.startCalled.promise;

    clock += 5_000;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('BLOCKED');
    expect(claude.cancels).toBe(1);

    codex.startGate.resolve();
    await sending;
    await env.orchestrator.idle();
    // 啟動返回時派發許可已失效：一定會被取消。P0 第二批審查起，即使阻塞期間的預算檢查已經取消過它，
    // 編排器也會再取消一次（停止時那次取消可能發生在派發請求在途時，沒能中斷隨後才開始的一輪；adapter 的 cancel 是冪等的）
    expect(codex.cancels).toBeGreaterThanOrEqual(1);
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('BLOCKED');
  });
});

describe('H-6：終態 run 上的審批（probe3 場景 D）', () => {
  it('取消後批准舊的審批：409，adapter 既不 approve 也不 resume，工具不執行；審批記錄為已作廢', async () => {
    const env = boot();
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, APPROVAL_SCRIPT);
    env.orchestrator.registerAdapter(adapter);

    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.pendingApprovals.map((x) => x.id)).toEqual(['approval-B']);

    await env.orchestrator.cancelTask(task.id);
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('CANCELLED');
    expect(run.pendingApprovals).toEqual([]);
    expect(await env.store.getApproval('approval-B')).toMatchObject({ status: 'voided' });

    await expect(env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve')).rejects.toMatchObject({ statusCode: 409, code: 'TASK_TERMINAL' });
    await env.orchestrator.idle();
    expect(world.executions).toEqual(['tool-A']);
    expect(adapter.calls).toMatchObject({ approve: 0, resume: 0, cancel: 1 });
    expect((await env.store.listEvents(task.runId)).filter((e) => e.type === 'approval.resolved')).toEqual([]);
  });

  it('終態之後才到的 approval.required：自動拒絕（記錄 + approval.resolved），不會變成待審批，批准它得到 409', async () => {
    const env = boot();
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    env.orchestrator.registerAdapter(claude);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    const sessionId = String((await env.store.getRun(task.runId))?.agentSessions.claude?.metadata?.adapterSessionId);
    await env.orchestrator.cancelTask(task.id);
    await env.orchestrator.idle();

    await env.bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId, type: 'approval.required', severity: 'warning', confidence: 'confirmed', data: { approvalId: 'late', summary: 'rm -rf x', providerCallId: 'toolu_late' } });
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('CANCELLED');
    expect(run.pendingApprovals).toEqual([]);
    expect(await env.store.getApproval('late')).toMatchObject({ status: 'declined', decision: expect.objectContaining({ resolvedBy: 'orchestrator', reason: 'run-terminal' }) });
    const resolved = (await env.store.listEvents(task.runId)).filter((e) => e.type === 'approval.resolved');
    expect(resolved.map((e) => e.data)).toEqual([expect.objectContaining({ approvalId: 'late', decision: 'decline', resolvedBy: 'orchestrator', reason: 'run-terminal' })]);

    await expect(env.orchestrator.resolveApproval(task.id, 'late', 'approve')).rejects.toMatchObject({ statusCode: 409 });
    expect(claude.approvals).toEqual([]);
  });

  /** 包一層 run 鎖：記錄每次排隊，便於確定性地安排“誰先落盤”。 */
  function lockProbe(orchestrator: Orchestrator) {
    type Locks = { run(key: string, fn: () => Promise<unknown>): Promise<unknown> };
    const locks = (orchestrator as unknown as { locks: Locks }).locks;
    const original = locks.run.bind(locks);
    let onQueued: (() => void) | undefined;
    locks.run = (key, fn) => {
      const result = original(key, fn);
      onQueued?.();
      return result;
    };
    return {
      /** 佔住該 run 的持久化鎖，直到 release。 */
      hold(runId: string) {
        const gate = deferred();
        const held = original(runId, () => gate.promise);
        return async () => {
          gate.resolve();
          await held;
        };
      },
      /** 下一次有人在鎖上排隊時 resolve。 */
      nextQueued(): Promise<void> {
        return new Promise<void>((resolve) => (onQueued = resolve));
      },
      stop() {
        onQueued = undefined;
      },
    };
  }

  it('批准已在途、取消的狀態遷移先落盤：鎖內檢查失敗，409，工具不執行，不留下 approval.resolved，序號不留空洞', async () => {
    const env = boot();
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, APPROVAL_SCRIPT);
    env.orchestrator.registerAdapter(adapter);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    const persisted: UnifiedEvent[] = [];
    env.bus.subscribe((event) => void persisted.push(event));

    // 佔住持久化鎖；取消的狀態遷移（批准的檢查通過之後才被按下的「停止」）先在鎖上排隊——這裡直接釋出這條遷移事件
    const probe = lockProbe(env.orchestrator);
    const release = probe.hold(task.runId);
    const endQueued = probe.nextQueued();
    const ending = env.bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, type: 'run.status', severity: 'info', confidence: 'confirmed', data: { status: 'CANCELLED', step: 'cancelled' } });
    await endQueued;
    // 批准：檢查時看到的仍是 WAITING_APPROVAL，它的 approval.resolved 排在終態事件之後
    const approvalQueued = probe.nextQueued();
    const outcome = env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve').then(
      () => 'resolved',
      (error: { statusCode?: number; code?: string }) => `${error.statusCode}:${error.code}`,
    );
    await approvalQueued;
    probe.stop();
    await release();
    await ending;
    expect(await outcome).toBe('409:TASK_TERMINAL');
    await env.orchestrator.idle();

    expect((await env.store.getRun(task.runId))?.status).toBe('CANCELLED');
    expect(world.executions).toEqual(['tool-A']);
    expect(adapter.calls).toMatchObject({ approve: 0, resume: 0 });
    expect(persisted.some((e) => e.type === 'approval.resolved')).toBe(false);
    expect(await env.store.getApproval('approval-B')).toMatchObject({ status: 'voided' });
    // 被拒絕落盤的事件收回了它的序號：事件日誌沒有空洞
    const sequences = (await env.store.listEvents(task.runId)).map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
  });

  it('按「停止」之後才提交的批准排在停止後面：409，工具不執行', async () => {
    const env = boot();
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, APPROVAL_SCRIPT);
    env.orchestrator.registerAdapter(adapter);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();

    // 停止的狀態事件還卡在持久化鎖上時，批准已經提交
    const probe = lockProbe(env.orchestrator);
    const release = probe.hold(task.runId);
    const cancelQueued = probe.nextQueued();
    const cancelling = env.orchestrator.cancelTask(task.id);
    await cancelQueued;
    probe.stop();
    const outcome = env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve').then(
      () => 'resolved',
      (error: { statusCode?: number; code?: string }) => `${error.statusCode}:${error.code}`,
    );
    await turnEventLoop(5);
    await release();
    await cancelling;
    expect(await outcome).toBe('409:TASK_TERMINAL');
    await env.orchestrator.idle();
    expect(world.executions).toEqual(['tool-A']);
    expect(adapter.calls).toMatchObject({ approve: 0, resume: 0 });
    expect(await env.store.getApproval('approval-B')).toMatchObject({ status: 'voided' });
  });
});
