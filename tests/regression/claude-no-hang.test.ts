import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput, EventSink, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ClaudeQueryDriver, type DriverScript } from './fakes/claude-query-driver.js';
import { deferred, turnEventLoop } from './fakes/deferred.js';
import { busRecorder, emitRecorder } from './fakes/event-waiter.js';

/**
 * P0-6（H-10 / H-11，Claude 部分）：Claude 的一輪不管怎麼結束，工作流都不會靜默掛起。
 *
 * 復現（修復前）：
 * - probe4：CLI 在 init 之後崩潰（socket hang up）→ runtime.error + failed；工作流按“可重試”再派發一次，
 *   但會話還登記在線上表裡，“continue” 被髮給已經關閉的會話 → ADAPTER_SEND_FAILED → BLOCKED（本該透明重連）。
 * - probe5：result 為 error_during_execution（或 success + is_error，例如 529 重試耗盡、401 認證失敗）時只發 runtime.error(retryable=false)，
 *   不發終態：run 一直停在 RUNNING，Claude 一直顯示“編碼中”，只能等 30 分鐘時長預算兜底；也不看 api_error_status（529 本該可以重試）。
 * - CLI 以退出碼 0 意外結束（訊息流正常結束但這一輪沒有 result）時什麼都不發，介面一直顯示“編碼中”。
 *
 * 期望：
 * - 每一輪都以終態結束；按 api_error_status 判斷可否重試（408/429/5xx/529 與沒有 HTTP 響應的連線錯誤可以重試）；
 * - 訊息泵正常結束而會話沒有被取消：補發 CLAUDE_RUNTIME_EXITED（這一輪進行中時再加 failed）；
 * - 編排器收到 failed / 會話關閉後把會話移出線上表，重試改走 resume（重新連線原生會話），不再發給已關閉的會話。
 */

type Emitted = Parameters<EventSink>[0];
const quiet = () => undefined;
const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';

const WORKFLOW: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test' };
const CHAT: CreateTaskInput = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' };

function boot(script: DriverScript) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: CWD, workspacePolicy: 'shared', log: quiet });
  const driver = new ClaudeQueryDriver(script);
  orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet }));
  const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'ok' });
  orchestrator.registerAdapter(tester);
  orchestrator.registerAdapter(codex);
  // 必須在編排器之後訂閱：記錄到某個事件時，編排器對它的反應已經執行完
  const rec = busRecorder(bus);
  return { store, bus, orchestrator, driver, tester, codex, rec };
}

/** 工作流有了結果：完成，或者進入 BLOCKED。 */
const outcome = (e: UnifiedEvent) => e.type === 'run.completed' || (e.type === 'run.status' && e.data.status === 'BLOCKED');

/** 之後的每條提示都成功完成。 */
async function answerAll(q: Parameters<DriverScript>[0]): Promise<void> {
  for (;;) {
    const prompt = await q.nextPrompt();
    if (prompt === undefined) return;
    q.text('fixed');
    q.result();
  }
}

describe('probe4：Claude CLI 在一輪進行中崩潰', () => {
  it('會話移出線上表，重試改走 resume（重新連線原生會話），工作流跑完', async () => {
    const crash = deferred();
    const env = boot(async (q) => {
      q.init();
      if (q.n === 1) {
        await q.nextPrompt();
        await crash.promise;
        q.crash('socket hang up');
        return;
      }
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(WORKFLOW);
    await env.orchestrator.idle();
    crash.resolve();
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(events.find((e) => e.type === 'runtime.error')?.data).toMatchObject({ code: 'CLAUDE_RUNTIME_ERROR', retryable: true, sessionClosed: true });
    expect(events.some((e) => e.data.code === 'ADAPTER_SEND_FAILED')).toBe(false);
    // 第二個 query 續接的是同一個原生會話，繼續的是同一步
    expect(env.driver.queries).toHaveLength(2);
    expect(env.driver.queries[1]!.options.resume).toBe('native-1');
    expect(env.driver.queries[1]!.prompts[0]).toMatch(/transient runtime error/);
    expect(run.workflowState?.history.map((h) => h.outcome)).toEqual(['transient failure (CLAUDE_RUNTIME_ERROR); retrying', 'implementation turn completed', 'tests passed']);
    expect(env.tester.calls).toHaveLength(1);
  });
});

describe('probe5：Claude 這一輪以錯誤 result 結束', () => {
  it('error_during_execution（不可重試）：補發 failed，任務進入帶原因的 BLOCKED，介面不再顯示“編碼中”', async () => {
    const env = boot(async (q) => {
      q.init();
      await q.nextPrompt();
      q.result({ subtype: 'error_during_execution', errors: ['boom'] });
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(WORKFLOW);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'workflow', code: 'AGENT_FAILED' });
    expect(run.workflowState?.lastError).toMatchObject({ agentId: 'claude', code: 'CLAUDE_ERROR_DURING_EXECUTION', retryable: false });
    expect(run.agentSessions.claude?.status).toBe('failed');
    const terminal = events.filter((e) => e.agentId === 'claude' && e.type === 'agent.status' && ['completed', 'failed', 'cancelled'].includes(String(e.data.status)));
    expect(terminal.map((e) => e.data.status)).toEqual(['failed']);
    expect((await env.store.getTask(task.id))?.currentAction).toMatch(/claude failed in step implement: CLAUDE_ERROR_DURING_EXECUTION/);
  });

  it('success + is_error，api_error_status 529（過載，重試耗盡）：按可重試處理，在同一個會話上繼續，工作流跑完', async () => {
    const env = boot(async (q) => {
      q.init();
      await q.nextPrompt();
      q.assistantError('overloaded');
      q.result({ isError: true, apiErrorStatus: 529, text: 'API Error: 529 overloaded' });
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(WORKFLOW);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    // 這一輪只有一條 runtime.error（來自 result，程式碼取這一輪 assistant 報告的具體錯誤），可否重試按 api_error_status 判斷
    const errors = (await env.store.listEvents(task.runId)).filter((e) => e.type === 'runtime.error');
    expect(errors.map((e) => e.data)).toEqual([expect.objectContaining({ code: 'CLAUDE_OVERLOADED', retryable: true, apiErrorStatus: 529 })]);
    // CLI 程序還在（只是這一輪失敗了）：續接直接在同一個 query 上繼續，不重新拉起 CLI
    expect(env.driver.queries).toHaveLength(1);
    expect(env.driver.queries[0]!.prompts).toHaveLength(2);
    expect(run.workflowState?.history[0]?.outcome).toBe('transient failure (CLAUDE_OVERLOADED); retrying');
  });

  it('認證失敗（401）：不可重試，立即進入帶原因的 BLOCKED（不等 30 分鐘時長預算）', async () => {
    const env = boot(async (q) => {
      q.init();
      await q.nextPrompt();
      q.assistantError('authentication_failed');
      q.result({ isError: true, apiErrorStatus: 401, text: 'API Error: 401 invalid credentials' });
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(WORKFLOW);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.workflowState?.lastError).toMatchObject({ code: 'CLAUDE_AUTHENTICATION_FAILED', category: 'permission', retryable: false });
    expect(env.driver.queries[0]!.prompts).toHaveLength(1);
  });
});

describe('Claude CLI 以退出碼 0 意外結束', () => {
  it('工作流：發出 CLAUDE_RUNTIME_EXITED 和 failed，重試改走 resume，工作流跑完', async () => {
    const env = boot(async (q) => {
      q.init();
      if (q.n === 1) {
        await q.nextPrompt();
        q.end(); // 訊息流正常結束：CLI 退出了，但這一輪沒有 result
        return;
      }
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(WORKFLOW);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('COMPLETED');
    const exited = events.find((e) => e.data.code === 'CLAUDE_RUNTIME_EXITED');
    expect(exited).toMatchObject({ type: 'runtime.error', agentId: 'claude', data: { retryable: true, sessionClosed: true } });
    const failed = events.find((e) => e.type === 'agent.status' && e.data.status === 'failed');
    expect(failed && exited && failed.sequence > exited.sequence).toBe(true);
    expect(env.driver.queries[1]!.options.resume).toBe('native-1');
  });

  it('對話任務：介面不再顯示“編碼中”（會話為 failed），再發訊息時透明續接', async () => {
    const env = boot(async (q) => {
      q.init();
      if (q.n === 1) {
        await q.nextPrompt();
        q.end();
        return;
      }
      await answerAll(q);
    });
    const task = await env.orchestrator.createTask(CHAT);
    await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'failed');
    await env.orchestrator.idle();

    let run = (await env.store.getRun(task.runId))!;
    expect(run.agentSessions.claude?.status).toBe('failed');
    expect(run.status).toBe('RUNNING');
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);

    await env.orchestrator.sendMessage(task.id, 'claude', 'please continue');
    await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.agentSessions.claude?.status).toBe('completed');
    expect(env.driver.queries).toHaveLength(2);
    expect(env.driver.queries[1]!.options.resume).toBe('native-1');
    expect(env.driver.queries[1]!.prompts).toEqual(['please continue']);
  });
});

describe('Claude adapter：result 與執行時結束的對映', () => {
  const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

  async function oneTurn(finish: (q: Parameters<DriverScript>[0]) => void): Promise<Emitted[]> {
    const driver = new ClaudeQueryDriver(async (q) => {
      q.init();
      await q.nextPrompt();
      finish(q);
    });
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet });
    const rec = emitRecorder();
    await adapter.start({ ...ids, prompt: 'go', cwd: CWD, mode: 'implement' }, rec.emit);
    await rec.waitFor((e) => e.type === 'agent.status' && (e.data.status === 'failed' || e.data.status === 'completed'));
    await turnEventLoop(5);
    return rec.events;
  }

  it.each([
    [429, true, 'usage'],
    [529, true, 'runtime'],
    [500, true, 'runtime'],
    [408, true, 'runtime'],
    [null, true, 'runtime'],
    [401, false, 'permission'],
    [403, false, 'permission'],
    [400, false, 'runtime'],
  ] as const)('api_error_status=%s → retryable=%s（category %s），並以 failed 結束', async (status, retryable, category) => {
    const events = await oneTurn((q) => q.result({ isError: true, apiErrorStatus: status }));
    expect(events.find((e) => e.type === 'runtime.error')?.data).toMatchObject({ code: 'CLAUDE_API_ERROR', retryable, category });
    expect(events.filter((e) => e.type === 'agent.status' && e.data.status === 'failed')).toHaveLength(1);
  });

  it('max_output_tokens 是這一輪裡可以自行恢復的錯誤：只記警告，不當作失敗', async () => {
    const events = await oneTurn((q) => {
      q.assistantError('max_output_tokens');
      q.text('continued after recovery');
      q.result();
    });
    expect(events.some((e) => e.type === 'runtime.error')).toBe(false);
    expect(events.find((e) => e.type === 'runtime.warning')?.data).toMatchObject({ code: 'CLAUDE_MAX_OUTPUT_TOKENS' });
    expect(events.filter((e) => e.type === 'agent.status' && ['completed', 'failed'].includes(String(e.data.status))).map((e) => e.data.status)).toEqual(['completed']);
  });

  it('CLI 在初始化之前就崩潰：start 拋錯，不再額外發出任何終態或錯誤事件（這次派發由 start 的異常報告）', async () => {
    const driver = new ClaudeQueryDriver((q) => q.crash('spawn claude ENOENT'));
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet });
    const rec = emitRecorder();
    await expect(adapter.start({ ...ids, prompt: 'go', cwd: CWD, mode: 'implement' }, rec.emit)).rejects.toThrow(/ENOENT/);
    await turnEventLoop(10);
    expect(rec.events).toEqual([]);
  });
});
