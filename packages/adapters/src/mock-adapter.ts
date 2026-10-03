import { randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentInfo, AgentResumeInput, AgentStartInput, ApprovalDecision, EventSink } from '@acc/core';
import { defaultAdapterLog, safeEmit, type AdapterLog } from './shared.js';

/** mock 會話：發事件用的身份與這一會話已經開始過的回合數。 */
interface MockSession {
  ids: Pick<AgentStartInput, 'projectId' | 'taskId' | 'runId'>;
  turns: number;
}

/**
 * 演示用的假執行時（ACC_RUNTIME_MODE=mock）：用定時器模擬一輪的進展和結果。
 * 同樣遵守 AgentAdapter 的回合終態合約（P0-6）：每一輪以且只以一個終態結束（帶 turnId）；
 * 取消會清掉這個會話還沒觸發的定時事件，取消之後不會再冒出 completed。
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly info: AgentInfo;
  private sessions = new Map<string, MockSession>();
  private readonly log: AdapterLog;
  /** 每個會話還沒觸發的模擬事件定時器：取消或 dispose 時清掉。 */
  private timers = new Map<string, Set<NodeJS.Timeout>>();
  private disposed = false;

  constructor(info: AgentInfo, options: { log?: AdapterLog } = {}) {
    this.info = info;
    this.log = options.log ?? defaultAdapterLog;
  }

  /** 定時模擬事件（dispose 之後不再安排）。 */
  private later(sessionId: string, ms: number, fn: () => void): void {
    if (this.disposed) return;
    let set = this.timers.get(sessionId);
    if (!set) {
      set = new Set();
      this.timers.set(sessionId, set);
    }
    const owner = set;
    const timer = setTimeout(() => {
      owner.delete(timer);
      fn();
    }, ms);
    owner.add(timer);
  }

  /** 清掉一個會話還沒觸發的定時事件。 */
  private clearTimers(sessionId: string): void {
    for (const timer of this.timers.get(sessionId) ?? []) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  /** 釋放一個會話（P1-5）：清掉它還沒觸發的定時事件並忘掉它，不發事件。 */
  release(sessionId: string): void {
    this.clearTimers(sessionId);
    this.sessions.delete(sessionId);
  }

  /** 停止全部模擬會話（服務關閉時呼叫）：清掉還沒觸發的定時事件，不發任何事件。 */
  dispose(): void {
    this.disposed = true;
    for (const sessionId of [...this.timers.keys()]) this.clearTimers(sessionId);
  }

  async start(input: AgentStartInput, emit: EventSink) {
    if (this.disposed) throw new Error(`Mock ${this.info.id} has been shut down`);
    const sessionId = `${this.info.id}-${randomUUID()}`;
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, turns: 0 });

    await emit({ ...this.base(sessionId), type: 'agent.started', severity: 'info', confidence: 'confirmed', data: { mode: input.mode, action: 'Starting runtime' } });
    await this.scheduleTurn(sessionId, emit, input.prompt, { status: 250, message: 650, done: 1100 });
    return { sessionId, providerSessionId: sessionId };
  }

  async send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    this.mustSession(sessionId);
    await this.scheduleTurn(sessionId, emit, message, { message: 0, done: 300 });
  }

  /** 續接（重啟之後、失敗之後）：會話重新登記，按續接提示再跑一輪。 */
  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    if (this.disposed) throw new Error(`Mock ${this.info.id} has been shut down`);
    const existing = this.sessions.get(sessionId);
    this.clearTimers(sessionId);
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, turns: existing?.turns ?? 0 });
    await emit({ ...this.base(sessionId), type: 'agent.started', severity: 'info', confidence: 'confirmed', data: { resumed: true, action: 'Resumed runtime' } });
    await this.scheduleTurn(sessionId, emit, input.message ?? `resume (${input.reason})`, { status: 0, message: 300, done: 600 });
  }

  /**
   * 安排一輪的模擬事件：工作狀態、回覆、終態（completed，帶 turnId）。
   * message 為 0 時回覆立即發出（send：與以前一樣在返回之前落盤），其餘由定時器發出。
   */
  private async scheduleTurn(sessionId: string, emit: EventSink, prompt: string, at: { status?: number; message: number; done: number }): Promise<void> {
    const session = this.mustSession(sessionId);
    session.turns += 1;
    const turnId = `${sessionId}#${session.turns}`;
    // 身份在安排時就確定：定時器觸發時會話可能已經被取消（定時器也會被一併清掉）
    const base = this.base(sessionId);
    const event = (type: 'agent.status' | 'agent.message', data: Record<string, unknown>) => ({ ...base, type, severity: 'info' as const, confidence: 'confirmed' as const, data });
    if (at.status !== undefined) {
      const status = this.info.kind === 'codex' ? 'reviewing' : this.info.kind === 'test' ? 'testing' : 'coding';
      this.later(sessionId, at.status, () => void this.emitLater(emit, event('agent.status', { status, action: 'Working on task' })));
    }
    const reply = { direction: 'from-agent', message: this.reply(prompt), action: 'Produced progress update' };
    if (at.message === 0) await emit(event('agent.message', { direction: 'from-agent', message: this.reply(prompt) }));
    else this.later(sessionId, at.message, () => void this.emitLater(emit, event('agent.message', reply)));
    this.later(sessionId, at.done, () => void this.emitLater(emit, event('agent.status', { ...this.completion(), turnId })));
  }

  /** mock 回覆：評審類 agent 附帶確定的結論行，便於演示完整工作流。 */
  private reply(prompt: string): string {
    const head = `[mock:${this.info.id}] ${prompt.slice(0, 160)}`;
    return this.info.kind === 'codex' ? `${head}\nVERDICT: ACCEPT` : head;
  }

  private completion(): Record<string, unknown> {
    return this.info.kind === 'test'
      ? { status: 'completed', testPassed: true, exitCode: 0, outputTail: 'mock: all tests passed', action: 'Tests passed (mock)' }
      : { status: 'completed', action: 'Waiting for orchestrator' };
  }

  async cancel(sessionId: string, emit: EventSink): Promise<void> {
    // 冪等（P0 第二批審查）：已經取消過（會話已移除）時什麼都不做，終態只報告一次
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // 取消是這一輪的終態：還沒觸發的模擬事件（包括 completed）全部作廢
    this.clearTimers(sessionId);
    await emit({
      ...this.base(sessionId),
      type: 'agent.status',
      severity: 'warning',
      confidence: 'confirmed',
      data: { status: 'cancelled', turnId: `${sessionId}#${session.turns}`, action: 'Cancelled' },
    });
    this.sessions.delete(sessionId);
  }

  /** 定時器裡發出的事件沒有呼叫方可以接住異常：走 safeEmit，失敗只記錄，不產生未處理的 Promise 拒絕。 */
  private emitLater(emit: EventSink, event: Parameters<EventSink>[0]): Promise<boolean> {
    return safeEmit(emit, event, this.log);
  }

  async approve(_sessionId: string, _decision: ApprovalDecision, _emit: EventSink): Promise<void> {
    // Mock hook; real adapters must map stable approval identity to provider identity.
  }

  private base(sessionId: string) {
    const session = this.mustSession(sessionId);
    return { ...session.ids, agentId: this.info.id, sessionId };
  }

  private mustSession(sessionId: string): MockSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown mock session ${sessionId}`);
    return session;
  }
}

export function createMockAdapters(options: { log?: AdapterLog } = {}): AgentAdapter[] {
  return [
    new MockAgentAdapter({ id: 'claude', name: 'Claude', kind: 'claude', ready: true, capabilities: ['implement', 'analysis'] }, options),
    new MockAgentAdapter({ id: 'codex', name: 'Codex', kind: 'codex', ready: true, capabilities: ['review', 'rescue', 'analysis'] }, options),
    new MockAgentAdapter({ id: 'test', name: 'Test Agent', kind: 'test', ready: true, capabilities: ['test', 'build', 'lint'] }, options),
  ];
}
