import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { deferred } from './fakes/deferred.js';
import { GatedAgent } from './fakes/gated-agent.js';
import { authHeaders, createServerSandbox, readDatabaseRows, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-3 審查：close() 和租約丟失後的自行關閉必須停止 agent 執行時。
 *
 * 現象（修復前）：onClose 只釋放 Codex 子程序；Claude 的 query 迴圈、測試命令子程序、透過 options.adapters 注入的 adapter
 * 都不會被通知。桌面外殼在同一程序裡 close() 再 startServer() 時，recover 會對同一個 provider 會話再 resume 一次，
 * 於是一個會話同時有兩個執行時（違反 H-3 的“一個會話只有一個執行時所有者”）；租約丟失後服務關了資料庫和埠，
 * agent 卻繼續執行工具，而且不再有任何記錄或審批。
 *
 * 期望：關閉時先停掉全部執行時（不發事件、不改持久化狀態，重啟後照常續接），再關埠和資料庫、釋放租約。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-shutdown-');
  cleanups.push(box.cleanup);
  return box;
}

function track(server: RunningServer): RunningServer {
  cleanups.push(() => server.close());
  return server;
}

/** 還在執行的 Claude 查詢（沒有被 abort）。 */
const liveQueries = (runtime: FakeClaudeRuntime) => runtime.queries.filter((q) => !q.options.abortController?.signal.aborted);

/** 第一輪一直不結束（agent 正在工作）；續跑的回合立即結束。 */
function holdingRuntime(disk: FakeClaudeDisk) {
  const started = deferred();
  const hold = deferred();
  const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
    if (ctx.resumed) return;
    started.resolve();
    await hold.promise;
  });
  return { runtime, started, hold };
}

async function createWorkingTask(server: RunningServer): Promise<{ id: string; runId: string }> {
  const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'keep working', agentId: 'claude', workflow: 'manual' } });
  expect(created.statusCode).toBe(201);
  return created.json() as { id: string; runId: string };
}

describe('P0-3 審查：關閉服務時停止 agent 執行時', () => {
  it('close() 之後執行時已經停止、持久化狀態不變；同一程序重啟後同一個 provider 會話只有一個存活的執行時', async () => {
    const box = sandbox();
    const disk = new FakeClaudeDisk();
    const { runtime, started } = holdingRuntime(disk);
    const first = track(await startServer(sandboxServerOptions(box, [new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn })])));
    const task = await createWorkingTask(first);
    await started.promise;
    await first.orchestrator.idle();
    expect(liveQueries(runtime)).toHaveLength(1);
    const dbPath = first.paths.dbPath;

    await first.close();
    // Claude 的 query 已經 abort
    expect(liveQueries(runtime)).toHaveLength(0);
    // 正常關閉不改寫任務狀態：會話仍是“工作中”，重啟後照常續接（不是被當成已取消 / 已失敗）
    const rows = readDatabaseRows(dbPath);
    const snapshot = JSON.parse((rows.runs as Array<{ run_id: string; snapshot_json: string }>).find((r) => r.run_id === task.runId)!.snapshot_json) as {
      status: string;
      agentSessions: Record<string, { status: string }>;
    };
    expect(snapshot.status).toBe('RUNNING');
    expect(snapshot.agentSessions.claude?.status).toBe('coding');
    const statuses = (rows.events as Array<{ run_id: string; type: string; data_json: string }>)
      .filter((e) => e.run_id === task.runId && e.type === 'agent.status')
      .map((e) => (JSON.parse(e.data_json) as { status?: string }).status);
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('failed');

    // 同一程序裡重啟：recover 續接同一個 provider 會話
    const second = track(await startServer(sandboxServerOptions(box, [new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn })])));
    expect(second.recovery.resumed).toEqual([task.runId]);
    const live = liveQueries(runtime);
    expect(live).toHaveLength(1);
    expect(live[0]?.options.resume).toBe('native-session-1');
    await second.orchestrator.idle();
  });

  it('透過 options.adapters 注入、沒有 dispose 的 adapter：關閉時對線上會話呼叫 cancel，發出的事件不落盤', async () => {
    const box = sandbox();
    const gated = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const server = track(await startServer(sandboxServerOptions(box, [gated])));
    const task = await createWorkingTask(server);
    await server.orchestrator.idle();
    expect(gated.starts).toHaveLength(1);
    const dbPath = server.paths.dbPath;

    await server.close();
    expect(gated.cancels).toBe(1);
    const statuses = (readDatabaseRows(dbPath).events as Array<{ run_id: string; type: string; data_json: string }>)
      .filter((e) => e.run_id === task.runId && e.type === 'agent.status')
      .map((e) => (JSON.parse(e.data_json) as { status?: string }).status);
    expect(statuses).not.toContain('cancelled');
  });

  it('租約丟失：先讓執行時停下，再關資料庫和埠，並通知宿主', async () => {
    const box = sandbox();
    const { runtime, started } = holdingRuntime(new FakeClaudeDisk());
    let lockDb: DatabaseSync | undefined;
    const fatal: Error[] = [];
    const server = track(
      await startServer(
        sandboxServerOptions(box, [new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn })], {
          instanceLock: { retries: 0, heartbeatMs: 0, openDatabase: (file: string) => (lockDb = new DatabaseSync(file, { timeout: 0 })) },
          onFatal: (error) => fatal.push(error),
        }),
      ),
    );
    await createWorkingTask(server);
    await started.promise;
    expect(liveQueries(runtime)).toHaveLength(1);

    lockDb!.close();
    expect(server.lock!.heartbeat()).toBe(false);
    // 租約丟失的回呼同步執行：返回時執行時已經被中止（不等到非同步關閉流程）
    expect(liveQueries(runtime)).toHaveLength(0);
    await server.closed;
    expect(fatal).toHaveLength(1);
    expect(server.app.server.listening).toBe(false);
  });
});
