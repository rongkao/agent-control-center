import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, STEP_INACTIVITY_TIMEOUT } from '@acc/core';
import type { AgentSessionHandle, CreateTaskInput, EventSink, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ClaudeQueryDriver, type DriverQuery } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { deferred, turnEventLoop } from './fakes/deferred.js';
import { emitRecorder } from './fakes/event-waiter.js';

/**
 * P0 第二批審查（P0-6 / H-10）：看門狗要認得“真實執行時仍在工作”的各種訊號，也不能被一個卡死的 cancel 拖住。
 *
 * 復現（修復前）：
 * - 只有頂層 text_delta 算“有動靜”：Claude 呼叫 Task 工具（子 agent）做一段長工作時，子 agent 的工具呼叫、結果和逐字輸出都帶
 *   parent_tool_use_id，被 adapter 直接丟掉；頂層只有 thinking_delta / input_json_delta（長時間思考、再寫一個大檔案）時同樣沒有動靜。
 *   15 分鐘後看門狗打斷正在正常工作的會話。
 * - 看門狗先 await adapter.cancel()，而 Claude 的 cancel 先等一個沒有超時的 interrupt()：執行時真卡死時 cancel 永遠不返回，
 *   abort 執行不到，watchdogBusy 一直不清，之後的每次檢查都跳過這個 run（不再重試、rescue 或 BLOCKED），任務一直顯示 RUNNING；
 *   按「停止」時這個會話已在 cancelledKeys 裡被跳過，卡住的 CLI 繼續佔著原生會話。
 *
 * 期望：子 agent 訊息、非文字增量等轉成不落盤的心跳（臨時事件），看門狗把它算作有動靜；Codex 的命令輸出增量同樣發心跳。
 * Claude cancel 的 interrupt 有超時，超時就直接結束程序；編排器等 adapter.cancel 也有超時，看門狗照常往下決策，
 * cancel 沒有完成的會話在停止任務時再取消一次。
 */

const quiet = () => undefined;
const MIN = 60_000;
const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const TASK: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test', budget: { maxDurationMs: 7 * 24 * 60 * MIN } };
const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

function bootClaude(script: (q: DriverQuery) => Promise<void> | void, adapterOptions: { interruptTimeoutMs?: number } = {}) {
  const clock = { now: 1_000_000 };
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: CWD, workspacePolicy: 'shared', log: quiet, now: () => clock.now, inactivityTimeoutMs: 15 * MIN });
  const driver = new ClaudeQueryDriver(script);
  orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet, now: () => clock.now, ...adapterOptions }));
  orchestrator.registerAdapter(new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true }));
  orchestrator.registerAdapter(new ControlledAgent({ id: 'codex', kind: 'codex' }));
  return { clock, store, bus, orchestrator, driver };
}

const inactivity = (events: UnifiedEvent[]) => events.filter((e) => e.type === 'runtime.error' && e.data.code === STEP_INACTIVITY_TIMEOUT);

describe('看門狗：真實執行時仍在工作的訊號', () => {
  it('Claude 的子 agent（Task 工具）每隔幾分鐘有工具呼叫、結果和輸出：看門狗不觸發', async () => {
    const env = bootClaude(async (q) => {
      q.init();
      await q.nextPrompt();
    });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const q = await env.driver.query(1);
    const sid = q.sessionId;
    // 頂層：呼叫 Task 工具（子 agent 開始一段長工作）
    q.send(msg({ type: 'assistant', parent_tool_use_id: null, session_id: sid, uuid: 'a0', message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { description: 'refactor' } }] } }));
    await turnEventLoop(5);
    await env.orchestrator.idle();

    for (let i = 1; i <= 5; i++) {
      env.clock.now += 4 * MIN;
      q.send(msg({ type: 'assistant', parent_tool_use_id: 'task-1', session_id: sid, uuid: `s${i}`, message: { content: [{ type: 'tool_use', id: `sub-${i}`, name: 'Read', input: { file_path: 'a.ts' } }] } }));
      q.send(msg({ type: 'user', parent_tool_use_id: 'task-1', session_id: sid, uuid: `r${i}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `sub-${i}`, content: 'ok' }] } }));
      q.send(msg({ type: 'stream_event', parent_tool_use_id: 'task-1', session_id: sid, uuid: `d${i}`, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working…' } } }));
      await turnEventLoop(5);
      await env.orchestrator.checkInactivity();
      await env.orchestrator.idle();
    }

    // 20 分鐘過去了（閾值 15 分鐘），子 agent 一直在幹活：沒有被當成卡住
    expect(inactivity(await env.store.listEvents(task.runId))).toEqual([]);
    expect(q.interrupts).toBe(0);
    expect(env.driver.queries).toHaveLength(1);
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('頂層只有 thinking_delta / input_json_delta（長時間思考、生成大段工具引數）：看門狗不觸發', async () => {
    const env = bootClaude(async (q) => {
      q.init();
      await q.nextPrompt();
    });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const q = await env.driver.query(1);
    for (let i = 1; i <= 5; i++) {
      env.clock.now += 4 * MIN;
      const delta = i % 2 ? { type: 'thinking_delta', thinking: 'hmm' } : { type: 'input_json_delta', partial_json: '{"content":"' };
      q.send(msg({ type: 'stream_event', parent_tool_use_id: null, session_id: q.sessionId, uuid: `d${i}`, event: { type: 'content_block_delta', index: 0, delta } }));
      await turnEventLoop(5);
      await env.orchestrator.checkInactivity();
      await env.orchestrator.idle();
    }
    expect(inactivity(await env.store.listEvents(task.runId))).toEqual([]);
    expect(q.interrupts).toBe(0);
  });

  it('對照：真的沒有任何動靜時照常觸發', async () => {
    const env = bootClaude(async (q) => {
      q.init();
      if (q.n === 1) {
        await q.nextPrompt();
        return;
      }
      await q.nextPrompt();
    });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    env.clock.now += 15 * MIN;
    await env.orchestrator.checkInactivity();
    await env.orchestrator.idle();
    expect(inactivity(await env.store.listEvents(task.runId))).toHaveLength(1);
  });

  it('Codex 的命令輸出增量（item/commandExecution/outputDelta）發出心跳（不落盤的臨時事件）', async () => {
    const release = deferred();
    const disk = new FakeCodexDisk();
    const server = new FakeCodexServer(disk, () => [
      { kind: 'notify', method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd-1', delta: 'compiling…' } },
      { kind: 'pause', until: release.promise },
    ]);
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: '/w', log: quiet });
    const rec = emitRecorder();
    const handle: AgentSessionHandle = await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'build it', mode: 'implement', cwd: '/w' }, rec.emit as EventSink);
    const heartbeat = await rec.waitFor((e) => e.data.ephemeral === true && e.data.heartbeat === true);
    expect(heartbeat).toMatchObject({ agentId: 'codex', sessionId: handle.sessionId });
    release.resolve();
    await adapter.cancel(handle.sessionId, rec.emit as EventSink);
  });
});

/** cancel 永遠不返回的 agent（執行時連中斷都不響應）。 */
class HangingCancelAgent extends ControlledAgent {
  override async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
    await new Promise(() => undefined);
  }
}

describe('看門狗：執行時連中斷都不響應', () => {
  it('真實 Claude adapter：interrupt() 永不返回 → 超時後直接結束程序，看門狗照常重試（重新連線原生會話）', async () => {
    const env = bootClaude(
      async (q) => {
        q.init();
        if (q.n === 1) {
          // CLI 卡死：讀走提示之後什麼都不發，中斷請求也永遠得不到回應
          (q.handle as { interrupt: () => Promise<unknown> }).interrupt = () => {
            q.interrupts += 1;
            return new Promise(() => undefined);
          };
          await q.nextPrompt();
          return;
        }
        for (;;) {
          const prompt = await q.nextPrompt();
          if (prompt === undefined) return;
          q.text('done');
          q.result();
        }
      },
      { interruptTimeoutMs: 5 },
    );
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const q1 = await env.driver.query(1);

    env.clock.now += 15 * MIN;
    await env.orchestrator.checkInactivity();
    await env.orchestrator.idle();

    expect(q1.interrupts).toBe(1);
    expect(q1.options.abortController?.signal.aborted).toBe(true);
    const events = await env.store.listEvents(task.runId);
    expect(inactivity(events).map((e) => e.data.next)).toEqual(['retry']);
    const q2 = await env.driver.query(2);
    expect(q2.options.resume).toBe(q1.sessionId);
  });

  it('編排器等 adapter.cancel 有超時：看門狗照常往下決策；按「停止」時再取消一次卡住的會話', async () => {
    const clock = { now: 1_000_000 };
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet, now: () => clock.now, inactivityTimeoutMs: 15 * MIN, cancelTimeoutMs: 5 });
    const claude = new HangingCancelAgent({ id: 'claude', kind: 'claude' });
    orchestrator.registerAdapter(claude);
    orchestrator.registerAdapter(new ControlledAgent({ id: 'codex', kind: 'codex' }));
    orchestrator.registerAdapter(new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true }));
    const task = await orchestrator.createTask(TASK);
    await orchestrator.idle();

    // 第一次：cancel 卡住，但看門狗照常重試（重新接上會話）
    clock.now += 15 * MIN;
    await orchestrator.checkInactivity();
    await orchestrator.idle();
    expect(claude.cancelled).toHaveLength(1);
    expect(inactivity(await store.listEvents(task.runId)).map((e) => e.data.next)).toEqual(['retry']);
    expect(claude.calls.at(-1)).toMatchObject({ via: 'resume' });

    // 第二次：看門狗沒有被卡住（watchdogBusy 已清），繼續按規則請 Codex 診斷
    clock.now += 15 * MIN;
    await orchestrator.checkInactivity();
    await orchestrator.idle();
    expect(inactivity(await store.listEvents(task.runId)).map((e) => e.data.next)).toEqual(['retry', 'rescue']);

    // 按「停止」：cancel 沒有完成的會話再取消一次（不會因為“已經取消過”被跳過）
    const before = claude.cancelled.length;
    await orchestrator.cancelTask(task.id);
    expect(claude.cancelled.length).toBeGreaterThan(before);
    expect((await store.getRun(task.runId))?.status).toBe('CANCELLED');
  });
});
