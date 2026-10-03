import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceCheckpointer, WorkspaceDiff, WorkspaceSnapshot } from '@acc/core';

const exec = promisify(execFile);

/**
 * 工作區檢查點（P2-3，參考 t3code 的隱藏 ref 與 Cline 的影子 git）。
 *
 * 每一輪 AI 做完，給整個倉庫的工作區拍一張快照：用一份臨時的 git 索引把當前檔案寫成一個 tree，
 * 再建一個提交掛在隱藏引用 `refs/acc/checkpoints/<任務>/<序號>` 下。
 * 不切換分支、不動使用者的暫存區（GIT_INDEX_FILE 指向臨時檔案）、不在任何分支上留下提交；遵守 .gitignore。
 * 不是 git 倉庫的目錄沒有檢查點（返回 undefined），其餘功能照常。
 */

const MAX_DIFF_BYTES = 400_000;

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  // 按原始位元組處理（不做換行符轉換）：Windows 上 core.autocrlf=true 時，快照和恢復都會改動換行符，
  // 恢復出來的檔案和 AI 改動之前的不一樣（git 顯示為“已修改”）
  const { stdout } = await exec('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return stdout;
}

async function repoRoot(cwd: string): Promise<string | undefined> {
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return undefined;
  }
}

export class GitCheckpointer implements WorkspaceCheckpointer {
  async snapshot(cwd: string, input: { taskId: string; seq: number; label: string; parent?: string }): Promise<WorkspaceSnapshot | undefined> {
    const root = await repoRoot(cwd);
    if (!root) return undefined;
    const tree = await this.writeTree(root);
    // 和上一個檢查點的內容一樣（這一輪沒有改動檔案）：不另建檢查點
    if (input.parent) {
      const parentTree = (await git(root, ['rev-parse', `${input.parent}^{tree}`]).catch(() => '')).trim();
      if (parentTree === tree) return { ref: input.parent, tree, changed: false };
    }
    let head = '';
    try {
      head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
    } catch {
      // 還沒有任何提交的倉庫：檢查點沒有父提交
    }
    const parent = input.parent ?? head;
    const args = ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `acc checkpoint ${input.taskId} #${input.seq}: ${input.label}`];
    const commit = (
      await git(root, args, { GIT_AUTHOR_NAME: 'Agent Control Center', GIT_AUTHOR_EMAIL: 'acc@local.invalid', GIT_COMMITTER_NAME: 'Agent Control Center', GIT_COMMITTER_EMAIL: 'acc@local.invalid' })
    ).trim();
    const ref = `refs/acc/checkpoints/${input.taskId.slice(0, 8)}/${input.seq}`;
    await git(root, ['update-ref', ref, commit]);
    return { ref: commit, tree, changed: true };
  }

  async diff(cwd: string, from: string, to?: string): Promise<WorkspaceDiff | undefined> {
    const root = await repoRoot(cwd);
    if (!root) return undefined;
    // 沒有給 to：和當前工作區比較（拍一張不掛引用的臨時快照）
    const target = to ?? (await this.writeTree(root));
    const nameStatus = (await git(root, ['diff', '--name-status', '--no-renames', from, target])).trim();
    const files = nameStatus
      ? nameStatus.split('\n').map((line) => {
          const [status, ...rest] = line.split('\t');
          return { status: (status ?? 'M').slice(0, 1) as 'A' | 'M' | 'D', path: rest.join('\t') };
        })
      : [];
    let patch = await git(root, ['diff', '--no-renames', '--no-color', from, target]);
    const truncated = patch.length > MAX_DIFF_BYTES;
    if (truncated) patch = `${patch.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated)\n`;
    return { files, patch, truncated };
  }

  async restore(cwd: string, to: string): Promise<{ restored: string[] }> {
    const root = await repoRoot(cwd);
    if (!root) throw new Error(`Not a git repository: ${cwd}`);
    const current = await this.writeTree(root);
    const changes = (await git(root, ['diff', '--name-status', '--no-renames', to, current])).trim();
    const restored: string[] = [];
    for (const line of changes ? changes.split('\n') : []) {
      const [status, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const full = resolve(root, path);
      // 防禦：路徑必須在倉庫裡面
      if (!isAbsolute(full) || !(full === root || full.startsWith(`${resolve(root)}${sep}`))) continue;
      if (status === 'A') {
        // 這一輪新增的檔案：刪掉
        if (existsSync(full)) await unlink(full);
      } else {
        // 被改動或刪除的檔案：只恢復工作區（--worktree），不動使用者的暫存區
        await git(root, ['restore', `--source=${to}`, '--worktree', '--', path]);
      }
      restored.push(path);
    }
    return { restored };
  }

  /** 用臨時索引把當前工作區寫成一個 tree（不影響使用者的暫存區）。 */
  private async writeTree(root: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'acc-index-'));
    const index = join(dir, 'index');
    const env = { GIT_INDEX_FILE: index };
    try {
      try {
        await git(root, ['read-tree', 'HEAD'], env);
      } catch {
        // 沒有提交：從空索引開始
      }
      await git(root, ['add', '-A', '--', '.'], env);
      return (await git(root, ['write-tree'], env)).trim();
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
