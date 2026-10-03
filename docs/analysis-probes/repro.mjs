// 復現：測試執行器 void this.run() 鏈路中，編排器反應鏈拋錯 → unhandled rejection
const root = 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages';
const { EventBus, Orchestrator } = await import(`${root}/core/src/index.ts`);
const { InMemoryControlPlaneStore } = await import(`${root}/storage/src/index.ts`);
const { LocalTestRunnerAdapter, createMockAdapters } = await import(`${root}/adapters/src/index.ts`);

const mode = process.argv[2] ?? 'log';
if (mode === 'log') {
  process.on('unhandledRejection', (e) => { console.log('UNHANDLED REJECTION:', e?.message); });
}
const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
for (const a of createMockAdapters()) {
  if (a.info.id === 'test') orch.registerAdapter(new LocalTestRunnerAdapter({ defaultCwd: process.cwd() }));
  else orch.registerAdapter(a);
}
let taskId;
let cancelled = false;
const trigger = process.argv[3] ?? 'workflow:rescue';
bus.subscribe(async (e) => {
  if (e.type === 'run.status' && e.data.step) console.log('run.status', e.data.status, e.data.step);
  if (!cancelled && e.type === 'run.status' && e.data.step === trigger) {
    cancelled = true;
    console.log('>> operator cancels task now');
    await orch.cancelTask(taskId);
  }
});
const task = await orch.createTask({ title: 't', prompt: 'p', agentId: 'claude', testCommand: 'node -e "process.exit(1)"', cwd: process.cwd() });
taskId = task.id;
setTimeout(() => { console.log('still alive after 8s'); process.exit(0); }, 8000);
