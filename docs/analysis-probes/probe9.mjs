const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);
const { AsyncAgent } = await import('./probe-agent.mjs');
const store = new InMemoryControlPlaneStore();
const mk = () => { const o = new Orchestrator(store, new EventBus(), { workspacePolicy: 'exclusive', defaultCwd: 'C:/tmp/ws-probe' }); o.registerAdapter(new AsyncAgent('claude', 'claude', { fallback: { kind: 'silent' } })); o.registerAdapter(new AsyncAgent('codex', 'codex', { fallback: { kind: 'silent' } })); o.registerAdapter(new AsyncAgent('test', 'test', { fallback: { kind: 'test', passed: true } })); return o; };
const o1 = mk();
const t = await o1.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
await o1.resolveGate(t.id, 'accept');
// 同一工作區：兩個對話任務 + 一個工作流任務都能同時建立（獨佔策略只看 workflowState）
const c1 = await o1.createTask({ title: 'chat1', prompt: 'p', agentId: 'claude', workflow: 'manual' });
const c2 = await o1.createTask({ title: 'chat2', prompt: 'p', agentId: 'codex', workflow: 'manual' });
let wfErr; try { await o1.createTask({ title: 'wf', prompt: 'p', agentId: 'claude' }); } catch (e) { wfErr = e.message; }
const o2 = mk(); // 重啟
await o2.recover();
let err; try { await o2.setHandoffPolicy(t.id, 'auto'); } catch (e) { err = e.message; }
console.log(JSON.stringify({ chatTasksSameWorkspace: [c1.status, c2.status], workflowAlongsideChats: wfErr ?? 'created', setPolicyOnTerminalAfterRestart: err ?? 'ok' }, null, 1));
