const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const { EventBus, Orchestrator } = await import(`${ROOT}/packages/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${ROOT}/packages/storage/src/index.ts`);
const { ClaudeAgentSdkAdapter } = await import(`${ROOT}/packages/adapters/src/index.ts`);
const { AsyncAgent } = await import('./probe-agent.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('exit', (c) => console.log('process exit code', c));
// Claude 在一輪中並行呼叫兩次 request_handoff（auto 策略），目標 codex 啟動較慢
const queryFn = ({ prompt, options }) => {
  async function* gen() {
    yield { type: 'system', subtype: 'init', session_id: 'native-1', model: 'm', cwd: '.', permissionMode: 'default' };
    for await (const _ of prompt) {
      const server = options.mcpServers.acc.instance;
      const tools = server._registeredTools ?? {};
      const tool = tools['request_handoff'];
      if (!tool) { console.log('tool keys', Object.keys(server)); break; }
      const cb = tool.handler ?? tool.callback;
      await cb({ to: 'codex', instruction: 'review A' }, {}); await sleep(5); await cb({ to: 'codex', instruction: 'review B' }, {});
      await sleep(200);
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, duration_ms: 1, session_id: 'native-1' };
    }
  }
  const it = gen();
  return { [Symbol.asyncIterator]: () => it, interrupt: async () => {} };
};
const store = new InMemoryControlPlaneStore();
const orch = new Orchestrator(store, new EventBus(), { workspacePolicy: 'shared' });
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn }));
orch.registerAdapter(new AsyncAgent('codex', 'codex', { startDelay: 500, fallback: { kind: 'reply' } }));
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto' });
await sleep(1000);
console.log('still alive; status', (await store.getRun(task.runId)).status);
