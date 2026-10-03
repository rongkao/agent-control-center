import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { CodexIncoming } from './codex-protocol.js';
import { codexRuntimeEnv, readCodexConfigEnvNames } from './env-policy.js';
import { killProcessTree, quoteExecutable, useProcessGroup } from './process-tree.js';

/** 行傳輸抽象：真實實現是 `codex app-server` 子程序的 stdio，測試中注入假傳輸。 */
export interface CodexTransport {
  write(line: string): void;
  onLine(handler: (line: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

export interface SpawnCodexOptions {
  /** 啟動命令，預設 `codex app-server`（可用 ACC_CODEX_BIN 覆蓋 codex 路徑）。 */
  command?: string;
  cwd?: string;
  /** 子程序環境變數；預設按 Codex 的白名單從 process.env 構造（P0-8，見 env-policy.ts），不再整體繼承。 */
  env?: NodeJS.ProcessEnv;
  onStderr?: (text: string) => void;
  /** stdin 待寫緩衝上限（位元組），預設 16 MiB。 */
  maxBufferedBytes?: number;
}

export function spawnCodexTransport(options: SpawnCodexOptions = {}): CodexTransport {
  // 路徑含空格（例如裝在 Program Files 下）時加引號，否則經 shell 啟動會被拆開
  const command = options.command ?? `${quoteExecutable(process.env.ACC_CODEX_BIN || 'codex')} app-server`;
  // Windows 上 codex 是 .cmd 包裝腳本，需要經 shell 啟動；命令整體作為字串傳入，不拼接任何使用者輸入
  const env = options.env ?? codexRuntimeEnv(process.env, process.platform, { extraNames: readCodexConfigEnvNames(process.env) });
  // windowsHide：不彈出控制台視窗；POSIX 用獨立程序組，結束時連同子程序一起結束
  const child: ChildProcess = spawn(command, { shell: true, cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: useProcessGroup });
  return createChildProcessTransport(child, {
    onStderr: options.onStderr,
    maxBufferedBytes: options.maxBufferedBytes,
    terminate: () => killProcessTree(child),
  });
}

/** 傳輸需要的子程序最小介面（真實 ChildProcess 或測試替身）。 */
export interface CodexChildProcess {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly pid?: number;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export interface ChildProcessTransportOptions {
  onStderr?: (text: string) => void;
  /**
   * stdin 待寫緩衝上限（位元組）。子程序不讀 stdin 時寫入會堆在記憶體裡：
   * write() 返回 false（背壓）且緩衝超過上限就斷開傳輸，而不是無限增長。
   */
  maxBufferedBytes?: number;
  /** 結束子程序（程序樹）；預設 child.kill()。 */
  terminate?: () => void;
}

/** 預設的 stdin 待寫緩衝上限：16 MiB。正常的 JSON-RPC 訊息遠小於這個量級。 */
export const DEFAULT_MAX_STDIN_BUFFER = 16 * 1024 * 1024;

/**
 * 把 `codex app-server` 子程序的 stdio 包裝成按行傳輸。
 *
 * 管道錯誤（例如子程序已經關閉 stdin 但還沒退出時寫入得到 EPIPE / write EOF）是非同步以 'error' 事件出現的；
 * 沒有監聽時 Node 會把它當作未捕獲異常，整個服務程序隨之退出（H-14）。
 * 因此子程序一建立就給 stdin/stdout/stderr 掛 error 監聽，統一轉成傳輸關閉（上層對映為 CODEX_TRANSPORT_CLOSED）。
 */
export function createChildProcessTransport(child: CodexChildProcess, options: ChildProcessTransportOptions = {}): CodexTransport {
  const lineHandlers: Array<(line: string) => void> = [];
  const closeHandlers: Array<(reason: string) => void> = [];
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_STDIN_BUFFER;
  let closed = false;
  let exited = false;
  let terminated = false;
  const fireClose = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler(reason);
      } catch (error) {
        // 關閉回呼執行在流事件裡：這裡丟擲同樣會成為未捕獲異常，只能記錄
        console.error('[acc] codex transport close handler failed', error);
      }
    }
  };
  const terminate = () => {
    // 已退出或已結束過的程序不再結束（避免 PID 被系統複用後誤殺其他程序）
    if (exited || terminated) return;
    terminated = true;
    try {
      if (options.terminate) options.terminate();
      else child.kill();
    } catch (error) {
      console.error('[acc] failed to terminate codex app-server', error);
    }
  };
  /** 傳輸已不可用：先通知上層（拒絕所有待回覆請求），再結束子程序。 */
  const teardown = (reason: string) => {
    if (closed) return;
    fireClose(reason);
    terminate();
  };

  // 必須在任何寫入之前掛好：錯誤事件可能在下一個 tick 就出現
  child.stdin?.on('error', (error: Error) => teardown(`codex app-server stdin error: ${error.message}`));
  child.stdout?.on('error', (error: Error) => teardown(`codex app-server stdout error: ${error.message}`));
  child.stderr?.on('error', (error: Error) => teardown(`codex app-server stderr error: ${error.message}`));
  // stdin 被關閉後再也寫不進去：儘早失敗，而不是讓請求一直等到超時（通常是程序正在退出，不必再結束它）
  child.stdin?.on('close', () => fireClose('codex app-server stdin closed'));

  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    for (const handler of lineHandlers) handler(line);
  });
  // readline 會把輸入流的 error 再轉發到 Interface 自身：這裡同樣必須監聽，否則仍然是未捕獲異常
  lines.on('error', (error: Error) => teardown(`codex app-server stdout error: ${error.message}`));
  child.stderr?.on('data', (data) => options.onStderr?.(String(data)));
  child.on('exit', (code, signal) => {
    exited = true;
    fireClose(`codex app-server exited (code=${code}, signal=${signal})`);
  });
  child.on('error', (error) => fireClose(`codex app-server failed: ${error.message}`));

  return {
    write(line) {
      const stdin = child.stdin;
      if (closed || !stdin?.writable) throw new Error('Codex transport is closed');
      const ok = stdin.write(`${line}\n`);
      // 背壓：返回 false 說明子程序讀得比我們寫得慢；緩衝超過上限就斷開，避免記憶體無限增長
      if (!ok && stdin.writableLength > maxBuffered) {
        teardown(`codex app-server stdin backpressure: ${stdin.writableLength} bytes buffered (limit ${maxBuffered})`);
      }
    },
    onLine(handler) {
      lineHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      fireClose('closed by client');
      terminate();
    },
  };
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'CodexRpcError';
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string; timer?: NodeJS.Timeout };

/** 按行 JSON 的 JSON-RPC 客戶端（Codex 變體：無 "jsonrpc" 欄位）。 */
export class CodexRpcClient {
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private notificationHandlers: Array<(method: string, params: unknown) => void> = [];
  private requestHandlers: Array<(id: number | string, method: string, params: unknown) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private closedReason?: string;

  constructor(private readonly transport: CodexTransport) {
    transport.onLine((line) => this.handleLine(line));
    transport.onClose((reason) => {
      this.closedReason = reason;
      for (const [key, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new CodexRpcError(-32000, reason, pending.method));
        this.pending.delete(key);
      }
      for (const handler of this.closeHandlers) handler(reason);
    });
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closedReason) return Promise.reject(new CodexRpcError(-32000, this.closedReason, method));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { resolve: resolve as (value: unknown) => void, reject, method };
      pending.timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new CodexRpcError(-32001, `timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      this.pending.set(String(id), pending);
      try {
        this.transport.write(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(String(id));
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.transport.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id: number | string, result: unknown): void {
    this.transport.write(JSON.stringify({ id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.transport.write(JSON.stringify({ id, error: { code, message } }));
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  onServerRequest(handler: (id: number | string, method: string, params: unknown) => void): void {
    this.requestHandlers.push(handler);
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this.transport.close();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: CodexIncoming;
    try {
      message = JSON.parse(line) as CodexIncoming;
    } catch {
      return; // 非 JSON 行（例如日誌）忽略
    }
    const hasId = 'id' in message && message.id !== undefined && message.id !== null;
    const hasMethod = 'method' in message && typeof message.method === 'string';
    if (hasId && hasMethod) {
      const m = message as { id: number | string; method: string; params?: unknown };
      for (const handler of this.requestHandlers) handler(m.id, m.method, m.params);
      return;
    }
    if (hasId) {
      const m = message as { id: number | string; result?: unknown; error?: { code: number; message: string } };
      const pending = this.pending.get(String(m.id));
      if (!pending) return;
      this.pending.delete(String(m.id));
      clearTimeout(pending.timer);
      if (m.error) pending.reject(new CodexRpcError(m.error.code, m.error.message, pending.method));
      else pending.resolve(m.result);
      return;
    }
    if (hasMethod) {
      const m = message as { method: string; params?: unknown };
      for (const handler of this.notificationHandlers) handler(m.method, m.params);
    }
  }
}
