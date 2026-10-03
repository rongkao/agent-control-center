const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);
const { AsyncAgent } = await import('./probe-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
// A. review-gate 等待中，給尚無會話的 codex 發訊息 -> run 變 RUNNING -> 閘門無法再處理
{
  const claude = new AsyncAgent('claude', 'claude', { fallback: { kind: 'reply' }, syncTurn: true });
  const codex = new AsyncAgent('codex', 'codex', { fallback: { kind: 'reply' }, syncTurn: true });
  const test = new AsyncAgent('test', 'test', { fallback: { kind: 'test', passed: true }, syncTurn: true });
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store, new EventBus());
  [claude, codex, test].forEach((a) => orch.registerAdapter(a));
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test', reviewGate: true });
  const before = (await store.getRun(task.runId)).status;
  await orch.sendMessage(task.id, 'codex', 'what do you think?');
  const r = await store.getRun(task.runId);
  let gateErr; try { await orch.resolveGate(task.id, 'accept'); } catch (e) { gateErr = e.message; }
  out.A = { before, after: r.status, wfStep: r.workflowState.step, pendingInputs: r.pendingInputs.map((x) => x.id), gateErr };
}
// B. 對話任務：askBoth 兩個都在工作時“重啟” -> 只續接 currentAgentId
{
  const store = new InMemoryControlPlaneStore();
  const orch = new Orchestrator(store, new EventBus(), { workspacePolicy: 'shared' });
  orch.registerAdapter(new AsyncAgent('claude', 'claude', { fallback: { kind: 'silent' } }));
  orch.registerAdapter(new AsyncAgent('codex', 'codex', { fallback: { kind: 'reply' }, syncTurn: true }));
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', askBoth: true });
  const r0 = await store.getRun(task.runId);
  // 模擬程序重啟：新編排器 + 新 adapter 實例，同一個 store
  const orch2 = new Orchestrator(store, new EventBus(), { workspacePolicy: 'shared' });
  const c2 = new AsyncAgent('claude', 'claude', { fallback: { kind: 'silent' } });
  const x2 = new AsyncAgent('codex', 'codex', { fallback: { kind: 'reply' }, syncTurn: true });
  orch2.registerAdapter(c2); orch2.registerAdapter(x2);
  const report = await orch2.recover();
  const r1 = await store.getRun(task.runId);
  const ev = await store.listEvents(task.runId);
  out.B = { currentAgentId: r0.currentAgentId, statusesBefore: Object.fromEntries(Object.entries(r0.agentSessions).map(([k, v]) => [k, v.status])), report, statusAfter: r1.status, claudeResumed: c2.log, incidents: ev.filter((e) => e.type === 'runtime.error').map((e) => e.data.code) };
}
// C. WAITING_APPROVAL 時給新 agent 發訊息 -> RUNNING 但仍有待審批
{
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
  orch.registerAdapter(new AsyncAgent('claude', 'claude', { fallback: { kind: 'silent' } }));
  orch.registerAdapter(new AsyncAgent('codex', 'codex', { fallback: { kind: 'silent' } }));
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId: 'claude-1', type: 'approval.required', severity: 'warning', confidence: 'confirmed', data: { approvalId: 'ap', summary: 's' } });
  const s0 = (await store.getRun(task.runId)).status;
  await orch.sendMessage(task.id, 'codex', 'hi');
  const r = await store.getRun(task.runId);
  out.C = { before: s0, after: r.status, pending: r.pendingApprovals.length, cursor: r.resumeCursor };
}
// D. 預算拒絕後 askBoth 的 handoff / 取消已終止任務後仍可 resolveApproval
{
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const claude = new AsyncAgent('claude', 'claude', { fallback: { kind: 'silent' } });
  claude.approve = async (sid, d) => { claude.log.push(['approve', d.decision]); };
  const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
  orch.registerAdapter(claude);
  const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
  await orch.cancelTask(task.id);
  await bus.publish({ projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'claude', sessionId: 'claude-1', type: 'approval.required', severity: 'warning', confidence: 'confirmed', data: { approvalId: 'late', summary: 's' } });
  let err; try { await orch.resolveApproval(task.id, 'late', 'approve'); } catch (e) { err = e.message; }
  out.D = { status: (await store.getRun(task.runId)).status, pendingOnTerminal: (await store.getRun(task.runId)).pendingApprovals.length, err, claudeLog: claude.log };
}
console.log(JSON.stringify(out, null, 2));
