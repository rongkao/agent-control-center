import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';
import { ClaudeAgentSdkAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/adapters/src/claude-agent-sdk-adapter.ts';

let queries = 0;
const consumed: string[] = [];
const queryFn = ({ prompt }: any) => {
  queries++;
  const it = prompt[Symbol.asyncIterator]();
  async function* gen() {
    const first = await it.next();
    consumed.push('first:' + JSON.stringify(first.value?.message?.content).slice(0, 30));
    yield { type: 'system', subtype: 'init', session_id: 'native-1', model: 'm', cwd: '/', permissionMode: 'default' } as any;
    await new Promise((r) => setTimeout(r, 50));
    throw new Error('Claude Code process exited with code 1');
  }
  const g = gen();
  return { [Symbol.asyncIterator]: () => g, interrupt: async () => {} } as any;
};

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store, bus, { workspacePolicy: 'shared' });
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn }));
const task = await orch.createTask({ title: 't', prompt: 'do it' });
await new Promise((r) => setTimeout(r, 500));
const events = await store.listEvents(task.runId);
for (const e of events) console.log(e.sequence, e.type, JSON.stringify(e.data).slice(0, 110));
const run = await store.getRun(task.runId);
console.log('run.status', run?.status, 'awaiting', run?.workflowState?.awaitingAgentId, 'transportRetriesUsed', run?.workflowState?.transportRetriesUsed, 'session.status', run?.agentSessions.claude?.status);
console.log('queries', queries, 'consumed', consumed);
process.exit(0);
