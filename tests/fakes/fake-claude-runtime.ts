import type { ClaudeQueryFn, ClaudeQueryHandle } from '@acc/adapters';
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * 假 Claude Agent SDK 執行時（只實現 adapter 用到的 query() 子集）。
 * FakeClaudeDisk 模擬 Claude Code 落盤的會話記錄，跨“程序重啟”共享。
 */
export class FakeClaudeDisk {
  /** session_id -> 已完成的步驟 ID（相當於會話 JSONL 中的 tool_result）。 */
  transcripts = new Map<string, Set<string>>();
  /** 外部副作用記錄。 */
  executions: string[] = [];
  private counter = 0;
  newSessionId(): string {
    return `native-session-${++this.counter}`;
  }
}

export interface FakeTurnContext {
  sessionId: string;
  prompt: string;
  resumed: boolean;
  options: Options;
  /** 傳送一條 SDK 訊息。 */
  send(message: SDKMessage): void;
  /** 執行一個工具步驟：已在會話記錄中的步驟跳過；needsPermission 時走 canUseTool。 */
  tool(step: { id: string; name: string; input: Record<string, unknown>; needsPermission?: boolean }): Promise<'done' | 'denied' | 'skipped'>;
}

export type FakeScript = (ctx: FakeTurnContext) => Promise<void>;

class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

export class FakeClaudeRuntime {
  readonly queries: Array<{ options: Options; prompts: string[]; interrupts: number }> = [];

  constructor(
    private readonly disk: FakeClaudeDisk,
    private readonly script: FakeScript,
    /** 可選：覆蓋每一輪 result 訊息裡的欄位（例如 total_cost_usd、modelUsage），引數是這一輪的上下文。 */
    private readonly resultOverride?: (ctx: FakeTurnContext) => Record<string, unknown>,
  ) {}

  readonly queryFn: ClaudeQueryFn = ({ prompt, options = {} }) => {
    const out = new Channel<SDKMessage>();
    const record = { options, prompts: [] as string[], interrupts: 0 };
    this.queries.push(record);
    const sessionId = options.resume ?? this.disk.newSessionId();
    const transcript = this.disk.transcripts.get(sessionId) ?? new Set<string>();
    this.disk.transcripts.set(sessionId, transcript);
    options.abortController?.signal.addEventListener('abort', () => out.close(), { once: true });

    const run = async () => {
      out.push(msg({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: options.cwd ?? '.', permissionMode: options.permissionMode ?? 'default', tools: [], mcp_servers: [], slash_commands: [], apiKeySource: 'none', claude_code_version: 'fake', output_style: 'default', skills: [], plugins: [], uuid: 'u' }));
      for await (const user of prompt as AsyncIterable<SDKUserMessage>) {
        const text = typeof user.message.content === 'string' ? user.message.content : '';
        record.prompts.push(text);
        const ctx: FakeTurnContext = {
          sessionId,
          prompt: text,
          resumed: Boolean(options.resume),
          options,
          send: (m) => out.push(m),
          tool: async (step) => {
            if (transcript.has(step.id)) return 'skipped';
            out.push(msg({ type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: 'u', message: { content: [{ type: 'tool_use', id: `toolu_${step.id}_${record.prompts.length}`, name: step.name, input: step.input }] } }));
            const toolUseID = `toolu_${step.id}_${record.prompts.length}`;
            if (step.needsPermission) {
              const result = (await options.canUseTool!(step.name, step.input, { signal: new AbortController().signal, toolUseID, requestId: 'r', title: `Allow ${step.name}?` })) as PermissionResult;
              if (result.behavior !== 'allow') {
                out.push(msg({ type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, is_error: true, content: 'denied' }] } }));
                return 'denied';
              }
            }
            this.disk.executions.push(step.id);
            transcript.add(step.id);
            out.push(msg({ type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseID, content: 'ok' }] } }));
            return 'done';
          },
        };
        await this.script(ctx);
        out.push(msg({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, stop_reason: 'end_turn', duration_ms: 10, duration_api_ms: 5, total_cost_usd: 0.01, session_id: sessionId, uuid: 'u', permission_denials: [], modelUsage: {}, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }, ...(this.resultOverride?.(ctx) ?? {}) }));
      }
      out.close();
    };
    void run().catch(() => out.close());

    const handle: ClaudeQueryHandle = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => {
        record.interrupts += 1;
        out.close();
      },
    };
    return handle;
  };
}
