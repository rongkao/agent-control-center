import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { InMemoryControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/in-memory-store.ts';
import { ClaudeAgentSdkAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/adapters/src/claude-agent-sdk-adapter.ts';

let queries = 0;
const consumed: string[] = [];
// 假執行時：讀取第一條提示，發 init，然後拋異常（模擬 CLI 程序崩潰）
const queryFn = ({ prompt }: any) => {
  queries++;
  const it = prompt[Symbol.asyncIterator]();
  async function* gen() {
    const first = await it.next();
    consumed.push('first:' + JSON.stringify(first.value?.message?.content).slice(0, 30));
    yield { type: 'system', subtype: 'init', session_id: 'native-1', model: 'm', cwd: '.', permissionMode: 'default' } as any;
    await new Promise((r) => setTimeout(r, 20));
    throw new Error('Claude Code process exited with code 1');
  }
  const g = gen() as any;
  g.interrupt = async () => undefined;
  return g;
};

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orch = new Orchestrator(store as any, bus);
orch.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: queryFn as any }) as any);
const task = await orch.createTask({ title: 't', prompt: 'do it', agentId: 'claude' } as any);
await new Promise((r) => setTimeout(r, 500));
const events = await store.listEvents(task.runId);
const run = await store.getRun(task.runId);
console.log('queries=', queries, 'consumed=', consumed);
console.log('run.status=', run?.status, 'claude session status=', run?.agentSessions.claude?.status, 'transportRetriesUsed=', run?.workflowState?.transportRetriesUsed, 'awaiting=', run?.workflowState?.awaitingAgentId);
console.log(events.map((e: any) => `${e.type}:${e.data.status ?? e.data.code ?? e.data.direction ?? ''}`).join('\n'));
