import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { WorkflowAgent } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/workflow-agent.ts';

let clock = 1_000_000;
async function scenarioA() {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { now: () => clock });
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, []);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, [], { kind: 'reply', text: 'VERDICT: ACCEPT' });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test' }, [{ kind: 'test', passed: true }], { kind: 'test', passed: true });
  orch.registerAdapter(claude); orch.registerAdapter(codex); orch.registerAdapter(tester);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', reviewGate: true });
  let run = (await store.getRun(task.runId))!;
  console.log('A after create:', run.status, run.workflowState?.step);
  clock += 31 * 60 * 1000;
  await orch.checkBudgets();
  run = (await store.getRun(task.runId))!;
  console.log('A after checkBudgets while waiting:', run.status);
  await orch.resolveGate(task.id, 'accept');
  run = (await store.getRun(task.runId))!;
  console.log('A after accept#1:', run.status, run.currentStep, 'wf=', run.workflowState?.step);
  await orch.resolveGate(task.id, 'accept');
  run = (await store.getRun(task.runId))!;
  console.log('A after accept#2:', run.status, run.currentStep, 'wf=', run.workflowState?.step);
  try { await orch.resolveGate(task.id, 'retry', 'go'); } catch (e) { console.log('retry err', (e as Error).message); }
  run = (await store.getRun(task.runId))!;
  console.log('A after retry:', run.status, run.currentStep, 'wf=', run.workflowState?.step, 'awaiting=', run.workflowState?.awaitingAgentId, 'claude calls=', claude.calls.map(c=>c.via));
  const evs = (await store.listEvents(task.runId)).map((e) => `${e.type}${e.data.status ? ':' + e.data.status : ''}${e.data.limit ? ':' + e.data.limit : ''}${e.data.step ? '@' + e.data.step : ''}`);
  console.log(evs.slice(-20).join('\n'));
}

async function scenarioManual() {
  clock = 1_000_000;
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { now: () => clock });
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, []);
  orch.registerAdapter(claude);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  let run = (await store.getRun(task.runId))!;
  console.log('M after create:', run.status);
  clock += 31 * 60 * 1000;
  await orch.checkBudgets();
  run = (await store.getRun(task.runId))!;
  console.log('M after checkBudgets:', run.status, run.currentStep);
  await orch.resolveGate(task.id, 'accept');
  run = (await store.getRun(task.runId))!;
  console.log('M after accept:', run.status, run.currentStep);
}

await scenarioA();
await scenarioManual();
