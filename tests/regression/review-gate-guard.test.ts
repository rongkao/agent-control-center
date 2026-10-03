import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, CreateTaskInput } from '@acc/core';
import { startServer } from '@acc/server';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0 第二批審查（P0-5 / M-5）：操作員派發不能繞過評審閘門；API 的 Ask Both 不會把測試執行器當成主 agent。
 *
 * 復現（修復前）：
 * - 工作流任務測試通過後停在評審閘門（WAITING_INPUT），此時 Codex 還沒有會話。操作員在 Codex 對話方塊裡問一句，
 *   或者用「同時問」（primary=claude，Codex 作為顧問），都會走 startReservedAgent，把 WAITING_INPUT 直接改成 RUNNING，
 *   review-gate 仍在 pendingInputs 裡。之後「接受結果」被拒絕（not waiting for an operator decision (RUNNING)），
 *   一個測試已經通過的任務只剩「停止」一條路。
 * - /ask-both 不帶 primaryAgentId 時回退到 run.currentAgentId：工作流在測試步驟之後它是 'test'，
 *   於是測試執行器被當成主 agent（測試被重跑），真正的實現者 Claude 收到的卻是隻讀顧問提示。
 *
 * 期望：操作員給新 agent 發訊息只啟動會話，不改變 run 狀態；閘門仍在，accept 能完成。
 * Ask Both 不指定主 agent 時，工作流任務用實現者；測試執行器永遠不會成為主 agent（指定它時返回 400）。
 */

const quiet = () => undefined;

function boot(adapters: AgentAdapter[]) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, orchestrator };
}

function agents() {
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }, [], { kind: 'reply', text: 'done' });
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'looks fine' });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  return { claude, codex, tester };
}

const GATED: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test', reviewGate: true };

async function atGate() {
  const a = agents();
  const env = boot([a.claude, a.codex, a.tester]);
  const task = await env.orchestrator.createTask(GATED);
  await env.orchestrator.idle();
  const run = (await env.store.getRun(task.runId))!;
  expect(run.status).toBe('WAITING_INPUT');
  expect(run.pendingInputs.map((x) => x.id)).toEqual(['review-gate']);
  expect(run.agentSessions.codex).toBeUndefined();
  return { ...env, ...a, task };
}

describe('評審閘門不被操作員派發繞過', () => {
  it('閘門期間在 Codex 對話方塊裡問一句：Codex 回答，任務仍停在閘門；「接受結果」能完成', async () => {
    const env = await atGate();
    await env.orchestrator.sendMessage(env.task.id, 'codex', 'Is this safe to merge?');
    await env.orchestrator.idle();

    expect(env.codex.calls).toEqual([expect.objectContaining({ via: 'start', prompt: 'Is this safe to merge?' })]);
    let run = (await env.store.getRun(env.task.runId))!;
    expect(run.status).toBe('WAITING_INPUT');
    expect(run.pendingInputs.map((x) => x.id)).toEqual(['review-gate']);

    await env.orchestrator.resolveGate(env.task.id, 'accept');
    await env.orchestrator.idle();
    run = (await env.store.getRun(env.task.runId))!;
    expect(run.status).toBe('COMPLETED');
  });

  it('閘門期間「同時問」（主 agent 為 Claude，Codex 作為顧問）：任務仍停在閘門；「接受結果」能完成', async () => {
    const env = await atGate();
    await env.orchestrator.askBoth(env.task.id, 'Any risks left?', 'claude');
    await env.orchestrator.idle();

    expect(env.codex.calls).toHaveLength(1);
    expect(env.claude.calls.at(-1)).toMatchObject({ via: 'send', prompt: 'Any risks left?' });
    let run = (await env.store.getRun(env.task.runId))!;
    expect(run.status).toBe('WAITING_INPUT');
    expect(run.pendingInputs.map((x) => x.id)).toEqual(['review-gate']);

    await env.orchestrator.resolveGate(env.task.id, 'accept');
    run = (await env.store.getRun(env.task.runId))!;
    expect(run.status).toBe('COMPLETED');
  });

  it('對話任務第一次啟動照常進入 RUNNING（修復不影響首次啟動）', async () => {
    const a = agents();
    const env = boot([a.claude, a.codex, a.tester]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
    await env.orchestrator.sendMessage(task.id, 'codex', 'and you?');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
    expect(a.codex.calls).toHaveLength(1);
  });
});

describe('Ask Both 的主 agent：工作流用實現者，測試執行器不能當主 agent', () => {
  it('工作流停在閘門時不指定主 agent：主 agent 是實現者 Claude，測試不會被重跑', async () => {
    const env = await atGate();
    expect((await env.store.getRun(env.task.runId))?.currentAgentId).toBe('test');
    const testCalls = env.tester.calls.length;

    await env.orchestrator.askBoth(env.task.id, 'Is this safe to merge?');
    await env.orchestrator.idle();

    expect(env.tester.calls).toHaveLength(testCalls);
    const outgoing = (await env.store.listEvents(env.task.runId)).filter((e) => e.type === 'agent.message' && e.data.direction === 'to-agent' && e.data.askBoth);
    expect(outgoing.map((e) => [e.agentId, e.data.advisory === true])).toEqual(expect.arrayContaining([['claude', false], ['codex', true]]));
    expect(outgoing.some((e) => e.agentId === 'test')).toBe(false);
    expect((await env.store.getRun(env.task.runId))?.status).toBe('WAITING_INPUT');
  });

  it('指定測試執行器為主 agent：400，什麼都不派發', async () => {
    const env = await atGate();
    const before = { claude: env.claude.calls.length, codex: env.codex.calls.length, tester: env.tester.calls.length };
    await expect(env.orchestrator.askBoth(env.task.id, 'run it', 'test')).rejects.toMatchObject({ statusCode: 400 });
    await env.orchestrator.idle();
    expect({ claude: env.claude.calls.length, codex: env.codex.calls.length, tester: env.tester.calls.length }).toEqual(before);
  });
});

describe('API：評審閘門期間問 Codex、不帶主 agent 的 Ask Both、rerun', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('閘門保持；Ask Both 不重跑測試；閘門上 rerun 返回 409 GATE_ACTION_UNAVAILABLE；accept 完成', async () => {
    const box = createServerSandbox('acc-gate-guard-');
    cleanups.push(box.cleanup);
    const a = agents();
    const server = await startServer(sandboxServerOptions(box, [a.claude, a.codex, a.tester]));
    cleanups.push(() => server.close());
    const post = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload });

    const created = await post('/api/tasks', { prompt: 'Fix the login bug', agentId: 'claude', testCommand: 'npm test', reviewGate: true });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; runId: string };
    const base = '/api/tasks/' + task.id;
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('WAITING_INPUT');
    const testCalls = a.tester.calls.length;

    expect((await post(base + '/message', { agentId: 'codex', message: 'Is this safe?' })).statusCode).toBe(200);
    expect((await post(base + '/ask-both', { message: 'Any risks left?' })).statusCode).toBe(200);
    await server.orchestrator.idle();
    expect(a.tester.calls).toHaveLength(testCalls);
    expect((await server.store.getRun(task.runId))?.status).toBe('WAITING_INPUT');

    const rerun = await post(base + '/gate', { action: 'rerun' });
    expect(rerun.statusCode).toBe(409);
    expect(rerun.json()).toMatchObject({ code: 'GATE_ACTION_UNAVAILABLE' });

    expect((await post(base + '/ask-both', { message: 'run it', primaryAgentId: 'test' })).statusCode).toBe(400);

    expect((await post(base + '/gate', { action: 'accept' })).statusCode).toBe(200);
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('COMPLETED');
  });
});
