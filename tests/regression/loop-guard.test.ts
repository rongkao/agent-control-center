import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, StuckDetector, handoffLoop } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-8：原地打轉檢測。
 * - 同一個工具、同樣的輸入連續 3 次 → 停下這一輪、任務進入帶原因的 BLOCKED（LOOP_DETECTED），由操作員決定；
 * - 同一個工具連續 3 次得到同樣的錯誤（引數不同也算）→ 同上；
 * - 交接在同一對 agent 之間來回（A→B→A）→ 不再自動執行；交接鏈達到上限 → 拒絕並說明原因。
 */

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, agentId = 'claude'): UnifiedEvent =>
  ({ id: `e${++seq}`, projectId: 'p', taskId: 't', runId: 'r', agentId, sequence: seq, timestamp: 0, severity: 'info', confidence: 'confirmed', type, data }) as UnifiedEvent;

describe('StuckDetector', () => {
  it('同樣的呼叫連續 3 次時報告 repeated-call；中間換了引數就重新計數', () => {
    const d = new StuckDetector();
    const call = (cmd: string) => d.observe(ev('tool.started', { toolName: 'Bash', toolInput: { command: cmd } }));
    expect(call('npm test')).toBeUndefined();
    expect(call('npm test')).toBeUndefined();
    expect(call('ls')).toBeUndefined();
    expect(call('npm test')).toBeUndefined();
    expect(call('npm test')).toBeUndefined();
    const finding = call('npm test');
    expect(finding).toMatchObject({ pattern: 'repeated-call', agentId: 'claude', toolName: 'Bash', count: 3 });
    expect(finding?.message).toContain('原地打轉');
  });

  it('同一個工具連續 3 次同樣的錯誤（引數不同、耗時數字不同）→ repeated-error；成功一次就清零', () => {
    const d = new StuckDetector();
    const fail = (i: number) => d.observe(ev('tool.failed', { toolName: 'Bash', toolCallId: `c${i}`, output: `Error: cannot find module x (took ${i}ms)` }));
    expect(fail(1)).toBeUndefined();
    expect(fail(2)).toBeUndefined();
    d.observe(ev('tool.completed', { toolName: 'Bash', toolCallId: 'ok' }));
    expect(fail(3)).toBeUndefined();
    expect(fail(4)).toBeUndefined();
    expect(fail(5)).toMatchObject({ pattern: 'repeated-error', count: 3 });
  });

  it('操作員發來新指令後重新計數；測試執行器和被拒絕的審批不算', () => {
    const d = new StuckDetector();
    const call = () => d.observe(ev('tool.started', { toolName: 'Bash', toolInput: { command: 'x' } }));
    call();
    call();
    d.observe(ev('agent.message', { direction: 'to-agent', from: 'operator', message: 'try again' }));
    expect(call()).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(d.observe(ev('tool.started', { toolName: 'test', toolInput: {} }, 'test'))).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(d.observe(ev('tool.failed', { toolName: 'Write', declined: true, output: 'denied' }))).toBeUndefined();
  });
});

describe('handoffLoop', () => {
  it('A→B→A 視為來回往返；達到上限視為鏈過長', () => {
    expect(handoffLoop([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }], 6)).toBeUndefined();
    expect(handoffLoop([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'b' }], 6)).toBe('ping-pong');
    expect(handoffLoop([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }], 6)).toBeUndefined();
    expect(handoffLoop(Array.from({ length: 6 }, (_, i) => ({ from: `x${i}`, to: `y${i}` })), 6)).toBe('chain-limit');
  });
});

describe('編排器：打轉時停下並說明原因', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('Claude 連續 3 次執行同一條命令：這一輪被停下，任務 BLOCKED（LOOP_DETECTED），原因是中文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-loop-'));
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    const bus = new EventBus({ log: () => undefined });
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.tool({ id: `bash-${i}`, name: 'Bash', input: { command: 'npm test' } });
    });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined, interruptTimeoutMs: 200 }));
    const rec = busRecorder(bus);
    cleanups.push(() => {
      rec.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const task = await orchestrator.createTask({ title: 'loop', prompt: 'fix it', agentId: 'claude', workflow: 'manual' });
    const error = await rec.waitFor((e) => e.type === 'runtime.error' && e.data.code === 'LOOP_DETECTED');
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'cancelled');
    await orchestrator.idle();
    expect(error.data).toMatchObject({ pattern: 'repeated-call', toolName: 'Bash', count: 3 });
    expect(String(error.data.message)).toContain('原地打轉');
    const loaded = await store.loadRun(task.runId);
    expect(loaded?.status === 'ok' && loaded.snapshot.status).toBe('BLOCKED');
  });
});
