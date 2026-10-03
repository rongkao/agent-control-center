import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';

// 一个会“挂住”的假 agent：start 后保持工作中（coding），不完成
class HangAgent {
  info: any; cancels = 0; calls: any[] = []; n = 0; sess = new Map<string, any>();
  constructor(id: string, public resumeOk = true) { this.info = { id, name: id, kind: id, ready: true, capabilities: [] }; }
  base(sid: string) { const s = this.sess.get(sid); return { projectId: s.projectId, taskId: s.taskId, runId: s.runId, agentId: this.info.id, sessionId: sid, severity: 'info', confidence: 'confirmed' }; }
  async start(input: any, emit: any) { const sid = `${this.info.id}-${++this.n}`; this.sess.set(sid, input); this.calls.push(['start', input.mode]);
    await emit({ ...this.base(sid), type: 'agent.started', data: {} });
    await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'coding' } });
    return { sessionId: sid, providerSessionId: `native-${sid}` }; }
  async send(sid: string, m: string, emit: any) { this.calls.push(['send']); await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'coding' } }); }
  async cancel(sid: string, emit: any) { this.cancels++; await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'cancelled' } }); }
  async resume(sid: string, input: any, emit: any) { this.calls.push(['resume', input.reason]); }
}
// codex 顾问：start 后立即完成
class QuickAgent extends HangAgent {
  async start(input: any, emit: any) { const h = await super.start(input, emit); await emit({ ...this.base(h.sessionId), type: 'agent.message', data: { message: 'advice' } }); await emit({ ...this.base(h.sessionId), type: 'agent.status', data: { status: 'completed' } }); return h; }
}

async function scenarioCancel() {
  const store = new InMemoryControlPlaneStore();
  const o = new Orchestrator(store as any, new EventBus());
  const claude = new HangAgent('claude'); const codex = new HangAgent('codex');
  o.registerAdapter(claude as any); o.registerAdapter(codex as any);
  const task = await o.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true } as any);
  const run = await store.getRun(task.runId);
  console.log('[cancel] currentAgentId=', run!.currentAgentId, 'sessions=', Object.fromEntries(Object.entries(run!.agentSessions).map(([k, v]: any) => [k, v.status])));
  await o.cancelTask(task.id);
  const r2 = await store.getRun(task.runId);
  console.log('[cancel] status=', r2!.status, 'claude.cancels=', claude.cancels, 'codex.cancels=', codex.cancels, 'sessions=', Object.fromEntries(Object.entries(r2!.agentSessions).map(([k, v]: any) => [k, v.status])));
  // reassign fromAgent 推导
  const store2 = new InMemoryControlPlaneStore();
  const o2 = new Orchestrator(store2 as any, new EventBus());
  const c2 = new HangAgent('claude'); const x2 = new QuickAgent('codex');
  o2.registerAdapter(c2 as any); o2.registerAdapter(x2 as any);
  const t2 = await o2.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true } as any);
  const rr = await store2.getRun(t2.runId);
  console.log('[reassign] currentAgentId=', rr!.currentAgentId);
  try { await o2.reassign(t2.id, 'codex'); console.log('[reassign] ok'); } catch (e: any) { console.log('[reassign] error:', e.message); }
  try { await o2.reassign(t2.id, 'claude'); console.log('[reassign->claude] ok; codex.cancels=', x2.cancels, 'claude.cancels=', c2.cancels); } catch (e: any) { console.log('[reassign->claude] error:', e.message); }
  const ev = await store2.listEvents(t2.runId);
  const h = ev.filter((e: any) => e.type === 'handoff.requested').map((e: any) => e.data);
  console.log('[reassign->claude] handoff:', JSON.stringify(h));
}

async function scenarioRecover() {
  const store = new InMemoryControlPlaneStore();
  const o = new Orchestrator(store as any, new EventBus());
  const claude = new HangAgent('claude'); const codex = new QuickAgent('codex');
  o.registerAdapter(claude as any); o.registerAdapter(codex as any);
  const task = await o.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true } as any);
  const run = await store.getRun(task.runId);
  console.log('[recover] before: status=', run!.status, 'currentAgentId=', run!.currentAgentId, 'sessions=', Object.fromEntries(Object.entries(run!.agentSessions).map(([k, v]: any) => [k, v.status])));
  // 模拟重启：新的 orchestrator 共享 store
  const o2 = new Orchestrator(store as any, new EventBus());
  const claude2 = new HangAgent('claude'); const codex2 = new QuickAgent('codex');
  o2.registerAdapter(claude2 as any); o2.registerAdapter(codex2 as any);
  const report = await o2.recover();
  const r2 = await store.getRun(task.runId);
  console.log('[recover] report=', JSON.stringify(report), 'status=', r2!.status, 'claude2.calls=', JSON.stringify(claude2.calls), 'codex2.calls=', JSON.stringify(codex2.calls), 'sessions=', Object.fromEntries(Object.entries(r2!.agentSessions).map(([k, v]: any) => [k, v.status])));
  const ev = await store.listEvents(task.runId);
  console.log('[recover] post-restart event types:', ev.slice(-5).map((e: any) => e.type + ':' + (e.data.code ?? '')).join(', '));
}

await scenarioCancel();
await scenarioRecover();
