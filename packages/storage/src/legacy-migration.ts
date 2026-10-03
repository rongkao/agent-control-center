import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 舊位置資料庫的一次性遷移（P0-10 / H-16）。
 *
 * 舊版本把資料庫放在 INIT_CWD（也就是 agent 的預設工作區）裡；新版本預設放到使用者資料目錄。
 * 舊位置有庫、新位置沒有時，必須把資料帶過去——絕不能靜默新建一個空庫，讓使用者以為歷史丟了。
 *
 * 步驟（呼叫方需已持有新位置的單實例鎖）：
 * 1. 用 `VACUUM INTO` 從舊庫匯出一份一致的副本到臨時檔案：它透過 SQLite 讀取，-wal 裡尚未合併的資料會一併帶上；
 * 2. 校驗副本（integrity_check、各錶行數、user_version 與舊庫一致）；
 * 3. 臨時檔案原子改名為新庫；
 * 4. 舊庫連同 -wal/-shm/-journal 改名為 `*.bak-時間戳` 保留備份。
 *    Windows 上舊庫仍被其他程序（例如舊版本實例）開啟時改名會失敗：此時刪除剛生成的新庫，撤銷整次遷移。
 * 5. 原地改名成功後，把備份移到資料目錄（backupDir，預設 <新庫目錄>/legacy-backups）：
 *    備份裡有完整的歷史提示詞、輸出和審批記錄，不能留在 agent 的預設工作區裡（H-16）。
 *    跨盤時先複製、校驗大小再刪除；移不走時保留在原地，並在結果裡說明（呼叫方據此告警）。
 * 1～4 任何一步失敗都丟擲 LegacyMigrationError，舊檔案保持原樣。
 */

export class LegacyMigrationError extends Error {
  override readonly name = 'LegacyMigrationError';
  readonly code = 'ACC_MIGRATION_FAILED';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export interface LegacyMigrationResult {
  from: string;
  to: string;
  /** 舊庫備份的最終位置（正常情況下在資料目錄的 legacy-backups 裡）。 */
  backupPath: string;
  /** 備份沒能移出舊庫所在目錄（仍在 agent 的工作區裡）時的原因。 */
  backupNotMoved?: string;
  tasks: number;
  runs: number;
  events: number;
}

/** 遷移留下的備份與舊日誌預設放在資料目錄下的這個子目錄裡。 */
export const LEGACY_BACKUP_DIR_NAME = 'legacy-backups';

const COUNTED_TABLES = ['tasks', 'run_snapshots', 'events', 'approvals', 'usage', 'agent_sessions'] as const;
const SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

function countRows(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    counts[table] = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  }
  counts.user_version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  return counts;
}

function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function reasonOf(error: unknown): string {
  const e = error as { errstr?: string; message?: string; code?: string };
  return e?.errstr ?? e?.message ?? String(error);
}

export function migrateLegacyDatabase(options: { from: string; to: string; backupDir?: string; now?: () => number }): LegacyMigrationResult {
  const { from, to } = options;
  const now = options.now ?? Date.now;
  const backupDir = options.backupDir ?? join(dirname(to), LEGACY_BACKUP_DIR_NAME);
  const temp = `${to}.migrating-${process.pid}`;
  rmSync(temp, { force: true });

  // 1～2：匯出並校驗
  let counts: Record<string, number>;
  try {
    // 舊庫可能正被舊版本實例寫入：給一點忙等時間
    const source = new DatabaseSync(from, { timeout: 5000 });
    try {
      counts = countRows(source);
      source.prepare('VACUUM INTO ?').run(temp);
    } finally {
      // 關閉時 SQLite 會把舊庫的 -wal 合併進主檔案（沒有其他連線時）
      source.close();
    }
    const copy = new DatabaseSync(temp);
    try {
      const integrity = (copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
      if (integrity !== 'ok') throw new Error(`副本完整性檢查失敗：${integrity}`);
      const copied = countRows(copy);
      for (const [key, value] of Object.entries(counts)) {
        if (copied[key] !== value) throw new Error(`副本與舊庫不一致：${key} 舊庫 ${value}，副本 ${copied[key]}`);
      }
    } finally {
      copy.close();
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw new LegacyMigrationError(
      `無法把舊位置的資料庫 ${from} 遷移到 ${to}：${reasonOf(error)}。\n` +
        '為避免丟失歷史資料，服務沒有啟動，也沒有新建空資料庫；舊檔案保持原樣。\n' +
        '請確認舊檔案是否完好；如需直接使用某個資料庫檔案，可以用 ACC_DB_PATH 指定它。',
      { cause: error },
    );
  }

  // 3：副本就位（同目錄內改名是原子的；中途崩潰只會留下 *.migrating-* 臨時檔案，不會出現半個新庫）
  try {
    renameSync(temp, to);
  } catch (error) {
    rmSync(temp, { force: true });
    throw new LegacyMigrationError(`無法把遷移後的資料庫寫到 ${to}：${reasonOf(error)}。服務沒有啟動，舊檔案保持原樣。`, { cause: error });
  }

  // 4：舊庫改名備份；改不了名說明舊庫還在被使用，撤銷遷移
  const backupPath = uniqueBackupPath(from, now());
  try {
    renameSync(from, backupPath);
  } catch (error) {
    rmSync(to, { force: true });
    throw new LegacyMigrationError(
      `舊位置的資料庫 ${from} 正被其他程式使用（可能還有一箇舊版本的 Agent Control Center 在執行），無法改名備份（${reasonOf(error)}）。\n` +
        '已撤銷這次遷移（沒有新建資料庫）。請先關閉舊版本，再重新啟動。',
      { cause: error },
    );
  }
  for (const suffix of SIDE_FILES) {
    if (!existsSync(`${from}${suffix}`)) continue;
    try {
      renameSync(`${from}${suffix}`, `${backupPath}${suffix}`);
    } catch {
      // 主檔案已改名，殘留的輔助檔案不會再被當成資料庫使用；忽略
    }
  }

  // 5：把備份移出 agent 的工作區（新庫已經就位，這一步失敗不影響遷移結果，隻影響備份放在哪）
  const moved = moveBackupSet(backupPath, backupDir);
  const result: LegacyMigrationResult = { from, to, backupPath: moved.path, tasks: counts.tasks ?? 0, runs: counts.run_snapshots ?? 0, events: counts.events ?? 0 };
  if (moved.error) result.backupNotMoved = moved.error;
  return result;
}

/** 舊版本在工作區裡留下、應當移到資料目錄的檔案。 */
export interface LegacyArtifactsResult {
  /** 已移到 backupDir 的檔案：原路徑 → 新路徑。 */
  moved: Array<{ from: string; to: string }>;
  /** 沒能移走（仍在工作區裡）的檔案及原因。 */
  failed: Array<{ path: string; error: string }>;
}

/** 上一版遷移留下的資料庫備份：agent-control.db.bak-YYYYMMDD-HHMMSS[-n]（主檔案）。 */
const BACKUP_NAME = /^agent-control\.db\.bak-\d{8}-\d{6}(?:-\d+)?$/;
/** 本程式寫的可讀事件日誌的行格式（見 apps/server/src/event-log.ts）：`HH:MM:SS [任務 xxxxxxxx] #  n ...`。 */
const EVENT_LOG_LINE = /^\d{1,2}:\d{2}:\d{2} \[任務 [0-9a-zA-Z-]{1,8}\] #\s*\d+ /;

/**
 * 把舊版本留在舊資料目錄（INIT_CWD，也就是 agent 的預設工作區）裡的控制面資料移到 backupDir（H-16）：
 * - 上一版遷移原地改名留下的 agent-control.db.bak-*（連同 -wal/-shm/-journal）；
 * - 舊版本預設的可讀事件日誌 logs/events.log——只有內容確實是本程式寫的格式才移動，使用者專案自己的同名檔案不碰；
 *   移走後 logs 目錄空了就一併刪除。
 * 呼叫方需已持有單實例鎖。任何單個檔案移不走都不拋錯，只記在 failed 裡（呼叫方據此告警）。
 */
export function relocateLegacyArtifacts(options: {
  legacyDir: string;
  backupDir: string;
  /** 舊的 logs/ 目錄就是當前正在使用的日誌目錄時（例如顯式指定了 ACC_LOG_DIR）不要移走它。 */
  skipEventLog?: boolean;
  now?: () => number;
}): LegacyArtifactsResult {
  const { legacyDir, backupDir } = options;
  const now = options.now ?? Date.now;
  const result: LegacyArtifactsResult = { moved: [], failed: [] };
  let names: string[] = [];
  try {
    names = readdirSync(legacyDir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    const source = join(legacyDir, name);
    const moved = moveBackupSet(source, backupDir);
    if (moved.error) result.failed.push({ path: source, error: moved.error });
    else result.moved.push({ from: source, to: moved.path });
  }

  const logDir = join(legacyDir, 'logs');
  const logFile = join(logDir, 'events.log');
  if (!options.skipEventLog && looksLikeEventLog(logFile)) {
    const target = uniquePath(join(backupDir, `events-${stamp(now())}.log`));
    const error = moveFile(logFile, target, backupDir);
    if (error) result.failed.push({ path: logFile, error });
    else {
      result.moved.push({ from: logFile, to: target });
      try {
        if (readdirSync(logDir).length === 0) rmdirSync(logDir);
      } catch {
        // 目錄刪不掉不影響結果
      }
    }
  }
  return result;
}

/** 檔案是否是本程式寫的可讀事件日誌（只看開頭幾行）。 */
function looksLikeEventLog(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    const head = readFileSync(file, 'utf8').slice(0, 4096).split(/\r?\n/).filter((line) => line.trim());
    return head.length > 0 && head.slice(0, 5).every((line) => EVENT_LOG_LINE.test(line));
  } catch {
    return false;
  }
}

/** 移動一組備份（主檔案 + -wal/-shm/-journal）到 backupDir；主檔案移不走時整組留在原地。 */
function moveBackupSet(mainPath: string, backupDir: string): { path: string; error?: string } {
  const target = uniquePath(join(backupDir, basename(mainPath)));
  const error = moveFile(mainPath, target, backupDir);
  if (error) return { path: mainPath, error };
  for (const suffix of SIDE_FILES) {
    if (existsSync(`${mainPath}${suffix}`)) moveFile(`${mainPath}${suffix}`, `${target}${suffix}`, backupDir);
  }
  return { path: target };
}

/** 移動一個檔案：同盤直接改名；跨盤（EXDEV）先複製、核對大小，再刪除原檔案。返回失敗原因。 */
function moveFile(from: string, to: string, dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    return reasonOf(error);
  }
  try {
    renameSync(from, to);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') return reasonOf(error);
  }
  try {
    copyFileSync(from, to);
    if (statSync(to).size !== statSync(from).size) throw new Error('複製後的檔案大小與原檔案不一致');
    rmSync(from);
    return undefined;
  } catch (error) {
    rmSync(to, { force: true });
    return reasonOf(error);
  }
}

function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const dot = path.lastIndexOf('.');
  const hasExt = dot > path.lastIndexOf('/') && dot > path.lastIndexOf('\\') && !/\.bak-/.test(path.slice(dot));
  for (let i = 2; ; i++) {
    const candidate = hasExt ? `${path.slice(0, dot)}-${i}${path.slice(dot)}` : `${path}-${i}`;
    if (!existsSync(candidate)) return candidate;
  }
}

function uniqueBackupPath(from: string, at: number): string {
  const base = `${from}.bak-${stamp(at)}`;
  if (!existsSync(base)) return base;
  for (let i = 2; ; i++) {
    if (!existsSync(`${base}-${i}`)) return `${base}-${i}`;
  }
}
