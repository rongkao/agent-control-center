/**
 * 阻塞橫幅與待審批橫幅的純函式規則（P0-6），與 React 元件分開，便於單獨測試。
 *
 * 任務因為 agent 失敗、長時間沒有動靜（看門狗）等原因進入 BLOCKED 時：用中文說清楚真實原因，
 * 並給出一鍵可用的出路（重試 / 換人接手 / 停止），不需要使用者懂錯誤程式碼。
 * 本模組不依賴其他前端模組（測試直接引用它）；步驟名稱與續接失敗說明也由這裡提供給 format.ts。
 */

/** 工作流步驟的中文名稱。 */
export const STEP_LABEL: Record<string, string> = {
  implement: '實現',
  test: '測試',
  retry: '重試修復',
  rescue: '另一個 AI 診斷',
  fix: '按診斷修復',
  'review-gate': '等待確認',
  review: '評審',
  'review-fix': '按評審修改',
  'final-test': '最終測試',
  done: '完成',
};

/**
 * 續跑前置條件不滿足（H-4）時阻塞橫幅上的原因。鍵是 runtime.error 的 data.classifiedAs（adapter 給出的結構化程式碼）。
 * 這些情況下系統故意不續接（fail closed），避免 AI 在錯誤的目錄或以錯誤的權限繼續工作。
 */
export const RESUME_BLOCK_REASON: Record<string, string> = {
  RESUME_CWD_MISSING: '找不到這個對話原來的工作目錄。為了不讓 AI 改到別的目錄（例如主倉庫），系統沒有續接它。',
  RESUME_MODE_MISSING: '找不到這個對話原來的權限模式（例如唯讀評審）。為了安全，系統沒有續接它。',
  CODEX_RESUME_CWD_MISMATCH: 'Codex 續接後使用的工作目錄和任務的工作目錄不一致。為了不改錯目錄，系統已經停下。',
};

/** 一鍵「重試」時交給 agent 的說明（工作流的人工閘門 retry 必須帶說明）。 */
export const RETRY_NOTE = '操作員按了「重試」：請檢查工作區目前的狀態，從中斷的地方繼續完成這一步。';

/** 診斷 / 評審的 agent 失敗或卡住時，一鍵“讓實現者自己繼續”交給實現者的說明。 */
export function skipHelperNote(helper: string): string {
  return `${helper} 這一步沒有完成（失敗或長時間沒有回應），操作員決定不再等它：請檢查工作區目前的狀態和最近的測試結果，自己繼續完成這個任務。`;
}

const BUDGET_LABEL: Record<string, string> = {
  maxTurns: '模型輪次',
  maxAgentCalls: 'Agent 呼叫次數',
  maxStallCount: '連續沒有進展',
  maxDurationMs: '執行時長',
  maxEstimatedTokens: 'Token 用量',
  maxCostUsd: '估算花費',
  maxReviewRounds: '評審輪次',
};

/** 預算項的中文名（例如 maxDurationMs → 執行時長）；認不出的原樣返回。 */
export function budgetLabel(code: string): string {
  return BUDGET_LABEL[code] ?? code;
}

/** 限額（結構與服務端快照的 budget 一致，只取用得到的欄位）。 */
export interface BudgetLimits {
  maxTurns: number;
  maxAgentCalls: number;
  maxReviewRounds: number;
  maxStallCount: number;
  maxDurationMs: number;
  maxEstimatedTokens?: number;
  maxCostUsd?: number;
}

/** 橫幅需要的最小輸入（結構與服務端快照一致，只取用得到的欄位）。 */
export interface BlockedInput {
  task: { currentAction?: string };
  run: {
    status: string;
    currentStep: string;
    blockedBy?: { source: string; code: string; agentId?: string };
    primaryAgentId?: string;
    currentAgentId?: string;
    /** 限額（用來說明是哪一項預算用完了，P0-7）。 */
    budget?: BudgetLimits;
    workflowState?: {
      step: string;
      agents: { implement: string; review: string; test: string };
      lastError?: { agentId: string; code: string; category: string; retryable: boolean };
    };
  };
  events: Array<{ type: string; agentId?: string; data: Record<string, unknown> }>;
  agents: Array<{ id: string; name: string; kind: string }>;
}

/**
 * relax：一鍵「放寬預算並繼續」（P0-7，呼叫預算 API 的 relax）。
 * rerun：把阻塞的這一步交還給負責它的 agent 重做（人工閘門的 rerun，P0 第二批審查）——失敗 / 卡住的是診斷或評審的 agent 時，
 * 「重試」要重跑那一步，而不是交給實現者。
 */
export type BlockedActionKind = 'retry' | 'rerun' | 'reassign' | 'stop' | 'relax';

/** 毫秒 → 中文時長（“30 分鐘”“2 小時”“1 小時 30 分鐘”），與服務端的說明一致。 */
export function budgetDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
}

/** run 是否因為預算而阻塞，返回是哪一項限額（升級前阻塞的舊任務沒有 blockedBy，從 currentStep = budget:<限額> 識別）。 */
export function budgetBlockCode(run: BlockedInput['run']): string | undefined {
  if (run.status !== 'BLOCKED') return undefined;
  if (run.blockedBy) return run.blockedBy.source === 'budget' ? run.blockedBy.code : undefined;
  return run.currentStep.startsWith('budget:') ? run.currentStep.slice('budget:'.length) : undefined;
}

/** 用中文說明哪一項預算用完了（例如“已經執行超過 30 分鐘”）；不知道限額時返回 undefined。 */
export function budgetLimitDetail(code: string, budget: BudgetLimits | undefined): string | undefined {
  if (!budget) return undefined;
  switch (code) {
    case 'maxDurationMs':
      return `已經執行超過 ${budgetDuration(budget.maxDurationMs)}（只計 AI 實際工作的時間）`;
    case 'maxTurns':
      return `AI 已經回覆了 ${budget.maxTurns} 輪`;
    case 'maxAgentCalls':
      return `已經呼叫 AI ${budget.maxAgentCalls} 次`;
    case 'maxStallCount':
      return `AI 連續 ${budget.maxStallCount} 輪沒有實際進展（沒有執行任何工具或修改）`;
    case 'maxEstimatedTokens':
      return budget.maxEstimatedTokens ? `Token 用量已達 ${budget.maxEstimatedTokens}` : undefined;
    case 'maxCostUsd':
      return budget.maxCostUsd ? `估算花費已達 US$${budget.maxCostUsd}` : undefined;
    case 'maxReviewRounds':
      return `評審輪次已用完（上限 ${budget.maxReviewRounds} 輪）`;
    default:
      return undefined;
  }
}

/** 放寬之後再給多少（按鈕上的說明）。 */
function relaxGrant(code: string, budget: BudgetLimits | undefined): string {
  if (!budget) return '再給一份同樣的額度';
  switch (code) {
    case 'maxDurationMs':
      return `再給 ${budgetDuration(budget.maxDurationMs)} 工作時間`;
    case 'maxTurns':
      return `再給 ${budget.maxTurns} 輪`;
    case 'maxAgentCalls':
      return `再給 ${budget.maxAgentCalls} 次呼叫`;
    case 'maxCostUsd':
      return budget.maxCostUsd ? `再給 US$${budget.maxCostUsd} 的額度` : '再給一份同樣的額度';
    case 'maxStallCount':
      return '重新計算「沒有進展」的輪次';
    default:
      return '再給一份同樣的額度';
  }
}

/** 服務端寫在當前動作裡的預算原因前綴（P0-7）：例如“預算用完：呼叫次數不夠：還剩 1 次，這次需要 2 次”。 */
const BUDGET_ACTION_PREFIX = '預算用完：';

/** 因預算阻塞時的原因（中文）：哪一項用完了、上限是多少。服務端給出了更具體的說明時優先用它。 */
function budgetReason(code: string, budget: BudgetLimits | undefined, currentAction?: string): string {
  const label = BUDGET_LABEL[code] ?? code;
  const precise = currentAction?.startsWith(BUDGET_ACTION_PREFIX) ? currentAction.slice(BUDGET_ACTION_PREFIX.length) : undefined;
  const detail = precise || budgetLimitDetail(code, budget);
  return detail ? `已達到預算上限（${label}）：${detail}。任務先停在這裡等你決定。` : `已達到預算上限（${label}），任務先停在這裡等你決定。`;
}

export interface BlockedAction {
  kind: BlockedActionKind;
  label: string;
  /** 換人接手的目標 agent。 */
  agentId?: string;
  /** 重試時交給 agent 的說明。 */
  note?: string;
  /** 需要先確認的操作（停止）。 */
  confirm?: string;
  /** 滑鼠懸停時的說明。 */
  title?: string;
}

export interface BlockedBanner {
  /** 為什麼停下來了（中文）。 */
  reason: string;
  /** 補充說明（例如為什麼沒有「重試」）。 */
  hint?: string;
  actions: BlockedAction[];
}

/** run 處於 BLOCKED 時的橫幅：真實原因 + 一鍵出路。其他狀態返回 undefined。 */
export function blockedBanner(input: BlockedInput): BlockedBanner | undefined {
  const { run } = input;
  if (run.status !== 'BLOCKED') return undefined;
  const name = (agentId: string | undefined) => (agentId ? (input.agents.find((a) => a.id === agentId)?.name ?? agentId) : 'Agent');
  const lastEvent = (predicate: (e: BlockedInput['events'][number]) => boolean) => [...input.events].reverse().find(predicate);

  const workflow = run.workflowState;
  const current = workflow?.agents.implement ?? run.primaryAgentId ?? run.currentAgentId;
  // 真正失敗 / 卡住的 agent 和步驟（P0 第二批審查）：出路要針對它，而不是總針對實現者
  const stuck = workflow ? stuckOf(input, lastEvent) : undefined;
  const actions: BlockedAction[] = [];
  /** 不能作為接手人的 agent：剛剛失敗 / 卡住的、續接不了的（P0 第三批審查）。 */
  let unavailable = stuck?.agentId;
  const reassignAndStop = () => {
    for (const agent of input.agents) {
      // 不把任務交給剛剛失敗 / 卡住的那個 agent
      if (agent.kind === 'test' || agent.id === current || agent.id === unavailable) continue;
      actions.push({ kind: 'reassign', label: `換 ${agent.name} 接手`, agentId: agent.id, title: `停止 ${name(current)}，把任務連同上下文交給 ${agent.name} 繼續` });
    }
    actions.push({ kind: 'stop', label: '停止', confirm: '確定停止此任務？', title: '結束這個任務（已完成的修改會保留在工作區）' });
  };

  // 因預算阻塞（P0-7）：說明是哪一項用完了；第一個出路是一鍵放寬預算並從中斷的地方繼續
  const budgetCode = budgetBlockCode(run);
  if (budgetCode) {
    actions.push({ kind: 'relax', label: '放寬預算並繼續', title: `${relaxGrant(budgetCode, run.budget)}，然後讓 AI 從中斷的地方繼續` });
    reassignAndStop();
    return { reason: budgetReason(budgetCode, run.budget, input.task.currentAction), actions };
  }

  // 續接前置條件不滿足：重試註定失敗，只給真正可行的出路
  const resumeProblem = lastEvent((e) => e.type === 'runtime.error' && typeof e.data.classifiedAs === 'string' && e.data.classifiedAs in RESUME_BLOCK_REASON);
  const blockedCode = run.blockedBy?.code;
  const resumeBlocked = Boolean(resumeProblem) && (blockedCode === 'ADAPTER_RESUME_FAILED' || blockedCode === 'SESSION_RESUME_BLOCKED' || run.blockedBy?.source === 'runtime');
  const reason = resumeBlocked ? `無法續接：${RESUME_BLOCK_REASON[String(resumeProblem!.data.classifiedAs)]}` : describeBlock(input, name, lastEvent);
  // 續接不了的是診斷 / 評審的 agent（不是實現者，P0 第三批審查）：按“卡住的 agent”處理——讓實現者自己繼續是可行的出路，
  // 也不把任務交給那個續接不了的 agent
  const resumeFailed = resumeBlocked ? (resumeProblem?.agentId ?? run.blockedBy?.agentId) : undefined;
  const helperResumeFailed = Boolean(workflow && resumeFailed && resumeFailed !== current);
  if (resumeFailed) unavailable = resumeFailed;

  if (workflow && helperResumeFailed) {
    actions.push({ kind: 'retry', label: `讓 ${name(current)} 自己繼續`, note: skipHelperNote(name(resumeFailed)), title: `不再續接 ${name(resumeFailed)}：讓 ${name(current)} 從目前的狀態繼續這個任務` });
  } else if (workflow && !resumeBlocked) {
    if (stuck && stuck.agentId !== current) {
      // 失敗 / 卡住的是診斷、評審或測試的 agent：「重試」請它重做這一步；另給一個“不等它了，讓實現者自己繼續”的出路
      const stepName = STEP_LABEL[stuck.step ?? ''] ?? stuck.step ?? '這一步';
      actions.push({ kind: 'rerun', label: '重試', note: RETRY_NOTE, title: `讓 ${name(stuck.agentId)} 重新做「${stepName}」這一步` });
      actions.push({ kind: 'retry', label: `讓 ${name(current)} 自己繼續`, note: skipHelperNote(name(stuck.agentId)), title: `不等 ${name(stuck.agentId)} 了：讓 ${name(current)} 從目前的狀態繼續這個任務` });
    } else {
      actions.push({ kind: 'retry', label: '重試', note: RETRY_NOTE, title: `讓 ${name(current)} 從中斷的地方繼續這一步` });
    }
  }
  reassignAndStop();

  const hint = helperResumeFailed ? `補充說明或重試都無法續接和 ${name(resumeFailed)} 的這段對話；可以讓 ${name(current)} 自己繼續。` : resumeBlocked ? '補充說明或重試都無法續接這段對話。' : undefined;
  return { reason, hint, actions };
}

/** 最近一次看門狗判定“沒有動靜”的事件。 */
const isStall = (e: BlockedInput['events'][number]) => e.type === 'runtime.error' && e.data.code === 'STEP_INACTIVITY_TIMEOUT';

/**
 * 工作流任務裡真正失敗 / 卡住的 agent 和步驟：agent 失敗看 lastError（其次 blockedBy.agentId），
 * 看門狗阻塞看最近一次 STEP_INACTIVITY_TIMEOUT 事件。其他阻塞原因（測試失敗、拒絕審批等）返回 undefined。
 */
function stuckOf(
  input: BlockedInput,
  lastEvent: (predicate: (e: BlockedInput['events'][number]) => boolean) => BlockedInput['events'][number] | undefined,
): { agentId: string; step?: string } | undefined {
  const { run } = input;
  const workflow = run.workflowState;
  if (!workflow) return undefined;
  switch (run.blockedBy?.code) {
    case 'AGENT_FAILED': {
      const agentId = workflow.lastError?.agentId ?? run.blockedBy.agentId;
      return agentId ? { agentId, step: workflow.step } : undefined;
    }
    case 'STEP_INACTIVE': {
      const stalled = lastEvent(isStall);
      if (!stalled?.agentId) return undefined;
      return { agentId: stalled.agentId, step: typeof stalled.data.step === 'string' ? stalled.data.step : workflow.step };
    }
    default:
      return undefined;
  }
}

/** 進入 BLOCKED 的真實原因（中文）。 */
function describeBlock(
  input: BlockedInput,
  name: (agentId: string | undefined) => string,
  lastEvent: (predicate: (e: BlockedInput['events'][number]) => boolean) => BlockedInput['events'][number] | undefined,
): string {
  const { run, task } = input;
  const blockedBy = run.blockedBy;
  const step = (value: string | undefined) => (value ? (STEP_LABEL[value] ?? value) : '這一步');
  switch (blockedBy?.source) {
    case 'approval':
      return '你拒絕了一個操作，任務已暫停在這一步（被拒絕的操作沒有執行）。';
    case 'budget':
      return budgetReason(blockedBy.code, run.budget, task.currentAction);
    case 'safety':
      return `被安全策略攔下了（${blockedBy.code}），任務已停止在這一步。`;
    default:
      break;
  }
  switch (blockedBy?.code) {
    case 'STEP_INACTIVE': {
      const stalled = lastEvent(isStall);
      const agentId = stalled?.agentId;
      const minutes = typeof stalled?.data.thresholdMs === 'number' ? Math.round(stalled.data.thresholdMs / 60_000) : undefined;
      const stepName = step(typeof stalled?.data.step === 'string' ? stalled.data.step : run.workflowState?.step);
      // 按實際經過描述（P0 第二批審查）：這個 agent 有沒有被自動重啟過、有沒有請別的 agent 診斷過
      const stalls = input.events.filter((e) => isStall(e) && e.agentId === agentId);
      const restarted = stalls.some((e) => e.data.next === 'retry');
      const diagnosed = stalls.some((e) => e.data.next === 'rescue');
      const reviewer = name(run.workflowState?.agents.review);
      const tried = restarted
        ? diagnosed
          ? `，自動重啟和請 ${reviewer} 診斷之後仍然沒有恢復`
          : '，自動重啟之後仍然沒有恢復'
        : diagnosed
          ? `，請 ${reviewer} 診斷之後仍然沒有恢復`
          : '';
      return `${name(agentId)} 在「${stepName}」這一步${minutes ? `超過 ${minutes} 分鐘` : '長時間'}沒有任何動靜${tried}。`;
    }
    case 'AGENT_FAILED':
      return describeFailure(input, name, lastEvent, step);
    case 'TESTS_FAILED':
      return '測試在自動重試和診斷修復之後仍然失敗。';
    case 'FINAL_TEST_FAILED':
      return '按評審意見修改之後，最終測試失敗。';
    case 'ORCHESTRATOR_REACTION_FAILED':
      return '編排器內部出錯（不是 AI 的問題），任務已停在這一步等你處理。';
    case 'RUNTIME_DISCONNECTED':
      return '服務重啟後無法確認 AI 當時的狀態，為了安全先停在這一步。';
    default:
      return `任務已阻塞：${task.currentAction ?? run.currentStep}`;
  }
}

/** agent 在這一步失敗了：按錯誤程式碼、類別和 HTTP 狀態碼給出原因。 */
function describeFailure(
  input: BlockedInput,
  name: (agentId: string | undefined) => string,
  lastEvent: (predicate: (e: BlockedInput['events'][number]) => boolean) => BlockedInput['events'][number] | undefined,
  step: (value: string | undefined) => string,
): string {
  const error = input.run.workflowState?.lastError;
  const who = name(error?.agentId ?? input.run.blockedBy?.agentId);
  const where = step(input.run.workflowState?.step);
  if (!error) return `${who} 在「${where}」這一步失敗了。`;
  const code = error.code;
  const detail = lastEvent((e) => e.type === 'runtime.error' && e.agentId === error.agentId && e.data.code === code);
  const status = typeof detail?.data.apiErrorStatus === 'number' ? detail.data.apiErrorStatus : undefined;
  if (/AUTHENTICATION|OAUTH|UNAUTHORIZED|ACCOUNT_ON_HOLD|VERIFICATION_REQUIRED|CREDENTIAL/.test(code) || status === 401 || status === 403 || error.category === 'permission') {
    return `${who} 的登入已失效或沒有權限（${code}）。請先在終端機重新登入 ${who}，再按「重試」。`;
  }
  if (error.category === 'usage' || status === 429 || /RATE_LIMIT|USAGE_LIMIT|BILLING|QUOTA|BUDGET|MAX_TURNS/.test(code)) {
    return `${who} 的用量或額度已達上限（${code}），自動重試後仍然失敗。可以稍後按「重試」，或換人接手。`;
  }
  if (code === 'CLAUDE_RUNTIME_EXITED') return `${who} 程式意外結束了，自動重新連線後仍然沒有完成這一步。`;
  if (code === 'CLAUDE_RUNTIME_ERROR' || code === 'CODEX_TRANSPORT_CLOSED') return `${who} 程式中斷了連線，自動重新連線後仍然失敗。`;
  if (code === 'CODEX_TURN_INTERRUPTED') return `${who} 的這一輪被中斷了，自動重試後仍然沒有完成。`;
  if (status === 529 || (status !== undefined && status >= 500) || /OVERLOADED|SERVER_ERROR/.test(code)) {
    return `${who} 的服務暫時繁忙（${code}），自動重試後仍然失敗。可以稍後按「重試」。`;
  }
  return `${who} 在「${where}」這一步失敗了（${code}）。`;
}

/**
 * 向已阻塞的對話任務發訊息之前的確認文字（P0-7 / H-8）：說明為什麼阻塞，確認後「恢復並傳送」
 * （服務端先恢復任務，因預算阻塞的會先放寬預算）。不需要確認（沒有阻塞、或者是工作流任務）時返回 undefined。
 */
export function blockedSendConfirm(input: BlockedInput): string | undefined {
  const { run } = input;
  if (run.status !== 'BLOCKED' || run.workflowState) return undefined;
  const banner = blockedBanner(input);
  const how = budgetBlockCode(run) ? '確定要恢復任務並傳送這條訊息嗎？（會重新計算預算，AI 會接著工作）' : '確定要恢復任務並傳送這條訊息嗎？';
  return `任務目前已阻塞：${banner?.reason ?? run.currentStep}\n\n${how}`;
}

/** 預算卡片的一行（P0-7）：當前計數視窗內的用量 / 上限。 */
export interface BudgetRow {
  label: string;
  used: number;
  max: number;
  kind?: 'duration' | 'tokens' | 'usd';
}

/** 預算快照（只取用得到的欄位）。 */
export interface BudgetUsageInput extends BudgetLimits {
  turnsUsed: number;
  agentCallsUsed: number;
  reviewRoundsUsed: number;
  stallCount: number;
  estimatedTokensUsed: number;
  costUsdUsed?: number;
  activeMs?: number;
  activeSince?: number;
  window?: { turns: number; agentCalls: number; tokens: number; costUsd?: number; activeMs: number; at: number; reason?: string };
}

/** 有效工作時長（毫秒）：只統計 AI 實際在工作的時間。 */
export function activeWorkMs(budget: BudgetUsageInput, now: number): number {
  return (budget.activeMs ?? 0) + (budget.activeSince !== undefined ? Math.max(0, now - budget.activeSince) : 0);
}

/** 預算卡片的各行：按當前計數視窗計算（對話任務每條指令一個視窗；工作流在閘門續額 / 放寬預算時開新視窗）。 */
export function budgetRows(budget: BudgetUsageInput, now: number): BudgetRow[] {
  const w = budget.window;
  const rows: BudgetRow[] = [
    { label: '模型輪次', used: Math.max(0, budget.turnsUsed - (w?.turns ?? 0)), max: budget.maxTurns },
    { label: 'Agent 呼叫', used: Math.max(0, budget.agentCallsUsed - (w?.agentCalls ?? 0)), max: budget.maxAgentCalls },
    { label: '評審輪次', used: budget.reviewRoundsUsed, max: budget.maxReviewRounds },
    { label: '連續無進展', used: budget.stallCount, max: budget.maxStallCount },
    { label: '工作時長', used: Math.max(0, activeWorkMs(budget, now) - (w?.activeMs ?? 0)), max: budget.maxDurationMs, kind: 'duration' },
  ];
  if (budget.maxEstimatedTokens) rows.push({ label: 'Token', used: Math.max(0, budget.estimatedTokensUsed - (w?.tokens ?? 0)), max: budget.maxEstimatedTokens, kind: 'tokens' });
  if (budget.maxCostUsd) rows.push({ label: '估算花費', used: Math.max(0, (budget.costUsdUsed ?? 0) - (w?.costUsd ?? 0)), max: budget.maxCostUsd, kind: 'usd' });
  return rows;
}

/**
 * 待審批橫幅：只有 agent 的交接請求時說明是誰請求交給誰（agent 並沒有暫停，批准或拒絕之後流程都會繼續）；
 * 有普通操作等待審批時，agent 在等你，已暫停。沒有待審批時返回 undefined。
 */
export function pendingApprovalBanner(pending: Array<{ agentId: string; payload?: Record<string, unknown> }>, agents: Array<{ id: string; name: string }>): string | undefined {
  if (pending.length === 0) return undefined;
  const name = (agentId: unknown) => (typeof agentId === 'string' ? (agents.find((a) => a.id === agentId)?.name ?? agentId) : 'Agent');
  const handoffs = pending.filter((p) => p.payload?.kind === 'handoff');
  if (handoffs.length === pending.length) {
    if (handoffs.length === 1) {
      const request = handoffs[0]!.payload!;
      // 從文字推斷出的請求（P0-9）：說明為什麼要你確認
      const inferred = request.inferred === true ? '這是從文字推斷的請求，需要你確認；' : '';
      return `${name(request.fromAgentId ?? handoffs[0]!.agentId)} 請求把工作交給 ${name(request.toAgentId)}，等你決定：${inferred}批准或拒絕之後流程都會繼續。`;
    }
    return `有 ${handoffs.length} 個交接請求等你決定：批准或拒絕之後流程都會繼續。`;
  }
  return `有 ${pending.length} 個操作等待你的審批，Agent 已暫停。`;
}
