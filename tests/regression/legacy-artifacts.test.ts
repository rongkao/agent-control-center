import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { makeEvent, makeRun, makeTask } from '../helpers.js';
import { createServerSandbox, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-3 / P0-10 審查：遷移之後，包含完整歷史的舊庫備份和舊日誌不能留在 agent 的預設工作區裡（H-16）。
 *
 * 現象（修復前）：舊庫原地改名為 agent-control.db.bak-時間戳，一直留在 INIT_CWD（預設工作區）裡；
 * 舊版本預設的 INIT_CWD/logs/events.log 也不處理、不提示。agent（包括 Codex 在 workspace-write 下無需審批的命令）
 * 可以直接讀到全部歷史提示詞、輸出和審批記錄；INIT_CWD 是別的倉庫時，git add . 還可能把備份提交出去。
 *
 * 期望：原地改名仍用來判斷舊庫是否被佔用，改名成功後把備份移到 <資料目錄>/legacy-backups/；
 * 上一版遷移已經留在工作區裡的 .bak-* 和舊的 logs/events.log 也一併移走；移不走時明確告警。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-legacy-');
  cleanups.push(box.cleanup);
  return box;
}

function track(server: RunningServer): RunningServer {
  cleanups.push(() => server.close());
  return server;
}

const scripted = () => [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])];
const SECRET = 'SECRET-PROMPT-XYZ';

/** 在 dir 下寫一個“舊版本”的資料庫：一個任務、三條事件（其中一條帶敏感提示詞）。 */
function writeLegacyDatabase(dir: string, name = 'agent-control.db'): string {
  const path = join(dir, name);
  const store = new SqliteControlPlaneStore({ path });
  void store.commit({ task: makeTask({ id: 'legacy-task', runId: 'legacy-run', status: 'COMPLETED', prompt: SECRET }), run: makeRun({ runId: 'legacy-run', taskId: 'legacy-task', status: 'COMPLETED' }) });
  for (let seq = 1; seq <= 3; seq++) {
    void store.commit({ event: makeEvent(seq, { runId: 'legacy-run', taskId: 'legacy-task', id: `legacy-event-${seq}`, data: { message: seq === 1 ? SECRET : `m${seq}` } }) });
  }
  store.close();
  return path;
}

/** 舊版本預設的可讀事件日誌（INIT_CWD/logs/events.log），格式與 event-log.ts 一致。 */
function writeLegacyEventLog(workspace: string): string {
  mkdirSync(join(workspace, 'logs'), { recursive: true });
  const path = join(workspace, 'logs', 'events.log');
  writeFileSync(path, `10:00:00 [任務 1a2b3c4d] #  1 系統     任務開始 \n10:00:01 [任務 1a2b3c4d] #  2 你 → claude: ${SECRET}\n`, 'utf8');
  return path;
}

/** 工作區裡所有控制面資料的痕跡（資料庫、備份、舊事件日誌）。 */
function controlDataLeftIn(workspace: string): string[] {
  const names = readdirSync(workspace).filter((name) => name.startsWith('agent-control.db'));
  if (existsSync(join(workspace, 'logs', 'events.log'))) names.push('logs/events.log');
  return names;
}

describe('P0-10 審查：遷移後的備份和舊日誌移出預設工作區', () => {
  it('遷移之後工作區裡不再有 agent-control.db*，也沒有舊的 logs/events.log；備份在資料目錄的 legacy-backups 裡且資料完整', async () => {
    const box = sandbox();
    writeLegacyDatabase(box.workspace);
    writeLegacyEventLog(box.workspace);
    // 使用者自己的日誌檔案不屬於我們：原樣保留
    writeFileSync(join(box.workspace, 'logs', 'app.log'), 'user log\n');
    const notices: string[] = [];
    const server = track(await startServer(sandboxServerOptions(box, scripted(), { notice: (m) => notices.push(m) })));

    expect(await server.store.getTask('legacy-task')).toMatchObject({ id: 'legacy-task' });
    expect(controlDataLeftIn(box.workspace)).toEqual([]);
    expect(readFileSync(join(box.workspace, 'logs', 'app.log'), 'utf8')).toBe('user log\n');
    expect(server.warnings).toEqual([]);

    const backupDir = join(box.data, 'legacy-backups');
    const backups = readdirSync(backupDir);
    const backupDb = backups.find((name) => /^agent-control\.db\.bak-[\d-]+$/.test(name));
    expect(backupDb).toBeDefined();
    const db = new DatabaseSync(join(backupDir, backupDb!));
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(3);
    db.close();
    const oldLog = backups.find((name) => name.startsWith('events') && name.endsWith('.log'));
    expect(oldLog).toBeDefined();
    expect(readFileSync(join(backupDir, oldLog!), 'utf8')).toContain(SECRET);
    const log = notices.join('\n');
    expect(log).toContain(backupDir);
  });

  it('上一版遷移已經留在工作區裡的 .bak-* 備份：啟動時一併移到資料目錄', async () => {
    const box = sandbox();
    // 新位置已經有庫（上一版已經遷移過），工作區裡只剩下上一版留下的備份
    const first = await startServer(sandboxServerOptions(box, scripted()));
    await first.close();
    writeLegacyDatabase(box.workspace, 'agent-control.db.bak-20260101-000000');
    writeFileSync(join(box.workspace, 'agent-control.db.bak-20260101-000000-wal'), '');

    const server = track(await startServer(sandboxServerOptions(box, scripted())));
    expect(controlDataLeftIn(box.workspace)).toEqual([]);
    const moved = readdirSync(join(box.data, 'legacy-backups'));
    expect(moved).toContain('agent-control.db.bak-20260101-000000');
    expect(moved).toContain('agent-control.db.bak-20260101-000000-wal');
    expect(server.warnings).toEqual([]);
  });

  it('不是本程式寫的 logs/events.log（例如使用者專案自己的日誌）：不動它', async () => {
    const box = sandbox();
    mkdirSync(join(box.workspace, 'logs'));
    writeFileSync(join(box.workspace, 'logs', 'events.log'), '2026-01-01 INFO user service started\n');
    track(await startServer(sandboxServerOptions(box, scripted())));
    expect(readFileSync(join(box.workspace, 'logs', 'events.log'), 'utf8')).toBe('2026-01-01 INFO user service started\n');
  });

  it('新舊位置都有庫（舊庫不遷移）：舊庫仍在工作區裡時給出告警', async () => {
    const box = sandbox();
    const first = await startServer(sandboxServerOptions(box, scripted()));
    await first.close();
    const legacyPath = writeLegacyDatabase(box.workspace);
    const server = track(await startServer(sandboxServerOptions(box, scripted())));
    expect(existsSync(legacyPath)).toBe(true);
    expect(server.warnings.join('\n')).toContain(legacyPath);
  });
});
