import type { AgentAdapter, AgentInfo, AgentSessionHandle, AgentStartInput, ApprovalDecision, EventSink } from '@acc/core';
import { deferred, type Deferred } from './deferred.js';

/**
 * 啟動可由測試“卡住”的假 agent（延遲投遞替身的最小實現）。
 *
 * - startGate 設定後，start() 在發出 agent.started 之前等待測試放行，用來模擬啟動很慢的執行時（例如 Codex 冷啟動）；
 * - start/send 只記錄呼叫併發出 started/coding，不會自己跑完一輪——結果由測試顯式驅動。
 */
export class GatedAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly starts: AgentStartInput[] = [];
  readonly sends: Array<{ sessionId: string; message: string }> = [];
  readonly approvals: ApprovalDecision[] = [];
  cancels = 0;
  /** 第一次 start() 被呼叫時 resolve。 */
  readonly startCalled = deferred<AgentStartInput>();
  /** 設定後 start() 等待它 resolve 才繼續。 */
  startGate?: Deferred<void>;
  private sessions = new Map<string, Pick<AgentStartInput, 'projectId' | 'taskId' | 'runId'>>();
  private counter = 0;

  constructor(info: Partial<AgentInfo> & { id: string }) {
    this.info = { name: info.id, kind: 'other', ready: true, capabilities: [], ...info };
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    this.starts.push(input);
    if (!this.startCalled.settled) this.startCalled.resolve(input);
    if (this.startGate) await this.startGate.promise;
    const sessionId = `${this.info.id}-gated-${++this.counter}`;
    this.sessions.set(sessionId, { projectId: input.projectId, taskId: input.taskId, runId: input.runId });
    await emit({ ...this.base(sessionId), type: 'agent.started', data: { adapterType: this.info.kind } });
    await emit({ ...this.base(sessionId), type: 'agent.status', data: { status: 'coding' } });
    return { sessionId, providerSessionId: `native-${sessionId}` };
  }

  async send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    this.sends.push({ sessionId, message });
    await emit({ ...this.base(sessionId), type: 'agent.status', data: { status: 'coding' } });
  }

  async cancel(sessionId: string, emit: EventSink): Promise<void> {
    this.cancels += 1;
    await emit({ ...this.base(sessionId), type: 'agent.status', severity: 'warning', data: { status: 'cancelled' } });
  }

  async approve(_sessionId: string, decision: ApprovalDecision): Promise<void> {
    this.approvals.push(decision);
  }

  private base(sessionId: string) {
    const ids = this.sessions.get(sessionId);
    if (!ids) throw new Error(`Unknown gated session ${sessionId}`);
    return { ...ids, agentId: this.info.id, sessionId, severity: 'info' as const, confidence: 'confirmed' as const };
  }
}
