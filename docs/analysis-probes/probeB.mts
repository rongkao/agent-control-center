import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';

// 模擬真實 Claude adapter：每輪 model.turn.completed（無工具進展）後 agent.status completed
class ChatAgent {
  info: any; calls: string[] = []; cancels = 0; n = 0; sessions = new Map<string, any>();
  constructor(id: string, kind: string) { this.info = { id, name: id, kind, ready: true, capabilities: [] }; }
  base(sid: string) { const s = this.sessions.get(sid); return { projectId: s.projectId, taskId: s.taskId, runId: s.runId, agentId: this.info.id, sessionId: sid, severity: 'info', confidence: 'confirmed' }; }
  async turn(sid: string, emit: any) {
    await emit({ ...this.base(sid), type: 'agent.message', data: { message: 'answer' } });
    await emit({ ...this.base(sid), type: 'model.turn.completed', data: { usage: { inputTokens: 1, outputTokens: 1 } } });
    await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'completed' } });
  }
  async start(input: any, emit: any) { const sid = `${this.info.id}-${++this.n}`; this.sessions.set(sid, input); this.calls.push('start'); await emit({ ...this.base(sid), type: 'agent.started', data: {} }); await this.turn(sid, emit); return { sessionId: sid, providerSessionId: 'native-' + sid }; }
  async send(sid: string, _m: string, emit: any) { this.calls.push('send'); await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'coding' } }); await this.turn(sid, emit); }
  async resume(sid: string, input: any, emit: any) { this.sessions.set(sid, input); this.calls.push('resume'); await this.turn(sid, emit); }
  async cancel(sid: string, emit: any) { this.cancels++; await emit({ ...this.base(sid), type: 'agent.status', data: { status: 'cancelled' } }); }
}
let now = 1_000_000;
const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store as any, bus, { now: () => now });
const claude = new ChatAgent('claude', 'claude');
orch.registerAdapter(claude as any);
// workflow 無測試命令 + 評審閘門，預設預算（maxStallCount=3）
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', reviewGate: true });
const show = async (label: string) => { const r = (await store.getRun(task.runId))!; console.log(label, r.status, 'step=', r.currentStep, 'wf=', r.workflowState?.step, 'await=', r.workflowState?.awaitingAgentId, 'stall=', r.budget.stallCount, 'calls=', claude.calls.join(',')); };
await show('B0');
await orch.resolveGate(task.id, 'retry', 'more'); await show('B1');
await orch.resolveGate(task.id, 'retry', 'more'); await show('B2');
await orch.resolveGate(task.id, 'retry', 'more'); await show('B3');
await orch.resolveGate(task.id, 'accept'); await show('B4-accept');
const evs = await store.listEvents(task.runId);
console.log(evs.slice(-14).map((e: any) => `${e.type}${e.data.status ? ':' + e.data.status : ''}${e.data.limit ? ':' + e.data.limit : ''}`).join(' | '));

// manual chat 任務：30 分鐘後無法 accept
{
  const store2 = new InMemoryControlPlaneStore(); const bus2 = new EventBus(); let t = 0;
  const o2 = new Orchestrator(store2 as any, bus2, { now: () => t });
  const c2 = new ChatAgent('claude', 'claude'); o2.registerAdapter(c2 as any);
  const tk = await o2.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  t += 31 * 60 * 1000; await o2.checkBudgets();
  console.log('M after timer', (await store2.getRun(tk.runId))!.status);
  await o2.sendMessage(tk.id, 'claude', 'hi');
  console.log('M after message', (await store2.getRun(tk.runId))!.status, c2.calls.join(','));
  await o2.resolveGate(tk.id, 'accept');
  const r = (await store2.getRun(tk.runId))!;
  console.log('M after accept', r.status, r.currentStep);
}
