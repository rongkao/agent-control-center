import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * 訪問令牌（P0-1 / H-1）：瀏覽器第一次訪問時用它換登入 Cookie；程式呼叫可以用 Authorization: Bearer。
 *
 * - 預設持久化在使用者私有的資料目錄（<資料目錄>/access-token），重啟後複用：
 *   `npm run dev` 的 --watch 重啟不會讓已經登入的頁面失效。
 * - 檔案權限只給當前使用者：Windows 用 icacls 去掉繼承、只授權當前使用者；其他平台 chmod 600。
 *   每次啟動都自檢，權限被放寬時自動修復，修不好就拒絕啟動。
 * - 令牌絕不放進 process.env：agent、Codex、測試命令等子程序都繼承 process.env。
 */

export const TOKEN_FILE_NAME = 'access-token';
/** 令牌格式：URL 安全字元，至少 32 個（生成的令牌是 32 位元組隨機數的 base64url，43 個字元）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,512}$/;

/** 令牌相關的啟動錯誤（帶錯誤碼，由 startServer 轉成 StartupError）。 */
export class AccessTokenError extends Error {
  override readonly name = 'AccessTokenError';

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function generateAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isValidAccessToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** 令牌檔案的權限保護：收緊 + 自檢。測試可以注入替身模擬“權限無法收緊”。 */
export interface TokenFileGuard {
  /** 把檔案權限收緊到只有當前使用者可以讀寫。 */
  restrict(file: string): void;
  /** 自檢：返回問題說明；undefined 表示只有當前使用者能訪問。 */
  check(file: string): string | undefined;
}

export interface TokenFileGuardOptions {
  /** Windows：視為“當前使用者”的 SID（測試用；預設取執行本程序的使用者）。 */
  userSid?: string;
}

export function createTokenFileGuard(platform: NodeJS.Platform = process.platform, options: TokenFileGuardOptions = {}): TokenFileGuard {
  return platform === 'win32' ? windowsTokenFileGuard(options.userSid) : posixTokenFileGuard();
}

// ---------------------------------------------------------------- Windows

/** 系統自帶工具的絕對路徑（不走 PATH，避免被同名程式劫持）。 */
function system32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', name);
}

function runTool(tool: string, args: string[]): string {
  const result = spawnSync(system32Tool(tool), args, { encoding: 'latin1', windowsHide: true, timeout: 15_000 });
  if (result.error) throw new Error(`無法執行 ${tool}：${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
    throw new Error(`${tool} ${args.slice(1).join(' ')} 失敗（退出碼 ${result.status}）${detail ? `：${detail}` : ''}`);
  }
  return result.stdout ?? '';
}

let cachedUserSid: string | undefined;

/** 當前使用者的 SID（whoami /user；只取 SID 部分，不依賴系統語言和使用者名稱編碼）。 */
export function currentWindowsUserSid(): string {
  if (cachedUserSid) return cachedUserSid;
  const output = runTool('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sids = output.match(/S-1-\d+(?:-\d+)+/g);
  if (!sids?.length) throw new Error(`無法從 whoami 的輸出中確定當前使用者的 SID：${output.trim()}`);
  cachedUserSid = sids[sids.length - 1]!;
  return cachedUserSid;
}

/** 讀取檔案的 DACL（SDDL 形式，與系統語言無關）：icacls /save 寫出 UTF-16LE 文字，第二行是 SDDL。 */
export function readWindowsDacl(file: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'acc-acl-'));
  try {
    const out = path.join(dir, 'acl.txt');
    runTool('icacls.exe', [file, '/save', out]);
    const lines = readFileSync(out).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/);
    const sddl = lines.slice(1).find((line) => line.includes('D:'));
    if (!sddl) throw new Error(`無法解析 icacls 輸出的 ACL：${lines.join(' | ')}`);
    return sddl.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SDDL 裡常見內建賬戶的縮寫（服務以這些賬戶執行時，SDDL 不寫完整 SID）。 */
const SDDL_ALIASES: Record<string, string> = { SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20' };

/** 從 SDDL 裡取出 DACL 標誌與各條 ACE（按 ; 分段）。 */
function parseDacl(sddl: string): { flags: string; aces: string[][] } | undefined {
  const match = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!match) return undefined;
  return { flags: match[1] ?? '', aces: [...(match[2] ?? '').matchAll(/\(([^)]*)\)/g)].map((ace) => ace[1]!.split(';')) };
}

export interface CheckWindowsDaclOptions {
  /**
   * SDDL 裡同樣表示當前使用者的寫法。與賬戶域相關的別名沒法只憑 SID 判斷：
   * 本機內建 Administrator（RID 500）寫成 LA、Guest（RID 501）寫成 LG。由 sddlAliasesForSid 讓 Windows 自己告訴我們。
   */
  userAliases?: readonly string[];
}

/**
 * 檢查 DACL 是否“只授權給當前使用者”：不繼承上級目錄（P 標誌），所有允許類 ACE 都屬於當前使用者。
 * 拒絕類 ACE 只會收緊訪問，不算問題。
 */
export function checkWindowsDacl(sddl: string, userSid: string, options: CheckWindowsDaclOptions = {}): string | undefined {
  const parsed = parseDacl(sddl);
  if (!parsed) return `無法解析 ACL：${sddl}`;
  if (!parsed.flags.includes('P')) return '檔案仍然繼承上級目錄的權限，其他賬戶可能也能讀取';
  const userTokens = new Set([userSid, ...(options.userAliases ?? [])]);
  let userAllowed = false;
  for (const ace of parsed.aces) {
    const type = ace[0] ?? '';
    const sid = ace[5] ?? '';
    if (type === 'D' || type === 'OD') continue;
    const resolved = SDDL_ALIASES[sid] ?? sid;
    if (!userTokens.has(sid) && resolved !== userSid) return `除當前使用者外，還授權給了 ${sid}`;
    userAllowed = true;
  }
  if (!userAllowed) return '當前使用者自己沒有訪問權限';
  return undefined;
}

const aliasCache = new Map<string, string[]>();

/**
 * Windows 在 SDDL 裡怎樣寫這個 SID（除完整 SID 以外的寫法，例如本機 Administrator 寫成 LA）。
 *
 * 與賬戶域相關的別名（LA = 本機賬戶域 SID + -500，LG = + -501）只憑 SID 無法判斷——域賬戶的 RID 500 就不會寫成 LA。
 * 所以直接問 Windows：建一個臨時檔案、只授權給這個 SID，再用同樣的 icacls /save 讀回來，看它寫成了什麼。
 * 只對 RID 500 / 501 這樣可能有別名的賬戶這樣做（其他賬戶直接返回空），結果按 SID 快取。
 */
export function sddlAliasesForSid(sid: string): string[] {
  if (!/^S-1-5-21-\d+-\d+-\d+-50[01]$/.test(sid)) return [];
  const cached = aliasCache.get(sid);
  if (cached) return cached;
  const dir = mkdtempSync(path.join(tmpdir(), 'acc-sid-'));
  const probe = path.join(dir, 'probe');
  try {
    writeFileSync(probe, '');
    runTool('icacls.exe', [probe, '/inheritance:r', '/grant:r', `*${sid}:(F)`]);
    const parsed = parseDacl(readWindowsDacl(probe));
    const tokens = [...new Set((parsed?.aces ?? []).filter((ace) => ace[0] === 'A').map((ace) => ace[5] ?? ''))].filter((token) => token && token !== sid);
    aliasCache.set(sid, tokens);
    return tokens;
  } finally {
    removeProbe(probe, dir);
  }
}

/** 刪除探測檔案：它可能只授權給了別的賬戶，先用所有者身份恢復繼承的權限再刪（清理失敗不影響結論）。 */
function removeProbe(probe: string, dir: string): void {
  try {
    if (existsSync(probe)) runTool('icacls.exe', [probe, '/reset']);
  } catch {
    // 忽略
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 臨時目錄刪不掉不影響結論
  }
}

function windowsTokenFileGuard(userSid?: string): TokenFileGuard {
  const user = () => userSid ?? currentWindowsUserSid();
  return {
    restrict(file) {
      const sid = user();
      // 先清掉顯式授權（例如被人為加上的 Everyone），再去掉繼承、只授權當前使用者
      runTool('icacls.exe', [file, '/reset']);
      runTool('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`]);
    },
    check(file) {
      const sid = user();
      // 以內建 Administrator 執行時 SDDL 把當前使用者寫成 LA：按 Windows 實際的寫法識別，否則每次啟動都會誤報
      return checkWindowsDacl(readWindowsDacl(file), sid, { userAliases: sddlAliasesForSid(sid) });
    },
  };
}

// ---------------------------------------------------------------- POSIX

function posixTokenFileGuard(): TokenFileGuard {
  return {
    restrict(file) {
      chmodSync(file, 0o600);
    },
    check(file) {
      const stat = statSync(file);
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return `檔案屬於其他使用者（uid ${stat.uid}）`;
      if ((stat.mode & 0o077) !== 0) return `權限過寬（${(stat.mode & 0o777).toString(8)}），其他使用者也能讀取`;
      return undefined;
    },
  };
}

// ---------------------------------------------------------------- 載入 / 生成

export interface LoadAccessTokenInput {
  /** 程式呼叫時顯式傳入的令牌（不落盤）。 */
  explicitToken?: string;
  /** 令牌檔案路徑（預設 <資料目錄>/access-token，或 ACC_TOKEN_FILE）。 */
  tokenPath: string;
  /** 令牌檔案由使用者顯式指定（ACC_TOKEN_FILE）：內容無效時報錯，而不是覆蓋使用者的檔案。 */
  explicitFile?: boolean;
  guard: TokenFileGuard;
}

export interface AccessTokenResult {
  token: string;
  /** 令牌檔案（顯式傳入令牌時沒有）。 */
  path?: string;
  /** 本次啟動新生成了令牌。 */
  created: boolean;
  /** 啟動自檢發現權限被放寬，已修復。 */
  repaired: boolean;
}

function insecureMessage(file: string, problem: string): string {
  return [
    `訪問令牌檔案 ${file} 的權限不安全：${problem}。`,
    '這個檔案相當於控制台的登入密碼，必須只有當前使用者能讀取；自動收緊權限沒有成功，服務沒有啟動。',
    '請確認該檔案所在的目錄屬於當前使用者且可以修改權限，或者用 ACC_TOKEN_FILE 指定一個只有你自己能訪問的位置。',
  ].join('\n');
}

/** 收緊權限並自檢；修不好就丟擲 ACC_TOKEN_FILE_INSECURE。 */
function protect(file: string, guard: TokenFileGuard): void {
  try {
    guard.restrict(file);
  } catch (error) {
    throw new AccessTokenError('ACC_TOKEN_FILE_INSECURE', insecureMessage(file, (error as Error).message), { cause: error });
  }
  let problem: string | undefined;
  try {
    problem = guard.check(file);
  } catch (error) {
    problem = (error as Error).message;
  }
  if (problem) throw new AccessTokenError('ACC_TOKEN_FILE_INSECURE', insecureMessage(file, problem));
}

/**
 * 取得訪問令牌：顯式令牌優先；否則讀取令牌檔案，沒有就生成。
 * 新檔案先以空內容獨佔建立、收緊權限並自檢通過後才寫入令牌——令牌從不出現在權限寬鬆的檔案裡。
 */
export function loadOrCreateAccessToken(input: LoadAccessTokenInput): AccessTokenResult {
  if (input.explicitToken !== undefined) {
    if (!isValidAccessToken(input.explicitToken)) {
      throw new AccessTokenError('ACC_TOKEN_INVALID', '顯式指定的訪問令牌無效：至少需要 32 個字元，只能包含字母、數字和 . _ ~ -。');
    }
    return { token: input.explicitToken, created: false, repaired: false };
  }

  const file = input.tokenPath;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (error) {
    throw new AccessTokenError('ACC_TOKEN_FILE_FAILED', `無法建立訪問令牌所在的目錄 ${path.dirname(file)}：${(error as Error).message}`, { cause: error });
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(file)) {
      // 啟動自檢：權限被放寬時先修復，再讀取
      let repaired = false;
      let problem: string | undefined;
      try {
        problem = input.guard.check(file);
      } catch (error) {
        problem = (error as Error).message;
      }
      if (problem) {
        protect(file, input.guard);
        repaired = true;
      }
      let content: string;
      try {
        content = readFileSync(file, 'utf8').trim();
      } catch (error) {
        throw new AccessTokenError('ACC_TOKEN_FILE_FAILED', `無法讀取訪問令牌檔案 ${file}：${(error as Error).message}`, { cause: error });
      }
      if (isValidAccessToken(content)) return { token: content, path: file, created: false, repaired };
      if (input.explicitFile && content) {
        throw new AccessTokenError('ACC_TOKEN_INVALID', `ACC_TOKEN_FILE 指定的檔案 ${file} 裡的令牌無效：至少需要 32 個字元，只能包含字母、數字和 . _ ~ -。`);
      }
      // 內容損壞或為空（例如上次寫入中途被強殺）：原地換一個新令牌（權限已經是安全的）
      const token = generateAccessToken();
      writeFileSync(file, `${token}\n`, { encoding: 'utf8' });
      return { token, path: file, created: true, repaired };
    }

    let fd: number;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; // 另一個程序剛好建立了它：按已有檔案處理
      throw new AccessTokenError('ACC_TOKEN_FILE_FAILED', `無法建立訪問令牌檔案 ${file}：${(error as Error).message}`, { cause: error });
    }
    closeSync(fd);
    try {
      protect(file, input.guard);
    } catch (error) {
      rmSync(file, { force: true });
      throw error;
    }
    const token = generateAccessToken();
    writeFileSync(file, `${token}\n`, { encoding: 'utf8' });
    return { token, path: file, created: true, repaired: false };
  }
  throw new AccessTokenError('ACC_TOKEN_FILE_FAILED', `無法建立訪問令牌檔案 ${file}`);
}
