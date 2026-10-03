import type {
  AgentAdapter,
  AgentInfo,
  AgentResumeInput,
  AgentSendOptions,
  AgentSessionHandle,
  AgentStartInput,
  ApprovalDecision,
  EventSeverity,
  EventSink,
  EventType,
} from '@acc/core';

/** 一次派發（start / send / resume）的記錄。 */
export interface ControlledCall {
  via: 'start' | 'send' | 'resume';
  sessionId: string;
  prompt: string;
  mode?: string;
  reason?: AgentResumeInput['reason'];
}

interface ControlledSession {
  ids: Pick<AgentStartInput, 'projectId' | 'taskId' | 'runId'>;
  emit: EventSink;
}

/**
 * 由測試顯式驅動的假 agent（P0-6）：start / send / resume 只發出 started / coding，不會自己結束這一輪——
 * 什麼時候完成、失敗、報錯或請求審批全部由測試呼叫 complete() / fail() / emit() 決定。
 * 用來複現“agent 一直沒有動靜”（看門狗）和“只報錯不給終態”的執行時。
 */
export class ControlledAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly calls: ControlledCall[] = [];
  readonly cancelled: string[] = [];
  readonly approvals: ApprovalDecision[] = [];
  private readonly sessions = new Map<string, ControlledSession>();
  private counter = 0;
  private lastSessionId?: string;

  constructor(info: Partial<AgentInfo> & { id: string }, options: { resumable?: boolean } = {}) {
    this.info = { name: info.id, kind: 'other', ready: true, capabilities: ['implement', 'analysis', 'review'], ...info };
    if (options.resumable === false) (this as { resume?: unknown }).resume = undefined;
  }

  /** 最近一次派發用的會話。 */
  get sessionId(): string {
    if (!this.lastSessionId) throw new Error(`${this.info.id} has no session yet`);
    return this.lastSessionId;
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const sessionId = `${this.info.id}-ctl-${++this.counter}`;
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, emit });
    this.lastSessionId = sessionId;
    this.calls.push({ via: 'start', sessionId, prompt: input.prompt, mode: input.mode });
    await this.emit('agent.started', { adapterType: this.info.kind }, sessionId);
    await this.emit('agent.status', { status: 'coding' }, sessionId);
    return { sessionId, providerSessionId: `native-${sessionId}` };
  }

  async send(sessionId: string, message: string, _emit: EventSink, options: AgentSendOptions = {}): Promise<void> {
    this.must(sessionId);
    this.lastSessionId = sessionId;
    this.calls.push({ via: 'send', sessionId, prompt: message, mode: options.mode });
    await this.emit('agent.status', { status: 'coding' }, sessionId);
  }

  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, emit });
    this.lastSessionId = sessionId;
    const mode = typeof input.metadata?.mode === 'string' ? input.metadata.mode : undefined;
    this.calls.push({ via: 'resume', sessionId, prompt: input.message ?? input.reason, mode, reason: input.reason });
    await this.emit('agent.started', { adapterType: this.info.kind, resumed: true }, sessionId);
    await this.emit('agent.status', { status: 'coding' }, sessionId);
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
    await this.emit('agent.status', { status: 'cancelled' }, sessionId, 'warning');
  }

  async approve(_sessionId: string, decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
  }

  /** 以該會話的身份發出一個事件（預設最近一次派發的會話）。 */
  async emit(type: EventType, data: Record<string, unknown>, sessionId = this.sessionId, severity: EventSeverity = 'info'): Promise<void> {
    const session = this.must(sessionId);
    await session.emit({ ...session.ids, agentId: this.info.id, sessionId, type, severity, confidence: 'confirmed', data });
  }

  /**
   * 原樣經該會話的 sink 發出一個事件（P0-9 / L-1 測試用）：可以偽造身份欄位、事件型別、sequence / id，
   * 用來確認事件入口會固定身份、剝離序號並拒絕編排器專屬的事件。
   */
  async raw(event: Parameters<EventSink>[0], sessionId = this.sessionId): Promise<void> {
    await this.must(sessionId).emit(event);
  }

  /** 這一輪完成（可帶回覆文字）。 */
  async complete(text?: string, sessionId = this.sessionId): Promise<void> {
    if (text) await this.emit('agent.message', { direction: 'from-agent', message: text }, sessionId);
    await this.emit('agent.status', { status: 'completed' }, sessionId);
  }

  private must(sessionId: string): ControlledSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown controlled session ${sessionId}`);
    return session;
  }
}
