import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-5 / M-6：對話任務裡答完話的 Claude 會話會一直佔著一個 CLI 程序（每個幾百 MB）。
 * 期望：閒置超過閾值後靜默釋放執行時（不發事件、任務狀態不變）；下一條訊息自動用原生會話 ID 續接，上下文不丟；
 * 正在工作或掛著審批的會話不釋放；任務結束後 adapter 忘掉這些會話。
 */

const IDLE_MS = 10 * 60_000;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function boot(runtime: FakeClaudeRuntime) {
  const root = mkdtempSync(join(tmpdir(), 'acc-idle-release-'));
  const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
  const bus = new EventBus({ log: () => undefined });
  let now = 1_000_000;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined, now: clock.now, idleSessionMs: IDLE_MS });
  const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined });
  orchestrator.registerAdapter(adapter);
  const rec = busRecorder(bus);
  cleanups.push(() => {
    rec.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, bus, orchestrator, rec, clock, adapter };
}

describe('P1-5：空閒會話回收', () => {
  it('閒置超過閾值後釋放 CLI 程序，不發事件；下一條訊息自動續接原生會話', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      ctx.send({ type: 'assistant', parent_tool_use_id: null, session_id: ctx.sessionId, uuid: 'u', message: { content: [{ type: 'text', text: `reply:${ctx.prompt}` }] } } as never);
    });
    const { orchestrator, bus, rec, clock, store } = boot(runtime);
    const task = await orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();
    expect(runtime.queries).toHaveLength(1);

    // 還沒到閾值：不釋放
    clock.advance(IDLE_MS / 2);
    expect(await orchestrator.releaseIdleSessions()).toBe(0);

    const before = rec.events.length;
    clock.advance(IDLE_MS);
    expect(await orchestrator.releaseIdleSessions()).toBe(1);
    await bus.drain();
    // 靜默：沒有新的事件（不會顯示成“已停止”或失敗），任務狀態不變
    expect(rec.events.slice(before)).toEqual([]);
    const loaded = await store.loadRun(task.runId);
    expect(loaded?.status === 'ok' && loaded.snapshot.status).toBe('RUNNING');
    // CLI 程序已結束（abort 訊號已發出）
    expect(runtime.queries[0]!.options.abortController?.signal.aborted).toBe(true);

    // 再發訊息：用原生會話 ID 續接（新的 SDK 查詢帶 resume），不是新建會話
    await orchestrator.sendMessage(task.id, 'claude', 'again');
    await rec.waitFor((e) => rec.events.indexOf(e) >= before && e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();
    expect(runtime.queries).toHaveLength(2);
    expect(runtime.queries[1]!.options.resume).toBeTruthy();
    expect(runtime.queries[1]!.prompts.join('\n')).toContain('again');
  });

  it('掛著審批的會話不釋放', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      await ctx.tool({ id: 'w1', name: 'Write', input: { file_path: 'a.txt', content: 'x' }, needsPermission: true });
    });
    const { orchestrator, rec, clock } = boot(runtime);
    await orchestrator.createTask({ title: 'chat', prompt: 'write', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.type === 'approval.required');
    await orchestrator.idle();
    clock.advance(IDLE_MS * 3);
    expect(await orchestrator.releaseIdleSessions()).toBe(0);
    expect(runtime.queries[0]!.options.abortController?.signal.aborted).toBe(false);
  });

  it('idleSessionMs=0 關閉回收', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const root = mkdtempSync(join(tmpdir(), 'acc-idle-off-'));
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    const bus = new EventBus({ log: () => undefined });
    let now = 0;
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined, now: () => now, idleSessionMs: 0 });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
    const rec = busRecorder(bus);
    cleanups.push(() => {
      rec.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    await orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();
    now += 24 * 60 * 60_000;
    expect(await orchestrator.releaseIdleSessions()).toBe(0);
  });
});
