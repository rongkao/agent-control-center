import { pathToFileURL } from 'node:url';
const root = 'D:/codes/ai/AgentBox/agent-control-center-claude';
const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { EventBus, Orchestrator } = await imp('packages/core/src/index.ts');
const { InMemoryControlPlaneStore } = await imp('packages/storage/src/index.ts');
const { ScriptedAdapter, FakeWorld } = await imp('tests/fakes/scripted-adapter.ts');
for (const workflow of ['manual', 'implementation-v1']) {
const world = new FakeWorld();
const store = new InMemoryControlPlaneStore();
const orch = new Orchestrator(store, new EventBus());
const claude = new ScriptedAdapter(world, [{ kind: 'approval', id: 'ap-B', providerCallId: 'pc-B' }, { kind: 'tool', id: 'B' }], { id: 'claude', kind: 'claude' });
orch.registerAdapter(claude);
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow, reviewAgentId: 'claude' });
let run = await store.getRun(task.runId);
console.log(workflow, 'create:', run.status, run.pendingApprovals.map((a: any)=>a.id));
await orch.cancelTask(task.id);
run = await store.getRun(task.runId);
console.log(workflow, 'cancel:', run.status, 'cancel calls', claude.calls.cancel, 'pending', run.pendingApprovals.map((a: any)=>a.id));
await orch.resolveApproval(task.id, 'ap-B', 'approve');
run = await store.getRun(task.runId);
console.log(workflow, 'approve:', run.status, 'executions', world.executions, 'resume', claude.calls.resume, 'approve', claude.calls.approve);
}
