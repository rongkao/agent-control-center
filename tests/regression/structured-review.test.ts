import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '@acc/adapters';
import { REVIEW_RESULT_SCHEMA, decide, initWorkflow, parseStructuredReview, renderStructuredReview, type WorkflowState } from '@acc/core';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { emitRecorder } from './fakes/event-waiter.js';

/**
 * P2-5 結構化的完成結果：評審這一輪用 outputSchema 約束 Codex 的最後一條回覆（結論 + 問題列表）；
 * adapter 把它顯示成可讀文字（第一行仍是 VERDICT）並把結構化內容交給編排器；工作流按結構化結論判斷（confirmed），
 * 沒有結構化結果時退回文字推斷（inferred）。
 */

const REVIEW_JSON = JSON.stringify({ verdict: 'SUGGEST_CHANGES', summary: 'Missing null check.', issues: [{ severity: 'high', file: 'src/a.ts', line: 12, text: 'user may be null' }] });

describe('P2-5：結構化評審結果', () => {
  it('解析與顯示', () => {
    const r = parseStructuredReview(REVIEW_JSON)!;
    expect(r).toMatchObject({ verdict: 'SUGGEST_CHANGES', issues: [{ severity: 'high', file: 'src/a.ts', line: 12 }] });
    expect(renderStructuredReview(r)).toBe('VERDICT: SUGGEST_CHANGES\n\nMissing null check.\n\nIssues:\n- [high] src/a.ts:12 — user may be null');
    expect(parseStructuredReview('VERDICT: ACCEPT')).toBeUndefined();
    expect(parseStructuredReview('{"verdict":"MAYBE"}')).toBeUndefined();
  });

  it('Codex 評審這一輪帶 outputSchema；回覆顯示成文字並附上結構化結果；實現這一輪不帶', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), () => [{ kind: 'message', text: REVIEW_JSON }]);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport });
    const rec = emitRecorder();
    try {
      const handle = await codex.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'review', mode: 'review', cwd: process.cwd() }, rec.emit);
      const msg = await rec.waitFor((e) => e.type === 'agent.message' && e.data.direction === 'from-agent');
      expect(server.received.find((r) => r.method === 'turn/start')?.params).toMatchObject({ outputSchema: REVIEW_RESULT_SCHEMA });
      expect(msg.data.message).toMatch(/^VERDICT: SUGGEST_CHANGES/);
      expect(msg.data.structured).toMatchObject({ kind: 'review', verdict: 'SUGGEST_CHANGES' });
      await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');

      await codex.send(handle.sessionId, 'now implement', rec.emit, { mode: 'implement' });
      await rec.waitFor(() => server.received.filter((r) => r.method === 'turn/start').length >= 2);
      const second = server.received.filter((r) => r.method === 'turn/start')[1]!.params as Record<string, unknown>;
      expect(second.outputSchema).toBeUndefined();
    } finally {
      codex.dispose();
    }
  });

  it('工作流：有結構化結論時按它判斷（confirmed），沒有時從文字推斷（inferred）', () => {
    const base = initWorkflow({ implementAgentId: 'claude', reviewAgentId: 'codex', testAgentId: 'test', testCommand: 'npm test' });
    const reviewing: WorkflowState = { ...base, step: 'review', awaitingAgentId: 'codex', lastOutputs: { codex: 'looks fine. VERDICT: ACCEPT' } };
    const inferred = decide(reviewing, { kind: 'agent-completed', agentId: 'codex', data: {} }, { now: 1, canReview: true });
    expect(inferred.state.review).toMatchObject({ verdict: 'ACCEPT', confidence: 'inferred' });
    // 結構化結論與文字不一致時以結構化為準
    const confirmed = decide({ ...reviewing, structuredReviews: { codex: { verdict: 'SUGGEST_CHANGES', issues: 1 } } }, { kind: 'agent-completed', agentId: 'codex', data: {} }, { now: 1, canReview: true });
    expect(confirmed.state.review).toMatchObject({ verdict: 'SUGGEST_CHANGES', confidence: 'confirmed' });
    expect(confirmed.directive).toMatchObject({ type: 'dispatch', step: 'review-fix' });
  });
});
