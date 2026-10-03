/**
 * UI 側的統一契約型別（只依賴服務端 REST/WS 的統一投影，不依賴任何 provider 私有結構）。
 */
export type TaskStatus = 'CREATED' | 'QUEUED' | 'RUNNING' | 'WAITING_INPUT' | 'WAITING_APPROVAL' | 'BLOCKED' | 'FAILED' | 'CANCELLED' | 'COMPLETED';

export interface Agent {
  id: string;
  name: string;
  kind: string;
  ready: boolean;
  /** 未就緒的原因與解決辦法（P1-16）。 */
  notReadyReason?: string;
  capabilities: string[];
}

export interface AppConfig {
  runtimeMode: string;
  storeMode: string;
  workspace: string;
  workspaceIsGit: boolean;
  workspacePolicy: 'exclusive' | 'shared';
  instanceId: string;
  /** 啟動恢復報告；服務先監聽埠再恢復，恢復完成之前為空。 */
  recovery?: { resumed: string[]; waiting: string[]; blocked: string[]; failedClosed: string[] };
}

export interface TaskSummary {
  taskId: string;
  runId: string;
  title: string;
  status: TaskStatus;
  step: string;
  workflowStep?: string;
  currentAgentId?: string;
  currentAction?: string;
  pendingApprovals: number;
  pendingInputs: number;
  recovered?: { count: number; at: number };
  blocker?: string;
  /** 結構化的阻塞原因（僅 BLOCKED 時；P0-5）。 */
  blockedBy?: { source: string; code: string; agentId?: string; approvalId?: string };
  updatedAt: number;
  createdAt: number;
}

export interface UnifiedEvent {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  agentId?: string;
  sessionId?: string;
  type: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  confidence: 'confirmed' | 'inferred';
  timestamp: number;
  sequence: number;
  data: Record<string, unknown>;
}

export interface PendingApproval {
  id: string;
  agentId: string;
  providerCallId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  status: string;
}

export interface Budget {
  maxTurns: number;
  maxAgentCalls: number;
  maxReviewRounds: number;
  maxStallCount: number;
  maxDurationMs: number;
  maxEstimatedTokens?: number;
  /** 美元花費上限（估算，P1-7）；預設不限。 */
  maxCostUsd?: number;
  turnsUsed: number;
  agentCallsUsed: number;
  reviewRoundsUsed: number;
  stallCount: number;
  estimatedTokensUsed: number;
  /** 累計估算美元花費（P1-7）。 */
  costUsdUsed?: number;
  startedAt: number;
  /** 已累計的有效工作時長（毫秒，只統計 AI 實際在工作的時間；P0-7）。 */
  activeMs?: number;
  /** 正在計時的這一段的開始時間。 */
  activeSince?: number;
  /** 正在進行一輪工作的 agent。 */
  workingAgentIds?: string[];
  /** 當前計數視窗（對話任務每條指令一個視窗；工作流在閘門續額 / 放寬預算時開新視窗）。 */
  window?: { turns: number; agentCalls: number; tokens: number; costUsd?: number; activeMs: number; at: number; reason?: string };
}

export interface WorkflowState {
  step: string;
  stepSeq: number;
  awaitingAgentId?: string;
  agents: { implement: string; review: string; test: string };
  cwd?: string;
  workspace?: { kind: 'directory' | 'worktree'; repoPath?: string; branch?: string };
  testCommand?: string;
  reviewGate: boolean;
  retriesUsed: number;
  rescueUsed: boolean;
  lastTest?: { passed: boolean; exitCode: number | null; outputTail: string; at: number };
  /** 最近一次 agent 錯誤（阻塞橫幅據此說明失敗原因）。 */
  lastError?: { agentId: string; code: string; category: string; retryable: boolean; confidence: string };
  review?: { verdict: string; confidence: string; agentId: string; summary: string };
  handoffs: Array<{ id: string; from?: string; to: string; step: string; reason: string; context: string; at: number }>;
  history: Array<{ step: string; agentId?: string; outcome: string; at: number }>;
  /** 等待你確認的測試配置改動（P0-8 / H-15）。 */
  testConfigReview?: TestConfigReview;
}

/** 等待操作員確認的測試配置改動（P0-8 / H-15）：AI 改過測試配置時，測試不會自動執行。 */
export interface TestConfigReview {
  /** 確認時原樣帶回；確認之前配置又被改了，服務端會拒絕並更新差異。 */
  digest: string;
  reason: 'changed' | 'no-baseline' | 'unreadable';
  /** workflow = 測試步驟之前發現的（任務在等你決定）；manual = 手動「重跑測試」時發現的。 */
  source: 'workflow' | 'manual';
  changes: Array<{ path: string; kind: 'added' | 'removed' | 'modified'; diff: string; note?: string }>;
  at: number;
}

/** 工作區檢查點（P2-3）。 */
export interface CheckpointRecord {
  seq: number;
  ref: string;
  agentId?: string;
  label: string;
  files: number;
  at: number;
  restoreOf?: number;
}

export interface RunSnapshot {
  /** 工作區檢查點（P2-3）。 */
  checkpoints?: CheckpointRecord[];
  /** 多個實現擇一（P2-11）。 */
  group?: { id: string; index: number; size: number };
  runId: string;
  taskId: string;
  status: TaskStatus;
  workflow: string;
  currentStep: string;
  currentAgentId?: string;
  /** 對話任務的主 agent（可寫的那一個；P0-5）。 */
  primaryAgentId?: string;
  /** 阻塞原因（僅 BLOCKED 時；P0-5）。 */
  blockedBy?: { source: 'approval' | 'safety' | 'budget' | 'workflow' | 'runtime'; code: string; agentId?: string; approvalId?: string; eventId: string; at: number; interruptedAgentIds?: string[] };
  agentSessions: Record<string, { agentId: string; adapterType: string; providerSessionId?: string; status: string; ownerInstanceId?: string }>;
  pendingApprovals: PendingApproval[];
  pendingInputs: Array<{ id: string; prompt: string; createdAt: number }>;
  budget: Budget;
  completedSideEffects: Array<{ id: string; name?: string; agentId?: string; completedAt: number }>;
  /** 已完成副作用的總數（P2-10：completedSideEffects 只有最近一段）。 */
  sideEffectCount?: number;
  recovery?: { recoveredAt: number; count: number };
  workflowState?: WorkflowState;
  /** inactivityTimeoutMs：步驟不活動看門狗的閾值（毫秒，0 表示關閉；P0-6）。 */
  settings?: { handoffPolicy: 'ask' | 'auto'; autoHandoffsUsed: number; maxAutoHandoffs: number; inactivityTimeoutMs?: number };
  /** 任務工作區（對話任務也有；v5 快照起）。 */
  workspace?: {
    cwd: string;
    kind?: 'directory' | 'worktree';
    repoPath?: string;
    branch?: string;
    /** P2-4：已經合入主倉庫。 */
    merged?: { at: number; mode: 'merge' | 'apply'; commit?: string };
    /** P2-4：worktree 與分支已經刪除。 */
    cleanedAt?: number;
  };
  lastSequence: number;
}

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  workflow: string;
  runId: string;
  createdAt: number;
  updatedAt: number;
  currentAgentId?: string;
  currentAction?: string;
}

export interface UsageRecord {
  id: string;
  agentId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  durationMs?: number;
  providerReported: boolean;
  createdAt: number;
}

export interface TaskDetail {
  task: TaskRecord;
  run?: RunSnapshot;
  runLoadStatus?: string;
  events: UnifiedEvent[];
  approvals: Array<{ id: string; status: string; agentId: string; request: Record<string, unknown>; decision?: Record<string, unknown>; createdAt: number; resolvedAt?: number }>;
  usage: UsageRecord[];
}

export interface UsageCounters {
  agentCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** 估算美元花費（只有 Claude 上報）。 */
  costUsd: number;
  costUsdToday: number;
  reportedTokens: number;
  durationMs: number;
  failures: number;
  testFailures: number;
  stalls: number;
  budgetBlocks: number;
  reviewRounds: number;
}

export interface UsageSummary {
  runs: number;
  activeRuns: number;
  totals: UsageCounters;
  byAgent: Array<{ agentId: string } & UsageCounters>;
}

/** 預算調整的結果（POST /api/tasks/:id/budget，P0-7）。 */
export interface BudgetAdjustResponse {
  ok: boolean;
  changes: Record<string, { from?: number; to: number }>;
  renewed: boolean;
  resumed: boolean;
  status: TaskStatus;
  /** 沒有恢復時的中文說明。 */
  message?: string;
  budget: Budget;
}

export interface CreateTaskBody {
  title?: string;
  prompt: string;
  agentId?: string;
  workflow?: 'implementation-v1' | 'manual';
  testCommand?: string;
  reviewGate?: boolean;
  cwd?: string;
  worktree?: boolean;
  sharedWorkspace?: boolean;
  handoffPolicy?: 'ask' | 'auto';
  askBoth?: boolean;
  /** 步驟不活動看門狗的閾值（毫秒）；預設用服務端預設值。 */
  inactivityTimeoutMs?: number;
}
