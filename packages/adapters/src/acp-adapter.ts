import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AgentAdapter,
  AgentInfo,
  AgentMode,
  AgentResumeInput,
  AgentSendOptions,
  AgentSessionHandle,
  AgentStartInput,
  ApprovalDecision,
  EventSeverity,
  EventSink,
  EventType,
} from '@acc/core';
import { isReadOnlyAgentMode } from '@acc/core';
import { acpRuntimeEnv, type AcpEnvOptions, type EnvSource } from './env-policy.js';
import { defaultAdapterLog, resumePrompt, safeEmit, type AdapterLog } from './shared.js';

/**
 * 通用 ACP（Agent Client Protocol）adapter（P2-1）：任何支援 ACP 的編碼 agent（Gemini CLI、OpenCode……）都用這一個 adapter 接入。
 *
 * - 一個 agent 程序服務多個會話：session/new 開會話，session/prompt 做一輪，session/cancel 停下；
 * - session/update 歸一成統一事件：回覆（逐字流式 + 一輪結束時的完整回覆）、工具呼叫開始 / 完成 / 失敗；
 * - session/request_permission 走 ACC 的審批；唯讀的一輪（評審、診斷、分析）自動拒絕改檔案 / 刪除 / 移動 / 執行命令的請求；
 * - 續接優先用 session/resume（不回放）；只支援 session/load 時，回放期間的更新一律丟棄（不進事件日誌、不進副作用台賬）；
 * - 啟動前探測引數（例如 Gemini CLI 新版用 --acp、舊版用 --experimental-acp）；透過 npx 分發的 agent 必須固定版本號。
 */

export interface AcpPreset {
  name: string;
  command: string;
  /** 固定引數。 */
  args?: string[];
  /** 候選引數（按順序）：啟動前用 `<command> --help` 探測，第一個在幫助文字裡出現的生效；都沒有時用最後一個。 */
  argCandidates?: string[][];
  env?: AcpEnvOptions;
}

/** 內建預設（P2-1）：Gemini CLI 與 OpenCode。 */
export const ACP_PRESETS: Readonly<Record<string, AcpPreset>> = {
  gemini: {
    name: 'Gemini CLI',
    command: 'gemini',
    argCandidates: [['--acp'], ['--experimental-acp']],
    env: { prefixes: ['GEMINI_', 'GOOGLE_CLOUD_', 'GOOGLE_GENAI_'], secrets: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  },
  opencode: {
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    env: { prefixes: ['OPENCODE_'], secrets: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  },
};

/** ACP 連線（測試可以注入記憶體裡的連線）。 */
export interface AcpTransport {
  stream: acp.Stream;
  close(): void;
  /** 程序退出 / 連線斷開時回呼。 */
  onClose(listener: (reason: string) => void): void;
}

export interface AcpAdapterOptions {
  id: string;
  name?: string;
  command: string;
  args?: string[];
  argCandidates?: string[][];
  env?: AcpEnvOptions;
  envSource?: EnvSource;
  defaultCwd?: string;
  capabilities?: string[];
  log?: AdapterLog;
  /** 測試用：注入連線。 */
  transportFactory?: (args: string[]) => AcpTransport;
  /** 測試用：返回 `<command> --help` 的輸出。 */
  helpProbe?: (command: string) => string;
}

/** 改檔案、刪除、移動、執行命令：唯讀的一輪裡一律拒絕。 */
const WRITE_KINDS = new Set(['edit', 'delete', 'move', 'execute']);

interface PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void;
  options: acp.PermissionOption[];
}

interface AcpSession {
  localId: string;
  acpSessionId: string;
  ids: { projectId: string; taskId: string; runId: string };
  emit: EventSink;
  cwd: string;
  mode?: AgentMode;
  readOnly: boolean;
  busy: boolean;
  cancelled: boolean;
  /** 進行中的一輪：終態只發一次（終態合約）。 */
  current?: { id: string; ended: boolean };
  turnCounter: number;
  /** session/load 回放期間（P2-1）：更新一律丟棄。 */
  replaying: boolean;
  text: string;
  tools: Map<string, { kind?: string; done: boolean }>;
  permissions: Map<string, PendingPermission>;
  turn: Promise<void>;
}

/** 選引數：第一個在幫助文字裡出現的候選；都沒有時用最後一個。 */
export function detectAcpArgs(help: string, candidates: string[][]): string[] {
  for (const candidate of candidates) {
    const flag = candidate[0];
    if (flag && new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|=|,|$)`, 'm').test(help)) return candidate;
  }
  return candidates.at(-1) ?? [];
}

/** 透過 npx 啟動時必須固定版本號（P2-1）：返回問題說明，沒有問題時返回 undefined。 */
export function unpinnedNpxProblem(command: string, args: readonly string[]): string | undefined {
  if (!/^npx(\.cmd)?$/i.test(command.split(/[\\/]/).pop() ?? '')) return undefined;
  const spec = args.find((a) => !a.startsWith('-'));
  if (!spec) return 'npx 沒有指定要執行的套件。';
  const at = spec.lastIndexOf('@');
  const version = at > 0 ? spec.slice(at + 1) : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) return `透過 npx 執行的 ${spec} 沒有固定版本號（例如 ${spec.replace(/@[^@/]*$/, '')}@1.2.3），每次啟動都可能換成不同的版本。`;
  return undefined;
}

export class AcpAdapter implements AgentAdapter {
  readonly info: AgentInfo;
  private connection?: acp.ClientSideConnection;
  private connecting?: Promise<acp.ClientSideConnection>;
  private transport?: AcpTransport;
  private agentCapabilities?: acp.AgentCapabilities;
  private authMethods: acp.AuthMethod[] = [];
  private authenticated = false;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly byAcpSession = new Map<string, AcpSession>();
  private readonly log: AdapterLog;
  private disposed = false;
  private resolvedArgs?: string[];

  constructor(private readonly options: AcpAdapterOptions) {
    this.log = options.log ?? defaultAdapterLog;
    const problem = unpinnedNpxProblem(options.command, options.args ?? []);
    this.info = {
      id: options.id,
      name: options.name ?? options.id,
      kind: 'other',
      ready: !problem,
      ...(problem ? { notReadyReason: problem } : {}),
      capabilities: options.capabilities ?? ['implement', 'analysis', 'review'],
    };
  }

  /** 實際使用的啟動引數（探測一次）。 */
  launchArgs(): string[] {
    if (this.resolvedArgs) return this.resolvedArgs;
    const fixed = this.options.args ?? [];
    if (!this.options.argCandidates?.length) return (this.resolvedArgs = fixed);
    const help = (this.options.helpProbe ?? defaultHelpProbe)(this.options.command);
    return (this.resolvedArgs = [...fixed, ...detectAcpArgs(help, this.options.argCandidates)]);
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const conn = await this.connect();
    const cwd = input.cwd ?? this.options.defaultCwd ?? process.cwd();
    const created = await this.withAuth(conn, () => conn.newSession({ cwd, mcpServers: [] }));
    const session = this.createSession(created.sessionId, input, emit, cwd, input.mode);
    await this.applyMode(conn, session, created.modes ?? undefined);
    await this.emitFor(session, 'agent.started', { adapterType: 'acp', command: this.options.command });
    this.queueTurn(session, input.prompt);
    return { sessionId: session.localId, providerSessionId: created.sessionId };
  }

  async send(sessionId: string, message: string, _emit: EventSink, options: AgentSendOptions = {}): Promise<void> {
    const session = this.mustSession(sessionId);
    session.cancelled = false;
    if (options.mode) {
      session.mode = options.mode;
      session.readOnly = isReadOnlyAgentMode(options.mode);
    }
    this.queueTurn(session, message);
  }

  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    const acpSessionId = input.metadata?.providerSessionId;
    if (typeof acpSessionId !== 'string' || !acpSessionId) throw new Error('Cannot resume ACP session without its session id');
    const cwd = typeof input.metadata?.cwd === 'string' ? input.metadata.cwd : this.options.defaultCwd;
    if (!cwd) throw new Error('Cannot resume ACP session without its working directory');
    const conn = await this.connect();
    const mode = (typeof input.metadata?.mode === 'string' ? input.metadata.mode : undefined) as AgentMode | undefined;
    const session =
      this.sessions.get(sessionId) ?? this.createSession(acpSessionId, { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, emit, cwd, mode, sessionId);
    session.emit = emit;
    session.cancelled = false;
    const caps = this.agentCapabilities;
    if (caps?.sessionCapabilities?.resume) {
      // 優先 session/resume：不回放歷史
      await this.withAuth(conn, () => conn.resumeSession({ sessionId: acpSessionId, cwd }));
    } else if (caps?.loadSession) {
      // session/load 會把歷史逐條回放成 session/update：回放期間一律丟棄（已經記過了，不能再算一次副作用）
      session.replaying = true;
      try {
        await this.withAuth(conn, () => conn.loadSession({ sessionId: acpSessionId, cwd, mcpServers: [] }));
      } finally {
        session.replaying = false;
      }
    } else {
      throw new Error(`${this.info.name} does not support resuming sessions (no session/resume or session/load)`);
    }
    this.queueTurn(session, resumePrompt(input));
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    for (const [id, pending] of session.permissions) {
      session.permissions.delete(id);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    await this.connection?.cancel({ sessionId: session.acpSessionId }).catch(() => undefined);
    // 這一輪立即以 cancelled 結束（終態合約）：agent 之後才送到的結果不再產生終態；重複取消不會多出終態
    const turn = session.current;
    if (turn && !turn.ended) await this.finishTurn(session, turn, 'cancelled');
  }

  async approve(sessionId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.mustSession(sessionId);
    const pending = session.permissions.get(decision.approvalId);
    if (!pending) throw new Error(`No pending ACP permission request for approval ${decision.approvalId}`);
    session.permissions.delete(decision.approvalId);
    const pick = (kinds: acp.PermissionOptionKind[]) => kinds.map((k) => pending.options.find((o) => o.kind === k)).find(Boolean);
    const option = decision.decision === 'approve' ? pick(decision.scope === 'session' ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    pending.resolve(option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
  }

  async release(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.byAcpSession.delete(session.acpSessionId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      for (const pending of session.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
      session.cancelled = true;
    }
    this.transport?.close();
    this.transport = undefined;
    this.connection = undefined;
  }

  // ---------- 內部 ----------

  private createSession(acpSessionId: string, ids: AcpSession['ids'], emit: EventSink, cwd: string, mode?: AgentMode, localId = `acp-${randomUUID()}`): AcpSession {
    const session: AcpSession = {
      localId,
      acpSessionId,
      ids: { projectId: ids.projectId, taskId: ids.taskId, runId: ids.runId },
      emit,
      cwd,
      mode,
      readOnly: isReadOnlyAgentMode(mode),
      busy: false,
      cancelled: false,
      turnCounter: 0,
      replaying: false,
      text: '',
      tools: new Map(),
      permissions: new Map(),
      turn: Promise.resolve(),
    };
    this.sessions.set(localId, session);
    this.byAcpSession.set(acpSessionId, session);
    return session;
  }

  /**
   * 需要認證時（例如 Gemini CLI 的 “Authentication required”）按 agent 提供的方式認證一次再重試：
   * 設定了 API key 就用 API key 的方式，否則用第一個方式（通常是本機已經登入過的快取憑據）。
   */
  private async withAuth<T>(conn: acp.ClientSideConnection, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.authenticated || this.authMethods.length === 0 || !/auth/i.test((error as Error).message)) throw error;
      const env = this.options.envSource ?? process.env;
      const hasKey = Object.keys(env).some((k) => /API_KEY$/i.test(k) && env[k]);
      const method = (hasKey ? this.authMethods.find((m) => /api.?key/i.test(m.id)) : undefined) ?? this.authMethods[0]!;
      await conn.authenticate({ methodId: method.id });
      this.authenticated = true;
      return fn();
    }
  }

  /** 唯讀的一輪：agent 有 plan / read-only 模式時切過去（權限請求照樣按唯讀拒絕，雙保險）。 */
  private async applyMode(conn: acp.ClientSideConnection, session: AcpSession, modes: acp.SessionModeState | undefined): Promise<void> {
    if (!session.readOnly || !modes) return;
    const target = modes.availableModes.find((m) => /plan|read.?only|ask/i.test(m.id));
    if (target && target.id !== modes.currentModeId) await conn.setSessionMode({ sessionId: session.acpSessionId, modeId: target.id }).catch(() => undefined);
  }

  /** 同一個會話的輪次序列（ACP 不允許同一會話同時有兩個 prompt）。 */
  private queueTurn(session: AcpSession, text: string): void {
    session.turn = session.turn.then(() => this.runTurn(session, text)).catch((error: unknown) => this.log(`ACP turn failed (${this.info.id})`, error));
  }

  private async runTurn(session: AcpSession, text: string): Promise<void> {
    const turn = { id: `${session.localId}:turn-${++session.turnCounter}`, ended: false };
    session.current = turn;
    session.busy = true;
    session.text = '';
    await this.emitFor(session, 'agent.status', { status: 'coding', turnId: turn.id });
    try {
      const conn = await this.connect();
      const response = await conn.prompt({ sessionId: session.acpSessionId, prompt: [{ type: 'text', text }] });
      if (turn.ended) return;
      if (session.text.trim()) await this.emitFor(session, 'agent.message', { direction: 'from-agent', message: session.text.slice(-16_000), action: `${this.info.name} replied` });
      const usage = (response as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      await this.emitFor(session, 'model.turn.completed', { turnId: turn.id, stopReason: response.stopReason, ...(usage ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } } : {}) });
      if (response.stopReason === 'cancelled' || session.cancelled) {
        await this.finishTurn(session, turn, 'cancelled');
      } else if (response.stopReason === 'refusal') {
        await this.emitFor(session, 'runtime.error', { code: 'ACP_REFUSAL', category: 'runtime', retryable: false, turnId: turn.id, message: `${this.info.name} refused to continue` }, 'error');
        await this.finishTurn(session, turn, 'failed');
      } else {
        if (response.stopReason !== 'end_turn') {
          await this.emitFor(session, 'runtime.warning', { code: `ACP_${response.stopReason.toUpperCase()}`, turnId: turn.id, message: `${this.info.name} 這一輪因為 ${response.stopReason} 提前結束。` }, 'warning');
        }
        await this.finishTurn(session, turn, 'completed');
      }
    } catch (error) {
      if (turn.ended) return;
      if (session.cancelled) {
        await this.finishTurn(session, turn, 'cancelled');
        return;
      }
      await this.emitFor(session, 'runtime.error', { code: 'ACP_PROMPT_FAILED', category: 'runtime', retryable: true, turnId: turn.id, message: (error as Error).message }, 'error');
      await this.finishTurn(session, turn, 'failed');
    } finally {
      session.busy = false;
    }
  }

  /** 這一輪的終態：只發一次。 */
  private async finishTurn(session: AcpSession, turn: { id: string; ended: boolean }, status: 'completed' | 'failed' | 'cancelled'): Promise<void> {
    if (turn.ended) return;
    turn.ended = true;
    const severity: EventSeverity = status === 'completed' ? 'info' : status === 'cancelled' ? 'warning' : 'error';
    await this.emitFor(session, 'agent.status', { status, turnId: turn.id, action: status === 'completed' ? 'Turn completed' : status === 'cancelled' ? 'Cancelled' : 'Turn failed' }, severity);
  }

  private connect(): Promise<acp.ClientSideConnection> {
    if (this.disposed) return Promise.reject(new Error(`${this.info.name} adapter has been shut down`));
    if (this.connection) return Promise.resolve(this.connection);
    this.connecting ??= (async () => {
      const transport = (this.options.transportFactory ?? ((args) => spawnAcpTransport(this.options.command, args, acpRuntimeEnv(this.options.envSource ?? process.env, this.options.env))))(this.launchArgs());
      const conn = new acp.ClientSideConnection(
        () => ({
          requestPermission: (params) => this.onPermission(params),
          sessionUpdate: (params) => this.onUpdate(params),
        }),
        transport.stream,
      );
      transport.onClose((reason) => void this.onTransportClosed(reason));
      const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      this.agentCapabilities = init.agentCapabilities;
      this.authMethods = init.authMethods ?? [];
      this.transport = transport;
      this.connection = conn;
      return conn;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /**
   * agent 程序退出 / 連線斷開：每個會話報告一次“會話已關閉”（可重試，編排器之後用 session/resume 續接）；
   * 進行中的一輪以 failed 結束（終態合約），空閒的會話不多發終態。
   */
  private async onTransportClosed(reason: string): Promise<void> {
    this.connection = undefined;
    this.transport = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.byAcpSession.clear();
    for (const session of sessions) {
      for (const pending of session.permissions.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
      session.permissions.clear();
      if (session.cancelled && !session.current) continue;
      await this.emitFor(session, 'runtime.error', { code: 'ACP_PROCESS_EXITED', category: 'runtime', retryable: true, sessionClosed: true, message: `${this.info.name}: ${reason}` }, 'error');
      const turn = session.current;
      if (turn && !turn.ended) await this.finishTurn(session, turn, session.cancelled ? 'cancelled' : 'failed');
    }
  }

  private async onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const session = this.byAcpSession.get(params.sessionId);
    if (!session || session.cancelled || session.replaying) return { outcome: { outcome: 'cancelled' } };
    const kind = params.toolCall.kind ?? session.tools.get(params.toolCall.toolCallId)?.kind;
    if (session.readOnly && kind && WRITE_KINDS.has(kind)) {
      // 唯讀的一輪（P0-9 權限傳遞契約）：不交給操作員，直接拒絕
      const reject = params.options.find((o) => o.kind === 'reject_once') ?? params.options.find((o) => o.kind === 'reject_always');
      await this.emitFor(session, 'runtime.warning', { code: 'ACP_READ_ONLY_DENIED', providerCallId: params.toolCall.toolCallId, toolKind: kind, message: `這一輪是唯讀的，已拒絕 ${this.info.name} 的「${params.toolCall.title ?? kind}」。` }, 'warning');
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    const approvalId = `acp:${this.info.id}:${params.sessionId}:${params.toolCall.toolCallId}`;
    const decision = new Promise<acp.RequestPermissionResponse>((resolve) => session.permissions.set(approvalId, { resolve, options: params.options }));
    const delivered = await safeEmit(
      session.emit,
      {
        ...session.ids,
        agentId: this.info.id,
        sessionId: session.localId,
        type: 'approval.required',
        severity: 'warning',
        confidence: 'confirmed',
        data: {
          approvalId,
          providerCallId: params.toolCall.toolCallId,
          toolName: kind ?? 'tool',
          toolInput: (params.toolCall.rawInput as Record<string, unknown> | undefined) ?? { title: params.toolCall.title },
          summary: params.toolCall.title ?? `${this.info.name} wants to use a tool`,
          allowSessionScope: params.options.some((o) => o.kind === 'allow_always'),
          action: `Waiting approval: ${params.toolCall.title ?? kind ?? 'tool'}`,
        },
      },
      this.log,
    );
    // 審批請求沒送到編排器：直接拒絕（fail closed）
    if (!delivered && session.permissions.delete(approvalId)) {
      const reject = params.options.find((o) => o.kind === 'reject_once');
      return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    return decision;
  }

  private async onUpdate(params: acp.SessionNotification): Promise<void> {
    const session = this.byAcpSession.get(params.sessionId);
    // 回放期間、已取消的會話：丟棄
    if (!session || session.replaying || session.cancelled) return;
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          session.text += update.content.text;
          await this.emitFor(session, 'agent.message', { ephemeral: true, direction: 'from-agent', delta: update.content.text });
        }
        break;
      case 'tool_call': {
        session.tools.set(update.toolCallId, { kind: update.kind ?? undefined, done: false });
        await this.emitFor(session, 'tool.started', {
          providerCallId: update.toolCallId,
          toolName: update.kind ?? 'tool',
          title: update.title,
          toolInput: (update.rawInput as Record<string, unknown> | undefined) ?? {},
          action: update.title,
        });
        if (update.status === 'completed' || update.status === 'failed') await this.finishTool(session, update.toolCallId, update.status);
        break;
      }
      case 'tool_call_update':
        if (update.status === 'completed' || update.status === 'failed') await this.finishTool(session, update.toolCallId, update.status);
        break;
      default:
        break;
    }
  }

  private async finishTool(session: AcpSession, toolCallId: string, status: 'completed' | 'failed'): Promise<void> {
    const tool = session.tools.get(toolCallId);
    if (tool?.done) return;
    session.tools.set(toolCallId, { kind: tool?.kind, done: true });
    await this.emitFor(session, status === 'completed' ? 'tool.completed' : 'tool.failed', {
      providerCallId: toolCallId,
      toolName: tool?.kind ?? 'tool',
      // 改檔案 / 執行命令的呼叫失敗時也可能已經產生了副作用
      ...(status === 'failed' ? { executed: tool?.kind ? WRITE_KINDS.has(tool.kind) : false } : {}),
    });
  }

  private mustSession(sessionId: string): AcpSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ACP session ${sessionId}`);
    return session;
  }

  private async emitFor(session: AcpSession, type: EventType, data: Record<string, unknown>, severity: EventSeverity = 'info'): Promise<void> {
    await safeEmit(session.emit, { ...session.ids, agentId: this.info.id, sessionId: session.localId, type, severity, confidence: 'confirmed', data }, this.log);
  }
}

function defaultHelpProbe(command: string): string {
  const result =
    process.platform === 'win32'
      ? spawnSync(`${command} --help`, { encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: true })
      : spawnSync(command, ['--help'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

/** 啟動 ACP agent 程序（stdio 上的換行分隔 JSON-RPC）。 */
export function spawnAcpTransport(command: string, args: string[], env: NodeJS.ProcessEnv): AcpTransport {
  // Windows 上 npm 安裝的命令是 .cmd，需要經過 shell；拼成一條命令字串（引數逐個加引號），不把引數陣列交給 shell
  const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  const child =
    process.platform === 'win32'
      ? spawn([command, ...args].map(quote).join(' '), { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true, shell: true })
      : spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
  const listeners: Array<(reason: string) => void> = [];
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-2000)));
  const notify = (reason: string) => {
    for (const l of listeners.splice(0)) l(reason);
  };
  child.on('exit', (code) => notify(`process exited (code ${code ?? 'n/a'})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`));
  child.on('error', (error) => notify(error.message));
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  return {
    stream,
    close: () => {
      try {
        child.kill();
      } catch {
        // 已經退出
      }
    },
    onClose: (listener) => listeners.push(listener),
  };
}

/** 命令是否能找到（ACP agent 的就緒檢查）。 */
export function commandAvailable(command: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return probe.status === 0 && String(probe.stdout).trim().length > 0;
}
