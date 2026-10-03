import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { scanDiffForSecrets, type SecretFinding } from '@acc/core';
import { createTaskWorktreeAt, type TaskWorktree } from './worktree.js';

const exec = promisify(execFile);

/**
 * worktree 生命週期（P2-4，參考 Kilo / Cline Kanban / container-use）：
 * - 準備：新 worktree 裡連結主倉庫的 node_modules（Windows 用 junction，不需要管理員權限），並執行倉庫裡的 setup 腳本，
 *   免得第一次跑測試就因為缺依賴失敗、白白觸發重試和診斷；
 * - 合入閘門：先預覽（要執行的命令、改動的檔案、衝突預檢、主倉庫有沒有未提交的改動），再由操作員選擇 merge 或 apply；
 * - 清理：合入之後刪除 worktree 與 acc/* 分支；Windows 上檔案被佔用時重試並給出原因。
 */

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  // 按使用者自己的換行符設定（core.autocrlf）處理：合入的是真正的改動，不能因為工作區檢出時轉換了換行符就把每個檔案都當成改過
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return stdout;
}

const IDENTITY = { GIT_AUTHOR_NAME: 'Agent Control Center', GIT_AUTHOR_EMAIL: 'acc@local.invalid', GIT_COMMITTER_NAME: 'Agent Control Center', GIT_COMMITTER_EMAIL: 'acc@local.invalid' };

export interface WorktreeSetupResult {
  linked: string[];
  script?: { path: string; ok: boolean; output: string };
}

/** 準備新 worktree：連結依賴目錄、執行 setup 腳本（`.acc/setup.ps1`（Windows）或 `.acc/setup.sh`）。失敗只報告，不丟擲。 */
export async function setupTaskWorktree(wt: TaskWorktree, options: { timeoutMs?: number } = {}): Promise<WorktreeSetupResult> {
  const linked: string[] = [];
  for (const name of ['node_modules']) {
    const source = join(wt.repoRoot, name);
    const target = join(wt.path, name);
    if (!existsSync(source) || existsSync(target)) continue;
    // 只在倉庫忽略它時才連結：否則 worktree 裡的 git add -A 會把整個依賴目錄當成改動
    const ignored = await git(wt.path, ['check-ignore', '-q', `${name}/`]).then(() => true, () => false);
    if (!ignored) continue;
    try {
      symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(name);
      // Linux / macOS 上連結是符號連結（不是目錄），`node_modules/` 這種只匹配目錄的規則忽略不到它：
      // 補一條不帶斜線的規則到本機的 info/exclude（只影響本機，不改被追蹤的 .gitignore）
      const linkIgnored = await git(wt.path, ['check-ignore', '-q', name]).then(() => true, () => false);
      if (!linkIgnored) await addLocalExclude(wt.path, name);
    } catch {
      // 連結失敗（例如檔案系統不支援）：跳過，setup 腳本或 agent 自己安裝依賴
    }
  }
  const scriptPath = process.platform === 'win32' ? join(wt.path, '.acc', 'setup.ps1') : join(wt.path, '.acc', 'setup.sh');
  if (!existsSync(scriptPath)) return { linked };
  const [cmd, args] = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]] : ['sh', [scriptPath]];
  const script = await new Promise<{ path: string; ok: boolean; output: string }>((resolve) => {
    let output = '';
    const child = spawn(cmd, args, { cwd: wt.path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 10 * 60_000);
    child.stdout?.on('data', (d) => (output = (output + String(d)).slice(-4000)));
    child.stderr?.on('data', (d) => (output = (output + String(d)).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ path: scriptPath, ok: false, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ path: scriptPath, ok: code === 0, output });
    });
  });
  return { linked, script };
}

/** 在倉庫本機的 info/exclude 加一條忽略規則（已經有就不加）。 */
async function addLocalExclude(cwd: string, pattern: string): Promise<void> {
  const common = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  const file = join(isAbsolute(common) ? common : join(cwd, common), 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  if (current.split(/\r?\n/).includes(pattern)) return;
  await appendFile(file, `${current.endsWith('\n') || !current ? '' : '\n'}${pattern}\n`);
}

export interface MergePreview {
  baseBranch: string;
  branch: string;
  /** 主倉庫有沒有未提交的改動（有的話不能合入）。 */
  baseDirty: boolean;
  files: Array<{ status: string; path: string }>;
  /** 預檢出的衝突檔案（為空表示可以乾淨合入）。 */
  conflicts: string[];
  /** 新增內容裡疑似金鑰（P2-9）：不為空時預設不合入。 */
  secrets: SecretFinding[];
  /** 合入時會執行的命令（給操作員看）。 */
  commands: { merge: string[]; apply: string[] };
}

/** worktree 裡還沒提交的改動：用臨時索引拍成一個提交（父提交為任務分支），不動 worktree 的暫存區。 */
async function candidateCommit(wt: TaskWorktree): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'acc-merge-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(wt.path, ['read-tree', 'HEAD'], env);
    await git(wt.path, ['add', '-A', '--', '.'], env);
    const tree = (await git(wt.path, ['write-tree'], env)).trim();
    const head = (await git(wt.path, ['rev-parse', 'HEAD'])).trim();
    const headTree = (await git(wt.path, ['rev-parse', 'HEAD^{tree}'])).trim();
    if (tree === headTree) return head;
    return (await git(wt.path, ['commit-tree', tree, '-p', head, '-m', 'acc: merge preview'], IDENTITY)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function baseDirty(repoRoot: string): Promise<boolean> {
  const status = (await git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])).trim();
  return status.split('\n').some((line) => line.trim() && !line.includes('.acc-worktrees/'));
}

export async function previewWorktreeMerge(wt: TaskWorktree): Promise<MergePreview> {
  const baseBranch = (await git(wt.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const candidate = await candidateCommit(wt);
  const base = (await git(wt.repoRoot, ['rev-parse', 'HEAD'])).trim();
  const mergeBase = (await git(wt.repoRoot, ['merge-base', base, candidate])).trim();
  const nameStatus = (await git(wt.repoRoot, ['diff', '--name-status', '--no-renames', mergeBase, candidate])).trim();
  const files = nameStatus ? nameStatus.split('\n').map((line) => ({ status: line.split('\t')[0] ?? 'M', path: line.split('\t').slice(1).join('\t') })) : [];
  // 金鑰掃描（P2-9）：只看新增的行
  const secrets = scanDiffForSecrets(await git(wt.repoRoot, ['diff', '--no-renames', '--no-color', '-U0', mergeBase, candidate]));
  // 衝突預檢：git merge-tree 只在物件庫裡合併，不碰任何工作區（git ≥ 2.38）
  let conflicts: string[] = [];
  try {
    await git(wt.repoRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, candidate]);
  } catch (error) {
    const out = String((error as { stdout?: string }).stdout ?? '');
    conflicts = out.split('\n').slice(1).map((x) => x.trim()).filter(Boolean);
  }
  return {
    baseBranch,
    branch: wt.branch,
    baseDirty: await baseDirty(wt.repoRoot),
    files,
    conflicts,
    secrets,
    commands: {
      merge: [`git -C "${wt.path}" add -A && git commit -m "acc: …"`, `git -C "${wt.repoRoot}" merge --no-ff --no-edit ${wt.branch}`],
      apply: [`git -C "${wt.path}" add -A && git commit -m "acc: …"`, `git -C "${wt.repoRoot}" merge --squash ${wt.branch}   （只暫存，不提交）`],
    },
  };
}

export class MergeError extends Error {
  constructor(
    message: string,
    readonly conflicts: string[] = [],
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

/**
 * 合入（P2-4）：先把 worktree 裡的改動提交到任務分支，再在主倉庫執行 merge（保留提交）或 apply（squash，只暫存不提交）。
 * 主倉庫有未提交的改動、或者有衝突時不合入（衝突時自動撤回這次合併），丟擲 MergeError（中文說明）。
 */
export async function mergeTaskWorktree(
  wt: TaskWorktree,
  mode: 'merge' | 'apply',
  message: string,
  options: { allowSecrets?: boolean } = {},
): Promise<{ commit?: string; files: number }> {
  if (await baseDirty(wt.repoRoot)) {
    throw new MergeError('主倉庫目前有還沒提交的改動，合入會和它們混在一起。請先提交或暫存（git stash）主倉庫的改動，再合入。');
  }
  // 合入前金鑰掃描（P2-9）：新增內容裡有疑似金鑰時不合入，除非操作員確認是誤報
  if (!options.allowSecrets) {
    const candidate = await candidateCommit(wt);
    const mergeBase = (await git(wt.repoRoot, ['merge-base', 'HEAD', candidate])).trim();
    const secrets = scanDiffForSecrets(await git(wt.repoRoot, ['diff', '--no-renames', '--no-color', '-U0', mergeBase, candidate]));
    if (secrets.length) {
      const where = secrets.slice(0, 5).map((s) => `${s.path ?? '?'}:${s.line ?? '?'}（${s.name}）`).join('、');
      throw new MergeError(`改動裡有疑似金鑰，沒有合入：${where}。請讓 AI 改用環境變數或設定檔（不要提交金鑰）；確認是誤報時可以選擇「仍然合入」。`);
    }
  }
  await git(wt.path, ['add', '-A']);
  const staged = (await git(wt.path, ['diff', '--cached', '--name-only'])).trim();
  if (staged) await git(wt.path, ['commit', '-m', message], IDENTITY);
  const files = (await git(wt.repoRoot, ['diff', '--name-only', `HEAD...${wt.branch}`])).trim().split('\n').filter(Boolean).length;
  if (files === 0) throw new MergeError('任務分支相對主倉庫沒有任何改動，不需要合入。');
  try {
    if (mode === 'merge') await git(wt.repoRoot, ['merge', '--no-ff', '--no-edit', wt.branch], IDENTITY);
    else await git(wt.repoRoot, ['merge', '--squash', wt.branch]);
  } catch (error) {
    const conflicts = (await git(wt.repoRoot, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean);
    // 撤回這次合併，主倉庫回到合併之前
    await git(wt.repoRoot, mode === 'merge' ? ['merge', '--abort'] : ['reset', '--merge']).catch(() => undefined);
    throw new MergeError(conflicts.length ? `合入時有衝突，已經撤回這次合入（主倉庫沒有被改動）。衝突的檔案：${conflicts.join('、')}` : `合入失敗，已經撤回：${(error as Error).message}`, conflicts);
  }
  const commit = mode === 'merge' ? (await git(wt.repoRoot, ['rev-parse', 'HEAD'])).trim() : undefined;
  return { commit, files };
}

/** 刪除 worktree 與分支；Windows 上檔案被佔用（例如編輯器、防毒軟體）時重試幾次，仍失敗時給出原因。 */
export async function cleanupTaskWorktree(wt: TaskWorktree, options: { attempts?: number; delayMs?: number } = {}): Promise<void> {
  const attempts = options.attempts ?? 4;
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      if (existsSync(wt.path)) await git(wt.repoRoot, ['worktree', 'remove', '--force', wt.path]);
      await git(wt.repoRoot, ['worktree', 'prune']).catch(() => undefined);
      if ((await git(wt.repoRoot, ['branch', '--list', wt.branch])).trim()) await git(wt.repoRoot, ['branch', '-D', wt.branch]);
      return;
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, (options.delayMs ?? 500) * (i + 1)));
    }
  }
  throw new Error(`沒辦法刪除 worktree ${wt.path}：${(last as Error)?.message ?? ''}。通常是有程式（編輯器、終端機、防毒軟體）還開著裡面的檔案，關掉後再試一次。`);
}

/** 找出孤兒 worktree（P2-4）：.acc-worktrees 下、沒有任何任務引用的目錄。 */
export function findOrphanWorktrees(repoRoot: string, referenced: ReadonlySet<string>): string[] {
  const dir = join(repoRoot, '.acc-worktrees');
  if (!existsSync(dir)) return [];
  // 同一個目錄可能有不同寫法（Windows 的 8.3 短檔名、大小寫、斜線方向）：先解析成真實路徑再比較
  const normalize = (p: string) => {
    let real = p;
    try {
      real = realpathSync.native(p);
    } catch {
      // 目錄已經不存在：按原樣比較
    }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const known = new Set([...referenced].map(normalize));
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(dir, e.name))
    .filter((p) => !known.has(normalize(p)));
}

/**
 * 從檢查點分叉（P2-3）：新建一個任務 worktree，工作區內容與檢查點一致，而原任務不受影響。
 * 新分支從檢查點所依據的那個提交開始（沿第一父提交跳過 ACC 的檢查點提交），檢查點裡的改動以“未提交的改動”出現——
 * 分支歷史裡不會帶上檢查點提交，之後合入時歷史是乾淨的。
 */
export async function forkWorktreeFromCheckpoint(repoPath: string, name: string, checkpoint: string): Promise<TaskWorktree> {
  if (!/^[0-9a-f]{7,64}$/i.test(checkpoint)) throw new Error(`Invalid checkpoint: ${checkpoint}`);
  const root = (await git(repoPath, ['rev-parse', '--show-toplevel'])).trim();
  const lines = (await git(root, ['log', '--first-parent', '--format=%H%x09%s', checkpoint])).trim().split('\n');
  const base = lines.map((l) => l.split('\t')).find(([, subject]) => !subject?.startsWith('acc checkpoint '))?.[0];
  if (!base) throw new Error('Cannot find the commit this checkpoint is based on');
  const wt = await createTaskWorktreeAt(root, name, base);
  try {
    // 檢查點裡改過 / 新增的檔案寫進工作區；檢查點裡沒有、基準提交裡有的檔案刪掉
    await git(wt.path, ['restore', `--source=${checkpoint}`, '--worktree', '--', '.']);
    const deleted = (await git(wt.path, ['diff', '--name-only', '--diff-filter=D', base, checkpoint])).trim().split('\n').filter(Boolean);
    for (const file of deleted) await rm(join(wt.path, file), { force: true });
  } catch (error) {
    await cleanupTaskWorktree(wt).catch(() => undefined);
    throw error;
  }
  return wt;
}
