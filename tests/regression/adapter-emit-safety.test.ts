import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter, LocalTestRunnerAdapter, MockAgentAdapter, safeEmit } from '@acc/adapters';
import type { EventSink } from '@acc/core';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { captureUnhandledRejections, deferred, turnEventLoop } from './fakes/deferred.js';

/**
 * P0-2（H-2 / L-2）：adapter 發事件失敗時（通常是事件沒能落盤）不能產生未處理的 Promise 拒絕，
 * 也不能靜默吞掉需要 fail closed 的錯誤；Codex 通知按 threadId 分 chain，避免跨任務隊頭阻塞。
 */

type Emitted = Parameters<EventSink>[0];
const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

function recorder() {
  const logs: Array<{ message: string; error: unknown }> = [];
  return { logs, log: (message: string, error?: unknown) => void logs.push({ message, error }) };
}

let unhandled: ReturnType<typeof captureUnhandledRejections>;
afterEach(() => {
  unhandled?.dispose();
  vi.useRealTimers();
});

describe('safeEmit', () => {
  it('傳送失敗時返回 false 並記錄日誌，絕不丟擲', async () => {
    const { logs, log } = recorder();
    const ok = await safeEmit(() => Promise.reject(new Error('disk full')), { ...ids, type: 'agent.message', severity: 'info', confidence: 'confirmed', data: {} }, log);
    expect(ok).toBe(false);
    expect(logs).toHaveLength(1);
    expect(String((logs[0]!.error as Error).message)).toBe('disk full');
    await expect(safeEmit(() => undefined, { ...ids, type: 'agent.message', severity: 'info', confidence: 'confirmed', data: {} }, log)).resolves.toBe(true);
  });
});

describe('ClaudeAgentSdkAdapter：區分 emit 異常與 SDK 迭代異常', () => {
  it('emit 丟擲的異常只記日誌，不關閉會話，後續訊息照常處理', async () => {
    unhandled = captureUnhandledRejections();
    const { logs, log } = recorder();
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      ctx.send({ type: 'assistant', parent_tool_use_id: null, session_id: ctx.sessionId, uuid: 'u', message: { content: [{ type: 'text', text: `echo: ${ctx.prompt}` }] } } as never);
    });
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log });
    const events: Emitted[] = [];
    const turns = [deferred(), deferred()];
    let failedOnce = false;
    const emit: EventSink = async (event) => {
      // 第一條回覆落盤失敗
      if (event.type === 'agent.message' && !failedOnce) {
        failedOnce = true;
        throw new Error('persist failed');
      }
      events.push(event);
      if (event.type === 'agent.status' && event.data.status === 'completed') turns[events.filter((x) => x.type === 'agent.status' && x.data.status === 'completed').length - 1]?.resolve();
    };

    const handle = await adapter.start({ ...ids, prompt: 'first' }, emit);
    await turns[0]!.promise;
    await adapter.send(handle.sessionId, 'second', emit);
    await turns[1]!.promise;

    expect(events.some((x) => x.data.code === 'CLAUDE_RUNTIME_ERROR')).toBe(false);
    expect(events.some((x) => x.type === 'agent.status' && x.data.status === 'failed')).toBe(false);
    expect(events.filter((x) => x.type === 'agent.message').map((x) => x.data.message)).toEqual(['echo: second']);
    expect(runtime.queries).toHaveLength(1);
    expect(logs.some((x) => String((x.error as Error)?.message) === 'persist failed')).toBe(true);
    await turnEventLoop();
    expect(unhandled.reasons).toEqual([]);
  });

  it('SDK 迭代丟擲的異常仍然是 CLAUDE_RUNTIME_ERROR，並關閉會話', async () => {
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => {
      throw new Error('never used');
    });
    let calls = 0;
    const crashing: typeof runtime.queryFn = (params) => {
      const inner = runtime.queryFn(params);
      return {
        interrupt: inner.interrupt,
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]();
          return {
            next: async () => {
              // 第一條（init）照常，第二次讀取時 SDK 本身報錯
              if (calls++ === 0) return it.next();
              throw new Error('sdk stream broke');
            },
          };
        },
      };
    };
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: crashing, log: () => undefined });
    const failed = deferred();
    const events: Emitted[] = [];
    const handle = await adapter.start({ ...ids, prompt: 'go' }, (event) => {
      events.push(event);
      if (event.type === 'agent.status' && event.data.status === 'failed') failed.resolve();
    });
    await failed.promise;
    expect(events.find((x) => x.type === 'runtime.error')?.data).toMatchObject({ code: 'CLAUDE_RUNTIME_ERROR', message: 'sdk stream broke' });
    await expect(adapter.send(handle.sessionId, 'more', () => undefined)).rejects.toThrow(/closed/);
  });

  it('審批請求沒能送到編排器時 fail closed：直接拒絕該工具呼叫，而不是無限期掛起', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      await ctx.tool({ id: 'A', name: 'Write', input: { file_path: 'a.txt' } });
      await ctx.tool({ id: 'B', name: 'Bash', input: { command: 'rm -rf /tmp/x' }, needsPermission: true });
    });
    const { logs, log } = recorder();
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log });
    const done = deferred();
    const events: Emitted[] = [];
    await adapter.start({ ...ids, prompt: 'go' }, async (event) => {
      if (event.type === 'approval.required') throw new Error('persist failed');
      events.push(event);
      if (event.type === 'agent.status' && event.data.status === 'completed') done.resolve();
    });
    await done.promise;
    expect(disk.executions).toEqual(['A']);
    expect(events.find((x) => x.type === 'tool.failed')?.data).toMatchObject({ toolName: 'Bash' });
    expect(logs.length).toBeGreaterThan(0);
  });

  it('request_handoff 工具在請求沒能提交時如實告訴 Claude', async () => {
    let result: unknown;
    const finished = deferred();
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      const server = (ctx.options.mcpServers as unknown as Record<string, { instance: { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }> } }>).acc!;
      result = await server.instance._registeredTools.request_handoff!.handler({ to: 'codex', instruction: 'review' }, {});
      finished.resolve();
    });
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: () => undefined });
    await adapter.start({ ...ids, prompt: 'go' }, async (event) => {
      if (event.type === 'handoff.requested') throw new Error('persist failed');
    });
    await finished.promise;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/could not be submitted/);
  });
});

describe('CodexAppServerAdapter：按 threadId 分 chain，審批送達失敗 fail closed', () => {
  it('一個執行緒的事件處理被阻塞時，另一個執行緒的審批請求照常到達（L-2）', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), (ctx) =>
      ctx.text === 'B' ? [{ kind: 'command', id: 'X', command: 'npm run clean', needsApproval: true }] : [{ kind: 'message', text: 'A working' }],
    );
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: () => undefined });
    const blockA = deferred();
    const blockedA = deferred();
    const approvalB = deferred<Emitted>();
    // 任務 A 的事件接收方卡住（例如編排器正在慢慢處理）
    await adapter.start({ ...ids, runId: 'run-a', prompt: 'A' }, (event) => {
      if (event.type === 'model.turn.started') {
        blockedA.resolve();
        return blockA.promise;
      }
    });
    await blockedA.promise;
    await adapter.start({ ...ids, runId: 'run-b', prompt: 'B' }, (event) => {
      if (event.type === 'approval.required') approvalB.resolve(event);
    });
    const approval = await approvalB.promise;
    expect(approval).toMatchObject({ runId: 'run-b', data: { toolName: 'shell', toolInput: { command: 'npm run clean' } } });
    blockA.resolve();
  });

  it('approval.required 沒能送達編排器：回覆 decline，命令不會執行，也不會一直掛起', async () => {
    const disk = new FakeCodexDisk();
    const server = new FakeCodexServer(disk, () => [{ kind: 'command', id: 'X', command: 'npm publish', needsApproval: true }]);
    const { logs, log } = recorder();
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, log });
    const declined = deferred<Emitted>();
    await adapter.start({ ...ids, prompt: 'go' }, async (event) => {
      if (event.type === 'approval.required') throw new Error('persist failed');
      if (event.type === 'tool.failed') declined.resolve(event);
    });
    const failed = await declined.promise;
    expect(failed.data).toMatchObject({ declined: true, executed: false });
    expect(disk.executions).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('LocalTestRunnerAdapter：void run() 不再產生未處理拒絕', () => {
  it('測試執行過程中發事件失敗：記錄日誌並 fail closed（runtime.error + failed），沒有未處理拒絕', async () => {
    unhandled = captureUnhandledRejections();
    const { logs, log } = recorder();
    const adapter = new LocalTestRunnerAdapter({ log });
    const events: Emitted[] = [];
    const failed = deferred();
    let failOnce = true;
    await adapter.start({ ...ids, prompt: '', mode: 'test', context: { testCommand: 'node -e "process.exit(0)"' } }, async (event) => {
      // agent.started 之後的第一條事件落盤失敗
      if (event.type !== 'agent.started' && failOnce) {
        failOnce = false;
        throw new Error('persist failed');
      }
      events.push(event);
      if (event.type === 'agent.status' && event.data.status === 'failed') failed.resolve();
    });
    await failed.promise;
    await turnEventLoop();
    expect(events.find((x) => x.type === 'runtime.error')?.data).toMatchObject({ code: 'TEST_RUNNER_FAILED', message: 'persist failed' });
    expect(logs.length).toBeGreaterThan(0);
    expect(unhandled.reasons).toEqual([]);
  });
});

describe('MockAgentAdapter：定時發出的事件失敗時只記錄', () => {
  it('沒有未處理拒絕', async () => {
    unhandled = captureUnhandledRejections();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logs, log } = recorder();
    const adapter = new MockAgentAdapter({ id: 'claude', name: 'Claude', kind: 'claude', ready: true, capabilities: [] }, { log });
    await adapter.start({ ...ids, prompt: 'hi' }, async (event) => {
      if (event.type !== 'agent.started') throw new Error('persist failed');
    });
    await vi.advanceTimersByTimeAsync(2000);
    vi.useRealTimers();
    await turnEventLoop();
    expect(logs).toHaveLength(3);
    expect(unhandled.reasons).toEqual([]);
  });
});
