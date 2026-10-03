// 只读复现探针：auto 策略下 Claude 并行两次 request_handoff -> codex
const ROOT = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude';
const core = await import(`${ROOT}/packages/core/src/index.ts`);
const storage = await import(`${ROOT}/packages/storage/src/in-memory-store.ts`);
const adapters = await import(`${ROOT}/packages/adapters/src/claude-agent-sdk-adapter.ts`);

const WITH_HANDLER = process.argv.includes('--handler');
if (WITH_HANDLER) process.on('unhandledRejection', (e: any) => console.log('[unhandledRejection]', e?.message));

// 假 Claude 运行时：只发 system/init，然后挂起直到 abort
let capturedOptions: any;
const queryFn = ({ prompt, options }: any) => {
  capturedOptions = options;
  const iter = (async function* () {
    // 消费第一条用户消息
    const it = prompt[Symbol.asyncIterator]();
    await it.next();
    yield { type: 'system', subtype: 'init', session_id: 'claude-native-1', model: 'fake', cwd: '.', permissionMode: 'default' } as any;
    await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve()));
  })();
  return Object.assign(iter, { interrupt: async () => undefined });
};

// 假 Codex adapter：start 需要 300ms（模拟 app-server 启动 + thread/start）
const codex = {
  info: { id: 'codex', name: 'Codex', kind: 'codex', ready: true, capabilities: ['review'] },
  starts: 0,
  async start(input: any, emit: any) {
    this.starts++;
    await new Promise((r) => setTimeout(r, 300));
    const sid = `codex-${this.starts}`;
    await emit({ projectId: input.projectId, taskId: input.taskId, runId: input.runId, agentId: 'codex', sessionId: sid, type: 'agent.started', severity: 'info', confidence: 'confirmed', data: { adapterType: 'codex', providerSessionId: `thread-${this.starts}` } });
    return { sessionId: sid, providerSessionId: `thread-${this.starts}` };
  },
  async send() {},
  async resume() {},
  async cancel() {},
};

const store = new storage.InMemoryControlPlaneStore();
const bus = new core.EventBus();
const orch = new core.Orchestrator(store, bus);
const claude = new adapters.ClaudeAgentSdkAdapter({ queryFn });
orch.registerAdapter(claude);
orch.registerAdapter(codex as any);

const task = await orch.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto' });
console.log('task created, status =', (await store.getRun(task.runId))?.status);

const server = capturedOptions.mcpServers.acc;
const inst = server.instance;
const tools = inst._registeredTools ?? {};
console.log('registered tools:', Object.keys(tools));
const tool = tools['request_handoff'];
const cb = tool.callback ?? tool.handler;

process.on('exit', (code) => console.log('process exit code', code));
// Claude 同一轮中两次调用 request_handoff（并行）
const r: any[] = [];
r.push(await cb({ to: 'codex', instruction: 'seq A', content: 'x' }, {}));
await new Promise((res) => setTimeout(res, 50)); // 两次顺序调用之间间隔 50ms
r.push(await cb({ to: 'codex', instruction: 'seq B', content: 'y' }, {}));
console.log('tool results returned:', r.length);
await new Promise((res) => setTimeout(res, 1500));
const run = await store.getRun(task.runId);
console.log('after: status =', run?.status, 'codex starts =', codex.starts, 'autoHandoffsUsed =', run?.settings?.autoHandoffsUsed);
const evs = await store.listEvents(task.runId);
console.log(evs.filter((e: any) => ['runtime.error', 'handoff.requested', 'handoff.completed'].includes(e.type)).map((e: any) => `${e.type}:${e.data.code ?? e.data.reason ?? e.data.origin ?? ''}`).join('\n'));
