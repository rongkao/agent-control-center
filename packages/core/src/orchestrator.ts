import { randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import {
  BUDGET_LIMITS,
  DEFAULT_BUDGET,
  activeWorkingAgents,
  DEFAULT_CONVERSATION_BUDGET,
  budgetBlockLimit,
  budgetLimitsProblem,
  budgetUsage,
  canStartReviewRound,
  closeActiveClockAfterRestart,
  createBudgetSnapshot,
  describeBudgetLimit,
  dispatchViolation,
  hasWorkingAgents,
  renewBudgetWindow,
  runtimeViolations,
  type BudgetLimit,
} from './budget.js';
import { DEFAULT_MAX_HANDOFF_CHAIN, StuckDetector, handoffLoop } from './stuck-detector.js';
import { buildContextEnvelope, type ContextPurpose } from './context-manager.js';
import { dataBlockNotice, dataBoundary, neutralizeReservedLines, renderDataBlock } from './data-block.js';
import { activitySummary } from './insights.js';
import { classifyError } from './error-classifier.js';
import {
  AdapterPreconditionError,
  AdapterSessionClosedError,
  ApprovalConflictError,
  BudgetExhaustedError,
  BudgetInputError,
  GateActionError,
  InvalidAgentError,
  SessionResumeBlockedError,
  TaskBlockedError,
  TaskTerminalError,
  AgentInterruptError,
  WorkspaceBusyError,
  DailyBudgetError,
  CheckpointError,
  TestConfigChangedError,
  TransitionRejectedError,
  WorkspaceRejectedError,
} from './errors.js';
import { EventBus } from './event-bus.js';
import { KeyedLock } from './keyed-lock.js';
import { completedSideEffectIdsFromEvents, projectEvent } from './projection.js';
import { DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS, evaluateApprovalPolicy, type ApprovalPolicySource } from './policy.js';
import { SessionOwnershipError, SessionRegistry } from './session-registry.js';
import { RUN_SNAPSHOT_SCHEMA_VERSION } from './snapshot.js';
import { assertTransition, canTransition, isTerminal } from './state-machine.js';
import { TEST_CONFIG_INPUT_ID, TEST_CONFIG_UNREADABLE_PATH, diffTestConfig, rebaseTrustedTestConfig, testConfigDigest, testConfigPrompt, unreadableTestConfig } from './test-config.js';
import { REVIEW_GATE_INPUT_ID, decide, firstDirective, initWorkflow, resumeStep, stepAgent, stepMode, type WorkflowDirective, type WorkflowSignal } from './workflow.js';
import { isReadOnlyAgentMode } from './types.js';
import type {
  AgentAdapter,
  AgentMode,
  AgentResumeInput,
  AgentStartInput,
  ApprovalDecision,
  BudgetSnapshot,
  ControlPlaneStore,
  EventConfidence,
  EventSeverity,
  EventSink,
  EventType,
  HandoffPolicy,
  NormalizedError,
  PendingConsult,
  PendingHandoff,
  RunLoadResult,
  RunSettings,
  RunSnapshot,
  RunWorkspace,
  SessionSnapshot,
  TaskBudget,
  TaskRecord,
  TaskStatus,
  TestConfigFingerprint,
  TestConfigGuard,
  TestConfigReview,
  UnifiedEvent,
  WorkflowStep,
  WorkspaceCheckpointer,
  WorkspaceDiff,
  IsolationStatus,
} from './types.js';

export interface CreateTaskInput {
  projectId?: string;
  title: string;
  prompt: string;
  agentId?: string;
  /** 'implementation-v1'（預設，確定性工作流）或 'manual'（只啟動一個 agent，由操作員驅動）。 */
  workflow?: string;
  budget?: Partial<TaskBudget>;
  /** 測試命令（例如 `npm test`）；為空時跳過測試步驟。 */
  testCommand?: string;
  /** 通過後是否停在人工評審閘門。 */
  reviewGate?: boolean;
  /** 任務工作目錄。 */
  cwd?: string;
  reviewAgentId?: string;
  testAgentId?: string;
  /** 工作區來源資訊（例如服務端為任務建立的 worktree）。 */
  workspace?: { kind: 'directory' | 'worktree'; repoPath?: string; branch?: string };
  /** 顯式允許與其他任務共享工作區。 */
  sharedWorkspace?: boolean;
  /** agent 主動請求交接時的策略（預設 ask）。 */
  handoffPolicy?: HandoffPolicy;
  /** 對話模式：第一條訊息同時發給所有可對話的 agent（主 agent 可寫，其餘唯讀給意見）。 */
  askBoth?: boolean;
  /** 步驟不活動看門狗的閾值（毫秒）；預設用編排器的預設值，0 表示關閉（P0-6）。 */
  inactivityTimeoutMs?: number;
  /**
   * 對話任務發給 agent 的首條訊息（預設就是 prompt，P0 第三批審查）：「繼續對話」在這裡帶上前情提要（資料區塊，見 buildContinuationPrompt），
   * task.prompt 仍只記錄操作員這次寫的話——之後「換人接手」時前情提要不會進入指令區。
   */
  firstMessage?: string;
  /** 多個實現擇一（P2-11 best-of-N）：同一組的任務各做一份，之後選一個合入。 */
  group?: { id: string; index: number; size: number };
}

/** 自動放行 agent 交接的次數上限：超出後回退為人工審批，防止 agent 之間來回踢皮球。 */
export const DEFAULT_MAX_AUTO_HANDOFFS = 4;

/**
 * 步驟不活動看門狗的預設閾值：15 分鐘（P0-6）。
 * 真實模型的一輪可能要好幾分鐘，單個工具呼叫也可能跑到 10 分鐘（Claude Code 的 Bash 上限、測試執行器的預設超時都是 10 分鐘），
 * 其間可能沒有任何落盤事件；閾值必須比它們長，免得把正常的長操作當成卡住。逐字流式輸出也算有動靜，等待人工（審批、閘門）的時間不計入。
 * 15 分鐘仍然只有原來 30 分鐘時長預算兜底的一半，而且觸發後先自動重試，而不是直接阻塞。
 */
export const DEFAULT_STEP_INACTIVITY_MS = 15 * 60_000;

/** 看門狗發現步驟沒有動靜時寫入 runtime.error 的錯誤碼（data.source = 'watchdog'）。 */
export const STEP_INACTIVITY_TIMEOUT = 'STEP_INACTIVITY_TIMEOUT';

const ACTIVE_AGENT_STATUSES = new Set(['starting', 'planning', 'coding', 'reviewing', 'testing']);
const clipText = (text: string, max = 3000) => (text.length > max ? `…${text.slice(-max)}` : text);

/**
 * 人工閘門的操作：accept 接受結果；review 請求一輪評審；retry 帶說明讓實現者繼續；
 * rerun 把阻塞的這一步交還給負責它的 agent 重做（P0 第二批審查：失敗 / 卡住的是診斷或評審的 agent 時，「重試」要重跑那一步）。
 */
export type GateAction = 'accept' | 'review' | 'retry' | 'rerun';

/** 發給 agent 的訊息來源：編排器（工作流/上下文信封）或操作員。 */
export type MessageSource = 'orchestrator' | 'operator' | 'handoff';

/** 操作員發訊息 / 同時問兩個 / 轉交時的附加選項（P0-7）。 */
export interface OperatorSendOptions {
  /**
   * 對話任務已阻塞時，先顯式恢復再傳送（操作員已經確認過）：因預算阻塞的會先放寬預算（開新的計數視窗）。
   * 不帶它時，向已阻塞的對話任務發訊息得到 409 TASK_BLOCKED，什麼都不會發給 agent。
   * 工作流任務忽略它：工作流離開 BLOCKED 只能經人工閘門、換人接手或放寬預算。
   */
  resume?: boolean;
}

/** 審批的附加選項（P0 第二批審查）。 */
export interface ApprovalOptions {
  /**
   * 批准交接請求時對話任務已阻塞：先顯式恢復任務再執行交接（介面上是使用者確認後的「恢復並轉交」；因預算阻塞的會先放寬預算）。
   * 不帶它時得到 409 TASK_BLOCKED，審批保持待處理，什麼都不會執行。其他審批忽略它。
   */
  resume?: boolean;
  /** 回答 AI 的問題（P2-6，kind = 'question' 的審批）：問題 ID → 答案。 */
  answers?: Record<string, string[]>;
}

/** 預算調整（P0-7，預算 API）。 */
export interface BudgetAdjustment {
  /** 要設定的新限額（只改給出的那幾項）。 */
  limits?: Partial<TaskBudget>;
  /** 放寬預算：開一個新的計數視窗（再給一份同樣的額度，停滯計數清零）。 */
  relax?: boolean;
  /** 因預算而阻塞的任務在調整之後是否恢復（預設 true）。 */
  resume?: boolean;
}

export interface BudgetAdjustResult {
  /** 實際改變的限額：from → to。 */
  changes: Partial<Record<BudgetLimit, { from: number | undefined; to: number }>>;
  /** 是否開了新的計數視窗。 */
  renewed: boolean;
  /** 因預算阻塞的任務是否已經恢復。 */
  resumed: boolean;
  status: TaskStatus;
  /** 沒有恢復時的中文說明。 */
  message?: string;
  budget: BudgetSnapshot;
}

/** 放寬預算之後，讓被預算停止打斷的對話 agent 接著做時發給它的說明。 */
const BUDGET_RESUME_MESSAGE =
  '[Orchestrator note] Your previous turn was stopped because the task reached its budget limit. The operator has raised the budget. Check the current state of the workspace, then continue from where you stopped.';

/** 編排器自己的狀態遷移事件：它們被狀態機拒絕時要顯式留下 TRANSITION_REJECTED 警告（P0-7）。 */
const TRANSITION_EVENT_TYPES: ReadonlySet<EventType> = new Set(['run.status', 'run.completed', 'run.failed']);

const STATUS_TEXT: Record<string, string> = {
  CREATED: '已建立',
  QUEUED: '排隊中',
  RUNNING: '執行中',
  WAITING_INPUT: '等待你決定',
  WAITING_APPROVAL: '等待審批',
  BLOCKED: '已阻塞',
  FAILED: '失敗',
  CANCELLED: '已停止',
  COMPLETED: '已完成',
};

export interface OrchestratorOptions {
  /** 本程序實例 ID，寫入會話歸屬資訊。 */
  instanceId?: string;
  /** 可注入時鐘，便於測試時長預算。 */
  now?: () => number;
  /** 任務未指定工作目錄時使用的預設工作區。 */
  defaultCwd?: string;
  /**
   * 工作區策略：'exclusive'（預設）= 同一工作區同一時間只允許一個有寫權限的任務；
   * 'shared' = 全域性允許共享（僅用於不會寫檔案的 mock 執行時）。
   */
  workspacePolicy?: 'exclusive' | 'shared';
  /** 日誌出口（編排反應失敗等）；預設寫 stderr。 */
  log?: (message: string, error?: unknown) => void;
  /**
   * 單實例租約（P0-3）。提供時，recover() 只有在租約仍由本實例持有時才會執行——
   * 恢復會把會話歸屬轉移到本實例，必須先確認上一任的租約已經失效。預設不檢查（測試、記憶體儲存）。
   */
  instanceLease?: { isHeld(): boolean };
  /**
   * 工作目錄守衛（P0-10 / H-16）：返回問題說明表示 agent 不能在這個目錄裡工作（例如它與控制面資料互相包含）。
   * 新建任務、啟動 agent、續接會話（包括重啟恢復）之前都會檢查；不合規時新建任務返回 400，其餘 fail closed 為帶原因的 BLOCKED。
   * 預設不檢查（測試、記憶體儲存）。
   */
  workspaceGuard?: (cwd: string) => string | undefined;
  /**
   * 步驟不活動看門狗的預設閾值（毫秒，P0-6）：新建任務時寫進 RunSettings.inactivityTimeoutMs；0 表示關閉。
   * 預設 DEFAULT_STEP_INACTIVITY_MS。服務端從環境變數 ACC_STEP_INACTIVITY_MS 讀取。
   */
  inactivityTimeoutMs?: number;
  /**
   * 測試配置守衛（P0-8 / H-15）：讀取測試相關配置（package.json 的 scripts、測試框架配置、testCommand 直接引用的腳本）的指紋。
   * 提供時：任務建立時記下基線；工作流每次進入測試步驟之前、操作員手動重跑測試之前重新讀取比較，
   * 和基線不一致就先請操作員確認（工作流進入 WAITING_INPUT，並附上逐檔案的差異），確認後才執行。
   * 預設不檢查（測試、記憶體儲存）。服務端注入 @acc/adapters 的 createLocalTestConfigGuard()。
   */
  testConfigGuard?: TestConfigGuard;
  /**
   * 等 adapter.cancel 返回的最長時間（毫秒，P0 第二批審查）；預設 DEFAULT_CANCEL_TIMEOUT_MS。
   * 執行時連中斷都不響應時，停止任務、預算停止和看門狗不會被一個卡死的 cancel 拖住：超時後照常往下走，
   * 這個會話記為“取消未完成”，下一次停止時再取消一次。
   */
  cancelTimeoutMs?: number;
  /**
   * 空閒會話回收閾值（毫秒，P1-5 / M-6）；預設 DEFAULT_IDLE_SESSION_MS，0 表示關閉。
   * 會話答完話、沒有掛起的審批、超過這個時間沒有任何動靜時，靜默釋放它的執行時程序（每個 Claude CLI 常駐幾百 MB）；
   * 下一條訊息自動用原生會話 ID 續接，對話上下文不丟。只對實現了 AgentAdapter.release 的 adapter 生效。
   */
  idleSessionMs?: number;
  /** 新任務預設的美元花費上限（估算，P1-7）；預設不限。建立任務時顯式給出的 budget.maxCostUsd 優先。 */
  defaultMaxCostUsd?: number;
  /**
   * 交接有向邊白名單（P2-5）：例如 ['claude>codex', 'codex>*']；agent 請求的交接（包括諮詢）不在名單裡時直接拒絕。
   * 預設不限（任何可對話的 agent 之間都可以請求）。
   */
  handoffEdges?: readonly string[];
  /** 工作區檢查點（P2-3）：每一輪做完後給工作區拍快照，可以檢視改動和撤銷一輪。預設不啟用。 */
  checkpointer?: WorkspaceCheckpointer;
  /** 審批策略（P2-7）：按規則 / 自主度自動放行非高風險的審批。預設不啟用（全部交給人）。 */
  approvalPolicy?: ApprovalPolicySource;
  /** 連續自動放行的上限（P2-7），達到後交給人確認一次；預設 DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS。 */
  maxConsecutiveAutoApprovals?: number;
  /** AI 提的問題多久沒人回答就跳過（P2-6，毫秒；0 / 預設 = 一直等）。跳過時 AI 自己判斷。 */
  questionTimeoutMs?: number;
  /** 全域性每日估算花費上限（美元，P1-7）：所有任務今天加起來達到後不再派發新的模型呼叫；預設不限。 */
  dailyMaxCostUsd?: number;
  /** 應用版本號（P1-14，寫進新任務的快照，便於排查“由哪個版本建立”）。 */
  appVersion?: string;
  /** 連續恢復多少次仍沒有任何一輪做完就不再自動續跑；預設 DEFAULT_MAX_RECOVERY_STREAK。 */
  maxRecoveryStreak?: number;
}

/**
 * 編排行為版本（P1-14）：工作流、恢復或交接的語義發生不相容變化時加一。
 * 快照記錄建立它的行為版本；版本不同的在途任務重啟後不自動續跑（避免新程式按新語義接著跑舊程式做了一半的步驟），等操作員處理。
 */
export const BEHAVIOR_VERSION = 1;

/** 連續恢復多少次仍沒有任何一輪做完，就不再自動續跑（P1-14）。 */
export const DEFAULT_MAX_RECOVERY_STREAK = 3;

/** 空閒會話回收的預設閾值：10 分鐘。 */
export const DEFAULT_IDLE_SESSION_MS = 10 * 60_000;

/** 等 adapter.cancel 返回的預設最長時間：Claude 的中斷請求自己最多等 5 秒，超時後直接結束程序，這裡留足餘量。 */
export const DEFAULT_CANCEL_TIMEOUT_MS = 15_000;

/** 未持有單實例租約時拒絕恢復的錯誤資訊。 */
export const INSTANCE_LEASE_NOT_HELD = 'Instance lease not held: refusing to recover runs or transfer session ownership';

/** 編排反應失敗時寫入 runtime.error 的錯誤碼：來源是編排器自身，不算 provider 的錯。 */
export const ORCHESTRATOR_REACTION_FAILED = 'ORCHESTRATOR_REACTION_FAILED';

/** 標記失敗的是哪一個編排反應（寫進 runtime.error，便於定位）。 */
class ReactionFailure extends Error {
  constructor(
    readonly reaction: string,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'ReactionFailure';
  }
}

async function runReaction(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    throw new ReactionFailure(name, error);
  }
}

export interface RecoveryReport {
  /** 已透過 adapter.resume 重新接上的 run。 */
  resumed: string[];
  /** 仍在等待審批/輸入的 run（審批身份已從快照恢復）。 */
  waiting: string[];
  /** 無法證明執行時狀態、已 fail closed 進入 BLOCKED 的 run。 */
  blocked: string[];
  /** 快照 schema 未知或損壞、只能人工處理的 run。 */
  failedClosed: string[];
}

type PublishInput = {
  /** 預先生成的事件 ID（審批的鎖內原子消費用它把前置條件關聯到這個事件）。 */
  id?: string;
  type: EventType;
  severity?: EventSeverity;
  confidence?: EventConfidence;
  agentId?: string;
  sessionId?: string;
  data: Record<string, unknown>;
};

/**
 * 不觸發預算檢查的事件（P0-7）：預算事件本身（避免遞迴），以及編排器自己的狀態遷移——
 * 閘門、恢復、審批結束回到 RUNNING 這些遷移不是 agent 在消耗預算，不能在它們身上檢查預算
 * （以前評審閘門停留 30 分鐘後點 accept，閘門自己的 RUNNING 就觸發了時長預算，任務永遠完成不了）。
 */
/** 原地打轉檢測關心的事件（P1-8）。 */
const LOOP_WATCHED_EVENTS: ReadonlySet<EventType> = new Set(['tool.started', 'tool.completed', 'tool.failed', 'agent.message']);

const BUDGET_EXEMPT_EVENT_TYPES: ReadonlySet<EventType> = new Set(['budget.exceeded', 'budget.stalled', 'budget.extended', 'run.started', 'run.status', 'run.completed', 'run.failed']);

/** 派發的附加資訊（P0-7）。 */
interface DispatchOptions {
  /** 這是操作員的一條新指令：停滯計數清零；對話任務開一個新的預算視窗。 */
  renew?: boolean;
  /** 已經預先領到的派發許可（Ask Both 扇出前一次性扣掉全部呼叫），不再單獨扣預算。 */
  ticket?: DispatchTicket;
  /**
   * 這一輪要求的模式（P0-9）：Ask Both 的顧問為 analysis（唯讀）。新會話以它啟動；已有會話按“會話啟動模式與它裡更嚴格的那個”執行，
   * 只會收緊、絕不放寬。預設按原來的規則。
   */
  mode?: AgentMode;
}

/** createTask 的全域性命令鍵：“工作區檢查 + 提交”在它之下原子完成。 */
const CREATE_TASK_KEY = 'create-task';

/**
 * 派發許可（P0-5 / H-6）：鎖內確認 run 允許派發並扣掉呼叫預算時發出。
 * epoch 是當時的“停止代數”：adapter.start / resume 返回後若代數變了（期間發生過取消、預算停止或接受結果），
 * 剛啟動的會話立刻被取消，不登記為線上。
 */
interface DispatchTicket {
  epoch: number;
}

/** 本程序內線上會話的登記：屬於哪個 run、哪個 agent。 */
interface LiveSession {
  runId: string;
  agentId: string;
}

export class Orchestrator {
  readonly instanceId: string;
  private adapters = new Map<string, AgentAdapter>();
  /**
   * 本程序內已啟動/已續接的會話：adapterSessionKey -> { runId, agentId }。重啟後為空，必須走 resume。
   * 按 run 遍歷它就是“該 run 的全部線上會話”（H-5：終止與恢復不再只看 currentAgentId）。
   */
  private liveSessions = new Map<string, LiveSession>();
  /**
   * 已經結束（failed / 執行時關閉）、移出線上表的會話（H-11）：之後對它的派發一律走 resume，不再 send 給一個可能已經關閉的會話。
   * 執行時可能還在（例如 Claude 只是這一輪失敗、CLI 仍在等下一條訊息），所以停止任務、關閉服務時仍要取消它們。
   */
  private retiredSessions = new Map<string, LiveSession>();
  /**
   * 每個會話最近一次 agent.started 與最近一次“會話結束”事件（failed / cancelled / sessionClosed）的序號。
   * adapter.start / resume 返回之後據此判斷：這期間會話是不是已經結束了（結束了就不登記為線上）。
   */
  private sessionMarks = new Map<string, { started: number; ended: number }>();
  /** 逐字流式輸出（臨時事件，不落盤）最近一次到達的時間：`${runId}\0${agentId}` → 編排器時鐘（看門狗用）。 */
  private streamActivity = new Map<string, number>();
  /** 正在執行看門狗動作的 run：定時檢查重疊時不重複觸發。 */
  private watchdogBusy = new Set<string>();
  /**
   * run 鎖：只保護“讀取快照 → 投影 → 原子提交”。不可重入；持有期間禁止 publish 事件、禁止呼叫 adapter（防死鎖的既有不變數）。
   */
  private locks = new KeyedLock();
  /**
   * 操作員命令佇列（P0-5）：同一任務的公共命令（發訊息、交接、Ask Both、換人接手、審批、閘門、策略）按到達順序一個一個執行；
   * createTask 用全域性鍵 CREATE_TASK_KEY。它不是 run 鎖：命令裡照常發事件、調 adapter；編排反應不進這個佇列。
   * 停止（cancelTask）是搶佔式的：不等排在前面的命令，但之後到達的命令排在它後面。
   */
  private commands = new KeyedLock();
  /**
   * 按 (run, agent) 的派發鎖：“有會話就傳送、沒有就啟動 / 續接”在它之下一次完成，
   * 操作員命令與編排反應同時找同一個 agent 時不會各自啟動一個會話（不再出現 SessionOwnershipError）。同樣不是 run 鎖。
   */
  private agentLocks = new KeyedLock();
  /** 每個 run 的停止代數：取消、預算停止、接受結果時 +1（見 DispatchTicket）。只在本程序內有意義。 */
  private stopEpochs = new Map<string, number>();
  /** 已經由編排器取消過的會話 key：同一會話不重複取消（例如預算停止之後啟動才返回）。續接後重新線上時移除。 */
  private cancelledKeys = new Set<string>();
  /**
   * 已經發起取消、adapter.cancel 還沒有完成的會話（P0 第二批審查）：執行時連中斷都不響應時 cancel 可能一直不返回。
   * 這些會話在停止任務、預算停止時再取消一次（adapter 的 cancel 是冪等的，第二次會直接結束程序）。續接後重新線上時移除。
   */
  private pendingCancels = new Map<string, LiveSession>();
  /**
   * 正在派發（啟動 / 續接 / 傳送還沒有返回）的 (run, agent) 計數：這期間會話可能還沒登記為線上，但 agent 已經算“正在工作”。
   * 清理殘留的“正在工作”時據此跳過它們。
   */
  private dispatching = new Map<string, number>();
  /**
   * 審批的鎖內原子消費（H-12）：approval.resolved 事件 ID → 它要消費的審批 ID。
   * 持久化階段（run 鎖內）先確認該審批仍待處理、run 不是終態，才提交這個事件；否則事件不落盤，釋出方得到 409。
   */
  private approvalClaims = new Map<string, string>();
  /** 正在進行的停止（重複點選「停止」時共用同一次）。 */
  private cancelling = new Map<string, Promise<void>>();
  /** 會話歸屬登記：同一會話只能有一個 adapter/runtime 持有者。 */
  readonly sessions = new SessionRegistry();
  private enforcing = new Set<string>();
  /** 服務正在關閉：不再啟動或續接任何執行時。 */
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private readonly now: () => number;
  private readonly defaultCwd?: string;
  private readonly workspacePolicy: 'exclusive' | 'shared';
  private readonly log: (message: string, error?: unknown) => void;
  private readonly instanceLease?: { isHeld(): boolean };
  private readonly workspaceGuard?: (cwd: string) => string | undefined;
  private readonly inactivityTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly idleSessionMs: number;
  private readonly defaultMaxCostUsd?: number;
  private readonly appVersion?: string;
  private readonly dailyMaxCostUsd?: number;
  private readonly checkpointer?: WorkspaceCheckpointer;
  private readonly handoffEdges?: readonly string[];
  private readonly approvalPolicy?: ApprovalPolicySource;
  private readonly maxConsecutiveAutoApprovals: number;
  private readonly questionTimeoutMs: number;
  /** 進行中的檢查點操作（git 子程序）：關閉時等它們結束，免得程序退出或目錄被刪除時還有 git 在工作區裡執行。 */
  private readonly checkpointOps = new Set<Promise<unknown>>();
  /** 今天花費的快取（30 秒內複用，避免每次派發都掃描全部用量記錄）。 */
  private dailySpendCache?: { at: number; day: number; value: number };
  private readonly maxRecoveryStreak: number;
  /** 原地打轉檢測（P1-8）：同一個呼叫反覆執行、同一個錯誤反覆出現。 */
  private stuck = new StuckDetector();
  /** 最近一次操作員指令之後，agent 主動發起的交接（P1-8：來回往返與鏈長度）。 */
  private handoffChains = new Map<string, Array<{ from: string; to: string }>>();
  /** 每個 (run, agent) 最近一次有事件（落盤或逐字流式）的時刻，用於空閒會話回收。 */
  private sessionActivity = new Map<string, number>();
  private readonly testConfigGuard?: TestConfigGuard;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly events: EventBus,
    options: OrchestratorOptions = {},
  ) {
    this.instanceId = options.instanceId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.defaultCwd = options.defaultCwd;
    this.workspacePolicy = options.workspacePolicy ?? 'exclusive';
    this.log = options.log ?? ((message, error) => console.error(`[acc] ${message}`, error ?? ''));
    this.instanceLease = options.instanceLease;
    this.workspaceGuard = options.workspaceGuard;
    this.inactivityTimeoutMs = validInactivityTimeout(options.inactivityTimeoutMs ?? DEFAULT_STEP_INACTIVITY_MS, 'inactivityTimeoutMs');
    this.cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_CANCEL_TIMEOUT_MS;
    this.idleSessionMs = Math.max(0, options.idleSessionMs ?? DEFAULT_IDLE_SESSION_MS);
    this.defaultMaxCostUsd = options.defaultMaxCostUsd;
    this.appVersion = options.appVersion;
    this.dailyMaxCostUsd = options.dailyMaxCostUsd;
    this.checkpointer = options.checkpointer;
    this.handoffEdges = options.handoffEdges?.length ? options.handoffEdges : undefined;
    this.approvalPolicy = options.approvalPolicy;
    this.maxConsecutiveAutoApprovals = options.maxConsecutiveAutoApprovals ?? DEFAULT_MAX_CONSECUTIVE_AUTO_APPROVALS;
    this.questionTimeoutMs = options.questionTimeoutMs ?? 0;
    this.maxRecoveryStreak = Math.max(1, options.maxRecoveryStreak ?? DEFAULT_MAX_RECOVERY_STREAK);
    this.testConfigGuard = options.testConfigGuard;
    // 逐字流式輸出不落盤、不經過編排反應，但它說明 agent 還在幹活：看門狗要把它算作“有動靜”
    this.events.subscribeEphemeral((event) => {
      if (event.agentId) {
        this.streamActivity.set(activityKey(event.runId, event.agentId), this.now());
        this.sessionActivity.set(activityKey(event.runId, event.agentId), this.now());
      }
    });
    // 落盤的事件同樣說明會話有動靜（包括髮給 agent 的訊息）：空閒回收以此計時
    this.events.subscribe(
      (event) => {
        if (event.agentId) this.sessionActivity.set(activityKey(event.runId, event.agentId), this.now());
        // 有新的用量（可能帶花費）：今天花費的快取作廢（P1-7 每日上限）
        if (event.type === 'model.turn.completed') this.dailySpendCache = undefined;
      },
      { phase: 'normal' },
    );
    // 持久化階段：事件與快照同事務落盤；失敗時 publish reject
    this.events.subscribe((event) => this.handleEvent(event), { phase: 'persist' });
    // 反應階段：按 run 序列的非同步佇列，與 adapter 的 emit 呼叫棧脫鉤（H-2）。
    // 反應裡的異常不會回到 adapter，而是轉成該 run 的編排器 runtime.error 並 fail closed。
    this.events.subscribe((event) => this.react(event), { phase: 'post', onError: (error, event) => this.onReactionFailed(event, error) });
  }

  /**
   * 等待編排反應佇列清空（測試與優雅關閉用）：包括等待期間新產生的反應。
   * 只等編排器自己的反應，不等 adapter 的後台工作（例如仍在進行的模型輪次）。不要在反應內部呼叫。
   */
  idle(runId?: string): Promise<void> {
    return this.events.drain(runId);
  }

  /**
   * 停止本程序內全部 agent 執行時（服務關閉、單實例租約丟失時呼叫）。可重複呼叫。
   *
   * 不發任何事件、不改持久化狀態：重啟後 recover 按快照原樣續接（同一個 provider 會話始終只有一個執行時）。
   * 實現了 dispose 的 adapter 呼叫 dispose；其餘 adapter 對每個線上會話呼叫 cancel，發出的事件直接丟棄。
   * 同步部分（標記 + 通知各 adapter 立即中止）在返回之前就已完成：租約丟失時呼叫方可以緊接著關閉資料庫。
   * 之後不再啟動或續接任何執行時。
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.stopRuntimes();
    return this.shutdownPromise;
  }

  private stopRuntimes(): Promise<void> {
    this.stopping = true;
    const discard: EventSink = () => undefined;
    const pending: Array<Promise<unknown>> = [];
    for (const adapter of this.adapters.values()) {
      try {
        if (adapter.dispose) {
          pending.push(Promise.resolve(adapter.dispose()));
          continue;
        }
        for (const [key, live] of [...this.liveSessions, ...this.retiredSessions]) {
          if (live.agentId === adapter.info.id) pending.push(adapter.cancel(key, discard));
        }
      } catch (error) {
        pending.push(Promise.reject(error));
      }
    }
    this.liveSessions.clear();
    this.retiredSessions.clear();
    pending.push(...this.checkpointOps);
    return Promise.allSettled(pending).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') this.log('failed to stop an agent runtime during shutdown', result.reason);
      }
    });
  }

  /** 一個事件引發的全部編排反應（依次執行；任一失敗即停止並交給 onReactionFailed）。 */
  private async react(event: UnifiedEvent): Promise<void> {
    if (!BUDGET_EXEMPT_EVENT_TYPES.has(event.type)) await runReaction('budget', () => this.enforceBudget(event.runId));
    await runReaction('workflow', () => this.onAgentSignal(event));
    // run 回到 RUNNING（審批結束等）：重放等待審批期間快取下來的完成 / 失敗訊號（H-9）
    if (event.type === 'approval.resolved' || (event.type === 'run.status' && event.data.status === 'RUNNING')) {
      await runReaction('workflow', () => this.replayDeferredSignal(event));
    }
    if (LOOP_WATCHED_EVENTS.has(event.type)) await runReaction('loop', () => this.onLoopSignal(event));
    // 審批策略（P2-7）：符合規則 / 自主度的非高風險審批自動放行（交接與提問一律交給人）
    if (event.type === 'approval.required' && this.approvalPolicy && event.data.kind !== 'handoff' && event.data.kind !== 'question') {
      await runReaction('approval-policy', () => this.onApprovalPolicy(event));
    }
    // 被諮詢的 agent 這一輪結束（P2-5）：把答覆交回提問的 agent
    if (event.type === 'agent.status' && ['completed', 'failed', 'cancelled'].includes(String(event.data.status)) && event.agentId) {
      await runReaction('consult', () => this.onConsultTurnEnded(event));
    }
    // 一輪做完（成功、失敗或被停下）：給工作區拍一個檢查點（P2-3）；測試執行器不改檔案，不拍
    if (event.type === 'agent.status' && ['completed', 'failed', 'cancelled'].includes(String(event.data.status)) && event.agentId && this.adapters.get(event.agentId)?.info.kind !== 'test') {
      await runReaction('checkpoint', () => this.onTurnEndedCheckpoint(event));
    }
    if (event.type === 'runtime.warning' && event.data.code === 'APPROVAL_WITHDRAWN') await runReaction('approval-withdrawn', () => this.onApprovalWithdrawn(event));
    if (event.type === 'handoff.requested' && event.data.origin === 'agent') await runReaction('handoff-request', () => this.onAgentHandoffRequest(event));
    if (event.type === 'approval.required') await runReaction('late-approval', () => this.onApprovalAfterTerminal(event));
  }

  /**
   * 原地打轉（P1-8）：同一個 agent 用同樣的引數反覆呼叫同一個工具、或者反覆得到同樣的錯誤時，
   * 停下它這一輪，任務進入帶原因的 BLOCKED，由操作員決定（補充說明重試、換人接手或停止）。
   * 操作員發來新指令時，交接鏈計數清零。
   */
  private async onLoopSignal(event: UnifiedEvent): Promise<void> {
    if (event.type === 'agent.message' && event.data.direction === 'to-agent' && event.data.from === 'operator') this.handoffChains.delete(event.runId);
    const finding = this.stuck.observe(event);
    if (!finding) return;
    const loaded = await this.store.loadRun(event.runId);
    if (loaded?.status !== 'ok' || isTerminal(loaded.snapshot.status) || loaded.snapshot.status === 'BLOCKED') return;
    const task = await this.store.getTask(event.taskId);
    if (!task) return;
    await this.failClosed(task, 'LOOP_DETECTED', finding.message, finding.agentId, undefined, {
      pattern: finding.pattern,
      toolName: finding.toolName,
      count: finding.count,
      source: 'loop-guard',
    });
    // 停下它當前這一輪（不然它會繼續打轉下去）；之後再發訊息會接回原來的對話
    await this.cancelAgentSession(task, finding.agentId);
  }

  /**
   * 執行時自己撤回了一個審批請求（M-16：Claude 的權限請求被 abort、Codex 發出 serverRequest/resolved）：
   * 這個操作不會再執行，介面上的審批卡要自動結案，否則之後點批准只會失敗。記為編排器作廢（withdrawn，不會讓任務阻塞）。
   */
  private async onApprovalWithdrawn(event: UnifiedEvent): Promise<void> {
    const approvalId = typeof event.data.approvalId === 'string' ? event.data.approvalId : '';
    if (!approvalId || !event.sessionId) return;
    const loaded = await this.store.loadRun(event.runId);
    if (loaded?.status !== 'ok') return;
    const approval = loaded.snapshot.pendingApprovals.find((x) => x.id === approvalId && x.status === 'pending');
    if (!approval || approval.sessionId !== event.sessionId) return;
    const task = await this.store.getTask(event.taskId);
    if (!task) return;
    const eventId = randomUUID();
    this.approvalClaims.set(eventId, approvalId);
    try {
      await this.publish(task, {
        id: eventId,
        type: 'approval.resolved',
        severity: 'info',
        agentId: approval.agentId,
        sessionId: approval.sessionId,
        data: { approvalId, decision: 'decline', providerCallId: approval.providerCallId, resolvedBy: 'orchestrator', reason: 'withdrawn-by-runtime', withdrawn: true },
      });
    } catch (error) {
      // 操作員恰好同時處理了它（409）：以操作員的決定為準
      if (!(error instanceof ApprovalConflictError) && !(error instanceof TaskTerminalError)) throw error;
    } finally {
      this.approvalClaims.delete(eventId);
    }
  }

  /**
   * 預設的實現者（P1-17）：第一個（按註冊順序）不是測試執行器、並且宣告瞭 implement 能力的 agent；
   * 都沒有宣告時退回第一個不是測試執行器的 agent。
   */
  private defaultImplementer(): string {
    const agents = [...this.adapters.values()].filter((a) => a.info.kind !== 'test');
    const pick = agents.find((a) => a.info.capabilities.includes('implement')) ?? agents[0];
    if (!pick) throw new InvalidAgentError('沒有可以對話的 Agent：請先設定至少一個 AI。', '');
    return pick.info.id;
  }

  /**
   * 預設的評審者（P1-17）：實現者以外、宣告瞭 review 能力的第一個 agent；沒有人宣告時取實現者以外的第一個可對話 agent；
   * 只有一個 agent 時由實現者自己評審。
   */
  private defaultReviewer(implementer: string): string {
    const others = [...this.adapters.values()].filter((a) => a.info.kind !== 'test' && a.info.id !== implementer);
    const pick = others.find((a) => a.info.capabilities.includes('review')) ?? others[0];
    return pick?.info.id ?? implementer;
  }

  /** 預設的測試執行器（P1-17）：第一個 kind 為 test 的 adapter；沒有註冊時仍用約定的 id（沒有測試命令的任務用不到它）。 */
  private defaultTestAgent(): string {
    return [...this.adapters.values()].find((a) => a.info.kind === 'test')?.info.id ?? 'test';
  }

  /**
   * 這個 agent 在任務裡的預設模式（P1-17：按角色，不按 provider 名字）：
   * 測試執行器 → test；工作流任務裡的評審者（且不是實現者）→ review（唯讀）；其餘 → implement。
   */
  private roleMode(run: RunSnapshot, agentId: string): AgentMode {
    if (this.adapters.get(agentId)?.info.kind === 'test') return 'test';
    const ws = run.workflowState;
    if (ws && ws.agents.test === agentId) return 'test';
    if (ws && ws.agents.review === agentId && ws.agents.implement !== agentId) return 'review';
    return 'implement';
  }

  /**
   * 審批策略（P2-7）：審批還在等待、策略允許時以 resolvedBy=policy 自動批准（走與人工批准相同的一次性消費路徑，
   * 同時人工也點了批准時只有一個生效）。不允許時什麼都不做，審批照常等人。
   */
  private async onApprovalPolicy(event: UnifiedEvent): Promise<void> {
    const source = this.approvalPolicy;
    const approvalId = typeof event.data.approvalId === 'string' ? event.data.approvalId : undefined;
    if (!source || !approvalId || !event.agentId || this.stopping) return;
    const task = await this.store.getTask(event.taskId);
    const loaded = await this.store.loadRun(event.runId);
    if (!task || loaded?.status !== 'ok' || isTerminal(loaded.snapshot.status)) return;
    const run = loaded.snapshot;
    const approval = run.pendingApprovals.find((a) => a.id === approvalId && a.status === 'pending');
    if (!approval) return;
    const decision = evaluateApprovalPolicy(approval.payload ?? {}, approval.agentId, source, run.autoApprovals?.consecutive ?? 0, this.maxConsecutiveAutoApprovals);
    if (!decision.allow) return;
    try {
      await this.resolveApprovalNow(task.id, approvalId, 'approve', 'once', {}, { ruleId: decision.ruleId, reason: decision.reason, risk: decision.risk });
    } catch (error) {
      // 人工恰好先處理了（409）或任務已結束：以已有的結果為準
      if (!(error instanceof ApprovalConflictError) && !(error instanceof TaskTerminalError)) throw error;
    }
  }

  /** 交接有向邊白名單（P2-5）：'from>to'，to 可以是 *。 */
  private handoffEdgeAllowed(fromAgentId: string, toAgentId: string): boolean {
    if (!this.handoffEdges) return true;
    return this.handoffEdges.some((edge) => {
      const [from, to] = edge.split('>').map((part) => part.trim());
      return (from === fromAgentId || from === '*') && (to === toAgentId || to === '*');
    });
  }

  /**
   * 被諮詢的 agent 這一輪結束（P2-5）：取它在諮詢開始之後的回覆，作為一條新訊息交回提問的 agent；
   * 失敗或被停下時不派發，只記錄結果並告訴操作員。
   */
  private async onConsultTurnEnded(event: UnifiedEvent): Promise<void> {
    const task = await this.store.getTask(event.taskId);
    const loaded = await this.store.loadRun(event.runId);
    if (!task || loaded?.status !== 'ok') return;
    const run = loaded.snapshot;
    const consult: PendingConsult | undefined = (run.pendingConsults ?? []).find((c) => c.toAgentId === event.agentId && c.afterSequence < event.sequence);
    if (!consult) return;
    const status = String(event.data.status);
    if (status !== 'completed' || isTerminal(run.status)) {
      await this.publish(task, {
        type: 'consult.answered',
        agentId: consult.toAgentId,
        data: { consultId: consult.id, fromAgentId: consult.fromAgentId, toAgentId: consult.toAgentId, outcome: status, delivered: false, action: `${this.agentName(consult.toAgentId)} 沒有回答 ${this.agentName(consult.fromAgentId)} 的問題（${status}）` },
      });
      return;
    }
    const events = await this.store.listEvents(run.runId);
    const replies = events
      .filter((e) => e.type === 'agent.message' && e.data.direction === 'from-agent' && e.agentId === consult.toAgentId && e.sequence > consult.afterSequence && e.sequence < event.sequence)
      .map((e) => String(e.data.text ?? e.data.message ?? '').trim())
      .filter(Boolean);
    const answer = replies.at(-1) ?? '(no answer text)';
    await this.publish(task, {
      type: 'consult.answered',
      agentId: consult.toAgentId,
      data: { consultId: consult.id, fromAgentId: consult.fromAgentId, toAgentId: consult.toAgentId, outcome: 'completed', delivered: true, action: `${this.agentName(consult.toAgentId)} 回答了 ${this.agentName(consult.fromAgentId)} 的問題，答覆已交回` },
    });
    const boundary = dataBoundary([answer, consult.question]);
    const message = [
      `[Answer from ${consult.toAgentId} to your question]`,
      dataBlockNotice(boundary),
      '',
      renderDataBlock(boundary, `your question to ${consult.toAgentId}`, consult.question),
      '',
      renderDataBlock(boundary, `answer from ${consult.toAgentId}`, answer),
      '',
      '[Your task]',
      'Continue your work, taking the answer above into account.',
    ].join('\n');
    try {
      await this.deliver(task.id, consult.fromAgentId, message, 'handoff', { consultReply: true, fromAgentId: consult.toAgentId }, { renew: false });
    } catch (error) {
      // 任務已結束、已阻塞或預算不夠：答覆記在事件裡，不再派發
      if (!(error instanceof TaskTerminalError) && !(error instanceof TaskBlockedError) && !(error instanceof BudgetExhaustedError)) throw error;
    }
  }

  private async onTurnEndedCheckpoint(event: UnifiedEvent): Promise<void> {
    const task = await this.store.getTask(event.taskId);
    if (!task) return;
    await this.takeCheckpoint(task, event.agentId, `${this.agentName(event.agentId!)} 這一輪`);
  }

  /**
   * 拍一個檢查點（P2-3）：和上一個檢查點比沒有變化時不記錄。失敗（例如 git 出錯）只記日誌，不影響任務。
   * 返回新的檢查點序號（沒有記錄時 undefined）。
   */
  private takeCheckpoint(task: TaskRecord, agentId: string | undefined, label: string, restoreOf?: number): Promise<number | undefined> {
    if (!this.checkpointer || this.stopping) return Promise.resolve(undefined);
    const op = this.takeCheckpointNow(task, agentId, label, restoreOf);
    this.checkpointOps.add(op);
    void op.finally(() => this.checkpointOps.delete(op));
    return op;
  }

  private async takeCheckpointNow(task: TaskRecord, agentId: string | undefined, label: string, restoreOf?: number): Promise<number | undefined> {
    if (!this.checkpointer) return undefined;
    try {
      const run = await this.mustRun(task.runId);
      const cwd = taskCwd(run) ?? this.defaultCwd;
      if (!cwd) return undefined;
      const last = run.checkpoints?.at(-1);
      const seq = (last?.seq ?? -1) + 1;
      const snap = await this.checkpointer.snapshot(cwd, { taskId: task.id, seq, label, parent: last?.ref });
      if (!snap || (last && !snap.changed && restoreOf === undefined) || this.stopping) return undefined;
      const files = last ? ((await this.checkpointer.diff(cwd, last.ref, snap.ref))?.files.length ?? 0) : 0;
      await this.publish(task, {
        type: 'checkpoint.created',
        agentId,
        data: { seq, ref: snap.ref, agentId, label, files, ...(restoreOf !== undefined ? { restoreOf } : {}) },
      });
      return seq;
    } catch (error) {
      this.log(`checkpoint failed (task ${task.id})`, error);
      return undefined;
    }
  }

  /**
   * 檢視改動（P2-3 / P2-4）：給了 seq 時是這個檢查點相對上一個的改動（這一輪改了什麼）；
   * 沒給時是當前工作區相對任務開始時的全部改動。
   */
  async checkpointDiff(taskId: string, seq?: number): Promise<WorkspaceDiff & { from: number; to?: number }> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    const list = run.checkpoints ?? [];
    const cwd = taskCwd(run) ?? this.defaultCwd;
    if (!this.checkpointer || !cwd || list.length === 0) throw new CheckpointError('這個任務沒有檢查點（工作目錄不是 git 倉庫，或者功能沒有開啟），沒辦法顯示改動。');
    if (seq === undefined) {
      const diff = await this.checkpointer.diff(cwd, list[0]!.ref);
      if (!diff) throw new CheckpointError('工作目錄不是 git 倉庫，沒辦法顯示改動。');
      return { ...diff, from: list[0]!.seq };
    }
    const index = list.findIndex((c) => c.seq === seq);
    if (index <= 0) throw new CheckpointError(`找不到第 ${seq} 輪的檢查點（或者它是任務開始時的基線）。`);
    const diff = await this.checkpointer.diff(cwd, list[index - 1]!.ref, list[index]!.ref);
    if (!diff) throw new CheckpointError('工作目錄不是 git 倉庫，沒辦法顯示改動。');
    return { ...diff, from: list[index - 1]!.seq, to: seq };
  }

  /** 分叉用（P2-3）：任務第 seq 個檢查點的提交與它所在的工作目錄。 */
  async checkpointFor(taskId: string, seq: number): Promise<{ task: TaskRecord; ref: string; cwd: string; label: string }> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    const checkpoint = (run.checkpoints ?? []).find((c) => c.seq === seq);
    const cwd = taskCwd(run) ?? this.defaultCwd;
    if (!checkpoint || !cwd) throw new CheckpointError(`找不到第 ${seq} 個檢查點。`);
    return { task, ref: checkpoint.ref, cwd, label: checkpoint.label };
  }

  /**
   * 任務的 worktree 資訊（P2-4）：不是 worktree 任務時 worktree 為空。AI 正在工作時 busy 為 true（不能合入或清理）。
   */
  async taskWorktree(taskId: string): Promise<{ task: TaskRecord; run: RunSnapshot; busy: boolean; worktree?: { path: string; branch: string; repoRoot: string } }> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    const ws = run.workspace;
    const kind = ws?.kind ?? run.workflowState?.workspace?.kind;
    const branch = ws?.branch ?? run.workflowState?.workspace?.branch;
    const repoRoot = ws?.repoPath ?? run.workflowState?.workspace?.repoPath;
    const path = taskCwd(run);
    const busy = hasWorkingAgents(run.budget) || this.liveAgentIds(run.runId).some((id) => this.dispatching.has(activityKey(run.runId, id)));
    return { task, run, busy, ...(kind === 'worktree' && branch && repoRoot && path ? { worktree: { path, branch, repoRoot } } : {}) };
  }

  /** 記錄 worktree 的合入 / 清理（P2-4），在操作員命令佇列裡執行，結果進入事件日誌。 */
  async recordWorkspaceEvent(taskId: string, type: 'workspace.merged' | 'workspace.cleaned', data: Record<string, unknown>): Promise<void> {
    await this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      await this.publish(task, { type, data });
    });
  }

  /**
   * 撤銷最後一輪（P2-3）：把工作區恢復到上一個檢查點。追加事件（checkpoint.restored 與一個新的檢查點），不刪除任何歷史；
   * AI 正在工作時不允許（它會接著改檔案）。之後你手動改過的檔案如果也在這一輪的改動裡，同樣會被恢復。
   */
  async undoLastTurn(taskId: string): Promise<{ restored: string[]; to: number }> {
    return this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      const run = await this.mustRun(task.runId);
      const cwd = taskCwd(run) ?? this.defaultCwd;
      const list = run.checkpoints ?? [];
      // 當前工作區等於哪個檢查點：最後一個是撤銷產生的，就等於它恢復到的那個
      const last = list.at(-1);
      const current = last?.restoreOf ?? last?.seq;
      const index = list.findIndex((c) => c.seq === current);
      if (!this.checkpointer || !cwd || !last || index <= 0) throw new CheckpointError('沒有可以撤銷的一輪：AI 還沒有改動過檔案，或者已經撤銷到任務開始時了（也可能工作目錄不是 git 倉庫）。');
      if (hasWorkingAgents(run.budget) || this.liveAgentIds(run.runId).some((id) => this.dispatching.has(activityKey(run.runId, id)))) {
        throw new CheckpointError('AI 正在工作，現在撤銷會和它的改動互相覆蓋。請先等這一輪做完，或者按「停下這一輪」。');
      }
      // 撤銷的目標：當前狀態之前的那個檢查點（連續撤銷會一輪一輪往前退，不會變成“重做”）
      const target = list[index - 1]!;
      const { restored } = await this.checkpointer.restore(cwd, target.ref);
      await this.publish(task, {
        type: 'checkpoint.restored',
        data: { from: last.seq, to: target.seq, files: restored.length, restored: restored.slice(0, 50), action: `撤銷了一輪：${restored.length} 個檔案恢復到第 ${target.seq} 個檢查點` },
      });
      await this.takeCheckpoint(task, undefined, `撤銷到第 ${target.seq} 個檢查點`, target.seq);
      return { restored, to: target.seq };
    });
  }

  /** 今天（編排器時鐘的本地日期）所有任務的估算花費之和（P1-7）；30 秒內複用上一次的結果。 */
  private async dailySpend(): Promise<number> {
    const now = this.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const day = start.getTime();
    if (this.dailySpendCache && this.dailySpendCache.day === day && now - this.dailySpendCache.at < 30_000) return this.dailySpendCache.value;
    let total = 0;
    for (const task of await this.store.listTasks()) {
      if (task.updatedAt < day) continue;
      for (const usage of await this.store.listUsage(task.runId)) if (usage.createdAt >= day) total += usage.costUsd ?? 0;
    }
    this.dailySpendCache = { at: now, day, value: total };
    return total;
  }

  /** 該 run 當前在本程序內線上的 agent（按 id 排序）。同一 run 可能有多個（例如 Ask Both）。 */
  liveAgentIds(runId: string): string[] {
    const ids = new Set<string>();
    for (const live of this.liveSessions.values()) if (live.runId === runId) ids.add(live.agentId);
    return [...ids].sort();
  }

  /**
   * 終態之後才到的 approval.required（H-5）：投影已按拒絕記錄、沒有登記為待審批。
   * 這裡補一條 approval.resolved（介面與審計可見），會話仍線上時再通知 adapter 拒絕，讓它不再等待。
   */
  private async onApprovalAfterTerminal(event: UnifiedEvent): Promise<void> {
    const loaded = await this.store.loadRun(event.runId);
    if (loaded?.status !== 'ok' || !isTerminal(loaded.snapshot.status)) return;
    const approvalId = typeof event.data.approvalId === 'string' && event.data.approvalId ? event.data.approvalId : event.id;
    if (loaded.snapshot.pendingApprovals.some((x) => x.id === approvalId)) return;
    const task = await this.store.getTask(event.taskId);
    if (!task) return;
    const providerCallId = typeof event.data.providerCallId === 'string' ? event.data.providerCallId : undefined;
    await this.publish(task, {
      type: 'approval.resolved',
      severity: 'warning',
      agentId: event.agentId,
      sessionId: event.sessionId,
      data: { approvalId, decision: 'decline', providerCallId, resolvedBy: 'orchestrator', reason: 'run-terminal', runStatus: loaded.snapshot.status },
    });
    const adapter = event.agentId ? this.adapters.get(event.agentId) : undefined;
    if (!adapter?.approve || !event.sessionId || !this.liveSessions.has(event.sessionId)) return;
    try {
      await adapter.approve(event.sessionId, { approvalId, decision: 'decline', providerCallId }, this.adapterSink(task, adapter.info.id));
    } catch (error) {
      // 會話可能已經結束：拒絕通知送不到也不影響結論（審批已記錄為拒絕，不會執行）
      this.log(`failed to decline late approval ${approvalId} (run ${event.runId})`, error);
    }
  }

  /**
   * 編排反應失敗：這是編排器自身的問題，不是 provider 的錯——記為不帶 agentId、source=orchestrator 的
   * runtime.error，再按既有規則 fail closed（BLOCKED，等待操作員）。agent 會話不受影響，繼續存活。
   */
  private async onReactionFailed(event: UnifiedEvent, error: unknown): Promise<void> {
    const reaction = error instanceof ReactionFailure ? error.reaction : 'unknown';
    const original = error instanceof ReactionFailure ? error.original : error;
    const message = original instanceof Error ? original.message : String(original);
    this.log(`orchestrator reaction "${reaction}" failed on ${event.type} #${event.sequence} (run ${event.runId})`, original);
    // 斷路：處理“編排器出錯”事件本身的反應又失敗時只記錄日誌，
    // 否則一個持續存在的 bug 會讓錯誤事件不斷觸發新的錯誤事件，無限迴圈
    if (event.type === 'runtime.error' && event.data.code === ORCHESTRATOR_REACTION_FAILED) return;
    const task = await this.store.getTask(event.taskId);
    if (!task) return;
    await this.failClosed(task, ORCHESTRATOR_REACTION_FAILED, message, undefined, undefined, {
      source: 'orchestrator',
      reaction,
      triggerEventId: event.id,
      triggerEventType: event.type,
      triggerSequence: event.sequence,
      // 介面上顯示的原因（任務阻塞橫幅會接著給出可選操作）。如實說明：任務停在這一步等操作員處理，
      // 但 AI 可能還在完成當前這一輪（會話按設計繼續存活），要立即停下需要按「停止」
      action: '編排器內部出錯（不是 AI 的問題），任務已停在這一步等你處理；AI 可能還在完成當前這一輪，要立即停下請按「停止」',
    });
  }

  registerAdapter(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.info.id)) {
      throw new Error(`Adapter already registered: ${adapter.info.id}`);
    }
    this.adapters.set(adapter.info.id, adapter);
  }

  listAgents() {
    return [...this.adapters.values()].map((x) => x.info);
  }

  /** 各 agent 的執行隔離狀態（P2-8）：沒有實現 isolation 的 adapter 不列出；查詢失敗時如實說明。 */
  async agentIsolation(): Promise<Array<{ agentId: string; name: string; status: IsolationStatus }>> {
    const list = [...this.adapters.values()].filter((a) => a.isolation);
    return Promise.all(
      list.map(async (a) => {
        let status: IsolationStatus;
        try {
          status = await a.isolation!();
        } catch (error) {
          status = { level: 'degraded', ready: false, detail: `查詢失敗：${(error as Error).message}` };
        }
        return { agentId: a.info.id, name: a.info.name, status: { ...status, canSetup: status.canSetup === true && typeof a.setupIsolation === 'function' } };
      }),
    );
  }

  /** 配置某個 agent 的執行隔離（P2-8，操作員在介面上按按鈕觸發）。 */
  async setupAgentIsolation(agentId: string): Promise<{ ok: boolean; message: string }> {
    const adapter = this.mustAdapter(agentId);
    if (!adapter.setupIsolation) return { ok: false, message: '這個 Agent 不需要（或不支援）在這裡設定隔離。' };
    return adapter.setupIsolation();
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const now = this.now();
    const taskId = randomUUID();
    const runId = randomUUID();
    // 沒有指定時按能力選（P1-17）：第一個能實現程式碼的 agent（註冊順序），不寫死 provider
    const agentId = input.agentId ?? this.defaultImplementer();
    const workflow = input.workflow ?? 'implementation-v1';
    this.mustAdapter(agentId);
    // 全域性每日上限（P1-7）：已經用完時在寫入任何資料之前拒絕，不留下一個開了頭卻派發不出去的任務
    if (this.dailyMaxCostUsd !== undefined) {
      const spent = await this.dailySpend();
      if (spent >= this.dailyMaxCostUsd) {
        throw new DailyBudgetError(`今天所有任務加起來的估算花費已經達到上限（US$${spent.toFixed(2)} / US$${this.dailyMaxCostUsd}），這個任務沒有建立。明天會自動恢復；今天需要繼續的話，請調高或取消 ACC_DAILY_MAX_COST_USD 後重新啟動服務。`, { spentUsd: spent, limitUsd: this.dailyMaxCostUsd });
      }
    }
    const cwd = input.cwd ?? this.defaultCwd;
    const inactivityTimeoutMs = validInactivityTimeout(input.inactivityTimeoutMs ?? this.inactivityTimeoutMs, 'inactivityTimeoutMs');
    // 工作目錄守衛：與控制面資料互相包含等不合規的目錄，在寫入任何資料之前拒絕（HTTP 400）
    const workspaceProblem = cwd ? this.workspaceProblem(cwd) : undefined;
    if (workspaceProblem) throw new WorkspaceRejectedError(workspaceProblem);
    const workflowState =
      workflow === 'implementation-v1'
        ? initWorkflow({
            implementAgentId: agentId,
            reviewAgentId: input.reviewAgentId ?? this.defaultReviewer(agentId),
            testAgentId: input.testAgentId ?? this.defaultTestAgent(),
            testCommand: input.testCommand,
            reviewGate: input.reviewGate,
            cwd,
          })
        : undefined;
    if (workflowState?.testCommand) this.mustAdapter(workflowState.agents.test);
    // 評審 agent 寫錯時在落盤之前拒絕（P1-1 / M-8）：不能出現“已提交、卻因為找不到評審者而派發不出去”
    if (workflowState && !this.adapters.has(workflowState.agents.review)) {
      throw new InvalidAgentError(`找不到評審 Agent「${workflowState.agents.review}」，請選擇已設定的 Agent。`, workflowState.agents.review);
    }
    if (workflowState) {
      workflowState.workspace = input.workspace ?? (workflowState.cwd ? { kind: 'directory' } : undefined);
      workflowState.sharedWorkspace = input.sharedWorkspace === true;
    }
    // 測試配置的基線（H-15）：在任何 agent 開始工作之前記下。讀取失敗時不記基線，測試步驟之前按“無法確認”請操作員確認（fail closed）。
    // 同一目錄以前有過任務時（P0 第三批審查），沿用那裡最後一次可信（第一次採集或操作員確認過）的配置，而不是現在磁碟上的內容——
    // 上一個任務裡 AI 改了測試腳本、停在確認卡片時被停止，改動留在磁碟上；新任務不能把它當成基線自動執行
    if (workflowState?.testCommand && workflowState.cwd && this.testConfigGuard) {
      const current = await this.captureTestConfig(workflowState.cwd, workflowState.testCommand);
      const trusted = await this.trustedTestConfig(workflowState.cwd);
      if (trusted) {
        workflowState.testConfigBaseline = rebaseTrustedTestConfig(trusted.fingerprint, trusted.testCommand, current.ok ? current.fingerprint : undefined, workflowState.testCommand);
        workflowState.testConfigTrustedAt = trusted.at;
        // 任務開始時磁碟上的內容就和可信的配置不一樣：記下來，介面說明這些改動在任務開始前就有了
        const startDigest = testConfigDigest(current.fingerprint);
        if (current.ok && startDigest !== testConfigDigest(workflowState.testConfigBaseline)) workflowState.testConfigStartDigest = startDigest;
      } else if (current.ok) {
        workflowState.testConfigBaseline = current.fingerprint;
        workflowState.testConfigTrustedAt = now;
      }
    }

    const task: TaskRecord = {
      id: taskId,
      projectId: input.projectId ?? 'local',
      title: input.title,
      prompt: input.prompt,
      status: 'CREATED',
      workflow,
      runId,
      createdAt: now,
      updatedAt: now,
      currentAgentId: agentId,
    };

    const snapshot: RunSnapshot = {
      schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION,
      runId,
      projectId: task.projectId,
      taskId,
      status: 'CREATED',
      workflow,
      currentStep: 'created',
      currentAgentId: agentId,
      // 對話任務的主 agent（可寫的那一個）；工作流任務由 workflowState.agents.implement 決定
      primaryAgentId: workflowState ? undefined : agentId,
      agentSessions: {},
      pendingApprovals: [],
      pendingInputs: [],
      // 對話任務使用獨立的預算配置（P0-7 / H-8）：按每條操作員指令一個視窗計算
      budget: {
        ...createBudgetSnapshot({ maxCostUsd: this.defaultMaxCostUsd, ...input.budget }, workflowState ? DEFAULT_BUDGET : DEFAULT_CONVERSATION_BUDGET),
        startedAt: now,
      },
      createdBy: { behavior: BEHAVIOR_VERSION, ...(this.appVersion ? { appVersion: this.appVersion } : {}) },
      completedSideEffects: [],
      progressSinceLastTurn: false,
      workflowState,
      settings: { handoffPolicy: input.handoffPolicy ?? 'ask', autoHandoffsUsed: 0, maxAutoHandoffs: DEFAULT_MAX_AUTO_HANDOFFS, inactivityTimeoutMs },
      // 任務工作區在建立時就持久化（對話任務也一樣）：首次啟動失敗、重啟之後仍在原來的目錄（例如獨立 worktree）裡工作
      workspace: cwd ? runWorkspace(cwd, input.workspace) : undefined,
      ...(input.group ? { group: input.group } : {}),
      lastSequence: 0,
      createdAt: now,
      updatedAt: now,
    };

    // 全域性鍵：工作區獨佔檢查與提交原子完成（兩個任務同時用同一個工作區建立時只有一個通過）
    await this.commands.run(CREATE_TASK_KEY, async () => {
      if (workflowState) await this.assertWorkspaceAvailable(workflowState.cwd, workflowState.sharedWorkspace === true);
      // 對話任務（P1-4 / M-4）：另一個任務裡有 AI 正在改同一個（或包含關係的）資料夾時不開始
      else await this.assertWorkspaceNotBusy(task, snapshot);
      await this.store.commit({ task, run: snapshot });
    });
    await this.publish(task, {
      type: 'run.started',
      data: { workflow, agentId, testCommand: workflowState?.testCommand, reviewGate: workflowState?.reviewGate ?? false },
    });
    await this.transitionTo(taskId, 'QUEUED', 'queued');
    // 基線檢查點（P2-3）：AI 動手之前的工作區，之後每一輪的改動都和它對比，撤銷也能回到這裡
    await this.takeCheckpoint(task, undefined, '任務開始時');

    try {
      if (workflowState) {
        let directive: WorkflowDirective | undefined;
        await this.locks.run(runId, async () => {
          const run = await this.mustRun(runId);
          const first = firstDirective(run.workflowState!);
          run.workflowState = first.state;
          directive = first.directive;
          await this.store.commit({ run });
        });
        await this.executeDirective(taskId, directive!);
      } else if (input.askBoth) {
        await this.askBothNow(taskId, input.prompt, agentId);
      } else {
        const first = input.firstMessage ?? input.prompt;
        await this.withAgent(runId, agentId, () => this.startAgent(taskId, agentId, first, 'implement', { cwd, source: 'operator', dispatch: { renew: true } }));
      }
    } catch (error) {
      // 任務已經落盤：建立過程中就被停止時照常返回這個（已停止的）任務，而不是報錯
      if (!(error instanceof TaskTerminalError)) throw error;
    }
    return (await this.store.getTask(taskId)) ?? task;
  }

  /** 操作員命令：同一任務的命令按到達順序一個一個執行（不是 run 鎖，命令裡照常發事件、調 adapter）。 */
  private command<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    return this.commands.run(`task:${taskId}`, fn);
  }

  /** 同一 (run, agent) 的派發（啟動 / 傳送 / 續接 / 審批投遞）序列執行。 */
  private withAgent<T>(runId: string, agentId: string, fn: () => Promise<T>): Promise<T> {
    return this.agentLocks.run(`${runId}\u0000${agentId}`, fn);
  }

  /**
   * 操作員給 agent 發訊息。對話任務已阻塞時（P0-7 / H-8）：不帶 resume 明確拒絕（409 TASK_BLOCKED，說明原因和出路）；
   * 帶 resume 時先顯式恢復（因預算阻塞的先放寬預算），再傳送——agent 始終在 RUNNING、受限額約束的狀態下工作。
   */
  async sendMessage(taskId: string, agentId: string, message: string, options: OperatorSendOptions = {}): Promise<void> {
    await this.command(taskId, async () => {
      await this.prepareOperatorDispatch(taskId, [agentId], options, '訊息沒有送出。');
      await this.deliver(taskId, agentId, message, 'operator', undefined, { renew: true });
    });
  }

  /**
   * 操作員發起的 agent 間交接：把一個 agent 的輸出（連同操作員的要求）交給另一個 agent。
   * agent 之間從不直接互相呼叫；交接由編排器執行並記錄 handoff.requested / handoff.completed。
   */
  async handoffMessage(taskId: string, fromAgentId: string, toAgentId: string, content: string, instruction?: string, options: OperatorSendOptions = {}): Promise<void> {
    await this.command(taskId, async () => {
      await this.prepareOperatorDispatch(taskId, [toAgentId], options, '內容沒有轉交。');
      await this.handoffNow(taskId, fromAgentId, toAgentId, content, instruction);
    });
  }

  /**
   * 操作員派發前的檢查（P0-7 / H-8）：對話任務已阻塞時，先顯式恢復（options.resume），否則明確拒絕。
   * 已知無法續接的會話優先說明（恢復了也續接不上，出路是換人接手等）。工作流任務不在這裡處理：
   * 工作流阻塞時仍然可以問 agent（派發照常受預算約束），離開 BLOCKED 只能經人工閘門、換人接手或放寬預算。
   */
  private async prepareOperatorDispatch(taskId: string, agentIds: string[], options: OperatorSendOptions, consequence: string): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (run.status !== 'BLOCKED' || run.workflowState) return;
    for (const agentId of agentIds) {
      const session = run.agentSessions[agentId];
      const blocked = session && !this.liveSessions.has(sessionKey(session)) ? resumeBlockedOf(session) : undefined;
      if (blocked) throw sessionResumeBlockedError(agentId, blocked.code);
    }
    if (!options.resume) throw this.blockedError(task, run, consequence);
    await this.resumeConversation(task, run);
  }

  /**
   * 操作員確認後恢復已阻塞的對話任務（P0-7）：因預算阻塞的先放寬預算（開新的計數視窗），然後回到 RUNNING。
   */
  private async resumeConversation(task: TaskRecord, run: RunSnapshot): Promise<void> {
    const limit = budgetBlockLimit(run);
    if (limit) {
      await this.publish(task, {
        type: 'budget.extended',
        data: { reason: 'resume', renew: true, blockedLimit: limit, action: '操作員確認恢復任務：預算重新計算' },
      });
    }
    await this.transitionTo(task.id, 'RUNNING', 'operator:resume', { action: '操作員確認後恢復了任務', resumedFrom: run.blockedBy?.code ?? run.currentStep });
  }

  /**
   * 已阻塞的對話任務拒絕操作員派發時的說明（中文：為什麼阻塞、怎麼繼續）。
   * how 預設是發訊息場景的出路；批准交接時傳入「恢復並轉交」的說明。
   */
  private blockedError(task: TaskRecord, run: RunSnapshot, consequence: string, how?: string): TaskBlockedError {
    const limit = budgetBlockLimit(run);
    how ??= limit ? '按「放寬預算並繼續」，或者傳送時選擇「恢復並傳送」' : '傳送時選擇「恢復並傳送」，或者「換人接手」、「停止」';
    return new TaskBlockedError(`任務目前已阻塞（${blockedReasonText(run)}），${consequence}要繼續的話，請${how}。`, {
      taskId: task.id,
      ...(run.blockedBy ? { blockedBy: { source: run.blockedBy.source, code: run.blockedBy.code } } : {}),
    });
  }

  /** 交接的實際執行（命令、審批通過的交接請求、auto 策略的編排反應共用；本身不進命令佇列）。 */
  private async handoffNow(
    taskId: string,
    fromAgentId: string,
    toAgentId: string,
    content: string,
    instruction?: string,
    meta: { reason?: 'operator' | 'agent-request' | 'reassign'; auto?: boolean; ticket?: DispatchTicket; kind?: 'consult' | 'transfer' } = {},
  ): Promise<void> {
    if (fromAgentId === toAgentId) throw new Error('Handoff requires two different agents');
    this.mustAdapter(fromAgentId);
    this.mustAdapter(toAgentId);
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不能再轉交內容。');
    // 已阻塞的對話任務不轉交（例如阻塞期間批准了 agent 的交接請求）：先恢復任務（P0-7）
    if (run.status === 'BLOCKED' && !run.workflowState) throw this.blockedError(task, run, '交接沒有執行。');
    const contextRef = `handoff#${randomUUID().slice(0, 8)}`;
    const ask = instruction?.trim() || 'Please review the content above and reply with your assessment and concrete suggestions.';
    const reason = meta.reason ?? 'operator';
    const via = reason === 'agent-request' ? (meta.auto ? 'at the request of ' + fromAgentId + ' (auto-approved by policy)' : 'at the request of ' + fromAgentId + ', approved by the operator') : reason === 'reassign' ? 'by the operator (task reassigned to you)' : 'by the operator';
    const consult = meta.kind === 'consult';
    // 諮詢（P2-5）：對方唯讀回答，答覆由編排器自動交回請求方
    const consultAsk = consult
      ? `${ask}\n\n[Orchestrator note] ${fromAgentId} is consulting you. Answer the question above; do NOT modify any files. Your reply will be sent back to ${fromAgentId} automatically.`
      : ask;
    // 轉發的原文放進帶唯一邊界的資料區塊，編排器的任務指令只出現一次、在區塊之後（P0-9 / H-13）
    const message = forwardedMessage(fromAgentId, via, content, consultAsk, activitySummary(await this.store.listEvents(run.runId), fromAgentId));
    await this.publish(task, {
      type: 'handoff.requested',
      agentId: toAgentId,
      data: { fromAgentId, toAgentId, contextRef, reason, auto: meta.auto === true, instruction: ask, ...(consult ? { kind: 'consult' } : {}) },
    });
    // 操作員發起的轉交 / 換人接手是操作員的新指令（對話任務開新的預算視窗）；agent 自己請求的交接算在當前視窗裡。
    // 批准交接請求時，派發許可已經在消費審批之前領到（預算不夠就不消費審批），這裡直接沿用
    await this.deliver(
      taskId,
      toAgentId,
      message,
      'handoff',
      { fromAgentId, instruction: ask, forwarded: content, reason, auto: meta.auto === true, ...(consult ? { consult: true, advisory: true } : {}) },
      { ...(meta.ticket ? { ticket: meta.ticket } : { renew: reason !== 'agent-request' }), ...(consult ? { mode: 'analysis' as const } : {}) },
    );
    await this.publish(task, {
      type: 'handoff.completed',
      agentId: toAgentId,
      data: { fromAgentId, toAgentId, contextRef, progress: true },
    });
  }

  /**
   * 同時問兩個（Ask Both）：同一條訊息由編排器分別派發給每個可對話的 agent。
   * 同一工作區不允許兩個可寫 agent 併發改檔案：主 agent 可寫，其餘 agent 以唯讀顧問身份回答。
   */
  async askBoth(taskId: string, message: string, primaryAgentId?: string, options: OperatorSendOptions = {}): Promise<void> {
    await this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      const primary = this.askBothPrimary(await this.mustRun(task.runId), primaryAgentId);
      await this.prepareOperatorDispatch(taskId, this.askBothTargets(primary), options, '問題沒有送出。');
      await this.askBothNow(taskId, message, primaryAgentId);
    });
  }

  /**
   * Ask Both 的主 agent（P0 第二批審查）：指定了就用指定的；否則工作流任務用實現者，對話任務用記錄的主 agent。
   * 不再回退到 currentAgentId——工作流在測試步驟之後它是測試執行器。測試執行器永遠不能當主 agent（400）。
   */
  private askBothPrimary(run: RunSnapshot, requested?: string): string {
    const primary = requested ?? run.workflowState?.agents.implement ?? run.primaryAgentId ?? run.currentAgentId ?? this.defaultImplementer();
    const adapter = this.adapters.get(primary);
    if (!adapter) throw new InvalidAgentError(`找不到 Agent「${primary}」，請選擇其他 Agent。`, primary);
    if (adapter.info.kind === 'test') throw new InvalidAgentError(`「${adapter.info.name}」是測試執行器，不能作為「同時問」的主 Agent，請選擇其他 Agent。`, primary);
    return primary;
  }

  /** Ask Both 會派發給哪些 agent：主 agent 在前，其餘可對話的 agent 作為唯讀顧問。 */
  private askBothTargets(primaryAgentId: string): string[] {
    return [primaryAgentId, ...[...this.adapters.values()].filter((a) => a.info.kind !== 'test' && a.info.id !== primaryAgentId).map((a) => a.info.id)];
  }

  /**
   * Ask Both 的實際執行。不指定主 agent 時沿用任務記錄的主 agent（對話為 primaryAgentId，工作流為實現者）；
   * 指定了就把它記為對話任務新的主 agent（這一問裡只有它可寫）。
   */
  private async askBothNow(taskId: string, message: string, requestedPrimary?: string): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不能再同時問兩個。');
    const primaryAgentId = this.askBothPrimary(run, requestedPrimary);
    if (!run.workflowState && run.primaryAgentId !== primaryAgentId) {
      await this.locks.run(task.runId, async () => {
        const fresh = await this.mustRun(task.runId);
        fresh.primaryAgentId = primaryAgentId;
        await this.store.commit({ run: fresh });
      });
    }
    const targets = this.askBothTargets(primaryAgentId);
    const current = await this.mustRun(task.runId);
    // 正在以可寫方式做它自己那一輪的顧問（P0 第三批審查）：這一輪不問它——唯讀的一步塞不進進行中的可寫回合（Codex），
    // 也不能把它進行中的一輪中途降為唯讀（Claude）。用中文說明原因，只問其餘的 agent
    const busy = targets.slice(1).filter((id) => this.busyWritable(current, id));
    const advisors = targets.slice(1).filter((id) => !busy.includes(id));
    // 扇出前一次性檢查並扣掉全部呼叫（P0-7 / H-8）：額度不夠就整體拒絕，不會只派發一半
    const ticket = await this.claimDispatch(taskId, [primaryAgentId, ...advisors], 'operator', { renew: true });
    if (!ticket) return;
    for (const id of busy) {
      const names = [primaryAgentId, ...advisors].map((agentId) => this.agentName(agentId)).join('、');
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'info',
        agentId: id,
        data: {
          code: 'ASK_BOTH_ADVISOR_BUSY',
          primaryAgentId,
          message: `${this.agentName(id)} 正在工作（它可以修改檔案的這一輪還沒結束），這次只問 ${names}。等它做完之後可以再「同時問」。`,
        },
      });
    }
    // 給顧問的說明按主 agent 實際的權限寫（M-3 過渡：主 agent 的會話可能是以唯讀方式開始的）
    const primaryWritable = this.primaryWritable(current, primaryAgentId);
    await Promise.all([
      this.deliver(taskId, primaryAgentId, message, 'operator', { askBoth: true, primary: true, ...(busy.length ? { skippedAdvisors: busy } : {}) }, { ticket }),
      // 顧問這一輪一律唯讀（P0-9 權限傳遞契約）：即使它之前是可寫的主 agent、已有可寫的會話，這一輪也收緊成唯讀
      ...advisors.map((id) =>
        this.deliver(taskId, id, advisoryMessage(primaryAgentId, message, primaryWritable), 'operator', { askBoth: true, advisory: true, original: message, primaryAgentId }, { ticket, mode: 'analysis' }),
      ),
    ]);
  }

  /** agent 的顯示名稱。 */
  private agentName(agentId: string): string {
    return this.adapters.get(agentId)?.info.name ?? agentId;
  }

  /**
   * 會話最近一次派發的這一輪的權限模式（P0 第三批審查）：派發時記下的 dispatchMode；沒有記錄（還沒有經 send / resume 派發過）時，
   * 還有沒做完的唯讀輪就是它，否則是會話啟動模式。
   */
  private roundModeOf(session: SessionSnapshot): AgentMode | undefined {
    const dispatched = asAgentMode(session.metadata?.dispatchMode);
    if (dispatched) return dispatched;
    const round = asAgentMode(session.metadata?.roundMode);
    return isReadOnlyAgentMode(round) ? round : asAgentMode(session.metadata?.mode);
  }

  /**
   * 這個 agent 是否正在以可寫方式做它自己的一輪（P0 第三批審查）：有進行中的一輪（正在工作、並且本程序裡確實有它的會話或正在派發），
   * 而這一輪不是隻讀的。
   */
  private busyWritable(run: RunSnapshot, agentId: string): boolean {
    const session = run.agentSessions[agentId];
    if (!session) return false;
    const working = (run.budget.workingAgentIds ?? []).includes(agentId) || this.dispatching.has(activityKey(run.runId, agentId));
    if (!working || !this.hasProcessSession(run.runId, agentId)) return false;
    return !isReadOnlyAgentMode(this.roundModeOf(session));
  }

  /** 主 agent 這一輪能不能改檔案（它的會話是隻讀啟動的就不能，M-3 過渡）。 */
  private primaryWritable(run: RunSnapshot, agentId: string): boolean {
    const session = run.agentSessions[agentId];
    if (session) return !isReadOnlyAgentMode(asAgentMode(session.metadata?.mode));
    // 還沒有會話：對話任務以可寫模式啟動；工作流任務按預設分工
    return run.workflowState ? !isReadOnlyAgentMode(this.roleMode(run, agentId)) : true;
  }

  /**
   * 換人接手（Reassign）：停止原 agent 當前的工作，把任務連同上下文交給另一個 agent 繼續。
   * 工作流任務同時切換實現者；原 agent 的待審批操作按“拒絕”處理（不會被執行）。
   */
  async reassign(taskId: string, toAgentId: string, note?: string): Promise<void> {
    await this.command(taskId, () => this.reassignNow(taskId, toAgentId, note));
  }

  private async reassignNow(taskId: string, toAgentId: string, note?: string): Promise<void> {
    const target = this.mustAdapter(toAgentId);
    if (target.info.kind === 'test') throw new Error('Cannot reassign a task to the test runner');
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不能再換人接手。');
    const ws = run.workflowState;
    // 交接來源是主 agent（工作流為實現者，對話為 primaryAgentId），不是最近被派發的 currentAgentId（H-5）
    const fromAgentId = ws?.agents.implement ?? run.primaryAgentId ?? run.currentAgentId ?? toAgentId;
    if (fromAgentId === toAgentId) throw new Error(`Task is already assigned to ${toAgentId}`);

    // 1. 停止原 agent 正在進行的工作；它的待審批操作作廢
    const session = run.agentSessions[fromAgentId];
    if (session && ACTIVE_AGENT_STATUSES.has(session.status)) await this.cancelAgentSession(task, fromAgentId);
    for (const approval of run.pendingApprovals.filter((a) => a.agentId === fromAgentId)) {
      await this.publish(task, {
        type: 'approval.resolved',
        severity: 'warning',
        agentId: fromAgentId,
        data: { approvalId: approval.id, decision: 'decline', resolvedBy: 'reassign', providerCallId: approval.providerCallId },
      });
    }
    // 操作員的說明只放操作員自己寫的話；原 agent 的最近輸出作為資料另外轉交（P0-9 / H-13：不能混進“操作員說明”）
    const operatorNote = note?.trim() || undefined;

    // 換人接手是操作員明確要求開始新的一段工作（P0-7）：顯式續額（新的計數視窗），因預算阻塞的任務也能接著做
    await this.publish(task, {
      type: 'budget.extended',
      data: { reason: 'reassign', renew: true, toAgentId, ...(budgetBlockLimit(run) ? { blockedLimit: budgetBlockLimit(run) } : {}) },
    });
    // 接手的 agent 這段對話是以唯讀方式開始的（例如當時是「同時問」的顧問，M-3 / P1-4）：唯讀會話不能被放寬，
    // 所以結束它、從快照裡去掉，接手時按接手者的角色開一個新的（可以改檔案的）對話；原來的分析內容隨交接一起轉給它
    const takeoverReadOnly = !ws && isReadOnlyAgentMode(asAgentMode(run.agentSessions[toAgentId]?.metadata?.mode));
    if (takeoverReadOnly) {
      await this.cancelAgentSession(task, toAgentId);
      const oldKey = run.agentSessions[toAgentId] ? sessionKey(run.agentSessions[toAgentId]!) : undefined;
      await this.locks.run(task.runId, async () => {
        const fresh = await this.mustRun(task.runId);
        delete fresh.agentSessions[toAgentId];
        await this.store.commit({ run: fresh });
      });
      this.sessions.release(task.runId, toAgentId);
      if (oldKey) {
        this.liveSessions.delete(oldKey);
        this.retiredSessions.delete(oldKey);
      }
      const name = this.agentName(toAgentId);
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'info',
        agentId: toAgentId,
        data: {
          code: 'READ_ONLY_TAKEOVER',
          message: `${name} 之前在這個任務裡是隻讀的顧問。為了讓它接手後能直接修改檔案，已經為它開了一個新的對話；它之前的分析會跟著交接內容一起轉給它。`,
        },
      });
    }

    if (ws) {
      // 2a. 工作流任務：切換實現者，並在實現類步驟上把工作交給新 agent
      let directive: WorkflowDirective | undefined;
      await this.locks.run(task.runId, async () => {
        const fresh = await this.mustRun(task.runId);
        const w = fresh.workflowState!;
        w.agents.implement = toAgentId;
        if (w.agents.review === toAgentId) w.agents.review = fromAgentId;
        // 換人接手之後步驟重新開始：原 agent 在等待審批期間快取的訊號作廢（H-9）
        delete w.deferredSignal;
        // 併入工作流、原本要交給原實現者的交接內容，改交給新的實現者（P0 第三批審查）
        if (w.pendingHandoffs) w.pendingHandoffs = w.pendingHandoffs.map((item) => (item.toAgentId === fromAgentId ? { ...item, toAgentId } : item));
        const implementing = ['implement', 'retry', 'fix', 'review-fix'].includes(w.step);
        if (implementing || fresh.status === 'BLOCKED' || fresh.status === 'WAITING_INPUT' || fresh.status === 'WAITING_APPROVAL') {
          const step = implementing ? w.step : 'retry';
          w.step = step;
          w.stepSeq += 1;
          w.awaitingAgentId = toAgentId;
          w.history.push({ step, agentId: toAgentId, outcome: `reassigned from ${fromAgentId}`, at: this.now() });
          directive = {
            type: 'dispatch',
            step,
            agentId: toAgentId,
            mode: 'implement',
            purpose: 'reassign',
            // 上下文信封據此把原實現者的最近輸出放進資料區塊
            handoffFrom: fromAgentId,
            note: operatorNote,
            action: { type: 'HANDOFF', fromAgentId, toAgentId, contextRef: `${step}#${w.stepSeq}`, reason: 'reassign' },
          };
        }
        await this.store.commit({ run: fresh });
      });
      const now = await this.mustRun(task.runId);
      if (directive) {
        if (now.status !== 'RUNNING') {
          await this.publish(task, {
            type: 'run.status',
            data: { status: 'RUNNING', step: 'workflow:reassign', resolvedInputId: now.pendingInputs[0]?.id, action: `Reassigned to ${toAgentId}` },
          });
        }
        await this.executeDirective(taskId, directive);
      } else {
        await this.publish(task, { type: 'runtime.warning', data: { code: 'TASK_REASSIGNED', fromAgentId, toAgentId, action: `Implementer changed to ${toAgentId}` } });
      }
      return;
    }

    // 2b. 對話任務：新 agent 成為主 agent，再把任務背景和原 agent 的最近輸出交給它
    await this.locks.run(task.runId, async () => {
      const fresh = await this.mustRun(task.runId);
      fresh.primaryAgentId = toAgentId;
      await this.store.commit({ run: fresh });
    });
    const fresh = await this.mustRun(task.runId);
    if (fresh.status !== 'RUNNING' && canTransition(fresh.status, 'RUNNING')) await this.transitionTo(taskId, 'RUNNING', 'reassign');
    // 原 agent 的最近輸出是資料（放進資料區塊）；任務說明是操作員寫的，和接手要求一起放在區塊之外（P0-9 / H-13）
    const lastOutput = await this.lastAgentOutput(task.runId, fromAgentId);
    const forwarded = lastOutput ? clipText(lastOutput) : `(${fromAgentId} has not replied yet)`;
    const takeOver =
      operatorNote ??
      (takeoverReadOnly
        ? 'Please take over this task from here. Your session in this task is read-only: check the current state of the workspace, then describe the exact changes still needed. Do NOT modify any files.'
        : 'Please take over this task from here and finish it. Check the current state of the workspace first.');
    const readOnlyNote = operatorNote && takeoverReadOnly ? '\n\nNote: your session in this task is read-only; do NOT modify any files.' : '';
    await this.handoffNow(taskId, fromAgentId, toAgentId, forwarded, `${takeOver}${readOnlyNote}\n\nTask: ${task.title}\n${task.prompt}`, { reason: 'reassign' });
  }

  /** 設定 agent 主動交接的策略（ask / auto）。 */
  async setHandoffPolicy(taskId: string, policy: HandoffPolicy): Promise<void> {
    await this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      const current = await this.mustRun(task.runId);
      // 終態任務不再改設定（重啟後終態 run 的事件序號沒有續上，先改快照再發事件會撞 UNIQUE）
      if (isTerminal(current.status)) throw TaskTerminalError.of(taskId, current.status, '不需要再調整交接策略。');
      await this.locks.run(task.runId, async () => {
        const run = await this.mustRun(task.runId);
        run.settings = { ...defaultSettings(run.settings), handoffPolicy: policy };
        await this.store.commit({ run });
      });
      await this.publish(task, { type: 'runtime.warning', severity: 'info', data: { code: 'HANDOFF_POLICY_CHANGED', policy, action: `Agent handoffs: ${policy}` } });
    });
  }

  /**
   * agent 主動請求交接（Claude 透過 request_handoff 工具，Codex 透過文字約定）。
   * agent 只能“請求”；編排器按策略決定：ask → 生成審批交給操作員；auto → 在次數上限內自動執行。
   * 工作流任務始終走人工審批，避免打亂確定性流程。
   */
  private async onAgentHandoffRequest(event: UnifiedEvent): Promise<void> {
    const fromAgentId = event.agentId;
    const toAgentId = typeof event.data.toAgentId === 'string' ? event.data.toAgentId : '';
    const instruction = String(event.data.instruction ?? '').trim();
    const content = String(event.data.content ?? '').trim();
    // 諮詢還是轉交（P2-5）：諮詢時對方唯讀回答，答覆自動交回請求方
    const handoffKind: 'consult' | 'transfer' = event.data.kind === 'consult' ? 'consult' : 'transfer';
    const task = await this.store.getTask(event.taskId);
    const loaded = await this.store.loadRun(event.runId);
    if (!task || !fromAgentId || loaded?.status !== 'ok' || isTerminal(loaded.snapshot.status)) return;
    const run = loaded.snapshot;

    // 目標必須是已註冊、可對話（不是測試執行器）、不是自己的 agent（P0-9：Codex 的文字標記同樣經過這裡）
    const target = this.adapters.get(toAgentId);
    const invalid = !target
      ? `unknown agent ${toAgentId}`
      : target.info.kind === 'test'
        ? 'cannot hand off to the test runner'
        : toAgentId === fromAgentId
          ? 'cannot hand off to itself'
          : !instruction
            ? 'missing instruction'
            : !this.handoffEdgeAllowed(fromAgentId, toAgentId)
              ? 'edge not allowed'
              : undefined;
    if (invalid) {
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'warning',
        agentId: fromAgentId,
        data: { code: 'HANDOFF_REQUEST_REJECTED', reason: invalid, toAgentId, message: `${fromAgentId} 請求交給「${toAgentId || '（沒有指定）'}」，但${handoffRejectionText(invalid)}，已忽略這個請求。` },
      });
      return;
    }

    // 來回往返與鏈長度（P1-8）：不論交接策略，同一條操作員指令之後 AI 之間自己交接太多次就拒絕；
    // 在同一對 agent 之間來回踢（A→B→A）時不再自動執行，交給操作員確認
    const chain = this.handoffChains.get(run.runId) ?? [];
    chain.push({ from: fromAgentId, to: toAgentId });
    this.handoffChains.set(run.runId, chain);
    const maxChain = defaultSettings(run.settings).maxHandoffChain ?? DEFAULT_MAX_HANDOFF_CHAIN;
    const loop = handoffLoop(chain, maxChain);
    if (loop === 'chain-limit') {
      chain.pop();
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'warning',
        agentId: fromAgentId,
        data: {
          code: 'HANDOFF_CHAIN_LIMIT',
          toAgentId,
          count: chain.length,
          message: `AI 之間已經自己交接了 ${chain.length} 次（上限 ${maxChain - 1}），這次 ${fromAgentId} 請求交給 ${toAgentId} 已拒絕，避免來回空轉。你發一條新指令後會重新計算。`,
        },
      });
      return;
    }
    const pingPong = loop === 'ping-pong';

    // 從文字推斷出的請求（Codex 的 HANDOFF@ 標記等：confidence=inferred，或者 via=text）一律交給操作員確認，
    // auto 策略只自動執行 agent 透過結構化工具提出的請求（P0-9 / H-13：結構化訊號優先，文字推斷只作兜底）
    const inferred = event.confidence !== 'confirmed' || event.data.via === 'text';
    // 唯讀的來源（這一輪只能讀的 agent，例如 Ask Both 的顧問）請求交給會改檔案的 agent（P0 第三批審查，權限傳遞契約的另一個方向）：
    // 它不能借另一個 agent 間接改檔案，auto 策略下也交給操作員確認
    // 諮詢時對方唯讀回答，不存在借它改檔案的問題
    const escalates = handoffKind === 'transfer' && this.handoffEscalates(run, fromAgentId, toAgentId);

    // auto 策略：檢查與計數在同一次鎖內完成（同時來兩個請求時已用次數不會超過上限）；只在 run 正常執行時自動執行——
    // 阻塞、等待審批或閘門期間 agent 的交接請求一律交給操作員決定（agent 發起的動作不能繞過阻塞）
    let auto = false;
    if (!run.workflowState && !inferred && !escalates && !pingPong) {
      await this.locks.run(run.runId, async () => {
        const fresh = await this.mustRun(run.runId);
        const s = defaultSettings(fresh.settings);
        if (fresh.status !== 'RUNNING' || s.handoffPolicy !== 'auto' || s.autoHandoffsUsed >= s.maxAutoHandoffs) return;
        fresh.settings = { ...s, autoHandoffsUsed: s.autoHandoffsUsed + 1 };
        auto = true;
        await this.store.commit({ run: fresh });
      });
    }
    if (auto) {
      try {
        await this.handoffNow(task.id, fromAgentId, toAgentId, content || '(no content provided)', instruction, { reason: 'agent-request', auto: true, kind: handoffKind });
      } catch (error) {
        // 任務在這期間被停止、已阻塞，或者預算不夠（budget.exceeded 已經說明了原因、任務因預算阻塞）：
        // 交接不再執行，這些都是預期的結果，不是編排器內部錯誤（P0 第二批審查）
        if (!(error instanceof TaskTerminalError) && !(error instanceof TaskBlockedError) && !(error instanceof BudgetExhaustedError)) throw error;
      }
      return;
    }

    const settings = defaultSettings((await this.mustRun(run.runId)).settings);
    const limitReached = !inferred && !escalates && settings.handoffPolicy === 'auto' && settings.autoHandoffsUsed >= settings.maxAutoHandoffs;
    await this.publish(task, {
      type: 'approval.required',
      severity: 'warning',
      agentId: fromAgentId,
      confidence: inferred ? 'inferred' : 'confirmed',
      data: {
        approvalId: `handoff:${event.id}`,
        kind: 'handoff',
        fromAgentId,
        toAgentId,
        instruction,
        content,
        handoffKind,
        toolName: 'handoff',
        toolInput: { to: toAgentId, kind: handoffKind, instruction },
        summary: handoffKind === 'consult' ? `${fromAgentId} 想問 ${toAgentId}：${instruction.slice(0, 160)}` : `${fromAgentId} 請求交給 ${toAgentId}：${instruction.slice(0, 160)}`,
        autoLimitReached: limitReached,
        // 從文字推斷出的請求：介面說明“這是從文字推斷的請求，需要你確認”（auto 策略下還說明為什麼沒有自動執行）
        inferred,
        // 唯讀的 agent 請求交給會改檔案的 agent：介面說明為什麼需要你確認
        ...(escalates ? { readOnlySource: true } : {}),
        // 兩個 AI 在來回交接（P1-8）：介面說明為什麼這次沒有自動執行
        ...(pingPong ? { pingPong: true } : {}),
        policy: settings.handoffPolicy,
        ...(typeof event.data.via === 'string' ? { via: event.data.via } : {}),
        action: `${fromAgentId} requests handoff to ${toAgentId}`,
      },
    });
  }

  /**
   * 交接會不會讓唯讀的來源借另一個 agent 改檔案（P0 第三批審查）：請求者這一輪是隻讀的（顧問、評審、診斷），
   * 而目標這一輪能改檔案（它的會話可寫；還沒有會話時對話任務會以可寫模式啟動）。
   */
  private handoffEscalates(run: RunSnapshot, fromAgentId: string, toAgentId: string): boolean {
    const from = run.agentSessions[fromAgentId];
    if (!from || !isReadOnlyAgentMode(this.roundModeOf(from))) return false;
    // 交接對目標來說是新的一輪：按它的會話啟動模式執行（唯讀啟動的會話仍是隻讀）
    const to = run.agentSessions[toAgentId];
    if (to) return !isReadOnlyAgentMode(asAgentMode(to.metadata?.mode));
    return run.workflowState ? !isReadOnlyAgentMode(this.roleMode(run, toAgentId)) : true;
  }

  private async cancelAgentSession(task: TaskRecord, agentId: string): Promise<void> {
    const run = await this.mustRun(task.runId);
    const session = run.agentSessions[agentId];
    if (!session) return;
    const key = sessionKey(session);
    if (!this.liveSessions.has(key) && !this.retiredSessions.has(key)) return;
    await this.cancelSessionKey(task, agentId, key);
  }

  /** 把會話登記為本程序線上。 */
  private markLive(key: string, runId: string, agentId: string): void {
    this.liveSessions.set(key, { runId, agentId });
    this.retiredSessions.delete(key);
    // 續接後重新線上：之後的停止要能再次取消它（按線上會話處理，不再算“取消未完成”）
    this.cancelledKeys.delete(key);
    this.pendingCancels.delete(key);
  }

  /**
   * 會話已經結束（H-11）：移出線上表，之後對它的派發一律走 resume（adapter 在原會話仍可用時直接繼續，否則重新連線）。
   * held = 執行時可能還在（failed、執行時關閉）：記為已退役，停止任務、關閉服務時仍會取消它；被取消的會話不再記錄。
   * 只改記憶體登記，不發事件（可以在 run 鎖內呼叫）。
   */
  private retireSession(key: string, runId: string, agentId: string, held: boolean): void {
    const live = this.liveSessions.get(key);
    if (live && (live.runId !== runId || live.agentId !== agentId)) return;
    this.liveSessions.delete(key);
    if (held && !this.cancelledKeys.has(key)) this.retiredSessions.set(key, { runId, agentId });
    else this.retiredSessions.delete(key);
  }

  /** 會話事件的登記（run 鎖內、持久化階段呼叫）：記錄 agent.started / 會話結束的位置，會話結束時移出線上表。 */
  private trackSessionEvent(event: UnifiedEvent): void {
    const key = event.sessionId;
    const agentId = event.agentId;
    if (!key || !agentId) return;
    const started = event.type === 'agent.started';
    const ended = endsSession(event);
    if (!started && !ended) return;
    const mark = this.sessionMarks.get(key) ?? { started: 0, ended: 0 };
    if (started) mark.started = event.sequence;
    if (ended) {
      mark.ended = event.sequence;
      this.retireSession(key, event.runId, agentId, !(event.type === 'agent.status' && event.data.status === 'cancelled'));
    }
    this.sessionMarks.set(key, mark);
  }

  /** 會話在 afterSequence 之後結束了，並且結束之後沒有重新啟動（adapter.start / resume 返回後判斷是否登記為線上）。 */
  private sessionEndedSince(key: string, afterSequence: number): boolean {
    const mark = this.sessionMarks.get(key);
    return mark !== undefined && mark.ended > Math.max(mark.started, afterSequence);
  }

  /**
   * 看門狗的“有動靜”計時（run 鎖內、持久化階段呼叫；只改傳入的快照）：
   * 正在等待的 agent 的事件、run 狀態變化（包括審批結束回到 RUNNING）與派發都會重新整理它。
   * 編排器自己取消的會話發出的事件（例如看門狗停掉卡住的會話時的 cancelled）不算。
   */
  private noteActivity(run: RunSnapshot, event: UnifiedEvent, statusChanged: boolean): void {
    const ws = run.workflowState;
    if (!ws) return;
    if (event.sessionId && this.cancelledKeys.has(event.sessionId)) return;
    // 編排器自己的警告（不帶會話身份，例如“取消沒有及時完成”“派發被拒絕”）不是 agent 的動靜
    if (event.type === 'runtime.warning' && !event.sessionId) return;
    if (statusChanged || event.type === 'run.status' || (event.agentId !== undefined && event.agentId === ws.awaitingAgentId)) {
      ws.lastActivityAt = this.now();
    }
  }

  /**
   * 取消一個會話；失敗只記錄 warning。
   * 同一會話通常只取消一次，以下情況再取消一次（adapter 的 cancel 是冪等的）：
   * - force：派發許可失效（啟動 / 續接 / 傳送途中發生過停止），剛返回的會話必須確保被停下——
   *   例如 Codex 的 turn/start 在途時第一次取消沒有 turn id 可以中斷，第二次取消能補發中斷（P0 第二批審查）；
   * - 上一次取消還沒有完成（執行時連中斷都不響應）：這次讓 adapter 直接結束程序。
   * 等 adapter.cancel 最多 cancelTimeoutMs：超時後照常返回（會話記為“取消未完成”），呼叫方（停止、預算停止、看門狗）不會被拖住。
   */
  private async cancelSessionKey(task: TaskRecord, agentId: string, key: string, options: { force?: boolean } = {}): Promise<void> {
    this.liveSessions.delete(key);
    this.retiredSessions.delete(key);
    if (this.cancelledKeys.has(key) && !options.force && !this.pendingCancels.has(key)) return;
    this.cancelledKeys.add(key);
    const adapter = this.adapters.get(agentId);
    if (!adapter) return;
    this.pendingCancels.set(key, { runId: task.runId, agentId });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelling = Promise.resolve()
      .then(() => adapter.cancel(key, this.adapterSink(task, agentId)))
      .then(() => {
        // 完成了（包括超時之後才完成）：不再算“取消未完成”
        if (this.pendingCancels.get(key)?.runId === task.runId) this.pendingCancels.delete(key);
      });
    try {
      await Promise.race([
        cancelling,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, this.cancelTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      if (this.stopping) return;
      await this.publish(task, { type: 'runtime.warning', severity: 'warning', agentId, data: { code: 'ADAPTER_CANCEL_FAILED', message: (error as Error).message } });
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!timedOut) return;
    // 超時：cancel 之後才失敗的也只記錄日誌（不能產生未處理的拒絕）
    cancelling.catch((error: unknown) => this.log(`cancelling ${agentId} session ${key} failed after timing out (task ${task.id})`, error));
    if (this.stopping) return;
    this.log(`cancelling ${agentId} session ${key} did not finish within ${this.cancelTimeoutMs}ms (task ${task.id}); it will be cancelled again on the next stop`);
    await this.publish(task, {
      type: 'runtime.warning',
      severity: 'warning',
      agentId,
      data: { code: 'ADAPTER_CANCEL_TIMEOUT', timeoutMs: this.cancelTimeoutMs, message: `${agentId} 沒有在 ${Math.round(this.cancelTimeoutMs / 1000)} 秒內回應停止請求；再按一次「停止」會強制結束它。` },
    });
  }

  /** 在“正在派發”登記之下執行一次派發（啟動 / 續接 / 傳送），結束後撤銷登記。 */
  private async trackDispatch<T>(runId: string, agentId: string, fn: () => Promise<T>): Promise<T> {
    const key = activityKey(runId, agentId);
    this.dispatching.set(key, (this.dispatching.get(key) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const left = (this.dispatching.get(key) ?? 1) - 1;
      if (left > 0) this.dispatching.set(key, left);
      else this.dispatching.delete(key);
    }
  }

  /** 這個 agent 在本程序裡是否還有會話（線上、已退役、取消未完成）或正在派發：沒有的話它不可能還在工作。 */
  private hasProcessSession(runId: string, agentId: string): boolean {
    if (this.dispatching.has(activityKey(runId, agentId))) return true;
    for (const map of [this.liveSessions, this.retiredSessions, this.pendingCancels]) {
      for (const live of map.values()) if (live.runId === runId && live.agentId === agentId) return true;
    }
    return false;
  }

  /**
   * 清理殘留的“正在工作”（P0 第二批審查 / H-8）：在本程序裡已經沒有任何會話、也沒有在派發的 agent 不可能還在工作
   * （例如重啟前在工作、之後沒有續上；拒絕審批時會話不線上；取消失敗沒有終態）。為每個這樣的 agent 發一條編排器事件
   * （data.workEnded，不帶會話身份）把它移出集合，時長不再為它計時，已阻塞的任務也不會因為它反覆觸發預算事件。
   * 服務正在關閉時不做（關閉時不改持久化狀態）。返回是否清理了。
   */
  private async clearStaleWorking(task: TaskRecord, run: RunSnapshot): Promise<boolean> {
    if (this.stopping) return false;
    const stale = (run.budget.workingAgentIds ?? []).filter((agentId) => !this.hasProcessSession(run.runId, agentId));
    for (const agentId of stale) {
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'info',
        agentId,
        data: { code: 'AGENT_WORK_CLEARED', workEnded: true, message: `${agentId} 目前沒有在工作（本機沒有它的對話），不再計入工作時長。` },
      });
    }
    return stale.length > 0;
  }

  /** 當前停止代數（見 DispatchTicket）。 */
  private stopEpoch(runId: string): number {
    return this.stopEpochs.get(runId) ?? 0;
  }

  /**
   * 停止該 run 的全部線上會話（H-5：取消、預算停止、接受結果）。先把停止代數 +1：
   * 這之前已經領到派發許可、還在啟動 / 續接中的會話，adapter 返回後在鎖內複核時會被立刻取消。
   */
  private async stopAllSessions(task: TaskRecord): Promise<void> {
    this.stopEpochs.set(task.runId, this.stopEpoch(task.runId) + 1);
    // 包括已退役（失敗後移出線上表、執行時可能還在）的會話，以及上一次取消還沒有完成的會話（這次再取消一次）
    const targets = new Map([...this.liveSessions, ...this.retiredSessions, ...this.pendingCancels].filter(([, live]) => live.runId === task.runId));
    await Promise.all([...targets].map(([key, live]) => this.cancelSessionKey(task, live.agentId, key)));
    // 任務已結束（M-6）：取消之後再讓 adapter 忘掉這些會話，內部 Map 不再隨任務數增長
    const loaded = await this.store.loadRun(task.runId);
    if (loaded?.status === 'ok' && isTerminal(loaded.snapshot.status)) {
      for (const [key, live] of targets) {
        try {
          await this.adapters.get(live.agentId)?.release?.(key);
        } catch (error) {
          this.log(`releasing ${live.agentId} session ${key} after the task ended failed (task ${task.id})`, error);
        }
      }
    }
  }

  private async lastAgentOutput(runId: string, agentId: string): Promise<string | undefined> {
    const events = await this.store.listEvents(runId);
    const last = [...events].reverse().find((e) => e.agentId === agentId && e.type === 'agent.message' && e.data.direction !== 'to-agent' && typeof e.data.message === 'string');
    return last ? String(last.data.message) : undefined;
  }

  private async deliver(taskId: string, agentId: string, message: string, source: MessageSource, meta?: Record<string, unknown>, dispatch: DispatchOptions = {}): Promise<void> {
    const initial = await this.mustTask(taskId);
    // “有會話就傳送、沒有就啟動”在 (run, agent) 派發鎖下一次完成：命令與編排反應不會各自啟動一個會話
    await this.withAgent(initial.runId, agentId, () => this.deliverNow(taskId, agentId, message, source, meta, dispatch));
  }

  private async deliverNow(taskId: string, agentId: string, message: string, source: MessageSource, meta?: Record<string, unknown>, dispatch: DispatchOptions = {}): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '訊息沒有送出。需要繼續的話，請在對話方塊裡直接輸入，會以「繼續對話」開新任務。');
    // 已阻塞的對話任務不再派發任何操作員 / 交接訊息（P0-7 / H-8）：必須先顯式恢復，
    // 絕不出現“任務顯示 BLOCKED，agent 卻在工作、不受任何限額約束”
    if (run.status === 'BLOCKED' && !run.workflowState && source !== 'orchestrator') throw this.blockedError(task, run, '訊息沒有送出。');
    if (source === 'operator' && run.workflowState?.testCommand && agentId === run.workflowState.agents.test) {
      // 測試正在跑（工作流在等測試結果，或者上一次手動重跑還沒結束，P0 第三批審查）：拒絕這一次（409），不要把整個任務 fail closed
      const ws = run.workflowState;
      const testing = (ws.awaitingAgentId === agentId && run.status === 'RUNNING') || (run.budget.workingAgentIds ?? []).includes(agentId) || this.dispatching.has(activityKey(run.runId, agentId));
      if (testing) {
        throw new GateActionError('測試正在執行中，請等這次測試跑完再重跑（結果會自動顯示在對話裡）。', { taskId, action: 'rerun-tests', step: ws.step });
      }
      // 操作員手動「重跑測試」（H-15）：測試配置和上次執行測試時不一樣（可能被 agent 改過）時先請操作員確認，不直接執行
      await this.assertTestConfigConfirmed(task, run);
    }

    const session = run.agentSessions[agentId];
    // 工作區互斥（P1-4 / M-4）：對話任務同樣參與——這一輪能改檔案，而另一個任務里正有 AI 在改同一個（或包含關係的）資料夾時拒絕
    if (!run.workflowState && source !== 'orchestrator' && !isReadOnlyAgentMode(dispatch.mode) && meta?.advisory !== true) {
      const mode = session ? asAgentMode(session.metadata?.mode) : 'implement';
      if (!isReadOnlyAgentMode(mode)) await this.assertWorkspaceNotBusy(task, run);
    }
    if (!session) {
      // 對話（手動）模式：操作員直接驅動，Codex 也以可寫模式工作；工作流模式下沿用預設分工。
      // 派發時明確要求了唯讀（Ask Both 的顧問）就按唯讀啟動——工作流任務裡 Claude 當顧問時預設分工是可寫的
      const testRunner = this.adapters.get(agentId)?.info.kind === 'test';
      const mode: AgentMode = isReadOnlyAgentMode(dispatch.mode) ? dispatch.mode! : run.workflowState || testRunner ? this.roleMode(run, agentId) : meta?.advisory === true ? 'analysis' : 'implement';
      await this.startAgent(taskId, agentId, message, mode, {
        // 持久化的任務工作區優先；只有升級前建立、快照裡沒有工作區的舊任務才回退到預設工作區
        cwd: taskCwd(run) ?? this.defaultCwd,
        context: { testCommand: run.workflowState?.testCommand },
        source,
        meta,
        dispatch,
      });
      return;
    }
    const live = this.liveSessions.has(sessionKey(session));
    if (!this.adapters.get(agentId)?.resume && !live) {
      throw new Error(`Session ${sessionKey(session)} is not live in this process and adapter ${agentId} cannot resume`);
    }
    const blocked = resumeBlockedOf(session);
    if (!live && blocked && source === 'operator') {
      // 已知無法續接的會話（P0-4 審查）：再補充說明或重試只會重複同樣的失敗並消耗呼叫預算——直接說明可行的出路
      throw sessionResumeBlockedError(agentId, blocked.code);
    }
    // 要求了唯讀的這一輪（Ask Both 的顧問）：帶上步驟模式，已有的可寫會話這一輪也收緊成唯讀。
    // 操作員 / 交接的新指令是新的一輪（freshRound）：按會話自己的模式，不沿用之前被打斷的唯讀輪（P0 第三批審查）
    await this.sendToSession(task, agentId, message, source, meta, { dispatch, freshRound: source !== 'orchestrator', ...(isReadOnlyAgentMode(dispatch.mode) ? { mode: dispatch.mode } : {}) });
  }

  /**
   * 人工閘門（Human Gate）：處理等待操作員決定的 run（WAITING_INPUT 評審閘門或 BLOCKED）。
   * - accept：接受當前結果並完成；
   * - review：發起一輪獨立評審（受 maxReviewRounds 限制，不會自動迴圈）；
   * - retry：帶操作員說明讓實現 agent 繼續，然後重新走測試。
   */
  async resolveGate(taskId: string, action: GateAction, note?: string): Promise<void> {
    await this.command(taskId, () => this.resolveGateNow(taskId, action, note));
  }

  private async resolveGateNow(taskId: string, action: GateAction, note?: string): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (!run.workflowState) {
      // 手動模式：沒有工作流，操作員只能接受結果（結束任務）
      if (action !== 'accept') throw new Error(`Task ${taskId} has no workflow; only accept is available`);
      if (run.status !== 'RUNNING' && run.status !== 'BLOCKED') throw new Error(`Task ${taskId} is not waiting for an operator decision (${run.status})`);
      // 直接完成（P0-7 / H-7）：阻塞時也不先回到 RUNNING
      await this.publish(task, { type: 'run.completed', data: { reason: 'Accepted by operator', acceptedBy: 'operator', action: 'Accepted by operator' } });
      await this.assertStatus(task, 'COMPLETED', '「接受結果」');
      // 先進入終態、再停止全部線上會話（H-5：Ask Both 時兩個 agent 都停）：之後的派發一律被拒絕
      await this.stopAllSessions(task);
      return;
    }
    if (run.status !== 'WAITING_INPUT' && run.status !== 'BLOCKED') {
      throw new Error(`Task ${taskId} is not waiting for an operator decision (${run.status})`);
    }
    if (action === 'retry' && !note?.trim()) throw new Error('Retry requires an instruction for the agent');
    if (action === 'rerun' && (run.status !== 'BLOCKED' || !stepAgent(run.workflowState, run.workflowState.step))) {
      // 只有阻塞在某個 agent 負責的步驟上時才能重跑那一步（評審閘門上沒有“這一步”可以重跑）
      throw new GateActionError('現在沒有可以重跑的步驟：請選擇「帶說明重試」、「請 Codex 評審」或「接受結果」。', { taskId, action, step: run.workflowState.step });
    }

    let directive: WorkflowDirective | undefined;
    await this.locks.run(run.runId, async () => {
      const fresh = await this.mustRun(run.runId);
      const result = decide(fresh.workflowState!, { kind: 'gate', action, note }, { now: this.now(), canReview: canStartReviewRound(fresh.budget) });
      // 只有新開的一輪評審消耗評審輪次；重跑一次失敗的評審不算新的一輪
      if (action === 'review' && result.directive.type === 'dispatch' && result.directive.step === 'review') fresh.budget.reviewRoundsUsed += 1;
      fresh.workflowState = result.state;
      directive = result.directive;
      await this.store.commit({ run: fresh });
    });
    const decided: WorkflowDirective = directive!;

    if (action === 'accept' && decided.type === 'complete') {
      // 接受結果直接完成（P0-7 / H-7）：不經過 RUNNING，也就不會在閘門自己的遷移上檢查預算——
      // 以前評審閘門停留超過 30 分鐘後點 accept，閘門的 RUNNING 先觸發時長預算進入 BLOCKED，完成被拒絕，任務永遠完成不了
      await this.publish(task, {
        type: 'run.completed',
        data: {
          reason: decided.reason,
          acceptedBy: 'operator',
          step: 'workflow:gate-accept',
          resolvedInputId: run.pendingInputs[0]?.id,
          nextAction: decided.action,
          action: 'Accepted by operator',
          note,
        },
      });
      await this.assertStatus(task, 'COMPLETED', '「接受結果」');
      // 任務結束後停止仍線上的全部會話（例如 BLOCKED 時還在完成當前一輪的 agent）
      await this.stopAllSessions(task);
      return;
    }

    // 重新派發之前先停掉目標 agent 進行中的一輪（P0 第三批審查）：舊一輪的完成不能被當成這次重試 / 評審的完成
    if (decided.type === 'dispatch') await this.releaseStepTarget(task, decided.agentId);

    // 評審 / 重試：操作員明確要求再做一輪，先顯式續額（新的計數視窗，停滯計數清零），再回到 RUNNING（P0-7）
    await this.publish(task, {
      type: 'budget.extended',
      data: { reason: 'gate', gateAction: action, renew: true, ...(budgetBlockLimit(run) ? { blockedLimit: budgetBlockLimit(run) } : {}) },
    });
    await this.publish(task, {
      type: 'run.status',
      data: {
        status: 'RUNNING',
        step: `workflow:gate-${action}`,
        resolvedInputId: run.pendingInputs[0]?.id,
        action: `Operator: ${action}`,
        note,
      },
    });
    await this.executeDirective(taskId, decided);
  }

  /**
   * 操作員確認測試配置的改動（P0-8 / H-15）。digest 是介面上顯示的那份差異的摘要（workflowState.testConfigReview.digest）。
   * - 先重新讀取當前的測試配置：和操作員看到的不一樣（確認之前又被改了）就更新差異並拒絕（409 TEST_CONFIG_CHANGED），請操作員重新檢視；
   * - 工作流停在測試配置閘門（WAITING_INPUT）：確認的配置成為新的基線，回到 RUNNING 並執行這一步的測試；
   * - 手動「重跑測試」時發現的改動：更新基線後執行測試，任務狀態不變。
   */
  async confirmTestConfig(taskId: string, digest: string): Promise<void> {
    await this.command(taskId, () => this.confirmTestConfigNow(taskId, digest));
  }

  private async confirmTestConfigNow(taskId: string, digest: string): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不需要再確認測試設定。');
    const ws = run.workflowState;
    const review = ws?.testConfigReview;
    if (!ws?.testCommand || !review) {
      throw new GateActionError('現在沒有需要確認的測試設定改動。', { taskId, action: 'confirm-tests', step: ws?.step });
    }
    if (review.digest !== digest) {
      throw new TestConfigChangedError('你確認的不是最新的差異（測試設定又被改過了），請重新檢視差異後再確認。', { taskId, paths: review.changes.map((c) => c.path) });
    }
    const cwd = ws.cwd ?? this.defaultCwd;
    const current = cwd && this.testConfigGuard ? await this.captureTestConfig(cwd, ws.testCommand) : undefined;
    const currentDigest = current ? testConfigDigest(current.fingerprint) : review.digest;
    // 確認之前又改回去了（和基線一致）同樣可以繼續：已經沒有需要確認的改動
    const reverted = current?.ok === true && ws.testConfigBaseline !== undefined && testConfigDigest(ws.testConfigBaseline) === currentDigest;
    if (current && currentDigest !== review.digest && !reverted) {
      // 確認之前測試配置又被改了：更新差異（介面重新整理後顯示最新的），請操作員重新確認
      let paths: string[] = [];
      await this.locks.run(run.runId, async () => {
        const fresh = await this.mustRun(run.runId);
        const fws = fresh.workflowState;
        if (!fws?.testConfigReview) return;
        const next = this.buildTestConfigReview(fws, current, fws.testConfigReview.source);
        fws.testConfigReview = next;
        paths = next.changes.map((c) => c.path);
        await this.store.commit({ run: fresh });
      });
      throw new TestConfigChangedError('測試設定在你檢視之後又被修改了，差異已經更新，請重新檢視後再確認。', { taskId, paths });
    }

    const gateWaiting = run.status === 'WAITING_INPUT' && run.pendingInputs.some((x) => x.id === TEST_CONFIG_INPUT_ID);
    if (gateWaiting) {
      // 工作流停在測試配置閘門：按閘門決定推進（確認的配置成為新的基線，派發這一步的測試）
      let directive: WorkflowDirective | undefined;
      await this.locks.run(run.runId, async () => {
        const fresh = await this.mustRun(run.runId);
        if (fresh.status !== 'WAITING_INPUT' || fresh.workflowState?.testConfigReview?.digest !== digest) {
          throw new TestConfigChangedError('等待確認的測試設定改動已經變了，請重新檢視差異後再確認。', { taskId, paths: [] });
        }
        if (reverted) fresh.workflowState.testConfigReview = { ...fresh.workflowState.testConfigReview, fingerprint: fresh.workflowState.testConfigBaseline! };
        const result = decide(fresh.workflowState, { kind: 'gate', action: 'confirm-tests' }, { now: this.now(), canReview: canStartReviewRound(fresh.budget) });
        fresh.workflowState = result.state;
        directive = result.directive;
        await this.store.commit({ run: fresh });
      });
      await this.publish(task, {
        type: 'run.status',
        data: {
          status: 'RUNNING',
          step: 'workflow:gate-confirm-tests',
          resolvedInputId: TEST_CONFIG_INPUT_ID,
          testConfigDigest: digest,
          action: '操作員確認了測試設定的改動，開始執行測試',
        },
      });
      await this.executeDirective(taskId, directive!);
      return;
    }

    // 手動「重跑測試」時發現的改動：更新基線，然後執行測試（任務狀態不變）
    await this.locks.run(run.runId, async () => {
      const fresh = await this.mustRun(run.runId);
      const fws = fresh.workflowState;
      if (!fws?.testConfigReview || fws.testConfigReview.digest !== digest) {
        throw new TestConfigChangedError('等待確認的測試設定改動已經變了，請重新檢視差異後再確認。', { taskId, paths: [] });
      }
      if (!reverted) fws.testConfigBaseline = fws.testConfigReview.fingerprint;
      // 操作員確認過的配置：同一目錄的後續任務以它為基線（P0 第三批審查）
      fws.testConfigTrustedAt = this.now();
      delete fws.testConfigStartDigest;
      delete fws.testConfigReview;
      fws.history.push({ step: fws.step, agentId: fws.agents.test, outcome: 'operator confirmed test configuration changes', at: this.now() });
      await this.store.commit({ run: fresh });
    });
    await this.deliver(taskId, ws.agents.test, 'run tests', 'operator', { testConfigConfirmed: digest }, { renew: true });
  }

  /** 讀取測試配置；讀取失敗時返回一個代表“無法讀取”的指紋（和任何基線都不同，fail closed）。 */
  private async captureTestConfig(cwd: string, testCommand: string): Promise<{ ok: boolean; fingerprint: TestConfigFingerprint; error?: string }> {
    try {
      return { ok: true, fingerprint: await this.testConfigGuard!.capture(cwd, testCommand) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to read the test configuration in ${cwd}`, error);
      return { ok: false, fingerprint: unreadableTestConfig(message), error: message };
    }
  }

  /**
   * 這個目錄最近一次可信的測試配置（P0 第三批審查）：同一工作目錄（規範化後比較）的歷史任務裡，基線成為可信（第一次採集、
   * 或操作員確認改動）最晚的那一個。沒有就返回 undefined（第一次在這個目錄建任務：以當時磁碟上的內容為基線）。
   */
  private async trustedTestConfig(cwd: string): Promise<{ fingerprint: TestConfigFingerprint; testCommand: string; at: number } | undefined> {
    const key = normalizePath(cwd);
    let best: { fingerprint: TestConfigFingerprint; testCommand: string; at: number } | undefined;
    for (const task of await this.store.listTasks()) {
      const loaded = await this.store.loadRun(task.runId);
      if (loaded?.status !== 'ok') continue;
      const ws = loaded.snapshot.workflowState;
      if (!ws?.testConfigBaseline || !ws.testCommand || !ws.cwd || normalizePath(ws.cwd) !== key) continue;
      const at = ws.testConfigTrustedAt ?? loaded.snapshot.createdAt;
      if (!best || at > best.at) best = { fingerprint: ws.testConfigBaseline, testCommand: ws.testCommand, at };
    }
    return best;
  }

  /** 按當前讀取的測試配置生成待確認的改動（鎖內呼叫，不提交）。 */
  private buildTestConfigReview(
    ws: NonNullable<RunSnapshot['workflowState']>,
    current: { ok: boolean; fingerprint: TestConfigFingerprint; error?: string },
    source: TestConfigReview['source'],
  ): TestConfigReview {
    const baseline = ws.testConfigBaseline;
    const reason = !current.ok ? 'unreadable' : baseline ? 'changed' : 'no-baseline';
    return {
      digest: testConfigDigest(current.fingerprint),
      fingerprint: current.fingerprint,
      changes: current.ok ? diffTestConfig(baseline, current.fingerprint) : [{ path: TEST_CONFIG_UNREADABLE_PATH, kind: 'modified', diff: '', note: current.error }],
      reason,
      // 改動在任務開始前就有了（沿用了這個目錄上一次確認過的配置，P0 第三批審查）
      ...(reason === 'changed' && ws.testConfigStartDigest !== undefined ? { preexisting: true } : {}),
      source,
      step: ws.step,
      stepSeq: ws.stepSeq,
      at: this.now(),
    };
  }

  /**
   * 工作流測試步驟之前的檢查（H-15）：測試配置和基線一致就返回 true（照常派發）；
   * 不一致（或者讀不到、沒有基線）就記下待確認的改動，任務進入 WAITING_INPUT，返回 false（不派發）。
   * 讀檔案在鎖外進行；鎖內只比較和提交。步驟已經變了（stepSeq 不同）或任務不在執行時同樣不派發。
   */
  private async testConfigAllowsDispatch(task: TaskRecord, run: RunSnapshot): Promise<boolean> {
    const ws = run.workflowState;
    const cwd = ws?.cwd ?? this.defaultCwd;
    if (!this.testConfigGuard || !ws?.testCommand || !cwd) return true;
    const stepSeq = ws.stepSeq;
    const current = await this.captureTestConfig(cwd, ws.testCommand);
    let outcome = 'stop' as 'run' | 'wait' | 'stop';
    let review: TestConfigReview | undefined;
    await this.locks.run(run.runId, async () => {
      const fresh = await this.mustRun(run.runId);
      const fws = fresh.workflowState;
      if (!fws || isTerminal(fresh.status) || fws.stepSeq !== stepSeq) return;
      const unchanged = current.ok && fws.testConfigBaseline !== undefined && testConfigDigest(fws.testConfigBaseline) === testConfigDigest(current.fingerprint);
      if (unchanged) {
        if (fws.testConfigReview) {
          delete fws.testConfigReview;
          await this.store.commit({ run: fresh });
        }
        outcome = 'run';
        return;
      }
      // 任務不在執行（例如這期間被預算阻塞）：不派發測試，由操作員的決定再走到這一步
      if (fresh.status !== 'RUNNING') return;
      review = this.buildTestConfigReview(fws, current, 'workflow');
      fws.testConfigReview = review;
      // 現在等的是操作員，不是測試執行器（看門狗、完成訊號都不再針對它）
      fws.awaitingAgentId = undefined;
      fws.history.push({ step: fws.step, agentId: fws.agents.test, outcome: `test configuration ${review.reason}; waiting for operator confirmation`, at: this.now() });
      await this.store.commit({ run: fresh });
      outcome = 'wait';
    });
    if (outcome === 'wait' && review) {
      const prompt = testConfigPrompt(review);
      await this.publish(task, {
        type: 'run.status',
        severity: 'warning',
        data: {
          status: 'WAITING_INPUT',
          step: 'workflow:test-config-review',
          pendingInput: { id: TEST_CONFIG_INPUT_ID, prompt },
          nextAction: { type: 'WAIT_INPUT', requestId: TEST_CONFIG_INPUT_ID, prompt },
          testConfigChanges: review.changes.map((change) => ({ path: change.path, kind: change.kind })),
          action: prompt,
        },
      });
    }
    return outcome === 'run';
  }

  /**
   * 操作員手動「重跑測試」之前的檢查（H-15）：測試配置和基線不一致時記下待確認的改動（任務狀態不變），
   * 丟擲 TestConfigChangedError（409），介面據此顯示確認卡片；一致時什麼都不做。
   */
  private async assertTestConfigConfirmed(task: TaskRecord, run: RunSnapshot): Promise<void> {
    const ws = run.workflowState;
    const cwd = ws?.cwd ?? this.defaultCwd;
    if (!this.testConfigGuard || !ws?.testCommand || !cwd) return;
    const current = await this.captureTestConfig(cwd, ws.testCommand);
    let paths: string[] | undefined;
    await this.locks.run(run.runId, async () => {
      const fresh = await this.mustRun(run.runId);
      const fws = fresh.workflowState;
      if (!fws) return;
      if (current.ok && fws.testConfigBaseline !== undefined && testConfigDigest(fws.testConfigBaseline) === testConfigDigest(current.fingerprint)) return;
      // 工作流已經停在測試配置閘門上：沿用那個閘門（更新成最新的差異），否則記為手動重跑時發現的改動
      const next = this.buildTestConfigReview(fws, current, fws.testConfigReview?.source ?? 'manual');
      fws.testConfigReview = next;
      paths = next.changes.map((c) => c.path);
      await this.store.commit({ run: fresh });
    });
    if (!paths) return;
    const list = paths.length > 4 ? `${paths.slice(0, 4).join('、')} 等 ${paths.length} 個檔案` : paths.join('、');
    throw new TestConfigChangedError(
      `測試設定和上次執行測試時不一樣了（${list}），可能被 AI 改過。為了安全，執行測試前需要你先確認這些改動：請在任務頁上方的「測試設定有改動」卡片檢視差異，確認後按「確認並執行測試」。`,
      { taskId: task.id, paths },
    );
  }

  /**
   * 編排器的狀態遷移必須生效（P0-7）：沒有生效時顯式報錯（409），不再“介面返回成功、任務卻停在原狀態”。
   * 被拒絕的遷移本身另有 TRANSITION_REJECTED 警告記錄在事件日誌裡。
   */
  private async assertStatus(task: TaskRecord, expected: TaskStatus, what: string): Promise<void> {
    const run = await this.mustRun(task.runId);
    if (run.status === expected) return;
    throw new TransitionRejectedError(`${what}沒有生效：任務目前是「${STATUS_TEXT[run.status] ?? run.status}」，沒有變成「${STATUS_TEXT[expected] ?? expected}」。`, {
      taskId: task.id,
      from: run.status,
      to: expected,
    });
  }

  /**
   * 調整預算（P0-7，預算 API）：設定新的限額，或者放寬（開一個新的計數視窗，再給一份同樣的額度），
   * 發出 budget.extended 事件並更新快照；因預算阻塞的任務在調整之後不再超限時恢復
   * （工作流讓正在等待的 agent 在同一步接著做；對話任務回到 RUNNING，並讓被打斷的 agent 接著做）。
   * 引數不合法 → 400（BudgetInputError）；終態任務 → 409（TaskTerminalError）。
   */
  async adjustBudget(taskId: string, input: BudgetAdjustment): Promise<BudgetAdjustResult> {
    const limits = input.limits ?? {};
    const problem = budgetLimitsProblem(limits as Record<string, unknown>);
    if (problem) throw new BudgetInputError(problem);
    const provided = BUDGET_LIMITS.filter((limit) => limits[limit] !== undefined);
    if (provided.length === 0 && input.relax !== true) throw new BudgetInputError('請至少指定一項要調整的預算，或者用 relax: true 放寬用完的那一項。');
    return this.command(taskId, () => this.adjustBudgetNow(taskId, limits, input.relax === true, input.resume !== false));
  }

  private async adjustBudgetNow(taskId: string, limits: Partial<TaskBudget>, relax: boolean, resume: boolean): Promise<BudgetAdjustResult> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不需要再調整預算。');
    const changes: BudgetAdjustResult['changes'] = {};
    for (const limit of BUDGET_LIMITS) {
      const to = limits[limit];
      if (to !== undefined && to !== run.budget[limit]) changes[limit] = { from: run.budget[limit], to };
    }
    const blockedLimit = budgetBlockLimit(run);
    if (Object.keys(changes).length > 0 || relax) {
      const summary = Object.entries(changes)
        .map(([limit, change]) => `${limit} ${change!.from ?? '—'} → ${change!.to}`)
        .join('，');
      await this.publish(task, {
        type: 'budget.extended',
        data: {
          reason: 'operator',
          changes,
          renew: relax,
          ...(blockedLimit ? { blockedLimit } : {}),
          action: relax ? `操作員放寬了預算（重新給一份額度）${summary ? `：${summary}` : ''}` : `操作員調整了預算：${summary}`,
        },
      });
    }

    let resumed = false;
    let message: string | undefined;
    if (resume && blockedLimit) {
      const fresh = await this.mustRun(task.runId);
      const target = this.budgetResumeTarget(fresh);
      const modelAgent = target === undefined || this.adapters.get(target)?.info.kind !== 'test';
      const now = this.now();
      const still = runtimeViolations(fresh.budget, now)[0] ?? dispatchViolation(fresh.budget, now, { calls: 1, modelAgent });
      if (still) {
        message = `調整之後預算仍然不夠（${describeBudgetLimit(still, fresh.budget)}），任務保持阻塞。可以再放寬一些。`;
      } else {
        resumed = await this.resumeAfterBudget(task);
        if (!resumed && !isTerminal((await this.mustRun(task.runId)).status)) {
          message = '預算已調整，但這個任務現在沒有可以直接接著做的步驟：請按「重試」、「換人接手」或「接受結果」。';
        }
      }
    }
    const after = await this.mustRun(task.runId);
    return { changes, renewed: relax, resumed, status: after.status, ...(message ? { message } : {}), budget: after.budget };
  }

  /** 放寬預算後第一個要接著工作的 agent（用來判斷是不是模型 agent）。 */
  private budgetResumeTarget(run: RunSnapshot): string | undefined {
    if (run.workflowState) return run.workflowState.awaitingAgentId;
    return run.blockedBy?.interruptedAgentIds?.[0];
  }

  /**
   * 因預算阻塞的任務放寬預算後恢復（P0-7）。返回是否已經恢復。
   * - 工作流：讓正在等待的 agent 在同一步接著做（沒有正在等待的 agent 時不恢復，由操作員走閘門）；
   * - 對話：回到 RUNNING，再讓被預算停止打斷的 agent（主 agent 在前）從中斷的地方接著做。
   */
  private async resumeAfterBudget(task: TaskRecord): Promise<boolean> {
    const run = await this.mustRun(task.runId);
    if (run.status !== 'BLOCKED') return false;
    if (run.workflowState) {
      let directive: WorkflowDirective | undefined;
      await this.locks.run(task.runId, async () => {
        const fresh = await this.mustRun(task.runId);
        if (fresh.status !== 'BLOCKED' || !fresh.workflowState) return;
        const plan = resumeStep(fresh.workflowState, this.now());
        if (!plan) return;
        fresh.workflowState = plan.state;
        directive = plan.directive;
        await this.store.commit({ run: fresh });
      });
      if (!directive) return false;
      if (directive.type === 'dispatch') await this.releaseStepTarget(task, directive.agentId);
      await this.publish(task, { type: 'run.status', data: { status: 'RUNNING', step: 'workflow:budget-resume', action: '預算已放寬，繼續這一步' } });
      await this.executeDirective(task.id, directive);
      return true;
    }
    const interrupted = run.blockedBy?.interruptedAgentIds ?? [];
    await this.transitionTo(task.id, 'RUNNING', 'operator:budget-resume', { action: '預算已放寬，任務已恢復' });
    const lead = run.primaryAgentId ?? run.currentAgentId;
    const ordered = [...interrupted].sort((a, b) => Number(b === lead) - Number(a === lead));
    for (const agentId of ordered) {
      if (!this.adapters.has(agentId)) continue;
      try {
        await this.deliver(task.id, agentId, BUDGET_RESUME_MESSAGE, 'orchestrator', { budgetResume: true });
      } catch (error) {
        // 這期間任務被停止：不再繼續，這不是錯誤
        if (error instanceof TaskTerminalError) break;
        // 接不上（例如執行時不支援續接）：任務已經恢復，操作員可以直接發訊息繼續；記錄原因即可
        this.log(`could not continue ${agentId} after the budget was raised (task ${task.id})`, error);
      }
    }
    return true;
  }

  /**
   * 解決審批並在同一個邏輯步驟上續跑。
   *
   * 順序：先持久化 approval.resolved（事件 + 快照同事務），再把決定交給 adapter。
   * - 會話仍在本程序：adapter.approve
   * - 程序重啟過：adapter.resume（帶已完成副作用台賬，禁止重放）
   * - adapter 無法續跑：fail closed -> BLOCKED
   */
  async resolveApproval(
    taskId: string,
    approvalId: string,
    decision: 'approve' | 'decline',
    scope: 'once' | 'session' = 'once',
    options: ApprovalOptions = {},
  ): Promise<void> {
    await this.command(taskId, () => this.resolveApprovalNow(taskId, approvalId, decision, scope, options));
  }

  /**
   * 審批只消費一次（H-12）：在 run 鎖內一次完成“確認仍待處理 → 提交 approval.resolved”（見 approvalClaims / handleEvent），
   * 只有提交成功（搶到）的呼叫才執行副作用（approve / resume / 投遞交接）；輸掉的呼叫得到 409（ApprovalConflictError），
   * 不碰 adapter，任務也不會因此被置為 BLOCKED。終態 run 上的審批一律 409（TaskTerminalError），工具不執行。
   */
  private async resolveApprovalNow(
    taskId: string,
    approvalId: string,
    decision: 'approve' | 'decline',
    scope: 'once' | 'session',
    options: ApprovalOptions,
    /** 由審批策略自動放行（P2-7）；by=timeout 是提問過期後的跳過（P2-6）。 */
    policy?: { ruleId?: string; reason: string; risk: string; by?: 'policy' | 'timeout' },
  ): Promise<void> {
    const task = await this.mustTask(taskId);
    let run = await this.mustRun(task.runId);
    const approval = run.pendingApprovals.find((x) => x.id === approvalId);
    if (!approval || approval.status !== 'pending' || isTerminal(run.status)) {
      const record = await this.store.getApproval(approvalId);
      // 已經批准 / 拒絕過：告訴操作員它已經處理過了（重複提交、另一個標籤頁先點了）
      if (record && record.runId === run.runId && (record.status === 'approved' || record.status === 'declined')) throw new ApprovalConflictError({ approvalId, status: record.status });
      // 任務已結束：這個審批已作廢（或結束後才到、已被自動拒絕），工具不會執行
      if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '這個審批已作廢，操作不會執行。');
      throw new Error(`Pending approval not found: ${approvalId}`);
    }
    const adapter = this.mustAdapter(approval.agentId);
    // 回答 AI 的問題（P2-6）：只接受這個審批裡有的問題 ID，每個答案有長度上限
    const answers = approval.payload?.kind === 'question' && options.answers ? sanitizeAnswers(approval.payload, options.answers) : undefined;

    // 批准交接請求：先確認交接執行得了，再消費審批（P0 第二批審查）——不能出現“審批記為已批准，交接卻沒有執行”
    let handoffTicket: DispatchTicket | undefined;
    /** 工作流任務裡，交接目標就是工作流正在等 / 接下來要派發的 agent：轉交內容併入工作流給它的下一個信封（P0 第三批審查）。 */
    let mergeIntoWorkflow = false;
    if (approval.payload?.kind === 'handoff' && decision === 'approve') {
      const toAgentId = String(approval.payload.toAgentId);
      this.mustAdapter(toAgentId);
      mergeIntoWorkflow = run.workflowState !== undefined && approval.payload.handoffKind !== 'consult' && this.handoffJoinsWorkflow(run, toAgentId);
    }
    if (approval.payload?.kind === 'handoff' && decision === 'approve' && !mergeIntoWorkflow) {
      const toAgentId = String(approval.payload.toAgentId);
      if (run.status === 'BLOCKED' && !run.workflowState) {
        // 已阻塞的對話任務：不帶 resume 時 409，審批保持待處理；帶 resume（介面上的「恢復並轉交」）時先顯式恢復
        if (!options.resume) throw this.blockedError(task, run, '交接沒有執行，這個請求仍然等你決定。', '選擇「恢復並轉交」（會先恢復任務再轉交），或者「換人接手」、「停止」');
        await this.resumeConversation(task, run);
        run = await this.mustRun(task.runId);
      }
      // 預算前置檢查並領取派發許可：不夠就在消費審批之前拒絕（409，任務因預算阻塞，可以一鍵放寬），審批保持待處理
      handoffTicket = await this.claimDispatch(taskId, [toAgentId], 'handoff', { refusal: '交接沒有執行，這個請求仍然等你決定。請按「放寬預算並繼續」後再批准' });
      if (!handoffTicket) return;
    }

    // 會話級批准只在執行時允許時生效（M-15）：審批請求標明不提供會話級選項（allowSessionScope=false，例如 Claude 的
    // suppressAlwaysAllowRule、命令涉及受保護路徑）時，即使收到 scope=session 也只批准這一次，並在記錄裡寫明降級
    // 交接請求沒有會話級的說法（P0-9）：批准只執行這一次交接，之後同樣的請求照樣要按策略重新決定
    const scopeDowngraded = decision === 'approve' && scope === 'session' && (approval.payload?.allowSessionScope === false || approval.payload?.kind === 'handoff');
    const effectiveScope: 'once' | 'session' = scopeDowngraded ? 'once' : scope;

    // 併入工作流的交接內容先記進快照（在消費審批之前：審批一旦記為批准，快取的完成訊號就會被重放、派發下一步，
    // 那時內容必須已經在那裡）；審批沒能消費（409）時撤回
    const pendingHandoff: PendingHandoff | undefined =
      mergeIntoWorkflow && approval.payload
        ? {
            id: approvalId,
            fromAgentId: String(approval.payload.fromAgentId),
            toAgentId: String(approval.payload.toAgentId),
            instruction: String(approval.payload.instruction ?? ''),
            content: String(approval.payload.content ?? ''),
            at: this.now(),
          }
        : undefined;
    if (pendingHandoff) await this.updatePendingHandoffs(run.runId, (list) => [...list.filter((item) => item.id !== approvalId), pendingHandoff]);

    // 鎖內原子消費：持久化階段確認該審批仍待處理、run 不是終態，才提交這個事件；否則事件不落盤、這裡丟擲 409
    const eventId = randomUUID();
    this.approvalClaims.set(eventId, approvalId);
    try {
      await this.publish(task, {
        id: eventId,
        type: 'approval.resolved',
        severity: decision === 'approve' ? 'info' : 'warning',
        agentId: approval.agentId,
        sessionId: approval.sessionId,
        data: {
          approvalId,
          decision,
          providerCallId: approval.providerCallId,
          resolvedBy: policy ? (policy.by ?? 'policy') : 'operator',
          ...(policy ? { policy } : {}),
          scope: decision === 'approve' ? effectiveScope : undefined,
          ...(scopeDowngraded ? { scopeDowngraded: true } : {}),
          // 問題的答案（P2-6）：機密問題的答案不寫進記錄
          ...(answers ? { answers: recordedAnswers(approval.payload, answers) } : {}),
          resumeStep: run.resumeCursor?.step ?? run.currentStep,
          ...(pendingHandoff ? { mergedIntoWorkflow: true } : {}),
        },
      });
    } catch (error) {
      if (pendingHandoff) await this.updatePendingHandoffs(run.runId, (list) => list.filter((item) => item.id !== approvalId));
      throw error;
    } finally {
      this.approvalClaims.delete(eventId);
    }

    // 以下只有搶到的呼叫才會執行
    // agent 交接請求：不涉及 provider，批准後由編排器執行交接（只投遞一次）
    if (approval.payload?.kind === 'handoff') {
      if (pendingHandoff) {
        // 併入工作流：不單獨派發（同一個 agent 同時收到兩條訊息，第一輪的完成就會被當成下一步的完成）
        const from = this.agentName(pendingHandoff.fromAgentId);
        const to = this.agentName(pendingHandoff.toAgentId);
        await this.publish(task, {
          type: 'handoff.requested',
          agentId: pendingHandoff.toAgentId,
          data: { fromAgentId: pendingHandoff.fromAgentId, toAgentId: pendingHandoff.toAgentId, contextRef: `handoff:${approvalId}`, reason: 'agent-request', auto: false, instruction: pendingHandoff.instruction, mergedIntoWorkflow: true },
        });
        await this.publish(task, {
          type: 'runtime.warning',
          severity: 'info',
          agentId: pendingHandoff.toAgentId,
          data: {
            code: 'HANDOFF_MERGED_INTO_WORKFLOW',
            fromAgentId: pendingHandoff.fromAgentId,
            toAgentId: pendingHandoff.toAgentId,
            message: `已同意 ${from} 的交接請求。${to} 正是自動流程接下來要交代工作的 Agent，轉交的內容會附在流程下一次交給 ${to} 的指令裡，不另外派發（避免同一時間派兩份工作）。`,
          },
        });
        return;
      }
      if (decision === 'approve') {
        const p = approval.payload;
        await this.handoffNow(taskId, String(p.fromAgentId), String(p.toAgentId), String(p.content ?? '') || '(no content provided)', String(p.instruction ?? ''), {
          reason: 'agent-request',
          ticket: handoffTicket,
          kind: p.handoffKind === 'consult' ? 'consult' : 'transfer',
        });
      }
      return;
    }

    const payload: ApprovalDecision = {
      approvalId,
      decision,
      scope: decision === 'approve' ? effectiveScope : undefined,
      providerCallId: approval.providerCallId,
      ...(answers && decision === 'approve' ? { answers } : {}),
    };
    // 決定交給了 agent（或者已經沒有必要再交）之後記下投遞狀態（P1-1）：崩潰發生在這之前時，恢復會按原決定補投一次
    const delivered = (how: string) => this.publish(task, { type: 'approval.delivered', agentId: approval.agentId, data: { approvalId, how } });
    await this.withAgent(task.runId, approval.agentId, async () => {
      const after = await this.mustRun(task.runId);
      // 決定已經記下；這期間任務被停止了就不再把它交給 agent（停止時已經取消了全部會話）
      if (isTerminal(after.status)) return delivered('task-ended');
      const session = after.agentSessions[approval.agentId];
      if (!session) return delivered('no-session');
      const key = sessionKey(session);

      if (this.liveSessions.has(key)) {
        if (adapter.approve) {
          await this.callAdapter(task, approval.agentId, 'ADAPTER_APPROVE_FAILED', () => adapter.approve!(key, payload, this.adapterSink(task, approval.agentId)));
        }
        await delivered('live');
        // 拒絕即停（M-18）：任務已經停在這裡等你決定，AI 不能拿著“被拒絕”的結果自己換個辦法繼續做下去；
        // 停下它這一輪，之後你發訊息（或按橫幅上的按鈕）時再接回原來的對話
        if (decision === 'decline') await this.cancelSessionKey(task, approval.agentId, key);
        return;
      }

      // 拒絕時 run 已進入 BLOCKED，無需為了通知拒絕而喚醒一個已斷開的會話
      if (decision !== 'approve') return delivered('declined-offline');

      if (!(await this.resumePrecheck(task, after, session))) return;
      // 預批准按完整輸入匹配（M-19）：介面上顯示的 toolInput 可能被截斷，長的 Write 用它永遠匹配不上
      const request = approval.payload && approval.payload.fullInput !== undefined ? { ...approval.payload, toolInput: approval.payload.fullInput } : approval.payload;
      if (await this.resumeSession(task, after, session, 'approval', { approval: payload, approvalRequest: request })) await delivered('resumed');
    });
  }

  /**
   * 工作流任務裡批准的交接，目標是不是工作流正在等 / 接下來要派發的 agent（P0 第三批審查）：
   * - 正在等它完成這一步；
   * - 正在等評審 / 診斷的 agent，而目標是實現者（診斷之後由實現者修復、評審提出修改時由實現者修改）；
   * - 等待審批期間快取了正在等的 agent 的完成訊號：按這個訊號推演（decide 是純函式），下一步派給的正是目標。
   */
  private handoffJoinsWorkflow(run: RunSnapshot, toAgentId: string): boolean {
    const ws = run.workflowState;
    if (!ws) return false;
    if (ws.awaitingAgentId === toAgentId) return true;
    if (ws.agents.implement === toAgentId && ws.awaitingAgentId !== undefined && (ws.step === 'rescue' || ws.step === 'review')) return true;
    const deferred = ws.deferredSignal;
    if (!deferred || deferred.stepSeq !== ws.stepSeq || deferred.agentId !== ws.awaitingAgentId) return false;
    try {
      const { directive } = decide(ws, { kind: deferred.kind, agentId: deferred.agentId, data: deferred.data }, { now: this.now(), canReview: canStartReviewRound(run.budget) });
      return directive.type === 'dispatch' && directive.agentId === toAgentId;
    } catch {
      return false;
    }
  }

  /** 修改併入工作流的交接內容（鎖內只寫快照）。 */
  private async updatePendingHandoffs(runId: string, update: (list: PendingHandoff[]) => PendingHandoff[]): Promise<void> {
    await this.locks.run(runId, async () => {
      const run = await this.mustRun(runId);
      const ws = run.workflowState;
      if (!ws) return;
      const next = update(ws.pendingHandoffs ?? []);
      if (next.length > 0) ws.pendingHandoffs = next;
      else delete ws.pendingHandoffs;
      await this.store.commit({ run });
    });
  }

  /**
   * 人工閘門 / 放寬預算重新派發這一步之前（P0 第三批審查，M-1 / M-18 的緩解）：目標 agent 還有進行中的一輪（例如拒絕審批後它還在收尾、
   * 評審閘門上剛問了它一句），就先停掉那一輪——否則新的指令排在它後面，舊一輪一結束就被當成新一步的完成。
   * 它還掛著的工具審批（屬於要被停掉的舊一輪）一併作廢（approval.resolved，withdrawn：不會讓任務進入 BLOCKED）。
   */
  private async releaseStepTarget(task: TaskRecord, agentId: string): Promise<void> {
    const run = await this.mustRun(task.runId);
    const stale = run.pendingApprovals.filter((approval) => approval.agentId === agentId && approval.status === 'pending' && approval.payload?.kind !== 'handoff');
    for (const approval of stale) {
      try {
        await this.publish(task, {
          type: 'approval.resolved',
          severity: 'warning',
          agentId,
          sessionId: approval.sessionId,
          data: { approvalId: approval.id, decision: 'decline', resolvedBy: 'orchestrator', reason: 'step-restarted', withdrawn: true, providerCallId: approval.providerCallId },
        });
      } catch (error) {
        this.log(`failed to withdraw approval ${approval.id} before restarting the step (task ${task.id})`, error);
      }
    }
    const working = (run.budget.workingAgentIds ?? []).includes(agentId) || this.dispatching.has(activityKey(task.runId, agentId));
    if (!working && stale.length === 0) return;
    const session = run.agentSessions[agentId];
    if (!session) return;
    const key = sessionKey(session);
    if (this.liveSessions.has(key) || this.retiredSessions.has(key) || this.pendingCancels.has(key)) await this.cancelSessionKey(task, agentId, key, { force: true });
  }

  /**
   * 停止任務：先進入 CANCELLED，再停止該 run 的全部線上會話（H-5：Ask Both 時兩個 agent 都停）。
   *
   * 停止是搶佔式的，不等排在前面的命令：它們可能正卡在很慢的啟動上，「停止」必須立刻生效。
   * 進行中的命令與編排反應在鎖內複核時會看到終態（或停止代數變化）而放棄；啟動中的會話返回後立刻被取消。
   * 停止之後才到達的命令排在它後面，屆時看到終態得到 409。重複停止同一個已停止的任務是冪等的。
   */
  /**
   * 只停下某一個 agent 當前這一輪（P1-10 / M-27），任務本身和其他 agent 不受影響。
   * 取消它的會話（執行時結束當前一輪，對話裡顯示“已停止”）；下一條訊息自動續接原來的對話，上下文不丟。
   * 自動流程正在等待的那個 agent 不能單獨停（流程會卡住），返回 409 並提示用「停止」或閘門上的「重試」。
   */
  async interruptAgent(taskId: string, agentId: string): Promise<void> {
    return this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      const run = await this.mustRun(task.runId);
      if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不需要再停下。');
      const session = run.agentSessions[agentId];
      const key = session ? sessionKey(session) : undefined;
      const active = key !== undefined && (this.liveSessions.has(key) || this.retiredSessions.has(key));
      const working = (run.budget.workingAgentIds ?? []).includes(agentId) || this.dispatching.has(activityKey(run.runId, agentId));
      if (!active || !working) {
        throw new AgentInterruptError(`${agentId} 現在沒有正在進行的一輪，不需要停下。`, { taskId, agentId });
      }
      if (run.workflowState && run.workflowState.awaitingAgentId === agentId && run.status === 'RUNNING') {
        throw new AgentInterruptError(`${agentId} 正在執行自動流程的這一步，單獨停下會讓流程卡住。要停下請按「停止」；想讓它重做請用「重試」。`, { taskId, agentId });
      }
      await this.cancelSessionKey(task, agentId, key!);
    });
  }

  /**
   * 放棄 / 歸檔一個任務（P1-12）：任務進入終態 FAILED（原因 abandoned），停止它的全部會話；重啟後不再恢復它。
   * 用於長期阻塞、不打算再處理的任務——它們不會在每次啟動時被重新處理一遍。
   */
  async abandonTask(taskId: string): Promise<void> {
    await this.command(taskId, async () => {
      const task = await this.mustTask(taskId);
      const run = await this.mustRun(task.runId);
      if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不需要再放棄。');
      await this.transitionTo(taskId, 'FAILED', 'abandoned', { action: '操作員放棄了這個任務（已歸檔，重啟後不再恢復）' });
      await this.stopAllSessions(task);
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    const existing = this.cancelling.get(taskId);
    if (existing) return existing;
    const cancelling = this.cancelNow(taskId).finally(() => this.cancelling.delete(taskId));
    this.cancelling.set(taskId, cancelling);
    // 停止之後才到達的命令排在這次停止後面（屆時看到終態、得到 409）；停止本身不等排在前面的命令
    void this.command(taskId, () => cancelling.catch(() => undefined));
    return cancelling;
  }

  private async cancelNow(taskId: string): Promise<void> {
    const task = await this.mustTask(taskId);
    const run = await this.mustRun(task.runId);
    if (run.status === 'CANCELLED') {
      // 已經停止：冪等。上一次停止時沒有及時響應的會話（取消未完成）這次再取消一次，其餘什麼都不做
      await this.stopAllSessions(task);
      return;
    }
    if (isTerminal(run.status)) throw TaskTerminalError.of(taskId, run.status, '不需要再停止。');
    await this.transitionTo(taskId, 'CANCELLED', 'cancelled');
    await this.stopAllSessions(task);
  }

  /**
   * 程序啟動時呼叫：恢復所有非終態 run。
   *
   * 不假設 provider 會話仍然存活；無法證明時 fail closed（BLOCKED + runtime.error），
   * 由操作員決定，絕不因為重啟而重放已完成的副作用。
   */
  async recover(): Promise<RecoveryReport> {
    const report: RecoveryReport = { resumed: [], waiting: [], blocked: [], failedClosed: [] };

    for (const loaded of await this.store.listRecoverableRuns()) {
      // 每個 run 轉移會話歸屬之前都確認租約仍在本實例手裡（恢復途中丟失租約則立即停止，不再寫入）
      this.assertInstanceLease();
      this.events.seedSequence(loaded.runId, await this.store.getLastSequence(loaded.runId));
      const task = await this.store.getTask(loaded.taskId);
      if (!task) continue;

      if (loaded.status !== 'ok') {
        const code = loaded.status === 'unsupported-schema' ? 'SNAPSHOT_SCHEMA_UNSUPPORTED' : 'SNAPSHOT_CORRUPTED';
        await this.publish(task, {
          type: 'runtime.error',
          severity: 'critical',
          data: {
            code,
            ...(loaded.status === 'unsupported-schema'
              ? { schemaVersion: loaded.schemaVersion, supportedVersion: loaded.supportedVersion }
              : { error: loaded.error }),
            action: code === 'SNAPSHOT_SCHEMA_UNSUPPORTED' ? 'Snapshot requires a newer binary or migration' : 'Snapshot corrupted; operator required',
          },
        });
        report.failedClosed.push(loaded.runId);
        continue;
      }

      const transferred: Array<{ agentId: string; from: string }> = [];
      const conflicts: Array<{ agentId: string; error: unknown }> = [];
      /** 重啟前確實處於工作中的 agent（空閒的對話會話不應被“續跑”打擾）。 */
      const activeBefore = new Set<string>();
      await this.locks.run(loaded.runId, async () => {
        const fresh = await this.mustRun(loaded.runId);
        fresh.recovery = { recoveredAt: this.now(), count: (fresh.recovery?.count ?? 0) + 1, streak: (fresh.recovery?.streak ?? 0) + 1 };
        // 停機的時間不算步驟不活動：看門狗從恢復這一刻重新計時
        if (fresh.workflowState) fresh.workflowState.lastActivityAt = this.now();
        // 重新登記會話歸屬；原持有程序已不存在，歸屬顯式轉移到本實例
        for (const session of Object.values(fresh.agentSessions)) {
          try {
            this.sessions.attach({ runId: fresh.runId, agentId: session.agentId, adapterType: session.adapterType, providerSessionId: session.providerSessionId });
          } catch (error) {
            conflicts.push({ agentId: session.agentId, error });
            continue;
          }
          if (session.ownerInstanceId && session.ownerInstanceId !== this.instanceId) {
            transferred.push({ agentId: session.agentId, from: session.ownerInstanceId });
          }
          session.ownerInstanceId = this.instanceId;
          // 重啟後會話不線上：活動中的狀態改為 waiting，等待續接或操作員決定
          if (['starting', 'planning', 'coding', 'reviewing', 'testing'].includes(session.status)) {
            activeBefore.add(session.agentId);
            session.status = 'waiting';
          }
        }
        // 停機時間不計入時長預算（P0-7）：上一個程序留下的計時段截止到它最後一次記賬。
        // 重啟之後沒有任何 agent 在本程序裡工作：“正在工作”清空（P0 第二批審查），真正續上的 agent 由續接時的
        // agent.started / 工作狀態事件重新登記。否則沒有續上的 agent（例如在等審批、之後被拒絕）會一直殘留，空閒的時間也被計時
        closeActiveClockAfterRestart(fresh.budget);
        fresh.budget.workingAgentIds = [];
        await this.store.commit({ run: fresh });
      });
      for (const item of transferred) {
        await this.publish(task, {
          type: 'runtime.warning',
          severity: 'warning',
          agentId: item.agentId,
          data: { code: 'SESSION_OWNER_TRANSFERRED', from: item.from, to: this.instanceId },
        });
      }
      if (conflicts.length) {
        for (const item of conflicts) await this.reportOwnershipConflict(task, item.agentId, item.error);
        await this.failClosed(task, 'SESSION_OWNERSHIP_CONFLICT', 'Session ownership conflict during recovery', conflicts[0]!.agentId);
        report.blocked.push(loaded.runId);
        continue;
      }

      const run = await this.mustRun(loaded.runId);
      await this.publish(task, {
        type: 'runtime.warning',
        severity: 'warning',
        data: {
          code: 'RUN_RECOVERED',
          status: run.status,
          step: run.currentStep,
          pendingApprovalIds: run.pendingApprovals.map((x) => x.id),
          completedSideEffects: run.sideEffectCount ?? run.completedSideEffects.length,
          action: 'Recovered after restart',
        },
      });

      if (run.status === 'BLOCKED') {
        report.blocked.push(run.runId);
        continue;
      }
      // 升級前建立的任務沒有經過工作目錄校驗（P0-10 審查）：不合規的不續跑、不等待，fail closed 並說明原因
      const workspaceIssue = this.runWorkspaceProblem(run);
      if (workspaceIssue) {
        await this.failClosed(task, 'WORKSPACE_REJECTED', workspaceIssue.problem, workspaceIssue.agentId);
        report.blocked.push(run.runId);
        continue;
      }
      // 檢查該 run 的全部會話，不只看 currentAgentId（H-5 / probe3 B：Ask Both 時 currentAgentId 可能是已經答完的顧問）
      const active = Object.values(run.agentSessions).filter((s) => activeBefore.has(s.agentId));
      const wouldResume = active.length > 0 || (run.status === 'RUNNING' && run.workflowState !== undefined);
      // 行為版本不同（P1-14）：舊 / 新版本程式做了一半的任務不按當前語義自動續跑，停下來說明由哪個版本建立
      const behavior = run.createdBy?.behavior ?? BEHAVIOR_VERSION;
      if (wouldResume && behavior !== BEHAVIOR_VERSION) {
        const by = run.createdBy?.appVersion ? `版本 ${run.createdBy.appVersion}` : `行為版本 ${behavior}`;
        await this.failClosed(task, 'RECOVERY_VERSION_MISMATCH', `這個任務是由${by}建立的，和目前的程式不相容，重啟後沒有自動接著做。請確認工作區的狀態後，用「重試」或「換人接手」繼續，或者停止它。`);
        report.blocked.push(run.runId);
        continue;
      }
      // 審批決定的 outbox（P1-1 / L-4）：已經記下、還沒交給 agent 的決定——批准的按原決定補投一次（續接時帶上這個決定），
      // 拒絕的不需要再喚醒 agent（任務已經停在那裡等你），直接記為已處理
      const redelivered = new Set<string>();
      for (const d of run.undeliveredDecisions ?? []) {
        const session = run.agentSessions[d.agentId];
        if (d.decision !== 'approve' || !session || !this.adapters.get(d.agentId)?.resume) {
          await this.publish(task, { type: 'approval.delivered', agentId: d.agentId, data: { approvalId: d.approvalId, how: 'recovery-skipped' } });
          continue;
        }
        const fresh = await this.mustRun(run.runId);
        const decision: ApprovalDecision = { approvalId: d.approvalId, decision: 'approve', scope: d.scope, providerCallId: d.providerCallId, ...(d.answers ? { answers: d.answers } : {}) };
        if ((await this.resumePrecheck(task, fresh, session)) && (await this.resumeSession(task, fresh, session, 'approval', { approval: decision, approvalRequest: d.request }))) {
          await this.publish(task, { type: 'approval.delivered', agentId: d.agentId, data: { approvalId: d.approvalId, how: 'redelivered-after-restart' } });
          redelivered.add(d.agentId);
        }
      }
      if (redelivered.size > 0) {
        const remaining = active.filter((s) => !redelivered.has(s.agentId));
        if (remaining.length > 0 && !(await this.resumeRecoveredSessions(task, await this.mustRun(run.runId), remaining))) {
          report.blocked.push(run.runId);
          continue;
        }
        report.resumed.push(run.runId);
        continue;
      }

      // 執行到一半的副作用（P1-2 / M-9）：崩潰前開始了、沒有看到結果的呼叫可能已經執行過。
      // 不盲目續跑（續跑可能把它再做一次），停下來列出這些呼叫，由操作員確認後再繼續（發訊息或「重試」時會一併告訴 agent）
      // 正在等審批的呼叫還沒有執行（在等你批准），不算狀態不明
      const awaitingIds = new Set([
        ...run.pendingApprovals.filter((a) => a.status === 'pending').map((a) => a.providerCallId),
        ...(run.undeliveredDecisions ?? []).map((d) => d.providerCallId),
      ].filter(Boolean));
      const uncertain = (run.inFlightSideEffects ?? []).filter((x) => active.some((s) => s.agentId === x.agentId) && !awaitingIds.has(x.id));
      if (uncertain.length > 0) {
        const list = uncertain.slice(-5).map((x) => `${x.agentId ?? ''} ${x.name ?? '工具'}${x.summary ? `：${x.summary}` : ''}`).join('；');
        await this.failClosed(
          task,
          'SIDE_EFFECT_UNCERTAIN',
          `服務重啟前有 ${uncertain.length} 個操作已經開始、但沒有看到結果，可能已經執行過了：${list}。為了不重複執行，這次沒有自動接著做。請先確認工作區的狀態，再發訊息或按「重試」讓 AI 繼續（會提醒它先檢查這些操作）。`,
          uncertain[uncertain.length - 1]!.agentId,
          undefined,
          { uncertain: uncertain.slice(-10).map((x) => ({ id: x.id, agentId: x.agentId, name: x.name, summary: x.summary })) },
        );
        report.blocked.push(run.runId);
        continue;
      }
      // 恢復次數上限（P1-14）：連續好幾次重啟都沒能做完任何一輪（例如每次續跑都讓程序崩潰），不再自動續跑
      if (wouldResume && (run.recovery?.streak ?? 0) > this.maxRecoveryStreak) {
        await this.failClosed(task, 'RECOVERY_ATTEMPTS_EXCEEDED', `這個任務已經連續 ${run.recovery?.streak} 次在重啟後接著做，但一輪都沒有做完（可能每次接著做都會讓程式出錯）。為了避免反覆重來，這次沒有自動接著做，請你決定下一步。`);
        report.blocked.push(run.runId);
        continue;
      }
      if (run.status === 'WAITING_APPROVAL' || run.status === 'WAITING_INPUT') {
        // 等待操作員：有待審批的 agent 由審批續跑；其餘重啟前仍在工作的 agent（例如 Ask Both 的另一個）照常續跑。
        // 交接審批不會暫停請求者（request_handoff 立即返回，它繼續把這一輪做完），批准交接也不會續跑它：
        // 只有這類審批的 agent 不算“因審批暫停”，照常續跑（續不上就 fail closed 並指明是它，P0 第二批審查）
        const awaitingApproval = new Set(run.pendingApprovals.filter((x) => x.payload?.kind !== 'handoff').map((x) => x.agentId));
        const others = active.filter((s) => !awaitingApproval.has(s.agentId));
        if (others.length > 0 && !(await this.resumeRecoveredSessions(task, run, others))) {
          report.blocked.push(run.runId);
          continue;
        }
        report.waiting.push(run.runId);
        continue;
      }

      let targets = active;
      if (targets.length === 0 && run.status === 'RUNNING') {
        // 對話（手動）任務裡，重啟時沒有在工作的 agent 只是在等你說話：不續跑、不阻塞，下一條訊息時再續接會話
        if (!run.workflowState && Object.keys(run.agentSessions).length > 0) {
          report.waiting.push(run.runId);
          continue;
        }
        // 工作流任務（M-8 過渡，P1-1 outbox 之前）：按 workflowState 重新執行當前步驟的指令——
        // 決定已經提交、派發 / 等待 / 完成還沒落盤就退出時，不再去“續跑”剛做完上一步的 currentAgentId
        let outcome: 'resumed' | 'waiting' | 'blocked' | undefined;
        try {
          outcome = run.workflowState ? await this.redriveWorkflowStep(task, run) : undefined;
        } catch (error) {
          // 重新驅動失敗不能讓整個啟動恢復失敗：這個任務 fail closed，其餘任務照常恢復
          if (error instanceof Error && error.message === INSTANCE_LEASE_NOT_HELD) throw error;
          this.log(`recovery: re-driving the workflow step failed (task ${task.id})`, error);
          await this.failClosed(task, 'RUNTIME_DISCONNECTED', `Could not continue workflow step ${run.workflowState?.step ?? ''} after restart: ${(error as Error).message}`, run.workflowState?.awaitingAgentId);
          outcome = 'blocked';
        }
        if (outcome) {
          report[outcome].push(run.runId);
          continue;
        }
        // 兜底：沿用原規則，續跑當前步驟的 agent
        const current = run.currentAgentId ? run.agentSessions[run.currentAgentId] : undefined;
        targets = current ? [current] : [];
      }
      if (run.status === 'RUNNING' && targets.length > 0) {
        (await this.resumeRecoveredSessions(task, run, targets) ? report.resumed : report.blocked).push(run.runId);
        continue;
      }

      await this.failClosed(task, 'RUNTIME_DISCONNECTED', 'Cannot prove provider runtime state after restart; operator decision required', targets[0]?.agentId ?? run.currentAgentId);
      report.blocked.push(run.runId);
    }

    return report;
  }

  /**
   * 重啟後續跑一組會話（主 agent 在前）。任何一個的 adapter 不能續跑就整體 fail closed（不做一半）；
   * 某個續跑失敗時 run 已經 fail closed，其餘會話不再續跑，等操作員決定。返回是否全部續上。
   */
  private async resumeRecoveredSessions(task: TaskRecord, run: RunSnapshot, sessions: SessionSnapshot[]): Promise<boolean> {
    const lead = run.workflowState?.awaitingAgentId ?? run.primaryAgentId ?? run.currentAgentId;
    const ordered = [...sessions].sort((a, b) => Number(b.agentId === lead) - Number(a.agentId === lead));
    const cannot = ordered.find((s) => !this.adapters.get(s.agentId)?.resume);
    if (cannot) {
      await this.failClosed(task, 'RUNTIME_DISCONNECTED', 'Cannot prove provider runtime state after restart; operator decision required', cannot.agentId);
      return false;
    }
    for (const target of ordered) {
      const fresh = await this.mustRun(run.runId);
      const session = fresh.agentSessions[target.agentId];
      if (!session || fresh.status === 'BLOCKED' || isTerminal(fresh.status)) return false;
      if (!(await this.resumePrecheck(task, fresh, session)) || !(await this.resumeSession(task, fresh, session, 'recovery'))) return false;
    }
    return true;
  }

  /**
   * 重啟後重新驅動工作流的當前步驟（M-8 過渡，P1-1 outbox 之前）：run 是 RUNNING、重啟前沒有 agent 在工作時呼叫。
   * - 正在等某個 agent（awaitingAgentId）：把這一步重新派給它（它重啟前就在工作的話由呼叫方按會話續接，不會走到這裡）。
   *   工作流已經決定了這一步、但派發沒來得及執行（例如關閉服務時它的完成訊號才被處理）時，這就是那次沒發出去的派發；
   * - 評審閘門（或測試配置確認閘門）還沒有落盤成 WAITING_INPUT：補發等待；
   * - 已經走到 done、run.completed 還沒落盤：補發完成。
   * 返回寫進恢復報告的哪一類；什麼都沒做時返回 undefined（呼叫方按原規則處理）。
   */
  private async redriveWorkflowStep(task: TaskRecord, run: RunSnapshot): Promise<'resumed' | 'waiting' | 'blocked' | undefined> {
    const ws = run.workflowState;
    if (!ws) return undefined;
    if (ws.awaitingAgentId && this.adapters.has(ws.awaitingAgentId)) {
      const agentId = ws.awaitingAgentId;
      const step = ws.step;
      this.log(`recovery: re-dispatching workflow step ${step} to ${agentId} (task ${task.id})`);
      await this.executeDirective(task.id, { type: 'dispatch', step, agentId, mode: stepMode(step), purpose: recoveryPurpose(step), action: { type: 'CONTINUE', agentId } });
      const after = await this.mustRun(run.runId);
      if (after.status === 'BLOCKED') return 'blocked';
      return after.status === 'WAITING_INPUT' ? 'waiting' : 'resumed';
    }
    if (ws.awaitingAgentId) return undefined;
    if (ws.testConfigReview && ws.testConfigReview.source === 'workflow' && (ws.step === 'test' || ws.step === 'final-test')) {
      const prompt = testConfigPrompt(ws.testConfigReview);
      await this.publish(task, {
        type: 'run.status',
        severity: 'warning',
        data: {
          status: 'WAITING_INPUT',
          step: 'workflow:test-config-review',
          pendingInput: { id: TEST_CONFIG_INPUT_ID, prompt },
          nextAction: { type: 'WAIT_INPUT', requestId: TEST_CONFIG_INPUT_ID, prompt },
          testConfigChanges: ws.testConfigReview.changes.map((change) => ({ path: change.path, kind: change.kind })),
          recovered: true,
          action: prompt,
        },
      });
      return 'waiting';
    }
    if (ws.step === 'review-gate') {
      const prompt = ws.review ? `Review verdict ${ws.review.verdict}. Accept, retry with instructions, or cancel.` : 'Tests passed. Accept the result or request a review.';
      await this.executeDirective(task.id, { type: 'wait-input', step: 'review-gate', inputId: REVIEW_GATE_INPUT_ID, prompt, action: { type: 'WAIT_INPUT', requestId: REVIEW_GATE_INPUT_ID, prompt } });
      return 'waiting';
    }
    if (ws.step === 'done') {
      await this.executeDirective(task.id, { type: 'complete', reason: 'Workflow completed (finished after restart)', action: { type: 'FINAL', resultRef: `history#${ws.history.length}` } });
      return 'resumed';
    }
    return undefined;
  }

  private assertInstanceLease(): void {
    if (this.instanceLease && !this.instanceLease.isHeld()) throw new Error(INSTANCE_LEASE_NOT_HELD);
  }

  /**
   * 週期性檢查（例如時長預算）。服務端用定時器呼叫。
   * 檢查執行中的 run，以及已阻塞但仍有 agent 在完成當前一輪的 run（P0-7：阻塞期間 agent 的工作同樣受限額約束）。
   */
  async checkBudgets(): Promise<void> {
    for (const loaded of await this.store.listRecoverableRuns()) {
      if (loaded.status !== 'ok') continue;
      const run = loaded.snapshot;
      // 執行中的 run，以及等待人工 / 已阻塞但仍有 agent 在工作的 run（P0 第二批審查：等待審批時仍在工作的 agent 同樣受約束）
      if (run.status === 'RUNNING' || (!isTerminal(run.status) && hasWorkingAgents(run.budget))) {
        await this.enforceBudget(loaded.runId);
      }
    }
  }

  /**
   * 空閒會話回收（P1-5 / M-6）：服務端用定時器呼叫（與預算檢查同一個定時器）。
   * 線上會話同時滿足以下條件時，靜默釋放它的執行時程序：adapter 支援 release；超過 idleSessionMs 沒有任何事件；
   * 不在工作（不在 workingAgentIds、沒有正在派發）；沒有掛起的審批；不是工作流正在等待的 agent。
   * 釋放後會話移出線上表，下一條訊息自動續接（resume），不發任何事件、不改變任務狀態。
   */
  async releaseIdleSessions(): Promise<number> {
    if (this.idleSessionMs <= 0 || this.stopping) return 0;
    let released = 0;
    for (const [key, live] of [...this.liveSessions]) {
      const adapter = this.adapters.get(live.agentId);
      if (!adapter?.release) continue;
      const activity = activityKey(live.runId, live.agentId);
      const last = this.sessionActivity.get(activity);
      // 沒有記錄（例如剛續接）：從現在開始計時
      if (last === undefined) {
        this.sessionActivity.set(activity, this.now());
        continue;
      }
      if (this.now() - last < this.idleSessionMs || this.dispatching.has(activity)) continue;
      try {
        // 在 (run, agent) 派發鎖下複核並釋放：不會和同時到達的訊息搶同一個會話
        const done = await this.withAgent(live.runId, live.agentId, async () => {
          if (this.stopping || this.liveSessions.get(key)?.runId !== live.runId) return false;
          const loaded = await this.store.loadRun(live.runId);
          if (loaded?.status !== 'ok') return false;
          const run = loaded.snapshot;
          if (!isIdleFor(run, live.agentId)) return false;
          if (this.now() - (this.sessionActivity.get(activity) ?? 0) < this.idleSessionMs) return false;
          this.retireSession(key, live.runId, live.agentId, false);
          await adapter.release!(key);
          return true;
        });
        if (done) released += 1;
      } catch (error) {
        this.log(`releasing idle ${live.agentId} session ${key} failed (run ${live.runId})`, error);
      }
    }
    return released;
  }

  /**
   * 步驟不活動看門狗（P0-6 / H-10）：服務端用定時器呼叫（與預算檢查同一個定時器）。
   * 工作流正在等待的 agent 超過閾值（RunSettings.inactivityTimeoutMs）沒有任何動靜時，
   * 按 重試（停掉卡住的會話、重新接上）→ rescue（請評審 agent 唯讀診斷）→ 帶原因的 BLOCKED 處理。
   * 只檢查 RUNNING 的工作流任務：等待審批 / 閘門、已阻塞的時間不算不活動；對話任務沒有“正在等待的步驟”。
   */
  /**
   * 提問過期（P2-6）：AI 提的問題超過 questionTimeoutMs 沒人回答，按“跳過”處理（空答案，AI 自己判斷），
   * 記為 resolvedBy=timeout。與人工回答走同一個一次性消費路徑，同時有人回答時以先到的為準。
   */
  async expireQuestions(): Promise<number> {
    if (this.questionTimeoutMs <= 0 || this.stopping) return 0;
    let expired = 0;
    const now = this.now();
    for (const loaded of await this.store.listRecoverableRuns()) {
      if (loaded.status !== 'ok' || isTerminal(loaded.snapshot.status)) continue;
      for (const approval of loaded.snapshot.pendingApprovals) {
        if (approval.status !== 'pending' || approval.payload?.kind !== 'question' || now - approval.createdAt < this.questionTimeoutMs) continue;
        try {
          await this.command(loaded.snapshot.taskId, () =>
            this.resolveApprovalNow(loaded.snapshot.taskId, approval.id, 'approve', 'once', { answers: {} }, { by: 'timeout', reason: `${Math.round(this.questionTimeoutMs / 60_000)} 分鐘沒有回答，已跳過`, risk: 'low' }),
          );
          expired += 1;
        } catch (error) {
          if (!(error instanceof ApprovalConflictError) && !(error instanceof TaskTerminalError)) this.log(`question expiry failed (${approval.id})`, error);
        }
      }
    }
    return expired;
  }

  async checkInactivity(): Promise<void> {
    for (const loaded of await this.store.listRecoverableRuns()) {
      if (loaded.status !== 'ok' || loaded.snapshot.status !== 'RUNNING' || !loaded.snapshot.workflowState?.awaitingAgentId) continue;
      try {
        await this.checkRunInactivity(loaded.runId);
      } catch (error) {
        this.log(`step inactivity check failed (run ${loaded.runId})`, error);
      }
    }
  }

  private async checkRunInactivity(runId: string): Promise<void> {
    if (this.stopping || this.watchdogBusy.has(runId)) return;
    this.watchdogBusy.add(runId);
    try {
      // 1. 鎖內確認：仍在執行、有正在等待的 agent、超過閾值沒有任何動靜
      const target = await this.locks.run(runId, async () => {
        const loaded = await this.store.loadRun(runId);
        const ws = loaded?.status === 'ok' ? loaded.snapshot.workflowState : undefined;
        if (loaded?.status === 'ok' && ws && ws.lastActivityAt === undefined) {
          // 升級前建立的任務沒有計時起點：從現在開始計時
          ws.lastActivityAt = this.now();
          await this.store.commit({ run: loaded.snapshot });
          return undefined;
        }
        return this.inactiveTarget(loaded);
      });
      if (!target) return;
      const task = await this.mustTask(target.taskId);

      // 2. 先停掉沒有反應的會話：之後它遲到的事件一律被 adapter 丟棄，不會被當成新一輪的結果
      if (target.sessionKey && (this.liveSessions.has(target.sessionKey) || this.retiredSessions.has(target.sessionKey))) {
        await this.cancelSessionKey(task, target.agentId, target.sessionKey);
      }

      // 3. 鎖內複核（這期間可能剛好有了動靜、步驟推進了或任務被停止）並決策
      let directive: WorkflowDirective | undefined;
      await this.locks.run(runId, async () => {
        const loaded = await this.store.loadRun(runId);
        const again = this.inactiveTarget(loaded);
        if (loaded?.status !== 'ok' || !again || again.stepSeq !== target.stepSeq || again.agentId !== target.agentId) return;
        const run = loaded.snapshot;
        directive = this.decideOn(run, { kind: 'agent-inactive', agentId: target.agentId, idleMs: again.idleMs });
        if (!directive) return;
        run.workflowState!.lastActivityAt = this.now();
        await this.store.commit({ run });
      });
      if (!directive) return;
      const decided: WorkflowDirective = directive;

      // 4. 記錄原因（介面與審計可見），再執行決策
      const next = decided.type === 'dispatch' ? (decided.step === 'rescue' && target.step !== 'rescue' ? 'rescue' : 'retry') : 'blocked';
      await this.publish(task, {
        type: 'runtime.error',
        severity: next === 'blocked' ? 'error' : 'warning',
        agentId: target.agentId,
        data: {
          code: STEP_INACTIVITY_TIMEOUT,
          category: 'runtime',
          retryable: next !== 'blocked',
          source: 'watchdog',
          step: target.step,
          idleMs: target.idleMs,
          thresholdMs: target.thresholdMs,
          next,
          message: `${target.agentId} produced no activity for ${Math.round(target.idleMs / 1000)}s in step ${target.step}`,
        },
      });
      await this.executeDirective(task.id, decided);
    } finally {
      this.watchdogBusy.delete(runId);
    }
  }

  /** 看門狗的檢查物件：RUNNING 的工作流任務，正在等待的 agent 超過閾值沒有動靜（包括逐字流式輸出）。 */
  private inactiveTarget(loaded: RunLoadResult | undefined):
    | { taskId: string; agentId: string; step: WorkflowStep; stepSeq: number; idleMs: number; thresholdMs: number; sessionKey?: string }
    | undefined {
    if (loaded?.status !== 'ok') return undefined;
    const run = loaded.snapshot;
    const ws = run.workflowState;
    if (run.status !== 'RUNNING' || !ws?.awaitingAgentId || ws.lastActivityAt === undefined) return undefined;
    const thresholdMs = run.settings?.inactivityTimeoutMs ?? this.inactivityTimeoutMs;
    if (!(thresholdMs > 0)) return undefined;
    const agentId = ws.awaitingAgentId;
    // 正在等的 agent 卡在工具審批上（P0 第三批審查）：它在等操作員，不是沒有動靜（與預算的 activeWorkingAgents 同一條規則）
    if (run.pendingApprovals.some((approval) => approval.status === 'pending' && approval.agentId === agentId && approval.payload?.kind !== 'handoff')) return undefined;
    const last = Math.max(ws.lastActivityAt, this.streamActivity.get(activityKey(run.runId, agentId)) ?? 0);
    const idleMs = this.now() - last;
    if (idleMs < thresholdMs) return undefined;
    const session = run.agentSessions[agentId];
    return { taskId: run.taskId, agentId, step: ws.step, stepSeq: ws.stepSeq, idleMs, thresholdMs, sessionKey: session ? sessionKey(session) : undefined };
  }

  private async startAgent(
    taskId: string,
    agentId: string,
    prompt: string,
    mode?: AgentMode,
    extra: { cwd?: string; context?: Record<string, unknown>; source?: MessageSource; meta?: Record<string, unknown>; dispatch?: DispatchOptions } = {},
  ): Promise<boolean> {
    const adapter = this.mustAdapter(agentId);
    const initial = await this.mustTask(taskId);
    // 沒有指定模式時按這個 agent 在任務裡的角色決定（P1-17：不按 provider 名字）
    mode ??= this.roleMode(await this.mustRun(initial.runId), agentId);
    if (this.stopping) {
      this.log(`not starting ${agentId} for task ${taskId}: orchestrator is shutting down`);
      return false;
    }
    const workspaceProblem = extra.cwd ? this.workspaceProblem(extra.cwd) : undefined;
    if (workspaceProblem) {
      await this.failClosed(initial, 'WORKSPACE_REJECTED', workspaceProblem, agentId);
      return false;
    }
    // 佔位：同一 (run, agent) 併發啟動時只有一個能成功，其餘被拒絕並記錄
    try {
      this.sessions.reserve(initial.runId, agentId, adapter.info.kind);
    } catch (error) {
      await this.reportOwnershipConflict(initial, agentId, error);
      throw error;
    }
    let attached = false;
    try {
      attached = await this.startReservedAgent(taskId, agentId, prompt, adapter, initial, mode, extra);
    } finally {
      if (!attached) this.sessions.release(initial.runId, agentId);
    }
    return attached;
  }

  private async startReservedAgent(
    taskId: string,
    agentId: string,
    prompt: string,
    adapter: AgentAdapter,
    initial: TaskRecord,
    mode: AgentMode,
    extra: { cwd?: string; context?: Record<string, unknown>; source?: MessageSource; meta?: Record<string, unknown>; dispatch?: DispatchOptions },
  ): Promise<boolean> {
    const source = extra.source ?? 'orchestrator';
    const before = await this.mustRun(initial.runId);
    // 派發前檢查（H-6）：終態 run 不再啟動任何 agent；編排器自己的派發只在 RUNNING 時進行
    if (!(await this.dispatchAllowed(initial, before, agentId, source))) return false;
    if (before.status === 'CREATED' || before.status === 'QUEUED') {
      // 只有任務的首次啟動把 run 遷到 RUNNING。其餘狀態下啟動一個新會話（例如評審閘門期間在 Codex 對話方塊裡問一句、
      // 「同時問」時第一次叫上 Codex、等待審批期間問另一個 agent）只啟動會話，不改變 run 狀態（P0 第二批審查 / M-5）：
      // 評審閘門（WAITING_INPUT）、等待審批、BLOCKED 都只能由操作員的決定解除，操作員給某個 agent 發訊息不是那個決定
      try {
        await this.transitionTo(taskId, 'RUNNING', `agent:${agentId}`);
      } catch (error) {
        // 檢查之後任務剛好被停止：按終態拒絕，而不是報“非法狀態遷移”
        const now = await this.mustRun(initial.runId);
        if (!isTerminal(now.status)) throw error;
        await this.dispatchAllowed(initial, now, agentId, source);
        return false;
      }
    }

    // 鎖內權威檢查：run 仍允許派發、預算夠用，領到派發許可（Ask Both 已經預先領過）
    const ticket = extra.dispatch?.ticket ?? (await this.claimDispatch(taskId, [agentId], source, { renew: extra.dispatch?.renew }));
    if (!ticket) return false;
    return this.trackDispatch(initial.runId, agentId, () => this.startClaimed(taskId, agentId, prompt, adapter, mode, extra, source, ticket));
  }

  /** 已領到派發許可之後的啟動：記錄發出的訊息 → adapter.start → 掛接（鎖內複核許可）。 */
  private async startClaimed(
    taskId: string,
    agentId: string,
    prompt: string,
    adapter: AgentAdapter,
    mode: AgentMode,
    extra: { cwd?: string; context?: Record<string, unknown>; meta?: Record<string, unknown> },
    source: MessageSource,
    ticket: DispatchTicket,
  ): Promise<boolean> {
    const task = await this.mustTask(taskId);
    await this.recordOutgoing(task, agentId, prompt, source, extra.meta);

    const input: AgentStartInput = {
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId,
      prompt,
      mode,
      cwd: extra.cwd,
      context: extra.context,
    };

    const sequenceBefore = (await this.mustRun(task.runId)).lastSequence;
    let handle: { sessionId: string; providerSessionId?: string } | undefined;
    const ok = await this.callAdapter(
      task,
      agentId,
      'ADAPTER_START_FAILED',
      async () => {
        handle = await adapter.start(input, this.adapterSink(task, agentId));
      },
      // 啟動途中發生過停止（取消、預算停止、接受結果）：adapter 因為會話已被取消而放棄這次啟動，這是停止的結果，不是 provider 的錯
      () => this.stopEpoch(task.runId) !== ticket.epoch,
    );
    if (!ok || !handle) return false;

    const started = handle;
    const providerSessionId = started.providerSessionId ?? started.sessionId;
    try {
      // 原生會話 ID 全域性唯一歸屬：跨 run（含已持久化/已結束的 run）複用視為衝突
      const owners = (await this.store.findSessionsByProviderId(providerSessionId)).filter(
        (x) => x.runId !== task.runId || x.agentId !== agentId,
      );
      const owner = owners[0];
      if (owner) {
        throw new SessionOwnershipError(`Provider session ${providerSessionId} is owned by ${owner.agentId} in run ${owner.runId}`, {
          runId: task.runId,
          agentId,
          providerSessionId,
          ownerRunId: owner.runId,
          ownerAgentId: owner.agentId,
          reason: 'provider-session-owned',
        });
      }
      this.sessions.attach({ runId: task.runId, agentId, adapterType: adapter.info.kind, providerSessionId });
    } catch (error) {
      // 拒絕掛接：停止剛啟動的會話，從快照移除，記錄衝突並 fail closed
      this.liveSessions.delete(started.sessionId);
      this.cancelledKeys.add(started.sessionId);
      try {
        await adapter.cancel(started.sessionId, this.adapterSink(task, agentId));
      } catch {
        // 取消失敗不影響拒絕結論
      }
      await this.locks.run(task.runId, async () => {
        const run = await this.mustRun(task.runId);
        delete run.agentSessions[agentId];
        await this.store.commit({ run });
      });
      await this.reportOwnershipConflict(task, agentId, error);
      await this.failClosed(task, 'SESSION_OWNERSHIP_CONFLICT', (error as Error).message, agentId);
      return false;
    }

    // 掛接（鎖內複核，H-6）：啟動期間任務進入終態，或發生過停止（停止代數變化）時，不登記為線上。
    // 會話照樣記進快照（原生會話 ID、模式、工作目錄都在，之後可以續接），然後立刻取消並釋放槽位。
    let accepted = false;
    await this.locks.run(task.runId, async () => {
      const run = await this.mustRun(task.runId);
      accepted = this.ticketStillValid(run, ticket);
      const existing = run.agentSessions[agentId];
      run.agentSessions[agentId] = {
        agentId,
        adapterType: adapter.info.kind,
        providerSessionId,
        // 保留 start 期間事件已經投影出的狀態
        status: existing?.status ?? 'starting',
        ownerInstanceId: this.instanceId,
        metadata: { ...(existing?.metadata ?? {}), adapterSessionId: started.sessionId, mode, ...(extra.cwd ? { cwd: extra.cwd } : {}) },
      };
      run.updatedAt = this.now();
      // 線上登記與複核在同一個鎖內：停止要麼在這之前（被複核發現），要麼在這之後（能看到這個線上會話並取消它）。
      // 啟動期間會話已經結束（第一輪就失敗、執行時已經退出）時不登記為線上：之後對它的派發走 resume（H-11）
      if (accepted && !this.sessionEndedSince(started.sessionId, sequenceBefore)) this.markLive(started.sessionId, task.runId, agentId);
      else if (!accepted) this.liveSessions.delete(started.sessionId);
      await this.store.commit({ run });
    });
    if (!accepted) {
      await this.discardDispatch(task, agentId, started.sessionId);
      return false;
    }
    return true;
  }

  /**
   * 派發前檢查（鎖外、不扣預算）：終態 run 拒絕一切派發——操作員發起的（訊息、交接、Ask Both）得到 409，
   * 編排器自己的派發（工作流步驟）只記一條 warning；編排器的派發還要求 run 正在執行（阻塞、等待審批或閘門時不推進）。
   */
  private async dispatchAllowed(task: TaskRecord, run: RunSnapshot, agentId: string, source: MessageSource): Promise<boolean> {
    if (isTerminal(run.status)) {
      if (source !== 'orchestrator') throw TaskTerminalError.of(task.id, run.status, '訊息沒有送出。');
      await this.publish(task, { type: 'runtime.warning', severity: 'info', agentId, data: { code: 'DISPATCH_REFUSED', reason: 'run-terminal', status: run.status } });
      return false;
    }
    if (source === 'orchestrator' && run.status !== 'RUNNING') {
      await this.publish(task, { type: 'runtime.warning', severity: 'warning', agentId, data: { code: 'DISPATCH_REFUSED', reason: 'run-not-running', status: run.status } });
      return false;
    }
    return true;
  }

  /**
   * 派發許可是否仍然有效：領許可之後沒有發生過停止（取消、接受結果、預算停止都會讓停止代數 +1），
   * 且 run 沒有被取消或失敗。agent 在這一輪裡自己把工作做完、run 因而 COMPLETED 不算停止：會話照常登記。
   */
  private ticketStillValid(run: RunSnapshot, ticket: DispatchTicket): boolean {
    return this.stopEpoch(run.runId) === ticket.epoch && !isStoppedStatus(run.status);
  }

  /**
   * 啟動 / 續接 / 傳送返回時派發許可已失效：立刻再取消一次剛派發的會話，並記錄原因。
   * 即使停止時已經取消過它也要再取消（force，P0 第二批審查）：那次取消可能發生在派發請求在途時（例如 Codex 還沒拿到 turn id），
   * 沒能中斷隨後才開始的這一輪。adapter 的 cancel 是冪等的。
   */
  private async discardDispatch(task: TaskRecord, agentId: string, key: string): Promise<void> {
    const run = await this.mustRun(task.runId);
    this.log(`discarding ${agentId} session ${key} for task ${task.id}: the run was stopped while it was being dispatched (${run.status})`);
    await this.cancelSessionKey(task, agentId, key, { force: true });
    // 不帶 action：不覆蓋介面上的當前動作 / 阻塞原因
    await this.publish(task, { type: 'runtime.warning', severity: 'info', agentId, data: { code: 'DISPATCH_DISCARDED', status: run.status } });
  }

  /**
   * 工作區獨佔檢查（P3.4）：同一工作區不允許兩個有寫權限的任務併發，除非雙方都顯式允許共享。
   * 需要並行時應為任務建立獨立 worktree。
   */
  private async assertWorkspaceAvailable(cwd: string | undefined, shared: boolean): Promise<void> {
    if (!cwd || this.workspacePolicy === 'shared') return;
    const key = normalizePath(cwd);
    for (const loaded of await this.store.listRecoverableRuns()) {
      if (loaded.status !== 'ok') continue;
      const other = loaded.snapshot.workflowState;
      // 父子目錄也算衝突（P1-4 / M-4）：一個任務在倉庫根目錄、另一個在它的子目錄裡寫，同樣會互相覆蓋；獨立 worktree 除外
      if (!other?.cwd || !workspacesOverlap(normalizePath(other.cwd), key)) continue;
      if (shared && other.sharedWorkspace) continue;
      throw new Error(
        `Workspace conflict: ${cwd} is already used by active task ${loaded.snapshot.taskId}. Use a separate worktree or allow a shared workspace explicitly.`,
      );
    }
  }

  /**
   * 對話任務的工作區互斥（P1-4 / M-4）：另一個未結束的任務裡有 AI 正在工作（有進行中的一輪），
   * 而且它的工作目錄和這個任務的有包含關係時，不讓這個任務裡能改檔案的 AI 開始新的一輪。
   * 只看“正在工作”的任務：閒置的舊對話不擋路（它們沒結束，但不會同時改檔案）。
   */
  private async assertWorkspaceNotBusy(task: TaskRecord, run: RunSnapshot): Promise<void> {
    if (this.workspacePolicy === 'shared') return;
    const cwd = taskCwd(run) ?? this.defaultCwd;
    if (!cwd) return;
    const key = normalizePath(cwd);
    for (const loaded of await this.store.listRecoverableRuns()) {
      if (loaded.status !== 'ok' || loaded.runId === run.runId) continue;
      const other = loaded.snapshot;
      const otherCwd = taskCwd(other) ?? this.defaultCwd;
      if (!otherCwd || !workspacesOverlap(normalizePath(otherCwd), key)) continue;
      if (!hasWorkingAgents(other.budget)) continue;
      throw new WorkspaceBusyError(
        `另一個任務（${other.taskId.slice(0, 8)}）裡的 AI 正在修改同一個資料夾（${otherCwd}），這時再讓 AI 在這裡改檔案，兩邊會互相覆蓋。請等那邊做完或先停止它；需要同時做的話，建立任務時勾選「使用獨立 worktree」。`,
        { taskId: task.id, otherTaskId: other.taskId, cwd },
      );
    }
  }

  /** 把發給 agent 的內容記錄為對話訊息（direction=to-agent），保證完整對話可追溯。 */
  private async recordOutgoing(task: TaskRecord, agentId: string, message: string, source: MessageSource, meta?: Record<string, unknown>): Promise<void> {
    // 測試執行器只執行配置的命令、不讀取提示詞，記錄提示只會製造噪音
    if (this.adapters.get(agentId)?.info.kind === 'test') return;
    await this.publish(task, {
      type: 'agent.message',
      agentId,
      data: {
        direction: 'to-agent',
        from: source,
        ...(meta ?? {}),
        message: message.length > 16_000 ? `${message.slice(0, 16_000)}…` : message,
      },
    });
  }

  /**
   * 派發許可（鎖內原子完成，H-6 / P0-7）：確認 run 仍允許派發（不是終態；編排器自己的派發要求 RUNNING），
   * 這 agentIds.length 次呼叫的預算都夠用（Ask Both 扇出前一次性檢查，不夠就整體拒絕），然後計數並領取許可（記下當時的停止代數）。
   * - 操作員的新指令（renew）算作有進展：停滯計數清零；對話任務同時開一個新的預算視窗（按會話視窗計算）。
   * - 預算用滿（>=）時不再派發新的一輪：發出 budget.exceeded（停滯為 budget.stalled）並阻塞 run；
   *   操作員發起的派發還會得到 409（BudgetExhaustedError，中文說明），什麼都不會發給 agent。
   * - 終態時操作員來源得到 409。不允許時返回 undefined。
   */
  private async claimDispatch(
    taskId: string,
    agentIds: string[],
    source: MessageSource,
    options: { renew?: boolean; /** 預算不夠時 409 說明的後半句（預設是發訊息場景）。 */ refusal?: string } = {},
  ): Promise<DispatchTicket | undefined> {
    const initial = await this.mustTask(taskId);
    const calls = agentIds.length;
    const lead = agentIds[0]!;
    const modelAgent = agentIds.some((id) => this.adapters.get(id)?.info.kind !== 'test');
    // 全域性每日上限（P1-7）：所有任務今天的估算花費加起來達到上限後，不再開始新的模型呼叫（測試執行器不受影響）
    if (modelAgent && this.dailyMaxCostUsd !== undefined) {
      const spent = await this.dailySpend();
      if (spent >= this.dailyMaxCostUsd) {
        const message = `今天所有任務加起來的估算花費已經達到上限（US$${spent.toFixed(2)} / US$${this.dailyMaxCostUsd}）。明天會自動恢復；今天需要繼續的話，請調高或取消 ACC_DAILY_MAX_COST_USD 後重新啟動服務。`;
        if (source === 'operator') throw new DailyBudgetError(message, { spentUsd: spent, limitUsd: this.dailyMaxCostUsd });
        await this.failClosed(initial, 'DAILY_BUDGET_EXHAUSTED', message);
        return undefined;
      }
    }
    let verdict: 'ok' | 'budget' | 'state' = 'ok';
    let epoch = 0;
    let refusedRun: RunSnapshot | undefined;
    let refused: { limit: BudgetLimit; used: number; max: number } | undefined;
    await this.locks.run(initial.runId, async () => {
      const task = await this.mustTask(taskId);
      const run = await this.mustRun(task.runId);
      if (isTerminal(run.status) || (source === 'orchestrator' && run.status !== 'RUNNING')) {
        verdict = 'state';
        refusedRun = run;
        return;
      }
      const now = this.now();
      if (options.renew || source === 'operator') {
        // 操作員的指令算作有進展（連續幾輪純問答不會被判為停滯）；對話任務每條指令一個新的預算視窗
        if (options.renew && !run.workflowState) renewBudgetWindow(run.budget, now, 'operator');
        else run.budget.stallCount = 0;
      }
      const limit = dispatchViolation(run.budget, now, { calls, modelAgent });
      if (limit) {
        verdict = 'budget';
        refusedRun = run;
        refused = { limit, ...budgetUsage(run.budget, limit, now) };
        return;
      }
      epoch = this.stopEpoch(run.runId);
      run.budget.agentCallsUsed += calls;
      run.currentAgentId = lead;
      task.currentAgentId = lead;
      task.currentAction = `Calling ${agentIds.join(' + ')}`;
      await this.store.commit({ task, run });
    });
    if (verdict === 'ok') return { epoch };
    if (verdict === 'state') {
      // 鎖外發 warning（或向操作員拋 409）：run 鎖內不 publish
      await this.dispatchAllowed(initial, refusedRun!, lead, source);
      return undefined;
    }
    const { limit, used, max } = refused!;
    const text =
      limit === 'maxAgentCalls' && calls > 1 && used < max
        ? `呼叫次數不夠：還剩 ${max - used} 次，這次需要 ${calls} 次`
        : describeBudgetLimit(limit, refusedRun!.budget);
    const task = await this.mustTask(taskId);
    // 等待人工（評審閘門、等待審批）或已阻塞時，操作員問 agent / 批准交接被預算拒絕（P0 第三批審查）：只拒絕這一次派發（409），
    // 不改變 run 的狀態——否則等待被改成 BLOCKED(budget)，一鍵放寬也恢復不了原來的等待。只有工作流自己的派發被拒時才阻塞
    const onlyRefuse =
      source !== 'orchestrator' && refusedRun!.workflowState !== undefined && (refusedRun!.status === 'WAITING_INPUT' || refusedRun!.status === 'WAITING_APPROVAL' || refusedRun!.status === 'BLOCKED');
    await this.publish(task, {
      type: limit === 'maxStallCount' ? 'budget.stalled' : 'budget.exceeded',
      severity: onlyRefuse ? 'warning' : 'error',
      agentId: lead,
      data: { limit, used, max, needed: calls, ...(onlyRefuse ? { whileWaiting: true, refusedDispatch: true } : { step: `budget:${limit}`, action: `預算用完：${text}` }) },
    });
    if (source === 'orchestrator') return undefined;
    const what = calls > 1 ? `這次要同時問 ${calls} 個 AI（需要 ${calls} 次呼叫），都沒有送出` : '訊息沒有送出';
    const tail = onlyRefuse
      ? `${source === 'handoff' ? '交接沒有執行，這個請求仍然等你決定' : what}；任務仍然在等你決定（沒有因此停下）。需要的話可以先放寬預算（再給一份同樣的額度）再試一次`
      : (options.refusal ?? `${what}。請按「放寬預算並繼續」後再傳送`);
    throw new BudgetExhaustedError(`預算用完了（${text}），${tail}。`, { taskId, limit, used, max, needed: calls });
  }

  /** 向已存在的會話傳送訊息：線上則 send，重啟後則 resume（帶副作用台賬）。 */
  private async sendToSession(
    task: TaskRecord,
    agentId: string,
    message: string,
    source: MessageSource = 'orchestrator',
    meta?: Record<string, unknown>,
    options: { mode?: AgentMode; dispatch?: DispatchOptions; freshRound?: boolean } = {},
  ): Promise<boolean> {
    if (this.stopping) {
      this.log(`not sending to ${agentId} for task ${task.id}: orchestrator is shutting down`);
      return false;
    }
    const before = await this.mustRun(task.runId);
    const existing = before.agentSessions[agentId]!;
    // 派發前檢查（H-6）：終態 run 不再傳送；編排器自己的派發只在 RUNNING 時進行
    if (!(await this.dispatchAllowed(task, before, agentId, source))) return false;
    // 續接前檢查放在扣呼叫預算之前：已知無法續接或工作目錄不合規時直接 fail closed，不消耗預算
    if (!this.liveSessions.has(sessionKey(existing)) && !(await this.resumePrecheck(task, before, existing))) return false;
    const ticket = options.dispatch?.ticket ?? (await this.claimDispatch(task.id, [agentId], source, { renew: options.dispatch?.renew }));
    if (!ticket) return false;
    return this.trackDispatch(task.runId, agentId, () => this.sendClaimed(task, agentId, message, source, meta, options.mode, ticket, options.freshRound === true));
  }

  /** 已領到派發許可之後的傳送：線上則 send（返回後按許可複核），否則 resume。 */
  private async sendClaimed(
    task: TaskRecord,
    agentId: string,
    message: string,
    source: MessageSource,
    meta: Record<string, unknown> | undefined,
    requestedMode: AgentMode | undefined,
    ticket: DispatchTicket,
    freshRound = false,
  ): Promise<boolean> {
    const options = { mode: requestedMode };
    await this.recordOutgoing(task, agentId, message, source, meta);
    const run = await this.mustRun(task.runId);
    const session = run.agentSessions[agentId]!;
    const adapter = this.mustAdapter(agentId);
    const key = sessionKey(session);
    if (this.liveSessions.has(key)) {
      // 這一輪的有效模式：唯讀步驟線上收緊權限（Claude 切 plan / Codex 本回合唯讀沙箱），回到實現步驟時恢復
      const mode = this.effectiveMode(run, session, options.mode, freshRound);
      // 唯讀的這一輪要持久化（P0 第三批審查）：被預算停止或服務重啟打斷後，續跑時仍按唯讀
      await this.noteRoundMode(task.runId, agentId, mode ?? asAgentMode(session.metadata?.mode));
      let closedMidway = false;
      const sent = await this.callAdapter(
        task,
        agentId,
        'ADAPTER_SEND_FAILED',
        () => adapter.send(key, message, this.adapterSink(task, agentId), mode ? { mode } : undefined),
        (error) => {
          // 傳送途中發生過停止：adapter 因為會話已被取消而放棄這一輪，這是停止的結果，不 fail closed
          if (this.stopEpoch(task.runId) !== ticket.epoch) return true;
          // 執行時連線在派發途中關閉（訊息沒有送達，也不會有終態）：不 fail closed，改走續接（透明重連，H-11）
          closedMidway = isSessionClosedError(error) && adapter.resume !== undefined;
          return closedMidway;
        },
      );
      if (sent) {
        // 傳送返回後按許可複核（P0 第二批審查 / H-6）：傳送途中發生過停止，就再取消一次這個會話——
        // 停止時的那次取消可能發生在這一輪真正開始之前（例如 Codex 的 turn/start 還在途，沒有 turn id 可以中斷）
        const after = await this.mustRun(task.runId);
        if (!this.ticketStillValid(after, ticket)) {
          await this.discardDispatch(task, agentId, key);
          return false;
        }
      }
      if (!closedMidway) return sent;
      this.retireSession(key, task.runId, agentId, true);
      const fresh = await this.mustRun(task.runId);
      const current = fresh.agentSessions[agentId];
      if (!current || !(await this.resumePrecheck(task, fresh, current))) return false;
      // 呼叫預算已經在上面扣過：續接沿用同一張派發許可，不再重複計數
      return this.resumeSession(task, fresh, current, 'message', { message }, options.mode, ticket, freshRound);
    }
    return this.resumeSession(task, run, session, 'message', { message }, options.mode, ticket, freshRound);
  }

  /**
   * 續接前檢查（不消耗呼叫預算）：會話已被標記為無法續接，或它的工作目錄不合規時 fail closed。
   * 返回是否可以續接。
   */
  private async resumePrecheck(task: TaskRecord, run: RunSnapshot, session: SessionSnapshot): Promise<boolean> {
    const blocked = resumeBlockedOf(session);
    if (blocked) {
      await this.failClosed(
        task,
        'SESSION_RESUME_BLOCKED',
        `Session of ${session.agentId} cannot be resumed (${blocked.code}); reassign, accept or cancel the task`,
        session.agentId,
        undefined,
        { classifiedAs: blocked.code, retryable: false },
      );
      return false;
    }
    const cwd = sessionCwd(run, session);
    const problem = cwd ? this.workspaceProblem(cwd) : undefined;
    if (problem) {
      await this.failClosed(task, 'WORKSPACE_REJECTED', problem, session.agentId);
      return false;
    }
    return true;
  }

  /**
   * 續接一個不在本程序內的會話（重啟恢復 / 審批後續跑 / 再發訊息）。返回是否成功。
   * adapter 因前置條件不滿足而拒絕（AdapterPreconditionError）時，把會話標記為“無法續接”：
   * 同樣的條件不會自己變好，之後不再反覆嘗試、也不再消耗呼叫預算。
   */
  private async resumeSession(
    task: TaskRecord,
    run: RunSnapshot,
    session: SessionSnapshot,
    reason: AgentResumeInput['reason'],
    extra: Partial<AgentResumeInput> = {},
    requestedMode?: AgentMode,
    ticket: DispatchTicket = { epoch: this.stopEpoch(run.runId) },
    freshRound = false,
  ): Promise<boolean> {
    const agentId = session.agentId;
    const adapter = this.mustAdapter(agentId);
    if (!adapter.resume) {
      await this.failClosed(task, 'RUNTIME_CANNOT_RESUME', `Adapter ${agentId} cannot resume session after restart`, agentId);
      return false;
    }
    if (this.stopping) {
      this.log(`not resuming ${agentId} for task ${task.id}: orchestrator is shutting down`);
      return false;
    }
    // 續接與之後的掛接都在“正在派發”登記之下：這期間會話還沒登記為線上，但 agent 已經在工作
    return this.trackDispatch(run.runId, agentId, () => this.resumeClaimed(task, run, session, adapter, reason, extra, requestedMode, ticket, freshRound));
  }

  /** resumeSession 的實際執行（已在“正在派發”登記之下）。 */
  private async resumeClaimed(
    task: TaskRecord,
    run: RunSnapshot,
    session: SessionSnapshot,
    adapter: AgentAdapter,
    reason: AgentResumeInput['reason'],
    extra: Partial<AgentResumeInput>,
    requestedMode: AgentMode | undefined,
    ticket: DispatchTicket,
    freshRound = false,
  ): Promise<boolean> {
    const agentId = session.agentId;
    const key = sessionKey(session);
    const sequenceBefore = (await this.mustRun(run.runId)).lastSequence;
    const input = this.resumeInput(run, session, reason, extra, requestedMode, freshRound, completedSideEffectIdsFromEvents(await this.store.listEvents(run.runId)));
    // 續跑的這一輪是隻讀的（P0 第三批審查）：同樣持久化，下一次被打斷之後續跑時仍按唯讀
    await this.noteRoundMode(run.runId, agentId, asAgentMode(input.metadata?.mode));
    try {
      await adapter.resume!(key, input, this.adapterSink(task, agentId));
    } catch (error) {
      if (this.stopping) {
        this.log(`resuming ${agentId} (task ${task.id}) interrupted by shutdown`, error);
        return false;
      }
      if (this.stopEpoch(run.runId) !== ticket.epoch) {
        // 續接途中發生過停止：adapter 因為會話已被取消而放棄，這是停止的結果，不是 provider 的錯
        this.log(`resuming ${agentId} (task ${task.id}) abandoned: the run was stopped meanwhile`, error);
        return false;
      }
      if (error instanceof AdapterPreconditionError) await this.markResumeBlocked(run.runId, agentId, error);
      await this.failClosed(task, 'ADAPTER_RESUME_FAILED', (error as Error).message, agentId, classifyError(error));
      return false;
    }
    // 續接返回後鎖內複核（H-6）：這期間任務被停止了，就立刻取消剛續上的會話，不登記為線上
    let accepted = false;
    await this.locks.run(run.runId, async () => {
      const fresh = await this.mustRun(run.runId);
      accepted = this.ticketStillValid(fresh, ticket);
      // 續接期間會話又結束了（這一輪馬上失敗、執行時又退出）：保持“已退役”，下一次派發再續接
      if (accepted && !this.sessionEndedSince(key, sequenceBefore)) this.markLive(key, run.runId, agentId);
      else if (!accepted) this.liveSessions.delete(key);
    });
    if (!accepted) {
      await this.discardDispatch(task, agentId, key);
      return false;
    }
    return true;
  }

  /** 把會話標記為“無法續接”（鎖內只寫快照，不發事件）。 */
  private async markResumeBlocked(runId: string, agentId: string, error: AdapterPreconditionError): Promise<void> {
    await this.locks.run(runId, async () => {
      const fresh = await this.mustRun(runId);
      const session = fresh.agentSessions[agentId];
      if (!session) return;
      session.metadata = { ...(session.metadata ?? {}), resumeBlocked: { code: error.code, message: error.message, at: this.now() } };
      await this.store.commit({ run: fresh });
    });
  }

  /**
   * 這一輪呼叫會話時的有效模式（P0-4 審查）：會話啟動模式與當前步驟模式裡更嚴格的那個，絕不放寬。
   * - 步驟模式：工作流派發時顯式傳入；否則工作流正在等這個 agent 完成當前步驟時，由步驟推出（例如重啟時正在評審）；
   * - 任一方是隻讀（評審 / 診斷 / 分析）就用唯讀；否則沿用會話啟動模式（讀不到時為空，續跑時由 adapter fail closed）。
   */
  private effectiveMode(run: RunSnapshot, session: SessionSnapshot, requested?: AgentMode, freshRound = false): AgentMode | undefined {
    const sessionMode = asAgentMode(session.metadata?.mode);
    const ws = run.workflowState;
    const step = requested ?? (ws && ws.awaitingAgentId === session.agentId ? stepMode(ws.step) : undefined);
    if (isReadOnlyAgentMode(step)) return step;
    // 會話還有沒做完的唯讀輪（P0 第三批審查：Ask Both 的顧問輪被預算停止、服務重啟打斷）：接著做的派發
    // （放寬預算後接著做、重啟後續跑、審批後續跑）仍按唯讀，絕不在續跑時放寬成會話啟動時的可寫模式。
    // 明確要求了模式的工作流步驟、操作員 / 交接的新指令（freshRound）是新的一輪，按它們自己的模式
    const round = asAgentMode(session.metadata?.roundMode);
    if (requested === undefined && !freshRound && isReadOnlyAgentMode(round)) return round;
    return sessionMode;
  }

  /**
   * 記下這一輪要求的唯讀模式（P0 第三批審查，持久化在會話後設資料 roundMode 裡）：這一輪收緊成唯讀、而會話啟動模式是可寫的時寫入；
   * 同時記下最近一次派發的模式（dispatchMode）。
   * 只由投影在會話的輪全部做完（completed / failed，後面沒有排隊的輪）時清除——之後派發的新一輪不清除它：
   * 排在後面的新一輪可能還沒開始，被打斷的仍是隻讀的那一輪。被取消（預算停止、看門狗）或服務重啟打斷的一輪不算做完，
   * 續跑時 effectiveMode 據此仍按唯讀。鎖內只寫快照，不發事件。
   */
  private async noteRoundMode(runId: string, agentId: string, effective: AgentMode | undefined): Promise<void> {
    if (!effective) return;
    await this.locks.run(runId, async () => {
      const run = await this.mustRun(runId);
      const session = run.agentSessions[agentId];
      if (!session) return;
      const metadata = { ...(session.metadata ?? {}) };
      // 最近一次派發的這一輪的模式（「同時問」據此判斷顧問是不是正在以可寫方式工作、交接的來源這一輪是不是隻讀）
      metadata.dispatchMode = effective;
      if (isReadOnlyAgentMode(effective) && !isReadOnlyAgentMode(asAgentMode(session.metadata?.mode))) metadata.roundMode = effective;
      if (metadata.dispatchMode === session.metadata?.dispatchMode && metadata.roundMode === session.metadata?.roundMode) return;
      session.metadata = metadata;
      await this.store.commit({ run });
    });
  }

  /** 工作目錄守衛的檢查結果（守衛本身出錯也視為不合規）。 */
  private workspaceProblem(cwd: string): string | undefined {
    if (!this.workspaceGuard) return undefined;
    try {
      return this.workspaceGuard(cwd);
    } catch (error) {
      return `Cannot verify workspace ${cwd}: ${(error as Error).message}`;
    }
  }

  /** run 用到的所有工作目錄（任務工作區、工作流 cwd、各會話 cwd）裡第一個不合規的。 */
  private runWorkspaceProblem(run: RunSnapshot): { problem: string; agentId?: string } | undefined {
    if (!this.workspaceGuard) return undefined;
    const candidates: Array<{ cwd: unknown; agentId?: string }> = [{ cwd: run.workspace?.cwd }, { cwd: run.workflowState?.cwd }];
    for (const session of Object.values(run.agentSessions)) candidates.push({ cwd: session.metadata?.cwd, agentId: session.agentId });
    for (const candidate of candidates) {
      if (typeof candidate.cwd !== 'string' || !candidate.cwd) continue;
      const problem = this.workspaceProblem(candidate.cwd);
      if (problem) return { problem, agentId: candidate.agentId };
    }
    return undefined;
  }

  /** 把工作流步驟派發給 agent：已有會話則繼續同一會話，否則啟動新會話。 */
  private async dispatchToAgent(taskId: string, agentId: string, mode: AgentMode, prompt: string): Promise<boolean> {
    const initial = await this.mustTask(taskId);
    // 與操作員命令共用 (run, agent) 派發鎖：同一 agent 不會被同時啟動兩次
    return this.withAgent(initial.runId, agentId, async () => {
      const task = await this.mustTask(taskId);
      const run = await this.mustRun(task.runId);
      const ws = run.workflowState;
      if (!run.agentSessions[agentId]) {
        return this.startAgent(taskId, agentId, prompt, mode, { cwd: ws?.cwd, context: { testCommand: ws?.testCommand } });
      }
      // 已有會話：帶上本步驟的模式，唯讀步驟不會沿用會話啟動時（例如實現步驟）的可寫權限
      return this.sendToSession(task, agentId, prompt, 'orchestrator', undefined, { mode });
    });
  }

  /** 執行工作流指令（鎖外執行：會呼叫 adapter 併發布事件）。 */
  private async executeDirective(taskId: string, directive: WorkflowDirective): Promise<void> {
    const task = await this.mustTask(taskId);
    switch (directive.type) {
      case 'ignore':
        return;
      case 'dispatch': {
        const run = await this.mustRun(task.runId);
        // 決定之後任務已被停止：不再推進（不發 RUNNING、不派發）
        if (isTerminal(run.status)) return;
        // 測試步驟之前核對測試配置（H-15）：被改過就停下來請操作員確認，不執行
        if (directive.mode === 'test' && !(await this.testConfigAllowsDispatch(task, run))) return;
        // 併入這一步的交接內容（P0 第三批審查）：取出要交給這個 agent 的，隨信封一起轉交（資料區塊）
        let forwarded: PendingHandoff[] = [];
        if (run.workflowState?.pendingHandoffs?.some((item) => item.toAgentId === directive.agentId)) {
          await this.updatePendingHandoffs(task.runId, (list) => {
            forwarded = list.filter((item) => item.toAgentId === directive.agentId);
            return list.filter((item) => item.toAgentId !== directive.agentId);
          });
        }
        const envelope = buildContextEnvelope({ task, state: run.workflowState!, purpose: directive.purpose, note: directive.note, handoffFrom: directive.handoffFrom, forwarded });
        const contextRef = `${directive.step}#${run.workflowState!.stepSeq}`;
        if (directive.handoffFrom) {
          await this.locks.run(task.runId, async () => {
            const fresh = await this.mustRun(task.runId);
            fresh.workflowState?.handoffs.push({
              id: contextRef,
              from: directive.handoffFrom,
              to: directive.agentId,
              step: directive.step,
              reason: directive.purpose,
              context: envelope.text.slice(0, 8000),
              at: this.now(),
            });
            await this.store.commit({ run: fresh });
          });
          await this.publish(task, {
            type: 'handoff.requested',
            agentId: directive.agentId,
            data: { fromAgentId: directive.handoffFrom, toAgentId: directive.agentId, contextRef, reason: directive.purpose, sources: envelope.sources },
          });
        }
        await this.publish(task, {
          type: 'run.status',
          data: {
            status: 'RUNNING',
            step: `workflow:${directive.step}`,
            nextAction: directive.action,
            action: `${directive.step} → ${directive.agentId}`,
          },
        });
        const ok = await this.dispatchToAgent(taskId, directive.agentId, directive.mode, envelope.text);
        if (ok && directive.handoffFrom) {
          await this.publish(task, {
            type: 'handoff.completed',
            agentId: directive.agentId,
            data: { fromAgentId: directive.handoffFrom, toAgentId: directive.agentId, contextRef, progress: true },
          });
        }
        if (ok) {
          for (const item of forwarded) {
            await this.publish(task, {
              type: 'handoff.completed',
              agentId: directive.agentId,
              data: { fromAgentId: item.fromAgentId, toAgentId: directive.agentId, contextRef: `handoff:${item.id}`, mergedIntoStep: contextRef, progress: true },
            });
          }
        }
        return;
      }
      case 'wait-input':
        await this.publish(task, {
          type: 'run.status',
          severity: 'warning',
          data: {
            status: 'WAITING_INPUT',
            step: `workflow:${directive.step}`,
            pendingInput: { id: directive.inputId, prompt: directive.prompt },
            nextAction: directive.action,
            action: directive.prompt,
          },
        });
        return;
      case 'complete':
        await this.publish(task, { type: 'run.completed', data: { reason: directive.reason, nextAction: directive.action, action: directive.reason } });
        // 工作流自己完成時和「接受結果」一樣停止全部線上會話（P0 第三批審查）：任務已經結束，不能還有 agent 在可寫模式下改檔案
        if ((await this.mustRun(task.runId)).status === 'COMPLETED') await this.stopAllSessions(task);
        return;
      case 'block':
        await this.publish(task, {
          type: 'run.status',
          severity: 'warning',
          data: { status: 'BLOCKED', step: `workflow:${directive.code}`, code: directive.code, reason: directive.reason, nextAction: directive.action, action: directive.reason },
        });
        return;
    }
  }

  /**
   * agent 的完成 / 失敗訊號 → 工作流決策（鎖內原子更新狀態，鎖外執行指令）。
   * - 終態：agent.status completed / failed；
   * - 兜底（終態合約第 4 條）：正在等待的 agent 當前會話發出不可重試的 runtime.error，按失敗處理，不再等它遲遲不來的終態；
   * - H-9：run 在 WAITING_APPROVAL（例如 agent 請求交接、正在等操作員決定）時到達的訊號連同 stepSeq 快取進快照，
   *   審批結束回到 RUNNING 後由 replayDeferredSignal 重放，不再被丟棄。
   */
  private async onAgentSignal(event: UnifiedEvent): Promise<void> {
    const signal = workflowSignalOf(event);
    if (!signal) return;

    let directive: WorkflowDirective | undefined;
    await this.locks.run(event.runId, async () => {
      const loaded = await this.store.loadRun(event.runId);
      if (!loaded || loaded.status !== 'ok') return;
      const run = loaded.snapshot;
      const ws = run.workflowState;
      if (!ws) return;
      if (event.type === 'runtime.error') {
        // 只認正在等待的 agent 當前會話發出的錯誤：編排器自己記錄的錯誤（沒有 sessionId）、舊會話遲到的錯誤都不算
        const session = run.agentSessions[signal.agentId];
        if (ws.awaitingAgentId !== signal.agentId || !session || sessionKey(session) !== event.sessionId) return;
      }
      if (run.status === 'WAITING_APPROVAL' && ws.awaitingAgentId === signal.agentId) {
        // 同一步只保留第一個訊號（一個回合只有一個終態）
        if (ws.deferredSignal?.stepSeq === ws.stepSeq) return;
        ws.deferredSignal = { kind: signal.kind, agentId: signal.agentId, stepSeq: ws.stepSeq, eventId: event.id, data: event.data };
        await this.store.commit({ run });
        return;
      }
      if (run.status !== 'RUNNING') return;
      directive = this.decideOn(run, signal);
      if (directive) await this.store.commit({ run });
    });
    if (directive) await this.executeDirective(event.taskId, directive);
  }

  /**
   * 重放等待審批期間快取的訊號（H-9）：run 回到 RUNNING 後，如果步驟沒變（stepSeq 相同、仍在等同一個 agent），
   * 就按這個訊號推進工作流；步驟已經變了就丟棄。run 仍在等待（例如還有別的審批）時繼續保留。
   */
  private async replayDeferredSignal(event: UnifiedEvent): Promise<void> {
    let directive: WorkflowDirective | undefined;
    await this.locks.run(event.runId, async () => {
      const loaded = await this.store.loadRun(event.runId);
      if (!loaded || loaded.status !== 'ok') return;
      const run = loaded.snapshot;
      const deferred = run.workflowState?.deferredSignal;
      if (!run.workflowState || !deferred || run.status !== 'RUNNING') return;
      if (deferred.stepSeq !== run.workflowState.stepSeq || deferred.agentId !== run.workflowState.awaitingAgentId) {
        delete run.workflowState.deferredSignal;
        await this.store.commit({ run });
        return;
      }
      directive = this.decideOn(run, { kind: deferred.kind, agentId: deferred.agentId, data: deferred.data });
      if (!directive) delete run.workflowState.deferredSignal;
      await this.store.commit({ run });
    });
    if (directive) await this.executeDirective(event.taskId, directive);
  }

  /** 鎖內呼叫：按訊號做工作流決策並寫回快照（不提交）。決策為 ignore 時返回 undefined、快照不變。 */
  private decideOn(run: RunSnapshot, signal: WorkflowSignal): WorkflowDirective | undefined {
    const result = decide(run.workflowState!, signal, { now: this.now(), canReview: canStartReviewRound(run.budget) });
    if (result.directive.type === 'ignore') return undefined;
    // 只有新開的一輪評審（purpose = review）消耗評審輪次：看門狗在評審步驟裡重新接上會話不算新的一輪
    if (result.directive.type === 'dispatch' && result.directive.step === 'review' && result.directive.purpose === 'review') run.budget.reviewRoundsUsed += 1;
    run.workflowState = result.state;
    return result.directive;
  }

  private async reportOwnershipConflict(task: TaskRecord, agentId: string, error: unknown): Promise<void> {
    const details = error instanceof SessionOwnershipError ? error.details : {};
    await this.publish(task, {
      type: 'runtime.error',
      severity: 'error',
      agentId,
      data: { code: 'SESSION_OWNERSHIP_CONFLICT', message: (error as Error).message, ...details },
    });
  }

  /** 事件處理：讀取 → 投影 → 事件與快照同事務提交。 */
  private async handleEvent(event: UnifiedEvent): Promise<void> {
    let foreignSession: { agentId: string; ownerSessionId: unknown } | undefined;
    let rejected: { from: TaskStatus; to: TaskStatus } | undefined;
    await this.locks.run(event.runId, async () => {
      const task = await this.store.getTask(event.taskId);
      const loaded = await this.store.loadRun(event.runId);
      if (!task || !loaded) {
        await this.store.commit({ event });
        return;
      }
      if (loaded.status !== 'ok') {
        // 快照不可讀：只追加事件並把任務 fail closed，絕不覆蓋（可能來自更新版本的）快照
        if (canTransition(task.status, 'BLOCKED')) task.status = 'BLOCKED';
        task.currentAction = `Snapshot ${loaded.status}; operator required`;
        task.updatedAt = event.timestamp;
        await this.store.commit({ event, task });
        return;
      }
      const run = loaded.snapshot;
      const claimed = this.approvalClaims.get(event.id);
      if (claimed !== undefined) {
        // 審批的原子消費（H-12）：與投影、提交在同一個 run 鎖內確認前置條件；不滿足時事件不落盤，釋出方得到 409
        if (isTerminal(run.status)) throw TaskTerminalError.of(task.id, run.status, '這個審批已作廢，操作不會執行。');
        const pending = run.pendingApprovals.find((x) => x.id === claimed);
        if (!pending || pending.status !== 'pending') {
          const record = await this.store.getApproval(claimed);
          throw new ApprovalConflictError({ approvalId: claimed, status: record?.status });
        }
      }
      // 有效工作時長用編排器時鐘記賬（P0-7）；已被編排器取消的會話遲到的事件不會把 agent 重新記為“正在工作”
      const projection = projectEvent(task, run, event, {
        now: this.now(),
        fromCancelledSession: event.sessionId !== undefined && this.cancelledKeys.has(event.sessionId),
      });
      if (projection.rejectedTransition && TRANSITION_EVENT_TYPES.has(event.type)) rejected = projection.rejectedTransition;
      if (event.type === 'agent.started' && event.agentId && event.sessionId) {
        const adapter = this.adapters.get(event.agentId);
        const session = run.agentSessions[event.agentId];
        const ownerSessionId = session?.metadata?.adapterSessionId;
        if (session && ownerSessionId && ownerSessionId !== event.sessionId) {
          // 該 agent 槽位已由另一個會話持有：不接管，記錄衝突
          foreignSession = { agentId: event.agentId, ownerSessionId };
        } else if (adapter && session) {
          if (session.adapterType === 'unknown') session.adapterType = adapter.info.kind;
          session.ownerInstanceId ??= this.instanceId;
          // 已取消（或失敗）的 run 上才啟動起來的會話不登記為線上：啟動方在 adapter.start 返回後的複核裡取消它（H-6）
          if (!isStoppedStatus(run.status)) this.markLive(event.sessionId, event.runId, event.agentId);
        }
      }
      // 會話結束（failed / cancelled / 執行時關閉）時移出線上表，之後的派發走 resume（H-11）
      if (!foreignSession) this.trackSessionEvent(event);
      // 看門狗計時（P0-6）
      this.noteActivity(run, event, projection.statusChanged);
      await this.store.commit({ event, task, run, approvals: projection.approvals, usage: projection.usage });
    });

    if (foreignSession) {
      // 衝突報告本身是一個反應：排進該 run 的反應佇列，失敗不影響當前事件已經落盤的結論
      const foreign = foreignSession;
      void this.events.enqueueReaction(
        event.runId,
        async () => {
          const task = await this.store.getTask(event.taskId);
          if (!task) return;
          await this.reportOwnershipConflict(
            task,
            foreign.agentId,
            new SessionOwnershipError(`Session ${event.sessionId} is not the owner of agent slot ${foreign.agentId}`, {
              runId: event.runId,
              agentId: foreign.agentId,
              sessionId: event.sessionId,
              ownerSessionId: foreign.ownerSessionId,
              reason: 'foreign-session',
            }),
          );
        },
        (error) => this.onReactionFailed(event, new ReactionFailure('session-ownership', error)),
      );
    }

    if (rejected) {
      // 被狀態機拒絕的狀態遷移（P0-7）：事件照常記錄但狀態沒變，這裡顯式留下一條警告，
      // 不再出現“介面返回成功、任務卻停在原狀態、事件日誌裡什麼都沒有”
      const { from, to } = rejected;
      void this.events.enqueueReaction(
        event.runId,
        async () => {
          const task = await this.store.getTask(event.taskId);
          if (!task) return;
          await this.publish(task, {
            type: 'runtime.warning',
            severity: 'warning',
            data: {
              code: 'TRANSITION_REJECTED',
              from,
              to,
              eventId: event.id,
              eventType: event.type,
              sequence: event.sequence,
              message: `狀態沒有從「${STATUS_TEXT[from] ?? from}」改成「${STATUS_TEXT[to] ?? to}」（不允許的狀態變化），任務仍然是「${STATUS_TEXT[from] ?? from}」。`,
            },
          });
        },
        (error) => this.onReactionFailed(event, new ReactionFailure('transition-rejected', error)),
      );
    }
  }

  /**
   * 執行中限額檢查：觸發時發出確定性的 budget.exceeded / budget.stalled，停止正在工作的 agent 並阻塞 run。
   * 已阻塞但 agent 仍在完成當前一輪時（例如阻塞後 agent 按設計把這一輪做完、或者操作員在阻塞期間問了別的 agent）同樣檢查：
   * 超限就停下它們（P0-7：絕不出現“任務顯示 BLOCKED，agent 卻在工作、不受任何限額約束”）；阻塞原因保持不變。
   */
  private async enforceBudget(runId: string): Promise<void> {
    if (this.enforcing.has(runId)) return;
    this.enforcing.add(runId);
    try {
      const loaded = await this.store.loadRun(runId);
      if (!loaded || loaded.status !== 'ok' || isTerminal(loaded.snapshot.status)) return;
      let run = loaded.snapshot;
      const task = await this.mustTask(run.taskId);
      // 先清掉殘留的“正在工作”（本程序裡已經沒有會話的 agent，P0 第二批審查）：它們不該計時，也不能讓已阻塞的任務反覆觸發預算事件
      if (await this.clearStaleWorking(task, run)) run = await this.mustRun(runId);

      // 仍在工作、沒有卡在審批上的 agent：只有它們消耗預算
      const working = activeWorkingAgents(run);
      const paused = run.status !== 'RUNNING';
      if (paused && working.length === 0) return;

      const now = this.now();
      const violations = runtimeViolations(run.budget, now);
      const limit = violations[0];
      if (!limit) return;

      if (paused) {
        // 已阻塞 / 等待人工（審批、評審閘門）時仍有 agent 在工作（P0-7；P0 第二批審查補上等待人工的情況）：
        // 超限就停下它們，但不改變 run 的狀態、阻塞原因與待審批項，只記錄“為什麼停下了仍在工作的 agent”。
        // 它們都已經在停止中（上一次取消還沒完成）時不再重複記錄，只再取消一次
        const alreadyStopping = working.every((agentId) => [...this.pendingCancels.values()].some((x) => x.runId === runId && x.agentId === agentId));
        if (!alreadyStopping) {
          const blocked = run.status === 'BLOCKED';
          const names = working.join('、');
          await this.publish(task, {
            type: limit === 'maxStallCount' ? 'budget.stalled' : 'budget.exceeded',
            severity: 'error',
            agentId: run.currentAgentId,
            data: {
              limit,
              ...budgetUsage(run.budget, limit, now),
              violations,
              workingAgentIds: working,
              ...(blocked
                ? { whileBlocked: true }
                : {
                    whileWaiting: true,
                    action: `預算用完：${describeBudgetLimit(limit, run.budget)}；已停下仍在工作的 ${names}。${run.status === 'WAITING_APPROVAL' ? '待審批的操作仍然等你決定。' : '任務仍然等你決定。'}`,
                  }),
            },
          });
        }
        // 已阻塞時沿用原來的做法停止全部會話；等待人工時只停下超限的這些 agent，卡在審批上的會話保留（審批之後照常繼續）
        if (run.status === 'BLOCKED') await this.stopAllSessions(task);
        else await this.stopAgents(task, working);
      } else {
        await this.publish(task, {
          type: limit === 'maxStallCount' ? 'budget.stalled' : 'budget.exceeded',
          severity: 'error',
          agentId: run.currentAgentId,
          data: { limit, ...budgetUsage(run.budget, limit, now), violations, step: `budget:${limit}`, stopsAgents: true, action: `預算用完：${describeBudgetLimit(limit, run.budget)}` },
        });
        // 預算停止遍歷該 run 的全部線上會話（H-5：Ask Both 時兩個 agent 都停）
        await this.stopAllSessions(task);
      }
      // 停止之後仍然沒有會話可以取消的 agent（例如取消失敗、沒有終態）不再算“正在工作”
      await this.clearStaleWorking(task, await this.mustRun(runId));
    } finally {
      this.enforcing.delete(runId);
    }
  }

  /**
   * 停下這些 agent 在本 run 裡的全部會話（線上、已退役、取消未完成），其餘會話不動。
   * 不改停止代數：別的 agent 正在進行的派發（例如操作員剛問的另一個 agent）不受影響。
   */
  private async stopAgents(task: TaskRecord, agentIds: string[]): Promise<void> {
    const wanted = new Set(agentIds);
    const targets = new Map([...this.liveSessions, ...this.retiredSessions, ...this.pendingCancels].filter(([, live]) => live.runId === task.runId && wanted.has(live.agentId)));
    await Promise.all([...targets].map(([key, live]) => this.cancelSessionKey(task, live.agentId, key)));
  }

  /**
   * 呼叫 adapter；異常被規範化為 runtime.error 並 fail closed。返回是否成功。
   * handled：呼叫方能處理的異常（例如派發途中會話關閉，改走續接）返回 true，此時不 fail closed，本方法返回 false。
   */
  private async callAdapter(task: TaskRecord, agentId: string, code: string, fn: () => Promise<void>, handled?: (error: unknown) => boolean): Promise<boolean> {
    if (this.stopping) {
      // 服務正在關閉：不再呼叫 adapter，也不 fail closed（重啟後由 recover 按持久化狀態處理）
      this.log(`skipping ${code} for ${agentId} (task ${task.id}): orchestrator is shutting down`);
      return false;
    }
    try {
      await fn();
      return true;
    } catch (error) {
      if (this.stopping) {
        // 關閉過程中被中止的呼叫（例如 app-server 連線被關掉）：不是 provider 的錯，也不改持久化狀態
        this.log(`${code} for ${agentId} (task ${task.id}) interrupted by shutdown`, error);
        return false;
      }
      const run = await this.store.loadRun(task.runId);
      if (run?.status === 'ok' && isTerminal(run.snapshot.status)) {
        // 呼叫途中任務被停止（會話已被取消）：呼叫失敗是停止的結果，不是 provider 的錯，也沒有可阻塞的
        this.log(`${code} for ${agentId} (task ${task.id}) failed after the task ended (${run.snapshot.status})`, error);
        return false;
      }
      if (handled?.(error)) return false;
      await this.failClosed(task, code, (error as Error).message, agentId, classifyError(error));
      return false;
    }
  }

  private async failClosed(
    task: TaskRecord,
    code: string,
    message: string,
    agentId?: string,
    classified?: NormalizedError,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.publish(task, {
      type: 'runtime.error',
      severity: 'error',
      agentId,
      // 異常文字推斷出的分類標記為 inferred，結構化來源為 confirmed
      confidence: classified?.confidence ?? 'confirmed',
      data: {
        code,
        message,
        action: message,
        category: classified?.category ?? 'runtime',
        retryable: classified?.retryable ?? false,
        classifiedAs: classified?.code,
        ...extra,
      },
    });
    const fresh = await this.mustTask(task.id);
    if (canTransition(fresh.status, 'BLOCKED') && fresh.status !== 'BLOCKED') {
      // 進入 BLOCKED 的事件本身帶上阻塞原因：agent 在兩個事件之間發出的普通事件不會讓介面上的原因變成別的內容
      const action = typeof extra.action === 'string' && extra.action ? extra.action : message;
      // 阻塞程式碼由步驟 blocked:<code> 表達（投影據此記錄 blockedBy）；不在狀態事件裡重複 data.code，避免被當成又一條錯誤
      await this.transitionTo(task.id, 'BLOCKED', `blocked:${code}`, { action });
    }
  }

  private resumeInput(
    run: RunSnapshot,
    session: SessionSnapshot,
    reason: AgentResumeInput['reason'],
    extra: Partial<AgentResumeInput> = {},
    requestedMode?: AgentMode,
    freshRound = false,
    allSideEffectIds?: string[],
  ): AgentResumeInput {
    // 續跑用這一輪的有效模式（會話啟動模式與當前步驟模式裡更嚴格的那個），不是簡單沿用會話啟動模式
    const mode = this.effectiveMode(run, session, requestedMode, freshRound);
    return {
      projectId: run.projectId,
      taskId: run.taskId,
      runId: run.runId,
      agentId: session.agentId,
      reason,
      step: run.resumeCursor?.step ?? run.currentStep,
      // 完整台賬（P2-10）：快照裡只有最近一段，呼叫方從事件日誌重建後傳進來
      completedSideEffectIds: allSideEffectIds ?? run.completedSideEffects.map((x) => x.id),
      uncertainSideEffects: (run.inFlightSideEffects ?? [])
        .filter((x) => x.agentId === session.agentId && !run.pendingApprovals.some((a) => a.status === 'pending' && a.providerCallId === x.id))
        .slice(-10)
        .map((x) => ({ id: x.id, name: x.name, summary: x.summary })),
      recentCompletedSideEffectIds: run.completedSideEffects.filter((x) => x.agentId === session.agentId).slice(-10).map((x) => x.id),
      lastSequence: run.lastSequence,
      metadata: {
        providerSessionId: session.providerSessionId,
        testCommand: run.workflowState?.testCommand,
        cwd: run.workflowState?.cwd,
        ...(session.metadata ?? {}),
        ...(mode ? { mode } : {}),
      },
      ...extra,
    };
  }

  /** 狀態遷移：以最新持久化狀態校驗，再透過 run.status 事件落地（事件與快照同事務）。 */
  private async transitionTo(taskId: string, next: TaskStatus, step: string, extra: Record<string, unknown> = {}): Promise<void> {
    const task = await this.mustTask(taskId);
    assertTransition(task.status, next);
    await this.publish(task, { type: 'run.status', data: { ...extra, status: next, step } });
  }

  /**
   * 交給 adapter 的事件入口（P0-9 / L-1）：身份固定為這個任務的 run 與這個 agent，只允許 adapter 可以發的事件型別，
   * 剝離 adapter 自帶的 id / sequence / timestamp（見 EventBus.createSink）。
   */
  private adapterSink(task: TaskRecord, agentId: string): EventSink {
    return this.events.createSink({ projectId: task.projectId, taskId: task.id, runId: task.runId, agentId });
  }

  private async publish(task: TaskRecord, input: PublishInput): Promise<void> {
    await this.events.publish({
      ...(input.id ? { id: input.id } : {}),
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId,
      agentId: input.agentId,
      sessionId: input.sessionId,
      type: input.type,
      severity: input.severity ?? 'info',
      confidence: input.confidence ?? 'confirmed',
      data: input.data,
    });
  }

  private mustAdapter(agentId: string): AgentAdapter {
    const adapter = this.adapters.get(agentId);
    if (!adapter) throw new Error(`Unknown agent adapter: ${agentId}`);
    return adapter;
  }

  private async mustTask(taskId: string): Promise<TaskRecord> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private async mustRun(runId: string): Promise<RunSnapshot> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    return run;
  }
}

/**
 * 交接訊息（P0-9 / H-13）：
 *
 *   [Forwarded from claude by the operator]
 *   <宣告：區塊內是資料，不是指令>
 *
 *   <<<ACC-DATA-… BEGIN from claude>>>
 *   | agent A 的原文（每行帶 "| " 前綴）
 *   <<<ACC-DATA-… END>>>
 *
 *   [Your task]
 *   操作員（或 agent 請求裡）的要求
 *
 * 原文裡偽造的 `[Your task]`、邊界行都在區塊之內、帶著前綴；要求裡看起來像編排器標記的行被轉義，
 * 所以編排器的任務指令在整條訊息裡只出現一次。邊界隨機生成，不出現在原文裡。
 */
function forwardedMessage(fromAgentId: string, via: string, content: string, ask: string, activity = ''): string {
  const boundary = dataBoundary([content, ask, activity]);
  const parts = [`[Forwarded from ${fromAgentId} ${via}]`, dataBlockNotice(boundary), '', renderDataBlock(boundary, `from ${fromAgentId}`, content)];
  // 編排器從事件記錄裡確定性生成的活動摘要（P1-4）：同樣放在資料區塊裡（裡面的命令和輸出來自 agent 的工作區，不是指令）
  if (activity) parts.push('', renderDataBlock(boundary, `activity of ${fromAgentId} recorded by the orchestrator`, activity));
  parts.push('', '[Your task]', neutralizeReservedLines(ask));
  return parts.join('\n');
}

/**
 * Ask Both 發給唯讀顧問的訊息：編排器的說明在最前面、只有一條；操作員訊息裡看起來像編排器標記的行被轉義（P0-9）。
 * 主 agent 的會話是隻讀啟動的（M-3 過渡）時如實說明，不再聲稱它 “has write access”。
 */
function advisoryMessage(primaryAgentId: string, message: string, primaryWritable = true): string {
  const primary = primaryWritable ? `${primaryAgentId}, which has write access to this workspace` : `${primaryAgentId}, which is also answering in read-only mode in this task`;
  return `[Orchestrator note] The same request was also sent to ${primary}. You are an advisor: analyse and answer, but do NOT modify any files.\n\n${neutralizeReservedLines(message)}`;
}

/** 問題的答案（P2-6）：只保留審批裡有的問題 ID；每題最多 10 個答案，每個最長 4000 字。 */
function sanitizeAnswers(payload: Record<string, unknown>, answers: Record<string, string[]>): Record<string, string[]> {
  const questions = Array.isArray(payload.questions) ? (payload.questions as Array<{ id?: unknown }>) : [];
  const ids = new Set(questions.map((q) => String(q.id)));
  const out: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(answers)) {
    if (!ids.has(id) || !Array.isArray(list)) continue;
    out[id] = list.slice(0, 10).map((item) => String(item).slice(0, 4000));
  }
  return out;
}

/** 寫進事件記錄的答案（P2-6）：機密問題（例如密碼）的答案替換成佔位。 */
function recordedAnswers(payload: Record<string, unknown> | undefined, answers: Record<string, string[]>): Record<string, string[]> {
  const questions = Array.isArray(payload?.questions) ? (payload.questions as Array<{ id?: unknown; secret?: unknown }>) : [];
  const secret = new Set(questions.filter((q) => q.secret === true).map((q) => String(q.id)));
  return Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, secret.has(id) ? ['[機密，未記錄]'] : list]));
}

/** 交接請求被拒絕的原因（給操作員看的中文說明）。 */
function handoffRejectionText(reason: string): string {
  if (reason.startsWith('unknown agent')) return '沒有這個 Agent';
  if (reason === 'cannot hand off to the test runner') return '測試執行器不能接手對話';
  if (reason === 'cannot hand off to itself') return '不能交給自己';
  if (reason === 'missing instruction') return '沒有說明要對方做什麼';
  if (reason === 'edge not allowed') return '設定裡不允許這兩個 Agent 之間交接（ACC_HANDOFF_EDGES）';
  return reason;
}

/** 重啟後重新派發當前步驟時的上下文用途（M-8 過渡）：按步驟還原成當初派發它時的用途。 */
function recoveryPurpose(step: WorkflowStep): ContextPurpose {
  switch (step) {
    case 'retry':
      return 'retry';
    case 'fix':
      return 'fix';
    case 'review-fix':
      return 'review-fix';
    case 'rescue':
      return 'rescue';
    case 'review':
      return 'review';
    case 'test':
    case 'final-test':
      return 'test';
    default:
      return 'implement';
  }
}

/** 被停止的終態：取消或失敗（不含 agent 把工作做完的 COMPLETED）。 */
function isStoppedStatus(status: TaskStatus): boolean {
  return status === 'CANCELLED' || status === 'FAILED';
}

type AgentSignal = Extract<WorkflowSignal, { kind: 'agent-completed' | 'agent-failed' }>;

/**
 * 事件 → 工作流訊號：agent.status completed / failed 是回合終態；
 * adapter 會話發出的不可重試 runtime.error 也當作失敗（終態合約第 4 條的兜底，是否來自正在等待的會話由呼叫方核對）。
 */
function workflowSignalOf(event: UnifiedEvent): AgentSignal | undefined {
  if (!event.agentId) return undefined;
  if (event.type === 'agent.status') {
    // 後面還有排隊的訊息（M-1 / P1-3：操作員在這一步中途插話）：這一輪做完不等於這一步做完，等最後一輪的完成訊號
    if (event.data.status === 'completed' && (Number(event.data.queuedTurns) || 0) > 0) return undefined;
    if (event.data.status === 'completed') return { kind: 'agent-completed', agentId: event.agentId, data: event.data };
    if (event.data.status === 'failed') return { kind: 'agent-failed', agentId: event.agentId, data: event.data };
    return undefined;
  }
  if (event.type === 'runtime.error' && event.sessionId && event.data.retryable !== true) {
    return { kind: 'agent-failed', agentId: event.agentId, data: event.data };
  }
  return undefined;
}

/** 這個事件說明會話已經結束：回合以 failed / cancelled 結束，或者 adapter 報告執行時連線已關閉（data.sessionClosed）。 */
function endsSession(event: UnifiedEvent): boolean {
  if (event.type === 'agent.status' && (event.data.status === 'failed' || event.data.status === 'cancelled')) return true;
  return event.data.sessionClosed === true;
}

/** adapter 報告“會話已關閉、這次派發沒有送達”（可以改走續接）。 */
function isSessionClosedError(error: unknown): boolean {
  return error instanceof AdapterSessionClosedError || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ADAPTER_SESSION_CLOSED');
}

/** 會話是否空閒、可以釋放執行時：不在工作、沒有掛起的審批、不是工作流正在等待的 agent。 */
function isIdleFor(run: RunSnapshot, agentId: string): boolean {
  if ((run.budget.workingAgentIds ?? []).includes(agentId)) return false;
  if (run.pendingApprovals.some((approval) => approval.agentId === agentId)) return false;
  if (!isTerminal(run.status) && run.workflowState?.awaitingAgentId === agentId) return false;
  return true;
}

function activityKey(runId: string, agentId: string): string {
  return `${runId}\u0000${agentId}`;
}

/** 看門狗閾值：非負整數毫秒（0 表示關閉）。不合法時丟擲 400 類錯誤。 */
function validInactivityTimeout(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw Object.assign(new RangeError(`${name} must be a non-negative integer number of milliseconds (0 disables the step inactivity watchdog), got ${value}`), { statusCode: 400 });
  }
  return value;
}

function defaultSettings(settings: RunSettings | undefined): RunSettings {
  return { handoffPolicy: 'ask', autoHandoffsUsed: 0, maxAutoHandoffs: DEFAULT_MAX_AUTO_HANDOFFS, ...(settings ?? {}) };
}

/** 任務的工作目錄：工作流 cwd → 持久化的任務工作區（v5）→ 舊任務的會話後設資料。 */
function taskCwd(run: RunSnapshot): string | undefined {
  if (run.workflowState?.cwd) return run.workflowState.cwd;
  if (run.workspace?.cwd) return run.workspace.cwd;
  for (const session of Object.values(run.agentSessions)) {
    const cwd = session.metadata?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return undefined;
}

/** 會話續接時使用的工作目錄（與 resumeInput 的合併順序一致：會話後設資料優先）。 */
function sessionCwd(run: RunSnapshot, session: SessionSnapshot): string | undefined {
  const cwd = session.metadata?.cwd;
  if (typeof cwd === 'string' && cwd) return cwd;
  return run.workflowState?.cwd;
}

function runWorkspace(cwd: string, source: CreateTaskInput['workspace']): RunWorkspace {
  const workspace: RunWorkspace = { cwd, kind: source?.kind ?? 'directory' };
  if (source?.repoPath) workspace.repoPath = source.repoPath;
  if (source?.branch) workspace.branch = source.branch;
  return workspace;
}

/** 會話是否已被標記為“無法續接”。 */
function resumeBlockedOf(session: SessionSnapshot): { code: string } | undefined {
  const value = session.metadata?.resumeBlocked;
  if (!value || typeof value !== 'object') return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && code ? { code } : undefined;
}

/** 已知無法續接的會話：再補充說明或重試只會重複同樣的失敗——直接說明可行的出路（409）。 */
function sessionResumeBlockedError(agentId: string, code: string): SessionResumeBlockedError {
  return new SessionResumeBlockedError(
    `無法續接和 ${agentId} 的這段對話（${code}）：再補充說明或重試都會遇到同樣的問題。請「換人接手」、「接受結果」或「停止」任務。`,
    { agentId, reason: code },
  );
}

/** run 為什麼阻塞（中文，給操作員看）。 */
function blockedReasonText(run: RunSnapshot): string {
  const limit = budgetBlockLimit(run);
  if (limit) return `預算用完：${describeBudgetLimit(limit, run.budget)}`;
  switch (run.blockedBy?.source) {
    case 'approval':
      return '你拒絕了一個操作';
    case 'safety':
      return `被安全策略攔下（${run.blockedBy.code}）`;
    default:
      return `系統停在這一步（${run.blockedBy?.code ?? run.currentStep}）`;
  }
}

const AGENT_MODES: ReadonlySet<string> = new Set<AgentMode>(['implement', 'review', 'rescue', 'test', 'analysis']);

function asAgentMode(value: unknown): AgentMode | undefined {
  return typeof value === 'string' && AGENT_MODES.has(value) ? (value as AgentMode) : undefined;
}

function normalizePath(path: string): string {
  // 分隔符統一成 /（父子目錄判斷用），Windows 下不區分大小寫
  const resolved = resolvePath(path).split('\\').join('/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}



/** adapter 呼叫所用的會話 key：優先 adapter 自己簽發的 sessionId，其次 provider 原生 ID。 */
function sessionKey(session: SessionSnapshot): string {
  const adapterSessionId = session.metadata?.adapterSessionId;
  if (typeof adapterSessionId === 'string' && adapterSessionId) return adapterSessionId;
  return session.providerSessionId ?? session.agentId;
}

/**
 * 兩個工作目錄會不會互相覆蓋（P1-4 / M-4）：相同，或者一個在另一個裡面。
 * 例外：獨立 worktree（路徑裡有 .acc-worktrees 這一段）雖然放在倉庫目錄裡，但它是單獨的一份程式碼，不算衝突。
 * 引數已經過 normalizePath（統一分隔符、Windows 下不區分大小寫）。
 */
function workspacesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const [outer, inner] = a.length < b.length ? [a, b] : [b, a];
  const prefix = outer.endsWith('/') ? outer : `${outer}/`;
  if (!inner.startsWith(prefix)) return false;
  return !inner.slice(prefix.length).split('/').includes('.acc-worktrees');
}
