import type { ClaudeQueryFn, ClaudeQueryHandle } from '@acc/adapters';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * 可由測試逐步驅動的假 Claude query（P0-6）：每次 adapter 呼叫 query() 得到一個 DriverQuery，
 * 測試（或腳本）顯式決定它什麼時候初始化、讀哪條提示、以什麼方式結束這一輪——
 * 正常 result、錯誤 result、SDK 迭代拋錯（CLI 崩潰），或者迭代直接結束（CLI 以退出碼 0 意外退出）。
 * 不依賴任何定時器，時序完全由測試控制。
 */

const END = Symbol('end');
type Item = { message: SDKMessage } | { error: Error } | typeof END;
type Queued = Exclude<Item, typeof END>;

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

export interface ResultOptions {
  /** 預設 success。 */
  subtype?: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd';
  isError?: boolean;
  /** API 錯誤狀態碼（success + is_error 時的 api_error_status）；null 表示沒有 HTTP 響應的連線錯誤。 */
  apiErrorStatus?: number | null;
  errors?: string[];
  text?: string;
  queuedTurnCount?: number;
}

export class DriverQuery {
  readonly prompts: string[] = [];
  readonly sessionId: string;
  interrupts = 0;
  private readonly input: AsyncIterator<SDKUserMessage>;
  private readonly items: Queued[] = [];
  private readonly waiters: Array<(item: Item) => void> = [];
  private ended = false;
  private uuid = 0;
  readonly handle: ClaudeQueryHandle;

  constructor(
    readonly n: number,
    prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    this.sessionId = options.resume ?? `native-${n}`;
    this.input = prompt[Symbol.asyncIterator]();
    // 取消時 adapter 會 abort：與真實執行時一致，訊息流隨之結束
    options.abortController?.signal.addEventListener('abort', () => this.end(), { once: true });
    this.handle = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SDKMessage>> => {
          const item = await this.take();
          if (item === END) return { value: undefined, done: true };
          if ('error' in item) throw item.error;
          return { value: item.message, done: false };
        },
      }),
      interrupt: async () => {
        this.interrupts += 1;
        this.end();
      },
    };
  }

  /** 發出 system/init（adapter 的 start / resume 等它完成初始化）。 */
  init(): void {
    this.send(msg({ type: 'system', subtype: 'init', session_id: this.sessionId, model: 'fake', cwd: this.options.cwd ?? '.', permissionMode: this.options.permissionMode ?? 'default', uuid: this.nextUuid() }));
  }

  /** 讀取 adapter 交給執行時的下一條使用者訊息；輸入流關閉時返回 undefined。 */
  async nextPrompt(): Promise<string | undefined> {
    const next = await this.input.next();
    if (next.done) return undefined;
    const content = next.value.message.content;
    const text = typeof content === 'string' ? content : '';
    this.prompts.push(text);
    return text;
  }

  text(text: string): void {
    this.send(msg({ type: 'assistant', parent_tool_use_id: null, session_id: this.sessionId, uuid: this.nextUuid(), message: { content: [{ type: 'text', text }] } }));
  }

  /** 帶 error 欄位的 assistant 訊息（SDK 合成的 API 錯誤訊息）。 */
  assistantError(error: string): void {
    this.send(msg({ type: 'assistant', parent_tool_use_id: null, session_id: this.sessionId, uuid: this.nextUuid(), error, message: { content: [] } }));
  }

  /** 這一輪的 result。返回 result 的 uuid（adapter 用它作為 turnId）。 */
  result(options: ResultOptions = {}): string {
    const uuid = `result-${this.n}-${this.nextUuid()}`;
    const subtype = options.subtype ?? 'success';
    this.send(
      msg({
        type: 'result',
        subtype,
        is_error: options.isError ?? subtype !== 'success',
        ...(options.apiErrorStatus !== undefined ? { api_error_status: options.apiErrorStatus } : {}),
        ...(subtype === 'success' ? { result: options.text ?? 'done' } : { errors: options.errors ?? ['boom'] }),
        ...(options.queuedTurnCount !== undefined ? { queued_turn_count: options.queuedTurnCount } : {}),
        num_turns: 1,
        stop_reason: null,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        permission_denials: [],
        modelUsage: {},
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        session_id: this.sessionId,
        uuid,
      }),
    );
    return uuid;
  }

  /** SDK 迭代拋錯（CLI 崩潰、流斷開）。 */
  crash(message = 'Claude Code process exited with code 1'): void {
    this.push({ error: new Error(message) });
  }

  /** 迭代正常結束（CLI 以退出碼 0 退出）。已經排隊的訊息照常先讀出。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    // 沒有排隊的訊息時，正在等待的讀取立刻得到“結束”
    if (this.items.length === 0) for (const waiter of this.waiters.splice(0)) waiter(END);
  }

  /** 執行時發出一條 SDK 訊息。 */
  send(message: SDKMessage): void {
    this.push({ message });
  }

  private push(item: Queued): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  private take(): Promise<Item> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    // “結束”一旦出現就一直保持：之後的讀取都得到它
    if (this.ended) return Promise.resolve(END);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private nextUuid(): string {
    this.uuid += 1;
    return `${this.n}-${this.uuid}`;
  }
}

export type DriverScript = (query: DriverQuery) => Promise<void> | void;

/** 每次 query() 呼叫都記錄下來；可選的腳本自動驅動每個 query。 */
export class ClaudeQueryDriver {
  readonly queries: DriverQuery[] = [];
  private waiters: Array<{ n: number; resolve: (query: DriverQuery) => void }> = [];

  constructor(private readonly script?: DriverScript) {}

  readonly queryFn: ClaudeQueryFn = ({ prompt, options }) => {
    const query = new DriverQuery(this.queries.length + 1, prompt, options ?? {});
    this.queries.push(query);
    for (const waiter of this.waiters.filter((x) => x.n === query.n)) waiter.resolve(query);
    this.waiters = this.waiters.filter((x) => x.n !== query.n);
    if (this.script) {
      const script = this.script;
      void Promise.resolve()
        .then(() => script(query))
        .catch((error: unknown) => query.crash(error instanceof Error ? error.message : String(error)));
    }
    return query.handle;
  };

  /** 等待第 n 個 query（從 1 開始）被建立。 */
  query(n: number): Promise<DriverQuery> {
    const existing = this.queries[n - 1];
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }
}

/** 常用腳本：初始化後，每條提示都回復一句並以成功 result 結束這一輪。 */
export const echoScript: DriverScript = async (query) => {
  query.init();
  for (;;) {
    const prompt = await query.nextPrompt();
    if (prompt === undefined) return;
    query.text(`echo: ${prompt.slice(0, 40)}`);
    query.result();
  }
};
