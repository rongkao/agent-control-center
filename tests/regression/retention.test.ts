import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { createEventLogger, startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P1-12 資料保留與永續性：synchronous=FULL、journal_size_limit、升級前備份、放棄 / 刪除 / 匯出、日誌輪轉。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('SQLite 永續性設定', () => {
  it('synchronous=FULL，journal_size_limit 等於配置值', () => {
    const dir = tempDir('acc-sync-');
    const store = new SqliteControlPlaneStore({ path: join(dir, 'a.db'), journalSizeLimit: 1234567 });
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous).toBe(2);
    expect((db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number }).journal_size_limit).toBe(1234567);
    store.close();
  });

  it('從舊版本升級前先備份；新建的空庫不備份', () => {
    const dir = tempDir('acc-migrate-');
    const path = join(dir, 'old.db');
    // 造一個 v2 的舊庫
    const fresh = new SqliteControlPlaneStore({ path });
    fresh.close();
    const raw = new DatabaseSync(path);
    raw.exec('ALTER TABLE usage DROP COLUMN cost_usd; ALTER TABLE usage DROP COLUMN cache_write_tokens; PRAGMA user_version = 2;');
    raw.close();
    const before = readdirSync(dir).filter((f) => f.endsWith('.bak'));
    expect(before).toHaveLength(0);
    const upgraded = new SqliteControlPlaneStore({ path });
    expect(upgraded.migrationBackup).toBeDefined();
    expect(existsSync(upgraded.migrationBackup!)).toBe(true);
    upgraded.close();
  });
});

describe('放棄 / 刪除 / 匯出', () => {
  it('BLOCKED 的任務可以放棄（→ FAILED）；刪除只允許已結束的任務，並清掉全部記錄；匯出是 JSON Lines', async () => {
    const box = createServerSandbox('acc-retention-');
    cleanups.push(box.cleanup);
    const world = new FakeWorld();
    const adapters: AgentAdapter[] = [new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }, { kind: 'complete' }])];
    const server = await startServer(sandboxServerOptions(box, adapters));
    cleanups.push(() => server.close());
    const headers = { ...authHeaders(server), 'content-type': 'application/json' };
    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers, payload: { prompt: 'hi', agentId: 'claude', workflow: 'manual' } });
    const taskId = created.json().id as string;

    // 還沒結束：不能刪
    const early = await server.app.inject({ method: 'DELETE', url: `/api/tasks/${taskId}`, headers, payload: {} });
    expect(early.statusCode).toBe(409);

    const abandoned = await server.app.inject({ method: 'POST', url: `/api/tasks/${taskId}/abandon`, headers, payload: {} });
    expect(abandoned.statusCode).toBe(200);
    const detail = (await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers })).json();
    expect(detail.run.status).toBe('FAILED');

    const exported = await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}/export`, headers });
    expect(exported.headers['content-type']).toContain('application/x-ndjson');
    const lines = exported.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'task', task: { id: taskId } });
    expect(lines.slice(1).every((l) => l.kind === 'event')).toBe(true);

    const deleted = await server.app.inject({ method: 'DELETE', url: `/api/tasks/${taskId}`, headers, payload: {} });
    expect(deleted.statusCode).toBe(200);
    expect((await server.app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers })).statusCode).toBe(404);
  });
});

describe('事件日誌輪轉', () => {
  it('超過上限時輪轉成 events.log.1', () => {
    const dir = tempDir('acc-log-');
    writeFileSync(join(dir, 'events.log'), 'x'.repeat(2000));
    createEventLogger(dir, { echo: false, maxBytes: 1000 });
    expect(existsSync(join(dir, 'events.log.1'))).toBe(true);
  });
});
