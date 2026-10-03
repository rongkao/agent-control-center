import type {
  AgentAdapter,
  AgentInfo,
  AgentResumeInput,
  AgentSessionHandle,
  AgentStartInput,
  EventSink,
} from '@acc/core';

/** 一輪呼叫的結果腳本。 */
export type TurnOutcome =
  | { kind: 'reply'; text?: string }
  | { kind: 'test'; passed: boolean; output?: string }
  | { kind: 'fail'; code: string; retryable: boolean }
  | { kind: 'handoff'; to: string; instruction: string; text?: string }
  | { kind: 'silent' };

interface Session {
  input: Pick<AgentStartInput, 'projectId' | 'taskId' | 'runId'>;
}

/**
 * 工作流測試用假 agent：每次 start/send/resume 視為一輪，按佇列產出結果併發出完成/失敗訊號。
 * 記錄每次呼叫收到的 prompt 與 mode，用於斷言上下文交接內容。
 */
export class WorkflowAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly calls: Array<{ via: 'start' | 'send' | 'resume'; prompt: string; mode?: string; cwd?: string; context?: Record<string, unknown> }> = [];
  cancels = 0;
  private sessions = new Map<string, Session>();
  private counter = 0;

  constructor(
    info: Partial<AgentInfo> & { id: string },
    private readonly outcomes: TurnOutcome[] = [],
    private readonly fallback: TurnOutcome = { kind: 'reply' },
  ) {
    this.info = { name: info.id, kind: 'other', ready: true, capabilities: [], ...info };
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const sessionId = `${this.info.id}-${++this.counter}`;
    this.sessions.set(sessionId, { input });
    this.calls.push({ via: 'start', prompt: input.prompt, mode: input.mode, cwd: input.cwd, context: input.context });
    await emit({ ...this.base(sessionId), type: 'agent.started', data: {} });
    await this.turn(sessionId, emit);
    return { sessionId, providerSessionId: `native-${sessionId}` };
  }

  async send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    this.calls.push({ via: 'send', prompt: message });
    // 與真實 adapter 一致：收到新訊息即進入工作狀態
    await emit({ ...this.base(sessionId), type: 'agent.status', data: { status: 'coding' } });
    await this.turn(sessionId, emit);
  }

  async cancel(sessionId: string, emit: EventSink): Promise<void> {
    this.cancels += 1;
    await emit({ ...this.base(sessionId), type: 'agent.status', severity: 'warning', data: { status: 'cancelled' } });
  }

  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    this.sessions.set(sessionId, { input });
    this.calls.push({ via: 'resume', prompt: input.message ?? input.reason });
    await this.turn(sessionId, emit);
  }

  private async turn(sessionId: string, emit: EventSink): Promise<void> {
    const outcome = this.outcomes.shift() ?? this.fallback;
    const base = this.base(sessionId);
    switch (outcome.kind) {
      case 'reply':
        await emit({ ...base, type: 'agent.message', data: { message: outcome.text ?? `${this.info.id} done` } });
        await emit({ ...base, type: 'agent.status', data: { status: 'completed' } });
        return;
      case 'test':
        await emit({ ...base, type: 'tool.completed', data: { toolCallId: `${sessionId}-${this.calls.length}`, toolName: 'test' } });
        await emit({
          ...base,
          type: 'agent.status',
          data: { status: 'completed', testPassed: outcome.passed, exitCode: outcome.passed ? 0 : 1, outputTail: outcome.output ?? (outcome.passed ? 'ok' : 'FAIL: expected 2 got 3') },
        });
        return;
      case 'fail':
        await emit({ ...base, type: 'runtime.error', severity: 'error', data: { code: outcome.code, category: 'runtime', retryable: outcome.retryable } });
        await emit({ ...base, type: 'agent.status', severity: 'error', data: { status: 'failed' } });
        return;
      case 'handoff':
        await emit({ ...base, type: 'agent.message', data: { message: outcome.text ?? 'I need help' } });
        await emit({ ...base, type: 'handoff.requested', data: { origin: 'agent', via: 'tool', toAgentId: outcome.to, instruction: outcome.instruction, content: outcome.text ?? 'I need help' } });
        await emit({ ...base, type: 'agent.status', data: { status: 'completed' } });
        return;
      case 'silent':
        return;
    }
  }

  private base(sessionId: string) {
    const session = this.sessions.get(sessionId)!;
    return {
      projectId: session.input.projectId,
      taskId: session.input.taskId,
      runId: session.input.runId,
      agentId: this.info.id,
      sessionId,
      severity: 'info' as const,
      confidence: 'confirmed' as const,
    };
  }
}
