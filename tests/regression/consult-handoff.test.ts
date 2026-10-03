import { afterEach, describe, expect, it } from 'vitest';
import { parseHandoffMarker } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P2-5 諮詢與轉交：
 * - agent 請求交接時可以指定 kind=consult（Claude 的 request_handoff 工具引數、Codex 的 `ASK@` 標記）；
 * - 諮詢執行時對方以唯讀方式回答（mode=analysis），這一輪結束後答覆自動作為新訊息交回提問的 agent（資料區塊裡）；
 * - 被諮詢的一方失敗時不派發，只記錄；
 * - 交接有向邊白名單：不在名單裡的請求直接拒絕。
 */

const quiet = () => undefined;
const CHAT: CreateTaskInput = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot(options: { handoffEdges?: string[] } = {}) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet, ...options });
  const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  cleanups.push(() => orchestrator.shutdown());
  return { store, orchestrator, claude, codex };
}

describe('P2-5：諮詢', () => {
  it('Codex 的 ASK@ 標記解析為諮詢，HANDOFF@ 仍是轉交', () => {
    expect(parseHandoffMarker('analysis\nASK@claude: is the lock re-entrant?')).toEqual({ toAgentId: 'claude', kind: 'consult', instruction: 'is the lock re-entrant?', content: 'analysis' });
    expect(parseHandoffMarker('done\nHANDOFF@claude: apply it')?.kind).toBe('transfer');
  });

  it('諮詢：對方唯讀回答，答覆自動交回提問的 agent；待處理的諮詢隨之清除', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('handoff.requested', { origin: 'agent', via: 'tool', kind: 'consult', toAgentId: 'codex', instruction: 'Is parser.ts thread-safe?', content: 'context' });
    await env.claude.complete('asked codex');
    await env.orchestrator.idle();

    // 被諮詢的一方以唯讀方式收到問題
    expect(env.codex.calls).toHaveLength(1);
    expect(env.codex.calls[0]!.mode).toBe('analysis');
    expect(env.codex.calls[0]!.prompt).toContain('is consulting you');
    let run = (await env.store.getRun(task.runId))!;
    expect(run.pendingConsults).toHaveLength(1);

    // 它回答完：答覆交回 claude
    await env.codex.complete('Yes, guarded by a mutex.');
    await env.orchestrator.idle();
    const reply = env.claude.calls.at(-1)!;
    expect(reply.prompt).toContain('[Answer from codex to your question]');
    expect(reply.prompt).toContain('| Yes, guarded by a mutex.');
    expect(reply.prompt).toContain('| Is parser.ts thread-safe?');
    run = (await env.store.getRun(task.runId))!;
    expect(run.pendingConsults ?? []).toHaveLength(0);
    const answered = (await env.store.listEvents(task.runId)).filter((e) => e.type === 'consult.answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.data).toMatchObject({ outcome: 'completed', delivered: true });
  });

  it('被諮詢的一方失敗：不派發答覆，只記錄', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('handoff.requested', { origin: 'agent', via: 'tool', kind: 'consult', toAgentId: 'codex', instruction: 'question?' });
    await env.claude.complete('asked');
    await env.orchestrator.idle();
    const claudeCalls = env.claude.calls.length;
    await env.codex.emit('agent.status', { status: 'failed' });
    await env.orchestrator.idle();
    expect(env.claude.calls).toHaveLength(claudeCalls);
    const answered = (await env.store.listEvents(task.runId)).filter((e) => e.type === 'consult.answered');
    expect(answered[0]!.data).toMatchObject({ outcome: 'failed', delivered: false });
  });

  it('交接有向邊白名單：不在名單裡的請求被拒絕', async () => {
    const env = boot({ handoffEdges: ['codex>claude'] });
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'review please' });
    await env.orchestrator.idle();
    expect(env.codex.calls).toHaveLength(0);
    const warning = (await env.store.listEvents(task.runId)).find((e) => e.type === 'runtime.warning' && e.data.code === 'HANDOFF_REQUEST_REJECTED');
    expect(warning?.data.reason).toBe('edge not allowed');
  });
});
