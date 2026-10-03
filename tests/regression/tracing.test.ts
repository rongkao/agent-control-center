import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, eventsToSpans, spansToOtlp, traceIdFor, traceparentFor } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { startOtlpExporter } from '../../apps/server/src/otlp-export.js';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P2-2 追蹤：
 * - eventsToSpans 是純投影：同一個 run 重建兩次，trace / span ID 與層級完全相同；
 * - 層級：run → 步驟 → agent 的一輪 → 工具呼叫 / 等待審批；token 用量按輪累加（累計口徑求增量）；
 * - 預設不含內容（命令、工具輸入）；includeContent 才附帶；
 * - 任務結束後匯出 OTLP/HTTP JSON（只匯出一次）。
 */

const quiet = () => undefined;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function scenario() {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const agent = new ControlledAgent({ id: 'claude', kind: 'claude' });
  orchestrator.registerAdapter(agent);
  cleanups.push(() => orchestrator.shutdown());
  const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await orchestrator.idle();
  await agent.emit('tool.started', { providerCallId: 'c1', toolName: 'Bash', toolInput: { command: 'npm test -- --secret-flag' } });
  await agent.emit('tool.completed', { providerCallId: 'c1', toolName: 'Bash', exitCode: 0 });
  await agent.emit('approval.required', { approvalId: 'ap1', toolName: 'Edit', toolInput: { file_path: 'a.ts' } }, undefined, 'warning');
  await orchestrator.idle();
  await orchestrator.resolveApproval(task.id, 'ap1', 'approve');
  await agent.emit('model.turn.completed', { usage: { cumulative: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } } });
  await agent.emit('model.turn.completed', { usage: { cumulative: { inputTokens: 250, outputTokens: 50, costUsd: 0.03 } } });
  await agent.complete('done');
  await orchestrator.idle();
  return { store, bus, orchestrator, task };
}

describe('P2-2：事件 → span', () => {
  it('確定性、層級、用量、預設不含內容', async () => {
    const { store, task } = await scenario();
    const events = await store.listEvents(task.runId);
    const a = eventsToSpans(events);
    const b = eventsToSpans([...events].reverse());
    expect(b).toEqual(a);

    const root = a.find((s) => s.name === 'acc.run')!;
    expect(root.traceId).toBe(traceIdFor(task.runId));
    expect(root.parentSpanId).toBeUndefined();
    expect(traceparentFor(task.runId)).toBe(`00-${root.traceId}-${root.spanId}-01`);
    const turn = a.find((s) => s.name === 'invoke_agent claude')!;
    const tool = a.find((s) => s.name === 'execute_tool Bash')!;
    const wait = a.find((s) => s.name === 'acc.approval.wait')!;
    expect(tool.parentSpanId).toBe(turn.spanId);
    expect(wait.parentSpanId).toBe(turn.spanId);
    expect(wait.attributes).toMatchObject({ 'acc.approval.decision': 'approve', 'acc.approval.resolved_by': 'operator' });
    // 輪的父 span 是步驟或 run
    expect(a.some((s) => s.spanId === turn.parentSpanId)).toBe(true);
    expect(turn.status).toBe('ok');
    expect(turn.attributes).toMatchObject({ 'gen_ai.usage.input_tokens': 250, 'gen_ai.usage.output_tokens': 50, 'gen_ai.system': 'anthropic' });
    // 預設不含內容
    expect(JSON.stringify(a)).not.toContain('--secret-flag');
    expect(JSON.stringify(eventsToSpans(events, { includeContent: true }))).toContain('--secret-flag');

    const otlp = spansToOtlp(a) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; startTimeUnixNano: string }> }> }> };
    const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(a.length);
    expect(spans[0]!.traceId).toBe(root.traceId);
    expect(spans[0]!.startTimeUnixNano).toMatch(/^\d+000000$/);
  });

  it('任務結束後匯出一次 OTLP/HTTP JSON', async () => {
    const { store, bus, orchestrator, task } = await scenario();
    const posts: Array<{ url: string; body: string }> = [];
    const stop = startOtlpExporter({
      endpoint: 'http://collector.local:4318/',
      store,
      bus,
      log: quiet,
      fetchFn: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: String(init.body) });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    cleanups.push(stop);
    await orchestrator.cancelTask(task.id);
    await orchestrator.idle();
    await new Promise((r) => setTimeout(r, 400));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('http://collector.local:4318/v1/traces');
    expect(posts[0]!.body).toContain(traceIdFor(task.runId));
    expect(posts[0]!.body).not.toContain('--secret-flag');
  });
});
