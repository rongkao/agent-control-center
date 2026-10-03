import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { EventSink, UnifiedEvent } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeCodexDisk, FakeCodexServer, type CodexScript } from './fakes/fake-codex-server.js';
import { tempDb } from './helpers.js';

type Emitted = Parameters<EventSink>[0];

function collector() {
  const events: Emitted[] = [];
  const emit: EventSink = (e) => {
    events.push(e);
  };
  return { events, emit, types: () => events.map((x) => x.type) };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

function makeAdapter(disk: FakeCodexDisk, script: CodexScript) {
  const server = new FakeCodexServer(disk, script);
  const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: '/repo' });
  return { server, adapter };
}

const writeThenTest: CodexScript = () => [
  { kind: 'command', id: 'A', command: 'echo hi > a.txt' },
  { kind: 'command', id: 'B', command: 'npm test', needsApproval: true },
  { kind: 'message', text: 'All done' },
];

describe('CodexAppServerAdapter contract (fake app-server)', () => {
  it('initializes, starts a thread and emits started/status with the native thread id', async () => {
    const { server, adapter } = makeAdapter(new FakeCodexDisk(), () => [{ kind: 'message', text: 'hello' }]);
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'hi', mode: 'review' }, c.emit);

    expect(handle.providerSessionId).toBe('thread-1');
    expect(server.received.map((x) => x.method).slice(0, 4)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
    expect(server.received[2]?.params).toMatchObject({ cwd: '/repo', approvalPolicy: 'on-request', sandbox: 'read-only' }); // 評審模式強制唯讀
    expect(c.events[0]).toMatchObject({ type: 'agent.started', agentId: 'codex', data: { providerSessionId: 'thread-1' } });
    expect(c.events[1]).toMatchObject({ type: 'agent.status', data: { status: 'reviewing' } });
    await until(() => c.events.some((x) => x.data.status === 'completed'));
    expect(c.types()).toEqual(expect.arrayContaining(['model.turn.started', 'agent.message', 'model.turn.completed']));
    expect(c.events.find((x) => x.type === 'model.turn.completed')?.data.usage).toMatchObject({ inputTokens: 100, outputTokens: 30, cachedTokens: 10, durationMs: 42 });
  });

  it('maps command items to tool lifecycle and approval requests to stable approval identity (ordered)', async () => {
    for (const decision of ['approve', 'decline'] as const) {
      const disk = new FakeCodexDisk();
      const { adapter } = makeAdapter(disk, writeThenTest);
      const c = collector();
      const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
      await until(() => c.types().includes('approval.required'));

      const approval = c.events.find((x) => x.type === 'approval.required')!;
      expect(approval.data).toMatchObject({ approvalId: 'codex:thread-1:B@turn-1', providerCallId: 'B@turn-1', toolName: 'shell', toolInput: { command: 'npm test' } });
      // 同一呼叫的 tool.started 一定在 approval.required 之前
      const startedIdx = c.events.findIndex((x) => x.type === 'tool.started' && x.data.toolCallId === 'B@turn-1');
      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(startedIdx).toBeLessThan(c.events.indexOf(approval));

      await adapter.approve(handle.sessionId, { approvalId: String(approval.data.approvalId), decision }, c.emit);
      await until(() => c.events.some((x) => x.data.status === 'completed'));
      expect(disk.executions).toEqual(decision === 'approve' ? ['A', 'B'] : ['A']);
      const final = c.events.find((x) => x.data.toolCallId === 'B@turn-1' && (x.type === 'tool.completed' || x.type === 'tool.failed'));
      expect(final?.type).toBe(decision === 'approve' ? 'tool.completed' : 'tool.failed');
      if (decision === 'decline') expect(final?.data).toMatchObject({ declined: true, executed: false });
    }
  });

  it('session-scoped approval answers acceptForSession', async () => {
    const disk = new FakeCodexDisk();
    const { server, adapter } = makeAdapter(disk, writeThenTest);
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('approval.required'));
    const approval = c.events.find((x) => x.type === 'approval.required')!;
    const decisions: unknown[] = [];
    const original = server.transport.write;
    server.transport.write = (line) => {
      const msg = JSON.parse(line) as { result?: { decision?: unknown } };
      if (msg.result?.decision) decisions.push(msg.result.decision);
      original(line);
    };
    await adapter.approve(handle.sessionId, { approvalId: String(approval.data.approvalId), decision: 'approve', scope: 'session' }, c.emit);
    await until(() => disk.executions.includes('B'));
    expect(decisions).toEqual(['acceptForSession']);
  });

  it('failed command with exit code is marked executed (enters side-effect ledger)', async () => {
    const { adapter } = makeAdapter(new FakeCodexDisk(), () => [{ kind: 'command', id: 'X', command: 'false', exitCode: 1 }]);
    const c = collector();
    await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('tool.failed'));
    expect(c.events.find((x) => x.type === 'tool.failed')?.data).toMatchObject({ exitCode: 1, executed: true, declined: false });
  });

  it('send steers an active turn or starts a new turn on the same thread', async () => {
    const { server, adapter } = makeAdapter(new FakeCodexDisk(), () => [{ kind: 'message', text: 'ok' }]);
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'first' }, c.emit);
    await until(() => c.events.some((x) => x.data.status === 'completed'));
    await adapter.send(handle.sessionId, 'second', c.emit);
    await until(() => c.events.filter((x) => x.type === 'model.turn.completed').length === 2);
    const turnStarts = server.received.filter((x) => x.method === 'turn/start');
    expect(turnStarts.map((x) => (x.params as { threadId: string }).threadId)).toEqual(['thread-1', 'thread-1']);
    expect(server.received.filter((x) => x.method === 'thread/start')).toHaveLength(1);
  });

  it('cancel interrupts the active turn, cancels pending approvals and ends in cancelled', async () => {
    const disk = new FakeCodexDisk();
    const { server, adapter } = makeAdapter(disk, writeThenTest);
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('approval.required'));
    await adapter.cancel(handle.sessionId, c.emit);
    await new Promise((r) => setTimeout(r, 20));

    expect(server.received.some((x) => x.method === 'turn/interrupt')).toBe(true);
    expect(c.events.at(-1)).toMatchObject({ type: 'agent.status', data: { status: 'cancelled' } });
    expect(disk.executions).toEqual(['A']);
    await expect(adapter.send(handle.sessionId, 'more', c.emit)).rejects.toThrow(/closed/);
  });

  it('normalizes structured errors: usage, retry warning and policy block', async () => {
    const { adapter } = makeAdapter(new FakeCodexDisk(), (ctx) =>
      ctx.text === 'policy'
        ? [{ kind: 'error', info: 'cyberPolicy' }]
        : [{ kind: 'error', info: 'serverOverloaded', willRetry: true }, { kind: 'error', info: 'usageLimitExceeded' }],
    );
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.events.some((x) => x.data.status === 'failed'));
    expect(c.events.find((x) => x.type === 'runtime.warning')?.data).toMatchObject({ code: 'CODEX_RETRY', info: 'serverOverloaded' });
    const errors = c.events.filter((x) => x.type === 'runtime.error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({ code: 'CODEX_USAGE_LIMIT_EXCEEDED', category: 'usage', retryable: false });

    await adapter.send(handle.sessionId, 'policy', c.emit);
    await until(() => c.types().includes('safety.blocked'));
    expect(c.events.find((x) => x.type === 'safety.blocked')).toMatchObject({ severity: 'critical', confidence: 'confirmed', data: { code: 'CODEX_CYBER_POLICY' } });
  });

  it('app-server crash becomes a normalized runtime error', async () => {
    const { server, adapter } = makeAdapter(new FakeCodexDisk(), () => []);
    const c = collector();
    await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.events.some((x) => x.data.status === 'completed'));
    server.crash('segfault');
    await until(() => c.types().includes('runtime.error'));
    expect(c.events.find((x) => x.type === 'runtime.error')?.data).toMatchObject({ code: 'CODEX_TRANSPORT_CLOSED', retryable: true, sessionClosed: true });
    // P0-6：崩潰時會話是空閒的（上一輪已經 completed），只報告會話已關閉，不再給已經結束的回合補一個 failed
    expect(c.events.at(-1)).toMatchObject({ type: 'runtime.error' });
    expect(c.events.filter((x) => x.type === 'agent.status' && x.data.status === 'failed')).toHaveLength(0);
  });

  it('resume uses thread/resume on the native thread and never starts a second thread', async () => {
    const disk = new FakeCodexDisk();
    const first = makeAdapter(disk, () => [{ kind: 'command', id: 'A', command: 'echo a' }]);
    const c = collector();
    const handle = await first.adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.events.some((x) => x.data.status === 'completed'));
    first.server.crash();

    const second = makeAdapter(disk, () => [{ kind: 'command', id: 'A', command: 'echo a' }, { kind: 'command', id: 'C', command: 'echo c' }]);
    // 續跑必須帶上會話原來的 cwd 與 mode（H-4）；這個假 app-server 的 thread/resume 固定回報 cwd '/w'
    await second.adapter.resume(handle.sessionId, { ...ids, agentId: 'codex', reason: 'recovery', step: 's', completedSideEffectIds: ['A@turn-1'], lastSequence: 1, metadata: { providerSessionId: 'thread-1', cwd: '/w', mode: 'implement' } }, c.emit);
    await until(() => disk.executions.includes('C'));
    expect(second.server.received.map((x) => x.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(disk.executions).toEqual(['A', 'C']);
    expect((second.server.received[3]?.params as { input: Array<{ text: string }> }).input[0]?.text).toMatch(/do NOT repeat.*A@turn-1/);
  });

  it('resume of an unknown thread fails closed', async () => {
    const { adapter } = makeAdapter(new FakeCodexDisk(), () => []);
    await expect(
      adapter.resume('x', { ...ids, agentId: 'codex', reason: 'recovery', step: 's', completedSideEffectIds: [], lastSequence: 0, metadata: { providerSessionId: 'thread-404', cwd: '/w', mode: 'implement' } }, collector().emit),
    ).rejects.toThrow(/no rollout found/);
    await expect(adapter.resume('y', { ...ids, agentId: 'codex', reason: 'recovery', step: 's', completedSideEffectIds: [], lastSequence: 0 }, collector().emit)).rejects.toThrow(/native thread id/);
  });
});

describe('CodexAppServerAdapter + Orchestrator + SQLite restart', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('approval pending across restart resumes the thread, auto-accepts the approved command once, and never repeats A', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const disk = new FakeCodexDisk();
    const boot = () => {
      const store = new SqliteControlPlaneStore({ path: db.path });
      // 與服務端一致：編排器總有預設工作區，會話的 cwd 隨會話持久化，續跑時沿用並與服務端回報的 cwd 核對（H-4）。
      // 這個假 app-server 的 thread/resume 固定回報 cwd '/w'，所以任務就建在 '/w'。
      const orchestrator = new Orchestrator(store, new EventBus(), { defaultCwd: '/w' });
      const fake = makeAdapter(disk, writeThenTest);
      orchestrator.registerAdapter(fake.adapter);
      return { store, orchestrator, ...fake };
    };

    const first = boot();
    const task = await first.orchestrator.createTask({ title: 'fix', prompt: 'fix it', agentId: 'codex' });
    await until(async () => (await first.store.getRun(task.runId))?.status === 'WAITING_APPROVAL');
    const run = await first.store.getRun(task.runId);
    expect(run?.agentSessions.codex?.providerSessionId).toBe('thread-1');
    const approvalId = run!.pendingApprovals[0]!.id;
    first.server.crash();
    await until(async () => (await first.store.listEvents(task.runId)).some((x) => x.data.code === 'CODEX_TRANSPORT_CLOSED'));
    first.store.close();

    const second = boot();
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    expect(report.waiting).toEqual([task.runId]);
    await second.orchestrator.resolveApproval(task.id, approvalId, 'approve');

    let events: UnifiedEvent[] = [];
    await until(async () => {
      events = await second.store.listEvents(task.runId);
      const resolved = events.find((x) => x.type === 'approval.resolved')?.sequence ?? Infinity;
      return events.some((x) => x.type === 'agent.status' && x.data.status === 'completed' && x.sequence > resolved);
    });
    expect(disk.executions).toEqual(['A', 'B']);
    expect(second.server.received.some((x) => x.method === 'thread/resume' && (x.params as { threadId: string }).threadId === 'thread-1')).toBe(true);
    expect(events.filter((x) => x.type === 'approval.required')).toHaveLength(1);
    expect((await second.store.getApproval(approvalId))?.status).toBe('approved');
  });
});
