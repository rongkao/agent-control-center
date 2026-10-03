import type { RunLoadResult, RunSnapshot, TaskStatus } from './types.js';

/**
 * RunSnapshot 當前結構版本。
 *
 * v1：初始交接骨架。
 * v2：新增 completedSideEffects（副作用台賬）、resumeCursor（暫停點遊標）、
 *     progressSinceLastTurn（停滯檢測）、recovery（重啟恢復資訊）。
 * v3：新增 workflowState（確定性工作流狀態，可選）。
 * v4：新增 settings（任務級協作設定，可選）。
 * v5：新增 workspace（任務工作區，可選；對話任務的工作目錄在建立時就持久化）。
 *     舊版本程式不認識它，會回退到預設工作區（H-4），所以必須升版本讓舊程式 fail closed。
 *
 * P0-6 在 v5 上增加了幾個可選欄位：workflowState.lastActivityAt（看門狗計時）、workflowState.deferredSignal（等待審批期間快取的
 * 完成 / 失敗訊號）、settings.inactivityTimeoutMs（看門狗閾值）。舊程式忽略它們只是少了看門狗和訊號重放（回到修復前的行為），
 * 不會放寬任何權限或改錯目錄，所以不提升版本。
 *
 * P0-7 同樣只在 v5 上增加可選欄位：budget.activeMs / activeSince / activeCheckedAt（有效工作時長）、budget.workingAgentIds、
 * budget.window（計數視窗）、blockedBy.interruptedAgentIds。缺少它們的舊快照按“有效工作時長 0、從任務開始算一個視窗”處理
 * （升級後不會因為停機時間被立即阻塞）；舊程式讀到新快照只會回到按 startedAt 計時的舊行為（更嚴格，不放寬任何限制），所以不提升版本。
 */
export const RUN_SNAPSHOT_SCHEMA_VERSION = 5;

export type SnapshotLoadErrorCode = 'SNAPSHOT_SCHEMA_UNSUPPORTED' | 'SNAPSHOT_CORRUPTED';

export class SnapshotLoadError extends Error {
  constructor(
    readonly code: SnapshotLoadErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SnapshotLoadError';
  }
}

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'CREATED',
  'QUEUED',
  'RUNNING',
  'WAITING_INPUT',
  'WAITING_APPROVAL',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
]);

type RawSnapshot = Record<string, unknown>;

/** 遷移邊界：key 為源版本，函式把該版本的原始物件升級到 key+1 版本。只允許向前遷移。 */
const MIGRATIONS: Record<number, (raw: RawSnapshot) => RawSnapshot> = {
  1: (raw) => ({
    ...raw,
    schemaVersion: 2,
    completedSideEffects: [],
    progressSinceLastTurn: false,
  }),
  // v2 -> v3：workflowState 為可選欄位，舊 run 視為手動模式
  2: (raw) => ({ ...raw, schemaVersion: 3 }),
  // v3 -> v4：settings 可選，舊 run 使用預設策略（ask）
  3: (raw) => ({ ...raw, schemaVersion: 4 }),
  // v4 -> v5：workspace 可選；舊的對話任務仍從會話後設資料裡讀取工作目錄
  4: (raw) => ({ ...raw, schemaVersion: 5 }),
};

function isRecord(value: unknown): value is RawSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 結構校驗：只做恢復所必需欄位的檢查，任何缺失都視為損壞，不做猜測性修補。 */
function validate(raw: RawSnapshot): RunSnapshot {
  const fail = (field: string): never => {
    throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', `RunSnapshot field invalid: ${field}`, { field });
  };
  if (typeof raw.runId !== 'string' || !raw.runId) fail('runId');
  if (typeof raw.taskId !== 'string' || !raw.taskId) fail('taskId');
  if (typeof raw.projectId !== 'string') fail('projectId');
  if (typeof raw.status !== 'string' || !TASK_STATUSES.has(raw.status as TaskStatus)) fail('status');
  if (typeof raw.workflow !== 'string') fail('workflow');
  if (typeof raw.currentStep !== 'string') fail('currentStep');
  if (!isRecord(raw.agentSessions)) fail('agentSessions');
  if (!Array.isArray(raw.pendingApprovals)) fail('pendingApprovals');
  if (!Array.isArray(raw.pendingInputs)) fail('pendingInputs');
  if (!isRecord(raw.budget)) fail('budget');
  if (!Array.isArray(raw.completedSideEffects)) fail('completedSideEffects');
  if (typeof raw.progressSinceLastTurn !== 'boolean') fail('progressSinceLastTurn');
  if (typeof raw.lastSequence !== 'number') fail('lastSequence');
  if (raw.workflowState !== undefined && (!isRecord(raw.workflowState) || typeof raw.workflowState.step !== 'string')) fail('workflowState');
  if (raw.workspace !== undefined && (!isRecord(raw.workspace) || typeof raw.workspace.cwd !== 'string' || !raw.workspace.cwd)) fail('workspace');
  for (const approval of raw.pendingApprovals as unknown[]) {
    if (!isRecord(approval) || typeof approval.id !== 'string' || typeof approval.agentId !== 'string') {
      fail('pendingApprovals[].id');
    }
  }
  return raw as unknown as RunSnapshot;
}

/**
 * 把任意版本的原始快照遷移到當前版本。
 * - 更高的未知版本：拋 SNAPSHOT_SCHEMA_UNSUPPORTED（fail closed，需要新版本程式）。
 * - 缺失遷移路徑/結構不合法：拋 SNAPSHOT_CORRUPTED。
 */
export function migrateRunSnapshot(input: unknown): RunSnapshot {
  if (!isRecord(input)) {
    throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', 'RunSnapshot is not an object');
  }
  const version = input.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', 'RunSnapshot schemaVersion missing or invalid', { schemaVersion: version });
  }
  if (version > RUN_SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotLoadError(
      'SNAPSHOT_SCHEMA_UNSUPPORTED',
      `RunSnapshot schemaVersion ${version} is newer than supported ${RUN_SNAPSHOT_SCHEMA_VERSION}`,
      { schemaVersion: version, supportedVersion: RUN_SNAPSHOT_SCHEMA_VERSION },
    );
  }

  let raw: RawSnapshot = structuredClone(input);
  for (let v = version; v < RUN_SNAPSHOT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', `No migration from RunSnapshot v${v}`, { schemaVersion: v });
    }
    raw = step(raw);
  }
  return validate(raw);
}

export function serializeRunSnapshot(snapshot: RunSnapshot): string {
  if (snapshot.schemaVersion !== RUN_SNAPSHOT_SCHEMA_VERSION) {
    // 禁止用舊程式把快照降級/覆蓋成其他版本
    throw new SnapshotLoadError(
      'SNAPSHOT_SCHEMA_UNSUPPORTED',
      `Refusing to write RunSnapshot schemaVersion ${snapshot.schemaVersion}`,
      { schemaVersion: snapshot.schemaVersion, supportedVersion: RUN_SNAPSHOT_SCHEMA_VERSION },
    );
  }
  return JSON.stringify(snapshot);
}

export function deserializeRunSnapshot(json: string): RunSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', `RunSnapshot JSON parse failed: ${(error as Error).message}`);
  }
  return migrateRunSnapshot(parsed);
}

/** 不拋異常的載入：供儲存層和恢復流程使用。 */
export function loadRunSnapshot(json: string, ids: { runId: string; taskId: string }): RunLoadResult {
  try {
    const snapshot = deserializeRunSnapshot(json);
    return { status: 'ok', runId: snapshot.runId, taskId: snapshot.taskId, snapshot };
  } catch (error) {
    if (error instanceof SnapshotLoadError && error.code === 'SNAPSHOT_SCHEMA_UNSUPPORTED') {
      return {
        status: 'unsupported-schema',
        ...ids,
        schemaVersion: Number(error.details.schemaVersion),
        supportedVersion: RUN_SNAPSHOT_SCHEMA_VERSION,
      };
    }
    return { status: 'corrupted', ...ids, error: (error as Error).message };
  }
}

export function unwrapRunLoad(result: RunLoadResult | undefined): RunSnapshot | undefined {
  if (!result) return undefined;
  if (result.status === 'ok') return result.snapshot;
  if (result.status === 'unsupported-schema') {
    throw new SnapshotLoadError('SNAPSHOT_SCHEMA_UNSUPPORTED', `Run ${result.runId} snapshot schema ${result.schemaVersion} unsupported`, {
      runId: result.runId,
      schemaVersion: result.schemaVersion,
      supportedVersion: result.supportedVersion,
    });
  }
  throw new SnapshotLoadError('SNAPSHOT_CORRUPTED', `Run ${result.runId} snapshot corrupted: ${result.error}`, { runId: result.runId });
}
