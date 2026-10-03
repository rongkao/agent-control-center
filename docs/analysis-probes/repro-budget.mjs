import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';

// 模擬純問答型 agent：每條訊息 -> 一段回覆 + model.turn.completed（無工具）+ agent.status completed
class ChatAdapter {
  constructor(id, kind) { this.info = { id, name: id, kind, ready: true, capabilities: ['implement'] }; this.n = 0; this.sessions = new Map(); this.calls = { start: 0, send: 0, resume: 0, cancel: 0 }; }
  base(s, sid) { return { projectId: s.projectId, taskId: s.taskId, runId: s.runId, agentId: this.info.id, sessionId: sid, severity: 'info', confidence: 'confirmed' }; }
  async reply(sid, emit) {
    const s = this.sessions.get(sid);
    await emit({ ...this.base(s, sid), type: 'agent.status', data: { status: 'planning' } });
    await emit({ ...this.base(s, sid), type: 'agent.message', data: { direction: 'from-agent', message: 'answer' } });
    await emit({ ...this.base(s, sid), type: 'model.turn.completed', data: { usage: { inputTokens: 10, outputTokens: 10 } } });
    await emit({ ...this.base(s, sid), type: 'agent.status', data: { status: 'completed' } });
  }
  async start(input, emit) { this.calls.start++; const sid = `${this.info.id}-${++this.n}`; this.sessions.set(sid, input); await emit({ ...this.base(input, sid), type: 'agent.started', data: {} }); await this.reply(sid, emit); return { sessionId: sid, providerSessionId: 'native-' + sid }; }
  async send(sid, msg, emit) { this.calls.send++; await this.reply(sid, emit); }
  async resume(sid, input, emit) { this.calls.resume++; this.sessions.set(sid, input); await this.reply(sid, emit); }
  async cancel(sid, emit) { this.calls.cancel++; const s = this.sessions.get(sid); await emit({ ...this.base(s, sid), type: 'agent.status', data: { status: 'cancelled' } }); }
}

async function scenario(name, fn) { try { console.log('==', name); await fn(); } catch (e) { console.log('  ERROR', e.message); } }

function boot(now) {
  const store = new InMemoryControlPlaneStore(); const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { now });
  const claude = new ChatAdapter('claude', 'claude'); const codex = new ChatAdapter('codex', 'codex');
  orch.registerAdapter(claude); orch.registerAdapter(codex);
  return { store, orch, claude, codex };
}
const lim = (evs) => evs.filter(e => e.type === 'budget.exceeded' || e.type === 'budget.stalled').map(e => `${e.type}:${e.data.limit}`);

await scenario('stall: pure Q&A manual chat', async () => {
  const { store, orch, claude } = boot();
  const t = await orch.createTask({ title: 't', prompt: 'q1', agentId: 'claude', workflow: 'manual' });
  let r = await store.getRun(t.runId); console.log('  after q1', r.status, 'stall', r.budget.stallCount, 'calls', r.budget.agentCallsUsed);
  await orch.sendMessage(t.id, 'claude', 'q2');
  r = await store.getRun(t.runId); console.log('  after q2', r.status, 'stall', r.budget.stallCount);
  await orch.sendMessage(t.id, 'claude', 'q3');
  r = await store.getRun(t.runId); console.log('  after q3', r.status, 'stall', r.budget.stallCount, r.currentStep, lim(await store.listEvents(t.runId)));
  // BLOCKED 後再發訊息
  await orch.sendMessage(t.id, 'claude', 'q4');
  r = await store.getRun(t.runId); console.log('  after q4 (while BLOCKED)', r.status, 'stall', r.budget.stallCount, 'calls', r.budget.agentCallsUsed, 'claude.send', claude.calls.send, 'turnsUsed', r.budget.turnsUsed, 'limitEvents', lim(await store.listEvents(t.runId)));
  for (let i = 5; i <= 14; i++) { try { await orch.sendMessage(t.id, 'claude', 'q' + i); } catch (e) { console.log('  q'+i+' threw', e.message); } }
  r = await store.getRun(t.runId); console.log('  after q14', r.status, 'calls', r.budget.agentCallsUsed, 'claude.send', claude.calls.send, 'limitEvents', lim(await store.listEvents(t.runId)));
});

await scenario('duration: idle manual chat', async () => {
  let now = 1_000_000;
  const { store, orch } = boot(() => now);
  const t = await orch.createTask({ title: 't', prompt: 'q1', agentId: 'claude', workflow: 'manual' });
  now += 30 * 60 * 1000;
  await orch.checkBudgets();
  const r = await store.getRun(t.runId); console.log('  after 30min idle', r.status, r.currentStep);
  await orch.sendMessage(t.id, 'claude', 'hello again');
  const r2 = await store.getRun(t.runId); console.log('  after message while BLOCKED', r2.status, 'turns', r2.budget.turnsUsed);
  // 轉發到 codex（新會話 -> startAgent 會 BLOCKED->RUNNING）
  await orch.handoffMessage(t.id, 'claude', 'codex', 'x', 'review');
  const r3 = await store.getRun(t.runId); console.log('  after first handoff to codex', r3.status, r3.currentStep, lim(await store.listEvents(t.runId)));
});

await scenario('calls: askBoth consumes 2', async () => {
  const { store, orch } = boot();
  const t = await orch.createTask({ title: 't', prompt: 'q1', agentId: 'claude', workflow: 'manual', askBoth: true });
  const r = await store.getRun(t.runId); console.log('  askBoth create calls', r.budget.agentCallsUsed, r.status, 'stall', r.budget.stallCount);
});
