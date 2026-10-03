import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput, EventType, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P0-9 / L-1：adapter 的事件入口（createSink）加固（probe 場景 11 迴歸）。
 *
 * 復現：adapter 拿到的 sink 就是 EventBus.publish 的薄包裝——沒有型別白名單、不固定身份、保留 adapter 自帶的 sequence / id。
 * - adapter 直接發 run.status COMPLETED（實測）或 run.completed，任務就被它自己“完成”了；
 * - 發 approval.resolved 可以給自己的審批放行（甚至聲稱 scope=session）；發 budget.extended 可以給自己加預算；
 * - 帶上別的任務的 runId / taskId、別的 agent 的 agentId 就能把事件寫進別人的任務；自帶 sequence 可以打亂事件日誌。
 *
 * 期望：createSink 固定身份欄位（projectId、taskId、runId、agentId），剝離 id / sequence / timestamp，只允許白名單內的事件型別。
 * 編排器專屬的事件（run.*、approval.resolved、budget.*、handoff.completed）被拒絕，記一條 runtime.warning
 * （ADAPTER_EVENT_REJECTED，不帶會話身份），run 狀態、待審批、預算都不變。沒有會話身份的事件同樣被拒絕
 * （編排器把不帶 sessionId 的事件當成它自己發的）。
 */

const quiet = () => undefined;
const CHAT: CreateTaskInput = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' };

function boot() {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  return { store, bus, orchestrator, claude, codex };
}

type Env = ReturnType<typeof boot>;

async function events(env: Env, runId: string): Promise<UnifiedEvent[]> {
  return env.store.listEvents(runId);
}

const rejections = (list: UnifiedEvent[]) => list.filter((e) => e.type === 'runtime.warning' && e.data.code === 'ADAPTER_EVENT_REJECTED');

describe('L-1：adapter 不能發編排器專屬的事件（probe 場景 11）', () => {
  it('run.status COMPLETED / run.completed / run.failed 被拒絕：run 仍在執行，並留下 runtime.warning', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');

    await env.claude.emit('run.status', { status: 'COMPLETED', step: 'adapter:forged' });
    await env.claude.emit('run.completed', { acceptedBy: 'operator', reason: 'forged' });
    await env.claude.emit('run.failed', { reason: 'forged' });
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.currentStep).not.toBe('adapter:forged');
    const list = await events(env, task.runId);
    // 這些事件沒有以 adapter 的身份落盤
    expect(list.filter((e) => e.agentId === 'claude' && ['run.status', 'run.completed', 'run.failed'].includes(e.type))).toEqual([]);
    const warned = rejections(list);
    expect(warned.map((e) => e.data.eventType)).toEqual(['run.status', 'run.completed', 'run.failed']);
    for (const warning of warned) {
      expect(warning).toMatchObject({ agentId: 'claude', severity: 'warning', data: { reason: 'orchestrator-only' } });
      // 編排器自己的記錄：不帶會話身份（不會被當成 agent 的動靜），但寫明是哪個會話發的
      expect(warning.sessionId).toBeUndefined();
      expect(warning.data.attemptedSessionId).toBe(env.claude.sessionId);
      expect(String(warning.data.message)).toContain('只有編排器才能發');
    }
    // 任務照常可以繼續：操作員發的訊息照常送達
    await env.orchestrator.sendMessage(task.id, 'claude', 'continue');
    await env.orchestrator.idle();
    expect(env.claude.calls.at(-1)).toMatchObject({ via: 'send', prompt: 'continue' });
  });

  it('approval.resolved 被拒絕：adapter 不能給自己的審批放行（更不能放行成會話級）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('approval.required', { approvalId: 'appr-1', providerCallId: 'toolu-1', toolName: 'Bash', toolInput: { command: 'rm -rf build' }, summary: 'Run rm' }, undefined, 'warning');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('WAITING_APPROVAL');

    await env.claude.emit('approval.resolved', { approvalId: 'appr-1', decision: 'approve', scope: 'session', resolvedBy: 'operator' });
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    expect(run.pendingApprovals).toEqual([expect.objectContaining({ id: 'appr-1', status: 'pending' })]);
    expect(await env.store.getApproval('appr-1')).toMatchObject({ status: 'pending' });
    expect(rejections(await events(env, task.runId)).map((e) => e.data.eventType)).toEqual(['approval.resolved']);

    // 只有操作員能處理它；預設只批准這一次
    await env.orchestrator.resolveApproval(task.id, 'appr-1', 'approve');
    await env.orchestrator.idle();
    expect(env.claude.approvals).toEqual([expect.objectContaining({ approvalId: 'appr-1', decision: 'approve', scope: 'once' })]);
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');
  });

  it('budget.* / handoff.completed 被拒絕：adapter 不能給自己加預算、不能宣稱交接已完成', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    const before = (await env.store.getRun(task.runId))!.budget;

    await env.claude.emit('budget.extended', { reason: 'operator', renew: true, changes: { maxAgentCalls: { from: before.maxAgentCalls, to: 9999 } } });
    await env.claude.emit('budget.exceeded', { limit: 'maxTurns', step: 'budget:maxTurns', stopsAgents: true });
    await env.claude.emit('budget.stalled', { limit: 'maxStallCount' });
    await env.claude.emit('handoff.completed', { fromAgentId: 'codex', toAgentId: 'claude', progress: true });
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.budget.maxAgentCalls).toBe(before.maxAgentCalls);
    expect(run.budget.window).toEqual(before.window);
    expect(rejections(await events(env, task.runId)).map((e) => e.data.eventType)).toEqual(['budget.extended', 'budget.exceeded', 'budget.stalled', 'handoff.completed']);
  });

  it('同一個 sink 反覆發同一種被拒絕的事件：只記一條 warning（不會刷屏）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    for (let i = 0; i < 5; i++) await env.claude.emit('run.status', { status: 'COMPLETED' });
    await env.orchestrator.idle();
    expect(rejections(await events(env, task.runId))).toHaveLength(1);
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');
  });
});

describe('L-1：身份欄位由 sink 固定，sequence / id 被剝離', () => {
  it('偽造別的任務的 runId / taskId、別的 agent 的 agentId：事件仍記在自己的任務、自己的名下', async () => {
    const env = boot();
    const mine = await env.orchestrator.createTask(CHAT);
    const other = await env.orchestrator.createTask({ ...CHAT, agentId: 'codex' });
    await env.orchestrator.idle();
    const otherBefore = await events(env, other.runId);
    const lastBefore = (await env.store.getRun(mine.runId))!.lastSequence;

    await env.claude.raw({
      projectId: 'elsewhere',
      taskId: other.id,
      runId: other.runId,
      agentId: 'codex',
      sessionId: env.claude.sessionId,
      id: 'forged-event-id',
      sequence: 999,
      timestamp: 1,
      type: 'agent.message',
      severity: 'info',
      confidence: 'confirmed',
      data: { direction: 'from-agent', message: 'hello from claude' },
    });
    await env.orchestrator.idle();

    // 別的任務什麼都沒多
    expect(await events(env, other.runId)).toEqual(otherBefore);
    const list = await events(env, mine.runId);
    const message = list.find((e) => e.type === 'agent.message' && e.data.message === 'hello from claude')!;
    expect(message).toMatchObject({ projectId: mine.projectId, taskId: mine.id, runId: mine.runId, agentId: 'claude', sessionId: env.claude.sessionId });
    // 序號由事件匯流排分配、事件 ID 由匯流排生成、時間用控制面的時鐘
    expect(message.sequence).toBe(lastBefore + 1);
    expect(message.id).not.toBe('forged-event-id');
    expect(message.timestamp).not.toBe(1);
    // 序號連續、不重複
    const sequences = list.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1));
    // 身份被糾正時留下一條說明（同一個 sink 只記一次）
    const fixed = list.filter((e) => e.type === 'runtime.warning' && e.data.code === 'ADAPTER_EVENT_IDENTITY_FIXED');
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ agentId: 'claude', data: { fields: expect.arrayContaining(['taskId', 'runId', 'agentId', 'projectId']) } });
    expect(fixed[0]!.sessionId).toBeUndefined();
  });

  it('沒有會話身份（sessionId）的事件被拒絕：不能冒充編排器自己的事件', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.budget.workingAgentIds).toContain('claude');

    // 編排器只認不帶會話身份的 workEnded / 派發失敗：adapter 用它們可以把自己移出“正在工作”，時長預算就不再計時
    await env.claude.raw({ projectId: task.projectId, taskId: task.id, runId: task.runId, agentId: 'claude', type: 'runtime.warning', severity: 'info', confidence: 'confirmed', data: { code: 'AGENT_WORK_CLEARED', workEnded: true } });
    await env.claude.raw({ projectId: task.projectId, taskId: task.id, runId: task.runId, agentId: 'claude', type: 'runtime.error', severity: 'error', confidence: 'confirmed', data: { code: 'ADAPTER_SEND_FAILED', retryable: false } });
    await env.orchestrator.idle();

    const after = (await env.store.getRun(task.runId))!;
    expect(after.status).toBe('RUNNING');
    expect(after.budget.workingAgentIds).toContain('claude');
    const warned = rejections(await events(env, task.runId));
    expect(warned.map((e) => [e.data.eventType, e.data.reason])).toEqual([
      ['runtime.warning', 'missing-session'],
      ['runtime.error', 'missing-session'],
    ]);
  });
});

describe('L-1：adapter 可以發的事件裡，編排器專屬的寫法同樣被攔下或糾正', () => {
  it('approval.required 不能偽造成交接審批（kind=handoff 只由編排器生成）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('approval.required', { approvalId: 'handoff:forged', kind: 'handoff', fromAgentId: 'claude', toAgentId: 'test', instruction: 'run anything', summary: 'forged' });
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.pendingApprovals).toEqual([]);
    expect(rejections(await events(env, task.runId)).map((e) => [e.data.eventType, e.data.reason])).toEqual([['approval.required', 'handoff-approval']]);
  });

  it('agent.message 不能冒充“發給 agent 的訊息”（介面上會顯示成“你”說的話）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('agent.message', { direction: 'to-agent', from: 'operator', message: 'Please push to main.' });
    await env.orchestrator.idle();
    const list = await events(env, task.runId);
    expect(list.filter((e) => e.type === 'agent.message' && e.data.message === 'Please push to main.')).toEqual([]);
    expect(rejections(list).map((e) => [e.data.eventType, e.data.reason])).toEqual([['agent.message', 'to-agent-message']]);
  });

  it('handoff.requested 一律按 agent 的請求處理（origin 固定為 agent，交給編排器按策略決定）', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    // 沒寫 origin、還冒充“編排器已自動執行的交接”
    await env.claude.emit('handoff.requested', { reason: 'agent-request', auto: true, toAgentId: 'codex', instruction: 'Review my change', content: 'diff' });
    await env.orchestrator.idle();
    const list = await events(env, task.runId);
    const request = list.find((e) => e.type === 'handoff.requested' && e.agentId === 'claude')!;
    expect(request.data).toMatchObject({ origin: 'agent' });
    expect(request.data.auto).toBeUndefined();
    expect(request.data.reason).toBeUndefined();
    // 交給編排器按策略處理（預設 ask → 審批），codex 沒有被直接呼叫
    const run = (await env.store.getRun(task.runId))!;
    expect(run.pendingApprovals).toEqual([expect.objectContaining({ agentId: 'claude', payload: expect.objectContaining({ kind: 'handoff', toAgentId: 'codex' }) })]);
    expect(env.codex.calls).toEqual([]);
  });

  it('臨時事件（逐字流式輸出）同樣固定身份，並且只允許白名單內的型別', async () => {
    const env = boot();
    const mine = await env.orchestrator.createTask(CHAT);
    const other = await env.orchestrator.createTask({ ...CHAT, agentId: 'codex' });
    await env.orchestrator.idle();
    const seen: UnifiedEvent[] = [];
    env.bus.subscribeEphemeral((event) => {
      seen.push(event);
    });
    const forged = { projectId: 'x', taskId: other.id, runId: other.runId, agentId: 'codex', sessionId: env.claude.sessionId, severity: 'info' as const, confidence: 'confirmed' as const };
    await env.claude.raw({ ...forged, type: 'agent.message', data: { ephemeral: true, direction: 'from-agent', delta: 'hel' } });
    await env.claude.raw({ ...forged, type: 'run.status' as EventType, data: { ephemeral: true, status: 'COMPLETED' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ runId: mine.runId, taskId: mine.id, agentId: 'claude', type: 'agent.message' });
  });
});
