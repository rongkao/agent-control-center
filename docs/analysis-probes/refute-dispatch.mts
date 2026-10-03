// 独立复现：启动期间取消 / 取消后批准旧审批
const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class GatedAgent {
  info: any;
  log: any[] = [];
  gate?: () => void;
  sessions = new Map<string, any>();
  n = 0;
  constructor(id: string, public emitStartedBeforeGate = false) {
    this.info = { id, name: id, kind: id, ready: true, capabilities: ['implement'] };
  }
  async start(input: any, emit: any) {
    this.log.push('start');
    const sid = `${this.info.id}-s${++this.n}`;
    const base = { projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId: sid, severity: 'info', confidence: 'confirmed' };
    this.sessions.set(sid, { base, cancelled: false });
    if (this.emitStartedBeforeGate) await emit({ ...base, type: 'agent.started', data: {} });
    // 模拟 Claude 等待 init / Codex 等待 thread/start
    await new Promise<void>((r) => (this.gate = r));
    if (!this.emitStartedBeforeGate) await emit({ ...base, type: 'agent.started', data: {} });
    this.log.push('working');
    return { sessionId: sid, providerSessionId: `native-${sid}` };
  }
  async send(sid: string) { this.log.push(['send', sid]); }
  async cancel(sid: string) { this.log.push(['cancel', sid]); const s = this.sessions.get(sid); if (s) s.cancelled = true; }
  async approve(sid: string, d: any) { this.log.push(['approve', sid, d.decision]); }
  async resume(sid: string, input: any) { this.log.push(['resume', sid, input.reason]); }
}

// 场景 A：start 期间（agent.started 之前）取消
{
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store, new EventBus(), { workspacePolicy: 'shared' });
  const claude = new GatedAgent('claude');
  orch.registerAdapter(claude);
  const p = orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await sleep(50);
  const task = (await store.listTasks())[0];
  const before = (await store.getRun(task.runId)).status;
  await orch.cancelTask(task.id);
  const mid = (await store.getRun(task.runId)).status;
  claude.gate!();
  await p;
  const run = await store.getRun(task.runId);
  console.log('A', JSON.stringify({ before, mid, after: run.status, log: claude.log, session: run.agentSessions.claude?.status, live: (orch as any).liveSessions.size }));
}

// 场景 B：WAITING_APPROVAL 时取消，然后批准旧审批
{
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
  const claude = new GatedAgent('claude');
  orch.registerAdapter(claude);
  const p = orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await sleep(20);
  claude.gate!();
  const task = await p;
  const run0 = await store.getRun(task.runId);
  const sid = run0.agentSessions.claude.metadata.adapterSessionId;
  await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId: sid, type: 'approval.required', severity: 'warning', confidence: 'confirmed', data: { approvalId: 'ap1', summary: 'Write file', toolName: 'Write' } });
  const s1 = (await store.getRun(task.runId)).status;
  await orch.cancelTask(task.id);
  const s2 = await store.getRun(task.runId);
  let err: string | undefined;
  try { await orch.resolveApproval(task.id, 'ap1', 'approve'); } catch (e) { err = (e as Error).message; }
  const s3 = await store.getRun(task.runId);
  console.log('B', JSON.stringify({ s1, afterCancel: s2.status, pendingAfterCancel: s2.pendingApprovals.map((x: any) => x.status), err, final: s3.status, log: claude.log }));
}

// 场景 C：BLOCKED 状态下给已有会话发消息
{
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
  const claude = new GatedAgent('claude');
  orch.registerAdapter(claude);
  const p = orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await sleep(20);
  claude.gate!();
  const task = await p;
  await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', type: 'budget.exceeded', severity: 'error', confidence: 'confirmed', data: { limit: 'maxTurns', step: 'budget:maxTurns' } });
  const s1 = (await store.getRun(task.runId)).status;
  let err: string | undefined;
  try { await orch.sendMessage(task.id, 'claude', 'keep going'); } catch (e) { err = (e as Error).message; }
  const s2 = await store.getRun(task.runId);
  console.log('C', JSON.stringify({ s1, err, after: s2.status, log: claude.log }));
}
