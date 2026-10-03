import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, win32, posix, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '@acc/server';
import { resolveControlPlanePaths, startServer } from '@acc/server';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { makeEvent, makeRun, makeTask } from '../helpers.js';
import { authHeaders, createServerSandbox, expectStartupFailure, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-10（H-16、L-31）：控制面資料（資料庫、日誌）移出 agent 可寫的工作區。
 * 現象：dbPath 預設是 ${INIT_CWD}/agent-control.db，日誌也在 INIT_CWD/logs，而預設工作區也是 INIT_CWD——
 * agent 能讀到全部歷史，也能改快照、審批和預算。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-data-');
  cleanups.push(box.cleanup);
  return box;
}

function track(server: RunningServer): RunningServer {
  cleanups.push(() => server.close());
  return server;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const scripted = () => [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])];

/** 不設定 ACC_DATA_DIR：走平台預設的使用者資料目錄（全部指向沙箱裡的假目錄）。 */
function defaultEnv(box: ServerSandbox): Record<string, string | undefined> {
  return { ACC_DATA_DIR: undefined, LOCALAPPDATA: box.local, XDG_DATA_HOME: box.local };
}

describe('P0-10 預設資料目錄（平台使用者資料目錄）', () => {
  it('Windows：%LOCALAPPDATA%\\agent-control-center；沒有 LOCALAPPDATA 時回退到主目錄下的 AppData\\Local', () => {
    const paths = resolveControlPlanePaths({
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', INIT_CWD: 'D:\\repo' },
      platform: 'win32',
      homedir: 'C:\\Users\\u',
      cwd: 'D:\\repo',
    });
    expect(paths.dataDir).toBe('C:\\Users\\u\\AppData\\Local\\agent-control-center');
    expect(paths.dbPath).toBe('C:\\Users\\u\\AppData\\Local\\agent-control-center\\agent-control.db');
    expect(paths.logDir).toBe('C:\\Users\\u\\AppData\\Local\\agent-control-center\\logs');
    expect(paths.lockPath).toBe(`${paths.dbPath}.lock`);
    expect(paths.legacyDbPath).toBe(win32.join('D:\\repo', 'agent-control.db'));
    expect(paths.workspace).toBe('D:\\repo');

    const fallback = resolveControlPlanePaths({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u', cwd: 'D:\\repo' });
    expect(fallback.dataDir).toBe('C:\\Users\\u\\AppData\\Local\\agent-control-center');
  });

  it('macOS：~/Library/Application Support/agent-control-center', () => {
    const paths = resolveControlPlanePaths({ env: { INIT_CWD: '/work/repo' }, platform: 'darwin', homedir: '/Users/u', cwd: '/work/repo' });
    expect(paths.dataDir).toBe('/Users/u/Library/Application Support/agent-control-center');
    expect(paths.dbPath).toBe(posix.join(paths.dataDir, 'agent-control.db'));
  });

  it('Linux 等：$XDG_DATA_HOME/agent-control-center，未設定時 ~/.local/share/agent-control-center', () => {
    expect(resolveControlPlanePaths({ env: { XDG_DATA_HOME: '/data/xdg' }, platform: 'linux', homedir: '/home/u', cwd: '/w' }).dataDir).toBe(
      '/data/xdg/agent-control-center',
    );
    expect(resolveControlPlanePaths({ env: {}, platform: 'linux', homedir: '/home/u', cwd: '/w' }).dataDir).toBe('/home/u/.local/share/agent-control-center');
  });

  it('保留原有環境變數的覆蓋能力：ACC_DB_PATH、ACC_LOG_DIR，另加 ACC_DATA_DIR', () => {
    const paths = resolveControlPlanePaths({
      env: { ACC_DATA_DIR: '/srv/acc', ACC_DB_PATH: '/db/custom.db', ACC_LOG_DIR: '/var/log/acc', ACC_WORKSPACE: '/w2', INIT_CWD: '/w1' },
      platform: 'linux',
      homedir: '/home/u',
      cwd: '/w0',
    });
    expect(paths).toMatchObject({ dataDir: '/srv/acc', dbPath: '/db/custom.db', logDir: '/var/log/acc', lockPath: '/db/custom.db.lock', workspace: '/w2' });
    expect(paths.dbPathExplicit).toBe(true);
    const byDataDir = resolveControlPlanePaths({ env: { ACC_DATA_DIR: '/srv/acc' }, platform: 'linux', homedir: '/home/u', cwd: '/w0' });
    expect(byDataDir).toMatchObject({ dbPath: '/srv/acc/agent-control.db', logDir: '/srv/acc/logs', workspace: '/w0', legacyDbPath: '/w0/agent-control.db' });
  });

  it('預設配置啟動後，資料庫和日誌都不在 INIT_CWD（預設工作區）下，工作區裡什麼都不寫', async () => {
    const box = sandbox();
    const server = track(await startServer(sandboxServerOptions(box, scripted(), { env: defaultEnv(box) })));
    const created = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'hello', agentId: 'claude' } });
    expect(created.statusCode).toBe(201);
    await server.orchestrator.idle();

    expect(isInside(server.paths.dbPath, box.workspace)).toBe(false);
    expect(isInside(server.paths.logDir, box.workspace)).toBe(false);
    expect(isInside(server.paths.dbPath, box.local) || isInside(server.paths.dbPath, box.home)).toBe(true);
    expect(existsSync(server.paths.dbPath)).toBe(true);
    expect(readFileSync(join(server.paths.logDir, 'events.log'), 'utf8')).toContain('任務開始');
    expect(readdirSync(box.workspace)).toEqual([]);
  });
});

describe('P0-10 資料落在工作區內時拒絕啟動', () => {
  it('ACC_DB_PATH 指向工作區內：啟動失敗並說明原因，不建立資料庫檔案', async () => {
    const box = sandbox();
    const dbPath = join(box.workspace, 'acc.db');
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, scripted(), { env: { ACC_DB_PATH: dbPath } })));
    expect(error.code).toBe('ACC_DATA_IN_WORKSPACE');
    expect(error.message).toContain('工作區');
    expect(error.message).toContain(dbPath);
    expect(error.message).toContain('ACC_ALLOW_DATA_IN_WORKSPACE');
    expect(existsSync(dbPath)).toBe(false);
    expect(readdirSync(box.workspace)).toEqual([]);
  });

  it('ACC_LOG_DIR 指向工作區內：同樣拒絕啟動', async () => {
    const box = sandbox();
    const logDir = join(box.workspace, 'logs');
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, scripted(), { env: { ACC_LOG_DIR: logDir } })));
    expect(error.code).toBe('ACC_DATA_IN_WORKSPACE');
    expect(error.message).toContain(logDir);
    expect(existsSync(logDir)).toBe(false);
  });

  it('顯式開關 ACC_ALLOW_DATA_IN_WORKSPACE=1：降級為告警，正常啟動', async () => {
    const box = sandbox();
    const notices: string[] = [];
    const server = track(
      await startServer(
        sandboxServerOptions(box, scripted(), { env: { ACC_DB_PATH: join(box.workspace, 'acc.db'), ACC_ALLOW_DATA_IN_WORKSPACE: '1' }, notice: (m) => notices.push(m) }),
      ),
    );
    expect(server.paths.dbPath).toBe(join(box.workspace, 'acc.db'));
    expect(server.warnings.join('\n')).toContain('工作區');
    expect(notices.join('\n')).toContain('工作區');
  });

  it('新建任務時 cwd 包含控制面資料：拒絕（400）且不建立任務', async () => {
    const box = sandbox();
    const server = track(await startServer(sandboxServerOptions(box, scripted())));
    // box.root 包含資料目錄 box.data：agent 在這裡工作就能改資料庫
    const response = await server.app.inject({ method: 'POST', url: '/api/tasks', headers: authHeaders(server), payload: { prompt: 'x', agentId: 'claude', cwd: box.root } });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain(box.data);
    expect(await server.store.listTasks()).toEqual([]);
  });
});

/** 在舊位置準備一個“舊版本”的資料庫：資料還在 -wal 裡、沒有合併進主檔案（舊程序被強殺時的典型狀態）。 */
function seedLegacyDatabase(box: ServerSandbox): { legacyPath: string } {
  const seedDir = join(box.root, 'seed');
  mkdirSync(seedDir);
  const seedPath = join(seedDir, 'agent-control.db');
  const store = new SqliteControlPlaneStore({ path: seedPath });
  void store.commit({ task: makeTask({ id: 'legacy-task', runId: 'legacy-run', status: 'COMPLETED' }), run: makeRun({ runId: 'legacy-run', taskId: 'legacy-task', status: 'COMPLETED' }) });
  for (let seq = 1; seq <= 3; seq++) void store.commit({ event: makeEvent(seq, { runId: 'legacy-run', taskId: 'legacy-task', id: `legacy-event-${seq}` }) });
  expect(existsSync(`${seedPath}-wal`)).toBe(true);
  const legacyPath = join(box.workspace, 'agent-control.db');
  // 連線仍開啟時按位元組複製：主檔案 + -wal + -shm
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${seedPath}${suffix}`)) writeFileSync(`${legacyPath}${suffix}`, readFileSync(`${seedPath}${suffix}`));
  }
  store.close();
  return { legacyPath };
}

describe('P0-10 舊位置資料庫的一次性遷移', () => {
  it('舊位置有庫、新位置沒有：連同 -wal 一起遷移，舊檔案改名保留為備份，並列印明確的日誌', async () => {
    const box = sandbox();
    const { legacyPath } = seedLegacyDatabase(box);
    const notices: string[] = [];
    const server = track(await startServer(sandboxServerOptions(box, scripted(), { notice: (m) => notices.push(m) })));

    expect(server.paths.dbPath).toBe(join(box.data, 'agent-control.db'));
    expect(await server.store.getTask('legacy-task')).toMatchObject({ id: 'legacy-task', status: 'COMPLETED' });
    expect((await server.store.listEvents('legacy-run')).map((e) => e.sequence)).toEqual([1, 2, 3]);

    // 舊檔案不再以原名存在（不會被當成“還在用的庫”），而是改名保留為備份
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(`${legacyPath}-wal`)).toBe(false);
    expect(existsSync(`${legacyPath}-shm`)).toBe(false);
    // 備份包含完整歷史，放在資料目錄的 legacy-backups 裡，而不是留在 agent 的工作區（P0-10 審查）
    expect(readdirSync(box.workspace).filter((name) => name.startsWith('agent-control.db'))).toEqual([]);
    const backupDir = join(box.data, 'legacy-backups');
    const backups = readdirSync(backupDir).filter((name) => name.startsWith('agent-control.db.bak-'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupDb = new DatabaseSync(join(backupDir, backups.find((name) => !/-(wal|shm)$/.test(name))!));
    expect((backupDb.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(3);
    backupDb.close();

    const log = notices.join('\n');
    expect(log).toContain('遷移');
    expect(log).toContain(legacyPath);
    expect(log).toContain(server.paths.dbPath);

    // 再次啟動：新庫已存在，不會重複遷移
    await server.close();
    const again = track(await startServer(sandboxServerOptions(box, scripted())));
    expect(await again.store.getTask('legacy-task')).toBeDefined();
  });

  it('遷移失敗（舊檔案不是有效資料庫）：拒絕啟動並說明原因，不靜默新建空庫，舊檔案原樣保留', async () => {
    const box = sandbox();
    const legacyPath = join(box.workspace, 'agent-control.db');
    const garbage = 'this is not a sqlite database, the migration must not silently start with an empty one';
    writeFileSync(legacyPath, garbage);
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, scripted())));
    expect(error.code).toBe('ACC_MIGRATION_FAILED');
    expect(error.message).toContain('遷移');
    expect(error.message).toContain(legacyPath);
    expect(existsSync(join(box.data, 'agent-control.db'))).toBe(false);
    expect(readFileSync(legacyPath, 'utf8')).toBe(garbage);
  });

  it.runIf(process.platform === 'win32')('舊庫正被舊版本程序開啟（Windows 無法改名）：遷移回滾，不留下新庫，並說明原因', async () => {
    const box = sandbox();
    const { legacyPath } = seedLegacyDatabase(box);
    const oldInstance = new DatabaseSync(legacyPath);
    cleanups.push(() => oldInstance.close());
    const error = await expectStartupFailure(startServer(sandboxServerOptions(box, scripted())));
    expect(error.code).toBe('ACC_MIGRATION_FAILED');
    expect(error.message).toContain('正被');
    expect(existsSync(join(box.data, 'agent-control.db'))).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
  });

  it('新舊位置都有庫：使用新庫、不遷移，並提示舊位置還有一個庫', async () => {
    const box = sandbox();
    const first = await startServer(sandboxServerOptions(box, scripted()));
    await first.close();
    const { legacyPath } = seedLegacyDatabase(box);
    const notices: string[] = [];
    const server = track(await startServer(sandboxServerOptions(box, scripted(), { notice: (m) => notices.push(m) })));
    expect(await server.store.getTask('legacy-task')).toBeUndefined();
    expect(existsSync(legacyPath)).toBe(true);
    expect(notices.join('\n')).toContain(legacyPath);
  });
});

describe('L-31 倉庫衛生', () => {
  it('references/（clone-references 的目標目錄）以及資料庫備份、鎖檔案都被 .gitignore 忽略', () => {
    for (const path of ['references/langgraph/README.md', 'references/codex/package.json', 'agent-control.db.lock', 'agent-control.db.bak-20260101-000000']) {
      const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: repoRoot });
      expect({ path, status: result.status }).toEqual({ path, status: 0 });
    }
  });
});
