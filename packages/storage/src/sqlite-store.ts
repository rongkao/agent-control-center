import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { loadRunSnapshot, serializeRunSnapshot, unwrapRunLoad } from '@acc/core';
import type {
  ApprovalRecord,
  ControlPlaneStore,
  RunLoadResult,
  RunSnapshot,
  SessionOwnerRecord,
  StoreCommit,
  TaskRecord,
  TaskStatus,
  UnifiedEvent,
  UsageRecord,
} from '@acc/core';

/**
 * SQLite 持久化儲存（docs/DATABASE.md）。使用 Node 內建 node:sqlite，無原生依賴。
 *
 * 關鍵保證：
 * - commit() 在單個事務中完成“追加事件 + 更新任務/快照/會話/審批/用量”，失敗整體回滾；
 * - 事件只追加，(run_id, sequence) 唯一；
 * - 快照以 JSON 儲存並帶 schema_version 列，讀取時遷移/校驗，未知更高版本 fail closed；
 * - agent_sessions 表由快照中的 agentSessions 派生，儲存 provider 會話 ID 與歸屬實例。
 */

/** 資料庫結構版本（PRAGMA user_version），與 RunSnapshot schema 版本相互獨立。 */
export const SQLITE_DB_SCHEMA_VERSION = 3;

const TERMINAL_STATUSES: TaskStatus[] = ['FAILED', 'CANCELLED', 'COMPLETED'];

const DB_MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      workflow TEXT NOT NULL,
      run_id TEXT NOT NULL,
      current_agent_id TEXT,
      current_action TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_updated ON tasks(updated_at);
    CREATE TABLE run_snapshots (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      current_step TEXT NOT NULL,
      current_agent_id TEXT,
      snapshot_json TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_run_snapshots_status ON run_snapshots(status);
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      provider_session_id TEXT,
      owner_instance_id TEXT,
      status TEXT NOT NULL,
      metadata_json TEXT,
      UNIQUE (run_id, agent_id)
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      confidence TEXT NOT NULL,
      agent_id TEXT,
      session_id TEXT,
      data_json TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      provider_call_id TEXT,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      decision_json TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX idx_approvals_run ON approvals(run_id);
    CREATE TABLE usage (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      agent_id TEXT,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      duration_ms INTEGER,
      provider_reported INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_usage_run ON usage(run_id);
  `,
  // v2：會話歸屬查詢（P1.3）
  2: `
    CREATE INDEX idx_agent_sessions_provider ON agent_sessions(provider_session_id);
  `,
  // v3：每一輪的美元花費和寫入快取的 token（P1-7）
  3: `
    ALTER TABLE usage ADD COLUMN cost_usd REAL;
    ALTER TABLE usage ADD COLUMN cache_write_tokens INTEGER;
  `,
};

type Row = Record<string, SQLInputValue>;

/** node:sqlite 不接受 undefined，統一轉成 NULL。 */
const n = (value: unknown): SQLInputValue => (value === undefined ? null : (value as SQLInputValue));
const optStr = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : String(value));
const optNum = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));

export interface SqliteStoreOptions {
  /** 資料庫檔案路徑，或 ':memory:'。 */
  path: string;
  /** WAL 檔案的大小上限（位元組，P1-12）；checkpoint 之後超過就截斷。預設 64 MiB。 */
  journalSizeLimit?: number;
}

/** WAL 檔案預設的大小上限：64 MiB。 */
export const DEFAULT_JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024;

export class SqliteControlPlaneStore implements ControlPlaneStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteStoreOptions) {
    this.path = options.path;
    this.db = new DatabaseSync(options.path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // synchronous=FULL（P1-12 / L-7）：WAL + NORMAL 在斷電時可能丟掉最後幾次提交，而“副作用之前的柵欄提交”丟了就可能讓命令被執行兩次；
    // 本專案每秒的提交次數很少，FULL 的代價可以接受
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`PRAGMA journal_size_limit = ${Math.max(0, Math.floor(options.journalSizeLimit ?? DEFAULT_JOURNAL_SIZE_LIMIT))};`);
    this.migrate();
  }

  private readonly path: string;

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    const current = Number(row.user_version);
    if (current > SQLITE_DB_SCHEMA_VERSION) {
      // 資料庫來自更新版本的程式：fail closed，不做任何寫入
      throw new Error(`Database schema version ${current} is newer than supported ${SQLITE_DB_SCHEMA_VERSION}`);
    }
    if (current === SQLITE_DB_SCHEMA_VERSION) return;
    // 升級前先備份（P1-12）：已有資料的庫（不是新建的空庫）用 VACUUM INTO 複製一份，升級失敗時原始資料還在
    if (current > 0 && this.path !== ':memory:') {
      const backup = `${this.path}.before-v${SQLITE_DB_SCHEMA_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      this.migrationBackup = backup;
    }
    for (let v = current + 1; v <= SQLITE_DB_SCHEMA_VERSION; v++) {
      const sql = DB_MIGRATIONS[v];
      if (!sql) throw new Error(`Missing database migration v${v}`);
      try {
        this.transaction(() => {
          this.db.exec(sql);
          this.db.exec(`PRAGMA user_version = ${v}`);
        });
      } catch (error) {
        const where = this.migrationBackup ? `升級前的備份在 ${this.migrationBackup}。` : '';
        throw new Error(`資料庫從 v${v - 1} 升級到 v${v} 失敗：${(error as Error).message}。${where}`, { cause: error });
      }
    }
  }

  /** 這次啟動做了資料庫升級時，升級前備份的路徑（P1-12）。 */
  migrationBackup?: string;

  /** 把 WAL 的內容寫回主庫並按 journal_size_limit 截斷（P1-12；服務端定期呼叫）。 */
  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  /**
   * 刪除一個任務的全部資料（P1-12）：任務、事件、快照、審批、用量、會話歸屬。呼叫方負責只刪已經結束的任務。
   * 返回是否確實刪掉了。
   */
  async deleteTask(taskId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT run_id FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!row) return false;
    const runId = String(row.run_id);
    this.transaction(() => {
      for (const table of ['events', 'approvals', 'usage', 'agent_sessions', 'run_snapshots']) {
        this.db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(runId);
      }
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    });
    return true;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // ROLLBACK 本身也可能失敗（例如事務已經被 SQLite 自動回滾）：保留原始錯誤，不讓它被回滾的錯誤掩蓋
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略
      }
      throw error;
    }
  }

  async listTasks(): Promise<TaskRecord[]> {
    const rows = this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as Row[];
    return rows.map(rowToTask);
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  async upsertTask(task: TaskRecord): Promise<void> {
    await this.commit({ task });
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    return unwrapRunLoad(await this.loadRun(runId));
  }

  async loadRun(runId: string): Promise<RunLoadResult | undefined> {
    const row = this.db.prepare('SELECT run_id, task_id, snapshot_json FROM run_snapshots WHERE run_id = ?').get(runId) as Row | undefined;
    return row ? rowToLoadResult(row) : undefined;
  }

  async listRecoverableRuns(): Promise<RunLoadResult[]> {
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT run_id, task_id, snapshot_json FROM run_snapshots WHERE status NOT IN (${placeholders}) ORDER BY updated_at ASC`)
      .all(...TERMINAL_STATUSES) as Row[];
    return rows.map(rowToLoadResult);
  }

  async upsertRun(snapshot: RunSnapshot): Promise<void> {
    await this.commit({ run: snapshot });
  }

  async appendEvent(event: UnifiedEvent): Promise<void> {
    await this.commit({ event });
  }

  async listEvents(runId: string, afterSequence = 0): Promise<UnifiedEvent[]> {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC')
      .all(runId, afterSequence) as Row[];
    return rows.map(rowToEvent);
  }

  async getLastSequence(runId: string): Promise<number> {
    const row = this.db.prepare('SELECT MAX(sequence) AS seq FROM events WHERE run_id = ?').get(runId) as Row | undefined;
    return Number(row?.seq ?? 0);
  }

  async commit(unit: StoreCommit): Promise<void> {
    // 序列化放在事務外：非法快照（例如舊程式試圖寫入未知版本）在寫任何資料之前就失敗
    const runJson = unit.run ? serializeRunSnapshot(unit.run) : undefined;

    this.transaction(() => {
      if (unit.event) this.insertEvent(unit.event);
      if (unit.task) this.writeTask(unit.task);
      if (unit.run && runJson) this.writeRun(unit.run, runJson);
      for (const approval of unit.approvals ?? []) this.writeApproval(approval);
      for (const usage of unit.usage ?? []) this.writeUsage(usage);
    });
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Row | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  async listApprovals(runId: string): Promise<ApprovalRecord[]> {
    const rows = this.db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[];
    return rows.map(rowToApproval);
  }

  async listUsage(runId: string): Promise<UsageRecord[]> {
    const rows = this.db.prepare('SELECT * FROM usage WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[];
    return rows.map(rowToUsage);
  }

  async findSessionsByProviderId(providerSessionId: string): Promise<SessionOwnerRecord[]> {
    const rows = this.db.prepare('SELECT * FROM agent_sessions WHERE provider_session_id = ?').all(providerSessionId) as Row[];
    return rows.map((row) => ({
      runId: String(row.run_id),
      agentId: String(row.agent_id),
      adapterType: String(row.adapter_type),
      providerSessionId,
      ownerInstanceId: optStr(row.owner_instance_id),
    }));
  }

  /** 列出會話歸屬記錄（供會話歸屬登錄檔/診斷使用）。 */
  listAgentSessions(runId: string): Array<{ agentId: string; providerSessionId?: string; ownerInstanceId?: string; status: string }> {
    const rows = this.db.prepare('SELECT * FROM agent_sessions WHERE run_id = ?').all(runId) as Row[];
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      providerSessionId: optStr(row.provider_session_id),
      ownerInstanceId: optStr(row.owner_instance_id),
      status: String(row.status),
    }));
  }

  /** 僅測試/運維用：直接寫入原始快照 JSON（模擬未來版本或損壞資料）。 */
  putRawRun(row: { runId: string; taskId: string; status: string; schemaVersion: number; json: string }): void {
    this.db
      .prepare(
        `INSERT INTO run_snapshots (run_id, task_id, schema_version, status, current_step, current_agent_id, snapshot_json, last_sequence, updated_at)
         VALUES (?, ?, ?, ?, 'raw', NULL, ?, 0, ?)
         ON CONFLICT(run_id) DO UPDATE SET schema_version = excluded.schema_version, status = excluded.status, snapshot_json = excluded.snapshot_json`,
      )
      .run(row.runId, row.taskId, row.schemaVersion, row.status, row.json, Date.now());
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private insertEvent(event: UnifiedEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (id, project_id, task_id, run_id, sequence, timestamp, type, severity, confidence, agent_id, session_id, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.projectId,
        event.taskId,
        event.runId,
        event.sequence,
        event.timestamp,
        event.type,
        event.severity,
        event.confidence,
        n(event.agentId),
        n(event.sessionId),
        JSON.stringify(event.data ?? {}),
      );
  }

  private writeTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, prompt, status, workflow, run_id, current_agent_id, current_action, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, title = excluded.title, prompt = excluded.prompt, status = excluded.status,
           workflow = excluded.workflow, run_id = excluded.run_id, current_agent_id = excluded.current_agent_id,
           current_action = excluded.current_action, updated_at = excluded.updated_at`,
      )
      .run(
        task.id,
        task.projectId,
        task.title,
        task.prompt,
        task.status,
        task.workflow,
        task.runId,
        n(task.currentAgentId),
        n(task.currentAction),
        task.createdAt,
        task.updatedAt,
      );
  }

  private writeRun(run: RunSnapshot, json: string): void {
    this.db
      .prepare(
        `INSERT INTO run_snapshots (run_id, task_id, schema_version, status, current_step, current_agent_id, snapshot_json, last_sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           task_id = excluded.task_id, schema_version = excluded.schema_version, status = excluded.status,
           current_step = excluded.current_step, current_agent_id = excluded.current_agent_id,
           snapshot_json = excluded.snapshot_json, last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`,
      )
      .run(run.runId, run.taskId, run.schemaVersion, run.status, run.currentStep, n(run.currentAgentId), json, run.lastSequence, run.updatedAt);

    const upsertSession = this.db.prepare(
      `INSERT INTO agent_sessions (id, run_id, agent_id, adapter_type, provider_session_id, owner_instance_id, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         adapter_type = excluded.adapter_type, provider_session_id = excluded.provider_session_id,
         owner_instance_id = excluded.owner_instance_id, status = excluded.status, metadata_json = excluded.metadata_json`,
    );
    for (const session of Object.values(run.agentSessions)) {
      upsertSession.run(
        `${run.runId}:${session.agentId}`,
        run.runId,
        session.agentId,
        session.adapterType,
        n(session.providerSessionId),
        n(session.ownerInstanceId),
        session.status,
        session.metadata ? JSON.stringify(session.metadata) : null,
      );
    }
  }

  private writeApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, task_id, agent_id, session_id, provider_call_id, status, request_json, decision_json, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, decision_json = excluded.decision_json, resolved_at = excluded.resolved_at`,
      )
      .run(
        approval.id,
        approval.runId,
        approval.taskId,
        approval.agentId,
        n(approval.sessionId),
        n(approval.providerCallId),
        approval.status,
        JSON.stringify(approval.request),
        approval.decision ? JSON.stringify(approval.decision) : null,
        approval.createdAt,
        n(approval.resolvedAt),
      );
  }

  private writeUsage(usage: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, run_id, agent_id, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cost_usd, duration_ms, provider_reported, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        usage.id,
        usage.runId,
        n(usage.agentId),
        n(usage.model),
        n(usage.inputTokens),
        n(usage.outputTokens),
        n(usage.cachedTokens),
        n(usage.cacheWriteTokens),
        n(usage.costUsd),
        n(usage.durationMs),
        usage.providerReported ? 1 : 0,
        usage.createdAt,
      );
  }
}

function rowToLoadResult(row: Row): RunLoadResult {
  return loadRunSnapshot(String(row.snapshot_json), { runId: String(row.run_id), taskId: String(row.task_id) });
}

function rowToTask(row: Row): TaskRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    prompt: String(row.prompt),
    status: String(row.status) as TaskStatus,
    workflow: String(row.workflow),
    runId: String(row.run_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    currentAgentId: optStr(row.current_agent_id),
    currentAction: optStr(row.current_action),
  };
}

function rowToEvent(row: Row): UnifiedEvent {
  const event: UnifiedEvent = {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    type: String(row.type) as UnifiedEvent['type'],
    severity: String(row.severity) as UnifiedEvent['severity'],
    confidence: String(row.confidence) as UnifiedEvent['confidence'],
    timestamp: Number(row.timestamp),
    sequence: Number(row.sequence),
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
  };
  const agentId = optStr(row.agent_id);
  const sessionId = optStr(row.session_id);
  if (agentId) event.agentId = agentId;
  if (sessionId) event.sessionId = sessionId;
  return event;
}

function rowToApproval(row: Row): ApprovalRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    sessionId: optStr(row.session_id),
    providerCallId: optStr(row.provider_call_id),
    status: String(row.status) as ApprovalRecord['status'],
    request: JSON.parse(String(row.request_json)) as Record<string, unknown>,
    decision: row.decision_json ? (JSON.parse(String(row.decision_json)) as Record<string, unknown>) : undefined,
    createdAt: Number(row.created_at),
    resolvedAt: optNum(row.resolved_at),
  };
}

function rowToUsage(row: Row): UsageRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    agentId: optStr(row.agent_id),
    model: optStr(row.model),
    inputTokens: optNum(row.input_tokens),
    outputTokens: optNum(row.output_tokens),
    cachedTokens: optNum(row.cached_tokens),
    cacheWriteTokens: optNum(row.cache_write_tokens),
    costUsd: optNum(row.cost_usd),
    durationMs: optNum(row.duration_ms),
    providerReported: Number(row.provider_reported) === 1,
    createdAt: Number(row.created_at),
  };
}
