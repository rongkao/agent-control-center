import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskWorktree, isGitRepository } from '@acc/adapters';
import { EventBus, Orchestrator, summarizeTask, summarizeUsage } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from './fakes/workflow-agent.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(options: { workspacePolicy?: 'exclusive' | 'shared'; defaultCwd?: string } = {}) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus(), options);
  // silent：實現 agent 一直“在工作”，任務保持活躍
  orchestrator.registerAdapter(new WorkflowAgent({ id: 'claude', kind: 'claude' }, [], { kind: 'silent' }));
  orchestrator.registerAdapter(new WorkflowAgent({ id: 'codex', kind: 'codex' }));
  orchestrator.registerAdapter(new WorkflowAgent({ id: 'test', kind: 'test' }, [], { kind: 'test', passed: true }));
  return { store, orchestrator };
}

describe('worktree isolation (P3.4)', () => {
  it('two active write-capable tasks cannot share a workspace without explicit policy', async () => {
    const dir = tempDir('acc-ws-');
    const { orchestrator } = boot();
    await orchestrator.createTask({ title: 'a', prompt: 'p', cwd: dir });
    await expect(orchestrator.createTask({ title: 'b', prompt: 'p', cwd: dir })).rejects.toThrow(/Workspace conflict/);
    // 路徑大小寫/相對形式不同也視為同一工作區
    await expect(orchestrator.createTask({ title: 'c', prompt: 'p', cwd: `${dir}/.` })).rejects.toThrow(/Workspace conflict/);
  });

  it('the default workspace counts as a workspace too', async () => {
    const dir = tempDir('acc-ws-');
    const { orchestrator } = boot({ defaultCwd: dir });
    await orchestrator.createTask({ title: 'a', prompt: 'p' });
    await expect(orchestrator.createTask({ title: 'b', prompt: 'p' })).rejects.toThrow(/Workspace conflict/);
  });

  it('explicit shared policy on both tasks allows sharing; finished tasks release the workspace', async () => {
    const dir = tempDir('acc-ws-');
    const { orchestrator } = boot();
    const a = await orchestrator.createTask({ title: 'a', prompt: 'p', cwd: dir, sharedWorkspace: true });
    await expect(orchestrator.createTask({ title: 'b', prompt: 'p', cwd: dir, sharedWorkspace: true })).resolves.toBeDefined();

    const other = tempDir('acc-ws-');
    const c = await orchestrator.createTask({ title: 'c', prompt: 'p', cwd: other });
    await orchestrator.cancelTask(c.id);
    await expect(orchestrator.createTask({ title: 'd', prompt: 'p', cwd: other })).resolves.toBeDefined();
    expect(a.id).toBeTruthy();
  });

  it('creates an isolated git worktree per task and keeps it out of git status', async () => {
    const repo = tempDir('acc-repo-');
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git('add', '.');
    git('commit', '-qm', 'init');

    expect(await isGitRepository(repo)).toBe(true);
    const wt = await createTaskWorktree(repo, 'task-123');
    cleanups.unshift(() => {
      try {
        git('worktree', 'remove', '--force', wt.path);
      } catch {
        // 目錄會隨臨時目錄一起刪除
      }
    });
    expect(wt.branch).toBe('acc/task-123');
    expect(existsSync(join(wt.path, 'README.md'))).toBe(true);
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('.acc-worktrees/');

    // 兩個任務各自使用自己的 worktree，可以並行
    const wt2 = await createTaskWorktree(repo, 'task-456');
    const { orchestrator } = boot();
    await orchestrator.createTask({ title: 'a', prompt: 'p', cwd: wt.path, workspace: { kind: 'worktree', repoPath: repo, branch: wt.branch } });
    await expect(orchestrator.createTask({ title: 'b', prompt: 'p', cwd: wt2.path })).resolves.toBeDefined();
    await expect(createTaskWorktree(repo, '../escape')).rejects.toThrow(/Invalid worktree name/);
  });

  it('non-git directories are rejected for worktrees', async () => {
    await expect(createTaskWorktree(tempDir('acc-plain-'), 'x')).rejects.toThrow(/Not a git repository/);
  });
});

describe('usage and task summaries (P3.2/P3.3)', () => {
  it('aggregates calls, tokens, failures, stalls and review rounds per agent', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus();
    const orchestrator = new Orchestrator(store, bus);
    orchestrator.registerAdapter(new WorkflowAgent({ id: 'claude', kind: 'claude' }));
    orchestrator.registerAdapter(new WorkflowAgent({ id: 'codex', kind: 'codex' }, [{ kind: 'reply', text: 'diagnosis' }]));
    orchestrator.registerAdapter(new WorkflowAgent({ id: 'test', kind: 'test' }, [{ kind: 'test', passed: false }, { kind: 'test', passed: false }, { kind: 'test', passed: true }]));
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', testCommand: 'npm test' });
    await orchestrator.idle();
    await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', type: 'model.turn.completed', severity: 'info', confidence: 'confirmed', data: { usage: { inputTokens: 100, outputTokens: 50, cachedTokens: 10, durationMs: 1000 } } });
    await orchestrator.idle();

    const run = (await store.getRun(task.runId))!;
    const summary = summarizeUsage([{ run, usage: await store.listUsage(task.runId), events: await store.listEvents(task.runId) }]);
    expect(summary.runs).toBe(1);
    expect(summary.totals).toMatchObject({ agentCalls: 7, turns: 1, inputTokens: 100, outputTokens: 50, reportedTokens: 150 });
    const byAgent = Object.fromEntries(summary.byAgent.map((x) => [x.agentId, x]));
    expect(byAgent.claude).toMatchObject({ agentCalls: 1, inputTokens: 100 });
    expect(byAgent.codex).toMatchObject({ agentCalls: 1 });
    expect(byAgent.test?.agentCalls).toBe(1);

    const t = summarizeTask((await store.getTask(task.id))!, run);
    expect(t).toMatchObject({ status: 'COMPLETED', workflowStep: 'done', pendingApprovals: 0 });
  });

  it('task summary exposes blocker, pending approvals and recovery marker', () => {
    const summary = summarizeTask(
      { id: 't', projectId: 'p', title: 'x', prompt: 'y', status: 'BLOCKED', workflow: 'w', runId: 'r', createdAt: 1, updatedAt: 2, currentAction: 'Cannot prove provider runtime state after restart' },
      {
        schemaVersion: 3, runId: 'r', projectId: 'p', taskId: 't', status: 'BLOCKED', workflow: 'w', currentStep: 'blocked:RUNTIME_DISCONNECTED',
        agentSessions: {}, pendingApprovals: [{ id: 'a', agentId: 'claude', summary: 's', createdAt: 1, status: 'pending' }], pendingInputs: [],
        budget: { maxTurns: 1, maxAgentCalls: 1, maxReviewRounds: 1, maxStallCount: 1, maxDurationMs: 1, turnsUsed: 0, agentCallsUsed: 0, reviewRoundsUsed: 0, stallCount: 0, estimatedTokensUsed: 0, startedAt: 0 },
        completedSideEffects: [], progressSinceLastTurn: false, recovery: { recoveredAt: 5, count: 2 }, lastSequence: 3, createdAt: 1, updatedAt: 2,
      },
    );
    expect(summary).toMatchObject({ pendingApprovals: 1, recovered: { count: 2, at: 5 }, blocker: 'Cannot prove provider runtime state after restart' });
  });
});
