import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunningServer } from '@acc/server';
import { startServer } from '@acc/server';
import { EditingAgent } from './fakes/editing-agent.js';
import { authHeaders, createServerSandbox, sandboxServerOptions } from './fakes/server-sandbox.js';

/**
 * P2-11 多個實現擇一（best-of-N）：同一個要求交給兩個 AI，各自在獨立的 worktree 裡做；
 * 比較給出確定性的推薦（這裡兩份都沒有測試，改動少的那份優先）；選定後合入它，另一份放棄並刪除 worktree。
 */

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('P2-11：多個 AI 各做一份，再選一份', () => {
  it('建立一組 → 比較與推薦 → 選定合入，另一份清理', async () => {
    const box = createServerSandbox('acc-best-');
    cleanups.push(() => {
      try {
        box.cleanup();
      } catch {
        // Windows 偶爾佔用
      }
    });
    const git = (...args: string[]) => execFileSync('git', ['-C', box.workspace, ...args], { stdio: 'ignore' });
    git('init');
    writeFileSync(join(box.workspace, 'a.txt'), 'original\n');
    git('add', '-A');
    git('commit', '-m', 'init');

    const claude = new EditingAgent([(cwd) => writeFileSync(join(cwd, 'a.txt'), 'small fix\n')], { id: 'claude', name: 'Claude', kind: 'claude' });
    const codex = new EditingAgent(
      [
        (cwd) => {
          writeFileSync(join(cwd, 'a.txt'), 'bigger\nfix\nwith\nmore\nlines\n');
          writeFileSync(join(cwd, 'extra.txt'), 'extra\n');
        },
      ],
      { id: 'codex', name: 'Codex', kind: 'codex' },
    );
    const server: RunningServer = await startServer(sandboxServerOptions(box, [claude, codex]));
    cleanups.push(() => server.close());
    const call = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await server.app.inject({ method, url, headers: authHeaders(server), ...(payload ? { payload: payload as Record<string, unknown> } : {}) });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> };
    };

    const created = await call('POST', '/api/groups', { prompt: 'fix a.txt', agentIds: ['claude', 'codex'] });
    expect(created.status).toBe(201);
    const groupId = String(created.body.groupId);
    await server.orchestrator.idle();

    let group = (await call('GET', `/api/groups/${groupId}`)).body as { recommended: string; candidates: Array<{ taskId: string; agentId: string; files: number; insertions: number; busy: boolean }> };
    for (let i = 0; i < 50 && group.candidates.some((c) => c.busy); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      group = (await call('GET', `/api/groups/${groupId}`)).body as typeof group;
    }
    expect(group.candidates.map((c) => c.agentId)).toEqual(['claude', 'codex']);
    expect(group.candidates.map((c) => c.files)).toEqual([1, 2]);
    const claudeTask = group.candidates[0]!.taskId;
    expect(group.recommended).toBe(claudeTask);

    const picked = await call('POST', `/api/groups/${groupId}/pick`, { taskId: claudeTask, mode: 'merge' });
    expect(picked.status).toBe(200);
    expect(readFileSync(join(box.workspace, 'a.txt'), 'utf8')).toBe('small fix\n');
    expect(existsSync(join(box.workspace, 'extra.txt'))).toBe(false);
    const after = (await call('GET', `/api/groups/${groupId}`)).body as { candidates: Array<{ merged: boolean; cleaned: boolean }> };
    expect(after.candidates.map((c) => [c.merged, c.cleaned])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(execFileSync('git', ['-C', box.workspace, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(2);
  }, 60_000);
});
