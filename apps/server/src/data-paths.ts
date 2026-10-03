import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * 控制面資料（資料庫、單實例鎖、日誌）的位置（P0-10 / H-16）。
 *
 * 預設放在當前使用者的資料目錄，而不是 agent 的工作區裡：
 * - Windows：%LOCALAPPDATA%\agent-control-center（沒有該變數時用 主目錄\AppData\Local）
 * - macOS：~/Library/Application Support/agent-control-center
 * - 其他：$XDG_DATA_HOME/agent-control-center（未設定時 ~/.local/share/agent-control-center）
 *
 * 環境變數（保留原有名稱和覆蓋能力）：
 * - ACC_DATA_DIR：整個資料目錄（資料庫 + 日誌）；
 * - ACC_DB_PATH：資料庫檔案（優先於 ACC_DATA_DIR）；
 * - ACC_LOG_DIR：日誌目錄（優先於 ACC_DATA_DIR）；
 * - ACC_WORKSPACE：agent 的預設工作區（預設為 INIT_CWD，再預設為程序當前目錄）。
 */

export const APP_DIR_NAME = 'agent-control-center';
export const DB_FILE_NAME = 'agent-control.db';

export interface ControlPlanePaths {
  /** 資料目錄。 */
  dataDir: string;
  /** SQLite 資料庫檔案。 */
  dbPath: string;
  /** 單實例鎖檔案（資料庫旁）。 */
  lockPath: string;
  /** 可讀事件日誌目錄（events.log）。 */
  logDir: string;
  /** agent 的預設工作區。 */
  workspace: string;
  /** 舊版本的預設資料庫位置（INIT_CWD/agent-control.db），用於一次性遷移。 */
  legacyDbPath: string;
  /** 資料庫路徑是否由 ACC_DB_PATH 顯式指定（顯式指定時不做自動遷移）。 */
  dbPathExplicit: boolean;
}

export interface ResolvePathsInput {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homedir: string;
  /** 程序當前目錄（INIT_CWD 預設時的回退，也是相對路徑的基準）。 */
  cwd: string;
}

/** 按平台選擇路徑語義，便於在任意平台上測試其他平台的預設目錄。 */
function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** 平台預設的使用者資料根目錄（不含應用子目錄）。 */
export function userDataRoot(env: Record<string, string | undefined>, platform: NodeJS.Platform, homedir: string): string {
  const p = pathApi(platform);
  if (platform === 'win32') return env.LOCALAPPDATA || p.join(homedir, 'AppData', 'Local');
  if (platform === 'darwin') return p.join(homedir, 'Library', 'Application Support');
  return env.XDG_DATA_HOME || p.join(homedir, '.local', 'share');
}

export function resolveControlPlanePaths(input: ResolvePathsInput): ControlPlanePaths {
  const platform = input.platform ?? process.platform;
  const p = pathApi(platform);
  const { env, cwd } = input;
  const resolve = (value: string) => p.resolve(cwd, value);
  const dataDir = env.ACC_DATA_DIR ? resolve(env.ACC_DATA_DIR) : p.join(userDataRoot(env, platform, input.homedir), APP_DIR_NAME);
  const dbPath = env.ACC_DB_PATH ? resolve(env.ACC_DB_PATH) : p.join(dataDir, DB_FILE_NAME);
  return {
    dataDir,
    dbPath,
    lockPath: `${dbPath}.lock`,
    logDir: env.ACC_LOG_DIR ? resolve(env.ACC_LOG_DIR) : p.join(dataDir, 'logs'),
    workspace: resolve(env.ACC_WORKSPACE || env.INIT_CWD || cwd),
    legacyDbPath: p.join(resolve(env.INIT_CWD || cwd), DB_FILE_NAME),
    dbPathExplicit: Boolean(env.ACC_DB_PATH),
  };
}

/**
 * 規範化到可比較的形式：對最近的已存在祖先目錄做 realpath（解開符號連結/目錄聯接、統一大小寫），再拼回尚不存在的部分。
 * Windows 與 macOS 的檔案系統預設不區分大小寫：按不區分大小寫比較（對安全檢查而言寧可多攔）。
 */
function canonical(target: string, platform: NodeJS.Platform): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync.native(current);
  } catch {
    // 無法解析時按原樣比較
  }
  const full = path.join(real, ...rest);
  return platform === 'win32' || platform === 'darwin' ? full.toLowerCase() : full;
}

/** child 是否就是 parent 或位於 parent 之內（按真實檔案系統路徑判斷）。 */
export function isPathInside(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const rel = path.relative(canonical(parent, platform), canonical(child, platform));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** 列出落在 dir 之內的控制面資料路徑（資料庫、日誌目錄）。 */
export function controlDataInside(paths: ControlPlanePaths, dir: string, options: { includeDb: boolean }): string[] {
  const candidates = options.includeDb ? [paths.dbPath, paths.logDir] : [paths.logDir];
  return candidates.filter((item) => isPathInside(item, dir));
}
