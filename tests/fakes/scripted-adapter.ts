import type {
  AgentAdapter,
  AgentInfo,
  AgentResumeInput,
  AgentSessionHandle,
  AgentStartInput,
  ApprovalDecision,
  EventSink,
} from '@acc/core';

/**
 * 模擬外部世界（檔案系統/命令執行等）的副作用記錄。
 * 跨“程序重啟”共享，用來斷言已完成的副作用沒有被重放。
 */
export class FakeWorld {
  executions: string[] = [];
}

export type ScriptStep =
  | { kind: 'tool'; id: string; name?: string }
  | { kind: 'approval'; id: string; providerCallId: string; summary?: string }
  | { kind: 'turn'; progress?: boolean; usage?: Record<string, unknown> }
  | { kind: 'complete' };

interface SessionState {
  input: Pick<AgentStartInput, 'projectId' | 'taskId' | 'runId'>;
  cursor: number;
  waitingApprovalId?: string;
  cancelled: boolean;
}

/**
 * 按腳本執行的假執行時：用於 adapter 合約測試和恢復測試。
 * 會話狀態只存在於實例記憶體中——新建實例即模擬程序重啟。
 */
export class ScriptedAdapter implements AgentAdapter {
  readonly info: AgentInfo;
  readonly calls = { start: 0, send: 0, cancel: 0, approve: 0, resume: 0 };
  readonly resumeInputs: AgentResumeInput[] = [];
  private sessions = new Map<string, SessionState>();
  private counter = 0;

  constructor(
    private readonly world: FakeWorld,
    private readonly script: ScriptStep[],
    info: Partial<AgentInfo> = {},
    private readonly options: {
      resumable?: boolean;
      /**
       * 可選：每執行完一個腳本步驟後等待它（預設不等待，整段腳本一口氣跑完）。
       * 編排反應是非同步排隊執行的；真實 agent 的兩輪之間有時間間隔，編排器（例如預算檢查）會在其間作出反應。
       * 需要模擬這一點的測試傳入 `() => orchestrator.idle()`（只能用於不會在編排反應裡被呼叫的 adapter）。
       */
      pace?: () => Promise<void>;
    } = { resumable: true },
  ) {
    this.info = { id: 'claude', name: 'Scripted', kind: 'claude', ready: true, capabilities: ['implement'], ...info };
    if (options.resumable === false) {
      // 不支援續跑的執行時：去掉可選方法
      (this as { resume?: unknown }).resume = undefined;
    }
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    this.calls.start += 1;
    const sessionId = `${this.info.id}-session-${++this.counter}`;
    const state: SessionState = { input, cursor: 0, cancelled: false };
    this.sessions.set(sessionId, state);
    await emit({ ...this.base(state, sessionId), type: 'agent.started', data: { action: 'Starting runtime' } });
    await this.runFrom(sessionId, state, emit, new Set());
    return { sessionId, providerSessionId: `native-${sessionId}` };
  }

  async send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    this.calls.send += 1;
    const state = this.must(sessionId);
    await emit({ ...this.base(state, sessionId), type: 'agent.message', data: { message } });
  }

  async cancel(sessionId: string, emit: EventSink): Promise<void> {
    this.calls.cancel += 1;
    const state = this.must(sessionId);
    state.cancelled = true;
    await emit({ ...this.base(state, sessionId), type: 'agent.status', severity: 'warning', data: { status: 'cancelled' } });
  }

  async approve(sessionId: string, decision: ApprovalDecision, emit: EventSink): Promise<void> {
    this.calls.approve += 1;
    const state = this.must(sessionId);
    if (state.waitingApprovalId !== decision.approvalId) throw new Error(`Unexpected approval ${decision.approvalId}`);
    state.waitingApprovalId = undefined;
    if (decision.decision !== 'approve') return;
    state.cursor += 1;
    await this.runFrom(sessionId, state, emit, new Set());
  }

  /** 重啟後續跑：從腳本開頭重放“決策”，但跳過 completedSideEffectIds 中已完成的工具呼叫。 */
  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    this.calls.resume += 1;
    this.resumeInputs.push(structuredClone(input));
    const state: SessionState = {
      input: { projectId: input.projectId, taskId: input.taskId, runId: input.runId },
      cursor: 0,
      cancelled: false,
    };
    this.sessions.set(sessionId, state);
    const approved = new Set<string>();
    if (input.approval?.decision === 'approve') approved.add(input.approval.approvalId);
    await this.runFrom(sessionId, state, emit, new Set(input.completedSideEffectIds), approved);
  }

  private async runFrom(
    sessionId: string,
    state: SessionState,
    emit: EventSink,
    completed: Set<string>,
    approved: Set<string> = new Set(),
  ): Promise<void> {
    while (state.cursor < this.script.length && !state.cancelled) {
      const step = this.script[state.cursor]!;
      const base = this.base(state, sessionId);
      switch (step.kind) {
        case 'tool':
          if (!completed.has(step.id)) {
            await emit({ ...base, type: 'tool.started', data: { toolCallId: step.id, toolName: step.name ?? step.id } });
            this.world.executions.push(step.id);
            await emit({ ...base, type: 'tool.completed', data: { toolCallId: step.id, toolName: step.name ?? step.id } });
          }
          break;
        case 'approval':
          if (!approved.has(step.id)) {
            state.waitingApprovalId = step.id;
            await emit({
              ...base,
              type: 'approval.required',
              severity: 'warning',
              data: { approvalId: step.id, providerCallId: step.providerCallId, summary: step.summary ?? `Approve ${step.id}` },
            });
            return;
          }
          break;
        case 'turn':
          await emit({ ...base, type: 'model.turn.completed', data: { progress: step.progress === true, usage: step.usage } });
          break;
        case 'complete':
          // P0-9 / L-1：adapter 不能自己發 run.completed（編排器專屬，會被 sink 拒絕）；這一輪以終態結束，由編排器決定任務是否完成
          await emit({ ...base, type: 'agent.status', data: { status: 'completed', action: 'Completed' } });
          break;
      }
      state.cursor += 1;
      if (this.options.pace && state.cursor < this.script.length) await this.options.pace();
    }
  }

  private base(state: SessionState, sessionId: string) {
    return {
      projectId: state.input.projectId,
      taskId: state.input.taskId,
      runId: state.input.runId,
      agentId: this.info.id,
      sessionId,
      severity: 'info' as const,
      confidence: 'confirmed' as const,
    };
  }

  private must(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown scripted session ${sessionId}`);
    return state;
  }
}
