import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '@acc/core';
import type { RunningServer, StartServerOptions } from '@acc/server';
import { startServer } from '@acc/server';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';
import { authHeaders, createServerSandbox, sandboxServerOptions, type ServerSandbox } from './fakes/server-sandbox.js';

/**
 * P0-1（L-12）：建立任務的輸入校驗。
 * 現象：cwd 可以是任意字串（相對路徑、不存在的目錄、控制面資料目錄）；不校驗 agentId 是否具備所需能力
 * （未知 agent 得到 500）；worktree 在校驗之前就已建立，校驗失敗後留下目錄和分支。
 */

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length) await cleanups.pop()!();
});

function sandbox(): ServerSandbox {
  const box = createServerSandbox('acc-input-');
  cleanups.push(box.cleanup);
  return box;
}

/** claude：可實現；codex：只能分析；test：測試執行器。 */
function agents(): AgentAdapter[] {
  const world = new FakeWorld();
  return [
    new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }]),
    new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-B' }], { id: 'codex', name: 'Codex', kind: 'codex', capabilities: ['analysis', 'review'] }),
    new ScriptedAdapter(world, [{ kind: 'complete' }], { id: 'test', name: 'Test', kind: 'test', capabilities: ['test'] }),
  ];
}

async function boot(box: ServerSandbox, adapters: AgentAdapter[] = agents(), overrides: Partial<StartServerOptions> & { env?: Record<string, string | undefined> } = {}) {
  const server = await startServer(sandboxServerOptions(box, adapters, overrides));
  cleanups.push(() => server.close());
  return server;
}

function post(server: RunningServer, url: string, payload: Record<string, unknown>) {
  return server.app.inject({ method: 'POST', url, headers: authHeaders(server), payload });
}

/** 一個有一次提交的 git 倉庫（worktree 需要）。 */
function gitRepo(dir: string): (...args: string[]) => string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  return git;
}

/** 倉庫裡沒有任何任務 worktree 和 acc/* 分支。 */
function expectNoWorktree(git: (...args: string[]) => string, repo: string) {
  expect(git('branch', '--list', 'acc/*').trim()).toBe('');
  expect(git('worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).length).toBe(1);
  const dir = join(repo, '.acc-worktrees');
  expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
}

describe('L-12 cwd 必須是已存在的絕對目錄', () => {
  it('相對路徑、不存在的目錄、檔案：400，且不建立任務', async () => {
    const box = sandbox();
    const server = await boot(box);
    const file = join(box.root, 'a-file.txt');
    writeFileSync(file, 'x');
    for (const cwd of ['relative/project', '.', join(box.root, 'does-not-exist'), file]) {
      const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd });
      expect({ cwd, status: response.statusCode }).toEqual({ cwd, status: 400 });
      expect(typeof response.json().error).toBe('string');
    }
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('cwd 落在控制面資料目錄內：400', async () => {
    const box = sandbox();
    const server = await boot(box);
    const inside = join(box.data, 'project');
    mkdirSync(inside, { recursive: true });
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: inside });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain(box.data);
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('預設不限制根目錄：工作區以外的任意已存在目錄都可以', async () => {
    const box = sandbox();
    const server = await boot(box);
    const elsewhere = join(box.root, 'other-project');
    mkdirSync(elsewhere);
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: elsewhere });
    expect(response.statusCode).toBe(201);
  });

  it('設定 ACC_ALLOWED_ROOTS 後：根目錄之外 400，之內 201', async () => {
    const box = sandbox();
    const allowedA = join(box.root, 'projects-a');
    const allowedB = join(box.root, 'projects-b');
    mkdirSync(join(allowedA, 'app'), { recursive: true });
    mkdirSync(allowedB);
    const outside = join(box.root, 'outside');
    mkdirSync(outside);
    const server = await boot(box, agents(), { env: { ACC_ALLOWED_ROOTS: [allowedA, allowedB].join(delimiter) } });
    const denied = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: outside });
    expect(denied.statusCode).toBe(400);
    expect(String(denied.json().error)).toContain('ACC_ALLOWED_ROOTS');
    expect((await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: join(allowedA, 'app') })).statusCode).toBe(201);
    expect((await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', cwd: allowedB, sharedWorkspace: true })).statusCode).toBe(201);
  });
});

describe('L-12 agentId 必須具備所需能力', () => {
  it('未知 agent：400（不是 500）', async () => {
    const box = sandbox();
    const server = await boot(box);
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'gpt-9' });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('gpt-9');
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('自動流程需要 implement 能力；只能分析的 agent 可以對話但不能負責自動流程', async () => {
    const box = sandbox();
    const server = await boot(box);
    const workflow = await post(server, '/api/tasks', { prompt: 'x', agentId: 'codex', workflow: 'implementation-v1' });
    expect(workflow.statusCode).toBe(400);
    expect(await server.store.listTasks()).toEqual([]);
    const chat = await post(server, '/api/tasks', { prompt: 'x', agentId: 'codex', workflow: 'manual' });
    expect(chat.statusCode).toBe(201);
  });

  it('測試執行器不能作為對話 / 實現的 agent', async () => {
    const box = sandbox();
    const server = await boot(box);
    for (const workflow of ['manual', 'implementation-v1']) {
      const response = await post(server, '/api/tasks', { prompt: 'npm test', agentId: 'test', workflow });
      expect({ workflow, status: response.statusCode }).toEqual({ workflow, status: 400 });
    }
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('帶測試命令但沒有具備 test 能力的執行器：400', async () => {
    const box = sandbox();
    const server = await boot(box, [new ScriptedAdapter(new FakeWorld(), [{ kind: 'complete' }])]);
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', testCommand: 'npm test' });
    expect(response.statusCode).toBe(400);
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('給未知 agent 發訊息 / 交接 / 換人：400', async () => {
    const box = sandbox();
    const server = await boot(box);
    const created = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', workflow: 'manual' });
    expect(created.statusCode).toBe(201);
    await server.orchestrator.idle();
    const taskId = created.json().id as string;
    expect((await post(server, `/api/tasks/${taskId}/message`, { agentId: 'nobody', message: 'hi' })).statusCode).toBe(400);
    expect((await post(server, `/api/tasks/${taskId}/handoff`, { fromAgentId: 'claude', toAgentId: 'nobody', content: 'c' })).statusCode).toBe(400);
    expect((await post(server, `/api/tasks/${taskId}/reassign`, { toAgentId: 'nobody' })).statusCode).toBe(400);
    expect((await post(server, `/api/tasks/${taskId}/ask-both`, { message: 'm', primaryAgentId: 'nobody' })).statusCode).toBe(400);
  });
});

describe('L-12 worktree 只在全部校驗通過後建立，失敗不留下目錄和分支', () => {
  it('校驗失敗（未知 agent、能力不足、缺少測試執行器）：400，倉庫裡沒有 worktree 和 acc/* 分支', async () => {
    const box = sandbox();
    const repo = join(box.root, 'repo');
    const git = gitRepo(repo);
    const server = await boot(box, agents().filter((agent) => agent.info.id !== 'test'));
    const cases = [
      { prompt: 'x', agentId: 'nobody', worktree: true, cwd: repo },
      { prompt: 'x', agentId: 'codex', workflow: 'implementation-v1', worktree: true, cwd: repo },
      { prompt: 'x', agentId: 'claude', testCommand: 'npm test', worktree: true, cwd: repo },
    ];
    for (const payload of cases) {
      const response = await post(server, '/api/tasks', payload);
      expect({ payload, status: response.statusCode }).toEqual({ payload, status: 400 });
    }
    expectNoWorktree(git, repo);
    expect(await server.store.listTasks()).toEqual([]);
  });

  it('建立任務本身失敗（任務沒有落盤）：已建立的 worktree 和分支被回滾', async () => {
    const box = sandbox();
    const repo = join(box.root, 'repo');
    const git = gitRepo(repo);
    const server = await boot(box);
    vi.spyOn(server.orchestrator, 'createTask').mockRejectedValueOnce(new Error('simulated failure before the task was persisted'));
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', worktree: true, cwd: repo });
    expect(response.statusCode).toBe(500);
    expectNoWorktree(git, repo);
  });

  it('全部校驗通過：建立 worktree 與任務', async () => {
    const box = sandbox();
    const repo = join(box.root, 'repo');
    const git = gitRepo(repo);
    const server = await boot(box);
    const response = await post(server, '/api/tasks', { prompt: 'x', agentId: 'claude', worktree: true, cwd: repo });
    expect(response.statusCode).toBe(201);
    expect(git('branch', '--list', 'acc/*').trim()).toMatch(/acc\/task-/);
    cleanups.push(() => {
      try {
        for (const line of git('worktree', 'list', '--porcelain').split(/\r?\n/)) {
          if (line.startsWith('worktree ') && line.includes('.acc-worktrees')) git('worktree', 'remove', '--force', line.slice('worktree '.length));
        }
      } catch {
        // 目錄會隨臨時目錄一起刪除
      }
    });
  });
});
