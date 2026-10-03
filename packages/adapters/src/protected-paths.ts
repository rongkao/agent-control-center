import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix as posixPath, win32 as win32Path } from 'node:path';
import { testRunnerEnv } from './env-policy.js';

/**
 * 受保護路徑（P0-8，借鑑 srt 的強制拒寫清單）：不論是否已有會話級允許，agent 都不能寫入這些位置——
 * 它們會改變 agent 的權限、自動執行命令或者接入外部工具，一旦被改，審批這道閘門就會被繞過：
 * - 任何 `.git` 路徑段（`.git` 檔案本身和 `.git/**`，P0 第三批審查）：hooks、config、子模組的 `.git/modules/<sub>/hooks|config`，
 *   以及 worktree 的 `.git` 指標檔案（改寫它能讓 git 改用任意目錄裡的 config 和 hooks）。正常開發從不需要用編輯工具寫這裡；
 * - 實際生效的 hooks 目錄（會話啟動時用 `git rev-parse --git-path hooks` 讀出，尊重 core.hooksPath，例如 husky 的 `.husky/`）：
 *   git 在提交、切換分支等操作時自動執行裡面的腳本；
 * - 使用者級 git 配置（`~/.gitconfig`、`~/.config/git/**`、`$XDG_CONFIG_HOME/git/**`）：core.hooksPath、core.fsmonitor 會影響本機所有 git 操作；
 * - `.claude/**`：Claude Code 的設定（allow 規則、hooks）、命令和子 agent 定義；
 * - `.mcp.json`：專案級 MCP 伺服器配置（接入外部工具）；
 * - `.codex/**`：Codex 的專案配置與 hooks。
 *
 * 路徑在工作目錄之內時按相對工作目錄的各級目錄名判斷（任意深度都算，例如 packages/app/.claude/settings.json）；
 * 在工作目錄之外時按完整路徑判斷（例如使用者主目錄下的 ~/.claude/settings.json、~/.codex/config.toml）。
 * 判斷前先解開已存在部分的真實路徑（符號連結、junction、8.3 短檔名），Windows 上不區分大小寫，並去掉結尾的點和空格、
 * 備用資料流（file:stream）這類同名寫法。
 */

/** 受保護路徑規則（顯示給操作員）。 */
export const PROTECTED_PATH_RULES = ['.git/**', '.git/hooks/**', '.git/config', 'git hooks 目錄（core.hooksPath）', '~/.gitconfig', '~/.config/git/**', '.claude/**', '.mcp.json', '.codex/**'] as const;

/** 判斷受保護路徑時的附加資訊（預設按本機環境）。 */
export interface ProtectedPathOptions {
  /** 使用者主目錄（使用者級 git 配置在它下面）；預設 os.homedir()。 */
  home?: string;
  /** $XDG_CONFIG_HOME；預設讀取程序環境變數。 */
  xdgConfigHome?: string;
  /** 實際生效的 hooks 目錄（絕對路徑，見 gitHooksDirs）。 */
  hooksDirs?: readonly string[];
}

/** 解開路徑裡已經存在的那一段的真實路徑（其餘部分原樣接上）。 */
function realpathOfExisting(target: string, lib: typeof win32Path): string {
  let existing = target;
  const rest: string[] = [];
  for (;;) {
    if (existsSync(existing)) break;
    const parent = lib.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(lib.basename(existing));
    existing = parent;
  }
  try {
    return lib.join(realpathSync.native(existing), ...rest);
  } catch {
    return target;
  }
}

/** 規範化一級目錄名 / 檔名，便於比較。 */
function normalizeSegment(segment: string, win: boolean): string {
  if (!win) return segment;
  // Windows：不區分大小寫；"foo." 與 "foo " 等同於 "foo"；"file:stream" 寫的是 file 的備用資料流
  const withoutStream = segment.length > 2 || !/^[a-z]:$/i.test(segment) ? segment.split(':')[0]! : segment;
  return withoutStream.replace(/[. ]+$/, '').toLowerCase();
}

/** 把路徑拆成規範化的各級名字（用於比較“是否在某個目錄之內”）。 */
function segmentsOf(path: string, win: boolean): string[] {
  return path
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => normalizeSegment(segment, win));
}

/** child 是否就是 parent，或者在 parent 之內（按規範化的各級名字比較）。 */
function insideOrEqual(child: string[], parent: string[]): boolean {
  if (parent.length === 0 || child.length < parent.length) return false;
  return parent.every((segment, index) => child[index] === segment);
}

/** 按規則檢查一串目錄名，命中時返回規則。 */
function matchSegments(segments: string[]): string | undefined {
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const next = segments[i + 1];
    const last = i === segments.length - 1;
    if (segment === '.claude') return '.claude/**';
    if (segment === '.codex') return '.codex/**';
    if (segment === '.mcp.json' && last) return '.mcp.json';
    if (segment === '.git' && next === 'hooks') return '.git/hooks/**';
    if (segment === '.git' && (next === 'config' || next === 'config.worktree') && i + 1 === segments.length - 1) return '.git/config';
    // worktree 的 git 目錄（.git/worktrees/<名字>/config.worktree）
    if (segment === '.git' && next === 'worktrees' && /^config(\.worktree)?$/.test(segments.at(-1) ?? '') && segments.length - i === 4) return '.git/config';
    // 其餘任何 .git 路徑段（P0 第三批審查）：.git 指標檔案本身、.git/modules/<sub>/hooks|config、.git/info 等
    if (segment === '.git') return '.git/**';
  }
  return undefined;
}

/**
 * 寫入目標是否落在受保護路徑上。target 可以是絕對路徑，也可以是相對 cwd 的路徑。
 * 返回命中的規則（例如 '.claude/**'），不受保護時返回 undefined。
 */
export function protectedWriteTarget(target: string, cwd: string | undefined, platform: NodeJS.Platform = process.platform, options: ProtectedPathOptions = {}): string | undefined {
  if (typeof target !== 'string' || !target.trim()) return undefined;
  const win = platform === 'win32';
  const lib = win ? win32Path : posixPath;
  const sameFs = platform === process.platform;
  const resolveReal = (path: string) => (sameFs ? realpathOfExisting(lib.resolve(path), lib) : lib.resolve(path));
  const base = cwd ? lib.resolve(cwd) : undefined;
  let absolute = base ? lib.resolve(base, target) : lib.resolve(target);
  let root = base;
  if (sameFs) {
    absolute = realpathOfExisting(absolute, lib);
    if (root) root = realpathOfExisting(root, lib);
  }
  let relative: string | undefined;
  if (root) {
    const rel = lib.relative(root, absolute);
    if (rel && !rel.startsWith('..') && !lib.isAbsolute(rel)) relative = rel;
    // 目標就是工作目錄本身：不是寫檔案
    if (rel === '') return undefined;
  }
  const absoluteSegments = segmentsOf(absolute, win);

  // 實際生效的 hooks 目錄（core.hooksPath，例如 .husky）
  for (const dir of options.hooksDirs ?? []) {
    if (!dir) continue;
    if (insideOrEqual(absoluteSegments, segmentsOf(resolveReal(dir), win))) {
      const rel = root ? lib.relative(root, lib.resolve(dir)) : '';
      const label = rel && !rel.startsWith('..') && !lib.isAbsolute(rel) ? rel.replace(/\\/g, '/') : lib.resolve(dir);
      return `${label}/**`;
    }
  }

  // 使用者級 git 配置
  const home = options.home ?? (sameFs ? homedir() : undefined);
  if (home) {
    const homeSegments = segmentsOf(resolveReal(home), win);
    if (insideOrEqual(absoluteSegments, [...homeSegments, normalizeSegment('.gitconfig', win)]) && absoluteSegments.length === homeSegments.length + 1) return '~/.gitconfig';
    if (insideOrEqual(absoluteSegments, [...homeSegments, normalizeSegment('.config', win), 'git'])) return '~/.config/git/**';
  }
  const xdg = options.xdgConfigHome ?? (sameFs ? process.env.XDG_CONFIG_HOME : undefined);
  if (xdg?.trim() && insideOrEqual(absoluteSegments, [...segmentsOf(resolveReal(xdg.trim()), win), 'git'])) return '$XDG_CONFIG_HOME/git/**';

  const segments = relative !== undefined ? segmentsOf(relative, win) : absoluteSegments;
  return matchSegments(segments);
}

/**
 * 實際生效的 git hooks 目錄（P0 第三批審查）：`git rev-parse --git-path hooks` 尊重 core.hooksPath（倉庫、使用者級、系統級配置），
 * 例如 husky 倉庫返回 `<倉庫>/.husky`。不是 git 倉庫、沒有安裝 git 或者讀取失敗時返回空列表（只少一層保護，不影響啟動）。
 * git 以白名單環境執行（不帶任何憑據），並關閉 core.fsmonitor，避免倉庫配置借這次呼叫執行命令。
 */
export function gitHooksDirs(cwd: string | undefined): string[] {
  if (!cwd) return [];
  try {
    const result = spawnSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', '--git-path', 'hooks'], {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      env: { ...testRunnerEnv(process.env), GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    const dir = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (!dir) return [];
    const lib = process.platform === 'win32' ? win32Path : posixPath;
    return [lib.resolve(cwd, dir)];
  } catch {
    return [];
  }
}

/** 命令文字裡提到 hooks 目錄時用來匹配的名字：在工作目錄之內用相對路徑（例如 .husky），之外用絕對路徑。 */
export function hooksDirNames(hooksDirs: readonly string[], cwd: string | undefined): string[] {
  const lib = process.platform === 'win32' ? win32Path : posixPath;
  return hooksDirs.map((dir) => {
    const rel = cwd ? lib.relative(lib.resolve(cwd), lib.resolve(dir)) : '';
    return (rel && !rel.startsWith('..') && !lib.isAbsolute(rel) ? rel : lib.resolve(dir)).replace(/\\/g, '/');
  });
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 命令文字裡提到的受保護路徑（Bash / PowerShell 命令裡的寫入無法可靠識別，只用來把審批標成高風險）。
 * options.hooksDirNames：會話實際生效的 hooks 目錄（見 hooksDirNames，例如 ['.husky']）。
 */
export function commandProtectedPaths(command: string, options: { hooksDirNames?: readonly string[] } = {}): string[] {
  if (typeof command !== 'string' || !command) return [];
  const text = command.replace(/\\/g, '/').toLowerCase();
  const hits: string[] = [];
  const add = (label: string) => {
    if (!hits.includes(label)) hits.push(label);
  };
  const boundary = '(?:^|[^a-z0-9_.-])';
  if (new RegExp(`\\.git/hooks(?:/|$|[^a-z0-9_])`).test(text)) add('.git/hooks');
  if (/\.git\/config\b/.test(text) || /\bgit\s+config\b/.test(text) || /core\.hookspath/.test(text) || /core\.fsmonitor/.test(text)) add('.git/config');
  // 其餘 .git 路徑段（.git 指標檔案、.git/modules/...）：.gitignore、.github 這類名字不算
  if (!hits.length && new RegExp(`${boundary}\\.git(?:/|$|[^a-z0-9_-])`).test(text)) add('.git');
  if (/\.gitconfig\b/.test(text) || /\.config\/git(?:\/|$|[^a-z0-9_-])/.test(text)) add('~/.gitconfig');
  for (const name of options.hooksDirNames ?? []) {
    const lower = name.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
    if (!lower || lower.startsWith('.git/')) continue;
    if (new RegExp(`${boundary}${escapeRegex(lower)}(?:/|$|[^a-z0-9_-])`).test(text)) add(name);
  }
  if (new RegExp(`${boundary}\\.claude(?:/|$|[^a-z0-9_-])`).test(text)) add('.claude');
  if (/\.mcp\.json\b/.test(text)) add('.mcp.json');
  if (new RegExp(`${boundary}\\.codex(?:/|$|[^a-z0-9_-])`).test(text)) add('.codex');
  return hits;
}

/** 拒絕寫入受保護路徑時給 agent 和操作員看的中文說明。 */
export function protectedWriteMessage(targets: string[]): string {
  const list = targets.join('、');
  return (
    `受保護的路徑不允許 AI 寫入：${list}。` +
    '這類檔案（.git 裡的任何內容、git hooks 目錄、使用者的 git 設定、.claude、.mcp.json、.codex）會改變 AI 的權限、自動執行命令或接入外部工具，' +
    '所以不論之前是否選過「本會話都允許」都一律拒絕。確實需要修改時，請由你自己手動修改。'
  );
}

/** 審批卡上“高風險”的說明：命令涉及受保護路徑。 */
export function protectedCommandRisk(paths: string[]): string {
  return `命令涉及受保護的路徑（${paths.join('、')}）：可能改變 AI 的權限或讓 git 自動執行命令。請確認命令內容後再批准；這類操作不提供「本會話都允許」。`;
}
