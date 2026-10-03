const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class AsyncAgent {
  constructor(id, kind, opts = {}) {
    this.info = { id, name: id, kind, ready: true, capabilities: [] };
    this.opts = opts;
    this.sessions = new Map();
    this.n = 0;
    this.log = [];
    this.outcomes = opts.outcomes ?? [];
  }
  base(sid) {
    const s = this.sessions.get(sid);
    return { projectId: s.input.projectId, taskId: s.input.taskId, runId: s.input.runId, agentId: this.info.id, sessionId: sid, severity: 'info', confidence: 'confirmed' };
  }
  async start(input, emit) {
    const sid = `${this.info.id}-${++this.n}`;
    this.sessions.set(sid, { input, closed: false, emit, mode: input.mode });
    this.log.push(['start', input.mode]);
    if (this.opts.startDelay) await sleep(this.opts.startDelay);
    await emit({ ...this.base(sid), type: 'agent.started', data: {} });
    this.turn(sid, emit, input.prompt);
    if (this.opts.syncTurn) await this.pending;
    return { sessionId: sid, providerSessionId: `native-${sid}` };
  }
  async send(sid, message, emit) {
    const s = this.sessions.get(sid);
    if (s.closed) throw new Error(`session ${sid} is closed`);
    this.log.push(['send', message.slice(0, 40)]);
    await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'coding' } });
    this.turn(sid, emit, message);
    if (this.opts.syncTurn) await this.pending;
  }
  async resume(sid, input, emit) {
    this.sessions.set(sid, { input, closed: false, emit });
    this.log.push(['resume', input.reason]);
    this.turn(sid, emit, input.message ?? '');
    if (this.opts.syncTurn) await this.pending;
  }
  async cancel(sid, emit) {
    const s = this.sessions.get(sid);
    s.closed = true;
    this.log.push(['cancel']);
    await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'cancelled' } });
  }
  turn(sid, emit, prompt) {
    const outcome = this.outcomes.shift() ?? this.opts.fallback ?? { kind: 'reply' };
    this.pending = (async () => {
      await sleep(this.opts.turnDelay ?? 0);
      const s = this.sessions.get(sid);
      if (s.closed) return;
      const b = this.base(sid);
      if (outcome.kind === 'reply') {
        await emit({ ...b, type: 'agent.message', data: { message: outcome.text ?? `${this.info.id} reply` } });
        await emit({ ...b, type: 'model.turn.completed', data: {} });
        await emit({ ...b, type: 'agent.status', data: { status: 'completed' } });
      } else if (outcome.kind === 'test') {
        await emit({ ...b, type: 'tool.completed', data: { toolCallId: `${sid}-${Math.random()}`, toolName: 'test' } });
        await emit({ ...b, type: 'agent.status', data: { status: 'completed', testPassed: outcome.passed, exitCode: outcome.passed ? 0 : 1, outputTail: 'x' } });
      } else if (outcome.kind === 'handoff') {
        await emit({ ...b, type: 'agent.message', data: { message: 'need help' } });
        await emit({ ...b, type: 'handoff.requested', data: { origin: 'agent', via: 'tool', toAgentId: outcome.to, instruction: 'please review', content: 'c' } });
        await emit({ ...b, type: 'agent.status', data: { status: 'completed' } });
      } else if (outcome.kind === 'transient-close') {
        // 模擬真實 adapter：執行時斷開 -> 可重試錯誤 + failed，且會話已關閉
        s.closed = true;
        await emit({ ...b, type: 'runtime.error', data: { code: 'CODEX_TRANSPORT_CLOSED', category: 'runtime', retryable: true } });
        await emit({ ...b, type: 'agent.status', data: { status: 'failed' } });
      } else if (outcome.kind === 'silent') {
        // 一直在工作
      }
    })();
  }
}
