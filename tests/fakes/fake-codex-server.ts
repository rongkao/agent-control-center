import type { CodexTransport } from '@acc/adapters';

/**
 * 假 Codex app-server：實現 adapter 用到的協議子集（按行 JSON，無 jsonrpc 欄位）。
 * FakeCodexDisk 模擬 ~/.codex 下持久化的執行緒記錄，跨“程序重啟”共享。
 */
export class FakeCodexDisk {
  threads = new Map<string, Set<string>>();
  executions: string[] = [];
  private counter = 0;
  newThreadId(): string {
    return `thread-${++this.counter}`;
  }
}

export type CodexStep =
  | { kind: 'command'; id: string; command: string; needsApproval?: boolean; exitCode?: number }
  | { kind: 'message'; text: string }
  | { kind: 'error'; info: string; willRetry?: boolean }
  /** 服務端自己中斷這一輪（不是客戶端請求的 turn/interrupt），回合以 interrupted 結束。 */
  | { kind: 'interrupted' }
  /** 這一輪在這裡停住，直到 until 完成（模擬模型還在思考）；之後照常檢查是否已被中斷。 */
  | { kind: 'pause'; until: Promise<void> }
  /** 發出一條通知（自動帶上 threadId / turnId），例如 item/commandExecution/outputDelta。 */
  | { kind: 'notify'; method: string; params: Record<string, unknown> }
  /**
   * 檔案改動（apply_patch，P0-8）：先發 item/started（帶 changes），needsApproval 時再發 item/fileChange/requestApproval，
   * 按客戶端的決定以 completed / declined 結束。moveTo 對應協議裡 update 的 move_path。
   */
  | { kind: 'fileChange'; id: string; changes: Array<{ path: string; moveTo?: string }>; needsApproval?: boolean; grantRoot?: string }
  /** 向使用者提問（P2-6）：發出 item/tool/requestUserInput，等客戶端的答案（記在 approvalResponses 裡）。 */
  | { kind: 'userInput'; id: string; questions: Array<Record<string, unknown>> };

export interface FakeTurnCtx {
  threadId: string;
  text: string;
  resumed: boolean;
}

export type CodexScript = (ctx: FakeTurnCtx) => CodexStep[];

export class FakeCodexServer {
  readonly received: Array<{ method: string; params: unknown }> = [];
  /** Windows 沙箱就緒狀態（P2-8）。 */
  windowsSandboxStatus: 'ready' | 'notConfigured' | 'updateRequired' = 'notConfigured';
  /** 客戶端對服務端審批請求的回覆（按到達順序）。 */
  readonly approvalResponses: Array<{ method: string; itemId: string; response: unknown }> = [];
  /** 合併進 thread/start、thread/resume 響應的欄位（例如模擬服務端回報另一個 approvalsReviewer）。 */
  threadResultOverrides: Record<string, unknown> = {};
  /** 為 true 時拒絕 turn/steer（模擬過時的 turnId）。 */
  rejectSteer = false;
  private lineHandlers: Array<(line: string) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private waiters = new Map<string, (result: unknown) => void>();
  private nextServerId = 1000;
  private turnCounter = 0;
  private interrupted = new Set<string>();
  private resumedThreads = new Set<string>();
  closed = false;

  constructor(
    private readonly disk: FakeCodexDisk,
    private readonly script: CodexScript,
  ) {}

  /** 給 adapter 用的傳輸。 */
  readonly transport: CodexTransport = {
    write: (line) => {
      if (this.closed) throw new Error('closed');
      void this.handle(JSON.parse(line) as Record<string, unknown>);
    },
    onLine: (handler) => this.lineHandlers.push(handler),
    onClose: (handler) => this.closeHandlers.push(handler),
    close: () => this.crash('closed by client'),
  };

  /** 模擬 app-server 程序崩潰。 */
  crash(reason = 'crashed'): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler(reason);
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    const line = JSON.stringify(message);
    // 非同步投遞，模擬真實管道
    setImmediate(() => {
      for (const handler of this.lineHandlers) handler(line);
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.waiters.set(String(id), (response) => {
        this.approvalResponses.push({ method, itemId: String((params as { itemId?: unknown } | undefined)?.itemId ?? ''), response });
        resolve(response);
      });
      this.send({ id, method, params });
    });
  }

  private async handle(message: Record<string, unknown>): Promise<void> {
    const { id, method, params } = message as { id?: number; method?: string; params?: Record<string, unknown> };
    if (method) this.received.push({ method, params });
    if (id !== undefined && !method) {
      // 客戶端對服務端請求的響應
      this.waiters.get(String(id))?.((message as { result?: unknown }).result ?? (message as { error?: unknown }).error);
      this.waiters.delete(String(id));
      return;
    }
    switch (method) {
      case 'initialize':
        this.send({ id, result: { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'linux' } });
        return;
      case 'initialized':
        return;
      // Windows 沙箱（P2-8）：就緒狀態由 windowsSandboxStatus 決定；setupStart 之後發 setupCompleted 並變成 ready
      case 'windowsSandbox/readiness':
        this.send({ id, result: { status: this.windowsSandboxStatus } });
        return;
      case 'windowsSandbox/setupStart':
        this.send({ id, result: { started: true } });
        setTimeout(() => {
          this.windowsSandboxStatus = 'ready';
          this.send({ method: 'windowsSandbox/setupCompleted', params: { mode: params?.mode, success: true, error: null } });
        }, 10);
        return;
      case 'thread/start': {
        const threadId = this.disk.newThreadId();
        this.disk.threads.set(threadId, new Set());
        this.send({ id, result: { thread: { id: threadId, sessionId: threadId }, model: 'fake-codex', cwd: String(params?.cwd ?? '/w'), ...this.threadResultOverrides } });
        return;
      }
      case 'thread/resume': {
        const threadId = String(params?.threadId);
        if (!this.disk.threads.has(threadId)) {
          this.send({ id, error: { code: -32602, message: `no rollout found for thread id ${threadId}` } });
          return;
        }
        this.resumedThreads.add(threadId);
        this.send({ id, result: { thread: { id: threadId, sessionId: threadId }, model: 'fake-codex', cwd: '/w', ...this.threadResultOverrides } });
        return;
      }
      case 'turn/start': {
        const threadId = String(params?.threadId);
        const turnId = `turn-${++this.turnCounter}`;
        const text = ((params?.input as Array<{ text: string }>) ?? [])[0]?.text ?? '';
        this.send({ id, result: { turn: { id: turnId, status: 'inProgress', error: null, durationMs: null } } });
        void this.runTurn(threadId, turnId, text);
        return;
      }
      case 'turn/steer':
        // 模擬回合剛好結束、expectedTurnId 已經過時（L-9）
        if (this.rejectSteer) {
          this.send({ id, error: { code: -32600, message: 'expectedTurnId does not match the active turn' } });
          return;
        }
        this.send({ id, result: { turnId: params?.expectedTurnId } });
        return;
      case 'turn/interrupt':
        this.interrupted.add(String(params?.turnId));
        this.send({ id, result: {} });
        return;
      default:
        this.send({ id, error: { code: -32601, message: `unknown method ${method}` } });
    }
  }

  private async runTurn(threadId: string, turnId: string, text: string): Promise<void> {
    const done = this.disk.threads.get(threadId)!;
    this.send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress', error: null, durationMs: null } } });
    let failed: { message: string; codexErrorInfo: string; additionalDetails: null } | null = null;
    for (const step of this.script({ threadId, text, resumed: this.resumedThreads.has(threadId) })) {
      if (this.interrupted.has(turnId) || this.closed) break;
      if (step.kind === 'pause') {
        await step.until;
        continue;
      }
      if (step.kind === 'notify') {
        this.send({ method: step.method, params: { threadId, turnId, ...step.params } });
        continue;
      }
      if (step.kind === 'message') {
        this.send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: `msg-${turnId}`, text: step.text }, completedAtMs: 1 } });
      } else if (step.kind === 'interrupted') {
        this.interrupted.add(turnId);
        break;
      } else if (step.kind === 'error') {
        const error = { message: `fake ${step.info}`, codexErrorInfo: step.info, additionalDetails: null };
        this.send({ method: 'error', params: { threadId, turnId, willRetry: step.willRetry === true, error } });
        if (!step.willRetry) failed = error;
      } else if (step.kind === 'userInput') {
        await this.request('item/tool/requestUserInput', { threadId, turnId, itemId: `${step.id}@${turnId}`, isBlocking: true, questions: step.questions });
      } else if (step.kind === 'fileChange') {
        const itemId = `${step.id}@${turnId}`;
        const changes = step.changes.map((c) => ({ path: c.path, kind: c.moveTo ? { type: 'update', move_path: c.moveTo } : { type: 'update', move_path: null }, diff: '' }));
        const base = { type: 'fileChange', id: itemId, changes };
        this.send({ method: 'item/started', params: { threadId, turnId, item: { ...base, status: 'inProgress' }, startedAtMs: 1 } });
        let decision = 'accept';
        if (step.needsApproval) {
          const response = (await this.request('item/fileChange/requestApproval', { threadId, turnId, itemId, startedAtMs: 1, reason: null, ...(step.grantRoot ? { grantRoot: step.grantRoot } : {}) })) as { decision?: string };
          decision = response?.decision ?? 'decline';
        }
        const applied = decision === 'accept' || decision === 'acceptForSession';
        if (applied) this.disk.executions.push(step.id);
        this.send({ method: 'item/completed', params: { threadId, turnId, item: { ...base, status: applied ? 'completed' : 'declined' }, completedAtMs: 1 } });
      } else if (step.kind === 'command') {
        if (done.has(step.id)) continue;
        const itemId = `${step.id}@${turnId}`;
        const base = { type: 'commandExecution', id: itemId, command: step.command, cwd: '/w', exitCode: null, durationMs: null, aggregatedOutput: null };
        this.send({ method: 'item/started', params: { threadId, turnId, item: { ...base, status: 'inProgress' }, startedAtMs: 1 } });
        let decision = 'accept';
        if (step.needsApproval) {
          const response = (await this.request('item/commandExecution/requestApproval', { threadId, turnId, itemId, command: step.command, cwd: '/w', reason: null, startedAtMs: 1 })) as { decision?: string };
          decision = response?.decision ?? 'decline';
        }
        if (decision !== 'accept' && decision !== 'acceptForSession') {
          this.send({ method: 'item/completed', params: { threadId, turnId, item: { ...base, status: 'declined' }, completedAtMs: 1 } });
          continue;
        }
        this.disk.executions.push(step.id);
        done.add(step.id);
        const exitCode = step.exitCode ?? 0;
        this.send({ method: 'item/completed', params: { threadId, turnId, item: { ...base, status: exitCode === 0 ? 'completed' : 'failed', exitCode }, completedAtMs: 1 } });
      }
    }
    if (this.closed) return;
    this.send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 5 }, last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 5 } } } });
    const status = this.interrupted.has(turnId) ? 'interrupted' : failed ? 'failed' : 'completed';
    this.send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, error: failed, durationMs: 42 } } });
  }
}
