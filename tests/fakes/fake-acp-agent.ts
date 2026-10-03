import * as acp from '@agentclientprotocol/sdk';
import type { AcpTransport } from '@acc/adapters';

/**
 * 記憶體裡的假 ACP agent（P2-1）：用官方 SDK 的 AgentSideConnection 實現協議的 agent 一側，
 * 與 AcpAdapter 之間用一對 TransformStream 連線，不啟動任何程序。
 *
 * 每一輪：回覆一段文字（分兩塊流式發出）→ 如果腳本要求，發起一個工具呼叫並請求權限 → 按客戶端的選擇完成或放棄 → end_turn。
 * 支援取消（這一輪以 cancelled 結束）、session/load 回放歷史（可以關掉 resume 能力，強制走 load）。
 */
export interface FakeAcpOptions {
  /** 是否宣稱支援 session/resume（預設 true）。 */
  resume?: boolean;
  /** 每一輪是否發起一個需要權限的工具呼叫。 */
  tool?: { kind: acp.ToolKind; title: string };
  /** 這一輪停在這裡直到被取消。 */
  hang?: boolean;
  /** 可用的會話模式。 */
  modes?: string[];
  /** 這一輪以錯誤結束（JSON-RPC 錯誤）。 */
  fail?: boolean;
  /** 開會話之前必須先認證（例如 Gemini CLI）。 */
  requireAuth?: boolean;
}

export class FakeAcpAgent {
  readonly prompts: string[] = [];
  readonly permissionOutcomes: acp.RequestPermissionResponse[] = [];
  readonly calls: string[] = [];
  readonly modeChanges: string[] = [];
  private readonly history = new Map<string, acp.SessionNotification[]>();
  private readonly cancelled = new Set<string>();
  private counter = 0;
  readonly authenticated: string[] = [];
  private conn?: acp.AgentSideConnection;

  constructor(private readonly options: FakeAcpOptions = {}) {}

  transport(): AcpTransport {
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    this.conn = new acp.AgentSideConnection(() => this.agent(), acp.ndJsonStream(toClient.writable, toAgent.readable));
    const listeners: Array<(reason: string) => void> = [];
    return {
      stream: acp.ndJsonStream(toAgent.writable, toClient.readable),
      close: () => {
        for (const l of listeners.splice(0)) l('closed');
      },
      onClose: (l) => listeners.push(l),
    };
  }

  private agent(): acp.Agent {
    return {
      initialize: async () => {
        this.calls.push('initialize');
        return {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, sessionCapabilities: this.options.resume === false ? {} : { resume: {} } },
          authMethods: this.options.requireAuth ? [{ id: 'oauth-personal', name: 'Login' }, { id: 'gemini-api-key', name: 'API key' }] : [],
        };
      },
      newSession: async () => {
        this.calls.push('newSession');
        if (this.options.requireAuth && this.authenticated.length === 0) throw acp.RequestError.authRequired();
        const sessionId = `s${++this.counter}`;
        this.history.set(sessionId, []);
        const modes = this.options.modes;
        return { sessionId, ...(modes ? { modes: { currentModeId: modes[0]!, availableModes: modes.map((id) => ({ id, name: id })) } } : {}) };
      },
      setSessionMode: async (params) => {
        this.modeChanges.push(params.modeId);
      },
      authenticate: async (params) => {
        this.authenticated.push(params.methodId);
      },
      resumeSession: async () => {
        this.calls.push('resumeSession');
        return {};
      },
      loadSession: async (params) => {
        this.calls.push('loadSession');
        // 回放歷史
        for (const n of this.history.get(params.sessionId) ?? []) await this.conn!.sessionUpdate(n);
      },
      cancel: async (params) => {
        this.cancelled.add(params.sessionId);
      },
      prompt: async (params) => {
        const sessionId = params.sessionId;
        this.cancelled.delete(sessionId);
        const text = params.prompt.map((p) => (p.type === 'text' ? p.text : '')).join('');
        this.prompts.push(text);
        const send = async (update: acp.SessionUpdate) => {
          const n = { sessionId, update };
          this.history.get(sessionId)?.push(n);
          await this.conn!.sessionUpdate(n);
        };
        if (this.options.fail) throw new Error('model overloaded');
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on ' } });
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'it.' } });
        if (this.options.tool) {
          const toolCallId = `call-${this.prompts.length}`;
          await send({ sessionUpdate: 'tool_call', toolCallId, title: this.options.tool.title, kind: this.options.tool.kind, status: 'pending', rawInput: { path: 'src/a.ts' } });
          const outcome = await this.conn!.requestPermission({
            sessionId,
            toolCall: { toolCallId, title: this.options.tool.title, kind: this.options.tool.kind },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'always', name: 'Always', kind: 'allow_always' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          });
          this.permissionOutcomes.push(outcome);
          const allowed = outcome.outcome.outcome === 'selected' && outcome.outcome.optionId !== 'reject';
          await send({ sessionUpdate: 'tool_call_update', toolCallId, status: allowed ? 'completed' : 'failed' });
        }
        if (this.options.hang) {
          while (!this.cancelled.has(sessionId)) await new Promise((r) => setTimeout(r, 20));
        }
        return { stopReason: this.cancelled.has(sessionId) ? 'cancelled' : 'end_turn' };
      },
    };
  }
}
