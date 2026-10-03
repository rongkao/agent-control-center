import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, AgentInfo, AgentStartInput, EventSink } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-6 審批完整性：
 * - M-16：執行時自己撤回的審批（Claude 的權限請求被 abort、Codex 的 serverRequest/resolved）自動結案，任務不阻塞；
 * - M-18：拒絕即停——拒絕之後那個 agent 這一輪被停下，不會拿著“被拒絕”自己繼續做；
 * - M-19：審批裡帶完整輸入；重啟後按完整輸入匹配預批准，長的 Write 不會被要求再審批一次。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function boot(adapters: AgentAdapter[], db?: string) {
  const root = mkdtempSync(join(tmpdir(), 'acc-approval-'));
  const store = new SqliteControlPlaneStore({ path: db ?? join(root, 'acc.db') });
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
  for (const a of adapters) orchestrator.registerAdapter(a);
  const rec = busRecorder(bus);
  const close = () => {
    rec.dispose();
    store.close();
  };
  cleanups.push(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, bus, orchestrator, rec, close };
}

/** 發出一個審批請求，然後（由測試觸發）撤回它的最小 adapter。 */
class WithdrawingAgent implements AgentAdapter {
  readonly info: AgentInfo = { id: 'claude', name: 'Claude', kind: 'claude', ready: true, capabilities: ['implement'] };
  emit?: EventSink;
  ids?: { projectId: string; taskId: string; runId: string };
  async start(input: AgentStartInput, emit: EventSink) {
    this.emit = emit;
    this.ids = { projectId: input.projectId, taskId: input.taskId, runId: input.runId };
    const base = { ...this.ids, agentId: 'claude', sessionId: 's1', severity: 'info' as const, confidence: 'confirmed' as const };
    await emit({ ...base, type: 'agent.started', data: { providerSessionId: 's1' } });
    await emit({ ...base, type: 'agent.status', data: { status: 'coding' } });
    await emit({ ...base, type: 'approval.required', severity: 'warning', data: { approvalId: 'a1', toolName: 'Bash', toolInput: { command: 'ls' } } });
    return { sessionId: 's1', providerSessionId: 's1' };
  }
  async withdraw() {
    await this.emit!({ ...this.ids!, agentId: 'claude', sessionId: 's1', severity: 'info', confidence: 'confirmed', type: 'runtime.warning', data: { code: 'APPROVAL_WITHDRAWN', approvalId: 'a1' } });
  }
  async send() {}
  async cancel() {}
}

describe('M-16：執行時撤回的審批自動結案', () => {
  it('撤回後審批記為已作廢（withdrawn），任務不進入 BLOCKED', async () => {
    const agent = new WithdrawingAgent();
    const { orchestrator, rec, store } = boot([agent]);
    const task = await orchestrator.createTask({ title: 't', prompt: 'go', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.type === 'approval.required');
    await orchestrator.idle();
    await agent.withdraw();
    const resolved = await rec.waitFor((e) => e.type === 'approval.resolved');
    await orchestrator.idle();
    expect(resolved.data).toMatchObject({ approvalId: 'a1', withdrawn: true, resolvedBy: 'orchestrator' });
    const loaded = await store.loadRun(task.runId);
    const run = loaded?.status === 'ok' ? loaded.snapshot : undefined;
    expect(run?.status).not.toBe('BLOCKED');
    expect(run?.pendingApprovals.filter((a) => a.status === 'pending')).toHaveLength(0);
  });
});

describe('M-18：拒絕即停', () => {
  it('拒絕一個工具審批：任務 BLOCKED，這個 agent 的這一輪被停下', async () => {
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      await ctx.tool({ id: 'rm', name: 'Bash', input: { command: 'rm -rf build' }, needsPermission: true });
      // 被拒絕後它本來還會繼續做別的事
      await ctx.tool({ id: 'after', name: 'Bash', input: { command: 'echo continue' } });
    });
    const { orchestrator, rec, store } = boot([new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: () => undefined, interruptTimeoutMs: 200 })]);
    const task = await orchestrator.createTask({ title: 't', prompt: 'clean', agentId: 'claude', workflow: 'manual' });
    const required = await rec.waitFor((e) => e.type === 'approval.required');
    await orchestrator.idle();
    await orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'decline');
    await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'cancelled');
    await orchestrator.idle();
    const loaded = await store.loadRun(task.runId);
    expect(loaded?.status === 'ok' && loaded.snapshot.status).toBe('BLOCKED');
  });
});

describe('M-19：完整輸入', () => {
  it('審批帶完整輸入；重啟後批准長的 Write，按完整輸入匹配、不再要求審批一次', async () => {
    const long = 'x'.repeat(2_000);
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      await ctx.tool({ id: 'w', name: 'Write', input: { file_path: 'big.txt', content: long }, needsPermission: true });
    });
    const dbRoot = mkdtempSync(join(tmpdir(), 'acc-approval-db-'));
    cleanups.push(() => rmSync(dbRoot, { recursive: true, force: true }));
    const db = join(dbRoot, 'acc.db');

    const first = boot([new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: () => undefined })], db);
    const task = await first.orchestrator.createTask({ title: 't', prompt: 'write', agentId: 'claude', workflow: 'manual' });
    const required = await first.rec.waitFor((e) => e.type === 'approval.required');
    await first.orchestrator.idle();
    expect(String((required.data.toolInput as Record<string, string>).content).length).toBeLessThan(long.length);
    expect((required.data.fullInput as Record<string, string>).content).toBe(long);
    await first.orchestrator.shutdown();
    first.close();

    const second = boot([new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: () => undefined })], db);
    await second.orchestrator.recover();
    const before = second.rec.events.length;
    await second.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve');
    await second.rec.waitFor((e) => second.rec.events.indexOf(e) >= before && e.type === 'agent.status' && e.data.status === 'completed');
    await second.orchestrator.idle();
    expect(second.rec.events.slice(before).filter((e) => e.type === 'approval.required')).toHaveLength(0);
    expect(disk.executions).toContain('w');
  });
});
