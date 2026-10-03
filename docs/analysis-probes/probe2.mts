import { EventBus } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/event-bus.ts';
import { Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/orchestrator.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';
import { WorkflowAgent } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/workflow-agent.ts';

async function scenario(decision: 'approve' | 'decline') {
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store as any, new EventBus());
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'handoff', to: 'codex', instruction: 'Take a look' }]);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, []);
  const tester = new WorkflowAgent({ id: 'test', kind: 'test' }, [], { kind: 'test', passed: true });
  orch.registerAdapter(claude); orch.registerAdapter(codex); orch.registerAdapter(tester);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'implementation-v1', testCommand: 'npm test' });
  let run = (await store.getRun(task.runId))!;
  console.log(decision, 'before:', run.status, run.workflowState?.step, run.workflowState?.awaitingAgentId, run.agentSessions.claude?.status);
  await orch.resolveApproval(task.id, run.pendingApprovals[0]!.id, decision);
  run = (await store.getRun(task.runId))!;
  console.log(decision, 'after:', run.status, run.workflowState?.step, run.workflowState?.awaitingAgentId, 'claude=', run.agentSessions.claude?.status, 'codex=', run.agentSessions.codex?.status, 'codexCalls', codex.calls.length, codex.calls[0]?.mode, 'testCalls', tester.calls.length);
  // workaround: resolveGate?
  try { await orch.resolveGate(task.id, 'accept'); } catch (e) { console.log('resolveGate:', (e as Error).message); }
  // workaround: send message to claude
  await orch.sendMessage(task.id, 'claude', 'continue');
  run = (await store.getRun(task.runId))!;
  console.log(decision, 'after sendMessage:', run.status, run.workflowState?.step, 'testCalls', tester.calls.length);
}
(async () => { await scenario("approve"); await scenario("decline"); })();
