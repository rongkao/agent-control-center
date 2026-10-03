import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';

type Sink = (e: any) => Promise<void>;
class SlowAdapter {
  info: any;
  calls: string[] = [];
  gate?: () => void;
  sessions = new Map<string, any>();
  n = 0;
  askApproval = false;
  constructor(id: string) { this.info = { id, name: id, kind: id, ready: true, capabilities: ['implement'] }; }
  async start(input: any, emit: Sink) {
    this.calls.push('start');
    const sid = `${this.info.id}-${++this.n}`;
    // 模擬 init 前的慢啟動：agent.started 之前等待外部放行
    await new Promise<void>((r) => (this.gate = r));
    const ids = { projectId: input.projectId, taskId: input.taskId, runId: input.runId };
    await emit({ ...ids, agentId: this.info.id, sessionId: sid, type: 'agent.started', severity: 'info', confidence: 'confirmed', data: { providerSessionId: 'p-' + sid, adapterType: this.info.kind } });
    await emit({ ...ids, agentId: this.info.id, sessionId: sid, type: 'agent.status', severity: 'info', confidence: 'confirmed', data: { status: 'coding' } });
    if (this.askApproval) {
      await emit({ ...ids, agentId: this.info.id, sessionId: sid, type: 'approval.required', severity: 'warning', confidence: 'confirmed', data: { approvalId: 'appr-1', toolName: 'Bash', toolInput: { command: 'rm -rf x' } } });
    }
    return { sessionId: sid, providerSessionId: 'p-' + sid };
  }
  async send(sid: string) { this.calls.push('send ' + sid); }
  async cancel(sid: string) { this.calls.push('cancel ' + sid); }
  async approve(sid: string, d: any) { this.calls.push('approve ' + sid); }
  async resume(sid: string, input: any) { this.calls.push('resume ' + input.reason + ' ' + sid); }
}

async function scenarioA() {
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store as any, new EventBus());
  const claude = new SlowAdapter('claude');
  orch.registerAdapter(claude as any);
  const p = orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' } as any);
  // 等待 start 進入 gate
  while (!claude.gate) await new Promise((r) => setTimeout(r, 5));
  const tasks = await (store as any).listTasks();
  const task = tasks[0];
  await orch.cancelTask(task.id);
  const mid = await store.getRun(task.runId);
  console.log('A: after cancel status=', mid!.status, 'calls=', claude.calls);
  claude.gate!();
  await p;
  const run = await store.getRun(task.runId);
  console.log('A: final status=', run!.status, 'sessions=', JSON.stringify(run!.agentSessions), 'calls=', claude.calls);
  console.log('A: live=', [...(orch as any).liveSessions.entries()]);
}

async function scenarioB() {
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store as any, new EventBus());
  const claude = new SlowAdapter('claude');
  claude.askApproval = true;
  orch.registerAdapter(claude as any);
  const p = orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' } as any);
  while (!claude.gate) await new Promise((r) => setTimeout(r, 5));
  claude.gate!();
  const task = await p;
  let run = await store.getRun(task.runId);
  console.log('B: status before cancel=', run!.status, 'pending=', run!.pendingApprovals.map((a: any) => a.id));
  await orch.cancelTask(task.id);
  run = await store.getRun(task.runId);
  console.log('B: after cancel status=', run!.status, 'pending=', run!.pendingApprovals.map((a: any) => a.id + ':' + a.status));
  await orch.resolveApproval(task.id, 'appr-1', 'approve');
  run = await store.getRun(task.runId);
  console.log('B: after approve status=', run!.status, 'calls=', claude.calls, 'live=', [...(orch as any).liveSessions.entries()]);
}

await scenarioA();
await scenarioB();
