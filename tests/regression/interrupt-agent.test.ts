import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { AgentInterruptError, EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-10 / M-27：以前只能停止整個任務；AI 跑偏時會連對話一起結束。
 * 期望：可以只停下某一個 agent 當前這一輪，任務仍在執行；下一條訊息自動續接原來的對話；沒有進行中的一輪時返回 409。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function boot(runtime: FakeClaudeRuntime) {
  const root = mkdtempSync(join(tmpdir(), 'acc-interrupt-'));
  const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
  orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined, interruptTimeoutMs: 200 }));
  const rec = busRecorder(bus);
  cleanups.push(() => {
    rec.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, orchestrator, rec };
}

describe('P1-10：只停下某個 AI 的這一輪', () => {
  it('停下正在進行的一輪：任務仍在執行，下一條訊息續接原來的對話', async () => {
    const disk = new FakeClaudeDisk();
    let release: () => void = () => undefined;
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      // 第一輪一直“做事”，直到被停下
      if (ctx.prompt.includes('long')) await new Promise<void>((resolve) => (release = resolve));
    });
    const { store, orchestrator, rec } = boot(runtime);
    const task = await orchestrator.createTask({ title: 'chat', prompt: 'long job', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'coding');
    await orchestrator.idle();

    await orchestrator.interruptAgent(task.id, 'claude');
    release();
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'cancelled');
    await orchestrator.idle();
    const loaded = await store.loadRun(task.runId);
    expect(loaded?.status === 'ok' && loaded.snapshot.status).toBe('RUNNING');

    const before = rec.events.length;
    await orchestrator.sendMessage(task.id, 'claude', 'short one');
    await rec.waitFor((e) => rec.events.indexOf(e) >= before && e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    expect(runtime.queries).toHaveLength(2);
    expect(runtime.queries[1]!.options.resume).toBeTruthy();
  });

  it('沒有進行中的一輪時返回 409（INTERRUPT_UNAVAILABLE）', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const { orchestrator, rec } = boot(runtime);
    const task = await orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();
    const error = await orchestrator.interruptAgent(task.id, 'claude').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentInterruptError);
    expect((error as AgentInterruptError).statusCode).toBe(409);
  });
});
