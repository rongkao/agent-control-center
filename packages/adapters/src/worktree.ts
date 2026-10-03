import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * 任務 worktree 管理（P3.4）。
 *
 * 為任務在倉庫內建立獨立的 git worktree（`.acc-worktrees/<name>`，分支 `acc/<name>`），
 * 讓寫程式碼的 agent 在隔離的工作區裡改動，不與其他任務共享同一個工作目錄。
 * `.acc-worktrees/` 寫入 `.git/info/exclude`，不修改倉庫裡被跟蹤的 .gitignore。
 */
export interface TaskWorktree {
  path: string;
  branch: string;
  repoRoot: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { windowsHide: true });
  return stdout.trim();
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function createTaskWorktree(repoPath: string, name: string): Promise<TaskWorktree> {
  return createTaskWorktreeAt(repoPath, name, 'HEAD');
}

/** 從指定提交建立任務 worktree（P2-3 的分叉用；預設是 HEAD）。 */
export async function createTaskWorktreeAt(repoPath: string, name: string, base: string): Promise<TaskWorktree> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`Invalid worktree name: ${name}`);
  if (!(await isGitRepository(repoPath))) throw new Error(`Not a git repository: ${repoPath}`);
  const repoRoot = await git(repoPath, ['rev-parse', '--show-toplevel']);
  const commonDir = await git(repoRoot, ['rev-parse', '--git-common-dir']);
  const excludeFile = join(commonDir.match(/^([A-Za-z]:|\/)/) ? commonDir : join(repoRoot, commonDir), 'info', 'exclude');

  // 忽略 worktree 目錄（只寫本地 exclude，不改被跟蹤檔案）
  let exclude = '';
  try {
    exclude = await readFile(excludeFile, 'utf8');
  } catch {
    await mkdir(join(excludeFile, '..'), { recursive: true });
  }
  if (!exclude.split(/\r?\n/).includes('.acc-worktrees/')) {
    await appendFile(excludeFile, `${exclude.endsWith('\n') || !exclude ? '' : '\n'}.acc-worktrees/\n`);
  }

  const path = join(repoRoot, '.acc-worktrees', name);
  const branch = `acc/${name}`;
  // 倉庫還沒有任何提交時無法建立 worktree，給出明確錯誤
  try {
    await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
  } catch {
    throw new Error('Repository has no commits yet; commit once before using task worktrees');
  }
  // 目錄或分支已經存在（名字衝突）：直接失敗，絕不去動別人的 worktree 和分支
  if (existsSync(path) || (await git(repoRoot, ['branch', '--list', branch]))) {
    throw new Error(`Worktree ${path} or branch ${branch} already exists`);
  }
  try {
    await git(repoRoot, ['worktree', 'add', '-b', branch, path, base]);
  } catch (error) {
    // 檢出中途失敗時 git 可能已經建好了分支：一併回滾，不留下半成品
    await removeTaskWorktree({ path, branch, repoRoot }).catch(() => undefined);
    throw error;
  }
  return { path, branch, repoRoot };
}

/**
 * 回滾一個剛建立、還沒有任務使用的 worktree：刪除工作目錄和對應的 acc/* 分支（P0-1 / L-12）。
 * 只用於“建立任務失敗”的回滾路徑；已有任務引用的 worktree 不應呼叫它。
 */
export async function removeTaskWorktree(worktree: TaskWorktree): Promise<void> {
  const problems: string[] = [];
  try {
    await git(worktree.repoRoot, ['worktree', 'remove', '--force', worktree.path]);
  } catch (error) {
    problems.push((error as Error).message);
  }
  // 目錄已不存在但登記還在時，prune 清掉登記，分支才能刪除
  await git(worktree.repoRoot, ['worktree', 'prune']).catch(() => undefined);
  try {
    if (await git(worktree.repoRoot, ['branch', '--list', worktree.branch])) {
      await git(worktree.repoRoot, ['branch', '-D', worktree.branch]);
    }
  } catch (error) {
    problems.push((error as Error).message);
  }
  if (problems.length) throw new Error(`Failed to roll back worktree ${worktree.path}: ${problems.join('; ')}`);
}
