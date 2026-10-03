import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { captureUnhandledRejections, deferred } from './fakes/deferred.js';
import { GatedAgent } from './fakes/gated-agent.js';

/**
 * P0-2（H-2 / M-10 / L-2）：編排反應放進按 run 序列的非同步佇列，與 adapter 的 emit 呼叫棧脫鉤。
 * - publish 只在持久化失敗時 reject；
 * - 反應異常轉為編排器來源的 runtime.error 並 fail closed，不再拋回 adapter；
 * - 一個 run 的反應被阻塞時，不影響其他 run。
 */

const quiet = () => undefined;

type PublishInput = Parameters<EventBus['publish']>[0];
const input = (runId: string, overrides: Partial<PublishInput> = {}): PublishInput => ({
  projectId: 'local',
  taskId: `task-${runId}`,
  runId,
  type: 'agent.message',
  severity: 'info',
  confidence: 'confirmed',
  data: { message: 'hi' },
  ...overrides,
});

/** 等待下一條滿足條件的已持久化事件（以觀察者身份訂閱，不按時間輪詢）。 */
function nextEvent(bus: EventBus, predicate: (event: UnifiedEvent) => boolean): Promise<UnifiedEvent> {
  return new Promise((resolve) => {
    const off = bus.subscribe((event) => {
      if (predicate(event)) {
        off();
        resolve(event);
      }
    });
  });
}

/** 取出 SDK 程序內 MCP 伺服器上註冊的 request_handoff 工具處理函式（模擬 Claude 呼叫該工具）。 */
function handoffTool(options: Options): (args: { to: string; instruction: string; content?: string }) => Promise<unknown> {
  const server = (options.mcpServers as Record<string, unknown> | undefined)?.acc as { instance?: { _registeredTools?: Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }> } };
  const tool = server?.instance?._registeredTools?.request_handoff;
  if (!tool) throw new Error('request_handoff tool is not registered');
  return (args) => tool.handler(args, {});
}

describe('EventBus：持久化與反應解耦（M-10）', () => {
  it('持久化成功後反應拋異常：publish 仍然 resolve，異常交給反應的 onError', async () => {
    const bus = new EventBus({ log: quiet });
    const persisted: number[] = [];
    const failures: Array<[string, number]> = [];
    bus.subscribe((event) => {
      persisted.push(event.sequence);
    }, { phase: 'persist' });
    bus.subscribe(
      () => {
        throw new Error('reaction bug');
      },
      { phase: 'post', onError: (error, event) => void failures.push([(error as Error).message, event.sequence]) },
    );

    await expect(bus.publish(input('run-1'))).resolves.toMatchObject({ sequence: 1 });
    expect(persisted).toEqual([1]);
    await bus.drain();
    expect(failures).toEqual([['reaction bug', 1]]);
  });

  it('持久化失敗：publish reject，觀察者和反應都不會執行', async () => {
    const bus = new EventBus({ log: quiet });
    const seen: string[] = [];
    bus.subscribe(() => {
      throw new Error('disk full');
    }, { phase: 'persist' });
    bus.subscribe(() => void seen.push('observer'));
    bus.subscribe(() => void seen.push('reaction'), { phase: 'post' });

    await expect(bus.publish(input('run-1'))).rejects.toThrow(/disk full/);
    await bus.drain();
    expect(seen).toEqual([]);
  });

  it('觀察者（例如 WebSocket 推送）拋異常不會讓 publish reject', async () => {
    const logged: string[] = [];
    const bus = new EventBus({ log: (message) => void logged.push(message) });
    bus.subscribe(() => {
      throw new Error('socket gone');
    });
    await expect(bus.publish(input('run-1'))).resolves.toBeDefined();
    expect(logged.length).toBe(1);
  });

  it('反應按 run 序列、互不阻塞；publish 不等待反應完成；drain 等待排隊期間新產生的反應', async () => {
    const bus = new EventBus({ log: quiet });
    const gate = deferred();
    const order: string[] = [];
    bus.subscribe(async (event) => {
      order.push(`${event.runId}:${String(event.data.message)}:start`);
      if (event.runId === 'run-a' && event.data.message === 'first') await gate.promise;
      if (event.runId === 'run-b' && event.data.message === 'first') await bus.publish(input('run-b', { data: { message: 'follow-up' } }));
      order.push(`${event.runId}:${String(event.data.message)}:end`);
    }, { phase: 'post' });

    // run-a 的第一個反應被卡住：publish 本身仍然立刻完成
    await bus.publish(input('run-a', { data: { message: 'first' } }));
    await bus.publish(input('run-a', { data: { message: 'second' } }));
    // 另一個 run 的反應不受影響
    await bus.publish(input('run-b', { data: { message: 'first' } }));
    await bus.drain('run-b');
    expect(order).toContain('run-b:follow-up:end');
    // run-a 內嚴格序列：第二個反應在第一個完成前不會開始
    expect(order.filter((x) => x.startsWith('run-a'))).toEqual(['run-a:first:start']);

    gate.resolve();
    await bus.drain();
    expect(order.filter((x) => x.startsWith('run-a'))).toEqual(['run-a:first:start', 'run-a:first:end', 'run-a:second:start', 'run-a:second:end']);
  });
});

describe('Orchestrator：反應異常隔離（H-2）', () => {
  it('probe7 迴歸：Claude 在同一輪並行呼叫兩次 request_handoff（auto），程序不退出，兩次交接按順序送達', async () => {
    const unhandled = captureUnhandledRejections();
    try {
      const store = new InMemoryControlPlaneStore();
      const bus = new EventBus({ log: quiet });
      const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
      // 目標 Codex 啟動很慢：第一次交接啟動它的時候，第二次交接請求已經到了
      const codex = new GatedAgent({ id: 'codex', kind: 'codex' });
      codex.startGate = deferred();
      const submitted = deferred<unknown[]>();
      const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
        if (ctx.prompt !== 'split the work') return;
        const request = handoffTool(ctx.options);
        submitted.resolve(await Promise.all([request({ to: 'codex', instruction: 'review A' }), request({ to: 'codex', instruction: 'review B' })]));
      });
      orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet }));
      orchestrator.registerAdapter(codex);

      const task = await orchestrator.createTask({ title: 't', prompt: 'split the work', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto' });
      const results = await submitted.promise;
      await codex.startCalled.promise;
      codex.startGate.resolve();
      await orchestrator.idle();

      // 工具呼叫本身都成功返回給 Claude
      expect(JSON.stringify(results)).toContain('submitted to the orchestrator');
      // 兩次交接序列執行：第一次啟動 Codex，第二次在同一會話上繼續，沒有“槽位已佔用”衝突
      expect(codex.starts).toHaveLength(1);
      expect(codex.starts[0]?.prompt).toContain('review A');
      expect(codex.sends).toHaveLength(1);
      expect(codex.sends[0]?.message).toContain('review B');
      const events = await store.listEvents(task.runId);
      expect(events.filter((x) => x.data.code === 'SESSION_OWNERSHIP_CONFLICT' || x.data.code === 'ORCHESTRATOR_REACTION_FAILED')).toEqual([]);
      const run = (await store.getRun(task.runId))!;
      expect(run.settings).toMatchObject({ autoHandoffsUsed: 2 });
      expect(run.status).toBe('RUNNING');
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it('編排反應拋異常：記為編排器的 runtime.error 並 fail closed；Claude 會話保持存活並繼續消費訊息', async () => {
    const unhandled = captureUnhandledRejections();
    try {
      const store = new InMemoryControlPlaneStore();
      const bus = new EventBus({ log: quiet });
      const orchestrator = new Orchestrator(store, bus, { log: quiet });
      const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
        ctx.send({ type: 'assistant', parent_tool_use_id: null, session_id: ctx.sessionId, uuid: 'u', message: { content: [{ type: 'text', text: `echo: ${ctx.prompt}` }] } } as never);
      });
      orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet }));

      // 注入一個編排器 bug：第一次處理“本輪完成”訊號時拋異常
      const internals = orchestrator as unknown as { onAgentSignal(event: UnifiedEvent): Promise<void> };
      const original = internals.onAgentSignal.bind(orchestrator);
      let injected = 0;
      internals.onAgentSignal = async (event) => {
        if (event.type === 'agent.status' && event.data.status === 'completed' && injected++ === 0) throw new Error('injected orchestrator bug');
        return original(event);
      };

      const firstTurn = nextEvent(bus, (e) => e.type === 'agent.status' && e.data.status === 'completed');
      const task = await orchestrator.createTask({ title: 'chat', prompt: 'first', agentId: 'claude', workflow: 'manual' });
      await firstTurn;
      await orchestrator.idle();

      let events = await store.listEvents(task.runId);
      const failure = events.find((x) => x.data.code === 'ORCHESTRATOR_REACTION_FAILED');
      expect(failure).toMatchObject({ type: 'runtime.error', agentId: undefined, data: { source: 'orchestrator', reaction: 'workflow', message: 'injected orchestrator bug' } });
      expect(failure?.data.triggerSequence).toBe(events.find((x) => x.type === 'agent.status' && x.data.status === 'completed')?.sequence);
      // 不算到 provider 頭上：沒有 Claude 執行時錯誤，也沒有 agent 失敗狀態
      expect(events.some((x) => x.data.code === 'CLAUDE_RUNTIME_ERROR')).toBe(false);
      expect(events.some((x) => x.agentId === 'claude' && x.type === 'agent.status' && x.data.status === 'failed')).toBe(false);
      // 按既有規則 fail closed
      expect((await store.getRun(task.runId))?.status).toBe('BLOCKED');

      // 會話仍然活著：同一個 SDK query 繼續消費下一條訊息
      const secondReply = nextEvent(bus, (e) => e.type === 'agent.message' && e.data.message === 'echo: second');
      // 任務已阻塞：對話任務發訊息前要顯式恢復（P0-7 / H-8）；恢復後訊息仍由同一個 SDK query 消費
      await orchestrator.sendMessage(task.id, 'claude', 'second', { resume: true });
      await secondReply;
      await orchestrator.idle();
      expect(runtime.queries).toHaveLength(1);
      expect(runtime.queries[0]?.prompts).toEqual(['first', 'second']);
      events = await store.listEvents(task.runId);
      expect(events.filter((x) => x.data.code === 'ORCHESTRATOR_REACTION_FAILED')).toHaveLength(1);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it('反應持續失敗時不會無限產生錯誤事件：處理“編排器出錯”事件本身失敗只記錄日誌', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { log: quiet });
    orchestrator.registerAdapter(new GatedAgent({ id: 'claude', kind: 'claude' }));
    // 一個對每個事件都會拋異常的編排器 bug
    const internals = orchestrator as unknown as { onAgentSignal(event: UnifiedEvent): Promise<void> };
    internals.onAgentSignal = async () => {
      throw new Error('persistent orchestrator bug');
    };

    const task = await orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();

    const events = await store.listEvents(task.runId);
    const failures = events.filter((x) => x.data.code === 'ORCHESTRATOR_REACTION_FAILED');
    expect(failures.length).toBeGreaterThan(0);
    // 每條錯誤都來自一個普通事件，沒有一條是由另一條“編排器出錯”事件引發的
    const failureIds = new Set(failures.map((x) => x.id));
    expect(failures.filter((x) => failureIds.has(String(x.data.triggerEventId)))).toEqual([]);
    expect((await store.getRun(task.runId))?.status).toBe('BLOCKED');
  });

  it('L-2：任務 A 的反應被阻塞時，任務 B 的 Codex 審批請求仍能到達編排器', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { log: quiet });
    const server = new FakeCodexServer(new FakeCodexDisk(), (ctx) =>
      ctx.text.includes('task B') ? [{ kind: 'command', id: 'X', command: 'rm -rf build', needsApproval: true }] : [{ kind: 'message', text: 'implemented' }],
    );
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: quiet });
    // 任務 A 的下一步（測試）啟動被卡住：它的編排反應一直停在 adapter.start 上
    const tester = new GatedAgent({ id: 'test', kind: 'test' });
    tester.startGate = deferred();
    orchestrator.registerAdapter(codex);
    orchestrator.registerAdapter(tester);

    const taskA = await orchestrator.createTask({ title: 'A', prompt: 'task A: implement', agentId: 'codex', testCommand: 'npm test' });
    await tester.startCalled.promise;

    const approvalB = nextEvent(bus, (e) => e.type === 'approval.required' && e.agentId === 'codex');
    const taskB = await orchestrator.createTask({ title: 'B', prompt: 'task B: clean the build', agentId: 'codex', workflow: 'manual' });
    const approval = await approvalB;

    expect(approval.runId).toBe(taskB.runId);
    expect((await store.getRun(taskB.runId))?.status).toBe('WAITING_APPROVAL');
    // A 仍然停在被卡住的反應裡
    expect(tester.startGate.settled).toBe(false);
    expect((await store.getRun(taskA.runId))?.workflowState?.step).toBe('test');

    tester.startGate.resolve();
    await orchestrator.idle();
  });
});
