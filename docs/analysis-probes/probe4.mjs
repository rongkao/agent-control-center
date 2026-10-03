const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);
const { ClaudeAgentSdkAdapter } = await import(`${ROOT}/packages/adapters/src/index.ts`);
const { AsyncAgent } = await import('./probe-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let queries = 0;
const prompts = [];
// 第一次 query：init 後丟擲執行時異常（模擬 CLI 程序崩潰）；之後的 query 正常完成
const queryFn = ({ prompt, options }) => {
  const n = ++queries;
  const sid = options.resume ?? `native-${n}`;
  async function* gen() {
    yield { type: 'system', subtype: 'init', session_id: sid, model: 'm', cwd: '.', permissionMode: 'default' };
    if (n === 1) { await sleep(20); throw new Error('socket hang up'); }
    for await (const user of prompt) {
      prompts.push(String(user.message.content).slice(0, 60));
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1, session_id: sid };
    }
  }
  const it = gen();
  return { [Symbol.asyncIterator]: () => it, interrupt: async () => {} };
};
const store = new InMemoryControlPlaneStore();
const orch = new Orchestrator(store, new EventBus());
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn }));
orch.registerAdapter(new AsyncAgent('codex', 'codex', { fallback: { kind: 'reply' }, syncTurn: true }));
orch.registerAdapter(new AsyncAgent('test', 'test', { fallback: { kind: 'test', passed: true }, syncTurn: true }));
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'npm test' });
await sleep(500);
const run = await store.getRun(task.runId);
const ev = await store.listEvents(task.runId);
console.log(JSON.stringify({ status: run.status, step: run.workflowState.step, awaiting: run.workflowState.awaitingAgentId, transportRetriesUsed: run.workflowState.transportRetriesUsed, claudeStatus: run.agentSessions.claude?.status, queries, promptsConsumed: prompts, tail: ev.slice(-6).map((e) => `${e.type}:${e.data.status ?? e.data.code ?? e.data.direction ?? ''}`) }, null, 2));
