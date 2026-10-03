import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { TaskBudget, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter, type ScriptStep } from './fakes/scripted-adapter.js';

function boot(script: ScriptStep[], options: { now?: () => number; extraAgents?: string[] } = {}) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orchestrator = new Orchestrator(store, bus, { now: options.now });
  const world = new FakeWorld();
  // 編排反應（預算檢查）非同步排隊執行：每一步之後等編排器處理完，模擬真實 agent 兩輪之間的間隔
  const adapter = new ScriptedAdapter(world, script, {}, { pace: () => orchestrator.idle() });
  orchestrator.registerAdapter(adapter);
  for (const id of options.extraAgents ?? []) {
    orchestrator.registerAdapter(new ScriptedAdapter(world, [], { id, kind: 'codex' }));
  }
  return { store, orchestrator, adapter, world };
}

async function run(script: ScriptStep[], budget: Partial<TaskBudget>, options: Parameters<typeof boot>[1] = {}) {
  const env = boot(script, options);
  const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget });
  await env.orchestrator.idle();
  const events = await env.store.listEvents(task.runId);
  const snapshot = await env.store.getRun(task.runId);
  return { ...env, task, events, snapshot };
}

const limitEvents = (events: UnifiedEvent[]) => events.filter((x) => x.type === 'budget.exceeded' || x.type === 'budget.stalled');

describe('budget + stall enforcement', () => {
  it('maxTurns blocks deterministically and stops the agent', async () => {
    const turn: ScriptStep = { kind: 'turn', progress: true };
    const { events, snapshot, adapter } = await run([turn, turn, turn, turn, { kind: 'complete' }], { maxTurns: 2 });

    // P0-7：限額是“最多允許 2 輪”——第 2 輪照常進行，超出上限的第 3 輪才阻塞（以前 >= 在第 2 輪就阻塞，丟掉它的完成訊號）
    expect(snapshot?.status).toBe('BLOCKED');
    expect(snapshot?.currentStep).toBe('budget:maxTurns');
    expect(snapshot?.budget.turnsUsed).toBe(3);
    expect(limitEvents(events)).toHaveLength(1);
    expect(limitEvents(events)[0]).toMatchObject({ type: 'budget.exceeded', confidence: 'confirmed', data: { limit: 'maxTurns', used: 3, max: 2 } });
    // 預算停止時取消了會話；啟動（整個腳本在 start() 裡跑完）返回後派發許可已失效，編排器再取消一次（P0 第二批審查：
    // 停止時那次取消可能發生在派發請求在途時，adapter 的 cancel 是冪等的），所以至少一次
    expect(adapter.calls.cancel).toBeGreaterThanOrEqual(1);
    expect(events.some((x) => x.type === 'run.completed')).toBe(false);
  });

  it('maxStallCount emits budget.stalled after consecutive no-progress turns', async () => {
    const idle: ScriptStep = { kind: 'turn', progress: false };
    const { events, snapshot } = await run([idle, idle, idle, idle], { maxStallCount: 2, maxTurns: 100 });

    expect(snapshot?.status).toBe('BLOCKED');
    expect(snapshot?.currentStep).toBe('budget:maxStallCount');
    // P0-7：允許連續 2 輪沒有進展，第 3 輪仍然沒有進展才判為停滯
    expect(limitEvents(events)).toEqual([expect.objectContaining({ type: 'budget.stalled', data: expect.objectContaining({ limit: 'maxStallCount', used: 3, max: 2 }) })]);
  });

  it('semantic progress (tool completion) resets the stall counter', async () => {
    const idle: ScriptStep = { kind: 'turn', progress: false };
    const script: ScriptStep[] = [idle, { kind: 'tool', id: 'a' }, idle, { kind: 'tool', id: 'b' }, idle, { kind: 'complete' }];
    const { snapshot, events } = await run(script, { maxStallCount: 2 });
    expect(snapshot?.status).toBe('COMPLETED');
    expect(limitEvents(events)).toHaveLength(0);
  });

  it('maxEstimatedTokens blocks when reported usage crosses the limit and persists usage', async () => {
    const usage = { inputTokens: 600, outputTokens: 100, model: 'fake-model' };
    const { snapshot, events, store, task } = await run(
      [{ kind: 'turn', progress: true, usage }, { kind: 'turn', progress: true, usage }, { kind: 'complete' }],
      { maxEstimatedTokens: 1000 },
    );
    expect(snapshot?.status).toBe('BLOCKED');
    expect(limitEvents(events)[0]?.data).toMatchObject({ limit: 'maxEstimatedTokens', used: 1400, max: 1000 });
    expect(await store.listUsage(task.runId)).toHaveLength(2);
  });

  it('maxAgentCalls refuses a new agent call with budget.exceeded', async () => {
    const env = boot([], { extraAgents: ['codex'] });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxAgentCalls: 1 } });
    await env.orchestrator.idle();
    // P0-7：操作員的訊息因為預算不夠沒有送出時明確報錯（409），不再“介面返回成功”
    await expect(env.orchestrator.sendMessage(task.id, 'codex', 'review please')).rejects.toMatchObject({ statusCode: 409, code: 'BUDGET_EXHAUSTED' });
    await env.orchestrator.idle();

    const snapshot = await env.store.getRun(task.runId);
    expect(snapshot?.status).toBe('BLOCKED');
    expect(snapshot?.agentSessions.codex).toBeUndefined();
    expect(snapshot?.budget.agentCallsUsed).toBe(1);
    const events = await env.store.listEvents(task.runId);
    expect(limitEvents(events)[0]?.data).toMatchObject({ limit: 'maxAgentCalls', used: 1, max: 1 });
  });

  it('maxDurationMs is enforced by the periodic check with an injected clock', async () => {
    let now = 1_000_000;
    const env = boot([{ kind: 'tool', id: 'a' }], { now: () => now });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 5_000 } });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');

    now += 4_999;
    await env.orchestrator.checkBudgets();
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');

    now += 1;
    await env.orchestrator.checkBudgets();
    const snapshot = await env.store.getRun(task.runId);
    expect(snapshot?.status).toBe('BLOCKED');
    const events = await env.store.listEvents(task.runId);
    expect(limitEvents(events)[0]?.data).toMatchObject({ limit: 'maxDurationMs', used: 5_000, max: 5_000 });

    // 再次檢查不會重複產生限額事件
    await env.orchestrator.checkBudgets();
    expect(limitEvents(await env.store.listEvents(task.runId))).toHaveLength(1);
  });

  it('does not enforce duration while waiting for a human', async () => {
    let now = 0;
    const env = boot([{ kind: 'approval', id: 'ap', providerCallId: 'c' }], { now: () => now });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 10 } });
    await env.orchestrator.idle();
    now = 1_000;
    await env.orchestrator.checkBudgets();
    expect((await env.store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');
  });
});
