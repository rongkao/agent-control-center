import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, WorkspaceBusyError, activitySummary } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-4：
 * - M-4：對話任務也參與工作區互斥——另一個任務裡有 AI 正在改同一個（或包含關係的）資料夾時，不讓這裡能改檔案的 AI 開始；
 *   閒置的舊對話不擋路；獨立 worktree 不算衝突。
 * - 交接附帶編排器從事件記錄確定性生成的活動摘要。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('M-4：對話任務的工作區互斥', () => {
  it('另一個任務的 AI 正在改父目錄時，子目錄裡的新對話被拒絕（409）；那邊做完後可以開始', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-busy-'));
    const repo = join(root, 'repo');
    const sub = join(repo, 'packages', 'app');
    const wt = join(repo, '.acc-worktrees', 'task-1');
    mkdirSync(sub, { recursive: true });
    mkdirSync(wt, { recursive: true });
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    const bus = new EventBus({ log: () => undefined });
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: repo, log: () => undefined });
    let release: () => void = () => undefined;
    const busy = new Promise<void>((resolve) => (release = resolve));
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      if (ctx.prompt === 'long job') await busy;
    });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: () => undefined }));
    const rec = busRecorder(bus);
    cleanups.push(() => {
      release();
      rec.dispose();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });

    // 一個已經答完話、閒著的舊對話：不擋路
    await orchestrator.createTask({ title: 'idle', prompt: 'hello', agentId: 'claude', workflow: 'manual', cwd: repo });
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();

    // 另一個任務在倉庫根目錄里正在工作
    await orchestrator.createTask({ title: 'busy', prompt: 'long job', agentId: 'claude', workflow: 'manual', cwd: repo });
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'coding' && rec.events.filter((x) => x.type === 'agent.status' && x.data.status === 'coding').length >= 2);
    await orchestrator.idle();

    // 子目錄裡的新對話：拒絕
    const error = await orchestrator.createTask({ title: 'sub', prompt: 'edit', agentId: 'claude', workflow: 'manual', cwd: sub }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceBusyError);
    expect((error as WorkspaceBusyError).message).toContain('互相覆蓋');

    // 獨立 worktree：不算衝突
    await expect(orchestrator.createTask({ title: 'wt', prompt: 'edit', agentId: 'claude', workflow: 'manual', cwd: wt })).resolves.toBeDefined();

    // 那邊做完之後：可以開始
    release();
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed' && rec.events.filter((x) => x.type === 'agent.status' && x.data.status === 'completed').length >= 3);
    await orchestrator.idle();
    await expect(orchestrator.createTask({ title: 'sub2', prompt: 'edit', agentId: 'claude', workflow: 'manual', cwd: sub })).resolves.toBeDefined();
  });
});

describe('交接附帶的活動摘要', () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>, agentId = 'claude'): UnifiedEvent =>
    ({ id: `e${++seq}`, projectId: 'p', taskId: 't', runId: 'r', agentId, sequence: seq, timestamp: 0, severity: 'info', confidence: 'confirmed', type, data }) as UnifiedEvent;

  it('只列最近一次指令之後執行過的命令、寫過的檔案和測試結果；唯讀工具不列；同樣的輸入得到同樣的摘要', () => {
    const events = [
      ev('tool.started', { toolCallId: 'old', toolName: 'Bash', toolInput: { command: 'echo old' } }),
      ev('tool.completed', { toolCallId: 'old', toolName: 'Bash', exitCode: 0 }),
      ev('agent.message', { direction: 'to-agent', message: 'fix the bug' }),
      ev('tool.started', { toolCallId: 'r', toolName: 'Read', toolInput: { file_path: 'a.js' } }),
      ev('tool.completed', { toolCallId: 'r', toolName: 'Read' }),
      ev('tool.started', { toolCallId: 'w', toolName: 'Write', toolInput: { file_path: 'a.js', content: 'x' } }),
      ev('tool.completed', { toolCallId: 'w', toolName: 'Write' }),
      ev('tool.started', { toolCallId: 'b', toolName: 'Bash', toolInput: { command: 'npm test' } }),
      ev('tool.failed', { toolCallId: 'b', toolName: 'Bash', exitCode: 1 }),
    ];
    const summary = activitySummary(events, 'claude');
    expect(summary).toBe(['- Write: a.js -> ok', '- Bash: npm test -> failed (exit 1)', 'files written: a.js'].join('\n'));
    expect(activitySummary(events, 'claude')).toBe(summary);
    expect(summary).not.toContain('echo old');
    expect(activitySummary(events, 'codex')).toBe('');
  });
});
