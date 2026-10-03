import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, ORCHESTRATOR_REACTION_FAILED, Orchestrator } from '@acc/core';
import type { AgentAdapter, CreateTaskInput } from '@acc/core';
import { startServer } from '@acc/server';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0 第二批審查（P0-5 / H-12、P0-7 低危）：批准交接時，交接執行不了就不能先把審批消費掉；agent 請求的交接被預算拒絕不是編排器內部錯誤。
 *
 * 復現（修復前）：
 * - 對話任務裡 Claude 請求交接給 Codex（ask 策略），待審批期間任務因為別的原因進入 BLOCKED（例如 Codex 被安全策略攔下）。
 *   操作員點「同意交給 codex」：審批先在鎖內被消費（記為 approved），handoffNow 再發現對話已阻塞，丟擲 409 TASK_BLOCKED——
 *   審批記錄說“已批准”，交接卻沒有執行，操作員也沒有任何一鍵重做的途徑。
 * - 預算不夠時同理：審批已被消費，之後才因為預算 409。
 * - auto 策略下 agent 請求的交接被預算拒絕：BudgetExhaustedError 冒出編排反應，被記成 ORCHESTRATOR_REACTION_FAILED
 *   （“編排器內部出錯”），實際原因只是預算用完。
 *
 * 期望：交接類審批在消費之前檢查執行條件：對話已阻塞 → 409 且審批保持待處理；帶 resume（介面上的「恢復並轉交」）時先顯式恢復再交接。
 * 預算不夠 → 409（任務因預算阻塞，可以一鍵放寬），審批保持待處理；放寬之後再批准，交接照常執行。
 * auto 交接被預算拒絕只留下 budget.exceeded，沒有編排器內部錯誤。
 */

const quiet = () => undefined;

function boot(adapters: AgentAdapter[]) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, bus, orchestrator };
}

const HANDOFF = { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Please review the diff', content: 'diff summary' };
const CHAT: CreateTaskInput = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' };

async function pendingHandoff(input: CreateTaskInput = CHAT) {
  const claude = new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'reviewed' });
  const env = boot([claude, codex]);
  const task = await env.orchestrator.createTask(input);
  await env.orchestrator.idle();
  await claude.emit('handoff.requested', HANDOFF);
  await env.orchestrator.idle();
  const run = (await env.store.getRun(task.runId))!;
  const approvalId = run.pendingApprovals.find((x) => x.payload?.kind === 'handoff')?.id;
  return { ...env, claude, codex, task, approvalId: approvalId! };
}

describe('已阻塞的對話任務上批准交接', () => {
  it('不帶 resume：409 TASK_BLOCKED，審批不被消費（仍待處理），交接沒有執行', async () => {
    const env = await pendingHandoff();
    // 待審批期間任務因為別的原因阻塞（例如 Codex 被安全策略攔下）
    await env.bus.publish({ projectId: 'local', taskId: env.task.id, runId: env.task.runId, agentId: 'codex', type: 'safety.blocked', severity: 'critical', confidence: 'confirmed', data: { code: 'CODEX_CYBER_POLICY' } });
    await env.orchestrator.idle();
    expect((await env.store.getRun(env.task.runId))?.status).toBe('BLOCKED');

    await expect(env.orchestrator.resolveApproval(env.task.id, env.approvalId, 'approve')).rejects.toMatchObject({ statusCode: 409, code: 'TASK_BLOCKED' });
    await env.orchestrator.idle();
    expect(await env.store.getApproval(env.approvalId)).toMatchObject({ status: 'pending' });
    expect((await env.store.getRun(env.task.runId))?.pendingApprovals.map((x) => x.id)).toEqual([env.approvalId]);
    expect(env.codex.calls).toEqual([]);
  });

  it('帶 resume（「恢復並轉交」）：先顯式恢復任務，再執行交接；審批記為已批准', async () => {
    const env = await pendingHandoff();
    await env.bus.publish({ projectId: 'local', taskId: env.task.id, runId: env.task.runId, agentId: 'codex', type: 'safety.blocked', severity: 'critical', confidence: 'confirmed', data: { code: 'CODEX_CYBER_POLICY' } });
    await env.orchestrator.idle();

    await env.orchestrator.resolveApproval(env.task.id, env.approvalId, 'approve', 'once', { resume: true });
    await env.orchestrator.idle();
    expect(await env.store.getApproval(env.approvalId)).toMatchObject({ status: 'approved' });
    expect(env.codex.calls).toHaveLength(1);
    expect(env.codex.calls[0]?.prompt).toContain('diff summary');
    expect((await env.store.getRun(env.task.runId))?.status).toBe('RUNNING');
  });

  it('拒絕交接不受阻塞影響：照常記為已拒絕', async () => {
    const env = await pendingHandoff();
    await env.bus.publish({ projectId: 'local', taskId: env.task.id, runId: env.task.runId, agentId: 'codex', type: 'safety.blocked', severity: 'critical', confidence: 'confirmed', data: { code: 'CODEX_CYBER_POLICY' } });
    await env.orchestrator.idle();
    await env.orchestrator.resolveApproval(env.task.id, env.approvalId, 'decline');
    expect(await env.store.getApproval(env.approvalId)).toMatchObject({ status: 'declined' });
    expect(env.codex.calls).toEqual([]);
  });
});

describe('預算不夠時批准交接', () => {
  it('409 BUDGET_EXHAUSTED，審批仍待處理；一鍵放寬預算之後再批准，交接照常執行', async () => {
    const env = await pendingHandoff({ ...CHAT, budget: { maxAgentCalls: 1 } });
    await expect(env.orchestrator.resolveApproval(env.task.id, env.approvalId, 'approve')).rejects.toMatchObject({ statusCode: 409, code: 'BUDGET_EXHAUSTED' });
    await env.orchestrator.idle();
    let run = (await env.store.getRun(env.task.runId))!;
    expect(await env.store.getApproval(env.approvalId)).toMatchObject({ status: 'pending' });
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxAgentCalls' });
    expect(env.codex.calls).toEqual([]);

    const relaxed = await env.orchestrator.adjustBudget(env.task.id, { relax: true });
    expect(relaxed.resumed).toBe(true);
    await env.orchestrator.resolveApproval(env.task.id, env.approvalId, 'approve');
    await env.orchestrator.idle();
    run = (await env.store.getRun(env.task.runId))!;
    expect(await env.store.getApproval(env.approvalId)).toMatchObject({ status: 'approved' });
    expect(env.codex.calls).toHaveLength(1);
    expect(run.status).toBe('RUNNING');
  });

  it('auto 策略下 agent 請求的交接被預算拒絕：只有 budget.exceeded，沒有“編排器內部出錯”', async () => {
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ ...CHAT, handoffPolicy: 'auto', budget: { maxAgentCalls: 1 } });
    await env.orchestrator.idle();
    await claude.emit('handoff.requested', HANDOFF);
    await env.orchestrator.idle();

    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'runtime.error' && e.data.code === ORCHESTRATOR_REACTION_FAILED)).toEqual([]);
    const run = (await env.store.getRun(task.runId))!;
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxAgentCalls' });
    expect((await env.store.getTask(task.id))?.currentAction).toMatch(/^預算用完/);
    expect(codex.calls).toEqual([]);
  });
});

describe('API：批准交接時任務已阻塞（「恢復並轉交」）', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('不帶 resume 返回 409 TASK_BLOCKED（審批仍待處理）；帶 resume 先恢復再轉交', async () => {
    const box = createServerSandbox('acc-handoff-approval-');
    cleanups.push(box.cleanup);
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] });
    const server = await startServer(sandboxServerOptions(box, [claude, codex]));
    cleanups.push(() => server.close());
    const post = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload });

    const created = await post('/api/tasks', { prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual', askBoth: true });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; runId: string };
    await server.orchestrator.idle();
    await claude.emit('handoff.requested', HANDOFF);
    await server.orchestrator.idle();
    // 待審批期間 Codex 被安全策略攔下：對話任務進入 BLOCKED
    await codex.emit('safety.blocked', { code: 'CODEX_CYBER_POLICY' }, codex.sessionId, 'critical');
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('BLOCKED');
    const approvalId = (await server.store.getRun(task.runId))!.pendingApprovals[0]!.id;
    const codexCalls = codex.calls.length;
    const resolveUrl = '/api/approvals/' + encodeURIComponent(approvalId) + '/resolve';

    const refused = await post(resolveUrl, { decision: 'approve' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'TASK_BLOCKED' });
    expect(refused.json().error).toContain('恢復並轉交');
    expect(await server.store.getApproval(approvalId)).toMatchObject({ status: 'pending' });

    const resumed = await post(resolveUrl, { decision: 'approve', resume: true });
    expect(resumed.statusCode).toBe(200);
    await server.orchestrator.idle();
    expect(await server.store.getApproval(approvalId)).toMatchObject({ status: 'approved' });
    expect(codex.calls.length).toBe(codexCalls + 1);
    expect(codex.calls.at(-1)?.prompt).toContain('diff summary');
    expect((await server.store.getRun(task.runId))?.status).toBe('RUNNING');
  });
});
