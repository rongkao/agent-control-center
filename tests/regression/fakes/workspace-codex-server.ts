import type { CodexTransport } from '@acc/adapters';
import { FakeCodexServer, type CodexScript, type FakeCodexDisk } from '../../fakes/fake-codex-server.js';

/**
 * 關心工作目錄的假 Codex app-server（H-4）。
 *
 * 包裝 tests/fakes 裡的 FakeCodexServer 的傳輸，不改變原替身的預設行為：
 * - 記住 thread/start 時執行緒的 cwd（跨“程序重啟”共享，放在 threadCwds 裡）；
 * - thread/resume 的響應報告“服務端實際使用的 cwd”：請求裡帶了 cwd 覆蓋值就用它，否則是執行緒建立時的 cwd，
 *   與真實 app-server 一致（原替身固定回報 '/w'）；
 * - resumeCwdOverride：強制讓 thread/resume 回報另一個目錄，模擬服務端沒有采用我們要求的工作目錄；
 * - holdTurnCompletion：扣住 turn/completed 通知，讓回合停在“進行中”，模擬重啟時 agent 正在工作。
 */
export class WorkspaceCodexServer {
  readonly inner: FakeCodexServer;
  readonly transport: CodexTransport;
  /** 設定後 thread/resume 固定回報這個 cwd。 */
  resumeCwdOverride?: string;
  /** 為 true 時扣住 turn/completed（不投遞給 adapter）。 */
  holdTurnCompletion = false;
  readonly heldNotifications: string[] = [];

  private handlers: Array<(line: string) => void> = [];
  /** 客戶端請求 id → 需要改寫的響應。 */
  private pending = new Map<string, { kind: 'start' } | { kind: 'resume'; threadId: string; cwd?: string }>();

  constructor(
    disk: FakeCodexDisk,
    script: CodexScript,
    /** threadId → 執行緒建立時的 cwd。 */
    readonly threadCwds: Map<string, string> = new Map(),
  ) {
    this.inner = new FakeCodexServer(disk, script);
    this.inner.transport.onLine((line) => this.deliver(line));
    this.transport = {
      write: (line) => {
        const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
        if (message.id !== undefined && message.method === 'thread/start') {
          this.pending.set(String(message.id), { kind: 'start' });
        } else if (message.id !== undefined && message.method === 'thread/resume') {
          const cwd = message.params?.cwd;
          this.pending.set(String(message.id), { kind: 'resume', threadId: String(message.params?.threadId), cwd: typeof cwd === 'string' ? cwd : undefined });
        }
        this.inner.transport.write(line);
      },
      onLine: (handler) => {
        this.handlers.push(handler);
      },
      onClose: (handler) => this.inner.transport.onClose(handler),
      close: () => this.inner.transport.close(),
    };
  }

  /** 客戶端發給服務端的請求（含 method 與 params）。 */
  get received(): Array<{ method: string; params: unknown }> {
    return this.inner.received;
  }

  /** 第一條指定方法的請求引數。 */
  paramsOf(method: string): Record<string, unknown> | undefined {
    return this.received.find((x) => x.method === method)?.params as Record<string, unknown> | undefined;
  }

  private deliver(line: string): void {
    const message = JSON.parse(line) as { id?: number | string; method?: string; result?: Record<string, unknown> };
    if (message.method === 'turn/completed' && this.holdTurnCompletion) {
      this.heldNotifications.push(line);
      return;
    }
    const pending = message.id !== undefined && !message.method ? this.pending.get(String(message.id)) : undefined;
    if (pending && message.result) {
      this.pending.delete(String(message.id));
      const result = message.result as { thread?: { id?: string }; cwd?: string };
      if (pending.kind === 'start') {
        if (result.thread?.id && typeof result.cwd === 'string') this.threadCwds.set(result.thread.id, result.cwd);
      } else {
        result.cwd = this.resumeCwdOverride ?? pending.cwd ?? this.threadCwds.get(pending.threadId) ?? result.cwd;
      }
      line = JSON.stringify(message);
    }
    for (const handler of this.handlers) handler(line);
  }
}
