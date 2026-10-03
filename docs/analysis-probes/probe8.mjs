const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);
const { AsyncAgent } = await import('./probe-agent.mjs');
let now = 1_000_000;
const store = new InMemoryControlPlaneStore();
const orch = new Orchestrator(store, new EventBus(), { now: () => now });
orch.registerAdapter(new AsyncAgent('claude', 'claude', { fallback: { kind: 'reply' }, syncTurn: true }));
orch.registerAdapter(new AsyncAgent('codex', 'codex', { fallback: { kind: 'reply' }, syncTurn: true }));
orch.registerAdapter(new AsyncAgent('test', 'test', { fallback: { kind: 'test', passed: true }, syncTurn: true }));
// 注意：AsyncAgent 發出 model.turn.completed 但無工具 -> 用較大的停滯上限避免干擾
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', reviewGate: true, budget: { maxStallCount: 99 } });
const s0 = (await store.getRun(task.runId)).status;
now += 31 * 60 * 1000; // 操作員 31 分鐘後才處理評審閘門
const attempts = [];
for (let i = 0; i < 2; i++) {
  try { await orch.resolveGate(task.id, 'accept'); attempts.push('ok'); } catch (e) { attempts.push(e.message); }
  const r = await store.getRun(task.runId);
  attempts.push(`${r.status} step=${r.currentStep} wf=${r.workflowState.step}`);
}
const ev = await store.listEvents(task.runId);
console.log(JSON.stringify({ s0, attempts, tail: ev.slice(-5).map((e) => `${e.type}:${e.data.status ?? e.data.limit ?? ''}`) }, null, 1));
