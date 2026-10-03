import { describe, expect, it } from 'vitest';
import { IMPLEMENTATION_V1, decide, firstDirective, initWorkflow, stepAgent, stepMode, validateWorkflowDefinition, type WorkflowSignal, type WorkflowState } from '@acc/core';
import * as legacy from './fixtures/legacy-workflow.js';

/**
 * P2-11 工作流定義資料化：implementation-v1 由資料定義（IMPLEMENTATION_V1），decide 只解釋它。
 * 與之前手寫的實現逐步比較：隨機生成大量訊號序列（完成 / 失敗 / 不活動 / 閘門，測試通過或失敗，各種評審結論），
 * 每一步的新狀態和指令都必須完全相同。
 */

/** 可重複的偽隨機數。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VERDICTS = ['VERDICT: ACCEPT', 'VERDICT: SUGGEST_CHANGES', 'VERDICT: BLOCKED', 'no verdict here'];

function randomSignal(state: WorkflowState, next: () => number): WorkflowSignal {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
  const agent = state.awaitingAgentId ?? pick(['claude', 'codex', 'test']);
  const r = next();
  if (state.step === 'review-gate' || r < 0.08) {
    return { kind: 'gate', action: pick(['accept', 'review', 'retry', 'rerun'] as const), note: pick([undefined, 'try again']) };
  }
  if (r < 0.15) return { kind: 'agent-inactive', agentId: agent, idleMs: 600_000 };
  if (r < 0.25) return { kind: 'agent-failed', agentId: agent, data: {} };
  return { kind: 'agent-completed', agentId: agent, data: { testPassed: next() < 0.45, exitCode: next() < 0.5 ? 0 : 1, outputTail: 'out' } };
}

function run<T>(fn: () => T): { ok: T } | { error: string } {
  try {
    return { ok: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe('P2-11：工作流定義資料化', () => {
  it('定義本身通過校驗', () => {
    expect(validateWorkflowDefinition(IMPLEMENTATION_V1)).toEqual([]);
    expect(validateWorkflowDefinition({ ...IMPLEMENTATION_V1, steps: { implement: { role: 'implement', mode: 'implement', onComplete: [{ when: ['hasTestCommand'], then: { dispatch: 'nope' as never, purpose: 'test' } }] } } })).toEqual([
      'step implement: the last rule must be unconditional',
      'step implement: dispatches to undefined step nope',
    ]);
  });

  it('與手寫實現逐步一致（2000 條隨機序列）', () => {
    let steps = 0;
    const visited = new Set<string>();
    for (let seed = 1; seed <= 2000; seed += 1) {
      const next = rng(seed);
      const init = initWorkflow({
        implementAgentId: 'claude',
        reviewAgentId: next() < 0.8 ? 'codex' : 'claude',
        testAgentId: 'test',
        testCommand: next() < 0.8 ? 'npm test' : undefined,
        reviewGate: next() < 0.5,
      });
      expect(firstDirective(init)).toEqual(legacy.firstDirective(init));
      let state = firstDirective(init).state;
      for (let i = 0; i < 25 && state.step !== 'done'; i += 1) {
        // 評審步驟的結論來自 agent 最後的輸出
        if (state.step === 'review' && state.awaitingAgentId) state = { ...state, lastOutputs: { ...state.lastOutputs, [state.awaitingAgentId]: VERDICTS[Math.floor(next() * VERDICTS.length)]! } };
        const signal = randomSignal(state, next);
        const ctx = { now: 1000 + i, canReview: next() < 0.7 };
        const a = run(() => decide(state, signal, ctx));
        const b = run(() => legacy.decide(state, signal, ctx));
        expect(a, `seed ${seed} step ${i} ${JSON.stringify(signal)}`).toEqual(b);
        steps += 1;
        if ('ok' in a) state = a.ok.state;
        visited.add(state.step);
      }
    }
    expect(steps).toBeGreaterThan(10_000);
    // 隨機序列覆蓋了全部步驟
    expect([...visited].sort()).toEqual(['done', 'final-test', 'fix', 'implement', 'rescue', 'retry', 'review', 'review-fix', 'review-gate', 'test']);
  });

  it('步驟的負責角色與模式來自定義', () => {
    const state = initWorkflow({ implementAgentId: 'claude', reviewAgentId: 'codex', testAgentId: 'test' });
    for (const step of ['implement', 'retry', 'fix', 'review-fix', 'test', 'final-test', 'rescue', 'review', 'review-gate', 'done'] as const) {
      expect(stepAgent(state, step)).toBe(legacy.stepAgent(state, step));
      expect(stepMode(step)).toBe(legacy.stepMode(step));
    }
  });
});
