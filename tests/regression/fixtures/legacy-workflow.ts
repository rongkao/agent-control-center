/**
 * P2-11 之前手寫的 implementation-v1（原樣保留，只改了 import）：用來和資料化之後的實現逐步比較，證明行為不變。
 */
import { parseReviewVerdict, type ContextPurpose } from '@acc/core';
import type { AgentMode, NextAction, NormalizedError, WorkflowState, WorkflowStep } from '@acc/core';

/**
 * implementation-v1 確定性工作流（P2.1）+ 評審管理（P2.3）。
 *
 *   implement → test ─ pass ─────────────────────────────┐
 *                 └ fail → retry(最多 1 次) → test         │
 *                            └ fail → rescue(Codex 唯讀診斷) → fix → test
 *                                                   └ fail → BLOCKED（人工閘門）
 *   通過後：reviewGate ? 等待操作員（接受 / 請求評審 / 帶說明重試） : 完成
 *   評審：ACCEPT → final-test → 完成；SUGGEST_CHANGES → review-fix → final-test → 完成；
 *         BLOCKED/無法解析 → 回到人工閘門。不會自動發起第二輪評審。
 *   不活動看門狗（P0-6）：正在等待的 agent 超過閾值沒有任何動靜 → 重新接上會話重試（與傳輸重試共用 1 次額度）
 *         → 實現類步驟請評審 agent 唯讀診斷（rescue）→ 帶原因的 BLOCKED（STEP_INACTIVE）。
 *
 *   等待審批期間到達的完成 / 失敗訊號由編排器快取（WorkflowState.deferredSignal），回到 RUNNING 後重放（H-9）；
 *   任何一次決策都會清掉它。
 *
 * 純函式：輸入當前狀態和訊號，輸出新狀態與唯一的下一步指令。不做 IO。
 */

export type WorkflowSignal =
  | { kind: 'agent-completed'; agentId: string; data: Record<string, unknown> }
  | { kind: 'agent-failed'; agentId: string; data: Record<string, unknown> }
  /** 不活動看門狗（P0-6）：正在等待的 agent 在這一步裡超過閾值沒有任何動靜。 */
  | { kind: 'agent-inactive'; agentId: string; idleMs: number }
  /**
   * 人工閘門。rerun（P0 第二批審查）：把阻塞的這一步交還給負責它的 agent 重做（例如 Codex 診斷時登入失效，重新登入後再請它診斷），
   * 而不是像 retry 那樣總是交給實現者。
   * confirm-tests（P0-8 / H-15）：操作員確認了測試配置的改動——當前配置成為新的基線，執行這一步的測試。
   * 編排器在呼叫之前已經核對過“操作員確認的就是現在的配置”。
   */
  | { kind: 'gate'; action: 'accept' | 'review' | 'retry' | 'rerun' | 'confirm-tests'; note?: string };

export type WorkflowDirective =
  | { type: 'dispatch'; step: WorkflowStep; agentId: string; mode: AgentMode; purpose: ContextPurpose; handoffFrom?: string; note?: string; action: NextAction }
  | { type: 'wait-input'; step: 'review-gate'; inputId: string; prompt: string; action: NextAction }
  | { type: 'complete'; reason: string; action: NextAction }
  | { type: 'block'; code: string; reason: string; action: NextAction }
  | { type: 'ignore'; reason: string };

export interface InitWorkflowInput {
  implementAgentId: string;
  reviewAgentId?: string;
  testAgentId?: string;
  testCommand?: string;
  reviewGate?: boolean;
  cwd?: string;
}

export interface DecideContext {
  now: number;
  /** 是否還有評審輪次預算（maxReviewRounds）。 */
  canReview: boolean;
}

export const REVIEW_GATE_INPUT_ID = 'review-gate';
/** 看門狗在重試和 rescue 都沒有讓步驟恢復之後進入 BLOCKED 時的阻塞程式碼（P0-6）。 */
export const STEP_INACTIVE = 'STEP_INACTIVE';
const MAX_RETRIES = 1;
const MAX_TRANSPORT_RETRIES = 1;
const OUTPUT_TAIL = 4000;
/** 實現類步驟：由實現者負責、卡住時可以請評審 agent 唯讀診斷（rescue）。 */
const IMPLEMENTING_STEPS: ReadonlySet<WorkflowStep> = new Set(['implement', 'retry', 'fix', 'review-fix']);

export function initWorkflow(input: InitWorkflowInput): WorkflowState {
  return {
    definition: 'implementation-v1',
    step: 'implement',
    stepSeq: 0,
    // 編排器總會傳入按能力選出的 agent（P1-17）；這裡的預設只是兜底，不寫死 provider
    agents: { implement: input.implementAgentId, review: input.reviewAgentId ?? input.implementAgentId, test: input.testAgentId ?? 'test' },
    cwd: input.cwd,
    testCommand: input.testCommand?.trim() || undefined,
    reviewGate: input.reviewGate === true,
    retriesUsed: 0,
    transportRetriesUsed: 0,
    rescueUsed: false,
    lastOutputs: {},
    handoffs: [],
    history: [],
  };
}

/**
 * 放寬預算後繼續（P0-7）：工作流當時正在等某個 agent 完成當前步驟（例如它被預算停止打斷了，或者派發前就因為預算被拒絕），
 * 就讓它在同一步接著做（新的 stepSeq，之前那一輪遲到的訊號不再算數）。沒有正在等待的 agent 時返回 undefined，由操作員走閘門。
 */
export function resumeStep(current: WorkflowState, now: number): { state: WorkflowState; directive: WorkflowDirective } | undefined {
  const agentId = current.awaitingAgentId;
  if (!agentId || current.step === 'done' || current.step === 'review-gate') return undefined;
  const state = structuredClone(current);
  delete state.deferredSignal;
  // 操作員的決定重新開始一段工作：自動重試的額度重新給一次（與人工閘門一致）
  state.transportRetriesUsed = 0;
  state.history.push({ step: state.step, agentId, outcome: 'budget raised by operator; continuing', at: now });
  return { state, directive: dispatch(state, state.step, agentId, modeOf(state, state.step), 'budget-resume') };
}

/** 工作流的第一條指令（任務建立時）。 */
export function firstDirective(state: WorkflowState): { state: WorkflowState; directive: WorkflowDirective } {
  const next = structuredClone(state);
  return { state: next, directive: dispatch(next, 'implement', next.agents.implement, 'implement', 'implement') };
}

export function decide(current: WorkflowState, signal: WorkflowSignal, ctx: DecideContext): { state: WorkflowState; directive: WorkflowDirective } {
  const state = structuredClone(current);
  // 任何決策都消費掉等待審批期間快取的訊號（H-9）：要麼正是在重放它，要麼步驟已經由別的原因推進了
  delete state.deferredSignal;
  const record = (outcome: string, agentId?: string) => state.history.push({ step: state.step, agentId, outcome, at: ctx.now });

  if (signal.kind === 'gate') return decideGate(state, signal, ctx, record);

  if (state.awaitingAgentId !== signal.agentId) {
    return { state: current, directive: { type: 'ignore', reason: `not awaiting ${signal.agentId}` } };
  }
  state.awaitingAgentId = undefined;

  if (signal.kind === 'agent-inactive') return decideInactive(state, signal, record);

  if (signal.kind === 'agent-failed') {
    const error = state.lastError?.agentId === signal.agentId ? state.lastError : undefined;
    if (error?.retryable && state.transportRetriesUsed < MAX_TRANSPORT_RETRIES) {
      state.transportRetriesUsed += 1;
      record(`transient failure (${error.code}); retrying`, signal.agentId);
      return { state, directive: dispatch(state, state.step, signal.agentId, modeOf(state, state.step), 'continue') };
    }
    record(`agent failed${error ? ` (${error.code})` : ''}`, signal.agentId);
    return { state, directive: block(state, 'AGENT_FAILED', `${signal.agentId} failed in step ${state.step}${error ? `: ${error.code}` : ''}`) };
  }

  // 成功完成：一次成功的 agent 呼叫後重置傳輸重試計數
  state.transportRetriesUsed = 0;
  switch (state.step) {
    case 'implement':
    case 'retry':
    case 'fix': {
      record('implementation turn completed', signal.agentId);
      return { state, directive: state.testCommand ? dispatch(state, 'test', state.agents.test, 'test', 'test', signal.agentId) : afterPass(state) };
    }
    case 'review-fix': {
      record('review changes applied', signal.agentId);
      return { state, directive: state.testCommand ? dispatch(state, 'final-test', state.agents.test, 'test', 'test', signal.agentId) : complete(state, 'Review changes applied') };
    }
    case 'test':
    case 'final-test': {
      const passed = signal.data.testPassed === true; // 缺失結果視為失敗（fail closed）
      const exitCode = typeof signal.data.exitCode === 'number' ? signal.data.exitCode : null;
      const outputTail = typeof signal.data.outputTail === 'string' ? signal.data.outputTail.slice(-OUTPUT_TAIL) : '';
      state.lastTest = { passed, exitCode, outputTail, at: ctx.now };
      record(passed ? 'tests passed' : `tests failed (exit ${exitCode ?? 'n/a'})`, signal.agentId);

      if (state.step === 'final-test') {
        return { state, directive: passed ? complete(state, 'Final test passed') : block(state, 'FINAL_TEST_FAILED', 'Final test failed after review changes') };
      }
      if (passed) return { state, directive: afterPass(state) };
      if (state.retriesUsed < MAX_RETRIES) {
        state.retriesUsed += 1;
        return { state, directive: dispatch(state, 'retry', state.agents.implement, 'implement', 'retry', signal.agentId) };
      }
      if (!state.rescueUsed) {
        state.rescueUsed = true;
        return { state, directive: dispatch(state, 'rescue', state.agents.review, 'rescue', 'rescue', state.agents.implement) };
      }
      return { state, directive: block(state, 'TESTS_FAILED', 'Tests still failing after retry and rescue; operator decision required') };
    }
    case 'rescue': {
      record('diagnosis delivered', signal.agentId);
      return { state, directive: dispatch(state, 'fix', state.agents.implement, 'implement', 'fix', signal.agentId) };
    }
    case 'review': {
      const summary = state.lastOutputs[signal.agentId] ?? '';
      const verdict = parseReviewVerdict(summary);
      state.review = { verdict, confidence: 'inferred', agentId: signal.agentId, summary: summary.slice(-OUTPUT_TAIL) };
      record(`review verdict ${verdict}`, signal.agentId);
      if (verdict === 'ACCEPT') {
        return { state, directive: state.testCommand ? dispatch(state, 'final-test', state.agents.test, 'test', 'test', signal.agentId) : complete(state, 'Review accepted') };
      }
      if (verdict === 'SUGGEST_CHANGES') {
        return { state, directive: dispatch(state, 'review-fix', state.agents.implement, 'implement', 'review-fix', signal.agentId) };
      }
      return { state, directive: waitGate(state, `Review verdict ${verdict}. Accept, retry with instructions, or cancel.`) };
    }
    default:
      return { state: current, directive: { type: 'ignore', reason: `no transition from ${state.step}` } };
  }
}

/**
 * 不活動看門狗（P0-6）：重試 → rescue → 帶原因的 BLOCKED。
 * - 還有傳輸重試額度：重新接上同一個 agent 的會話，在同一步繼續（與傳輸類錯誤共用一次重試額度，成功完成後重置）；
 * - 實現類步驟、rescue 還沒用過、評審 agent 不是同一個：請評審 agent 以唯讀方式診斷，之後照常由實現者按診斷修復；
 * - 否則進入 BLOCKED，交給操作員（重試、換人接手或停止）。
 */
function decideInactive(
  state: WorkflowState,
  signal: Extract<WorkflowSignal, { kind: 'agent-inactive' }>,
  record: (outcome: string, agentId?: string) => void,
): { state: WorkflowState; directive: WorkflowDirective } {
  const idle = formatMinutes(signal.idleMs);
  if (state.transportRetriesUsed < MAX_TRANSPORT_RETRIES) {
    state.transportRetriesUsed += 1;
    record(`no activity for ${idle}; restarting ${signal.agentId}`, signal.agentId);
    return { state, directive: dispatch(state, state.step, signal.agentId, modeOf(state, state.step), 'stalled') };
  }
  if (!state.rescueUsed && IMPLEMENTING_STEPS.has(state.step) && state.agents.review !== signal.agentId) {
    state.rescueUsed = true;
    record(`no activity for ${idle} again; asking ${state.agents.review} to diagnose`, signal.agentId);
    return { state, directive: dispatch(state, 'rescue', state.agents.review, 'rescue', 'rescue-stalled', signal.agentId) };
  }
  record(`no activity for ${idle}; blocked`, signal.agentId);
  return { state, directive: block(state, STEP_INACTIVE, `${signal.agentId} produced no activity for ${idle} in step ${state.step}`, 'runtime') };
}

/** 毫秒 → “N min”（最多一位小數）；不到一分鐘時用秒。 */
function formatMinutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round((ms / 60_000) * 10) / 10} min`;
}

function decideGate(
  state: WorkflowState,
  signal: Extract<WorkflowSignal, { kind: 'gate' }>,
  ctx: DecideContext,
  record: (outcome: string, agentId?: string) => void,
): { state: WorkflowState; directive: WorkflowDirective } {
  state.awaitingAgentId = undefined;
  // 操作員的決定重新開始一段工作：自動重試的額度（傳輸錯誤 / 看門狗共用）重新給一次
  state.transportRetriesUsed = 0;
  record(`operator: ${signal.action}${signal.note ? ` (${signal.note.slice(0, 80)})` : ''}`);
  if (signal.action === 'confirm-tests') {
    // 確認測試配置的改動（H-15）：確認的配置成為新的基線，然後執行這一步的測試
    const review = state.testConfigReview;
    if (!review || (state.step !== 'test' && state.step !== 'final-test')) throw new Error('No test configuration change is waiting for confirmation');
    state.testConfigBaseline = review.fingerprint;
    // 操作員確認過的配置：同一目錄的後續任務以它為基線（P0 第三批審查）
    state.testConfigTrustedAt = ctx.now;
    delete state.testConfigStartDigest;
    delete state.testConfigReview;
    return { state, directive: dispatch(state, state.step, state.agents.test, 'test', 'test') };
  }
  // 其餘決定（接受、評審、帶說明重試、重跑）讓待確認的測試配置改動失效：之後再走到測試步驟時按基線重新比較
  delete state.testConfigReview;
  switch (signal.action) {
    case 'accept':
      return { state, directive: complete(state, 'Accepted by operator') };
    case 'review':
      if (!ctx.canReview) {
        throw new Error('Review round limit reached (maxReviewRounds); automatic review loops are not allowed');
      }
      return { state, directive: dispatch(state, 'review', state.agents.review, 'review', 'review', state.agents.implement) };
    case 'retry':
      return { state, directive: dispatch(state, 'retry', state.agents.implement, 'implement', 'operator-retry', undefined, signal.note) };
    case 'rerun': {
      const step = state.step;
      const agentId = stepAgent(state, step);
      if (!agentId) throw new Error(`No step to rerun in ${step}; use retry, review or accept`);
      return { state, directive: dispatch(state, step, agentId, stepMode(step), rerunPurpose(state, step), undefined, signal.note) };
    }
  }
}

/** 負責這一步的 agent（rerun 用）；閘門、完成等沒有負責 agent 的步驟返回 undefined。 */
export function stepAgent(state: Pick<WorkflowState, 'agents'>, step: WorkflowStep): string | undefined {
  if (IMPLEMENTING_STEPS.has(step)) return state.agents.implement;
  if (step === 'test' || step === 'final-test') return state.agents.test;
  if (step === 'rescue' || step === 'review') return state.agents.review;
  return undefined;
}

/** 重做這一步時交給 agent 的上下文用途：診斷 / 評審沿用原來的唯讀說明，實現類步驟按操作員的說明繼續。 */
function rerunPurpose(state: WorkflowState, step: WorkflowStep): ContextPurpose {
  if (step === 'rescue') return state.lastTest && !state.lastTest.passed ? 'rescue' : 'rescue-stalled';
  if (step === 'review') return 'review';
  if (step === 'test' || step === 'final-test') return 'test';
  return 'operator-retry';
}

function modeOf(_state: WorkflowState, step: WorkflowStep): AgentMode {
  return stepMode(step);
}

/** 工作流步驟要求的 agent 模式：評審 / 診斷步驟唯讀，測試步驟只跑命令，其餘是實現。 */
export function stepMode(step: WorkflowStep): AgentMode {
  if (step === 'test' || step === 'final-test') return 'test';
  if (step === 'rescue') return 'rescue';
  if (step === 'review') return 'review';
  return 'implement';
}

function dispatch(
  state: WorkflowState,
  step: WorkflowStep,
  agentId: string,
  mode: AgentMode,
  purpose: ContextPurpose,
  handoffFrom?: string,
  note?: string,
): WorkflowDirective {
  state.step = step;
  state.stepSeq += 1;
  state.awaitingAgentId = agentId;
  const handoff = handoffFrom && handoffFrom !== agentId ? handoffFrom : undefined;
  const action: NextAction = handoff
    ? { type: 'HANDOFF', fromAgentId: handoff, toAgentId: agentId, contextRef: `${step}#${state.stepSeq}`, reason: purpose }
    : { type: 'CONTINUE', agentId };
  return { type: 'dispatch', step, agentId, mode, purpose, handoffFrom: handoff, note, action };
}

function afterPass(state: WorkflowState): WorkflowDirective {
  return state.reviewGate ? waitGate(state, 'Tests passed. Accept the result or request a review.') : complete(state, state.testCommand ? 'Tests passed' : 'Implementation completed');
}

function waitGate(state: WorkflowState, prompt: string): WorkflowDirective {
  state.step = 'review-gate';
  state.stepSeq += 1;
  state.awaitingAgentId = undefined;
  return { type: 'wait-input', step: 'review-gate', inputId: REVIEW_GATE_INPUT_ID, prompt, action: { type: 'WAIT_INPUT', requestId: REVIEW_GATE_INPUT_ID, prompt } };
}

function complete(state: WorkflowState, reason: string): WorkflowDirective {
  state.step = 'done';
  state.stepSeq += 1;
  state.awaitingAgentId = undefined;
  return { type: 'complete', reason, action: { type: 'FINAL', resultRef: `history#${state.history.length}` } };
}

function block(state: WorkflowState, code: string, reason: string, category: NormalizedError['category'] = code === 'AGENT_FAILED' ? 'runtime' : 'tool'): WorkflowDirective {
  state.awaitingAgentId = undefined;
  return {
    type: 'block',
    code,
    reason,
    action: { type: 'FAIL', error: { code, message: reason, category, retryable: false, confidence: 'confirmed' } },
  };
}
