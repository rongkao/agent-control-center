import { dataBlockNotice, dataBoundary, neutralizeReservedLines, renderDataBlock } from './data-block.js';
import type { WorkflowState, WorkflowStep } from './types.js';

/**
 * 上下文管理器（P2.2）。
 *
 * 構造跨 agent 交接的上下文信封：任務摘要 + 本步驟目標 + 精選結果（最近測試輸出、相關 agent 的最近輸出）+ 約束。
 * 預設不轉發完整對話或整個倉庫，只帶下一步真正需要的資訊。
 *
 * P0-9 / H-13：其他 agent 的輸出和測試輸出可能被注入過，一律放進帶唯一邊界的資料區塊（見 data-block.ts），
 * 並在“相關結果”開頭宣告區塊內是資料、不是指令；信封自己的章節標題（本步目標、約束等）只出現在區塊之外、只出現一次。
 * 操作員說明屬於指令，放在區塊之外，但其中看起來像信封標題的行會被轉義。
 */
export type ContextPurpose =
  | 'implement'
  | 'retry'
  | 'rescue'
  | 'fix'
  | 'review'
  | 'review-fix'
  | 'operator-retry'
  | 'continue'
  | 'reassign'
  | 'test'
  /** 看門狗：這一步長時間沒有任何動靜，會話已重新接上（P0-6）。 */
  | 'stalled'
  /** 看門狗：重新接上之後仍然沒有動靜，請另一個 agent 唯讀診斷（P0-6）。 */
  | 'rescue-stalled'
  /** 這一步因為預算用完被停下，操作員放寬預算後讓同一個 agent 接著做（P0-7）。 */
  | 'budget-resume';

export interface ContextEnvelope {
  purpose: ContextPurpose;
  step: WorkflowStep;
  text: string;
  /** 引用了哪些來源（用於追蹤/展示）。 */
  sources: string[];
}

const LIMIT = 3000;
const clip = (text: string, max = LIMIT) => (text.length > max ? `…${text.slice(-max)}` : text);

const INSTRUCTIONS: Record<ContextPurpose, string> = {
  implement: 'Implement the task in the workspace. Keep changes focused and runnable.',
  retry: 'The test run after your change FAILED. Fix the failures shown below, then stop.',
  rescue:
    'Two implementation attempts failed the tests. Diagnose the ROOT CAUSE. Do NOT modify any files. Reply with the root cause and a concrete, minimal fix plan.',
  fix: 'Apply the fix plan from the independent diagnosis below. Keep changes minimal, then stop.',
  review:
    'Review the current changes in the workspace for correctness, safety and test coverage. Do NOT modify any files. End your reply with exactly one line: "VERDICT: ACCEPT", "VERDICT: SUGGEST_CHANGES" or "VERDICT: BLOCKED".',
  'review-fix': 'Address the reviewer\'s suggested changes below, then stop.',
  'operator-retry': 'The operator asked you to continue with the instruction below.',
  continue: 'The previous turn ended because of a transient runtime error. Continue the task from where you stopped.',
  reassign: 'The operator reassigned this task to you. Review the current state of the workspace and the previous agent\'s latest output below, then continue and finish the task.',
  test: 'Run the configured test command.',
  stalled:
    'Your previous turn in this step stopped responding (no activity for a long time), so the orchestrator restarted your session. Check the current state of the workspace, then continue the step from where you stopped.',
  'rescue-stalled':
    'The implementing agent stopped responding in this step, even after its session was restarted. Inspect the workspace read-only. Do NOT modify any files. Describe what has been done, what is left, any likely reason it got stuck, and a concrete plan to finish the step.',
  'budget-resume':
    'Your previous turn in this step was stopped because the task reached its budget limit. The operator has raised the budget. Check the current state of the workspace, then continue the step from where you stopped.',
};

export interface BuildContextInput {
  task: { title: string; prompt: string };
  state: WorkflowState;
  purpose: ContextPurpose;
  /** 操作員補充說明（人工閘門 retry、換人接手時）。只放操作員自己寫的話，其他 agent 的輸出不能混進來。 */
  note?: string;
  /** 交接來源（換人接手時是原來的實現者）：purpose 為 reassign 時帶上它的最近輸出（放在資料區塊裡）。 */
  handoffFrom?: string;
  /**
   * 已經批准、併入這一步的交接請求（P0 第三批審查，見 WorkflowState.pendingHandoffs）：請求裡的要求和轉交內容都是 agent 寫的，
   * 一律放在資料區塊裡（不進指令區）。
   */
  forwarded?: Array<{ fromAgentId: string; instruction: string; content: string }>;
}

export function buildContextEnvelope(input: BuildContextInput): ContextEnvelope {
  const { task, state, purpose, note } = input;
  const sources: string[] = ['task'];
  const sections: string[] = [`# Task\n${task.title}\n\n${task.prompt}`, `# Your goal in this step\n${INSTRUCTIONS[purpose]}`];

  /** 要放進資料區塊的內容（測試輸出、其他 agent 的輸出）：先收集，整條信封共用一個隨機邊界。 */
  const quoted: Array<{ title: string; source: string; text: string }> = [];
  const includeTest = purpose === 'retry' || purpose === 'rescue' || purpose === 'fix' || purpose === 'operator-retry' || purpose === 'reassign';
  if (includeTest && state.lastTest) {
    quoted.push({
      title: `## Latest test run: ${state.lastTest.passed ? 'PASSED' : 'FAILED'} (exit ${state.lastTest.exitCode ?? 'n/a'})`,
      source: 'test output',
      text: clip(state.lastTest.outputTail),
    });
    sources.push('test');
  }
  // 交接時只帶“對方”的最近輸出：修復用診斷、修評審意見用評審結論、診斷用實現者的最近說明、換人接手用原實現者的最近輸出
  const fromAgent =
    purpose === 'fix' || purpose === 'review-fix'
      ? state.agents.review
      : purpose === 'rescue' || purpose === 'rescue-stalled' || purpose === 'review'
        ? state.agents.implement
        : purpose === 'reassign'
          ? input.handoffFrom
          : undefined;
  const fromOutput = fromAgent ? state.lastOutputs[fromAgent] : undefined;
  if (fromAgent && fromOutput) {
    quoted.push({ title: `## Latest output from ${fromAgent}`, source: `from ${fromAgent}`, text: clip(fromOutput) });
    sources.push(`agent:${fromAgent}`);
  }
  // 併入這一步的交接請求：要求和內容都是 agent 寫的，屬於資料
  for (const item of input.forwarded ?? []) {
    const text = [item.instruction.trim(), item.content.trim()].filter(Boolean).join('\n\n');
    quoted.push({ title: `## Handoff request from ${item.fromAgentId} (approved by the operator; its request and content are quoted below)`, source: `from ${item.fromAgentId}`, text: clip(text) });
    sources.push(`handoff:${item.fromAgentId}`);
  }

  const results: string[] = [];
  const boundary = quoted.length > 0 ? dataBoundary(quoted.map((item) => item.text)) : undefined;
  if (boundary) results.push(dataBlockNotice(boundary));
  if (note) {
    // 操作員說明是指令（在區塊之外）；其中看起來像信封標題的行轉義，信封自己的標題只出現一次
    results.push(`## Operator instruction\n${neutralizeReservedLines(note)}`);
    sources.push('operator');
  }
  if (boundary) for (const item of quoted) results.push(`${item.title}\n${renderDataBlock(boundary, item.source, item.text)}`);
  if (results.length) sections.push(`# Relevant results\n${results.join('\n\n')}`);

  const constraints = ['Work only inside the task workspace.', 'Do not repeat tool calls that already completed successfully.'];
  // 在唯讀步驟（評審 / 診斷）裡接著做（看門狗重啟、放寬預算後繼續）同樣是唯讀的
  const continuingReadOnlyStep = (purpose === 'stalled' || purpose === 'budget-resume') && (state.step === 'review' || state.step === 'rescue');
  const readOnly = purpose === 'rescue' || purpose === 'rescue-stalled' || purpose === 'review' || continuingReadOnlyStep;
  if (readOnly) constraints.push('Read-only: do not modify files or run destructive commands.');
  if (state.testCommand && !readOnly) constraints.push(`The orchestrator will run \`${state.testCommand}\` after you finish.`);
  sections.push(`# Constraints\n${constraints.map((x) => `- ${x}`).join('\n')}`);

  return { purpose, step: state.step, text: sections.join('\n\n'), sources };
}

export interface ContinuationInput {
  /** 上一個任務。 */
  previous: { title: string; prompt: string; status: string };
  /** 上一個任務的工作流記錄（對話任務沒有）。 */
  workflow?: Pick<WorkflowState, 'history' | 'lastTest' | 'lastOutputs'>;
  /** 操作員這次寫的話（新任務的指令）。 */
  message: string;
}

/** 前情提要裡每一段的長度上限。 */
const RECAP_LIMIT = 1500;

/**
 * 「繼續對話」新任務的首條訊息（P0 第三批審查，H-13 漏修的同類路徑）：
 * 上一個任務的前情提要（原始目標、流程記錄、測試結果、各 agent 最後的回覆）可能被注入過，整段放進一個資料區塊；
 * 操作員這次寫的話是唯一的指令，放在區塊之後的 [Your task] 下面（其中看起來像編排器標記的行被轉義）。
 * 新任務的 task.prompt 只記錄操作員這次寫的話，前情提要不會在之後「換人接手」時進入指令區。
 */
export function buildContinuationPrompt(input: ContinuationInput): string {
  const { previous, workflow } = input;
  const recap: string[] = [`前情提要（上一個任務「${previous.title}」，狀態 ${previous.status}）：`, `原始目標：${previous.prompt.slice(0, RECAP_LIMIT)}`];
  if (workflow?.history.length) recap.push(`流程記錄：${workflow.history.map((h) => `${h.step}:${h.outcome}`).join(' → ')}`);
  if (workflow?.lastTest) recap.push(`最近測試：${workflow.lastTest.passed ? '通過' : '失敗'}`);
  for (const [agent, text] of Object.entries(workflow?.lastOutputs ?? {})) {
    // 回覆單獨起行：它的每一行都在區塊裡、帶前綴
    recap.push(`${agent} 最後的回覆：`, text.slice(-RECAP_LIMIT));
  }
  const text = recap.join('\n');
  const boundary = dataBoundary([text, input.message]);
  return [
    '[Context from a previous task]',
    dataBlockNotice(boundary),
    '',
    renderDataBlock(boundary, 'previous task', text),
    '',
    '[Your task]',
    neutralizeReservedLines(input.message),
  ].join('\n');
}

/** 從評審文字中解析結論（文字推斷，confidence = inferred）。 */
export function parseReviewVerdict(text: string | undefined): 'ACCEPT' | 'SUGGEST_CHANGES' | 'BLOCKED' | 'UNKNOWN' {
  if (!text) return 'UNKNOWN';
  const matches = [...text.matchAll(/VERDICT:\s*(ACCEPT|SUGGEST_CHANGES|BLOCKED)\b/gi)];
  const last = matches.at(-1)?.[1]?.toUpperCase();
  return last === 'ACCEPT' || last === 'SUGGEST_CHANGES' || last === 'BLOCKED' ? last : 'UNKNOWN';
}
