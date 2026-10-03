import { BUDGET_LIMITS, activeWorkingAgents, renewBudgetWindow, syncActiveClock } from './budget.js';
import { canAcceptResult, canTransition, isTerminal } from './state-machine.js';
import type {
  AgentStatus,
  ApprovalRecord,
  BlockedBy,
  PendingApproval,
  RunSnapshot,
  TaskBudget,
  TaskRecord,
  TaskStatus,
  UnifiedEvent,
  UsageCursor,
  UsageRecord,
} from './types.js';

/** 投影的附加輸入。 */
export interface ProjectionOptions {
  /**
   * 編排器時鐘的當前時間（P0-7 有效工作時長記賬用）。預設用事件時間戳。
   * 編排器傳入自己的時鐘（測試可注入），保證時長預算與定時檢查用的是同一個時鐘。
   */
  now?: number;
  /**
   * 這個事件來自編排器已經取消過的會話（遲到的殘留事件）：不能把這個 agent 重新記為“正在工作”，
   * 否則時長會被繼續計算。結束類事件（終態、會話關閉）照常處理。
   */
  fromCancelledSession?: boolean;
}

/**
 * 純函式事件投影：把一個 UnifiedEvent 應用到 task + RunSnapshot 上（原地修改傳入物件）。
 *
 * 所有影響狀態的變化都經由事件完成，保證“事件追加 + 快照更新”可以放在同一個儲存事務裡提交，
 * 事件日誌永遠不會聲稱一個快照中不存在的審批或步驟遷移。
 */
export interface ProjectionResult {
  approvals: ApprovalRecord[];
  usage: UsageRecord[];
  /** 本事件是否引起了任務狀態變化。 */
  statusChanged: boolean;
  /** 狀態遷移被狀態機拒絕時的說明（事件仍然記錄，但不改變狀態）。 */
  rejectedTransition?: { from: TaskStatus; to: TaskStatus };
}

const AGENT_STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  'idle',
  'starting',
  'planning',
  'coding',
  'reviewing',
  'testing',
  'waiting',
  'blocked',
  'failed',
  'completed',
  'cancelled',
]);

/** 被視為“語義進展”的事件型別；單純的 token 輸出不算進展。 */
const PROGRESS_EVENTS: ReadonlySet<string> = new Set(['tool.completed', 'handoff.completed']);

/**
 * 唯讀取、不改變任何東西的工具（P1-8）：它們完成不算“有進展”，否則 agent 反覆讀同一個檔案也能一直清零停滯計數。
 * 命令類工具（Bash / shell）無法判斷是否唯讀，按有進展處理。
 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

function readOnlyToolDone(event: UnifiedEvent): boolean {
  return event.type === 'tool.completed' && typeof event.data.toolName === 'string' && READ_ONLY_TOOLS.has(event.data.toolName);
}

/**
 * BLOCKED 期間可以更新“當前動作”（也就是介面上的阻塞原因）的事件：新的錯誤、攔截、預算與狀態事件。
 * agent 在 BLOCKED 之後繼續完成當前這一輪時發出的普通事件（工具完成、本輪結束等）不能把阻塞原因覆蓋掉。
 */
const BLOCK_REASON_EVENTS: ReadonlySet<string> = new Set(['runtime.error', 'safety.blocked', 'budget.exceeded', 'budget.stalled', 'run.status']);

/** agent 正在進行一輪工作的狀態（P0-7：有效工作時長只在有 agent 處於這一輪之中時計算）。 */
const WORKING_STATUSES: ReadonlySet<string> = new Set(['starting', 'planning', 'coding', 'reviewing', 'testing']);
/** 這一輪結束的狀態（終態合約：completed / failed / cancelled）。 */
const TURN_END_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
/**
 * 編排器 fail closed 時記錄的錯誤碼（runtime.error 不帶 sessionId）：這次派發沒有送達，或者已經無法確認 agent 還在工作，
 * 不再為它計時（它之後如果真的有動靜，事件會重新把它記為正在工作）。
 */
const DISPATCH_FAILURE_CODES: ReadonlySet<string> = new Set([
  'ADAPTER_START_FAILED',
  'ADAPTER_SEND_FAILED',
  'ADAPTER_RESUME_FAILED',
  'ADAPTER_APPROVE_FAILED',
  'RUNTIME_DISCONNECTED',
  'RUNTIME_CANNOT_RESUME',
  'SESSION_RESUME_BLOCKED',
  'SESSION_OWNERSHIP_CONFLICT',
  'WORKSPACE_REJECTED',
]);

/**
 * 一輪的用量（P1-7 / M-17）。token 口徑統一為：輸入包含快取讀寫（OTel GenAI 的口徑），輸出包含思考。
 * - adapter 給出 cumulative（會話累計值）時：減去該會話上一次的累計值得到這一輪的增量；累計值變小說明被重置
 *   （例如會話被 /clear），這時整個累計值就是增量；全為 0 的結果（崩潰 / 啟動失敗）不記賬、不更新遊標。
 * - 否則直接用 adapter 給出的這一輪用量（Codex 已經在 adapter 裡按執行緒累計值算好增量）。
 */
function turnUsage(run: RunSnapshot, sessionId: string | undefined, u: Record<string, unknown>): Omit<UsageRecord, 'id' | 'runId' | 'agentId' | 'createdAt'> | undefined {
  const base = { model: str(u.model), durationMs: num(u.durationMs), providerReported: u.providerReported !== false };
  const c = u.cumulative;
  if (c && typeof c === 'object' && sessionId) {
    const now = cursorOf(c as Record<string, unknown>);
    if (now.costUsd === 0 && now.inputTokens === 0 && now.outputTokens === 0) return undefined;
    const cursors = (run.usageCursors ??= {});
    const prev = cursors[sessionId];
    const reset = prev !== undefined && (now.costUsd < prev.costUsd || now.inputTokens < prev.inputTokens || now.outputTokens < prev.outputTokens);
    const from = prev && !reset ? prev : { costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    cursors[sessionId] = now;
    return {
      ...base,
      inputTokens: now.inputTokens - from.inputTokens,
      outputTokens: now.outputTokens - from.outputTokens,
      cachedTokens: Math.max(0, now.cacheReadTokens - from.cacheReadTokens),
      cacheWriteTokens: Math.max(0, now.cacheWriteTokens - from.cacheWriteTokens),
      costUsd: Math.max(0, roundUsd(now.costUsd - from.costUsd)),
    };
  }
  return {
    ...base,
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cachedTokens: num(u.cachedTokens),
    cacheWriteTokens: num(u.cacheWriteTokens),
    costUsd: num(u.costUsd),
  };
}

function cursorOf(c: Record<string, unknown>): UsageCursor {
  return {
    costUsd: num(c.costUsd) ?? 0,
    inputTokens: num(c.inputTokens) ?? 0,
    outputTokens: num(c.outputTokens) ?? 0,
    cacheReadTokens: num(c.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(c.cacheWriteTokens) ?? 0,
  };
}

/** 美元保留到 1e-6，避免浮點累加誤差讓 0.1 + 0.2 之類的差值出現負零或長尾。 */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function removeInFlight(run: RunSnapshot, event: UnifiedEvent): void {
  if (!run.inFlightSideEffects?.length) return;
  const id = str(event.data.toolCallId) ?? str(event.data.providerCallId);
  run.inFlightSideEffects = run.inFlightSideEffects.filter((x) => x.id !== id);
}

/** 工具輸入的簡短說明（命令、檔案路徑……），最多 200 字。 */
function inputSummary(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  const main = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url;
  const text = main !== undefined ? String(main) : JSON.stringify(o);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function projectEvent(task: TaskRecord, run: RunSnapshot, event: UnifiedEvent, options: ProjectionOptions = {}): ProjectionResult {
  const result: ProjectionResult = { approvals: [], usage: [], statusChanged: false };
  const now = options.now ?? event.timestamp;

  /** force：操作員「接受結果」（canAcceptResult 已確認來源狀態），不走普通遷移表。 */
  const setStatus = (next: TaskStatus, force = false): boolean => {
    if (run.status === next) return true;
    if (!force && !canTransition(run.status, next)) {
      result.rejectedTransition = { from: run.status, to: next };
      return false;
    }
    run.status = next;
    task.status = next;
    result.statusChanged = true;
    // 阻塞原因（M-5）：進入 BLOCKED 時記錄觸發它的事件，離開 BLOCKED 時清除
    if (next === 'BLOCKED') run.blockedBy = blockedByOf(event);
    else delete run.blockedBy;
    return true;
  };

  run.lastEventId = event.id;
  run.lastSequence = Math.max(run.lastSequence, event.sequence);
  run.updatedAt = event.timestamp;
  task.updatedAt = event.timestamp;
  const wasBlocked = run.status === 'BLOCKED';

  if (event.agentId) {
    const session = run.agentSessions[event.agentId];
    const status = event.data.status;
    if (session && event.type === 'agent.status' && typeof status === 'string' && AGENT_STATUSES.has(status)) {
      session.status = status as AgentStatus;
      // 會話沒做完的唯讀輪全部結束了（這一輪做完或失敗，後面沒有排隊的輪）：清掉“這一輪唯讀”的標記（P0 第三批審查）。
      // 被取消的一輪不算做完——預算停止之後放寬、重啟之後續跑，續上的仍是那一輪，仍然唯讀
      const ownSession = event.sessionId !== undefined && session.metadata?.adapterSessionId === event.sessionId;
      const finished = status === 'completed' || status === 'failed';
      if (ownSession && finished && !(num(event.data.queuedTurns) ?? 0) && session.metadata?.roundMode !== undefined) {
        const { roundMode: _done, ...rest } = session.metadata;
        session.metadata = rest;
      }
    }
    task.currentAgentId = event.agentId;
  }
  const action = str(event.data.action);

  // 正在工作的 agent（P0-7，時長預算只在有 agent 處於一輪之中時計時）：
  // 派發（發給 agent 的訊息）、會話啟動、進入工作狀態時加入；這一輪以終態結束、會話關閉、編排器判定派發失敗時移出
  const working = new Set(run.budget.workingAgentIds ?? []);
  if (event.agentId) {
    const status = typeof event.data.status === 'string' ? event.data.status : undefined;
    const starts =
      (event.type === 'agent.message' && event.data.direction === 'to-agent') ||
      event.type === 'agent.started' ||
      (event.type === 'agent.status' && status !== undefined && WORKING_STATUSES.has(status));
    if (starts && !options.fromCancelledSession) working.add(event.agentId);
    const ends =
      (event.type === 'agent.status' && status !== undefined && TURN_END_STATUSES.has(status)) ||
      event.data.sessionClosed === true ||
      (event.type === 'runtime.error' && !event.sessionId && DISPATCH_FAILURE_CODES.has(str(event.data.code) ?? '')) ||
      // 編排器確認這個 agent 在本程序裡已經沒有會話（殘留的“正在工作”，P0 第二批審查）：只認不帶會話身份的編排器事件
      (!event.sessionId && event.data.workEnded === true);
    if (ends) working.delete(event.agentId);
  }
  /** 進入 BLOCKED 之前正在工作的 agent（預算停止會打斷它們）。 */
  const workingBefore = [...working];

  // 一輪以終態結束（completed / failed / cancelled）：執行時已經收尾，它名下還掛著的“執行中”條目不再算狀態不明（P1-2）
  if (event.type === 'agent.status' && ['completed', 'failed', 'cancelled'].includes(String(event.data.status)) && event.agentId && run.inFlightSideEffects?.length) {
    run.inFlightSideEffects = run.inFlightSideEffects.filter((x) => x.agentId !== event.agentId);
  }
  // 任何 agent 做完一輪（包括測試執行器）：重啟之後確實接著做成了事，連續恢復計數清零（P1-14）
  if (event.type === 'agent.status' && event.data.status === 'completed' && run.recovery?.streak) run.recovery = { ...run.recovery, streak: 0 };

  if ((PROGRESS_EVENTS.has(event.type) && !readOnlyToolDone(event)) || event.data.progress === true) {
    run.progressSinceLastTurn = true;
    run.budget.stallCount = 0;
  }

  switch (event.type) {
    case 'agent.started': {
      // adapter 可能在 start() 返回前就開始流式發事件：以 agent.started 作為會話掛接點
      if (event.agentId && event.sessionId && !run.agentSessions[event.agentId]) {
        run.agentSessions[event.agentId] = {
          agentId: event.agentId,
          adapterType: str(event.data.adapterType) ?? 'unknown',
          status: 'starting',
          metadata: { adapterSessionId: event.sessionId },
        };
      }
      break;
    }

    case 'run.status': {
      const next = event.data.status;
      const previousStep = run.currentStep;
      if (typeof next === 'string' && setStatus(next as TaskStatus)) {
        const step = str(event.data.step);
        if (step) run.currentStep = step;
        // 進入等待操作員輸入：登記穩定的輸入請求身份
        const pendingInput = event.data.pendingInput as { id?: unknown; prompt?: unknown } | undefined;
        const inputId = str(pendingInput?.id);
        if (next === 'WAITING_INPUT' && inputId) {
          if (!run.pendingInputs.some((x) => x.id === inputId)) {
            run.pendingInputs.push({ id: inputId, agentId: event.agentId, prompt: str(pendingInput?.prompt) ?? 'Input required', createdAt: event.timestamp });
          }
          run.resumeCursor ??= { step: previousStep, reason: 'input' };
        }
        const resolvedInputId = str(event.data.resolvedInputId);
        if (resolvedInputId) {
          run.pendingInputs = run.pendingInputs.filter((x) => x.id !== resolvedInputId);
          if (run.resumeCursor?.reason === 'input') run.resumeCursor = undefined;
        }
      }
      break;
    }

    case 'agent.message': {
      const message = str(event.data.message);
      if (run.workflowState && event.agentId && message && event.data.direction !== 'to-agent') {
        run.workflowState.lastOutputs[event.agentId] = message.length > 4000 ? message.slice(-4000) : message;
        // 結構化的評審結果（P2-5）：這條回覆帶了就記下，沒帶就清掉（不能沿用上一輪的）
        const structured = event.data.structured as { kind?: unknown; verdict?: unknown; issues?: unknown } | undefined;
        const reviews = (run.workflowState.structuredReviews ??= {});
        if (structured?.kind === 'review' && (structured.verdict === 'ACCEPT' || structured.verdict === 'SUGGEST_CHANGES' || structured.verdict === 'BLOCKED')) {
          reviews[event.agentId] = { verdict: structured.verdict, issues: Array.isArray(structured.issues) ? structured.issues.length : 0 };
        } else {
          delete reviews[event.agentId];
        }
      }
      break;
    }

    case 'runtime.error': {
      const code = str(event.data.code);
      if (run.workflowState && event.agentId && code) {
        run.workflowState.lastError = {
          agentId: event.agentId,
          code,
          category: str(event.data.category) ?? 'unknown',
          retryable: event.data.retryable === true,
          confidence: event.confidence,
        };
      }
      break;
    }

    case 'approval.required': {
      const approvalId = str(event.data.approvalId) ?? event.id;
      if (isTerminal(run.status)) {
        // 終態之後才到的審批請求（H-5）：不再登記為待審批，直接按拒絕記錄；編排器隨後通知 adapter 並補一條 approval.resolved
        if (!run.pendingApprovals.some((x) => x.id === approvalId)) {
          const late: PendingApproval = {
            id: approvalId,
            agentId: event.agentId ?? 'unknown',
            sessionId: event.sessionId,
            providerCallId: str(event.data.providerCallId),
            summary: str(event.data.summary) ?? 'Approval required',
            payload: event.data,
            createdAt: event.timestamp,
            status: 'declined',
          };
          result.approvals.push({
            ...toApprovalRecord(run, late),
            decision: { decision: 'decline', resolvedBy: 'orchestrator', reason: 'run-terminal', runStatus: run.status },
            resolvedAt: event.timestamp,
          });
        }
        break;
      }
      if (!run.pendingApprovals.some((x) => x.id === approvalId)) {
        const pending: PendingApproval = {
          id: approvalId,
          agentId: event.agentId ?? 'unknown',
          sessionId: event.sessionId,
          providerCallId: str(event.data.providerCallId),
          summary: str(event.data.summary) ?? 'Approval required',
          payload: event.data,
          createdAt: event.timestamp,
          status: 'pending',
        };
        run.pendingApprovals.push(pending);
        result.approvals.push(toApprovalRecord(run, pending));
      }
      if (setStatus('WAITING_APPROVAL') && !run.resumeCursor) {
        // 記錄暫停時所在的邏輯步驟，審批通過後回到同一步驟
        run.resumeCursor = { step: run.currentStep, reason: 'approval', agentId: event.agentId, approvalId };
      }
      break;
    }

    case 'approval.resolved': {
      // 連續自動放行計數（P2-7）：策略放行 +1；人工處理（批准或拒絕）清零
      if (event.data.resolvedBy === 'policy') {
        const prev = run.autoApprovals ?? { consecutive: 0, total: 0 };
        run.autoApprovals = { consecutive: prev.consecutive + 1, total: prev.total + 1 };
      } else if (event.data.resolvedBy === 'operator' && run.autoApprovals?.consecutive) {
        run.autoApprovals = { ...run.autoApprovals, consecutive: 0 };
      }
      const approvalId = str(event.data.approvalId);
      const decision = event.data.decision === 'approve' ? 'approve' : 'decline';
      const pending = run.pendingApprovals.find((x) => x.id === approvalId);
      // 重複/過期的決定只記錄事件，不改變狀態（冪等）
      if (!pending || pending.status !== 'pending') break;

      run.pendingApprovals = run.pendingApprovals.filter((x) => x.id !== approvalId);
      const resolved: PendingApproval = { ...pending, status: decision === 'approve' ? 'approved' : 'declined' };
      result.approvals.push({
        ...toApprovalRecord(run, resolved),
        decision: { decision, resolvedBy: str(event.data.resolvedBy) ?? 'operator' },
        resolvedAt: event.timestamp,
      });

      const cursorStep = run.resumeCursor?.step;
      const isHandoffRequest = pending.payload?.kind === 'handoff';
      // 投遞狀態（P1-1）：操作員對工具審批的決定記進 outbox，直到確認交給了 agent（approval.delivered）
      if (!isHandoffRequest && event.data.resolvedBy === 'operator') {
        const request = pending.payload && pending.payload.fullInput !== undefined ? { ...pending.payload, toolInput: pending.payload.fullInput } : pending.payload;
        (run.undeliveredDecisions ??= []).push({
          approvalId: pending.id,
          agentId: pending.agentId,
          sessionId: pending.sessionId,
          decision,
          scope: event.data.scope === 'session' ? 'session' : event.data.scope === 'once' ? 'once' : undefined,
          providerCallId: pending.providerCallId,
          request,
          ...(event.data.answers && typeof event.data.answers === 'object' ? { answers: withoutSecretAnswers(event.data.answers as Record<string, string[]>) } : {}),
          resolvedAt: event.timestamp,
        });
      }
      // 編排器作廢的審批（P0 第三批審查：閘門重試之前，目標 agent 舊一輪的待審批一併作廢）：不是操作員的拒絕，不讓任務進入 BLOCKED。
      // 只認編排器自己發出的（adapter 不能發 approval.resolved）
      const withdrawn = event.data.withdrawn === true && event.data.resolvedBy === 'orchestrator';
      // 只有“因審批而暫停”（WAITING_APPROVAL）才允許由審批恢復為 RUNNING（M-5）。
      // 其他狀態下審批只處理這一個操作：BLOCKED 必須保持住（P0-2 審查，離開 BLOCKED 只能經人工閘門、換人接手或停止）；
      // 評審閘門（WAITING_INPUT）等待的是操作員的閘門決定，一次批准不能把它繞過去。
      const pausedForApproval = run.status === 'WAITING_APPROVAL';
      const releaseApprovalCursor = () => {
        if (run.pendingApprovals.length === 0 && run.resumeCursor?.reason === 'approval') run.resumeCursor = undefined;
      };
      if (decision === 'approve') {
        run.progressSinceLastTurn = true;
        run.budget.stallCount = 0;
      }
      if (run.status === 'BLOCKED') {
        releaseApprovalCursor();
      } else if (decision === 'decline' && !isHandoffRequest && !withdrawn) {
        // 拒絕一個操作：任務進入 BLOCKED，由操作員決定下一步（blockedBy 記錄是哪一條審批）
        run.resumeCursor = undefined;
        if (setStatus('BLOCKED')) run.currentStep = cursorStep ?? run.currentStep;
      } else if (run.pendingApprovals.length === 0 && pausedForApproval) {
        // 批准最後一條審批，或拒絕 agent 的交接請求（不交接即可）：回到暫停前的步驟繼續
        run.resumeCursor = undefined;
        if (setStatus('RUNNING')) run.currentStep = cursorStep ?? run.currentStep;
      } else {
        releaseApprovalCursor();
      }
      break;
    }

    case 'checkpoint.created': {
      const ref = str(event.data.ref);
      const seq = num(event.data.seq);
      if (ref && seq !== undefined) {
        const list = (run.checkpoints ??= []);
        list.push({
          seq,
          ref,
          agentId: str(event.data.agentId),
          label: str(event.data.label) ?? '',
          files: num(event.data.files) ?? 0,
          at: event.timestamp,
          ...(num(event.data.restoreOf) !== undefined ? { restoreOf: num(event.data.restoreOf) } : {}),
        });
        if (list.length > 100) list.splice(0, list.length - 100);
      }
      break;
    }

    case 'handoff.requested': {
      // 編排器執行的諮詢（P2-5；agent 自己發出的請求帶 origin=agent，不算）
      if (event.data.kind === 'consult' && event.data.origin !== 'agent' && str(event.data.contextRef) && str(event.data.fromAgentId) && str(event.data.toAgentId)) {
        const list = (run.pendingConsults ??= []);
        list.push({
          id: str(event.data.contextRef)!,
          fromAgentId: str(event.data.fromAgentId)!,
          toAgentId: str(event.data.toAgentId)!,
          question: String(event.data.instruction ?? '').slice(0, 2000),
          afterSequence: event.sequence,
          at: event.timestamp,
        });
        if (list.length > 20) list.splice(0, list.length - 20);
      }
      break;
    }

    case 'consult.answered': {
      if (run.pendingConsults) run.pendingConsults = run.pendingConsults.filter((c) => c.id !== event.data.consultId);
      break;
    }

    case 'workspace.merged': {
      const ws = run.workspace;
      if (ws) ws.merged = { at: event.timestamp, mode: event.data.mode === 'apply' ? 'apply' : 'merge', ...(str(event.data.commit) ? { commit: str(event.data.commit) } : {}) };
      break;
    }

    case 'workspace.cleaned': {
      if (run.workspace) run.workspace.cleanedAt = event.timestamp;
      break;
    }

    case 'approval.delivered': {
      const approvalId = str(event.data.approvalId);
      if (run.undeliveredDecisions?.length) run.undeliveredDecisions = run.undeliveredDecisions.filter((x) => x.approvalId !== approvalId);
      break;
    }

    case 'tool.started': {
      // 執行中台賬（P1-2）：有結果之前一直記著，崩潰恢復時據此判斷“可能執行了一半”
      const id = str(event.data.toolCallId) ?? str(event.data.providerCallId);
      if (id && !run.completedSideEffects.some((x) => x.id === id)) {
        const list = (run.inFlightSideEffects ??= []);
        if (!list.some((x) => x.id === id)) {
          list.push({ id, agentId: event.agentId, name: str(event.data.toolName), summary: inputSummary(event.data.toolInput), startedAt: event.timestamp });
          // 有上限：只保留最近的 50 個（正常情況下同時執行中的呼叫只有一兩個）
          if (list.length > 50) list.splice(0, list.length - 50);
        }
      }
      break;
    }

    case 'tool.failed':
      removeInFlight(run, event);
      // 失敗但確實執行過的工具（例如非零退出碼的命令）同樣可能產生了副作用
      if (event.data.executed !== true) break;
    // falls through
    case 'tool.completed': {
      removeInFlight(run, event);
      const id = sideEffectId(event);
      if (!run.completedSideEffects.some((x) => x.id === id)) {
        run.sideEffectCount = (run.sideEffectCount ?? run.completedSideEffects.length) + 1;
        run.completedSideEffects.push({
          id,
          agentId: event.agentId,
          name: str(event.data.toolName),
          eventId: event.id,
          completedAt: event.timestamp,
        });
        // 有上限（P2-10 / L-5）：快照每個事件都整份寫一次，台賬不能無限增長；完整台賬在事件日誌裡
        if (run.completedSideEffects.length > MAX_SNAPSHOT_SIDE_EFFECTS) run.completedSideEffects.splice(0, run.completedSideEffects.length - MAX_SNAPSHOT_SIDE_EFFECTS);
      }
      break;
    }

    case 'model.turn.completed': {
      run.budget.turnsUsed += 1;
      // 做完了一輪：重啟之後確實接著做成了事，連續恢復計數清零（P1-14）
      if (run.recovery?.streak) run.recovery = { ...run.recovery, streak: 0 };
      if (run.progressSinceLastTurn) {
        run.budget.stallCount = 0;
      } else {
        run.budget.stallCount += 1;
      }
      run.progressSinceLastTurn = false;

      const usage = event.data.usage;
      if (usage && typeof usage === 'object') {
        const turn = turnUsage(run, event.sessionId, usage as Record<string, unknown>);
        if (turn) {
          run.budget.estimatedTokensUsed += (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0);
          if (turn.costUsd !== undefined) run.budget.costUsdUsed = (run.budget.costUsdUsed ?? 0) + turn.costUsd;
          result.usage.push({ id: event.id, runId: run.runId, agentId: event.agentId, ...turn, createdAt: event.timestamp });
        }
      }
      break;
    }

    case 'safety.blocked':
    case 'budget.exceeded':
    case 'budget.stalled': {
      // 等待人工（審批 / 評審閘門）期間停下仍在工作的 agent（P0 第二批審查）：只記錄原因，不改變等待狀態、不作廢待審批項
      if (event.type !== 'safety.blocked' && event.data.whileWaiting === true && !event.sessionId) break;
      const wasStatus = run.status;
      if (setStatus('BLOCKED')) {
        const step = str(event.data.step);
        if (step) run.currentStep = step;
        // 預算阻塞（P0-7）：記下被這次預算停止打斷的 agent，放寬預算並繼續時讓它們從中斷的地方接著做。
        // 只有真正會停止 agent 的預算事件（data.stopsAgents，執行中超限）才算；派發前拒絕不停止任何 agent，正在進行的一輪照常做完
        if (event.type !== 'safety.blocked' && event.data.stopsAgents === true && wasStatus !== 'BLOCKED' && run.blockedBy && workingBefore.length > 0) {
          run.blockedBy.interruptedAgentIds = workingBefore;
        }
      }
      break;
    }

    case 'budget.extended': {
      // 預算調整（P0-7）：changes 裡是新的限額，renew 表示開一個新的計數視窗（停滯計數同時清零）。
      // 只接受編排器自己發出的（不帶 agent / 會話身份）：agent 不能給自己加預算
      if (event.agentId || event.sessionId) break;
      const changes = event.data.changes;
      if (changes && typeof changes === 'object') {
        for (const limit of BUDGET_LIMITS) {
          const change = (changes as Record<string, unknown>)[limit];
          const to = change && typeof change === 'object' ? num((change as { to?: unknown }).to) : undefined;
          if (to !== undefined) (run.budget as TaskBudget)[limit] = to;
        }
      }
      if (event.data.renew === true) renewBudgetWindow(run.budget, now, str(event.data.reason));
      else if (event.data.resetStall === true) run.budget.stallCount = 0;
      break;
    }

    case 'run.completed':
      // 操作員「接受結果」直接完成（P0-7 / H-7）：可以從評審閘門（WAITING_INPUT）或 BLOCKED 直接進入 COMPLETED，不經過 RUNNING
      // （只認編排器自己發出的：不帶 agent / 會話身份）
      setStatus('COMPLETED', event.data.acceptedBy === 'operator' && !event.agentId && !event.sessionId && canAcceptResult(run.status));
      break;

    case 'run.failed':
      setStatus('FAILED');
      break;

    default:
      break;
  }

  // run 進入終態（H-5）：同一次投影裡作廢全部待審批（不會再執行，也不能再批准），待輸入與暫停遊標一併清空
  if (isTerminal(run.status) && (run.pendingApprovals.length > 0 || run.pendingInputs.length > 0 || run.resumeCursor)) {
    for (const approval of run.pendingApprovals) {
      result.approvals.push({
        ...toApprovalRecord(run, { ...approval, status: 'voided' }),
        decision: { decision: 'void', resolvedBy: 'orchestrator', reason: 'run-terminal', runStatus: run.status },
        resolvedAt: event.timestamp,
      });
    }
    run.pendingApprovals = [];
    run.pendingInputs = [];
    run.resumeCursor = undefined;
  }

  // 有效工作時長（P0-7，P0 第二批審查修正）：只要有 agent 正在工作、並且沒有卡在工具審批上就計時——與 run 的狀態無關：
  // 等待審批時仍在工作的 agent（request_handoff 之後繼續這一輪、Ask Both 的另一個）、評審閘門期間被問的 agent 同樣計時；
  // 真正卡在審批上的 agent、對話空閒、終態都不計時
  run.budget.workingAgentIds = isTerminal(run.status) ? [] : [...working];
  const clockRunning = !isTerminal(run.status) && activeWorkingAgents(run).length > 0;
  syncActiveClock(run.budget, clockRunning, now);

  // 當前動作：BLOCKED 期間（事件前後都是 BLOCKED）只接受能說明阻塞原因的事件，避免原因被 agent 的普通事件覆蓋
  const stillBlocked = wasBlocked && run.status === 'BLOCKED';
  if (action && event.data.direction !== 'to-agent' && (!stillBlocked || BLOCK_REASON_EVENTS.has(event.type))) task.currentAction = action;

  return result;
}

/** 觸發進入 BLOCKED 的事件 → 阻塞原因。 */
function blockedByOf(event: UnifiedEvent): BlockedBy {
  const base = { eventId: event.id, at: event.timestamp, ...(event.agentId ? { agentId: event.agentId } : {}) };
  const data = event.data;
  switch (event.type) {
    case 'safety.blocked':
      return { source: 'safety', code: str(data.code) ?? 'SAFETY_BLOCKED', ...base };
    case 'budget.exceeded':
    case 'budget.stalled':
      return { source: 'budget', code: str(data.limit) ?? (event.type === 'budget.stalled' ? 'maxStallCount' : 'BUDGET_EXCEEDED'), ...base };
    case 'approval.resolved':
      return { source: 'approval', code: 'APPROVAL_DECLINED', ...(str(data.approvalId) ? { approvalId: str(data.approvalId) } : {}), ...base };
    case 'run.status': {
      // 編排器 fail closed 的遷移步驟為 blocked:<code>，工作流規則的阻塞為 workflow:<code>
      const step = str(data.step) ?? '';
      const workflow = step.startsWith('workflow:');
      const fromStep = step.startsWith('blocked:') ? step.slice('blocked:'.length) : workflow ? step.slice('workflow:'.length) : undefined;
      return { source: workflow ? 'workflow' : 'runtime', code: str(data.code) ?? (fromStep || 'BLOCKED'), ...base };
    }
    default:
      return { source: 'runtime', code: str(data.code) ?? event.type, ...base };
  }
}

function toApprovalRecord(run: RunSnapshot, approval: PendingApproval): ApprovalRecord {
  return {
    id: approval.id,
    runId: run.runId,
    taskId: run.taskId,
    agentId: approval.agentId,
    sessionId: approval.sessionId,
    providerCallId: approval.providerCallId,
    status: approval.status,
    request: { summary: approval.summary, ...(approval.payload ?? {}) },
    createdAt: approval.createdAt,
  };
}

/** 快照裡保留的已完成副作用條數（P2-10 / L-5）。 */
export const MAX_SNAPSHOT_SIDE_EFFECTS = 200;

/** 一個完成（或執行過的失敗）工具事件對應的副作用 ID。 */
function sideEffectId(event: UnifiedEvent): string {
  return str(event.data.toolCallId) ?? str(event.data.providerCallId) ?? event.id;
}

/**
 * 從事件日誌重建完整的已完成副作用 ID 列表（P2-10）：與投影規則一致——tool.completed，以及 executed=true 的 tool.failed；
 * 按首次完成的順序、去重。續跑時交給 adapter，確保已完成的呼叫不重放。
 */
export function completedSideEffectIdsFromEvents(events: readonly UnifiedEvent[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool.completed' && !(event.type === 'tool.failed' && event.data.executed === true)) continue;
    const id = sideEffectId(event);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 補投用的答案（P2-6）：機密問題的答案沒有記錄（佔位），不交給 agent。 */
function withoutSecretAnswers(answers: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(answers).filter(([, list]) => !(Array.isArray(list) && list[0] === '[機密，未記錄]')));
}
