import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { WorkflowAgent } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/workflow-agent.ts';

function boot(store: any, claudeOutcomes: any[] = [], codexOutcomes: any[] = [], claudeFallback?: any) {
  const orchestrator = new Orchestrator(store, new EventBus());
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, claudeOutcomes, claudeFallback);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, codexOutcomes);
  const tester = new WorkflowAgent({ id: 'test', kind: 'test' }, [], { kind: 'test', passed: true });
  orchestrator.registerAdapter(claude); orchestrator.registerAdapter(codex); orchestrator.registerAdapter(tester);
  return { orchestrator, claude, codex };
}
const CHAT = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' };

// 場景 A: askBoth -> cancel
{
  const store = new InMemoryControlPlaneStore();
  const env = boot(store, [{ kind: 'silent' }], [{ kind: 'reply', text: 'advice' }]);
  const task = await env.orchestrator.createTask({ ...CHAT, askBoth: true } as any);
  const run = (await store.getRun(task.runId))!;
  console.log('A: after askBoth currentAgentId=', run.currentAgentId, 'sessions=', Object.fromEntries(Object.entries(run.agentSessions).map(([k, v]: any) => [k, v.status])), 'status=', run.status);
  await env.orchestrator.cancelTask(task.id);
  const after = (await store.getRun(task.runId))!;
  console.log('A: after cancel status=', after.status, 'claude.cancels=', env.claude.cancels, 'codex.cancels=', env.codex.cancels, 'sessions=', Object.fromEntries(Object.entries(after.agentSessions).map(([k, v]: any) => [k, v.status])));
}

// 場景 C: 對話模式先讓 claude 工作，再問 codex -> cancel
{
  const store = new InMemoryControlPlaneStore();
  const env = boot(store, [{ kind: 'silent' }], [{ kind: 'reply', text: 'advice' }]);
  const task = await env.orchestrator.createTask(CHAT as any);
  await env.orchestrator.sendMessage(task.id, 'codex', 'what do you think?');
  const run = (await store.getRun(task.runId))!;
  console.log('C: currentAgentId=', run.currentAgentId, 'sessions=', Object.fromEntries(Object.entries(run.agentSessions).map(([k, v]: any) => [k, v.status])));
  await env.orchestrator.cancelTask(task.id);
  console.log('C: after cancel claude.cancels=', env.claude.cancels, 'codex.cancels=', env.codex.cancels);
}

// 場景 B: askBoth, claude 仍在工作 -> 重啟 recover
{
  const store = new InMemoryControlPlaneStore();
  const env = boot(store, [{ kind: 'silent' }], [{ kind: 'reply', text: 'advice' }]);
  const task = await env.orchestrator.createTask({ ...CHAT, askBoth: true } as any);
  const env2 = boot(store, [], []);
  const report = await env2.orchestrator.recover();
  const after = (await store.getRun(task.runId))!;
  console.log('B: report=', JSON.stringify(report), 'status=', after.status, 'sessions=', Object.fromEntries(Object.entries(after.agentSessions).map(([k, v]: any) => [k, v.status])), 'claude2.calls=', env2.claude.calls.length, 'codex2.calls=', env2.codex.calls.length);
  const evs = await store.listEvents(task.runId);
  console.log('B: runtime.error after recover=', evs.filter((e: any) => e.type === 'runtime.error').map((e: any) => e.data.code));
}

// 場景 B2: 對照 - 單 agent 工作中重啟
{
  const store = new InMemoryControlPlaneStore();
  const env = boot(store, [{ kind: 'silent' }], []);
  const task = await env.orchestrator.createTask(CHAT as any);
  const env2 = boot(store, [{ kind: 'silent' }], []);
  const report = await env2.orchestrator.recover();
  console.log('B2: report=', JSON.stringify(report), 'claude2.calls=', env2.claude.calls.map((c: any) => c.via));
}

// 場景 D: 預算停止 - maxAgentCalls? 用 wallclock
{
  let t = 1000;
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus(), { now: () => t });
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'silent' }]);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, [{ kind: 'reply', text: 'advice' }]);
  orchestrator.registerAdapter(claude); orchestrator.registerAdapter(codex);
  const task = await orchestrator.createTask({ ...CHAT, askBoth: true, budget: { maxDurationMs: 5000 } } as any);
  t += 60_000;
  await orchestrator.checkBudgets();
  const after = (await store.getRun(task.runId))!;
  console.log('D: status=', after.status, 'claude.cancels=', claude.cancels, 'codex.cancels=', codex.cancels);
}

// 場景 E: reassign 在 askBoth 後
{
  const store = new InMemoryControlPlaneStore();
  const env = boot(store, [{ kind: 'reply', text: 'claude halfway' }], [{ kind: 'reply', text: 'codex advice' }], { kind: 'silent' });
  const task = await env.orchestrator.createTask({ ...CHAT, askBoth: true } as any);
  console.log('E: currentAgentId=', (await store.getRun(task.runId))!.currentAgentId);
  try { await env.orchestrator.reassign(task.id, 'codex'); console.log('E: reassign to codex ok'); } catch (e) { console.log('E: reassign to codex threw:', (e as Error).message); }
}
