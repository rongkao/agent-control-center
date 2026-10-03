import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { EventSink, UnifiedEvent } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime, type FakeScript } from './fakes/fake-claude-runtime.js';
import { tempDb } from './helpers.js';

type Emitted = Parameters<EventSink>[0];

function collector() {
  const events: Emitted[] = [];
  const emit: EventSink = (e) => {
    events.push(e);
  };
  return { events, emit, types: () => events.map((x) => x.type) };
}

/** 等待非同步事件流穩定。 */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

const writeThenBash: FakeScript = async (ctx) => {
  await ctx.tool({ id: 'A', name: 'Write', input: { file_path: 'a.txt', content: 'x' } });
  await ctx.tool({ id: 'B', name: 'Bash', input: { command: 'npm test' }, needsPermission: true });
};

describe('ClaudeAgentSdkAdapter contract (fake runtime)', () => {
  it('start emits started/status and returns the native session identity', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    const c = collector();

    const handle = await adapter.start({ ...ids, prompt: 'hello', cwd: '/repo' }, c.emit);

    expect(handle.providerSessionId).toBe('native-session-1');
    expect(c.events[0]).toMatchObject({ type: 'agent.started', agentId: 'claude', sessionId: handle.sessionId, confidence: 'confirmed', data: { providerSessionId: 'native-session-1' } });
    expect(c.events[1]).toMatchObject({ type: 'agent.status', data: { status: 'coding' } });
    expect(runtime.queries[0]?.options).toMatchObject({ cwd: '/repo', permissionMode: 'default' });
    expect(runtime.queries[0]?.options.resume).toBeUndefined();
    await until(() => c.types().includes('model.turn.completed'));
  });

  it('maps tool lifecycle and per-turn usage', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      await ctx.tool({ id: 'A', name: 'Write', input: { file_path: 'a.txt' } });
    });
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    const c = collector();
    await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('agent.status') && c.events.some((x) => x.data.status === 'completed'));

    const started = c.events.find((x) => x.type === 'tool.started');
    const completed = c.events.find((x) => x.type === 'tool.completed');
    expect(started?.data).toMatchObject({ toolName: 'Write' });
    expect(completed?.data).toMatchObject({ toolCallId: started?.data.toolCallId, toolName: 'Write' });
    // P1-7：輸入 token 包含快取讀寫（100 + 5 快取讀取 + 0 快取寫入）
    expect(c.events.find((x) => x.type === 'model.turn.completed')?.data.usage).toMatchObject({ inputTokens: 105, outputTokens: 20, cachedTokens: 5, providerReported: true });
  });

  it('permission request maps to a stable approval identity and approve/decline resolve it', async () => {
    for (const decision of ['approve', 'decline'] as const) {
      const disk = new FakeClaudeDisk();
      const adapter = new ClaudeAgentSdkAdapter({ queryFn: new FakeClaudeRuntime(disk, writeThenBash).queryFn });
      const c = collector();
      const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
      await until(() => c.types().includes('approval.required'));

      const approval = c.events.find((x) => x.type === 'approval.required')!;
      expect(approval.data).toMatchObject({ toolName: 'Bash', toolInput: { command: 'npm test' }, summary: 'Allow Bash?' });
      expect(approval.data.approvalId).toBe(`claude:native-session-1:${approval.data.providerCallId}`);

      await adapter.approve(handle.sessionId, { approvalId: String(approval.data.approvalId), decision }, c.emit);
      await until(() => c.events.some((x) => x.data.status === 'completed'));
      expect(disk.executions).toEqual(decision === 'approve' ? ['A', 'B'] : ['A']);
      expect(c.types()).toContain(decision === 'approve' ? 'tool.completed' : 'tool.failed');
    }
  });

  it('send preserves session identity (same query, same native session)', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'first' }, c.emit);
    await adapter.send(handle.sessionId, 'second', c.emit);
    await until(() => c.events.filter((x) => x.type === 'model.turn.completed').length === 2);
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.queries[0]?.prompts).toEqual(['first', 'second']);
    expect(new Set(c.events.map((x) => x.sessionId))).toEqual(new Set([handle.sessionId]));
  });

  it('cancel interrupts the runtime, denies pending permissions and reaches a terminal agent state', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, writeThenBash);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    const c = collector();
    const handle = await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('approval.required'));

    await adapter.cancel(handle.sessionId, c.emit);
    expect(runtime.queries[0]?.interrupts).toBe(1);
    expect(c.events.at(-1)).toMatchObject({ type: 'agent.status', data: { status: 'cancelled' } });
    await expect(adapter.send(handle.sessionId, 'more', c.emit)).rejects.toThrow(/closed/);
    expect(disk.executions).toEqual(['A']);
  });

  it('provider errors become normalized runtime.error events', async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      queryFn: new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
        ctx.send({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { content: [] } } as never);
        ctx.send({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'], num_turns: 9, stop_reason: null, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } } as never);
      }).queryFn,
    });
    const c = collector();
    await adapter.start({ ...ids, prompt: 'go' }, c.emit);
    // P0-6：這一輪裡 assistant 報告的錯誤只是警告（結局以 result 為準）；以錯誤 result 結束的一輪發一條 runtime.error 並以 failed 結束
    await until(() => c.events.some((x) => x.type === 'agent.status' && x.data.status === 'failed'));
    expect(c.events.find((x) => x.type === 'runtime.warning')?.data).toMatchObject({ code: 'CLAUDE_RATE_LIMIT', category: 'usage', retryable: true });
    const errors = c.events.filter((x) => x.type === 'runtime.error').map((x) => x.data);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'CLAUDE_ERROR_MAX_TURNS', category: 'usage', retryable: false });
  });

  it('start fails closed when the runtime never initializes', async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      startTimeoutMs: 50,
      queryFn: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }), interrupt: async () => undefined }),
    });
    await expect(adapter.start({ ...ids, prompt: 'go' }, collector().emit)).rejects.toThrow(/did not initialize/);
  });

  it('resume reuses the native session and does not create a second logical session', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      await ctx.tool({ id: 'A', name: 'Write', input: {} });
    });
    const first = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    const c = collector();
    const handle = await first.start({ ...ids, prompt: 'go' }, c.emit);
    await until(() => c.types().includes('model.turn.completed'));

    const second = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    // 續跑必須帶上會話原來的 cwd 與 mode（H-4：讀不到就 fail closed，不回退 defaultCwd）
    await second.resume(
      handle.sessionId,
      { ...ids, agentId: 'claude', reason: 'recovery', step: 'agent:claude', completedSideEffectIds: ['A'], lastSequence: 3, metadata: { providerSessionId: handle.providerSessionId, cwd: '/repo', mode: 'implement' } },
      c.emit,
    );
    await until(() => c.events.filter((x) => x.type === 'model.turn.completed').length === 2);
    expect(runtime.queries[1]?.options.resume).toBe('native-session-1');
    expect(runtime.queries[1]?.options).toMatchObject({ cwd: '/repo', permissionMode: 'default' });
    expect(runtime.queries[1]?.prompts[0]).toMatch(/do NOT repeat.*A/);
    expect(disk.executions).toEqual(['A']);
    expect(c.events.filter((x) => x.type === 'agent.started').map((x) => x.sessionId)).toEqual([handle.sessionId, handle.sessionId]);
  });

  it('resume without native session id fails closed', async () => {
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined).queryFn });
    await expect(
      adapter.resume('x', { ...ids, agentId: 'claude', reason: 'recovery', step: 's', completedSideEffectIds: [], lastSequence: 0 }, collector().emit),
    ).rejects.toThrow(/native session id/);
  });
});

describe('ClaudeAgentSdkAdapter + Orchestrator + SQLite restart', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('approval pending across restart resumes the native session and never repeats tool A', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const disk = new FakeClaudeDisk();

    const boot = () => {
      const store = new SqliteControlPlaneStore({ path: db.path });
      const bus = new EventBus();
      // 與服務端一致：編排器總有預設工作區，會話的 cwd 隨會話持久化，續跑時沿用（H-4）
      const orchestrator = new Orchestrator(store, bus, { defaultCwd: '/repo' });
      const runtime = new FakeClaudeRuntime(disk, writeThenBash);
      orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn }));
      return { store, orchestrator, runtime };
    };

    const first = boot();
    const task = await first.orchestrator.createTask({ title: 'fix', prompt: 'fix it', agentId: 'claude' });
    let run = await first.store.getRun(task.runId);
    for (let i = 0; i < 200 && run?.status !== 'WAITING_APPROVAL'; i++) {
      await new Promise((r) => setTimeout(r, 5));
      run = await first.store.getRun(task.runId);
    }
    expect(run?.status).toBe('WAITING_APPROVAL');
    expect(run?.agentSessions.claude?.providerSessionId).toBe('native-session-1');
    const approvalId = run!.pendingApprovals[0]!.id;
    // 模擬崩潰前讓程序 1 的訊息泵消費完已排隊的 SDK 訊息（真實崩潰會連同執行時一起終止）
    for (let i = 0; i < 200; i++) {
      const evts = await first.store.listEvents(task.runId);
      if (evts.filter((x) => x.type === 'tool.started').length === 2) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    first.store.close();

    const second = boot();
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    expect(report.waiting).toEqual([task.runId]);

    await second.orchestrator.resolveApproval(task.id, approvalId, 'approve');
    // 等本輪 result 投影落庫後再斷言（之後才允許關閉資料庫）
    let events: UnifiedEvent[] = [];
    for (let i = 0; i < 200; i++) {
      events = await second.store.listEvents(task.runId);
      const resolvedSeq = events.find((e) => e.type === 'approval.resolved')?.sequence ?? Infinity;
      if (events.some((x) => x.type === 'agent.status' && x.data.status === 'completed' && x.sequence > resolvedSeq)) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    expect(disk.executions).toEqual(['A', 'B']);
    expect(second.runtime.queries[0]?.options.resume).toBe('native-session-1');
    // 重新發起的同一 Bash 呼叫被識別為“已批准”，沒有產生第二次審批
    expect(events.filter((x) => x.type === 'approval.required')).toHaveLength(1);
    // 實現輪次完成且未配置測試命令 → 工作流完成
    expect((await second.store.getRun(task.runId))?.status).toBe('COMPLETED');
    expect((await second.store.getApproval(approvalId))?.status).toBe('approved');
  });
});
