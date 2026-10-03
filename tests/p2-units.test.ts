import { describe, expect, it } from 'vitest';
import { LocalTestRunnerAdapter } from '@acc/adapters';
import { buildContextEnvelope, classifyError, initWorkflow, parseReviewVerdict } from '@acc/core';
import type { EventSink } from '@acc/core';

type Emitted = Parameters<EventSink>[0];

async function runTests(command: string, timeoutMs?: number) {
  const events: Emitted[] = [];
  const adapter = new LocalTestRunnerAdapter({ timeoutMs });
  const handle = await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: '', mode: 'test', context: { testCommand: command } }, (e) => {
    events.push(e);
  });
  const deadline = Date.now() + 15_000;
  while (!events.some((x) => x.type === 'agent.status' && x.data.status === 'completed') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { events, handle, adapter, done: events.find((x) => x.type === 'agent.status' && x.data.status === 'completed')! };
}

describe('LocalTestRunnerAdapter (real child processes)', () => {
  it('passing command → testPassed true, tool.completed', async () => {
    const { events, done } = await runTests('node -e "console.log(\'all green\')"');
    expect(done.data).toMatchObject({ testPassed: true, exitCode: 0 });
    expect(String(done.data.outputTail)).toContain('all green');
    expect(events.some((x) => x.type === 'tool.completed' && x.data.toolName === 'test')).toBe(true);
  });

  it('failing command → testPassed false with output tail and executed side effect', async () => {
    const { events, done } = await runTests('node -e "console.error(\'boom: 1 failing\'); process.exit(3)"');
    expect(done.data).toMatchObject({ testPassed: false, exitCode: 3 });
    expect(String(done.data.outputTail)).toContain('boom: 1 failing');
    expect(events.find((x) => x.type === 'tool.failed')?.data).toMatchObject({ executed: true, exitCode: 3 });
  });

  it('timeout kills the process and fails the run', async () => {
    const { done } = await runTests('node -e "setTimeout(() => {}, 60000)"', 500);
    expect(done.data).toMatchObject({ testPassed: false, timedOut: true });
    // 結束程序樹是非同步的 taskkill（P1-5，不阻塞事件迴圈）：整套測試並行、機器繁忙時啟動 taskkill 本身可能要好幾秒
  }, 20_000);

  it('send re-runs the same command in the same logical session', async () => {
    const { events, handle, adapter } = await runTests('node -e "process.exit(0)"');
    await adapter.send(handle.sessionId, 'rerun', () => undefined);
    await expect(adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: '' }, () => undefined)).rejects.toThrow(/No test command/);
    expect(events.filter((x) => x.type === 'agent.started')).toHaveLength(1);
  });
});

describe('error classifier', () => {
  it('structured errors are confirmed', () => {
    expect(classifyError({ code: 'CODEX_USAGE_LIMIT_EXCEEDED', category: 'usage', retryable: false })).toMatchObject({ confidence: 'confirmed', category: 'usage' });
  });
  it('text-only errors are inferred and never claimed as confirmed', () => {
    expect(classifyError(new Error('Request failed: 429 Too Many Requests'))).toMatchObject({ code: 'INFERRED_RATE_LIMIT', retryable: true, confidence: 'inferred' });
    expect(classifyError(new Error('read ECONNRESET'))).toMatchObject({ category: 'runtime', retryable: true, confidence: 'inferred' });
    expect(classifyError(new Error('spawn codex ENOENT'))).toMatchObject({ code: 'INFERRED_NOT_FOUND', retryable: false });
    expect(classifyError('something odd')).toMatchObject({ code: 'UNKNOWN_ERROR', confidence: 'inferred' });
  });
});

describe('context manager', () => {
  const state = {
    ...initWorkflow({ implementAgentId: 'claude', reviewAgentId: 'codex', testCommand: 'npm test' }),
    lastTest: { passed: false, exitCode: 1, outputTail: 'x'.repeat(10_000) + 'LAST LINE', at: 1 },
    lastOutputs: { claude: 'implemented guard', codex: 'root cause: missing guard' },
  };
  const task = { title: 'T', prompt: 'P' };

  it('retry envelope carries the (clipped) failing test output, not the whole log', () => {
    const env = buildContextEnvelope({ task, state, purpose: 'retry' });
    expect(env.text).toContain('LAST LINE');
    expect(env.text.length).toBeLessThan(5000);
    expect(env.sources).toEqual(['task', 'test']);
  });

  it('fix envelope forwards only the reviewer diagnosis; review is read-only', () => {
    expect(buildContextEnvelope({ task, state, purpose: 'fix' }).text).toContain('root cause: missing guard');
    const review = buildContextEnvelope({ task, state, purpose: 'review' });
    expect(review.text).toContain('Read-only');
    expect(review.text).toContain('implemented guard');
    expect(review.text).not.toContain('root cause');
  });

  it('parses review verdicts (last one wins, unknown when missing)', () => {
    expect(parseReviewVerdict('... VERDICT: SUGGEST_CHANGES\n... VERDICT: ACCEPT')).toBe('ACCEPT');
    expect(parseReviewVerdict('no verdict here')).toBe('UNKNOWN');
  });
});
