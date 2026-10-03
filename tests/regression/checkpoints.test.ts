import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitCheckpointer } from '@acc/adapters';
import { CheckpointError, EventBus, Orchestrator } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { EditingAgent } from './fakes/editing-agent.js';

/**
 * P2-3 檢查點與撤銷：
 * - 任務開始時拍基線，每一輪改了檔案之後再拍一個（沒改動的輪不拍）；檢查點掛在隱藏引用下，不動分支、不動使用者的暫存區；
 * - 可以檢視每一輪的改動和任務的全部改動；
 * - 撤銷最後一輪：檔案恢復到上一個檢查點（新增的刪掉、改過的還原），是追加事件而不是刪除歷史；連續撤銷一輪一輪往前退。
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 忽略
    }
  }
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-ckpt-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init');
  writeFileSync(join(dir, 'a.txt'), 'original\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  return dir;
}

function boot(cwd: string, edits: Array<(cwd: string) => void>) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: cwd, log: () => undefined, checkpointer: new GitCheckpointer(), workspacePolicy: 'shared' });
  const agent = new EditingAgent(edits);
  orchestrator.registerAdapter(agent);
  return { store, orchestrator, agent };
}

describe('P2-3：檢查點與撤銷', () => {
  it('每一輪拍檢查點、檢視改動、撤銷最後一輪、連續撤銷；不動分支和暫存區', async () => {
    const dir = repo();
    const headBefore = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const env = boot(dir, [
      (cwd) => writeFileSync(join(cwd, 'a.txt'), 'turn one\n'),
      () => undefined, // 這一輪什麼都沒改
      (cwd) => {
        writeFileSync(join(cwd, 'b.txt'), 'new file\n');
        writeFileSync(join(cwd, 'a.txt'), 'turn three\n');
      },
    ]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'one', agentId: 'claude', workflow: 'manual', cwd: dir });
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'claude', 'two');
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'claude', 'three');
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    // 基線 + 第一輪 + 第三輪（第二輪沒有改動，不拍）
    expect(run.checkpoints?.map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(run.checkpoints?.map((c) => c.files)).toEqual([0, 1, 2]);

    // 第三輪的改動
    const turn = await env.orchestrator.checkpointDiff(task.id, 2);
    expect(turn.files).toEqual(expect.arrayContaining([{ status: 'A', path: 'b.txt' }, { status: 'M', path: 'a.txt' }]));
    expect(turn.patch).toContain('+turn three');
    // 全部改動（相對任務開始時）
    const all = await env.orchestrator.checkpointDiff(task.id);
    expect(all.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);

    // 撤銷最後一輪：b.txt 刪掉，a.txt 回到第一輪之後
    const undo = await env.orchestrator.undoLastTurn(task.id);
    expect(undo.to).toBe(1);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('turn one\n');
    // 再撤銷一輪：回到任務開始時
    await env.orchestrator.undoLastTurn(task.id);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('original\n');
    // 已經在基線：沒有可以撤銷的了
    await expect(env.orchestrator.undoLastTurn(task.id)).rejects.toBeInstanceOf(CheckpointError);

    // 歷史只追加：撤銷產生了事件和新的檢查點
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'checkpoint.restored')).toHaveLength(2);
    // 分支和暫存區沒動
    expect(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(headBefore);
    expect(execFileSync('git', ['-C', dir, 'diff', '--cached', '--name-only'], { encoding: 'utf8' }).trim()).toBe('');
    // 檢查點在隱藏引用下
    expect(execFileSync('git', ['-C', dir, 'for-each-ref', 'refs/acc/checkpoints'], { encoding: 'utf8' }).trim()).not.toBe('');
  });

  it('不是 git 倉庫：沒有檢查點，檢視改動給出中文說明', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-nogit-'));
    dirs.push(dir);
    const env = boot(dir, [(cwd) => writeFileSync(join(cwd, 'x.txt'), 'x')]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'one', agentId: 'claude', workflow: 'manual', cwd: dir });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.checkpoints ?? []).toHaveLength(0);
    await expect(env.orchestrator.checkpointDiff(task.id)).rejects.toThrow(/git/);
  });
});

describe('P2-3：從檢查點分叉', () => {
  it('新 worktree 的內容等於檢查點（改動是未提交的），分支歷史裡沒有檢查點提交，原任務不受影響', async () => {
    const { forkWorktreeFromCheckpoint, cleanupTaskWorktree } = await import('@acc/adapters');
    const dir = repo();
    writeFileSync(join(dir, 'gone.txt'), 'will be deleted\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-m', 'add gone'], { stdio: 'ignore' });
    const base = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const env = boot(dir, [
      (cwd) => {
        writeFileSync(join(cwd, 'a.txt'), 'turn one\n');
        writeFileSync(join(cwd, 'new.txt'), 'new\n');
        rmSync(join(cwd, 'gone.txt'));
      },
      (cwd) => writeFileSync(join(cwd, 'a.txt'), 'turn two\n'),
    ]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'one', agentId: 'claude', workflow: 'manual', cwd: dir });
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'claude', 'two');
    await env.orchestrator.idle();

    const { ref, cwd } = await env.orchestrator.checkpointFor(task.id, 1);
    const wt = await forkWorktreeFromCheckpoint(cwd, 'fork-test', ref);
    try {
      expect(readFileSync(join(wt.path, 'a.txt'), 'utf8')).toBe('turn one\n');
      expect(readFileSync(join(wt.path, 'new.txt'), 'utf8')).toBe('new\n');
      expect(existsSync(join(wt.path, 'gone.txt'))).toBe(false);
      // 分支從基準提交開始，檢查點的改動是未提交的
      expect(execFileSync('git', ['-C', wt.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(base);
      expect(execFileSync('git', ['-C', wt.path, 'log', '--format=%s'], { encoding: 'utf8' })).not.toContain('acc checkpoint');
      expect(execFileSync('git', ['-C', wt.path, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('a.txt');
      // 原任務的工作區仍是第二輪之後的樣子
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('turn two\n');
    } finally {
      await cleanupTaskWorktree(wt);
    }
  });
});
