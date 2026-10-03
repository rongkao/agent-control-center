import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@acc/core';
import { startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P1-9 效能：
 * - M-22：GET /api/tasks/:id?after=N 只返回序號大於 N 的事件（介面按 id 合併），不再每次重傳整份事件日誌；
 * - M-11：/api/usage 在沒有新事件時直接返回快取的彙總，不再每次掃描全部事件。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('P1-9：增量事件與用量快取', () => {
  it('?after=N 只返回新事件；用量彙總在事件不變時走快取', async () => {
    const box = createServerSandbox('acc-perf-');
    cleanups.push(box.cleanup);
    const world = new FakeWorld();
    const adapters: AgentAdapter[] = [new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }, { kind: 'complete' }])];
    const server = await startServer(sandboxServerOptions(box, adapters));
    cleanups.push(() => server.close());
    const headers = authHeaders(server);

    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, 'content-type': 'application/json' }, payload: { prompt: 'hi', agentId: 'claude', workflow: 'manual' } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().id as string;
    // 等這一輪跑完
    for (let i = 0; i < 100; i++) {
      const d = (await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers })).json();
      if (d.events.some((e: { type: string; data: { status?: string } }) => e.type === 'agent.status' && e.data.status === 'completed')) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    const full = (await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers })).json();
    const events = full.events as Array<{ sequence: number }>;
    expect(events.length).toBeGreaterThan(3);
    const cut = events[events.length - 3]!.sequence;
    const delta = (await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}?after=${cut}`, headers })).json();
    expect(delta.incrementalAfter).toBe(cut);
    expect(delta.events.map((e: { sequence: number }) => e.sequence)).toEqual(events.slice(-2).map((e) => e.sequence));
    expect(delta.task.id).toBe(taskId);

    const u1 = await server.app.inject({ method: 'GET', url: '/api/usage', headers });
    const u2 = await server.app.inject({ method: 'GET', url: '/api/usage', headers });
    expect(u1.statusCode).toBe(200);
    expect(u2.json()).toEqual(u1.json());
  });
});
