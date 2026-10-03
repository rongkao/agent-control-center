import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { DEFAULT_STEP_INACTIVITY_MS, EventBus, Orchestrator, STEP_INACTIVITY_TIMEOUT } from '@acc/core';
import type { CreateTaskInput, UnifiedEvent } from '@acc/core';
import { startServer, StartupError } from '@acc/server';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ClaudeQueryDriver } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { busRecorder } from './fakes/event-waiter.js';
import { authHeaders, createServerSandbox, expectStartupFailure, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0-6（H-10）：按步驟計算的不活動看門狗。
 *
 * 復現（修復前）：工作流正在等的 agent 在一步裡再也沒有任何動靜（執行時卡住、終態丟了），
 * 編排器沒有任何機制發現它，只能等 30 分鐘的時長預算把整個任務 BLOCKED（repro-error-result：+29 分鐘仍是 RUNNING）。
 *
 * 期望：一個步驟在閾值內沒有任何 agent 事件（包括逐字流式輸出），就按 重試（重新接上會話）→ rescue（請另一個 agent 診斷）→
 * 帶原因的 BLOCKED 處理。等待人工（審批、閘門）的時間不算不活動。閾值可配置：環境變數 ACC_STEP_INACTIVITY_MS（服務端預設值）
 * 與每個任務的 RunSettings.inactivityTimeoutMs；0 表示關閉。全部用可注入時鐘測試，不等真即時間。
 */

const quiet = () => undefined;
const MIN = 60_000;
const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';
/** 隔離 H-7（時長預算把等待時間也算進去，由 P0-7 修）：這裡只看看門狗。 */
const TASK: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test', budget: { maxDurationMs: 7 * 24 * 60 * MIN } };

function boot(options: { inactivityTimeoutMs?: number } = {}) {
  let clock = 1_000_000;
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet, now: () => clock, inactivityTimeoutMs: options.inactivityTimeoutMs ?? 10 * MIN });
  const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);
  /** 時鐘前進並執行一次看門狗檢查。 */
  const advance = async (ms: number) => {
    clock += ms;
    await orchestrator.checkInactivity();
    await orchestrator.idle();
  };
  return { store, bus, orchestrator, claude, codex, tester, advance };
}

const inactivityErrors = (events: UnifiedEvent[]) => events.filter((e) => e.type === 'runtime.error' && e.data.code === STEP_INACTIVITY_TIMEOUT);

describe('看門狗：重試 → rescue → 帶原因的 BLOCKED', () => {
  it('實現步驟一直沒有動靜：先重新接上會話重試，再請 Codex 診斷，最後進入帶原因的 BLOCKED', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();

    // 閾值之內：什麼都不做
    await env.advance(10 * MIN - 1);
    expect(env.claude.calls).toHaveLength(1);
    expect(env.claude.cancelled).toHaveLength(0);

    // 1. 到達閾值：停掉沒有反應的會話，重新接上（resume）並在同一步繼續
    await env.advance(1);
    let run = (await env.store.getRun(task.runId))!;
    let events = await env.store.listEvents(task.runId);
    expect(env.claude.cancelled).toHaveLength(1);
    expect(env.claude.calls[1]).toMatchObject({ via: 'resume', reason: 'message', mode: 'implement' });
    expect(env.claude.calls[1]?.prompt).toMatch(/stopped responding/);
    expect(inactivityErrors(events)[0]).toMatchObject({ agentId: 'claude', data: { step: 'implement', idleMs: 10 * MIN, thresholdMs: 10 * MIN, retryable: true } });
    expect(run.status).toBe('RUNNING');
    expect(run.workflowState).toMatchObject({ step: 'implement', awaitingAgentId: 'claude', transportRetriesUsed: 1 });

    // 2. 重試之後仍然沒有動靜：請評審 agent（Codex）以唯讀方式診斷
    await env.advance(10 * MIN);
    run = (await env.store.getRun(task.runId))!;
    expect(env.claude.cancelled).toHaveLength(2);
    expect(env.codex.calls[0]).toMatchObject({ via: 'start', mode: 'rescue' });
    expect(env.codex.calls[0]?.prompt).toMatch(/stopped responding/);
    expect(run.workflowState).toMatchObject({ step: 'rescue', awaitingAgentId: 'codex', rescueUsed: true });

    // 3. 診斷也沒有動靜：進入帶原因的 BLOCKED，等操作員決定
    await env.advance(10 * MIN);
    run = (await env.store.getRun(task.runId))!;
    events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'workflow', code: 'STEP_INACTIVE' });
    expect(env.codex.cancelled).toHaveLength(1);
    expect(inactivityErrors(events).map((e) => e.agentId)).toEqual(['claude', 'claude', 'codex']);
    expect((await env.store.getTask(task.id))?.currentAction).toMatch(/codex produced no activity for 10 min in step rescue/);

    // BLOCKED 之後不再檢查
    await env.advance(60 * MIN);
    expect(inactivityErrors(await env.store.listEvents(task.runId))).toHaveLength(3);
  });

  it('阻塞之後操作員按「重試」：重新給一次自動重試的額度（再卡住時先重新接上，而不是馬上又阻塞）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await env.advance(10 * MIN); // 重試
    await env.advance(10 * MIN); // rescue
    await env.advance(10 * MIN); // BLOCKED
    expect((await env.store.getRun(task.runId))?.status).toBe('BLOCKED');

    await env.orchestrator.resolveGate(task.id, 'retry', '操作員按了「重試」：請從中斷的地方繼續完成這一步。');
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.workflowState).toMatchObject({ step: 'retry', awaitingAgentId: 'claude', transportRetriesUsed: 0 });
    expect(env.claude.calls.at(-1)).toMatchObject({ via: 'resume' });

    await env.advance(10 * MIN);
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(inactivityErrors(await env.store.listEvents(task.runId)).at(-1)?.data).toMatchObject({ next: 'retry', step: 'retry' });
  });

  it('重試之後這一步正常完成：流程照常推進，計數隨成功重置', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await env.advance(10 * MIN);
    expect(env.claude.calls.at(-1)).toMatchObject({ via: 'resume' });

    await env.claude.complete('Fixed.');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(run.workflowState?.transportRetriesUsed).toBe(0);
    expect(env.tester.calls).toHaveLength(1);
  });
});

describe('看門狗 + 真實 Claude adapter：執行時卡住、既不報錯也不退出', () => {
  it('超過閾值後停掉卡住的 query，用原生會話重新連線（resume）繼續這一步，工作流跑完', async () => {
    let clock = 1_000_000;
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: CWD, workspacePolicy: 'shared', log: quiet, now: () => clock, inactivityTimeoutMs: 10 * MIN });
    const driver = new ClaudeQueryDriver(async (q) => {
      q.init();
      if (q.n === 1) {
        await q.nextPrompt(); // 讀走提示之後再也沒有任何訊息（CLI 卡死）
        return;
      }
      for (;;) {
        const prompt = await q.nextPrompt();
        if (prompt === undefined) return;
        q.text('done');
        q.result();
      }
    });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet }));
    const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
    orchestrator.registerAdapter(tester);
    orchestrator.registerAdapter(new ControlledAgent({ id: 'codex', kind: 'codex' }));
    // 必須在編排器之後訂閱：記錄到某個事件時，編排器對它的反應已經執行完
    const rec = busRecorder(bus);

    const task = await orchestrator.createTask(TASK);
    await orchestrator.idle();
    clock += 10 * MIN;
    await orchestrator.checkInactivity();
    await rec.waitFor((e) => e.type === 'run.completed');
    await orchestrator.idle();

    const run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(driver.queries[0]!.interrupts).toBe(1);
    expect(driver.queries[1]!.options.resume).toBe('native-1');
    expect(driver.queries[1]!.prompts[0]).toMatch(/stopped responding/);
    expect(tester.calls).toHaveLength(1);
  });
});

describe('看門狗：什麼算“有動靜”', () => {
  it('agent 的任何事件（工具呼叫、回覆）都會重新計時', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await env.advance(9 * MIN);
    await env.claude.emit('tool.started', { toolCallId: 't1', toolName: 'Bash' });
    await env.orchestrator.idle();
    await env.advance(9 * MIN);
    expect(env.claude.cancelled).toHaveLength(0);
    await env.advance(1 * MIN);
    expect(env.claude.cancelled).toHaveLength(1);
    expect(inactivityErrors(await env.store.listEvents(task.runId))).toHaveLength(1);
  });

  it('逐字流式輸出（不落盤的臨時事件）也算有動靜：長回答不會被誤判為卡住', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await env.advance(9 * MIN);
    // P0-9 / L-1：sink 的身份由編排器固定，createSink 需要傳入這個 adapter 所在的任務與 agent
    const sink = env.bus.createSink({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude' });
    await sink({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId: env.claude.sessionId, type: 'agent.message', severity: 'info', confidence: 'confirmed', data: { ephemeral: true, direction: 'from-agent', delta: 'thinking…' } });
    await env.advance(9 * MIN);
    expect(env.claude.cancelled).toHaveLength(0);
    await env.advance(1 * MIN);
    expect(env.claude.cancelled).toHaveLength(1);
  });

  it('等待審批的時間不算不活動：審批結束回到 RUNNING 後重新計時', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await env.claude.emit('approval.required', { approvalId: 'a1', toolName: 'Bash', toolInput: { command: 'npm install' }, summary: 'Install deps' }, env.claude.sessionId, 'warning');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');

    await env.advance(3 * 60 * MIN); // 操作員三小時後才回來
    expect(env.claude.cancelled).toHaveLength(0);

    await env.orchestrator.resolveApproval(task.id, 'a1', 'approve');
    await env.orchestrator.idle();
    await env.advance(10 * MIN - 1);
    expect(env.claude.cancelled).toHaveLength(0);
    await env.advance(1);
    expect(env.claude.cancelled).toHaveLength(1);
  });

  it('對話任務不受步驟看門狗管理（沒有“正在等待的步驟”）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: TASK.budget });
    await env.orchestrator.idle();
    await env.advance(24 * 60 * MIN);
    expect(env.claude.cancelled).toHaveLength(0);
    expect(inactivityErrors(await env.store.listEvents(task.runId))).toHaveLength(0);
  });
});

describe('看門狗：閾值配置', () => {
  it('預設值 15 分鐘；任務可以用 RunSettings.inactivityTimeoutMs 單獨設定，0 表示關閉', async () => {
    expect(DEFAULT_STEP_INACTIVITY_MS).toBe(15 * MIN);

    const env = boot();
    const quick = await env.orchestrator.createTask({ ...TASK, inactivityTimeoutMs: 1 * MIN });
    await env.orchestrator.idle();
    expect((await env.store.getRun(quick.runId))?.settings?.inactivityTimeoutMs).toBe(1 * MIN);
    await env.advance(1 * MIN);
    expect(env.claude.cancelled).toHaveLength(1);

    const off = boot();
    const disabled = await off.orchestrator.createTask({ ...TASK, inactivityTimeoutMs: 0 });
    await off.orchestrator.idle();
    await off.advance(24 * 60 * MIN);
    expect(off.claude.cancelled).toHaveLength(0);
    expect((await off.store.getRun(disabled.runId))?.status).toBe('RUNNING');
  });

  it('編排器沒有指定時使用預設值；任務建立時把閾值寫進 RunSettings', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    orchestrator.registerAdapter(new ControlledAgent({ id: 'claude', kind: 'claude' }));
    const task = await orchestrator.createTask({ title: 'fix', prompt: 'p', agentId: 'claude' });
    expect((await store.getRun(task.runId))?.settings?.inactivityTimeoutMs).toBe(DEFAULT_STEP_INACTIVITY_MS);
  });
});

describe('看門狗：服務端配置（ACC_STEP_INACTIVITY_MS）', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('環境變數設定預設閾值；建立任務時可以單獨指定；非法值拒絕啟動或返回 400', async () => {
    const box = createServerSandbox('acc-watchdog-');
    cleanups.push(box.cleanup);

    const bad = await expectStartupFailure(startServer(sandboxServerOptions(box, [new ControlledAgent({ id: 'claude', kind: 'claude' })], { env: { ACC_STEP_INACTIVITY_MS: '15min' } })));
    expect(bad).toBeInstanceOf(StartupError);
    expect(bad.code).toBe('ACC_INVALID_CONFIG');
    expect(bad.message).toContain('ACC_STEP_INACTIVITY_MS');

    const server = await startServer(sandboxServerOptions(box, [new ControlledAgent({ id: 'claude', kind: 'claude' })], { env: { ACC_STEP_INACTIVITY_MS: '120000' } }));
    cleanups.push(() => server.close());
    const post = (payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload });

    const byEnv = await post({ prompt: 'fix it', agentId: 'claude' });
    expect(byEnv.statusCode).toBe(201);
    expect((await server.store.getRun(byEnv.json().runId))?.settings?.inactivityTimeoutMs).toBe(120_000);

    const explicit = await post({ prompt: 'fix it', agentId: 'claude', inactivityTimeoutMs: 30_000 });
    expect(explicit.statusCode).toBe(201);
    expect((await server.store.getRun(explicit.json().runId))?.settings?.inactivityTimeoutMs).toBe(30_000);

    expect((await post({ prompt: 'fix it', agentId: 'claude', inactivityTimeoutMs: -1 })).statusCode).toBe(400);
    await server.orchestrator.idle();
  });
});
