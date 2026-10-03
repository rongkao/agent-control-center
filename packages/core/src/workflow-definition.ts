import type { ContextPurpose } from './context-manager.js';
import type { AgentMode, ReviewVerdict, WorkflowStep } from './types.js';

/**
 * 工作流定義資料化（P2-11）：步驟由誰做（角色）、以什麼模式做、做完之後按順序檢查哪些條件、走到哪一步，全部寫成資料。
 * 編排引擎（workflow.ts 的 decide）只解釋這些資料；失敗、傳輸重試、不活動看門狗、人工閘門是引擎的通用行為。
 */

/** 步驟由哪個角色的 agent 負責。 */
export type WorkflowRole = 'implement' | 'review' | 'test';

/** 規則的條件（全部滿足才生效）。 */
export type WorkflowGuard =
  /** 任務配置了測試命令。 */
  | 'hasTestCommand'
  /** 這一步的測試通過了（測試步驟）。 */
  | 'testPassed'
  /** 這一步的測試沒有通過。 */
  | 'testFailed'
  /** 還有自動重試額度。 */
  | 'retriesLeft'
  /** 還沒有請評審 agent 診斷過。 */
  | 'rescueAvailable'
  /** 評審結論（評審步驟）。 */
  | { verdict: ReviewVerdict };

/** 規則的結果。 */
export type WorkflowOutcome =
  /** 派發下一步。handoffFrom：signal = 剛做完這一步的 agent（預設），implementer = 實現者。effect：消耗一次重試或診斷額度。 */
  | { dispatch: WorkflowStep; purpose: ContextPurpose; handoffFrom?: 'signal' | 'implementer'; effect?: 'useRetry' | 'useRescue' }
  | { complete: string }
  | { block: string; reason: string }
  /** 等操作員決定（評審閘門）；{verdict} 替換成評審結論。 */
  | { gate: string }
  /** 通過之後：開啟了評審閘門就等操作員，否則完成。 */
  | { afterPass: true };

export interface WorkflowRule {
  when?: WorkflowGuard[];
  then: WorkflowOutcome;
}

export interface WorkflowStepDefinition {
  role: WorkflowRole;
  mode: AgentMode;
  /** 實現類步驟：卡住時可以請評審 agent 唯讀診斷（rescue）。 */
  implementing?: boolean;
  /** 測試步驟：記錄測試結果（lastTest）。 */
  recordsTest?: boolean;
  /** 評審步驟：解析評審結論（review）。 */
  recordsReview?: boolean;
  /** 做完時寫進歷史的說明（測試 / 評審步驟由引擎按結果生成）。 */
  record?: string;
  /** 做完之後按順序檢查的規則：第一條條件全部滿足的生效。 */
  onComplete: WorkflowRule[];
}

export interface WorkflowDefinition {
  id: string;
  /** 第一步。 */
  start: WorkflowStep;
  steps: Partial<Record<WorkflowStep, WorkflowStepDefinition>>;
  /** 測試失敗後自動重試的次數。 */
  maxRetries: number;
  /** 傳輸錯誤 / 不活動時重新接上會話的次數。 */
  maxTransportRetries: number;
}

/**
 * implementation-v1：
 *   implement → test ─ pass → (評審閘門 ? 等操作員 : 完成)
 *                 └ fail → retry（最多 1 次）→ test → fail → rescue（唯讀診斷）→ fix → test → fail → BLOCKED
 *   評審：ACCEPT → final-test → 完成；SUGGEST_CHANGES → review-fix → final-test → 完成；其他 → 回到評審閘門。
 */
export const IMPLEMENTATION_V1: WorkflowDefinition = {
  id: 'implementation-v1',
  start: 'implement',
  maxRetries: 1,
  maxTransportRetries: 1,
  steps: {
    implement: { role: 'implement', mode: 'implement', implementing: true, record: 'implementation turn completed', onComplete: implementationDone() },
    retry: { role: 'implement', mode: 'implement', implementing: true, record: 'implementation turn completed', onComplete: implementationDone() },
    fix: { role: 'implement', mode: 'implement', implementing: true, record: 'implementation turn completed', onComplete: implementationDone() },
    'review-fix': {
      role: 'implement',
      mode: 'implement',
      implementing: true,
      record: 'review changes applied',
      onComplete: [{ when: ['hasTestCommand'], then: { dispatch: 'final-test', purpose: 'test' } }, { then: { complete: 'Review changes applied' } }],
    },
    test: {
      role: 'test',
      mode: 'test',
      recordsTest: true,
      onComplete: [
        { when: ['testPassed'], then: { afterPass: true } },
        { when: ['retriesLeft'], then: { dispatch: 'retry', purpose: 'retry', effect: 'useRetry' } },
        { when: ['rescueAvailable'], then: { dispatch: 'rescue', purpose: 'rescue', handoffFrom: 'implementer', effect: 'useRescue' } },
        { then: { block: 'TESTS_FAILED', reason: 'Tests still failing after retry and rescue; operator decision required' } },
      ],
    },
    'final-test': {
      role: 'test',
      mode: 'test',
      recordsTest: true,
      onComplete: [{ when: ['testPassed'], then: { complete: 'Final test passed' } }, { then: { block: 'FINAL_TEST_FAILED', reason: 'Final test failed after review changes' } }],
    },
    rescue: { role: 'review', mode: 'rescue', record: 'diagnosis delivered', onComplete: [{ then: { dispatch: 'fix', purpose: 'fix' } }] },
    review: {
      role: 'review',
      mode: 'review',
      recordsReview: true,
      onComplete: [
        { when: [{ verdict: 'ACCEPT' }, 'hasTestCommand'], then: { dispatch: 'final-test', purpose: 'test' } },
        { when: [{ verdict: 'ACCEPT' }], then: { complete: 'Review accepted' } },
        { when: [{ verdict: 'SUGGEST_CHANGES' }], then: { dispatch: 'review-fix', purpose: 'review-fix' } },
        { then: { gate: 'Review verdict {verdict}. Accept, retry with instructions, or cancel.' } },
      ],
    },
  },
};

function implementationDone(): WorkflowRule[] {
  return [{ when: ['hasTestCommand'], then: { dispatch: 'test', purpose: 'test' } }, { then: { afterPass: true } }];
}

/** 已註冊的工作流定義。 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<string, WorkflowDefinition>> = { [IMPLEMENTATION_V1.id]: IMPLEMENTATION_V1 };

/** 按 ID 取工作流定義；沒有時退回 implementation-v1（舊快照裡的定義 ID 一定是它）。 */
export function workflowDefinition(id: string | undefined): WorkflowDefinition {
  return (id && WORKFLOW_DEFINITIONS[id]) || IMPLEMENTATION_V1;
}

/** 校驗定義：每條派發都指向定義裡的步驟，每個步驟最後一條規則沒有條件（保證總有結果）。返回問題列表。 */
export function validateWorkflowDefinition(def: WorkflowDefinition): string[] {
  const problems: string[] = [];
  if (!def.steps[def.start]) problems.push(`start step ${def.start} is not defined`);
  for (const [name, step] of Object.entries(def.steps)) {
    if (!step) continue;
    const last = step.onComplete.at(-1);
    if (!last || (last.when && last.when.length > 0)) problems.push(`step ${name}: the last rule must be unconditional`);
    for (const rule of step.onComplete) {
      if ('dispatch' in rule.then && !def.steps[rule.then.dispatch]) problems.push(`step ${name}: dispatches to undefined step ${rule.then.dispatch}`);
    }
  }
  return problems;
}
