/**
 * 編排器與 adapter 之間約定的結構化錯誤。
 *
 * 帶 statusCode 的錯誤由 HTTP 層按原狀態碼返回（4xx 不算服務端故障）；
 * 帶 code / category / retryable 的錯誤會被錯誤分類器識別為 confirmed（不是文字推斷）。
 */

/**
 * adapter 前置條件不滿足時丟擲的結構化錯誤（例如續跑時讀不到持久化的工作目錄，或 Codex 續接到了別的目錄）。
 *
 * 編排器據此發出 runtime.error（data.classifiedAs = code）並把 run fail closed 為帶原因的 BLOCKED；
 * 續跑時遇到它還會把該會話標記為“無法續接”：重試同一會話不會讓條件自己變好，所以 retryable 固定為 false。
 */
export class AdapterPreconditionError extends Error {
  readonly category = 'runtime' as const;
  readonly retryable = false;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterPreconditionError';
  }
}

/**
 * adapter 的會話（執行時連線）已經關閉，這次派發沒有送達（P0-6 / H-11）：例如 app-server 在 turn/start 請求途中退出，
 * 或者 Claude CLI 已經結束。它不是這一輪的失敗（沒有終態事件），編排器據此把會話移出線上表並改走 resume（透明重連），
 * 而不是把任務 fail closed 為 BLOCKED。被編排器取消過的會話不會拋它（那種情況不該續接）。
 */
export class AdapterSessionClosedError extends Error {
  readonly code = 'ADAPTER_SESSION_CLOSED';
  readonly category = 'runtime' as const;
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'AdapterSessionClosedError';
  }
}

/** 任務工作目錄不合規（例如與控制面資料互相包含）：新建任務時返回 400。 */
export class WorkspaceRejectedError extends Error {
  readonly statusCode = 400;
  readonly code = 'WORKSPACE_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceRejectedError';
  }
}

/** 會話已被標記為“無法續接”：再發訊息只會重複同樣的失敗，直接告訴操作員可行的出路（409）。 */
export class SessionResumeBlockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'SESSION_RESUME_BLOCKED';

  constructor(
    message: string,
    readonly details: { agentId: string; reason: string },
  ) {
    super(message);
    this.name = 'SessionResumeBlockedError';
  }
}

const TERMINAL_LABEL: Record<string, string> = { CANCELLED: '已停止', COMPLETED: '已完成', FAILED: '失敗' };

/**
 * 任務已進入終態（已停止 / 已完成 / 失敗），不能再執行這個操作（409）。P0-5：終態 run 上的審批、訊息、交接等一律拒絕，
 * 什麼都不會執行。message 是給操作員看的中文說明。
 */
export class TaskTerminalError extends Error {
  readonly statusCode = 409;
  readonly code = 'TASK_TERMINAL';

  constructor(
    message: string,
    readonly details: { taskId: string; status: string },
  ) {
    super(message);
    this.name = 'TaskTerminalError';
  }

  /** 生成標準說明：「任務已經結束（已停止），<後果>」。 */
  static of(taskId: string, status: string, consequence = '不能再進行這個操作。'): TaskTerminalError {
    return new TaskTerminalError(`任務已經結束（${TERMINAL_LABEL[status] ?? status}），${consequence}`, { taskId, status });
  }
}

/**
 * 預算不夠，這次操作員發起的派發被拒絕（409，P0-7）：什麼都沒有發給 agent；任務同時因為預算進入 BLOCKED
 * （事件日誌裡有 budget.exceeded），介面上可以一鍵「放寬預算並繼續」。message 是給操作員看的中文說明。
 */
export class BudgetExhaustedError extends Error {
  readonly statusCode = 409;
  readonly code = 'BUDGET_EXHAUSTED';

  constructor(
    message: string,
    readonly details: { taskId: string; limit: string; used: number; max: number; needed?: number },
  ) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * 任務已阻塞，訊息沒有送出（409，P0-7 / H-8）：對話任務阻塞時，發訊息之前必須先顯式恢復（請求裡帶 resume: true，
 * 介面上是「恢復並傳送」），否則明確拒絕——絕不出現“任務顯示 BLOCKED，agent 卻在工作、不受任何限額約束”。
 */
export class TaskBlockedError extends Error {
  readonly statusCode = 409;
  readonly code = 'TASK_BLOCKED';

  constructor(
    message: string,
    readonly details: { taskId: string; blockedBy?: { source: string; code: string } },
  ) {
    super(message);
    this.name = 'TaskBlockedError';
  }
}

/** 預算調整的引數不合法（400，P0-7）。 */
export class BudgetInputError extends Error {
  readonly statusCode = 400;
  readonly code = 'BUDGET_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'BudgetInputError';
  }
}

/**
 * 編排器的狀態遷移沒有生效（409，P0-7）：例如「接受結果」之後任務沒有進入 COMPLETED。
 * 不再出現“介面返回成功、任務卻停在原狀態、事件日誌裡什麼都沒有”——被拒絕的遷移另外記一條 TRANSITION_REJECTED 警告。
 */
export class TransitionRejectedError extends Error {
  readonly statusCode = 409;
  readonly code = 'TRANSITION_REJECTED';

  constructor(
    message: string,
    readonly details: { taskId: string; from: string; to: string },
  ) {
    super(message);
    this.name = 'TransitionRejectedError';
  }
}

const APPROVAL_STATUS_LABEL: Record<string, string> ={ approved: '已批准', declined: '已拒絕', voided: '已作廢' };

/**
 * 審批已經被處理過（409，P0-5 / H-12）：同一審批只能被消費一次，併發或重複提交時只有第一次生效，
 * 其餘呼叫得到這個錯誤，不執行任何副作用。
 */
export class ApprovalConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'APPROVAL_ALREADY_RESOLVED';

  constructor(readonly details: { approvalId: string; status?: string }) {
    const label = details.status ? APPROVAL_STATUS_LABEL[details.status] : undefined;
    super(`這個審批已經處理過了${label ? `（${label}）` : ''}，不需要再操作。`);
    this.name = 'ApprovalConflictError';
  }
}

/**
 * 請求裡的 agent 不能擔任這個角色（400，P0 第二批審查）：例如把測試執行器指定為「同時問」的主 agent。
 * message 是給操作員看的中文說明。
 */
export class InvalidAgentError extends Error {
  readonly statusCode = 400;
  readonly code = 'INVALID_AGENT';

  constructor(
    message: string,
    readonly agentId: string,
  ) {
    super(message);
    this.name = 'InvalidAgentError';
  }
}

/**
 * 檢查點操作現在不可用（409，P2-3）：沒有可以撤銷的一輪、AI 正在工作、或者工作區不是 git 倉庫。
 */
export class CheckpointError extends Error {
  readonly statusCode = 409;
  readonly code = 'CHECKPOINT_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

/**
 * 今天的估算花費已經達到全域性每日上限（409，P1-7）：所有任務加起來的上限，由 ACC_DAILY_MAX_COST_USD 設定。
 * 明天自動恢復；需要今天繼續的話調高或取消這個設定後重啟服務。
 */
export class DailyBudgetError extends Error {
  readonly statusCode = 409;
  readonly code = 'DAILY_BUDGET_EXHAUSTED';

  constructor(
    message: string,
    readonly details: { spentUsd: number; limitUsd: number },
  ) {
    super(message);
    this.name = 'DailyBudgetError';
  }
}

/**
 * 工作區正被另一個任務使用（409，P1-4 / M-4）：另一個任務裡有 AI 正在改同一個（或包含關係的）資料夾，
 * 這時再讓一個能改檔案的 AI 在這裡動手，兩邊會互相覆蓋。等那邊做完、停止它，或者為任務使用獨立 worktree。
 */
export class WorkspaceBusyError extends Error {
  readonly statusCode = 409;
  readonly code = 'WORKSPACE_BUSY';

  constructor(
    message: string,
    readonly details: { taskId: string; otherTaskId: string; cwd: string },
  ) {
    super(message);
    this.name = 'WorkspaceBusyError';
  }
}

/**
 * 「停下這一輪」現在不可用（409，P1-10 / M-27）：這個 agent 沒有正在進行的一輪，或者它是自動流程正在等待的那一步
 * （停下它會讓流程卡住，應該用「停止」或閘門上的「重試」）。
 */
export class AgentInterruptError extends Error {
  readonly statusCode = 409;
  readonly code = 'INTERRUPT_UNAVAILABLE';

  constructor(
    message: string,
    readonly details: { taskId: string; agentId: string },
  ) {
    super(message);
    this.name = 'AgentInterruptError';
  }
}

/**
 * 人工閘門的這個操作現在不可用（409，P0 第二批審查）：例如評審閘門上沒有可以“重跑”的步驟。什麼都不會派發。
 */
export class GateActionError extends Error {
  readonly statusCode = 409;
  readonly code = 'GATE_ACTION_UNAVAILABLE';

  constructor(
    message: string,
    readonly details: { taskId: string; action: string; step?: string },
  ) {
    super(message);
    this.name = 'GateActionError';
  }
}

/**
 * 測試配置被改過、需要操作員先確認（P0-8 / H-15，HTTP 409）：手動「重跑測試」時發現測試配置和上次執行測試時不一樣，
 * 或者確認時帶回的摘要已經過時（確認之後配置又被改了）。差異已經記進任務快照（workflowState.testConfigReview），介面據此顯示確認卡片。
 */
export class TestConfigChangedError extends Error {
  readonly statusCode = 409;
  readonly code = 'TEST_CONFIG_CHANGED';

  constructor(
    message: string,
    readonly details: { taskId: string; paths: string[] },
  ) {
    super(message);
    this.name = 'TestConfigChangedError';
  }
}
