import { realpathSync } from 'node:fs';
import { isAbsolute, posix as posixPath, win32 as win32Path } from 'node:path';
import { AdapterPreconditionError } from '@acc/core';
import type { AgentMode, AgentResumeInput, EventSink } from '@acc/core';

/** adapter 共用的小工具：不含任何 provider 細節。 */

export const MAX_TEXT = 4000;

/** adapter 的日誌出口（服務端注入自己的 logger；預設寫 stderr）。 */
export type AdapterLog = (message: string, error?: unknown) => void;

export const defaultAdapterLog: AdapterLog = (message, error) => {
  console.error(`[acc] ${message}`, error ?? '');
};

type EmitInput = Parameters<EventSink>[0];

/**
 * 安全地發出事件：永不丟擲，也就不會產生未處理的 Promise 拒絕（Node 預設會因此退出整個程序）。
 *
 * 編排器的反應已經與 emit 脫鉤，emit 失敗只意味著“事件沒能落盤”。失敗時記錄日誌並返回 false，
 * 由呼叫方決定是否需要 fail closed——例如審批請求沒送到編排器時，應當直接拒絕該操作，
 * 而不是讓它無限期掛起。所有 fire-and-forget 的傳送都必須走這裡。
 */
export async function safeEmit(emit: EventSink, event: EmitInput, log: AdapterLog = defaultAdapterLog): Promise<boolean> {
  try {
    await emit(event);
    return true;
  } catch (error) {
    try {
      log(`failed to emit ${event.type} (run ${event.runId}, session ${event.sessionId ?? '-'})`, error);
    } catch {
      // 日誌本身失敗也不能丟擲
    }
    return false;
  }
}

export function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 審批/事件載荷裡只保留輸入摘要，避免把大檔案內容寫入事件日誌。 */
export function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === 'string' ? clip(value, 500) : value;
  }
  return out;
}

/** 鍵排序後的 JSON，用於判斷“同一呼叫”（重啟後預批准匹配）。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * adapter 前置條件不滿足時丟擲的結構化錯誤（定義在 @acc/core，屬於 adapter 與編排器之間的約定）：
 * 編排器據此把 run fail closed 為帶原因的 BLOCKED，續跑時還會把會話標記為“無法續接”，不再反覆嘗試。
 */
export { AdapterPreconditionError };

/** 續跑時讀不到會話原來的工作目錄（或它不是絕對路徑）。 */
export const RESUME_CWD_MISSING = 'RESUME_CWD_MISSING';
/** 續跑時讀不到會話原來的模式（或不是已知模式）。 */
export const RESUME_MODE_MISSING = 'RESUME_MODE_MISSING';

const AGENT_MODES: ReadonlySet<string> = new Set<AgentMode>(['implement', 'review', 'rescue', 'test', 'analysis']);

/** 唯讀步驟（評審 / 診斷 / 分析）：Claude 必須用 plan 模式，Codex 必須用 read-only 沙箱，不因任務需要而放寬。 */
export function isReadOnlyMode(mode: AgentMode | undefined): boolean {
  return mode === 'review' || mode === 'rescue' || mode === 'analysis';
}

/** 續跑必須沿用的會話上下文：原來的工作目錄與模式。 */
export interface ResumeWorkspace {
  cwd: string;
  mode: AgentMode;
}

/**
 * 從續跑輸入裡讀取會話原來的工作目錄和模式（編排器把它們持久化在會話後設資料裡，經 resumeInput.metadata 傳入）。
 *
 * 讀不到就 fail closed（拋 AdapterPreconditionError）：
 * - 絕不回退到 adapter 的 defaultCwd——那通常是主倉庫，而任務可能是在獨立 worktree 裡建立的；
 * - 絕不預設成可寫模式——唯讀的評審 / 診斷 / 分析會話續跑之後必須仍然唯讀。
 */
export function resumeWorkspace(input: AgentResumeInput, provider: string): ResumeWorkspace {
  const cwd = input.metadata?.cwd;
  if (typeof cwd !== 'string' || !cwd.trim() || !isAbsolute(cwd)) {
    throw new AdapterPreconditionError(
      RESUME_CWD_MISSING,
      `Cannot resume ${provider} session: the persisted working directory is ${typeof cwd === 'string' && cwd.trim() ? `not absolute (${cwd})` : 'missing'}; refusing to fall back to the default workspace`,
    );
  }
  const mode = input.metadata?.mode;
  if (typeof mode !== 'string' || !AGENT_MODES.has(mode)) {
    throw new AdapterPreconditionError(
      RESUME_MODE_MISSING,
      `Cannot resume ${provider} session: the persisted session mode is ${typeof mode === 'string' ? `unknown (${mode})` : 'missing'}; refusing to guess its permissions`,
    );
  }
  return { cwd, mode: mode as AgentMode };
}

/**
 * 把工作目錄規範化成可比較的形式（用於核對 provider 回報的 cwd）：
 * - 解析 `.` / `..` 與多餘 / 結尾分隔符；
 * - 目錄存在時取真實路徑（解開符號連結、junction、8.3 短檔名），不存在時按字面比較；
 * - Windows：去掉 `\\?\` 長路徑前綴，統一分隔符為 `/`，不區分大小寫。
 */
export function normalizeWorkspacePath(path: string, platform: NodeJS.Platform = process.platform): string {
  const win = platform === 'win32';
  const lib = win ? win32Path : posixPath;
  let text = path.trim();
  if (win) text = text.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  let resolved = lib.resolve(text);
  if (platform === process.platform) {
    try {
      resolved = realpathSync.native(resolved);
    } catch {
      // 目錄不存在或無法訪問：按字面比較
    }
  }
  if (win) resolved = resolved.replace(/\\/g, '/').toLowerCase();
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved;
}

/** 兩個工作目錄是否指向同一位置（規範化後比較）。 */
export function sameWorkspacePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return normalizeWorkspacePath(a, platform) === normalizeWorkspacePath(b, platform);
}

/** 重啟續跑時發給 agent 的提示詞（所有 adapter 統一語義）。 */
export function resumePrompt(input: AgentResumeInput): string {
  // P1-2：不再羅列全部已完成的原始呼叫 ID（執行時自己的會話記錄裡已經有這些結果）；只點名這個 agent 狀態不明的呼叫，
  // 請它先檢查是否已經做過，再決定要不要重做
  const uncertain = (input.uncertainSideEffects ?? []).slice(-10);
  const recent = (input.recentCompletedSideEffectIds ?? input.completedSideEffectIds).slice(-10);
  const completed = recent.length ? ` Already completed tool calls (do NOT repeat them): ${recent.join(', ')}.` : '';
  const unknown = uncertain.length
    ? ` These actions were started before the restart but their results were never recorded, so they may or may not have run: ${uncertain
        .map((x) => `${x.name ?? 'tool'}${x.summary ? ` (${x.summary})` : ''}`)
        .join('; ')}. Check the workspace to see whether they took effect before repeating any of them.`
    : '';
  const done = `${completed}${unknown}`;
  switch (input.reason) {
    case 'message':
      // 操作員的訊息原樣轉達；有狀態不明的呼叫時附一句控制面的提醒（P1-2）
      return unknown ? `${input.message ?? 'Continue.'}

[Note from the control plane]${unknown}` : (input.message ?? 'Continue.');
    case 'approval': {
      const tool = typeof input.approvalRequest?.toolName === 'string' ? ` (${input.approvalRequest.toolName})` : '';
      return `The control plane restarted while your permission request${tool} was pending. The operator approved it; retry that exact action and continue the task.${done}`;
    }
    case 'recovery':
    default:
      return `The control plane restarted. Continue the task from where you stopped.${done}`;
  }
}

/** 可推送的非同步佇列。 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) throw new Error('Input stream already closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
