import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { CodexAppServerAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/adapters/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { FakeCodexDisk, FakeCodexServer } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/fake-codex-server.ts';

const disk = new FakeCodexDisk();
const servers: FakeCodexServer[] = [];
const script = () => [{ kind: 'message', text: 'working' } as const];
const adapter = new CodexAppServerAdapter({ transportFactory: () => { const s = new FakeCodexServer(disk, script as any); servers.push(s); return s.transport; }, defaultCwd: '/repo' });
const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store as any, bus);
orch.registerAdapter(adapter);
const log: string[] = [];
let crashed = false;
bus.subscribe((e) => {
  log.push(`${e.type}${e.data.status ? ':' + e.data.status : ''}${e.data.code ? ':' + e.data.code : ''}${e.data.direction ? ':' + e.data.direction : ''}`);
  if (e.type === 'model.turn.started' && !crashed) { crashed = true; servers[0]!.crash('app-server crashed'); }
});
const task = await orch.createTask({ title: 't', prompt: 'do it', agentId: 'codex', workflow: 'implementation-v1' } as any);
await new Promise((r) => setTimeout(r, 500));
let run = await store.getRun(task.runId);
console.log(log.join('\n'));
console.log('run.status', run?.status, 'codex status', run?.agentSessions.codex?.status, 'ws.step', run?.workflowState?.step, 'transportRetriesUsed', run?.workflowState?.transportRetriesUsed, 'servers', servers.length);
// operator gate retry
log.length = 0;
try { await orch.resolveGate(task.id, 'retry', 'please continue'); } catch (e) { console.log('gate err', (e as Error).message); }
await new Promise((r) => setTimeout(r, 300));
run = await store.getRun(task.runId);
console.log('--- after gate retry\n' + log.join('\n'));
console.log('run.status', run?.status, 'servers', servers.length);
process.exit(0);
