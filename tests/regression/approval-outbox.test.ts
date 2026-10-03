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
 * P1-1 / L-4：審批決定的投遞狀態（outbox）。
 * approval.resolved 已經落盤、還沒交給 agent 時服務崩潰：重啟後按原決定補投一次（工具執行一次，不會再問操作員），
 * 並記下 approval.delivered；正常的批准同樣記下投遞狀態。建立任務時評審 agent 寫錯直接 400，不落盤。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'acc-outbox-'));
  cleanups.push(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 忽略
    }
  });
  const disk = new FakeClaudeDisk();
  const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
    await ctx.tool({ id: 'w', name: 'Write', input: { file_path: 'a.txt', content: 'hello' }, needsPermission: true });
  });
  const boot = () => {
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    const bus = new EventBus({ log: () => undefined });
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
    const rec = busRecorder(bus);
    return { store, bus, orchestrator, rec, close: () => (rec.dispose(), store.close()) };
  };
  return { disk, runtime, boot };
}

describe('審批決定的投遞狀態', () => {
  it('正常批准：記下 approval.delivered，outbox 清空', async () => {
    const { disk, boot } = setup();
    const env = boot();
    cleanups.push(env.close);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'write', agentId: 'claude', workflow: 'manual' });
    const required = await env.rec.waitFor((e) => e.type === 'approval.required');
    await env.orchestrator.idle();
    await env.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve');
    await env.rec.waitFor((e) => e.type === 'approval.delivered');
    await env.orchestrator.idle();
    const run = (await env.store.loadRun(task.runId)) as { status: 'ok'; snapshot: { undeliveredDecisions?: unknown[] } };
    expect(run.snapshot.undeliveredDecisions ?? []).toHaveLength(0);
    expect(disk.executions).toEqual(['w']);
  });

  it('批准已落盤、還沒交給 agent 就崩潰：重啟後按原決定補投一次，工具只執行一次，不再問操作員', async () => {
    const { disk, boot } = setup();
    const a = boot();
    const task = await a.orchestrator.createTask({ title: 't', prompt: 'write', agentId: 'claude', workflow: 'manual' });
    const required = await a.rec.waitFor((e) => e.type === 'approval.required');
    await a.orchestrator.idle();
    // 模擬“決定已經落盤、投遞之前崩潰”：只寫下 approval.resolved，不呼叫 adapter
    await a.bus.publish({
      projectId: task.projectId,
      taskId: task.id,
      runId: task.runId,
      agentId: 'claude',
      sessionId: required.sessionId,
      type: 'approval.resolved',
      severity: 'info',
      confidence: 'confirmed',
      data: { approvalId: required.data.approvalId, decision: 'approve', resolvedBy: 'operator', providerCallId: required.data.providerCallId, scope: 'once' },
    });
    await a.orchestrator.idle();
    await a.orchestrator.shutdown();
    a.close();

    const b = boot();
    cleanups.push(b.close);
    await b.orchestrator.recover();
    await b.rec.waitFor((e) => e.type === 'approval.delivered');
    await b.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    await b.orchestrator.idle();
    const delivered = b.rec.events.find((e) => e.type === 'approval.delivered');
    expect(delivered?.data.how).toBe('redelivered-after-restart');
    expect(b.rec.events.filter((e) => e.type === 'approval.required')).toHaveLength(0);
    expect(disk.executions).toEqual(['w']);
  });

  it('評審 agent 寫錯：建立任務直接拒絕（400），不落盤', async () => {
    const { boot } = setup();
    const env = boot();
    cleanups.push(env.close);
    const error = (await env.orchestrator
      .createTask({ title: 't', prompt: 'x', agentId: 'claude', workflow: 'implementation-v1', reviewAgentId: 'nobody' })
      .catch((e: unknown) => e)) as { statusCode?: number };
    expect(error.statusCode).toBe(400);
    expect(await env.store.listTasks()).toHaveLength(0);
  });
});
