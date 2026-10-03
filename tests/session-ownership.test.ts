import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, SessionOwnershipError, SessionRegistry } from '@acc/core';
import type { AgentSessionHandle, AgentStartInput, EventSink } from '@acc/core';
import { InMemoryControlPlaneStore, SqliteControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from './fakes/scripted-adapter.js';
import { tempDb } from './helpers.js';

/** 總是返回同一個原生會話 ID 的執行時（模擬兩個 run 試圖掛接同一個 provider 執行緒）。 */
class FixedNativeSessionAdapter extends ScriptedAdapter {
  override async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const handle = await super.start(input, emit);
    return { ...handle, providerSessionId: 'native-shared-thread' };
  }
}

describe('SessionRegistry', () => {
  it('rejects double reservation of the same slot', () => {
    const registry = new SessionRegistry();
    registry.reserve('run-1', 'claude', 'claude');
    expect(() => registry.reserve('run-1', 'claude', 'claude')).toThrowError(SessionOwnershipError);
    registry.release('run-1', 'claude');
    expect(() => registry.reserve('run-1', 'claude', 'claude')).not.toThrow();
  });

  it('rejects a provider session owned by another run and adapter-type switches', () => {
    const registry = new SessionRegistry();
    registry.attach({ runId: 'run-1', agentId: 'claude', adapterType: 'claude', providerSessionId: 'p-1' });
    expect(() => registry.attach({ runId: 'run-2', agentId: 'claude', adapterType: 'claude', providerSessionId: 'p-1' })).toThrow(/owned by claude in run run-1/);
    expect(() => registry.attach({ runId: 'run-1', agentId: 'claude', adapterType: 'codex', providerSessionId: 'p-1' })).toThrow(/owned by adapter claude/);
    // 同一持有者重複掛接（例如恢復）是冪等的
    expect(() => registry.attach({ runId: 'run-1', agentId: 'claude', adapterType: 'claude', providerSessionId: 'p-1' })).not.toThrow();
  });
});

describe('Orchestrator session ownership', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('concurrent messages to the same agent: exactly one session is started, the other message reuses it (no ownership conflict)', async () => {
    // P0-5：操作員命令按任務排隊、同一 agent 的“啟動或傳送”在派發鎖下完成——
    // 以前第二條訊息撞上第一條的啟動得到 SessionOwnershipError，現在兩條都送達同一個會話
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus());
    const world = new FakeWorld();
    orchestrator.registerAdapter(new ScriptedAdapter(world, [], { id: 'claude' }));
    const codex = new ScriptedAdapter(world, [], { id: 'codex', kind: 'codex' });
    orchestrator.registerAdapter(codex);

    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude' });
    await orchestrator.idle();
    const results = await Promise.allSettled([
      orchestrator.sendMessage(task.id, 'codex', 'review A'),
      orchestrator.sendMessage(task.id, 'codex', 'review B'),
    ]);

    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(codex.calls.start).toBe(1);
    expect(codex.calls.send).toBe(1);
    const events = await store.listEvents(task.runId);
    expect(events.filter((x) => x.data.code === 'SESSION_OWNERSHIP_CONFLICT')).toHaveLength(0);
  });

  it('the slot guard still rejects a second concurrent start that bypasses the dispatch lock', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus());
    const world = new FakeWorld();
    orchestrator.registerAdapter(new ScriptedAdapter(world, [], { id: 'claude' }));
    const codex = new ScriptedAdapter(world, [], { id: 'codex', kind: 'codex' });
    orchestrator.registerAdapter(codex);
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude' });
    await orchestrator.idle();

    // 直接呼叫內部的 startAgent（繞過派發鎖）：會話歸屬登記表仍然只允許一個持有者
    const internals = orchestrator as unknown as { startAgent(taskId: string, agentId: string, prompt: string, mode: string, extra: Record<string, unknown>): Promise<boolean> };
    const results = await Promise.allSettled([
      internals.startAgent(task.id, 'codex', 'review A', 'review', { source: 'operator' }),
      internals.startAgent(task.id, 'codex', 'review B', 'review', { source: 'operator' }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SessionOwnershipError);
    expect(codex.calls.start).toBe(1);
    const events = await store.listEvents(task.runId);
    expect(events.filter((x) => x.data.code === 'SESSION_OWNERSHIP_CONFLICT')).toHaveLength(1);
  });

  it('a provider session already owned by another run is rejected, cancelled and blocks the new run', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus());
    const adapter = new FixedNativeSessionAdapter(new FakeWorld(), []);
    orchestrator.registerAdapter(adapter);

    const first = await orchestrator.createTask({ title: 'a', prompt: 'p', agentId: 'claude' });
    await orchestrator.idle();
    const second = await orchestrator.createTask({ title: 'b', prompt: 'p', agentId: 'claude' });
    await orchestrator.idle();

    expect((await store.getRun(first.runId))?.agentSessions.claude?.providerSessionId).toBe('native-shared-thread');
    const secondRun = await store.getRun(second.runId);
    expect(secondRun?.status).toBe('BLOCKED');
    expect(secondRun?.agentSessions.claude).toBeUndefined();
    expect(adapter.calls.cancel).toBe(1);
    const conflict = (await store.listEvents(second.runId)).find((x) => x.data.code === 'SESSION_OWNERSHIP_CONFLICT');
    expect(conflict?.data).toMatchObject({ reason: 'provider-session-owned', ownerRunId: first.runId });
  });

  it('agent.started from a foreign session does not take over the slot', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus();
    const orchestrator = new Orchestrator(store, bus);
    orchestrator.registerAdapter(new ScriptedAdapter(new FakeWorld(), []));
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude' });
    await orchestrator.idle();
    const owner = (await store.getRun(task.runId))?.agentSessions.claude?.metadata?.adapterSessionId;

    await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId: 'intruder', type: 'agent.started', severity: 'info', confidence: 'confirmed', data: {} });
    await orchestrator.idle();

    expect((await store.getRun(task.runId))?.agentSessions.claude?.metadata?.adapterSessionId).toBe(owner);
    const conflict = (await store.listEvents(task.runId)).find((x) => x.data.code === 'SESSION_OWNERSHIP_CONFLICT');
    expect(conflict?.data).toMatchObject({ reason: 'foreign-session', sessionId: 'intruder' });
  });

  it('restart transfers ownership to the new instance explicitly', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const script = [{ kind: 'approval' as const, id: 'ap', providerCallId: 'c' }];

    const store1 = new SqliteControlPlaneStore({ path: db.path });
    const first = new Orchestrator(store1, new EventBus(), { instanceId: 'instance-1' });
    first.registerAdapter(new ScriptedAdapter(new FakeWorld(), script));
    const task = await first.createTask({ title: 't', prompt: 'p', agentId: 'claude' });
    await first.idle();
    expect(store1.listAgentSessions(task.runId)[0]?.ownerInstanceId).toBe('instance-1');
    store1.close();

    const store2 = new SqliteControlPlaneStore({ path: db.path });
    cleanups.push(() => store2.close());
    const second = new Orchestrator(store2, new EventBus(), { instanceId: 'instance-2' });
    second.registerAdapter(new ScriptedAdapter(new FakeWorld(), script));
    await second.recover();
    await second.idle();

    expect(store2.listAgentSessions(task.runId)[0]?.ownerInstanceId).toBe('instance-2');
    const transfer = (await store2.listEvents(task.runId)).find((x) => x.data.code === 'SESSION_OWNER_TRANSFERRED');
    expect(transfer?.data).toMatchObject({ from: 'instance-1', to: 'instance-2' });
    expect(second.sessions.get(task.runId, 'claude')?.state).toBe('attached');
  });
});
