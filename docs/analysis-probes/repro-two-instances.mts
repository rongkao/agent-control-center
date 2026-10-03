import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { SqliteControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { FakeWorld, ScriptedAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/scripted-adapter.ts';

const dir = mkdtempSync(join(tmpdir(), 'acc-repro-'));
const dbPath = join(dir, 'agent-control.db');
const world = new FakeWorld();
function boot(adapter: any) {
  const store = new SqliteControlPlaneStore({ path: dbPath });
  const bus = new EventBus();
  const orchestrator = new Orchestrator(store, bus);
  orchestrator.registerAdapter(adapter);
  return { store, bus, orchestrator };
}
// 实例 1：执行 tool-A 后仍在 RUNNING，且不关闭 store（进程仍存活）
const a1 = new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }]);
const p1 = boot(a1);
const task = await p1.orchestrator.createTask({ title: 'x', prompt: 'do', agentId: 'claude' } as any);
console.log('p1 run status', (await p1.store.getRun(task.runId))?.status, 'instance', p1.orchestrator.instanceId);
// 实例 2：同一数据库，第一实例未退出
const a2 = new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }, { kind: 'tool', id: 'tool-Z' }]);
const p2 = boot(a2);
const report = await p2.orchestrator.recover();
console.log('p2 recover', JSON.stringify(report));
console.log('world executions', world.executions);
const snap = await p2.store.getRun(task.runId);
console.log('owner after p2', Object.values(snap!.agentSessions).map((s: any) => s.ownerInstanceId), 'p2 instance', p2.orchestrator.instanceId, 'status', snap?.status);
// 实例 1 继续操作
try {
  await p1.orchestrator.sendMessage(task.id, 'claude', 'hello');
  console.log('p1 sendMessage ok');
} catch (e) {
  console.log('p1 sendMessage error:', (e as Error).message);
}
p1.store.close(); p2.store.close();
