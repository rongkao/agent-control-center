import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { ClaudeAgentSdkAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/adapters/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';

let queries = 0;
const consumed: string[] = [];
const queryFn = ({ prompt }: any) => {
  queries++;
  const it = prompt[Symbol.asyncIterator]();
  const gen = (async function* () {
    const first = await it.next();
    consumed.push(String(first.value?.message?.content).slice(0, 30));
    yield { type: 'system', subtype: 'init', session_id: 'native-1', model: 'm', cwd: '/', permissionMode: 'default' } as any;
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('Claude Code process exited with code 1');
  })();
  return Object.assign(gen, { interrupt: async () => undefined });
};

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store as any, bus);
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: queryFn as any }));
const log: string[] = [];
bus.subscribe((e) => { log.push(`${e.type}${e.data.status ? ':' + e.data.status : ''}${e.data.code ? ':' + e.data.code : ''}${e.data.direction ? ':' + e.data.direction : ''}`); });
const task = await orch.createTask({ title: 't', prompt: 'do it', agentId: 'claude', workflow: 'implementation-v1' } as any);
await new Promise((r) => setTimeout(r, 500));
const run = await store.getRun(task.runId);
console.log(log.join('\n'));
console.log('run.status', run?.status, 'claude status', run?.agentSessions.claude?.status, 'ws.step', run?.workflowState?.step, 'awaiting', run?.workflowState?.awaitingAgentId, 'transportRetriesUsed', run?.workflowState?.transportRetriesUsed);
console.log('queries', queries, 'consumed', consumed);
process.exit(0);
