import type { AgentAdapter, AgentInfo, AgentResumeInput, AgentSessionHandle, AgentStartInput, EventSink } from '@acc/core';

/** 一輪裡對工作目錄做的改動（例如改 package.json 的 test 腳本）。 */
export type Edit = (cwd: string) => void;

interface Session {
  ids: { projectId: string; taskId: string; runId: string };
  cwd: string;
}

/**
 * 會改檔案的假實現者（P0-8 / H-15）：每次 start / send / resume 算一輪，按佇列在工作目錄裡做一次改動，
 * 然後像真實 agent 一樣回覆並以 completed 結束這一輪。用來模擬“agent 在實現步驟裡改了測試配置”。
 */
export class EditingAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly prompts: string[] = [];
  private sessions = new Map<string, Session>();
  private counter = 0;

  constructor(
    private readonly edits: Edit[] = [],
    info: Partial<AgentInfo> = {},
  ) {
    this.info = { id: 'claude', name: 'Editor', kind: 'claude', ready: true, capabilities: ['implement', 'analysis'], ...info };
  }

  async start(input: AgentStartInput, emit: EventSink): Promise<AgentSessionHandle> {
    const sessionId = `editor-${++this.counter}`;
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, cwd: input.cwd ?? '.' });
    await emit({ ...this.base(sessionId), type: 'agent.started', data: {} });
    await this.turn(sessionId, input.prompt, emit);
    return { sessionId, providerSessionId: `native-${sessionId}` };
  }

  async send(sessionId: string, message: string, emit: EventSink): Promise<void> {
    await emit({ ...this.base(sessionId), type: 'agent.status', data: { status: 'coding' } });
    await this.turn(sessionId, message, emit);
  }

  async cancel(sessionId: string, emit: EventSink): Promise<void> {
    await emit({ ...this.base(sessionId), type: 'agent.status', severity: 'warning', data: { status: 'cancelled' } });
  }

  async resume(sessionId: string, input: AgentResumeInput, emit: EventSink): Promise<void> {
    const cwd = typeof input.metadata?.cwd === 'string' ? input.metadata.cwd : '.';
    this.sessions.set(sessionId, { ids: { projectId: input.projectId, taskId: input.taskId, runId: input.runId }, cwd });
    await this.turn(sessionId, input.message ?? input.reason, emit);
  }

  private async turn(sessionId: string, prompt: string, emit: EventSink): Promise<void> {
    this.prompts.push(prompt);
    const session = this.sessions.get(sessionId)!;
    this.edits.shift()?.(session.cwd);
    await emit({ ...this.base(sessionId), type: 'agent.message', data: { message: 'done editing' } });
    await emit({ ...this.base(sessionId), type: 'agent.status', data: { status: 'completed' } });
  }

  private base(sessionId: string) {
    return { ...this.sessions.get(sessionId)!.ids, agentId: this.info.id, sessionId, severity: 'info' as const, confidence: 'confirmed' as const };
  }
}
