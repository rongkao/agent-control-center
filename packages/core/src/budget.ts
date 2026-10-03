import type { BlockedBy, BudgetSnapshot, PendingApproval, TaskBudget } from './types.js';

/**
 * 預算（P0-7 修正後的語義）：
 *
 * - 限額都是“最多允許 N”：第 N 輪 / 第 N 次呼叫照常進行，它的成功完成照常被接受（修正以前 `>=` 在最後一輪就阻塞、丟掉完成訊號）；
 *   已經用滿時不再派發新的一輪（派發前檢查），執行中超出（多於 N）才阻塞。時長是連續量，用滿即停。
 * - 時長只統計 agent 實際工作的時間（有 agent 處於一輪之中、並且沒有卡在工具審批上，見 activeWorkingAgents），
 *   不含等待人工（卡在審批上、評審閘門沒人問 agent）、對話空閒和服務停機的時間。
 * - 計數按視窗計算（BudgetWindow）：工作流在人工閘門（評審 / 重試）、換人接手、操作員放寬預算時開新視窗；
 *   對話任務每條操作員指令開一個新視窗。停滯計數在開新視窗時清零，操作員的訊息也算作有進展。
 * - maxReviewRounds 不按視窗計算：評審輪次是防止自動評審迴圈的硬上限，只能由操作員顯式調高。
 */

/** 自動流程（implementation-v1）的預設預算：整個任務一個視窗，人工閘門續額。 */
export const DEFAULT_BUDGET: TaskBudget = {
  maxTurns: 30,
  maxAgentCalls: 12,
  maxReviewRounds: 1,
  maxStallCount: 3,
  maxDurationMs: 30 * 60 * 1000,
};

/**
 * 對話任務的預設預算（P0-7 / H-8）：按“每條操作員指令一個視窗”計算——
 * 限的是 AI 為了一條指令自己連續做了多少事（輪次、呼叫、實際工作時長），而不是操作員能發多少條訊息。
 * Ask Both 一次用 2 次呼叫；agent 之間的自動交接也算在這條指令的視窗裡。
 */
export const DEFAULT_CONVERSATION_BUDGET: TaskBudget = {
  maxTurns: 30,
  maxAgentCalls: 12,
  maxReviewRounds: 1,
  maxStallCount: 3,
  maxDurationMs: 60 * 60 * 1000,
};

export type BudgetLimit =
  | 'maxTurns'
  | 'maxAgentCalls'
  | 'maxReviewRounds'
  | 'maxStallCount'
  | 'maxDurationMs'
  | 'maxEstimatedTokens'
  | 'maxCostUsd';

export const BUDGET_LIMITS: readonly BudgetLimit[] = ['maxTurns', 'maxAgentCalls', 'maxReviewRounds', 'maxStallCount', 'maxDurationMs', 'maxEstimatedTokens', 'maxCostUsd'];

/** 可以是小數的限額（美元）；其餘限額都是整數。 */
export const FRACTIONAL_LIMITS: readonly BudgetLimit[] = ['maxCostUsd'];

/** 操作員可以設定的限額範圍（預算 API 與編排器共用的校驗）。 */
export const BUDGET_LIMIT_RANGES: Readonly<Record<BudgetLimit, { min: number; max: number }>> = {
  maxTurns: { min: 1, max: 100_000 },
  maxAgentCalls: { min: 1, max: 100_000 },
  maxReviewRounds: { min: 0, max: 100 },
  maxStallCount: { min: 1, max: 10_000 },
  maxDurationMs: { min: 60_000, max: 30 * 24 * 60 * 60 * 1000 },
  maxEstimatedTokens: { min: 1, max: 1_000_000_000_000 },
  maxCostUsd: { min: 0.01, max: 100_000 },
};

export function createBudgetSnapshot(budget: Partial<TaskBudget> = {}, defaults: TaskBudget = DEFAULT_BUDGET): BudgetSnapshot {
  const overrides = Object.fromEntries(Object.entries(budget).filter(([, value]) => value !== undefined)) as Partial<TaskBudget>;
  const merged = { ...defaults, ...overrides };
  return {
    ...merged,
    turnsUsed: 0,
    agentCallsUsed: 0,
    reviewRoundsUsed: 0,
    stallCount: 0,
    estimatedTokensUsed: 0,
    costUsdUsed: 0,
    startedAt: Date.now(),
    activeMs: 0,
    workingAgentIds: [],
  };
}

/** 有效工作時長（毫秒）：已累計的部分 + 正在計時的這一段。 */
export function activeDurationMs(snapshot: BudgetSnapshot, now = Date.now()): number {
  const running = snapshot.activeSince !== undefined ? Math.max(0, now - snapshot.activeSince) : 0;
  return (snapshot.activeMs ?? 0) + running;
}

export interface WindowUsage {
  turns: number;
  agentCalls: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

/** 當前計數視窗內的用量。 */
export function windowUsage(snapshot: BudgetSnapshot, now = Date.now()): WindowUsage {
  const w = snapshot.window;
  return {
    turns: Math.max(0, snapshot.turnsUsed - (w?.turns ?? 0)),
    agentCalls: Math.max(0, snapshot.agentCallsUsed - (w?.agentCalls ?? 0)),
    tokens: Math.max(0, snapshot.estimatedTokensUsed - (w?.tokens ?? 0)),
    costUsd: Math.max(0, (snapshot.costUsdUsed ?? 0) - (w?.costUsd ?? 0)),
    durationMs: Math.max(0, activeDurationMs(snapshot, now) - (w?.activeMs ?? 0)),
  };
}

/** 已經用滿的限額（>=，按視窗計算）。用滿不代表越界：只代表不能再開始新的一輪 / 呼叫 / 評審。 */
export function budgetViolations(snapshot: BudgetSnapshot, now = Date.now()): string[] {
  const used = windowUsage(snapshot, now);
  const violations: string[] = [];
  if (used.turns >= snapshot.maxTurns) violations.push('maxTurns');
  if (used.agentCalls >= snapshot.maxAgentCalls) violations.push('maxAgentCalls');
  if (snapshot.reviewRoundsUsed >= snapshot.maxReviewRounds) violations.push('maxReviewRounds');
  if (snapshot.stallCount >= snapshot.maxStallCount) violations.push('maxStallCount');
  if (used.durationMs >= snapshot.maxDurationMs) violations.push('maxDurationMs');
  if (snapshot.maxEstimatedTokens !== undefined && used.tokens >= snapshot.maxEstimatedTokens) violations.push('maxEstimatedTokens');
  if (snapshot.maxCostUsd !== undefined && used.costUsd >= snapshot.maxCostUsd) violations.push('maxCostUsd');
  return violations;
}

/**
 * 執行中持續檢查的限額（觸發即停止正在工作的 agent 並阻塞 run）。
 * 輪次、停滯、token 必須“超出”（多於上限）才算：恰好用滿最後一輪時，這一輪的成功完成照常被接受。
 * 時長用滿即停。maxAgentCalls / maxReviewRounds 只在開始新呼叫 / 評審之前檢查（dispatchViolation / canStartReviewRound）。
 */
export const RUNTIME_ENFORCED_LIMITS: readonly BudgetLimit[] = ['maxTurns', 'maxStallCount', 'maxDurationMs', 'maxEstimatedTokens', 'maxCostUsd'];

export function runtimeViolations(snapshot: BudgetSnapshot, now = Date.now()): BudgetLimit[] {
  const used = windowUsage(snapshot, now);
  const violations: BudgetLimit[] = [];
  if (used.turns > snapshot.maxTurns) violations.push('maxTurns');
  if (snapshot.stallCount > snapshot.maxStallCount) violations.push('maxStallCount');
  if (used.durationMs >= snapshot.maxDurationMs) violations.push('maxDurationMs');
  if (snapshot.maxEstimatedTokens !== undefined && used.tokens > snapshot.maxEstimatedTokens) violations.push('maxEstimatedTokens');
  if (snapshot.maxCostUsd !== undefined && used.costUsd > snapshot.maxCostUsd) violations.push('maxCostUsd');
  return violations;
}

/**
 * 派發前檢查：開始這 calls 次新呼叫會不會超出預算（Ask Both 一次檢查全部呼叫，不夠就整體拒絕）。
 * modelAgent=false（測試執行器，不消耗模型輪次）時只看呼叫次數與時長。返回第一個不允許的限額。
 */
export function dispatchViolation(snapshot: BudgetSnapshot, now = Date.now(), options: { calls?: number; modelAgent?: boolean } = {}): BudgetLimit | undefined {
  const calls = options.calls ?? 1;
  const used = windowUsage(snapshot, now);
  if (used.agentCalls + calls > snapshot.maxAgentCalls) return 'maxAgentCalls';
  if (used.durationMs >= snapshot.maxDurationMs) return 'maxDurationMs';
  if (options.modelAgent !== false) {
    if (used.turns >= snapshot.maxTurns) return 'maxTurns';
    if (snapshot.maxEstimatedTokens !== undefined && used.tokens >= snapshot.maxEstimatedTokens) return 'maxEstimatedTokens';
    if (snapshot.maxCostUsd !== undefined && used.costUsd >= snapshot.maxCostUsd) return 'maxCostUsd';
    if (snapshot.stallCount >= snapshot.maxStallCount) return 'maxStallCount';
  }
  return undefined;
}

export function canStartAgentCall(snapshot: BudgetSnapshot, calls = 1): boolean {
  return windowUsage(snapshot).agentCalls + calls <= snapshot.maxAgentCalls;
}

export function canStartReviewRound(snapshot: BudgetSnapshot): boolean {
  return snapshot.reviewRoundsUsed < snapshot.maxReviewRounds;
}

/** 限額的已用量/上限（按視窗），用於 budget.exceeded 事件載荷與介面。 */
export function budgetUsage(snapshot: BudgetSnapshot, limit: BudgetLimit, now = Date.now()): { used: number; max: number } {
  const used = windowUsage(snapshot, now);
  switch (limit) {
    case 'maxTurns':
      return { used: used.turns, max: snapshot.maxTurns };
    case 'maxAgentCalls':
      return { used: used.agentCalls, max: snapshot.maxAgentCalls };
    case 'maxReviewRounds':
      return { used: snapshot.reviewRoundsUsed, max: snapshot.maxReviewRounds };
    case 'maxStallCount':
      return { used: snapshot.stallCount, max: snapshot.maxStallCount };
    case 'maxDurationMs':
      return { used: used.durationMs, max: snapshot.maxDurationMs };
    case 'maxEstimatedTokens':
      return { used: used.tokens, max: snapshot.maxEstimatedTokens ?? Number.POSITIVE_INFINITY };
    case 'maxCostUsd':
      return { used: used.costUsd, max: snapshot.maxCostUsd ?? Number.POSITIVE_INFINITY };
  }
}

/** 開一個新的計數視窗（原地修改）：之後的輪次、呼叫、token、時長從現在重新算，停滯計數清零。 */
export function renewBudgetWindow(snapshot: BudgetSnapshot, now: number, reason?: string): void {
  snapshot.window = {
    turns: snapshot.turnsUsed,
    agentCalls: snapshot.agentCallsUsed,
    tokens: snapshot.estimatedTokensUsed,
    costUsd: snapshot.costUsdUsed ?? 0,
    activeMs: activeDurationMs(snapshot, now),
    at: now,
    ...(reason ? { reason } : {}),
  };
  snapshot.stallCount = 0;
}

/** 是否有 agent 正在進行一輪工作。 */
export function hasWorkingAgents(snapshot: BudgetSnapshot): boolean {
  return (snapshot.workingAgentIds?.length ?? 0) > 0;
}

/**
 * 正在工作、並且沒有卡在審批上的 agent（P0 第二批審查 / H-8）：時長只為它們計時，執行時限額也只約束它們。
 * - 在等工具審批的 agent（canUseTool / 服務端審批請求掛起）什麼都做不了，等待人工的時間不算；
 * - 交接審批（payload.kind = handoff）不會暫停請求者：request_handoff 立即返回，它繼續把這一輪做完，照常計時。
 * 與 run 的狀態無關：等待審批 / 評審閘門 / 已阻塞時仍在工作的 agent（例如 Ask Both 的另一個、閘門期間被問的 Codex）同樣計時。
 */
export function activeWorkingAgents(run: { budget: BudgetSnapshot; pendingApprovals: ReadonlyArray<Pick<PendingApproval, 'agentId' | 'status' | 'payload'>> }): string[] {
  const paused = new Set(run.pendingApprovals.filter((x) => x.status === 'pending' && x.payload?.kind !== 'handoff').map((x) => x.agentId));
  return (run.budget.workingAgentIds ?? []).filter((agentId) => !paused.has(agentId));
}

/** 按“是否正在計時”開始或結束一段有效工作時間（原地修改），並記下這次記賬的時間。 */
export function syncActiveClock(snapshot: BudgetSnapshot, running: boolean, now: number): void {
  if (running && snapshot.activeSince === undefined) {
    snapshot.activeSince = now;
  } else if (!running && snapshot.activeSince !== undefined) {
    snapshot.activeMs = (snapshot.activeMs ?? 0) + Math.max(0, now - snapshot.activeSince);
    delete snapshot.activeSince;
  }
  snapshot.activeCheckedAt = now;
}

/**
 * 重啟恢復時結束上一個程序留下的計時段（原地修改）：只算到最後一次記賬的時間（上一個程序最後處理事件的時刻），
 * 停機期間不計入。恢復之後，續上的 agent 一有事件就重新開始計時。
 */
export function closeActiveClockAfterRestart(snapshot: BudgetSnapshot): void {
  if (snapshot.activeSince === undefined) return;
  const end = Math.max(snapshot.activeSince, snapshot.activeCheckedAt ?? snapshot.activeSince);
  snapshot.activeMs = (snapshot.activeMs ?? 0) + (end - snapshot.activeSince);
  delete snapshot.activeSince;
}

function isBudgetLimit(value: unknown): value is BudgetLimit {
  return typeof value === 'string' && (BUDGET_LIMITS as readonly string[]).includes(value);
}

/**
 * run 是否因為預算而阻塞，返回是哪一項限額（blockedBy.source = budget；升級前阻塞的舊任務沒有 blockedBy，從 currentStep = budget:<限額> 識別）。
 */
export function budgetBlockLimit(run: { status: string; currentStep: string; blockedBy?: Pick<BlockedBy, 'source' | 'code'> }): BudgetLimit | 'BUDGET_EXCEEDED' | undefined {
  if (run.status !== 'BLOCKED') return undefined;
  if (run.blockedBy) {
    if (run.blockedBy.source !== 'budget') return undefined;
    return isBudgetLimit(run.blockedBy.code) ? run.blockedBy.code : 'BUDGET_EXCEEDED';
  }
  if (!run.currentStep.startsWith('budget:')) return undefined;
  const code = run.currentStep.slice('budget:'.length);
  return isBudgetLimit(code) ? code : 'BUDGET_EXCEEDED';
}

/** 毫秒 → 中文時長（“30 分鐘”“2 小時”“1 小時 30 分鐘”）。 */
export function formatBudgetDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
}

/** 用中文說明哪一項預算用完了（給操作員看的原因，例如“已經執行超過 30 分鐘”）。 */
export function describeBudgetLimit(limit: BudgetLimit | 'BUDGET_EXCEEDED', budget: Pick<TaskBudget, BudgetLimit>): string {
  switch (limit) {
    case 'maxDurationMs':
      return `已經執行超過 ${formatBudgetDuration(budget.maxDurationMs)}（只計 AI 實際工作的時間）`;
    case 'maxTurns':
      return `AI 已經回覆了 ${budget.maxTurns} 輪（上限 ${budget.maxTurns} 輪）`;
    case 'maxAgentCalls':
      return `已經呼叫 AI ${budget.maxAgentCalls} 次（上限 ${budget.maxAgentCalls} 次）`;
    case 'maxStallCount':
      return `AI 連續 ${budget.maxStallCount} 輪沒有實際進展（沒有執行任何工具或修改）`;
    case 'maxEstimatedTokens':
      return `Token 用量已達上限（${budget.maxEstimatedTokens ?? '—'}）`;
    case 'maxCostUsd':
      return `估算花費已達上限（US$${budget.maxCostUsd ?? '—'}）`;
    case 'maxReviewRounds':
      return `評審輪次已用完（上限 ${budget.maxReviewRounds} 輪）`;
    default:
      return '預算已用完';
  }
}

/**
 * 校驗操作員提交的限額（預算 API、編排器共用）：只接受已知限額、範圍內的整數。
 * 返回問題說明（中文）；undefined 表示通過。
 */
export function budgetLimitsProblem(limits: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(limits)) {
    if (value === undefined) continue;
    if (!isBudgetLimit(key)) return `未知的預算專案「${key}」。`;
    const range = BUDGET_LIMIT_RANGES[key];
    const fractional = FRACTIONAL_LIMITS.includes(key);
    if (typeof value !== 'number' || !Number.isFinite(value) || (!fractional && !Number.isInteger(value)) || value < range.min || value > range.max) {
      return `${key} 必須是 ${range.min}～${range.max} 之間的${fractional ? '數字' : '整數'}，收到的是 ${JSON.stringify(value)}。`;
    }
  }
  return undefined;
}
