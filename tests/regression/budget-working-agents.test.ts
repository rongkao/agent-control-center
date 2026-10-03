import { describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, activeDurationMs } from '@acc/core';
import type { AgentAdapter, CreateTaskInput, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { ClaudeQueryDriver } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { turnEventLoop } from './fakes/deferred.js';

/**
 * P0 第二批審查（P0-7 / H-8）：“正在工作的 agent”必須和實際情況一致——不殘留、不遺漏。
 *
 * 復現（修復前）：
 * - 重啟時 recover() 把重啟前處於工作狀態的 agent 直接記為“正在工作”。對話任務裡 Claude 在等審批時重啟、之後操作員「拒絕」：
 *   會話不線上，拒絕不會喚醒它，也就沒有終態把它移出集合。run 變成 BLOCKED 但時鐘繼續走，60 分鐘後 checkBudgets 每 5 秒發一條
 *   budget.exceeded（whileBlocked），stopAllSessions 什麼都取消不了，殘留永遠清不掉。
 *   Ask Both 變體：Codex 在等審批時重啟、拒絕後「恢復並傳送」只和 Claude 聊，Codex 殘留在集合裡，空閒對話 60 分鐘後被 maxDurationMs 阻塞，
 *   blockedBy.interruptedAgentIds 被寫成 ['codex']。
 * - WAITING_APPROVAL 期間仍在工作的 agent（request_handoff 之後繼續這一輪）不計時，也不受任何限額約束：40 輪之後仍然沒有預算事件。
 * - 真實 Claude 排隊的第二條訊息：第一輪的 result 發出 completed 後 Claude 被移出集合，第二輪進行期間 adapter 不再發 coding，
 *   這一輪不計時，時長預算管不到它。
 *
 * 期望：重啟後只有真正續上的 agent 重新計時；拒絕審批之後反覆檢查預算最多一條預算事件，空閒對話不被阻塞；
 * 等待審批時仍在工作的 agent 照常計時、照常受限額約束（超限時停下它，保留待審批項和等待狀態），真正卡在審批上的 agent 不計時；
 * Claude 處理排隊訊息時重新報告工作狀態。
 */

const MIN = 60_000;
const quiet = () => undefined;

function boot(agents: AgentAdapter[], options: { store?: InMemoryControlPlaneStore; clock?: { now: number }; instanceId?: string } = {}) {
  const store = options.store ?? new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const clock = options.clock ?? { now: 1_000_000 };
  const orchestrator = new Orchestrator(store, bus, { now: () => clock.now, log: quiet, workspacePolicy: 'shared', instanceId: options.instanceId });
  for (const agent of agents) orchestrator.registerAdapter(agent);
  return { store, bus, clock, orchestrator };
}

const budgetEvents = (events: UnifiedEvent[]) => events.filter((e) => e.type === 'budget.exceeded' || e.type === 'budget.stalled');
const claudeAgent = () => new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
const codexAgent = () => new ControlledAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis', 'review'] });
const TOOL_APPROVAL = { approvalId: 'a1', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, summary: 'Delete build' };

describe('重啟之後“正在工作”不殘留', () => {
  it('Claude 等審批時重啟，之後「拒絕」：反覆檢查預算最多一條預算事件，集合被清空', async () => {
    const store = new InMemoryControlPlaneStore();
    const clock = { now: 1_000_000 };
    const claude1 = claudeAgent();
    const first = boot([claude1], { store, clock, instanceId: 'i1' });
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'clean up', agentId: 'claude', workflow: 'manual' });
    await first.orchestrator.idle();
    await claude1.emit('approval.required', TOOL_APPROVAL, claude1.sessionId, 'warning');
    await first.orchestrator.idle();
    expect((await store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');

    clock.now += 5 * MIN;
    const second = boot([claudeAgent()], { store, clock, instanceId: 'i2' });
    await second.orchestrator.recover();
    await second.orchestrator.idle();
    await second.orchestrator.resolveApproval(task.id, 'a1', 'decline');
    await second.orchestrator.idle();
    expect((await store.getRun(task.runId))?.status).toBe('BLOCKED');

    clock.now += 61 * MIN;
    for (let i = 0; i < 5; i++) {
      await second.orchestrator.checkBudgets();
      await second.orchestrator.idle();
      clock.now += 5_000;
    }
    const run = (await store.getRun(task.runId))!;
    expect(budgetEvents(await store.listEvents(task.runId)).length).toBeLessThanOrEqual(1);
    expect(run.budget.workingAgentIds ?? []).toEqual([]);
    expect(run.budget.activeSince).toBeUndefined();
  });

  it('Ask Both：Codex 等審批時重啟、拒絕後「恢復並傳送」只和 Claude 聊 → 空閒對話 61 分鐘後不被阻塞', async () => {
    const store = new InMemoryControlPlaneStore();
    const clock = { now: 1_000_000 };
    const claude1 = claudeAgent();
    const codex1 = codexAgent();
    const first = boot([claude1, codex1], { store, clock, instanceId: 'i1' });
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual', askBoth: true });
    await first.orchestrator.idle();
    await claude1.complete('fixed');
    await codex1.emit('approval.required', { ...TOOL_APPROVAL, approvalId: 'c1' }, codex1.sessionId, 'warning');
    await first.orchestrator.idle();

    const claude2 = claudeAgent();
    const second = boot([claude2, codexAgent()], { store, clock, instanceId: 'i2' });
    await second.orchestrator.recover();
    await second.orchestrator.idle();
    await second.orchestrator.resolveApproval(task.id, 'c1', 'decline');
    await second.orchestrator.idle();
    await second.orchestrator.sendMessage(task.id, 'claude', 'continue without codex', { resume: true });
    await second.orchestrator.idle();
    await claude2.complete('done');
    await second.orchestrator.idle();

    let run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.budget.workingAgentIds ?? []).toEqual([]);

    clock.now += 61 * MIN;
    await second.orchestrator.checkBudgets();
    await second.orchestrator.idle();
    run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(budgetEvents(await store.listEvents(task.runId))).toEqual([]);
  });
});

describe('等待審批期間仍在工作的 agent 照常計時、受限額約束', () => {
  const WORKFLOW: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude' };

  it('request_handoff 之後 Claude 繼續這一輪：超出輪次上限時被停下；待審批項和等待狀態保留', async () => {
    const claude = claudeAgent();
    const env = boot([claude, codexAgent()]);
    const task = await env.orchestrator.createTask({ ...WORKFLOW, budget: { maxTurns: 30, maxStallCount: 1000, maxDurationMs: 24 * 60 * MIN } });
    await env.orchestrator.idle();
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'review', content: 'x' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');

    for (let i = 0; i < 40 && claude.cancelled.length === 0; i++) {
      env.clock.now += 2 * MIN;
      await claude.emit('model.turn.completed', {});
      await env.orchestrator.checkBudgets();
      await env.orchestrator.idle();
    }
    const run = (await env.store.getRun(task.runId))!;
    const events = budgetEvents(await env.store.listEvents(task.runId));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ limit: 'maxTurns', whileWaiting: true });
    expect(claude.cancelled).toHaveLength(1);
    expect(run.status).toBe('WAITING_APPROVAL');
    expect(run.pendingApprovals).toHaveLength(1);
    expect(activeDurationMs(run.budget, env.clock.now)).toBeGreaterThan(0);
  });

  it('等待審批期間工作時間照常計入時長；超過時長上限同樣被停下', async () => {
    const claude = claudeAgent();
    const env = boot([claude, codexAgent()]);
    const task = await env.orchestrator.createTask({ ...WORKFLOW, budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'review', content: 'x' });
    await env.orchestrator.idle();

    env.clock.now += 31 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(budgetEvents(await env.store.listEvents(task.runId)).map((e) => e.data.limit)).toEqual(['maxDurationMs']);
    expect(claude.cancelled).toHaveLength(1);
    expect(run.status).toBe('WAITING_APPROVAL');
  });

  it('真正卡在工具審批上的 agent 不計時：操作員三小時後才回來，不觸發任何預算', async () => {
    const claude = claudeAgent();
    const env = boot([claude]);
    const task = await env.orchestrator.createTask({ ...WORKFLOW, budget: { maxDurationMs: 30 * MIN } });
    await env.orchestrator.idle();
    env.clock.now += 1 * MIN;
    await claude.emit('approval.required', TOOL_APPROVAL, claude.sessionId, 'warning');
    await env.orchestrator.idle();
    const before = activeDurationMs((await env.store.getRun(task.runId))!.budget, env.clock.now);

    env.clock.now += 180 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(budgetEvents(await env.store.listEvents(task.runId))).toEqual([]);
    expect(activeDurationMs(run.budget, env.clock.now)).toBe(before);
    expect(claude.cancelled).toHaveLength(0);
  });
});

describe('真實 Claude adapter：排隊的第二條訊息', () => {
  it('第一輪結束後 Claude 接著處理排隊的訊息：這一輪照常計時，超過對話任務每條指令 60 分鐘的上限時被停下', async () => {
    const clock = { now: 1_000_000 };
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { now: () => clock.now, log: quiet, workspacePolicy: 'shared', defaultCwd: process.cwd() });
    const driver = new ClaudeQueryDriver(async (q) => {
      q.init();
      await q.nextPrompt();
    });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet }));
    const task = await orchestrator.createTask({ title: 'chat', prompt: 'first question', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    const q = await driver.query(1);

    // 第一輪還在進行時，操作員又補了一句（SDK 流式輸入把它排隊）
    await orchestrator.sendMessage(task.id, 'claude', 'second question');
    await orchestrator.idle();
    // 第一輪結束，結果裡說明還有 1 條排隊的訊息
    q.text('answer 1');
    q.result({ queuedTurnCount: 1 });
    await turnEventLoop(5);
    await orchestrator.idle();

    let run = (await store.getRun(task.runId))!;
    expect(run.budget.workingAgentIds).toEqual(['claude']);
    expect(run.agentSessions.claude?.status).toBe('coding');

    clock.now += 61 * MIN;
    await orchestrator.checkBudgets();
    await orchestrator.idle();
    run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxDurationMs' });
    expect(q.options.abortController?.signal.aborted).toBe(true);
  });
});
