import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/**
 * 單實例鎖 / 實例租約（P0-3 / H-3）。
 *
 * 實現：資料庫旁放一個很小的 SQLite 檔案 `<db>.lock`，裡面只有一張 instance_lease 表
 * （instance_id, pid, hostname, started_at, heartbeat_at）。
 * - 獲取：`PRAGMA locking_mode = EXCLUSIVE` + `BEGIN EXCLUSIVE` 搶佔，寫入本實例的租約後提交。
 *   排他鎖模式下提交之後仍然持有作業系統級的檔案鎖（Windows 為 LockFileEx，POSIX 為 fcntl），直到連線關閉。
 * - 第二個實例搶佔時得到 SQLITE_BUSY → 在寫入任何控制面資料之前拒絕啟動。
 * - 持有者被強殺或斷電：作業系統隨程序一起釋放檔案鎖，租約記錄殘留在檔案裡 →
 *   新實例能搶到鎖，把殘留記錄作為“上一任”報告出來（心跳時間、程序是否還在），再覆蓋成自己的。
 * - 不靠 pid / 心跳推斷對方是否存活：pid 會被複用，休眠喚醒後心跳也會“過期”，都可能誤判；作業系統鎖不會。
 *   因此“原租約已失效”由作業系統鎖來確認，心跳只用於診斷和自檢（發現租約丟失時讓服務 fail-safe 停止）。
 * - 釋放：刪除租約記錄後關閉連線。鎖檔案本身保留——刪除鎖檔案會引入“刪掉別人剛剛開啟的鎖檔案”的競態。
 *
 * 另有一個僅供提示用的 `<db>.lock.json`（持有者 pid、地址等），讓被拒絕的第二個實例能告訴使用者去哪裡找已在執行的那個；
 * 它不參與互斥判斷。
 */

export type InstanceLockErrorCode = 'ACC_ALREADY_RUNNING' | 'ACC_LOCK_FILE_BUSY' | 'ACC_LOCK_FAILED' | 'ACC_LEASE_LOST';

/** 租約持有者資訊（寫在租約表和提示檔案裡）。 */
export interface InstanceLeaseInfo {
  instanceId: string;
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
  /** 服務地址（監聽成功後寫入提示檔案）。 */
  url?: string;
}

/** 接管時發現的上一份租約（上一個實例沒有正常退出：強殺、崩潰或斷電）。 */
export interface PreviousLease extends InstanceLeaseInfo {
  /** 心跳是否早已過期（超過 staleAfterMs）。 */
  heartbeatExpired: boolean;
  /** 原持有程序是否還存在（不同主機時無法判斷，為 undefined）。僅供診斷：互斥以作業系統鎖為準。 */
  processAlive: boolean | undefined;
}

export class InstanceLockError extends Error {
  override readonly name = 'InstanceLockError';

  constructor(
    readonly code: InstanceLockErrorCode,
    message: string,
    readonly lockPath: string,
    readonly holder?: Partial<InstanceLeaseInfo>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface InstanceLockOptions {
  /** 鎖檔案路徑（通常是 `<資料庫路徑>.lock`）。所在目錄必須已存在。 */
  lockPath: string;
  /** 本實例 ID（預設隨機生成）；編排器用同一個 ID 標記會話歸屬。 */
  instanceId?: string;
  /** 寫入租約的程序號（預設 process.pid；測試用來偽造殘留租約）。 */
  pid?: number;
  /** 可注入時鐘。 */
  now?: () => number;
  /** 自動心跳間隔，預設 10 秒；0 表示不自動心跳（測試裡手動呼叫 heartbeat()）。 */
  heartbeatMs?: number;
  /** 心跳超過多久算“過期”（隻影響診斷報告），預設 max(3 × 心跳間隔, 30 秒)。 */
  staleAfterMs?: number;
  /** 鎖被佔用時的重試次數，預設 4（給正在退出的舊程序一點時間釋放控制代碼）。 */
  retries?: number;
  /** 每次重試前的等待時間，預設 500 毫秒。 */
  retryDelayMs?: number;
  /** 等待函式（可注入，測試裡不真的等）。 */
  wait?: (ms: number) => Promise<void>;
  /** 判斷程序是否存在（可注入）。 */
  isProcessAlive?: (pid: number) => boolean;
  /** 租約丟失時回呼（只呼叫一次）。持有者應立即停止寫入。 */
  onLost?: (error: InstanceLockError) => void;
  /** 開啟鎖資料庫（測試接縫：可以拿到底層連線來模擬斷電或控制代碼被佔用）。 */
  openDatabase?: (path: string) => DatabaseSync;
}

export interface InstanceLock {
  readonly instanceId: string;
  readonly lockPath: string;
  /** 本實例當前的租約資訊（心跳成功後更新 heartbeatAt）。 */
  readonly info: InstanceLeaseInfo;
  /** 接管的上一份殘留租約；上一個實例正常退出（或第一次啟動）時為 undefined。 */
  readonly previous?: PreviousLease;
  /** 手動心跳：成功返回 true；發現租約丟失返回 false（並觸發一次 onLost）。 */
  heartbeat(): boolean;
  /** 是否仍持有租約。 */
  isHeld(): boolean;
  /** 更新提示檔案裡的持有者資訊（例如監聽成功後的地址）。 */
  setOwnerInfo(extra: { url?: string }): void;
  /** 正常釋放：刪除租約記錄並關閉連線。可重複呼叫。 */
  release(): void;
}

const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 500;

const LEASE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS instance_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    instance_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    hostname TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
  )`;

type Failure = 'held' | 'busy' | 'corrupt' | 'other';

/** 持有者提示檔案路徑（僅用於報錯資訊）。 */
export function ownerInfoPath(lockPath: string): string {
  return `${lockPath}.json`;
}

/** 讀取持有者提示資訊（盡力而為，讀不到返回 undefined）。 */
export function readOwnerInfo(lockPath: string): Partial<InstanceLeaseInfo> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(ownerInfoPath(lockPath), 'utf8')) as Partial<InstanceLeaseInfo>;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：程序存在，只是沒有權限發訊號
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 把底層錯誤歸類：被另一個實例持有 / 檔案控制代碼被佔用 / 鎖檔案損壞 / 其他。 */
function classify(error: unknown, lockPath: string): Failure {
  const e = error as { code?: string; errcode?: number; message?: string };
  const primary = typeof e?.errcode === 'number' ? e.errcode & 0xff : undefined;
  // SQLITE_BUSY(5) / SQLITE_LOCKED(6)：另一個連線持有排他鎖
  if (primary === 5 || primary === 6) return 'held';
  // SQLITE_NOTADB(26) / SQLITE_CORRUPT(11)：殘留的鎖檔案內容損壞（例如斷電時寫了一半）
  if (primary === 26 || primary === 11) return 'corrupt';
  // Windows：檔案被其他程序以不共享的方式開啟時，SQLite 報 SQLITE_CANTOPEN(14)，fs 報 EBUSY/EPERM/EACCES
  if (primary === 14 && existsSync(lockPath)) return 'busy';
  if (e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES') return 'busy';
  return 'other';
}

function describeHolder(holder: Partial<InstanceLeaseInfo> | undefined): string {
  if (!holder) return '';
  const parts: string[] = [];
  if (holder.pid) parts.push(`程序 ${holder.pid}`);
  if (holder.url) parts.push(`地址 ${holder.url}`);
  if (holder.startedAt) parts.push(`啟動於 ${new Date(holder.startedAt).toLocaleString('zh-CN', { hour12: false })}`);
  return parts.length ? `（${parts.join('，')}）` : '';
}

function alreadyRunning(lockPath: string, cause: unknown): InstanceLockError {
  const holder = readOwnerInfo(lockPath);
  const where = holder?.url ? `請直接在瀏覽器開啟 ${holder.url} 使用已經在執行的那個；` : '請直接使用已經在執行的那個；';
  return new InstanceLockError(
    'ACC_ALREADY_RUNNING',
    `已有一個 Agent Control Center 在執行${describeHolder(holder)}，它正在使用同一份資料（鎖檔案 ${lockPath}）。\n` +
      `${where}如果要重新啟動，請先關閉它；如果它剛剛關閉，請等幾秒再啟動。`,
    lockPath,
    holder,
    { cause },
  );
}

function fileBusy(lockPath: string, cause: unknown): InstanceLockError {
  const code = (cause as { code?: string })?.code;
  const detail = code && code !== 'ERR_SQLITE_ERROR' ? code : ((cause as { errstr?: string })?.errstr ?? String((cause as Error)?.message ?? cause));
  return new InstanceLockError(
    'ACC_LOCK_FILE_BUSY',
    `無法獲取單實例鎖：鎖檔案 ${lockPath} 正被其他程式佔用（${detail}），無法確認是否已有實例在執行。\n` +
      '可能是舊的 Agent Control Center 程序還沒有完全退出，或者防毒/備份軟體正在掃描這個檔案。' +
      '請等幾秒再啟動；如果一直失敗，請在工作管理員中結束殘留的 node.exe（或重啟電腦）後再試。',
    lockPath,
    readOwnerInfo(lockPath),
    { cause },
  );
}

/** 殘留鎖檔案損壞：挪到一邊（只有沒人持有鎖時才會讀到損壞內容），下一次嘗試重新建立。 */
function quarantine(lockPath: string, now: number): void {
  renameSync(lockPath, `${lockPath}.corrupt-${now}`);
}

/**
 * 先用普通的檔案開啟探測一次：鎖檔案被其他程式以不共享的方式佔用時（Windows 上舊程序尚未完全退出、防毒軟體掃描等）
 * 立即得到 EBUSY/EPERM。直接交給 SQLite 的話，它的 Windows VFS 會先內部重試一秒多才報 SQLITE_CANTOPEN。
 * 正常持有租約的實例（SQLite 連線）允許共享開啟，不影響這次探測。
 */
function probeFileHandle(lockPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fileIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

/**
 * 獲取實例租約。成功返回持有中的鎖；失敗丟擲 InstanceLockError：
 * - ACC_ALREADY_RUNNING：另一個實例正持有租約；
 * - ACC_LOCK_FILE_BUSY：鎖檔案被其他程式的控制代碼佔用（Windows 上舊程序尚未完全退出等）；
 * - ACC_LOCK_FAILED：其他錯誤（目錄不可寫等）。
 * 被佔用時按 retries / retryDelayMs 有限重試。
 */
export async function acquireInstanceLock(options: InstanceLockOptions): Promise<InstanceLock> {
  const lockPath = options.lockPath;
  const now = options.now ?? Date.now;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const wait = options.wait ?? defaultWait;
  const open = options.openDatabase ?? ((path: string) => new DatabaseSync(path, { timeout: 0 }));

  let lastError: InstanceLockError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await wait(retryDelayMs);
    try {
      return tryAcquire(options, open, now);
    } catch (error) {
      const kind = classify(error, lockPath);
      if (kind === 'held') {
        lastError = alreadyRunning(lockPath, error);
      } else if (kind === 'busy') {
        lastError = fileBusy(lockPath, error);
      } else if (kind === 'corrupt') {
        try {
          quarantine(lockPath, now());
          lastError = new InstanceLockError('ACC_LOCK_FAILED', `鎖檔案 ${lockPath} 已損壞，已移到一邊重建`, lockPath, undefined, { cause: error });
        } catch (renameError) {
          lastError = classify(renameError, lockPath) === 'busy' ? fileBusy(lockPath, renameError) : undefined;
          if (!lastError) throw lockFailed(lockPath, renameError);
        }
      } else {
        throw lockFailed(lockPath, error);
      }
    }
  }
  throw lastError!;
}

function lockFailed(lockPath: string, cause: unknown): InstanceLockError {
  return new InstanceLockError('ACC_LOCK_FAILED', `無法獲取單實例鎖（${lockPath}）：${(cause as Error)?.message ?? String(cause)}`, lockPath, undefined, {
    cause,
  });
}

function tryAcquire(options: InstanceLockOptions, open: (path: string) => DatabaseSync, now: () => number): InstanceLock {
  const lockPath = options.lockPath;
  probeFileHandle(lockPath);
  const db = open(lockPath);
  let previousRow: Record<string, unknown> | undefined;
  const startedAt = now();
  const info: InstanceLeaseInfo = {
    instanceId: options.instanceId ?? randomUUID(),
    pid: options.pid ?? process.pid,
    hostname: osHostname(),
    startedAt,
    heartbeatAt: startedAt,
  };
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // 搶佔：另一個實例持有時這裡立即得到 SQLITE_BUSY（timeout 為 0，不排隊等待）
    db.exec('BEGIN EXCLUSIVE');
    db.exec(LEASE_TABLE_SQL);
    previousRow = db.prepare('SELECT instance_id, pid, hostname, started_at, heartbeat_at FROM instance_lease WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    db.prepare('INSERT OR REPLACE INTO instance_lease (id, instance_id, pid, hostname, started_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?)').run(
      info.instanceId,
      info.pid,
      info.hostname,
      info.startedAt,
      info.heartbeatAt,
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 沒有進行中的事務
    }
    try {
      db.close();
    } catch {
      // 忽略
    }
    throw error;
  }
  return new HeldInstanceLock(options, db, info, previousRow, now);
}

class HeldInstanceLock implements InstanceLock {
  readonly instanceId: string;
  readonly lockPath: string;
  readonly info: InstanceLeaseInfo;
  readonly previous?: PreviousLease;
  private held = true;
  private lostNotified = false;
  private readonly identity: string | undefined;
  private readonly timer?: NodeJS.Timeout;
  private ownerExtra: { url?: string } = {};

  constructor(
    private readonly options: InstanceLockOptions,
    private readonly db: DatabaseSync,
    info: InstanceLeaseInfo,
    previousRow: Record<string, unknown> | undefined,
    private readonly now: () => number,
  ) {
    this.instanceId = info.instanceId;
    this.lockPath = options.lockPath;
    this.info = info;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (previousRow) {
      const staleAfterMs = options.staleAfterMs ?? Math.max(3 * (heartbeatMs || DEFAULT_HEARTBEAT_MS), 30_000);
      const previous = {
        instanceId: String(previousRow.instance_id),
        pid: Number(previousRow.pid),
        hostname: String(previousRow.hostname),
        startedAt: Number(previousRow.started_at),
        heartbeatAt: Number(previousRow.heartbeat_at),
      };
      const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
      this.previous = {
        ...previous,
        heartbeatExpired: info.startedAt - previous.heartbeatAt > staleAfterMs,
        processAlive: previous.hostname === info.hostname ? isAlive(previous.pid) : undefined,
      };
    }
    try {
      this.identity = fileIdentity(this.lockPath);
    } catch {
      this.identity = undefined;
    }
    this.writeOwnerInfo();
    if (heartbeatMs > 0) {
      this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
      this.timer.unref();
    }
  }

  heartbeat(): boolean {
    if (!this.held) return false;
    try {
      const at = this.now();
      const result = this.db.prepare('UPDATE instance_lease SET heartbeat_at = ? WHERE id = 1 AND instance_id = ?').run(at, this.instanceId);
      if (Number(result.changes) !== 1) throw new Error('租約記錄已不屬於本實例');
      // POSIX 上鎖檔案可以在持有期間被刪除或替換：那樣別的實例就能在新檔案上拿到鎖
      if (this.identity !== undefined && fileIdentity(this.lockPath) !== this.identity) throw new Error('鎖檔案已被刪除或替換');
      this.info.heartbeatAt = at;
      return true;
    } catch (error) {
      this.markLost(error);
      return false;
    }
  }

  isHeld(): boolean {
    return this.held;
  }

  setOwnerInfo(extra: { url?: string }): void {
    this.ownerExtra = { ...this.ownerExtra, ...extra };
    if (this.held) this.writeOwnerInfo();
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    if (!this.held) return;
    this.held = false;
    try {
      // 正常退出不留殘留租約：下一個實例據此區分“正常退出”和“強殺/斷電”
      this.db.prepare('DELETE FROM instance_lease WHERE id = 1 AND instance_id = ?').run(this.instanceId);
    } catch {
      // 刪除失敗不影響釋放：關閉連線後作業系統鎖即釋放
    }
    this.closeDb();
    this.removeOwnerInfo();
  }

  private markLost(cause: unknown): void {
    if (this.timer) clearInterval(this.timer);
    this.held = false;
    this.closeDb();
    if (this.lostNotified) return;
    this.lostNotified = true;
    const reason = (cause as Error)?.message ?? String(cause);
    const error = new InstanceLockError(
      'ACC_LEASE_LOST',
      `單實例租約已丟失（${this.lockPath}）：${reason}。為避免兩個實例同時寫同一份資料，本實例必須立即停止。`,
      this.lockPath,
      this.info,
      { cause },
    );
    try {
      this.options.onLost?.(error);
    } catch {
      // 回呼異常不能影響 fail-safe 流程
    }
  }

  private closeDb(): void {
    try {
      if (this.db.isOpen) this.db.close();
    } catch {
      // 忽略
    }
  }

  private writeOwnerInfo(): void {
    try {
      writeFileSync(ownerInfoPath(this.lockPath), JSON.stringify({ ...this.info, ...this.ownerExtra }, null, 2), 'utf8');
    } catch {
      // 提示檔案只是輔助資訊，寫不了不影響互斥
    }
  }

  private removeOwnerInfo(): void {
    try {
      if (readOwnerInfo(this.lockPath)?.instanceId === this.instanceId) rmSync(ownerInfoPath(this.lockPath), { force: true });
    } catch {
      // 忽略
    }
  }
}
