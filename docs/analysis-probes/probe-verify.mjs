import { pathToFileURL } from 'node:url';
const root = 'D:/codes/ai/AgentBox/agent-control-center-claude';
const core = await import(pathToFileURL(root + '/packages/core/src/index.ts').href);
const storage = await import(pathToFileURL(root + '/packages/storage/src/index.ts').href);

class BusyAgent {
  constructor(id, kind, { completeImmediately = false } = {}) { this.info = { id, kind, name: id }; this.cancels = []; this.n = 0; this.completeImmediately = completeImmediately; this.resumes = []; }
  async start(input, emit) {
    const sessionId = `${this.info.id}-s${++this.n}`;
    await emit({ projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId, type: 'agent.started', severity: 'info', confidence: 'confirmed', data: {} });
    await emit({ projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId, type: 'agent.status', severity: 'info', confidence: 'confirmed', data: { status: 'coding' } });
    if (this.completeImmediately) {
      await emit({ projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId, type: 'agent.message', severity: 'info', confidence: 'confirmed', data: { message: 'advice from ' + this.info.id } });
      await emit({ projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: this.info.id, sessionId, type: 'agent.status', severity: 'info', confidence: 'confirmed', data: { status: 'completed' } });
    }
    return { sessionId, providerSessionId: 'p-' + sessionId };
  }
  async send() {}
  async cancel(key) { this.cancels.push(key); }
  async resume(key, input) { this.resumes.push([key, input.reason]); }
}

// 場景 1：askBoth 後 cancel
{
  const store = new storage.InMemoryControlPlaneStore();
  const orch = new core.Orchestrator(store, new core.EventBus());
  const claude = new BusyAgent('claude', 'claude');
  const codex = new BusyAgent('codex', 'codex', { completeImmediately: true });
  orch.registerAdapter(claude); orch.registerAdapter(codex);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true });
  const run = await store.getRun(task.runId);
  console.log('S1 currentAgentId=', run.currentAgentId, 'status=', run.status, 'sessions=', Object.fromEntries(Object.entries(run.agentSessions).map(([k,v])=>[k,v.status])));
  await orch.cancelTask(task.id);
  const after = await store.getRun(task.runId);
  console.log('S1 after cancel status=', after.status, 'claude.cancels=', claude.cancels, 'codex.cancels=', codex.cancels);

  // 場景 2：askBoth 後重啟 recover
  const store2 = new storage.InMemoryControlPlaneStore();
  const orchA = new core.Orchestrator(store2, new core.EventBus());
  const c1 = new BusyAgent('claude', 'claude'); const x1 = new BusyAgent('codex', 'codex', { completeImmediately: true });
  orchA.registerAdapter(c1); orchA.registerAdapter(x1);
  const t2 = await orchA.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true });
  const r2 = await store2.getRun(t2.runId);
  console.log('S2 before restart currentAgentId=', r2.currentAgentId, 'sessions=', Object.fromEntries(Object.entries(r2.agentSessions).map(([k,v])=>[k,v.status])));
  const orchB = new core.Orchestrator(store2, new core.EventBus());
  const c2 = new BusyAgent('claude', 'claude'); const x2 = new BusyAgent('codex', 'codex');
  orchB.registerAdapter(c2); orchB.registerAdapter(x2);
  const report = await orchB.recover();
  const r2b = await store2.getRun(t2.runId);
  const evs = await store2.listEvents(t2.runId);
  console.log('S2 report=', JSON.stringify(report), 'status=', r2b.status, 'claude.resumes=', c2.resumes, 'codex.resumes=', x2.resumes, 'sessions=', Object.fromEntries(Object.entries(r2b.agentSessions).map(([k,v])=>[k,v.status])), 'runtime.error count=', evs.filter(e=>e.type==='runtime.error').length);
}

// 場景 3：對話模式無 askBoth：先給 claude，再給 codex 發訊息，然後 cancel
{
  const store = new storage.InMemoryControlPlaneStore();
  const orch = new core.Orchestrator(store, new core.EventBus());
  const claude = new BusyAgent('claude', 'claude');
  const codex = new BusyAgent('codex', 'codex');
  orch.registerAdapter(claude); orch.registerAdapter(codex);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await orch.sendMessage(task.id, 'codex', 'what do you think?');
  await orch.cancelTask(task.id);
  const after = await store.getRun(task.runId);
  console.log('S3 status=', after.status, 'currentAgentId=', after.currentAgentId, 'claude.cancels=', claude.cancels, 'codex.cancels=', codex.cancels);
}
