import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { busRecorder } from './fakes/event-waiter.js';
import { FailingStartAgent } from './fakes/failing-start-agent.js';

/**
 * P0-4 審查（medium）：對話任務的工作目錄（例如獨立 worktree）必須持久化在 run 快照裡。
 *
 * 現象（修復前）：對話任務沒有 workflowState，cwd 只存在於記憶體裡的 manualCwd 和會話啟動成功後才寫入的 session.metadata.cwd。
 * 第一次啟動 agent 就失敗（Codex 沒裝 → spawn ENOENT、Claude 初始化超時）時快照裡沒有任何會話；
 * 使用者裝好 CLI、重啟程式後再發訊息，deliver 依次試 workflowState.cwd（無）→ 會話後設資料（無）→ manualCwd（重啟後為空）
 * → defaultCwd，於是新會話在主倉庫以可寫模式啟動——這正是 H-4 描述的後果，只是走的是 start 路徑。
 *
 * 期望：建立對話任務時就把工作目錄持久化進快照；deliver / 換人接手優先用它，不回退到 defaultCwd。
 */

interface Box {
  repo: string;
  wt: string;
  db: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspaceBox(): Box {
  const root = mkdtempSync(join(tmpdir(), 'acc-chat-cwd-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'repo-worktrees', 'task-1');
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { repo, wt, db: join(root, 'agent-control.db') };
}

function openProcess(box: Box) {
  const store = new SqliteControlPlaneStore({ path: box.db });
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: box.repo, log: () => undefined });
  const rec = busRecorder(bus);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rec.dispose();
    store.close();
  };
  cleanups.push(close);
  return { store, bus, orchestrator, rec, close };
}

describe('P0-4 審查：對話任務的工作目錄持久化', () => {
  it('首次啟動失敗 → 重啟後再發訊息：新會話仍在任務的 worktree 裡啟動，不回退到主倉庫', async () => {
    const box = workspaceBox();
    const first = openProcess(box);
    const flaky = new FailingStartAgent({ id: 'codex', kind: 'codex' });
    first.orchestrator.registerAdapter(flaky);
    const task = await first.orchestrator.createTask({
      title: 'chat in worktree',
      prompt: 'fix it',
      agentId: 'codex',
      workflow: 'manual',
      cwd: box.wt,
      workspace: { kind: 'worktree', repoPath: box.repo, branch: 'acc/task-1' },
    });
    await first.bus.drain();
    expect(flaky.starts[0]?.cwd).toBe(box.wt);
    const blocked = await first.store.getRun(task.runId);
    expect(blocked?.status).toBe('BLOCKED');
    expect(blocked?.agentSessions).toEqual({});
    first.close();

    // 使用者裝好了 CLI，重啟程式後再發一條訊息
    const second = openProcess(box);
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['implement'] });
    second.orchestrator.registerAdapter(codex);
    await second.orchestrator.recover();
    // 任務因首次啟動失敗而阻塞：對話任務發訊息前要顯式恢復（P0-7 / H-8，介面上是「恢復並傳送」）
    await second.orchestrator.sendMessage(task.id, 'codex', 'try again', { resume: true });
    await second.bus.drain();
    expect(codex.calls[0]).toMatchObject({ via: 'start', cwd: box.wt });
  });

  it('換人接手（對話任務）同樣沿用任務的工作目錄', async () => {
    const box = workspaceBox();
    const first = openProcess(box);
    first.orchestrator.registerAdapter(new FailingStartAgent({ id: 'claude', kind: 'claude' }));
    first.orchestrator.registerAdapter(new FailingStartAgent({ id: 'codex', kind: 'codex' }));
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'fix it', agentId: 'claude', workflow: 'manual', cwd: box.wt });
    await first.bus.drain();
    first.close();

    const second = openProcess(box);
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['implement'] });
    second.orchestrator.registerAdapter(claude);
    second.orchestrator.registerAdapter(codex);
    await second.orchestrator.recover();
    await second.orchestrator.reassign(task.id, 'codex', 'please take over');
    await second.bus.drain();
    expect(codex.calls[0]).toMatchObject({ via: 'start', cwd: box.wt });
  });
});
