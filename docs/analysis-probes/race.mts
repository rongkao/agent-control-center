import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { WorkflowAgent } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/workflow-agent.ts';

const store = new InMemoryControlPlaneStore();
const orchestrator = new Orchestrator(store, new EventBus());
const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'handoff', to: 'codex', instruction: 'Please review', text: 'done' }] as any);
const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, []);
orchestrator.registerAdapter(claude);
orchestrator.registerAdapter(codex);
const task = await orchestrator.createTask({ title: 'chat', prompt: 'x', agentId: 'claude', workflow: 'manual' });
const run = (await store.getRun(task.runId))!;
const approval = run.pendingApprovals[0]!;
console.log('status before:', run.status, 'approval kind:', (approval.payload as any)?.kind);
// 模拟两个浏览器标签页同时点“批准”
const results = await Promise.allSettled([
  orchestrator.resolveApproval(task.id, approval.id, 'approve'),
  orchestrator.resolveApproval(task.id, approval.id, 'approve'),
]);
console.log('results:', results.map((r) => r.status + (r.status === 'rejected' ? ':' + (r.reason as Error).message : '')).join(', '));
const events = await store.listEvents(task.runId);
console.log('approval.resolved events:', events.filter((e) => e.type === 'approval.resolved').length);
console.log('handoff.requested (agent-request) events:', events.filter((e) => e.type === 'handoff.requested' && e.data.reason === 'agent-request').length);
console.log('codex received prompts:', codex.calls.length);
