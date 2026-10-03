import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { RunningServer, StartServerOptions } from '@acc/server';
import { startServer } from '@acc/server';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { authHeaders, createServerSandbox, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-3 / P0-10 審查：任何任務的工作目錄都不能與控制面資料互相包含（H-16）。
 *
 * 現象（修復前）：
 * - 只檢查預設工作區（啟動時）和新建任務時顯式傳入的 cwd；升級前已有任務的 cwd（例如 C:\Users\me，包含新的資料目錄）
 *   在啟動恢復、續跑、再發訊息時都不檢查，照樣續跑，agent 能改到資料庫；
 * - 預設工作區在資料目錄之內時照樣啟動，不帶 cwd 的任務直接用它（顯式傳同一目錄卻返回 400）；
 * - ACC_ALLOW_DATA_IN_WORKSPACE=1 會整體關閉任務 cwd 的資料目錄檢查，比文件說的“預設工作區內只告警”範圍大。
 *
 * 期望：啟動恢復和每次啟動 / 續接 agent 前都用同一套規則檢查工作目錄，不合規的任務 fail closed 為帶原因的 BLOCKED；
 * 不帶 cwd 的任務同樣校驗預設工作區；開關只放寬“預設工作區包含資料”這一條。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-cwd-guard-');
  cleanups.push(box.cleanup);
  return box;
}

async function boot(box: ServerSandbox, adapters: ScriptedAdapter[], overrides: Partial<StartServerOptions> & { env?: Record<string, string | undefined> } = {}): Promise<RunningServer> {
  const server = await startServer(sandboxServerOptions(box, adapters, overrides));
  cleanups.push(() => server.close());
  return server;
}

function post(server: RunningServer, url: string, payload: Record<string, unknown>) {
  return server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload });
}

describe('P0-10 審查：升級前已有任務的工作目錄', () => {
  it('cwd 包含資料目錄的已有任務：啟動時不續跑，fail closed 為帶原因的 BLOCKED；再發訊息也不會續接', async () => {
    const box = sandbox();
    const world = new FakeWorld();
    // 升級前的舊程式直接寫入一個 cwd = box.root 的任務（box.root 包含資料目錄 box.data），執行到一半
    mkdirSync(box.data, { recursive: true });
    const oldStore = new SqliteControlPlaneStore({ path: join(box.data, 'agent-control.db') });
    const oldOrchestrator = new Orchestrator(oldStore, new EventBus(), { instanceId: 'old' });
    oldOrchestrator.registerAdapter(new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }]));
    const task = await oldOrchestrator.createTask({ title: 't', prompt: 'work', agentId: 'claude', workflow: 'manual', cwd: box.root });
    await oldOrchestrator.idle();
    expect((await oldStore.getRun(task.runId))?.agentSessions.claude?.metadata?.cwd).toBe(box.root);
    oldStore.close();

    const adapter = new ScriptedAdapter(world, [
      { kind: 'tool', id: 'tool-A' },
      { kind: 'tool', id: 'tool-Z' },
    ]);
    const server = await boot(box, [adapter]);
    expect(server.recovery.resumed).toEqual([]);
    expect(server.recovery.blocked).toEqual([task.runId]);
    expect(adapter.calls.resume).toBe(0);
    expect(world.executions).toEqual(['tool-A']);
    const run = await server.store.getRun(task.runId);
    expect(run?.status).toBe('BLOCKED');
    const error = (await server.store.listEvents(task.runId)).find((e) => e.type === 'runtime.error' && e.data.code === 'WORKSPACE_REJECTED');
    expect(String(error?.data.message)).toContain(box.data);

    // 操作員再發訊息：同樣不續接這個會話
    await post(server, `/api/tasks/${task.id}/message`, { agentId: 'claude', message: 'continue' });
    await server.orchestrator.idle();
    expect(adapter.calls.resume).toBe(0);
    expect(adapter.calls.start).toBe(0);
    expect(world.executions).toEqual(['tool-A']);
    expect((await server.store.getRun(task.runId))?.status).toBe('BLOCKED');
  });
});

describe('P0-10 審查：兩個方向一致', () => {
  it('預設工作區在資料目錄之內：服務照常啟動並告警，但不帶 cwd 的任務返回 400（與顯式傳同一目錄一致）', async () => {
    const box = sandbox();
    const inside = join(box.data, 'proj');
    mkdirSync(inside, { recursive: true });
    const server = await boot(box, [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])], { env: { ACC_WORKSPACE: inside, INIT_CWD: inside }, cwd: inside });
    expect(server.warnings.join('\n')).toContain(box.data);

    const implicit = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude' });
    expect(implicit.statusCode).toBe(400);
    expect(String(implicit.json().error)).toContain('工作目錄');
    const explicit = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: inside });
    expect(explicit.statusCode).toBe(400);
    expect(await server.store.listTasks()).toEqual([]);

    // 填一個正常的專案目錄就能用
    const project = join(box.root, 'project');
    mkdirSync(project);
    expect((await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: project })).statusCode).toBe(201);
  });

  it('ACC_ALLOW_DATA_IN_WORKSPACE 只放寬“預設工作區包含資料”：任務 cwd 在資料目錄之內、或包含工作區之外的資料時仍然拒絕', async () => {
    const box = sandbox();
    const server = await boot(box, [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])], {
      env: { ACC_DB_PATH: join(box.workspace, 'acc.db'), ACC_ALLOW_DATA_IN_WORKSPACE: '1' },
    });
    // 預設工作區包含資料庫：顯式允許，照常可用
    expect((await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude' })).statusCode).toBe(201);
    expect((await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: box.workspace })).statusCode).toBe(201);

    // cwd 在資料目錄（日誌、令牌所在的 box.data）之內：仍然拒絕
    const insideData = join(box.data, 'proj');
    mkdirSync(insideData, { recursive: true });
    const inData = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: insideData });
    expect(inData.statusCode).toBe(400);
    expect(String(inData.json().error)).toContain(box.data);

    // cwd 包含工作區之外的控制面資料（box.root 包含 box.data 裡的日誌和令牌）：仍然拒絕
    const containsData = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: box.root });
    expect(containsData.statusCode).toBe(400);
  });
});
