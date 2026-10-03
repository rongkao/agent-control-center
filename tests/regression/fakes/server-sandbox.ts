import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentAdapter } from '@acc/core';
import type { RunningServer, StartServerOptions } from '@acc/server';

/**
 * startServer 的測試沙箱：所有目錄都在系統臨時目錄裡，環境變數用獨立物件傳入，
 * 絕不讀寫真實的 %LOCALAPPDATA%、使用者主目錄或倉庫根目錄。
 */
export interface ServerSandbox {
  root: string;
  /** 顯式的資料目錄（ACC_DATA_DIR）。 */
  data: string;
  /** 預設工作區（ACC_WORKSPACE / INIT_CWD）。 */
  workspace: string;
  /** 假的使用者主目錄（決定平台預設資料目錄）。 */
  home: string;
  /** 假的 %LOCALAPPDATA% / $XDG_DATA_HOME。 */
  local: string;
  cleanup(): void;
}

export function createServerSandbox(prefix = 'acc-server-'): ServerSandbox {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const sandbox = {
    root,
    data: join(root, 'data'),
    workspace: join(root, 'workspace'),
    home: join(root, 'home'),
    local: join(root, 'local'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  mkdirSync(sandbox.workspace);
  mkdirSync(sandbox.home);
  mkdirSync(sandbox.local);
  return sandbox;
}

/** 測試用的 startServer 引數：隨機埠、安靜、不裝全域性兜底、不提供前端靜態檔案、鎖不重試不自動心跳。 */
export function sandboxServerOptions(
  sandbox: ServerSandbox,
  adapters: AgentAdapter[],
  overrides: Partial<StartServerOptions> & { env?: Record<string, string | undefined> } = {},
): StartServerOptions {
  const { env, ...rest } = overrides;
  return {
    env: { ACC_DATA_DIR: sandbox.data, ACC_WORKSPACE: sandbox.workspace, INIT_CWD: sandbox.workspace, ACC_RUNTIME_MODE: 'mock', ...env },
    homedir: sandbox.home,
    cwd: sandbox.workspace,
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    logLevel: 'silent',
    installProcessGuards: false,
    serveWeb: false,
    adapters: () => adapters,
    instanceLock: { retries: 0, heartbeatMs: 0 },
    notice: () => undefined,
    ...rest,
  };
}

/**
 * 已登入的請求頭（P0-1 之後所有 API 請求都要求登入）：用啟動令牌走 Bearer 認證。
 * 瀏覽器走的是“帶令牌連結 → HttpOnly Cookie”流程，那部分由 access-control.test.ts 專門覆蓋。
 */
export function authHeaders(server: Pick<RunningServer, 'accessToken'>): Record<string, string> {
  return { authorization: `Bearer ${server.accessToken}` };
}

/** 期望啟動失敗：如果意外啟動成功，先關掉再讓斷言失敗，避免洩漏埠和鎖。 */
export async function expectStartupFailure(promise: Promise<RunningServer>): Promise<Error & { code?: string }> {
  let server: RunningServer | undefined;
  try {
    server = await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  await server.close();
  throw new Error('expected startServer to fail, but it started');
}

/** 直接讀資料庫裡的原始行（事件、快照、會話歸屬），用來斷言“什麼都沒寫”。 */
export function readDatabaseRows(dbPath: string): { events: unknown[]; runs: unknown[]; sessions: unknown[] } {
  const db = new DatabaseSync(dbPath);
  try {
    return {
      events: db.prepare('SELECT run_id, sequence, type, data_json FROM events ORDER BY run_id, sequence').all(),
      runs: db.prepare('SELECT run_id, status, snapshot_json, last_sequence FROM run_snapshots ORDER BY run_id').all(),
      sessions: db.prepare('SELECT id, owner_instance_id, status FROM agent_sessions ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}
