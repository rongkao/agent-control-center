import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeError, cleanupTaskWorktree, createTaskWorktree, findOrphanWorktrees, mergeTaskWorktree, previewWorktreeMerge, setupTaskWorktree } from '@acc/adapters';

/**
 * P2-4 worktree 生命週期：準備（依賴連結 + setup 腳本）、合入閘門（預覽、衝突預檢、merge / apply）、清理、孤兒檢測。
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
  const dir = mkdtempSync(join(tmpdir(), 'acc-wt-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.autocrlf=false', ...args], { stdio: 'ignore' });
  git('init');
  writeFileSync(join(dir, 'app.js'), 'line1\nline2\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  return dir;
}
const gitOut = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

describe('P2-4：worktree 生命週期', () => {
  it('準備：連結被忽略的 node_modules，並執行 .acc/setup 腳本', async () => {
    const dir = repo();
    const script = process.platform === 'win32' ? 'setup.ps1' : 'setup.sh';
    mkdirSync(join(dir, '.acc'));
    writeFileSync(join(dir, '.acc', script), process.platform === 'win32' ? "Set-Content -Path ready.txt -Value 'ok'\n" : 'echo ok > ready.txt\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-m', 'setup'], { stdio: 'ignore' });
    const wt = await createTaskWorktree(dir, 'task-setup');
    const result = await setupTaskWorktree(wt);
    expect(result.linked).toEqual(['node_modules']);
    expect(existsSync(join(wt.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(result.script?.ok).toBe(true);
    expect(existsSync(join(wt.path, 'ready.txt'))).toBe(true);
    // 連結進來的依賴目錄不算改動
    expect(gitOut(wt.path, 'status', '--porcelain')).not.toContain('node_modules');
    await cleanupTaskWorktree(wt);
  }, 60_000);

  it('預覽 → merge 合入 → 清理；主倉庫有未提交改動時拒絕', async () => {
    const dir = repo();
    const wt = await createTaskWorktree(dir, 'task-merge');
    writeFileSync(join(wt.path, 'app.js'), 'line1\nline2 fixed\n');
    writeFileSync(join(wt.path, 'new.js'), 'new\n');

    const preview = await previewWorktreeMerge(wt);
    expect(preview.branch).toBe('acc/task-merge');
    expect(preview.conflicts).toEqual([]);
    expect(preview.baseDirty).toBe(false);
    expect(preview.files.map((f) => f.path).sort()).toEqual(['app.js', 'new.js']);
    expect(preview.commands.merge.join('\n')).toContain('merge --no-ff');
    // 預覽不改動任何東西
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe('line1\nline2\n');

    // 主倉庫有未提交改動：拒絕
    writeFileSync(join(dir, 'app.js'), 'line1\nline2\nlocal\n');
    await expect(mergeTaskWorktree(wt, 'merge', 'acc: test')).rejects.toBeInstanceOf(MergeError);
    execFileSync('git', ['-C', dir, 'checkout', '--', 'app.js'], { stdio: 'ignore' });

    const merged = await mergeTaskWorktree(wt, 'merge', 'acc: test');
    expect(merged.files).toBe(2);
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe('line1\nline2 fixed\n');
    expect(existsSync(join(dir, 'new.js'))).toBe(true);

    await cleanupTaskWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(gitOut(dir, 'branch', '--list', 'acc/task-merge')).toBe('');
  }, 60_000);

  it('衝突：預覽報告衝突檔案；合入被撤回，主倉庫不變', async () => {
    const dir = repo();
    const wt = await createTaskWorktree(dir, 'task-conflict');
    writeFileSync(join(wt.path, 'app.js'), 'line1\nfrom task\n');
    // 主倉庫同時改了同一行並提交
    writeFileSync(join(dir, 'app.js'), 'line1\nfrom main\n');
    execFileSync('git', ['-C', dir, 'commit', '-am', 'main change'], { stdio: 'ignore' });

    const preview = await previewWorktreeMerge(wt);
    expect(preview.conflicts).toEqual(['app.js']);
    const error = await mergeTaskWorktree(wt, 'merge', 'acc: test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeError);
    expect((error as MergeError).conflicts).toEqual(['app.js']);
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe('line1\nfrom main\n');
    expect(gitOut(dir, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    await cleanupTaskWorktree(wt);
  }, 60_000);

  it('apply：改動暫存在主倉庫，不產生提交', async () => {
    const dir = repo();
    const head = gitOut(dir, 'rev-parse', 'HEAD');
    const wt = await createTaskWorktree(dir, 'task-apply');
    writeFileSync(join(wt.path, 'app.js'), 'line1\napplied\n');
    await mergeTaskWorktree(wt, 'apply', 'acc: test');
    expect(gitOut(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(gitOut(dir, 'diff', '--cached', '--name-only')).toBe('app.js');
    await cleanupTaskWorktree(wt);
  }, 60_000);

  it('孤兒 worktree：沒有任務引用的目錄被找出來', async () => {
    const dir = repo();
    const a = await createTaskWorktree(dir, 'task-a');
    const b = await createTaskWorktree(dir, 'task-b');
    // Windows 路徑不分大小寫（git 返回的倉庫根目錄大小寫可能和 tmpdir() 不同）
    // 解析成真實路徑再比較（Windows 的暫存目錄可能是 8.3 短檔名，git 回傳的是長檔名）
    const norm = (p: string) => (process.platform === 'win32' ? realpathSync.native(p).toLowerCase() : realpathSync.native(p));
    expect(findOrphanWorktrees(dir, new Set([a.path])).map(norm)).toEqual([norm(b.path)]);
    await cleanupTaskWorktree(a);
    await cleanupTaskWorktree(b);
  }, 60_000);
});

describe('P2-4：換行符', () => {
  it('core.autocrlf=true 的倉庫：沒有改動的 worktree 預覽為 0 個檔案（不會把檢出時的換行符轉換當成改動）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-crlf-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
      git('init');
      git('config', 'core.autocrlf', 'true');
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
      git('add', '-A');
      git('commit', '-m', 'init');
      const wt = await createTaskWorktree(dir, 'task-crlf');
      expect((await previewWorktreeMerge(wt)).files).toEqual([]);
      await cleanupTaskWorktree(wt);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 60_000);
});

describe('P2-4：路徑寫法不同', () => {
  it.runIf(process.platform === 'win32')('同一個倉庫用 8.3 短檔名傳入：不會把任務正在用的 worktree 誤判成孤兒', async () => {
    const dir = repo();
    const a = await createTaskWorktree(dir, 'task-short');
    // 取得倉庫目錄的 8.3 短檔名（這台機器沒有短檔名時跳過比較）
    const short = spawnSync('cmd', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();
    if (short.toLowerCase() !== dir.toLowerCase()) {
      expect(short).toMatch(/~\d/);
      expect(findOrphanWorktrees(short, new Set([a.path]))).toEqual([]);
    }
    await cleanupTaskWorktree(a);
  }, 60_000);
});
