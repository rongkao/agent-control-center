import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter } from '@acc/core';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter, type ScriptStep } from '../fakes/scripted-adapter.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P0-5（H-12）：同一審批只能被消費一次。
 *
 * 復現（docs/analysis-probes/race.mts、race2.mts，服務端審查實測）：同一個交接審批併發提交兩次，交接被投遞兩次；
 * 普通工具審批的第二次呼叫讓 adapter.approve 報錯，經 callAdapter → failClosed 把任務誤置為 BLOCKED（按程式碼推斷）。
 * 原因：resolveApproval 在鎖外“檢查 pending → 釋出 approval.resolved → 執行副作用”，執行副作用前不確認本次呼叫確實完成了狀態遷移。
 *
 * 期望：在 run 鎖內一次完成“檢查 pending → 提交 approval.resolved”，只有搶到的呼叫執行副作用；
 * 另一個呼叫返回 409（APPROVAL_ALREADY_RESOLVED），任務不會因此被誤置為 BLOCKED。
 */

const quiet = () => undefined;

function boot(adapters: AgentAdapter[]) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, orchestrator };
}

const script = (approvalId: string): ScriptStep[] => [
  { kind: 'tool', id: 'tool-A' },
  { kind: 'approval', id: approvalId, providerCallId: `toolu_${approvalId}`, summary: 'Run shell command' },
  { kind: 'tool', id: 'tool-B' },
  { kind: 'complete' },
];

describe('H-12：併發批准只執行一次副作用', () => {
  it('同一個交接審批併發批准兩次（Promise.all）：交接只投遞一次，另一個呼叫 409，任務不被阻塞', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'handoff', to: 'codex', instruction: 'Please review', text: 'done' }]);
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'x', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();
    const approval = (await env.store.getRun(task.runId))!.pendingApprovals[0]!;
    expect(approval.payload).toMatchObject({ kind: 'handoff' });

    const results = await Promise.allSettled([
      env.orchestrator.resolveApproval(task.id, approval.id, 'approve'),
      env.orchestrator.resolveApproval(task.id, approval.id, 'approve'),
    ]);
    await env.orchestrator.idle();

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ statusCode: 409, code: 'APPROVAL_ALREADY_RESOLVED' });
    expect(String((lost.reason as Error).message)).toContain('已經處理過');

    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'handoff.requested' && e.data.reason === 'agent-request')).toHaveLength(1);
    expect(codex.calls).toHaveLength(1);
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('普通工具審批併發批准兩次：adapter.approve 只呼叫一次，工具只執行一次，任務正常完成（不是 BLOCKED）', async () => {
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, script('approval-B'));
    const env = boot([adapter]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();

    const results = await Promise.allSettled([
      env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve'),
      env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve'),
    ]);
    await env.orchestrator.idle();

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    expect(adapter.calls.approve).toBe(1);
    expect(world.executions).toEqual(['tool-A', 'tool-B']);
    const run = (await env.store.getRun(task.runId))!;
    // P0-9 / L-1：adapter 不能自己把任務標成完成（run.completed 只有編排器能發）；對話任務這一輪正常結束後保持 RUNNING，由操作員接受結果
    expect(run.status).toBe('RUNNING');
    expect(run.agentSessions.claude?.status).toBe('completed');
    expect((await env.store.listEvents(task.runId)).filter((e) => e.type === 'runtime.error')).toEqual([]);
  });

  it('批准與拒絕併發：先到者生效，另一個 409；工具的執行與記錄一致', async () => {
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, script('approval-B'));
    const env = boot([adapter]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();

    const results = await Promise.allSettled([
      env.orchestrator.resolveApproval(task.id, 'approval-B', 'approve'),
      env.orchestrator.resolveApproval(task.id, 'approval-B', 'decline'),
    ]);
    await env.orchestrator.idle();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const record = await env.store.getApproval('approval-B');
    expect(['approved', 'declined']).toContain(record?.status);
    expect(world.executions).toEqual(record?.status === 'approved' ? ['tool-A', 'tool-B'] : ['tool-A']);
    expect(adapter.calls.approve).toBe(1);
  });
});

describe('H-12 / H-6：HTTP 層', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function serve(adapters: AgentAdapter[]): Promise<RunningServer> {
    const box = createServerSandbox('acc-approval-');
    cleanups.push(box.cleanup);
    const server = await startServer(sandboxServerOptions(box, adapters));
    cleanups.push(() => server.close());
    return server;
  }

  const post = (server: RunningServer, url: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload });

  async function waitingTask(server: RunningServer): Promise<{ id: string; runId: string }> {
    const created = await post(server, '/api/tasks', { prompt: 'do it', agentId: 'claude', workflow: 'manual' });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: string; runId: string };
    await server.orchestrator.idle();
    expect((await server.store.getRun(task.runId))?.status).toBe('WAITING_APPROVAL');
    return task;
  }

  it('已取消任務上的審批返回 409（中文說明），工具不執行', async () => {
    const world = new FakeWorld();
    const server = await serve([new ScriptedAdapter(world, script('approval-http-1'), { capabilities: ['implement'] })]);
    const task = await waitingTask(server);

    expect((await post(server, `/api/tasks/${task.id}/cancel`, {})).statusCode).toBe(200);
    const response = await post(server, '/api/approvals/approval-http-1/resolve', { taskId: task.id, decision: 'approve' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain('已作廢');
    await server.orchestrator.idle();
    expect(world.executions).toEqual(['tool-A']);
  });

  it('兩個標籤頁同時點「批准」：一個 200，一個 409；工具只執行一次', async () => {
    const world = new FakeWorld();
    const server = await serve([new ScriptedAdapter(world, script('approval-http-2'), { capabilities: ['implement'] })]);
    const task = await waitingTask(server);

    const responses = await Promise.all([
      post(server, '/api/approvals/approval-http-2/resolve', { taskId: task.id, decision: 'approve' }),
      post(server, '/api/approvals/approval-http-2/resolve', { taskId: task.id, decision: 'approve' }),
    ]);
    await server.orchestrator.idle();
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(world.executions).toEqual(['tool-A', 'tool-B']);
    // P0-9 / L-1：對話任務這一輪正常結束（不是 BLOCKED），任務保持 RUNNING 等操作員接受結果（adapter 不能自己完成任務）
    const run = (await server.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.agentSessions.claude?.status).toBe('completed');
  });
});
