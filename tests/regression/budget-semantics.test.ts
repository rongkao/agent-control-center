import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, activeDurationMs } from '@acc/core';
import type { AgentAdapter, RunSnapshot, TaskRecord, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { startServer } from '@acc/server';
import type { RunningServer } from '@acc/server';
import { blockedBanner, blockedSendConfirm, type BlockedInput } from '../../apps/web/src/blocked-ui.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0-7 預算語義修正（H-7、H-8）。
 *
 * 現象（修復前，均實測）：
 * - probe8：評審閘門停留 31 分鐘後點 accept，閘門自己的 run.status RUNNING 先觸發 budget:maxDurationMs 進入 BLOCKED，
 *   BLOCKED→COMPLETED 被狀態機靜默拒絕，介面卻返回成功；再點一次結果一樣，任務永遠完成不了。
 * - probe2：stall 阻塞後執行 gate retry，Claude 被派發出去，但它的完成訊號被丟棄（run 又被停滯預算阻塞了）。
 * - 限額用 >= 判斷：恰好用滿最後一輪時，這一輪的成功完成被丟掉。
 * - 時長 = now - startedAt：等待人工、對話空閒、服務停機都算進去——服務停了 13 小時後重啟，恢復時立刻被 maxDurationMs 阻塞。
 * - 對話任務沿用實現型任務的預算：空閒 30 分鐘被阻塞、3 輪純問答被判停滯、12 條訊息後額度用完；Ask Both 只派發一半。
 * - 向 BLOCKED 的對話任務發訊息：任務仍顯示 BLOCKED，agent 卻在工作，而且不再受任何限額約束。
 * - 被拒絕的狀態遷移不留任何事件；沒有預算 API。
 *
 * 期望：見各用例。時間流逝一律用可注入時鐘，不 sleep。
 */

const MIN = 60_000;
const quiet = () => undefined;

function boot(agents: AgentAdapter[], options: { store?: InMemoryControlPlaneStore; clock?: { now: number } } = {}) {
  const store = options.store ?? new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const clock = options.clock ?? { now: 1_000_000 };
  const orchestrator = new Orchestrator(store, bus, { now: () => clock.now, log: quiet, workspacePolicy: 'shared' });
  for (const agent of agents) orchestrator.registerAdapter(agent);
  return { store, bus, clock, orchestrator };
}

type Env = ReturnType<typeof boot>;

const budgetEvents = (events: UnifiedEvent[]) => events.filter((e) => e.type === 'budget.exceeded' || e.type === 'budget.stalled');
const snapshot = async (env: Pick<Env, 'store'>, runId: string) => (await env.store.getRun(runId))!;

function claudeAgent() {
  return new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
}

function testRunner(outcomes: Array<{ kind: 'test'; passed: boolean }> = []) {
  return new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, outcomes, { kind: 'test', passed: true });
}

describe('H-7：人工閘門與預算', () => {
  it('probe8：評審閘門停留 31 分鐘後「接受結果」→ COMPLETED；接受不經過 RUNNING，也不觸發預算', async () => {
    const env = boot([new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }), testRunner()]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', reviewGate: true, budget: { maxStallCount: 99 } });
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('WAITING_INPUT');

    // 操作員 31 分鐘後才處理評審閘門：等待人工的時間不算時長
    env.clock.now += 31 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();

    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(run.pendingInputs).toEqual([]);
    const events = await env.store.listEvents(task.runId);
    expect(budgetEvents(events)).toEqual([]);
    expect(events.some((e) => e.type === 'run.status' && e.data.step === 'workflow:gate-accept')).toBe(false);
    expect(events.find((e) => e.type === 'run.completed')?.data).toMatchObject({ acceptedBy: 'operator' });
  });

  it('因預算阻塞的工作流直接「接受結果」→ COMPLETED（不先回到 RUNNING），仍在工作的 agent 被停止', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    env.clock.now += 30 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).blockedBy).toMatchObject({ source: 'budget', code: 'maxDurationMs' });

    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'run.status' && e.data.status === 'RUNNING' && String(e.data.step).includes('accept'))).toEqual([]);
  });

  it('probe2：停滯阻塞後 gate retry → 顯式續額（budget.extended），重試這一輪的完成訊號被處理，流程走到完成', async () => {
    const claude = claudeAgent();
    const tester = testRunner();
    const env = boot([claude, tester]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', budget: { maxStallCount: 1 } });
    await env.orchestrator.idle();
    // 兩輪純文字、沒有任何工具：第 2 輪超出“最多 1 輪沒有進展”
    await claude.emit('model.turn.completed', {});
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
    await claude.emit('model.turn.completed', {});
    await env.orchestrator.idle();
    let run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxStallCount' });

    await env.orchestrator.resolveGate(task.id, 'retry', 'please continue');
    await env.orchestrator.idle();
    run = await snapshot(env, task.runId);
    expect(run.status).toBe('RUNNING');
    expect(run.budget.stallCount).toBe(0);
    const extended = (await env.store.listEvents(task.runId)).find((e) => e.type === 'budget.extended');
    expect(extended?.data).toMatchObject({ reason: 'gate', gateAction: 'retry', renew: true });
    expect(claude.calls.at(-1)?.prompt).toContain('please continue');

    // 重試這一輪同樣是純文字，但完成了：完成訊號被處理，進入測試，測試通過後任務完成
    await claude.emit('model.turn.completed', {});
    await claude.complete('fixed');
    await env.orchestrator.idle();
    run = await snapshot(env, task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(run.workflowState?.step).toBe('done');
    expect(tester.calls).toHaveLength(1);
  });

  it('>= 邊界：限額恰好用滿最後一輪時，這一輪的成功完成照常被接受', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxTurns: 1 } });
    await env.orchestrator.idle();
    await claude.emit('tool.completed', { toolCallId: 'edit-1', toolName: 'Edit' });
    await claude.emit('model.turn.completed', {});
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');

    await claude.complete('done');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
    expect(budgetEvents(await env.store.listEvents(task.runId))).toEqual([]);
  });

  it('用滿之後不再派發新的一輪：測試失敗要重試時因 maxTurns 阻塞，而不是先讓 agent 做完一輪再丟掉結果', async () => {
    const claude = claudeAgent();
    const tester = testRunner([{ kind: 'test', passed: false }]);
    const env = boot([claude, tester]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', budget: { maxTurns: 1 } });
    await env.orchestrator.idle();
    await claude.emit('tool.completed', { toolCallId: 'edit-1', toolName: 'Edit' });
    await claude.emit('model.turn.completed', {});
    await claude.complete('done');
    await env.orchestrator.idle();

    // 最後一輪的完成被接受：測試照常執行（測試執行器不消耗模型輪次）
    expect(tester.calls).toHaveLength(1);
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxTurns' });
    expect(claude.calls).toHaveLength(1);
    expect(budgetEvents(await env.store.listEvents(task.runId)).map((e) => e.data)).toEqual([expect.objectContaining({ limit: 'maxTurns', used: 1, max: 1 })]);
  });

  it('被狀態機拒絕的狀態遷移留下 TRANSITION_REJECTED 警告（不再靜默）', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    await env.bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, type: 'run.status', severity: 'info', confidence: 'confirmed', data: { status: 'CREATED', step: 'bogus' } });
    await env.orchestrator.idle();

    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
    const warning = (await env.store.listEvents(task.runId)).find((e) => e.type === 'runtime.warning' && e.data.code === 'TRANSITION_REJECTED');
    expect(warning?.data).toMatchObject({ from: 'RUNNING', to: 'CREATED', eventType: 'run.status' });
  });
});

describe('時長只統計 agent 實際工作的時間', () => {
  it('服務停機 40 分鐘後重啟：停機時間不計入，續接的會話不會被立即阻塞；之後只按工作時間累計', async () => {
    const store = new InMemoryControlPlaneStore();
    const clock = { now: 1_000_000 };
    const claude1 = claudeAgent();
    const first = boot([claude1], { store, clock });
    const task = await first.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude' });
    await first.orchestrator.idle();
    // 工作了 10 分鐘（最後一個事件在第 10 分鐘）
    clock.now += 10 * MIN;
    await claude1.emit('tool.completed', { toolCallId: 'a', toolName: 'Edit' });
    await first.orchestrator.idle();

    // 服務停機 40 分鐘（程序直接結束，不做任何清理），然後重啟
    clock.now += 40 * MIN;
    const claude2 = claudeAgent();
    const second = boot([claude2], { store, clock });
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    await second.orchestrator.checkBudgets();
    await second.orchestrator.idle();
    expect(report.resumed).toEqual([task.runId]);
    let run = await snapshot(second, task.runId);
    expect(run.status).toBe('RUNNING');
    expect(budgetEvents(await store.listEvents(task.runId))).toEqual([]);
    expect(activeDurationMs(run.budget, clock.now)).toBe(10 * MIN);

    // 再工作 19 分鐘（共 29 分鐘）仍在執行；滿 30 分鐘才停
    clock.now += 19 * MIN;
    await second.orchestrator.checkBudgets();
    await second.orchestrator.idle();
    expect((await snapshot(second, task.runId)).status).toBe('RUNNING');
    clock.now += 1 * MIN;
    await second.orchestrator.checkBudgets();
    await second.orchestrator.idle();
    run = await snapshot(second, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(budgetEvents(await store.listEvents(task.runId)).map((e) => e.data)).toEqual([expect.objectContaining({ limit: 'maxDurationMs', used: 30 * MIN, max: 30 * MIN })]);
  });

  it('真實案例：升級前的對話任務在服務停了 13 小時後重啟，不會被 maxDurationMs 阻塞', async () => {
    const store = new InMemoryControlPlaneStore();
    const clock = { now: 1_000_000 };
    const first = boot([new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] })], { store, clock });
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await first.orchestrator.idle();
    await makeLegacySnapshot(store, task.runId);

    clock.now += 13 * 60 * MIN;
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const second = boot([claude], { store, clock });
    await second.orchestrator.recover();
    await second.orchestrator.idle();
    await second.orchestrator.checkBudgets();
    await second.orchestrator.idle();
    expect((await snapshot(second, task.runId)).status).toBe('RUNNING');

    await second.orchestrator.sendMessage(task.id, 'claude', 'hello again');
    await second.orchestrator.idle();
    expect((await snapshot(second, task.runId)).status).toBe('RUNNING');
    expect(claude.calls).toHaveLength(1);
  });

  it('已經因此被阻塞的舊任務：一鍵放寬預算就恢復，之後可以繼續對話', async () => {
    const store = new InMemoryControlPlaneStore();
    const clock = { now: 1_000_000 };
    const first = boot([new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] })], { store, clock });
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await first.orchestrator.idle();
    // 升級前的阻塞：只有 currentStep = budget:maxDurationMs，沒有 blockedBy，也沒有有效工作時長欄位
    await makeLegacySnapshot(store, task.runId, (run, t) => {
      run.status = 'BLOCKED';
      t.status = 'BLOCKED';
      run.currentStep = 'budget:maxDurationMs';
      delete run.blockedBy;
    });

    clock.now += 13 * 60 * MIN;
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const second = boot([claude], { store, clock });
    await second.orchestrator.recover();
    await second.orchestrator.idle();

    const result = await second.orchestrator.adjustBudget(task.id, { relax: true });
    await second.orchestrator.idle();
    expect(result).toMatchObject({ resumed: true, renewed: true, status: 'RUNNING' });
    await second.orchestrator.sendMessage(task.id, 'claude', 'continue please');
    await second.orchestrator.idle();
    expect((await snapshot(second, task.runId)).status).toBe('RUNNING');
    expect(claude.calls.map((c) => c.prompt)).toEqual(['continue please']);
  });

  it('等待審批的時間不計入；批准後接著計時', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    env.clock.now += 5 * MIN;
    await claude.emit('approval.required', { approvalId: 'ap-1', providerCallId: 'c1', summary: 'npm install' });
    await env.orchestrator.idle();
    env.clock.now += 60 * MIN;
    await env.orchestrator.resolveApproval(task.id, 'ap-1', 'approve');
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('RUNNING');
    expect(activeDurationMs(run.budget, env.clock.now)).toBe(5 * MIN);
    env.clock.now += 24 * MIN;
    await env.orchestrator.checkBudgets();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
  });
});

describe('H-8：對話任務使用獨立的預算', () => {
  it('空閒 60 分鐘不被阻塞；之後照常對話', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    env.clock.now += 60 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');

    await env.orchestrator.sendMessage(task.id, 'claude', 'still there?');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
    expect(claude.calls).toHaveLength(2);
  });

  it('連續幾輪純問答（沒有任何工具）不被判為停滯：操作員的訊息算作有進展', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'q0', agentId: 'claude', workflow: 'manual' });
    for (let i = 0; i < 5; i++) {
      if (i > 0) await env.orchestrator.sendMessage(task.id, 'claude', `q${i}`);
      await claude.emit('model.turn.completed', { usage: { inputTokens: 10, outputTokens: 10 } });
      await claude.complete(`a${i}`);
      await env.orchestrator.idle();
      expect((await snapshot(env, task.runId)).status, `after round ${i + 1}`).toBe('RUNNING');
    }
    expect(budgetEvents(await env.store.listEvents(task.runId))).toEqual([]);
  });

  it('呼叫額度按每條指令一個視窗計算：日常聊天 20 條訊息不會用完', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    for (let i = 0; i < 20; i++) {
      await env.orchestrator.sendMessage(task.id, 'claude', `message ${i}`);
      await env.orchestrator.idle();
    }
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('RUNNING');
    expect(run.budget.agentCallsUsed).toBe(21);
    expect(claude.calls).toHaveLength(21);
  });

  it('Ask Both 扇出前一次性檢查兩次呼叫：額度夠就兩個都派發', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: { maxAgentCalls: 2 } });
    await env.orchestrator.idle();
    await env.orchestrator.askBoth(task.id, 'what do you both think?');
    await env.orchestrator.idle();
    expect(claude.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(1);
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
  });

  it('Ask Both 額度不夠就整體拒絕（409），兩個都不派發，不會只派發一半', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: { maxAgentCalls: 1 } });
    await env.orchestrator.idle();

    await expect(env.orchestrator.askBoth(task.id, 'what do you both think?')).rejects.toMatchObject({ statusCode: 409, code: 'BUDGET_EXHAUSTED' });
    await env.orchestrator.idle();
    expect(claude.calls).toHaveLength(1);
    expect(codex.calls).toHaveLength(0);
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.budget.agentCallsUsed).toBe(1);
    expect(budgetEvents(await env.store.listEvents(task.runId)).map((e) => e.data)).toEqual([expect.objectContaining({ limit: 'maxAgentCalls', needed: 2 })]);
  });
});

describe('向 BLOCKED 任務發訊息', () => {
  async function budgetBlockedChat() {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: { maxTurns: 1 } });
    await env.orchestrator.idle();
    await claude.emit('model.turn.completed', {});
    await claude.emit('model.turn.completed', {});
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxTurns', interruptedAgentIds: ['claude'] });
    expect(claude.cancelled).toHaveLength(1);
    return { claude, env, task };
  }

  it('對話任務：不帶 resume 明確拒絕（409 TASK_BLOCKED，說明原因與出路），什麼都不發給 agent', async () => {
    const { claude, env, task } = await budgetBlockedChat();
    const calls = claude.calls.length;
    const eventCount = (await env.store.listEvents(task.runId)).length;

    const error = await env.orchestrator.sendMessage(task.id, 'claude', 'are you there?').then(
      () => undefined,
      (e: unknown) => e as Error & { statusCode?: number; code?: string },
    );
    expect(error).toMatchObject({ statusCode: 409, code: 'TASK_BLOCKED' });
    expect(error?.message).toContain('放寬預算並繼續');
    await env.orchestrator.idle();
    expect(claude.calls).toHaveLength(calls);
    expect((await snapshot(env, task.runId)).status).toBe('BLOCKED');
    expect(await env.store.listEvents(task.runId)).toHaveLength(eventCount);
  });

  it('對話任務：操作員確認後（resume）先恢復並放寬預算再傳送；恢復後的工作仍受限額約束', async () => {
    const { claude, env, task } = await budgetBlockedChat();
    await env.orchestrator.sendMessage(task.id, 'claude', 'go on', { resume: true });
    await env.orchestrator.idle();

    let run = await snapshot(env, task.runId);
    expect(run.status).toBe('RUNNING');
    expect(claude.calls.at(-1)).toMatchObject({ via: 'resume', prompt: 'go on' });
    const events = await env.store.listEvents(task.runId);
    expect(events.find((e) => e.type === 'budget.extended')?.data).toMatchObject({ reason: 'resume', renew: true });
    expect(events.find((e) => e.type === 'run.status' && e.data.step === 'operator:resume')).toBeDefined();

    // 這條指令的新視窗裡再超出輪次：照樣被阻塞並停下 agent
    await claude.emit('model.turn.completed', {});
    await claude.emit('model.turn.completed', {});
    await env.orchestrator.idle();
    run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(claude.cancelled).toHaveLength(2);
  });

  it('工作流任務阻塞期間問另一個 agent：它的工作同樣受限額約束，超時被停下，阻塞原因不變', async () => {
    const claude = claudeAgent();
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    await claude.emit('approval.required', { approvalId: 'ap-1', providerCallId: 'c1', summary: 'rm -rf build' });
    await env.orchestrator.idle();
    await env.orchestrator.resolveApproval(task.id, 'ap-1', 'decline');
    await claude.complete('ok, not doing that');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).blockedBy).toMatchObject({ source: 'approval' });

    await env.orchestrator.sendMessage(task.id, 'codex', 'what happened?');
    await env.orchestrator.idle();
    env.clock.now += 30 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();

    expect(codex.cancelled).toHaveLength(1);
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'approval' });
    expect(budgetEvents(await env.store.listEvents(task.runId)).map((e) => e.data)).toEqual([expect.objectContaining({ limit: 'maxDurationMs', whileBlocked: true })]);
  });
});

describe('放寬預算並繼續', () => {
  it('工作流因時長預算阻塞：一鍵放寬後，被打斷的 agent 在同一步接著做，完成後流程繼續', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    env.clock.now += 30 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).blockedBy).toMatchObject({ source: 'budget', code: 'maxDurationMs', interruptedAgentIds: ['claude'] });

    const result = await env.orchestrator.adjustBudget(task.id, { relax: true });
    await env.orchestrator.idle();
    expect(result).toMatchObject({ resumed: true, renewed: true, status: 'RUNNING' });
    expect(claude.calls.at(-1)?.prompt).toContain('raised the budget');
    const extended = (await env.store.listEvents(task.runId)).find((e) => e.type === 'budget.extended');
    expect(extended?.data).toMatchObject({ reason: 'operator', renew: true, blockedLimit: 'maxDurationMs' });

    await claude.complete('done');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
  });

  it('派發前被拒絕時正在進行的一輪不算被打斷：它照常做完，放寬預算後也不會收到“接著做”', async () => {
    const claude = claudeAgent();
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: { maxAgentCalls: 1 } });
    await env.orchestrator.idle();
    // Claude 的第一輪還在進行；Ask Both 需要 2 次呼叫，額度只有 1 次
    await expect(env.orchestrator.askBoth(task.id, 'both?')).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    await env.orchestrator.idle();
    let run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy?.interruptedAgentIds).toBeUndefined();
    expect(claude.cancelled).toHaveLength(0);

    const calls = claude.calls.length;
    const result = await env.orchestrator.adjustBudget(task.id, { limits: { maxAgentCalls: 2 } });
    await env.orchestrator.idle();
    expect(result).toMatchObject({ resumed: true, status: 'RUNNING' });
    expect(claude.calls).toHaveLength(calls);
    expect(codex.calls).toHaveLength(0);
    run = await snapshot(env, task.runId);
    expect(run.budget.maxAgentCalls).toBe(2);
  });

  it('調高的限額仍然不夠時不恢復，並說明原因', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    env.clock.now += 40 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();

    const result = await env.orchestrator.adjustBudget(task.id, { limits: { maxDurationMs: 35 * MIN } });
    expect(result).toMatchObject({ resumed: false, status: 'BLOCKED', changes: { maxDurationMs: { from: 30 * MIN, to: 35 * MIN } } });
    expect(result.message).toContain('仍然不夠');
    expect((await snapshot(env, task.runId)).budget.maxDurationMs).toBe(35 * MIN);
  });
});

describe('預算 API：POST /api/tasks/:taskId/budget', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function serverWithBlockedChat() {
    const box = createServerSandbox('acc-budget-');
    cleanups.push(box.cleanup);
    const claude = claudeAgent();
    const server = await startServer(sandboxServerOptions(box, [claude]));
    cleanups.push(() => server.close());
    const task = await server.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', budget: { maxTurns: 1 } });
    await server.orchestrator.idle();
    await claude.emit('model.turn.completed', {});
    await claude.emit('model.turn.completed', {});
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('BLOCKED');
    return { server, claude, task };
  }

  const post = (server: RunningServer, url: string, payload: unknown) => server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload: payload as Record<string, unknown> });

  it('調高限額：budget.extended 落庫、快照更新，因預算阻塞的任務恢復，被打斷的 agent 接著做', async () => {
    const { server, claude, task } = await serverWithBlockedChat();
    const response = await post(server, `/api/tasks/${task.id}/budget`, { maxTurns: 5 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, resumed: true, status: 'RUNNING', changes: { maxTurns: { from: 1, to: 5 } } });
    await server.orchestrator.idle();

    const run = (await server.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.budget.maxTurns).toBe(5);
    const extended = (await server.store.listEvents(task.runId)).find((e) => e.type === 'budget.extended');
    expect(extended?.data).toMatchObject({ reason: 'operator', changes: { maxTurns: { from: 1, to: 5 } } });
    expect(claude.calls.at(-1)).toMatchObject({ via: 'resume', reason: 'message' });
    expect(claude.calls.at(-1)?.prompt).toContain('raised the budget');
  });

  it('非法引數 400；任務不存在 404；終態任務 409', async () => {
    const { server, task } = await serverWithBlockedChat();
    const url = `/api/tasks/${task.id}/budget`;
    for (const payload of [{}, { maxTurns: -1 }, { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 'ten' }, { maxDurationMs: 1000 }, { bogus: 1 }, { relax: 'yes' }]) {
      const response = await post(server, url, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await server.store.getRun(task.runId))?.status).toBe('BLOCKED');
    expect((await server.store.listEvents(task.runId)).some((e) => e.type === 'budget.extended')).toBe(false);

    expect((await post(server, '/api/tasks/no-such-task/budget', { maxTurns: 5 })).statusCode).toBe(404);

    await server.orchestrator.cancelTask(task.id);
    const terminal = await post(server, url, { maxTurns: 5 });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json()).toMatchObject({ code: 'TASK_TERMINAL' });
  });

  it('向阻塞的對話任務發訊息：409 TASK_BLOCKED（帶 code 與中文說明）；帶 resume: true 時先恢復再傳送', async () => {
    const { server, claude, task } = await serverWithBlockedChat();
    const refused = await post(server, `/api/tasks/${task.id}/message`, { agentId: 'claude', message: 'hello?' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'TASK_BLOCKED' });
    expect(String(refused.json().error)).toContain('已阻塞');

    const resumed = await post(server, `/api/tasks/${task.id}/message`, { agentId: 'claude', message: 'hello?', resume: true });
    expect(resumed.statusCode).toBe(200);
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('RUNNING');
    expect(claude.calls.at(-1)).toMatchObject({ via: 'resume', prompt: 'hello?' });
  });
});

describe('介面：因預算阻塞的橫幅', () => {
  const AGENTS = [
    { id: 'claude', name: 'Claude', kind: 'claude' },
    { id: 'codex', name: 'Codex', kind: 'codex' },
    { id: 'test', name: 'Test Runner', kind: 'test' },
  ];
  const BUDGET = { maxTurns: 30, maxAgentCalls: 12, maxReviewRounds: 1, maxStallCount: 3, maxDurationMs: 30 * MIN };

  function budgetBlocked(code: string, overrides: Partial<BlockedInput['run']> = {}): BlockedInput {
    return {
      task: { currentAction: 'x' },
      run: { status: 'BLOCKED', currentStep: `budget:${code}`, blockedBy: { source: 'budget', code }, primaryAgentId: 'claude', budget: BUDGET, ...overrides },
      events: [],
      agents: AGENTS,
    };
  }

  it('說明是哪一項預算用完了（中文），第一個出路是一鍵「放寬預算並繼續」', () => {
    const banner = blockedBanner(budgetBlocked('maxDurationMs'))!;
    expect(banner.reason).toContain('已經執行超過 30 分鐘');
    expect(banner.actions[0]).toMatchObject({ kind: 'relax', label: '放寬預算並繼續' });
    expect(banner.actions.map((a) => a.kind)).toEqual(['relax', 'reassign', 'stop']);

    expect(blockedBanner(budgetBlocked('maxTurns'))!.reason).toMatch(/預算上限（模型輪次）.*30 輪/);
    expect(blockedBanner(budgetBlocked('maxStallCount'))!.reason).toContain('連續 3 輪沒有實際進展');
    expect(blockedBanner(budgetBlocked('maxAgentCalls'))!.reason).toContain('12 次');
    // 服務端寫下了更具體的原因（派發前拒絕）：橫幅用它
    const precise = { ...budgetBlocked('maxAgentCalls'), task: { currentAction: '預算用完：呼叫次數不夠：還剩 1 次，這次需要 2 次' } };
    expect(blockedBanner(precise)!.reason).toBe('已達到預算上限（Agent 呼叫次數）：呼叫次數不夠：還剩 1 次，這次需要 2 次。任務先停在這裡等你決定。');
  });

  it('升級前阻塞的舊任務（沒有 blockedBy，只有 currentStep = budget:maxDurationMs）同樣可以一鍵放寬', () => {
    const banner = blockedBanner(budgetBlocked('maxDurationMs', { blockedBy: undefined }))!;
    expect(banner.reason).toContain('已經執行超過 30 分鐘');
    expect(banner.actions[0]?.kind).toBe('relax');
  });

  it('阻塞的對話任務發訊息前先確認（恢復並傳送）；工作流任務和未阻塞的任務不需要確認', () => {
    const chat = budgetBlocked('maxDurationMs');
    expect(blockedSendConfirm(chat)).toMatch(/已經執行超過 30 分鐘[\s\S]*恢復任務/);
    expect(blockedSendConfirm({ ...chat, run: { ...chat.run, status: 'RUNNING' } })).toBeUndefined();
    expect(
      blockedSendConfirm({ ...chat, run: { ...chat.run, workflowState: { step: 'implement', agents: { implement: 'claude', review: 'codex', test: 'test' } } } }),
    ).toBeUndefined();
  });
});

/** 把快照改成升級前的樣子：去掉 P0-7 新增的有效工作時長欄位；可選地再做其他修改。 */
async function makeLegacySnapshot(store: InMemoryControlPlaneStore, runId: string, mutate?: (run: RunSnapshot, task: TaskRecord) => void): Promise<void> {
  const run = (await store.getRun(runId))!;
  const task = (await store.getTask(run.taskId))!;
  const budget = run.budget as unknown as Record<string, unknown>;
  for (const key of ['activeMs', 'activeSince', 'activeCheckedAt', 'workingAgentIds', 'window']) delete budget[key];
  mutate?.(run, task);
  await store.commit({ run, task });
}
