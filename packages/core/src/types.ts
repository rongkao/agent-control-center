export type TaskStatus =
  | 'CREATED'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'WAITING_APPROVAL'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED'
  | 'COMPLETED';

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'planning'
  | 'coding'
  | 'reviewing'
  | 'testing'
  | 'waiting'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';
export type EventConfidence = 'confirmed' | 'inferred';

export type EventType =
  | 'run.started'
  | 'run.status'
  | 'run.completed'
  | 'run.failed'
  | 'agent.started'
  | 'agent.status'
  | 'agent.message'
  | 'model.turn.started'
  | 'model.turn.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'handoff.requested'
  | 'handoff.completed'
  | 'approval.required'
  | 'approval.resolved'
  /** P1-1：操作員對工具審批的決定已經交給了 agent（投遞狀態；只有編排器能發）。 */
  | 'approval.delivered'
  /** P2-3：工作區檢查點（每一輪做完後的檔案快照；只有編排器能發）。 */
  | 'checkpoint.created'
  /** P2-3：工作區恢復到某個檢查點（撤銷一輪；追加事件，不刪除歷史）。 */
  | 'checkpoint.restored'
  /** P2-4：任務 worktree 的改動已經合入主倉庫（merge 或 apply）。 */
  | 'workspace.merged'
  /** P2-4：任務 worktree 與分支已經刪除。 */
  | 'workspace.cleaned'
  /** P2-5：諮詢有了結果（被諮詢的 agent 答完、失敗或被停下）；答覆已交回提問的 agent。 */
  | 'consult.answered'
  | 'safety.blocked'
  | 'budget.exceeded'
  | 'budget.stalled'
  /** P0-7：預算被調整（閘門續額、操作員放寬 / 調整限額、恢復阻塞的任務）。 */
  | 'budget.extended'
  | 'runtime.warning'
  | 'runtime.error';

export interface UnifiedEvent {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  agentId?: string;
  sessionId?: string;
  type: EventType;
  severity: EventSeverity;
  confidence: EventConfidence;
  timestamp: number;
  sequence: number;
  data: Record<string, unknown>;
}

export interface TaskBudget {
  maxTurns: number;
  maxAgentCalls: number;
  maxReviewRounds: number;
  maxStallCount: number;
  maxDurationMs: number;
  maxEstimatedTokens?: number;
  /**
   * P1-7：美元花費上限（估算值，只有上報美元的 provider 才計入，目前是 Claude）。預設不限。
   * 訂閱登入時這是 SDK 按官方價格估算的“等值花費”，不是實際賬單；用來防止 AI 一口氣跑掉太多額度。
   */
  maxCostUsd?: number;
}

/**
 * 預算計數視窗（P0-7）：記錄視窗開始時各項累計值，限額按“視窗內的用量”判斷。
 * 工作流任務在人工閘門（評審 / 重試）、換人接手和操作員放寬預算時開新視窗；
 * 對話任務每條操作員指令開一個新視窗（按會話視窗計算，日常聊天不會把額度用完）。
 */
export interface BudgetWindow {
  turns: number;
  agentCalls: number;
  tokens: number;
  /** P1-7：視窗開始時的累計美元花費（升級前的視窗沒有這個欄位，按 0 計）。 */
  costUsd?: number;
  /** 視窗開始時的有效工作時長（毫秒）。 */
  activeMs: number;
  /** 視窗開始的時間（編排器時鐘）。 */
  at: number;
  /** 開新視窗的原因：gate / operator / relax / resume / reassign。 */
  reason?: string;
}

export interface BudgetSnapshot extends TaskBudget {
  turnsUsed: number;
  agentCallsUsed: number;
  reviewRoundsUsed: number;
  stallCount: number;
  estimatedTokensUsed: number;
  /** P1-7：累計的美元花費（估算，provider 上報的增量之和）；升級前的快照沒有這個欄位，按 0 計。 */
  costUsdUsed?: number;
  /** 任務建立時間（只作展示；時長預算不再用它計算，見 activeMs）。 */
  startedAt: number;
  /**
   * P0-7：已累計的有效工作時長（毫秒，不含正在計時的這一段）。只統計 agent 實際在工作的時間：
   * 等待人工（WAITING_APPROVAL / WAITING_INPUT）、對話空閒、服務停機都不計入。升級前的快照沒有這個欄位，按 0 計。
   */
  activeMs?: number;
  /** P0-7：正在計時的這一段的開始時間（編排器時鐘）；沒有在計時時為空。 */
  activeSince?: number;
  /** P0-7：最近一次記賬的時間（編排器時鐘）。重啟恢復時計時截止到這裡，停機時間不計入。 */
  activeCheckedAt?: number;
  /** P0-7：正在進行一輪工作的 agent（派發時加入，這一輪以終態結束或會話關閉時移出）。 */
  workingAgentIds?: string[];
  /** P0-7：當前計數視窗；為空表示從任務開始算起。 */
  window?: BudgetWindow;
}

/**
 * 審批狀態。voided（P0-5）：run 進入終態時仍未處理的審批被作廢——不會再執行，也不能再批准。
 */
export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'voided';

export interface PendingApproval {
  id: string;
  agentId: string;
  sessionId?: string;
  providerCallId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  status: ApprovalStatus;
}

/** 審批的持久化記錄（approvals 表）。審批 ID 與 providerCallId 在重啟/恢復後必須保持不變。 */
export interface ApprovalRecord {
  id: string;
  runId: string;
  taskId: string;
  agentId: string;
  sessionId?: string;
  providerCallId?: string;
  status: ApprovalStatus;
  request: Record<string, unknown>;
  decision?: Record<string, unknown>;
  createdAt: number;
  resolvedAt?: number;
}

/** 用量記錄（usage 表），來自 model.turn.completed 事件攜帶的 usage 資料。 */
export interface UsageRecord {
  id: string;
  runId: string;
  agentId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** P1-7：寫入快取的輸入 token（Claude 的 cache_creation）；已經包含在 inputTokens 裡。 */
  cacheWriteTokens?: number;
  /** P1-7：這一輪的美元花費（估算，provider 上報的累計值之差）；不上報美元的 provider 為空。 */
  costUsd?: number;
  durationMs?: number;
  providerReported: boolean;
  createdAt: number;
}

/** 工作區檢查點（P2-3）。 */
export interface CheckpointRecord {
  /** 序號（任務內從 0 開始，0 是任務開始時的基線）。 */
  seq: number;
  /** git 提交（掛在隱藏引用 refs/acc/checkpoints/… 下）。 */
  ref: string;
  /** 哪個 agent 這一輪做完後拍的（基線為空）。 */
  agentId?: string;
  label: string;
  /** 相對上一個檢查點改動的檔案數。 */
  files: number;
  at: number;
  /** 恢復到這個檢查點而產生的（撤銷）。 */
  restoreOf?: number;
}

/** 工作區快照結果（P2-3）。 */
export interface WorkspaceSnapshot {
  ref: string;
  tree: string;
  /** 相對 parent 有沒有變化；沒有變化時 ref 就是 parent。 */
  changed: boolean;
}

/** 兩個檢查點（或檢查點與當前工作區）之間的差異。 */
export interface WorkspaceDiff {
  files: Array<{ status: 'A' | 'M' | 'D'; path: string }>;
  patch: string;
  truncated: boolean;
}

/**
 * 工作區檢查點的實現（P2-3）：由服務端注入（git 實現在 @acc/adapters 的 GitCheckpointer），核心不直接呼叫 git。
 * 不是 git 倉庫時 snapshot / diff 返回 undefined。
 */
export interface WorkspaceCheckpointer {
  snapshot(cwd: string, input: { taskId: string; seq: number; label: string; parent?: string }): Promise<WorkspaceSnapshot | undefined>;
  diff(cwd: string, from: string, to?: string): Promise<WorkspaceDiff | undefined>;
  restore(cwd: string, to: string): Promise<{ restored: string[] }>;
}

/** 還沒有投遞的審批決定（P1-1）。 */
export interface UndeliveredDecision {
  approvalId: string;
  agentId: string;
  sessionId?: string;
  decision: 'approve' | 'decline';
  scope?: 'once' | 'session';
  providerCallId?: string;
  /** 原審批請求（工具名、完整輸入），補投時用來匹配“同一呼叫”。 */
  request?: Record<string, unknown>;
  /** 問題的答案（P2-6；機密問題的答案沒有記錄，補投時為空）。 */
  answers?: Record<string, string[]>;
  resolvedAt: number;
}

/** 執行中的工具呼叫（P1-2）。 */
export interface InFlightSideEffect {
  id: string;
  agentId?: string;
  name?: string;
  /** 輸入摘要（命令、檔案路徑等，最多 200 字），給操作員判斷“它可能已經做了什麼”。 */
  summary?: string;
  startedAt: number;
}

/**
 * 已完成的副作用台賬條目。恢復/續跑時交給 adapter，保證已完成的工具呼叫不會被重放。
 * id 優先使用 provider 原生的呼叫 ID（toolCallId / providerCallId）。
 */
export interface CompletedSideEffect {
  id: string;
  agentId?: string;
  name?: string;
  eventId: string;
  completedAt: number;
}

/** 暫停點遊標：記錄進入等待前所在的邏輯步驟，審批/輸入完成後回到同一步驟繼續。 */
export interface ResumeCursor {
  step: string;
  reason: 'approval' | 'input';
  agentId?: string;
  approvalId?: string;
}

export interface PendingInput {
  id: string;
  agentId?: string;
  prompt: string;
  createdAt: number;
}

export interface SessionSnapshot {
  agentId: string;
  adapterType: string;
  providerSessionId?: string;
  status: AgentStatus;
  /** 持有該會話的 orchestrator 程序實例 ID（會話歸屬，見 P1.3）。 */
  ownerInstanceId?: string;
  metadata?: Record<string, unknown>;
}

export type AgentMode = 'implement' | 'review' | 'rescue' | 'test' | 'analysis';

/** 唯讀模式（評審 / 診斷 / 分析）：Claude 必須用 plan 模式，Codex 必須用 read-only 沙箱，不因任務需要而放寬。 */
export function isReadOnlyAgentMode(mode: AgentMode | undefined): boolean {
  return mode === 'review' || mode === 'rescue' || mode === 'analysis';
}

/**
 * agent 主動請求交接時的策略：
 * - ask：每次都作為審批交給操作員決定（預設）；
 * - auto：自動放行，但每個任務最多 maxAutoHandoffs 次，超出後回退為 ask，防止 agent 之間來回踢皮球。
 */
export type HandoffPolicy = 'ask' | 'auto';

export interface RunSettings {
  handoffPolicy: HandoffPolicy;
  autoHandoffsUsed: number;
  maxAutoHandoffs: number;
  /** 一條操作員指令之後，AI 之間最多自己交接幾次（P1-8，不論策略）；預設 DEFAULT_MAX_HANDOFF_CHAIN。 */
  maxHandoffChain?: number;
  /**
   * 步驟不活動看門狗的閾值（毫秒，P0-6）：工作流正在等待的 agent 在這麼長時間裡沒有任何事件（包括逐字流式輸出），
   * 就按 重試 → rescue → 帶原因的 BLOCKED 處理。0 表示關閉；預設（升級前建立的任務）用編排器的預設值。
   * 等待人工（審批、閘門）的時間不計入。
   */
  inactivityTimeoutMs?: number;
}

/**
 * 在 WAITING_APPROVAL 期間到達的、工作流正在等待的那個 agent 的完成 / 失敗訊號（H-9）。
 * 連同當時的 stepSeq 持久化在快照裡，審批結束、run 回到 RUNNING 後重放；步驟已經變了（stepSeq 不同）就丟棄。
 */
export interface DeferredSignal {
  kind: 'agent-completed' | 'agent-failed';
  agentId: string;
  stepSeq: number;
  /** 觸發它的事件。 */
  eventId: string;
  data: Record<string, unknown>;
}

/** implementation-v1 工作流步驟。 */
export type WorkflowStep =
  | 'implement'
  | 'test'
  | 'retry'
  | 'rescue'
  | 'fix'
  | 'review-gate'
  | 'review'
  | 'review-fix'
  | 'final-test'
  | 'done';

export type ReviewVerdict = 'ACCEPT' | 'SUGGEST_CHANGES' | 'BLOCKED' | 'UNKNOWN';

/** 持久化的確定性工作流狀態（v3）。所有跨 agent 決策都由 Orchestrator 基於它做出。 */
export interface WorkflowState {
  definition: 'implementation-v1';
  step: WorkflowStep;
  /** 每進入一個步驟 +1，用於去重完成訊號。 */
  stepSeq: number;
  /** 當前步驟正在等待其完成訊號的 agent；為空表示不在等待 agent。 */
  awaitingAgentId?: string;
  agents: { implement: string; review: string; test: string };
  /** 任務工作目錄（worktree 繫結時為 worktree 路徑）。 */
  cwd?: string;
  /** 工作區來源：普通目錄或為任務建立的獨立 git worktree。 */
  workspace?: { kind: 'directory' | 'worktree'; repoPath?: string; branch?: string };
  /** 顯式策略：允許與其他任務共享同一工作區（預設不允許）。 */
  sharedWorkspace?: boolean;
  testCommand?: string;
  /** 測試通過後是否停在人工評審閘門（預設 false）。 */
  reviewGate: boolean;
  retriesUsed: number;
  transportRetriesUsed: number;
  rescueUsed: boolean;
  lastTest?: { passed: boolean; exitCode: number | null; outputTail: string; at: number };
  /** 各 agent 最近一次輸出摘要（上下文交接用，不轉發完整對話）。 */
  lastOutputs: Record<string, string>;
  /** 結構化的評審結果（P2-5）：agent 最近一條回覆是合法的結構化結果時才有。 */
  structuredReviews?: Record<string, { verdict: Exclude<ReviewVerdict, 'UNKNOWN'>; issues: number }>;
  lastError?: { agentId: string; code: string; category: string; retryable: boolean; confidence: EventConfidence };
  review?: { verdict: ReviewVerdict; confidence: EventConfidence; agentId: string; summary: string };
  handoffs: Array<{ id: string; from?: string; to: string; step: WorkflowStep; reason: string; context: string; at: number }>;
  history: Array<{ step: WorkflowStep; agentId?: string; outcome: string; at: number }>;
  /**
   * 當前步驟最近一次“有動靜”的時間（編排器時鐘，P0-6 不活動看門狗用）：
   * 正在等待的 agent 的任何事件、狀態變化（包括審批結束回到 RUNNING）、派發、重啟恢復都會重新整理它。
   * 舊程式不認識這個欄位也不會出錯（只是沒有看門狗），所以不需要提升快照版本。
   */
  lastActivityAt?: number;
  /** 等待審批期間快取的完成 / 失敗訊號（H-9），見 DeferredSignal。 */
  deferredSignal?: DeferredSignal;
  /**
   * 測試配置的基線（P0-8 / H-15）：上一次允許執行測試時，測試相關配置（package.json 的 scripts、測試框架配置、
   * testCommand 直接引用的腳本）的指紋。任務建立時採集；操作員確認改動後更新。升級前建立的任務沒有它（按“無法確認”處理）。
   * 舊程式不認識這個欄位也不會出錯（只是不做這項檢查），所以不需要提升快照版本。
   */
  testConfigBaseline?: TestConfigFingerprint;
  /**
   * 基線成為“可信”的時間（P0 第三批審查）：第一次在這個目錄建任務時採集、或者操作員確認改動的時間。
   * 同一目錄的新任務沿用最近一次可信的基線（而不是建立時磁碟上的內容），上一個任務裡沒確認的改動在新任務裡照樣要確認。
   */
  testConfigTrustedAt?: number;
  /**
   * 任務建立時磁碟上測試配置的摘要（沿用了上一次確認過的基線、而磁碟上的內容和它不一樣時才記，P0 第三批審查）：
   * 介面據此說明這些改動在任務開始前就已經存在。操作員確認改動後清除。
   */
  testConfigStartDigest?: string;
  /** 等待操作員確認的測試配置改動（H-15）：測試步驟之前發現配置和基線不一致時寫入，確認、重試、接受結果後清除。 */
  testConfigReview?: TestConfigReview;
  /**
   * 已經批准、等工作流下一次派發時一起轉交的交接內容（P0 第三批審查）：交接目標就是工作流正在等 / 接下來要派發的 agent 時，
   * 單獨投遞會讓它同時收到兩條訊息（第一輪的完成被當成下一步的完成），所以併入工作流給它的下一個信封（放在資料區塊裡）。
   */
  pendingHandoffs?: PendingHandoff[];
}

/** 併入工作流下一次派發的交接內容（見 WorkflowState.pendingHandoffs）。 */
/** 進行中的諮詢（P2-5）：from 問 to 一個問題，to 唯讀回答，這一輪結束後答覆自動交回 from。 */
export interface PendingConsult {
  /** 對應 handoff.requested 的 contextRef。 */
  id: string;
  fromAgentId: string;
  toAgentId: string;
  question: string;
  /** 諮詢開始時的事件序號：答覆只取這之後 to 發出的訊息。 */
  afterSequence: number;
  at: number;
}

export interface PendingHandoff {
  /** 對應的交接審批。 */
  id: string;
  fromAgentId: string;
  toAgentId: string;
  /** agent 請求裡的要求（agent 寫的，轉交時放在資料區塊裡）。 */
  instruction: string;
  content: string;
  at: number;
}

/** 測試配置裡的一個檔案（或檔案裡與測試有關的那部分，例如 package.json 的 scripts）。 */
export interface TestConfigFile {
  /** 用於比較的內容的 sha256。 */
  hash: string;
  /** 用於顯示差異的文字（有長度上限）；不顯示內容時為空，原因見 note。 */
  text?: string;
  /** 說明：只取了哪一部分、為什麼不顯示內容等。 */
  note?: string;
  /**
   * command = 只因為這條測試命令才檢查的檔案（Makefile、deno.json、testCommand 直接引用的腳本）。
   * 同一目錄換了測試命令時，只沿用上一次確認過的共用部分（P0 第三批審查）。
   */
  scope?: 'command';
}

/** 測試配置的指紋：鍵是相對工作目錄的路徑（用 / 分隔；工作目錄之外被 testCommand 引用的腳本用絕對路徑）。 */
export interface TestConfigFingerprint {
  files: Record<string, TestConfigFile>;
}

/** 測試配置的一處改動（給操作員看的差異）。 */
export interface TestConfigChange {
  path: string;
  kind: 'added' | 'removed' | 'modified';
  /** 統一格式的差異：以 - 開頭的行被刪除，以 + 開頭的行是新增，以空格開頭的是上下文。 */
  diff: string;
  note?: string;
}

/** 等待操作員確認的測試配置改動（H-15）。 */
export interface TestConfigReview {
  /** 當前測試配置的摘要：操作員確認時必須原樣帶回，確認前後配置又變了就要求重新確認。 */
  digest: string;
  /** 當前測試配置（確認後成為新的基線）。 */
  fingerprint: TestConfigFingerprint;
  changes: TestConfigChange[];
  /**
   * changed = 與基線不一致；no-baseline = 沒有基線（升級前建立的任務，或建立時讀取失敗），無法確認有沒有被改過；
   * unreadable = 這次讀取測試配置失敗（fail closed，同樣請操作員確認）。
   */
  reason: 'changed' | 'no-baseline' | 'unreadable';
  /** 這些改動在任務建立時就已經存在（和這個目錄上一次確認過的測試配置不一樣，P0 第三批審查）：介面據此說明它不一定是這個任務裡的 AI 改的。 */
  preexisting?: boolean;
  /** workflow = 工作流的測試步驟之前發現的（任務進入 WAITING_INPUT）；manual = 操作員手動「重跑測試」時發現的（任務狀態不變）。 */
  source: 'workflow' | 'manual';
  step: WorkflowStep;
  stepSeq: number;
  at: number;
}

/**
 * 讀取測試配置的指紋（由服務端注入本地實現，見 @acc/adapters 的 createLocalTestConfigGuard）。
 * 編排器只在鎖外呼叫它；讀取失敗時編排器按“無法確認”處理（fail closed，請操作員確認）。
 */
export interface TestConfigGuard {
  capture(cwd: string, testCommand: string): TestConfigFingerprint | Promise<TestConfigFingerprint>;
}

/**
 * 任務的工作區（v5）：建立任務時就持久化，與 workflowState.cwd 對等。
 * 對話任務沒有 workflowState，以前只能從會話後設資料裡讀 cwd——首次啟動就失敗時快照裡沒有會話，重啟後會回退到預設工作區（H-4）。
 */
export interface RunWorkspace {
  cwd: string;
  kind?: 'directory' | 'worktree';
  repoPath?: string;
  branch?: string;
  /** P2-4：合入主倉庫的時間與方式。 */
  merged?: { at: number; mode: 'merge' | 'apply'; commit?: string };
  /** P2-4：worktree 與分支已經刪除。 */
  cleanedAt?: number;
}

/**
 * 阻塞原因（P0-5 / M-5）：run 進入 BLOCKED 時由投影記錄，離開 BLOCKED 時清除。
 * 只說明“為什麼進入 BLOCKED”；離開 BLOCKED 只能經人工閘門、換人接手或停止，審批不會解除它。
 */
export interface BlockedBy {
  /** approval = 操作員拒絕了審批；safety = 安全攔截；budget = 預算 / 停滯；workflow = 工作流規則；runtime = 編排器 fail closed（執行時錯誤、恢復失敗、會話歸屬衝突等）。 */
  source: 'approval' | 'safety' | 'budget' | 'workflow' | 'runtime';
  /** 具體程式碼：審批為 APPROVAL_DECLINED，預算為限額名（maxTurns 等），其餘為錯誤碼。 */
  code: string;
  agentId?: string;
  /** 被拒絕的審批（source = approval）。 */
  approvalId?: string;
  /** 導致進入 BLOCKED 的事件。 */
  eventId: string;
  at: number;
  /** 預算阻塞時正在工作、被預算停止打斷的 agent（P0-7）：放寬預算並繼續時讓它們從中斷的地方接著做。 */
  interruptedAgentIds?: string[];
}

/**
 * P1-7：provider 上報的累計用量（Claude 的 total_cost_usd / modelUsage 是“這個會話到目前為止”的累計值）。
 * 按會話記住上一次的值，每一輪只記增量；續接後第一條結果仍帶著之前各輪的累計值，也不會重複計算。
 */
export interface UsageCursor {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface RunSnapshot {
  /** 快照結構版本，當前版本見 RUN_SNAPSHOT_SCHEMA_VERSION；更高版本必須 fail closed。 */
  schemaVersion: number;
  /** P1-7：會話 ID → 上一次記賬時的累計用量（只有上報累計值的 provider 才有）。可選欄位，升級前的快照沒有。 */
  usageCursors?: Record<string, UsageCursor>;
  runId: string;
  projectId: string;
  taskId: string;
  status: TaskStatus;
  workflow: string;
  currentStep: string;
  /** 最近一次被派發的 agent（只作展示）。終止、恢復、交接不以它為準：同一 run 可能有多個 agent 在工作。 */
  currentAgentId?: string;
  /**
   * 對話任務的主 agent（P0-5）：可寫的那一個。建立時為發起對話的 agent，Ask Both 指定主 agent 或換人接手時更新；
   * 換人接手的交接來源用它，而不是 currentAgentId（Ask Both 之後 currentAgentId 可能是隻讀的顧問）。工作流任務為空（用 workflowState.agents.implement）。
   */
  primaryAgentId?: string;
  /** 阻塞原因（僅在 BLOCKED 時存在）。 */
  blockedBy?: BlockedBy;
  agentSessions: Record<string, SessionSnapshot>;
  pendingApprovals: PendingApproval[];
  pendingInputs: PendingInput[];
  budget: BudgetSnapshot;
  /** v2：已完成副作用台賬（恢復時不得重放）。 */
  /**
   * 已完成副作用台賬的最近一段（P2-10：只保留最近 MAX_SNAPSHOT_SIDE_EFFECTS 個，快照大小有上限）。
   * 完整的台賬由事件日誌重建（completedSideEffectIdsFromEvents），續跑時交給 adapter。
   */
  completedSideEffects: CompletedSideEffect[];
  /** 已完成副作用的總數（P2-10；沒有時等於 completedSideEffects.length）。 */
  sideEffectCount?: number;
  /** 由策略自動放行的審批（P2-7）：consecutive 在人工處理一次審批後清零。 */
  autoApprovals?: { consecutive: number; total: number };
  /**
   * P1-2 / M-9：已經開始、還沒有結果的工具呼叫（tool.started 之後沒有 completed / failed）。
   * 服務在這期間崩潰時，這些呼叫可能已經執行了、也可能沒有：恢復時不盲目續跑，先請操作員確認。可選欄位，升級前的快照沒有。
   */
  inFlightSideEffects?: InFlightSideEffect[];
  /**
   * P1-1 / L-4：已經記下、但還沒有確認交給 agent 的審批決定（outbox）。approval.resolved 時加入，approval.delivered 時移除。
   * 服務在兩者之間崩潰時，恢復按原來的決定補投一次，而不是靜默丟失或再問操作員一遍。
   */
  undeliveredDecisions?: UndeliveredDecision[];
  /** P2-3：工作區檢查點（任務開始時的基線 + 每一輪改動過檔案之後各一個，最多保留最近 100 個）。 */
  checkpoints?: CheckpointRecord[];
  /** 進行中的諮詢（P2-5）。 */
  pendingConsults?: PendingConsult[];
  /** 多個實現擇一（P2-11）：這個任務是第幾個候選。 */
  group?: { id: string; index: number; size: number };
  /** v2：等待審批/輸入時的邏輯步驟遊標。 */
  resumeCursor?: ResumeCursor;
  /** v2：自上一次模型輪次結束以來是否出現過語義進展（用於停滯檢測）。 */
  progressSinceLastTurn: boolean;
  /** v2：程序重啟後的恢復資訊，供 UI 展示“重啟後已恢復”。 */
  /**
   * 重啟恢復記錄。streak（P1-14）：連續多少次恢復之後都還沒有任何一輪做完——每次續跑都讓程序崩潰的任務靠它識別；
   * 任何 agent 做完一輪就清零。
   */
  recovery?: { recoveredAt: number; count: number; streak?: number };
  /**
   * 建立這個任務的程式的行為版本（P1-14，見 BEHAVIOR_VERSION）與應用版本號。行為版本不同的在途任務重啟後不自動續跑，等操作員處理。
   * 升級前建立的任務沒有這兩個欄位，按當前行為版本處理。
   */
  createdBy?: { behavior: number; appVersion?: string };
  /** v3：確定性工作流狀態；手動模式（workflow='manual'）下為空。 */
  workflowState?: WorkflowState;
  /** v4：任務級協作設定（agent 主動請求交接的處理策略等）。 */
  settings?: RunSettings;
  /** v5：任務的工作區（對話任務也有；工作流任務與 workflowState.cwd 一致）。 */
  workspace?: RunWorkspace;
  lastEventId?: string;
  lastSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRecord {
  id: string;
  projectId: string;
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

export interface AgentInfo {
  id: string;
  name: string;
  kind: 'claude' | 'codex' | 'test' | 'reviewer' | 'other';
  ready: boolean;
  /** 未就緒時的中文原因與解決辦法（P1-16，例如“沒有找到 Codex 的登入資訊……”）。 */
  notReadyReason?: string;
  capabilities: string[];
}

export interface AgentStartInput {
  projectId: string;
  taskId: string;
  runId: string;
  prompt: string;
  cwd?: string;
  mode?: AgentMode;
  context?: Record<string, unknown>;
  /** 這個任務還剩多少美元預算（P1-7；設了 maxCostUsd 才有）：支援的 provider 據此自己設上限（Claude 的 maxBudgetUsd）。 */
  remainingCostUsd?: number;
}

/** 方案額度（P1-7，例如 Codex 訂閱的 5 小時 / 每週用量）。 */
export interface QuotaStatus {
  plan?: string;
  windows: Array<{ label: string; usedPercent: number; resetsAt?: number }>;
  /** 已經用完時的原因（provider 的代碼）。 */
  limitReached?: string;
}

export interface AgentSessionHandle {
  sessionId: string;
  providerSessionId?: string;
}

/**
 * 執行隔離狀態（P2-8）：sandbox = 在沙箱裡執行（限制檔案與網路）；degraded = 沒有沙箱，只有環境變數白名單與超時等弱約束。
 */
export interface IsolationStatus {
  level: 'sandbox' | 'degraded';
  /** 沙箱是否可用。 */
  ready: boolean;
  /** 給人看的說明（中文）。 */
  detail: string;
  /** 怎麼開啟（例如需要管理員執行的命令）。 */
  setupHint?: string;
  /** 可以直接在介面上按按鈕配置（adapter 實現了 setupIsolation）。 */
  canSetup?: boolean;
}

/**
 * AI 向操作員提的問題（P2-6，統一的中斷請求）：作為 kind = 'question' 的審批出現，操作員選擇或填寫答案後交回 AI。
 * Claude 的 AskUserQuestion 與 Codex 的 requestUserInput 都歸一成這個形狀。
 */
export interface ApprovalQuestion {
  /** 問題 ID（答案按它對應）。 */
  id: string;
  /** 很短的標籤。 */
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** 可以多選。 */
  multiSelect?: boolean;
  /** 可以不選選項、自己填寫。 */
  allowOther?: boolean;
  /** 答案是密碼之類的機密：不寫進事件記錄。 */
  secret?: boolean;
}

export interface ApprovalDecision {
  approvalId: string;
  decision: 'approve' | 'decline';
  /** P2-6：回答 AI 的問題（kind = 'question' 的審批）：問題 ID → 選中的選項或填寫的內容。 */
  answers?: Record<string, string[]>;
  /** 批准範圍：once = 僅這一次（預設）；session = 本會話內同類操作不再詢問（由操作員顯式選擇）。 */
  scope?: 'once' | 'session';
  /** provider 原生呼叫 ID，adapter 用它把決定路由回原始的權限請求。 */
  providerCallId?: string;
}

/**
 * 會話續跑輸入。用於程序重啟後（adapter 記憶體中已無該會話）重新連線 provider 會話。
 * adapter 必須用 completedSideEffectIds 跳過已完成的副作用，禁止重放。
 */
export interface AgentResumeInput {
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
  /** 這個任務還剩多少美元預算（P1-7，見 AgentStartInput）。 */
  remainingCostUsd?: number;
  reason: 'recovery' | 'approval' | 'message';
  /** 需要續跑的邏輯步驟（來自 ResumeCursor 或 currentStep）。 */
  step: string;
  approval?: ApprovalDecision;
  /** 被批准的原始審批請求載荷（approval.required 事件的 data），adapter 用它識別重新發起的同一呼叫。 */
  approvalRequest?: Record<string, unknown>;
  message?: string;
  completedSideEffectIds: string[];
  /**
   * P1-2：這個 agent 在崩潰前開始了、但沒有看到結果的呼叫（名稱與輸入摘要，最多 10 條）。續跑提示裡請它先確認這些是否已經做過，
   * 而不是羅列全部已完成的原始 ID。
   */
  uncertainSideEffects?: Array<{ id: string; name?: string; summary?: string }>;
  /** P1-2：這個 agent 最近完成的呼叫（最多 10 個），續跑提示裡提醒它不要重做；不再羅列整個任務的全部 ID。 */
  recentCompletedSideEffectIds?: string[];
  lastSequence: number;
  metadata?: Record<string, unknown>;
}

export type EventSink = (event: Omit<UnifiedEvent, 'id' | 'sequence' | 'timestamp'> & Partial<Pick<UnifiedEvent, 'id' | 'sequence' | 'timestamp'>>) => Promise<void> | void;

/** 向已有會話傳送訊息時的附加要求。 */
export interface AgentSendOptions {
  /**
   * 這一輪的有效模式（編排器按“會話啟動模式與當前步驟模式中更嚴格的那個”算出）。
   * 唯讀模式時 adapter 必須在這一輪開始前把權限收緊（Claude 切到 plan，Codex 用 read-only 沙箱）；
   * 做不到就拋錯（fail closed），絕不以可寫權限執行唯讀步驟。預設表示沿用會話當前的權限。
   */
  mode?: AgentMode;
}

/**
 * provider 執行時的統一介面。編排器只透過它和 agent 打交道，不知道任何 provider 細節。
 *
 * 回合終態合約（P0-6 / H-10）——每個實現都必須遵守，共享合約測試見 tests/regression/adapter-terminal-contract.test.ts：
 * 1. 每個派發出去的回合（start 的首輪、send、resume 引發的一輪）必須以且只以一個終態結束：
 *    agent.status 的 data.status 為 completed / failed / cancelled。終態儘量帶上回合 ID（data.turnId，
 *    例如 Codex 的 turn id、Claude result 訊息的 uuid、測試執行器的這一次執行），便於和派發對應。
 *    - 執行時報錯、provider 自己中斷回合：先發歸一化的 runtime.error（code / category / retryable），再以 failed 結束；
 *    - 被編排器取消：以 cancelled 結束，之後執行時殘留的結果一律丟棄，不能再出現第二個終態；
 *    - 執行時程序崩潰、連線斷開或意外退出（例如 Claude CLI 以退出碼 0 結束）：發一條帶 data.sessionClosed = true 的
 *      runtime.error（這一輪還在進行時）或 runtime.warning（會話空閒時），這一輪還在進行時再以 failed 結束；
 *      會話空閒時不補終態（上一輪已經結束過了）。
 * 2. start / send / resume 丟擲異常表示這次派發沒有送達：不再為它發終態，由編排器處理這個異常。
 *    因為執行時連線已經關閉而沒有送達時拋 AdapterSessionClosedError，編排器會改走 resume（透明重連）。
 * 3. 編排器收到 failed、cancelled 或 sessionClosed 之後把會話移出線上表，之後對它的派發一律走 resume：
 *    會話在 adapter 裡仍然可用時（例如只是這一輪失敗）resume 直接在原會話上繼續；已經關閉時重新連線原生會話。
 *    因此實現了 resume 的 adapter 必須能處理這兩種情況。
 * 4. 正在等待的 agent 發出不可重試的 runtime.error 卻遲遲不給終態時，編排器把它當作失敗處理（兜底）；
 *    這一輪裡可以自行恢復的錯誤應當用 runtime.warning 報告，而不是 runtime.error。
 */
export interface AgentAdapter {
  readonly info: AgentInfo;
  start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle>;
  send(sessionId: string, message: string, emit: EventSink, options?: AgentSendOptions): Promise<void>;
  cancel(sessionId: string, emit: EventSink): Promise<void>;
  approve?(sessionId: string, decision: ApprovalDecision, emit: EventSink): Promise<void>;
  /**
   * 續接會話：程序重啟後、審批之後、或者會話被移出線上表之後（見上面的終態合約第 3 條）。
   * 會話在本 adapter 裡仍然可用時直接在原會話上繼續；否則用原生會話 ID 重新連線。
   */
  resume?(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void>;
  /**
   * 停止本 adapter 名下的全部執行時（服務關閉、單實例租約丟失時由編排器呼叫）。
   * 不發任何事件、不改變持久化狀態：重啟後 recover 按快照原樣續接。呼叫之後不再接受新的 start / resume。
   * 沒有實現時，編排器對每個線上會話呼叫 cancel（事件不會落盤）。
   */
  dispose?(): Promise<void> | void;
  /**
   * 靜默釋放單個會話的執行時（P1-5 / M-6：空閒回收、任務結束後清理）。
   * 不發任何事件、不改變持久化狀態；本 adapter 忘掉這個會話（清理內部 Map），之後對它的派發由編排器走 resume
   * 用原生會話 ID 重新連線。只在會話空閒（沒有進行中的回合、沒有掛起的審批）時由編排器呼叫。
   */
  release?(sessionId: string): Promise<void> | void;
  /** 執行隔離狀態（P2-8，可選）：介面顯示這個 agent 的命令在什麼隔離級別下執行。 */
  isolation?(): Promise<IsolationStatus>;
  /** 配置執行隔離（P2-8，可選，例如 Codex 的 Windows 沙箱）：由操作員在介面上按按鈕觸發。 */
  setupIsolation?(): Promise<{ ok: boolean; message: string }>;
  /** 方案額度（P1-7，可選）：例如 Codex 訂閱的剩餘用量；查不到時回傳 undefined。 */
  quota?(): Promise<QuotaStatus | undefined>;
}

/** 快照載入結果：未知的更高 schema 或損壞的快照不會拋給呼叫方，而是顯式返回，便於 fail closed。 */
export type RunLoadResult =
  | { status: 'ok'; runId: string; taskId: string; snapshot: RunSnapshot }
  | { status: 'unsupported-schema'; runId: string; taskId: string; schemaVersion: number; supportedVersion: number }
  | { status: 'corrupted'; runId: string; taskId: string; error: string };

export interface SessionOwnerRecord {
  runId: string;
  agentId: string;
  adapterType: string;
  providerSessionId: string;
  ownerInstanceId?: string;
}

/** 一次原子提交：事件追加 + 任務/快照/審批/用量更新，要麼全部成功，要麼全部回滾。 */
export interface StoreCommit {
  event?: UnifiedEvent;
  task?: TaskRecord;
  run?: RunSnapshot;
  approvals?: ApprovalRecord[];
  usage?: UsageRecord[];
}

export interface ControlPlaneStore {
  listTasks(): Promise<TaskRecord[]>;
  getTask(taskId: string): Promise<TaskRecord | undefined>;
  upsertTask(task: TaskRecord): Promise<void>;
  /** 讀取快照；遇到未知 schema 或損壞資料時丟擲 SnapshotLoadError。 */
  getRun(runId: string): Promise<RunSnapshot | undefined>;
  /** 讀取快照但不拋異常，返回顯式的載入結果。 */
  loadRun(runId: string): Promise<RunLoadResult | undefined>;
  /** 列出全部非終態 run（用於重啟恢復）。 */
  listRecoverableRuns(): Promise<RunLoadResult[]>;
  upsertRun(snapshot: RunSnapshot): Promise<void>;
  appendEvent(event: UnifiedEvent): Promise<void>;
  listEvents(runId: string, afterSequence?: number): Promise<UnifiedEvent[]>;
  /** 刪除一個任務的全部資料（P1-12）；只應該用於已經結束的任務。返回是否刪掉了。 */
  deleteTask?(taskId: string): Promise<boolean>;
  /** 事件日誌中該 run 的最大 sequence（快照不可讀時也能繼續追加事件）。 */
  getLastSequence(runId: string): Promise<number>;
  commit(unit: StoreCommit): Promise<void>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  listApprovals(runId: string): Promise<ApprovalRecord[]>;
  listUsage(runId: string): Promise<UsageRecord[]>;
  /** 按 provider 原生會話 ID 查詢所有歸屬記錄（會話歸屬唯一性檢查）。 */
  findSessionsByProviderId(providerSessionId: string): Promise<SessionOwnerRecord[]>;
  close?(): Promise<void> | void;
}

export type NextAction =
  | { type: 'CONTINUE'; agentId: string; prompt?: string }
  | { type: 'HANDOFF'; fromAgentId: string; toAgentId: string; contextRef: string; reason: string }
  | { type: 'RUN_TOOL'; toolId: string; args: unknown }
  | { type: 'WAIT_INPUT'; requestId: string; prompt: string }
  | { type: 'WAIT_APPROVAL'; approvalId: string }
  | { type: 'FINAL'; resultRef: string }
  | { type: 'FAIL'; error: NormalizedError };

export interface NormalizedError {
  code: string;
  message: string;
  category: 'policy' | 'approval' | 'permission' | 'runtime' | 'tool' | 'usage' | 'unknown';
  retryable: boolean;
  confidence: EventConfidence;
  details?: Record<string, unknown>;
}
