// 只读验证脚本：在临时数据库上复现审计中的几个恢复/持久化场景（不修改项目文件）
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus, Orchestrator } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';
import { SqliteControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/index.ts';
import { FakeWorld, ScriptedAdapter } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/tests/fakes/scripted-adapter.ts';

const db = () => join(mkdtempSync(join(tmpdir(), 'acc-audit-')), 'a.db');
function boot(path: string, adapters: any[]) {
  const store = new SqliteControlPlaneStore({ path });
  const bus = new EventBus();
  const o = new Orchestrator(store, bus);
  for (const a of adapters) o.registerAdapter(a);
  return { store, bus, o };
}

// S1：终态 run 重启后 setHandoffPolicy → 序号冲突；快照已被改写但没有事件
{
  const path = db();
  const world = new FakeWorld();
  const p1 = boot(path, [new ScriptedAdapter(world, [{ kind: 'tool', id: 't1' }, { kind: 'complete' }])]);
  const task = await p1.o.createTask({ title: 'x', prompt: 'y', agentId: 'claude', workflow: 'manual' });
  console.log('S1 status before restart', (await p1.store.getRun(task.runId))?.status);
  p1.store.close();
  const p2 = boot(path, [new ScriptedAdapter(world, [])]);
  await p2.o.recover();
  try {
    await p2.o.setHandoffPolicy(task.id, 'auto');
    console.log('S1 no error');
  } catch (e) {
    console.log('S1 error:', (e as Error).message);
  }
  console.log('S1 snapshot policy after failed call:', (await p2.store.getRun(task.runId))?.settings?.handoffPolicy);
  p2.store.close();
}

// S2：手动任务两个 agent，cancel 只停 currentAgentId；另一个 agent 的审批在 CANCELLED 后仍可批准并执行
{
  const path = db();
  const world = new FakeWorld();
  const claude = new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }, { kind: 'approval', id: 'ap-B', providerCallId: 'B' }, { kind: 'tool', id: 'B' }]);
  const codex = new ScriptedAdapter(world, [{ kind: 'tool', id: 'C' }], { id: 'codex', kind: 'codex' });
  const p = boot(path, [claude, codex]);
  const task = await p.o.createTask({ title: 'x', prompt: 'y', agentId: 'claude', workflow: 'manual' });
  await p.o.sendMessage(task.id, 'codex', 'also look');
  await p.o.cancelTask(task.id);
  const run = await p.store.getRun(task.runId);
  console.log('S2 status', run?.status, 'pending approvals on terminal run', run?.pendingApprovals.map((x) => x.id), 'cancel calls claude/codex', claude.calls.cancel, codex.calls.cancel);
  try {
    await p.o.resolveApproval(task.id, 'ap-B', 'approve');
  } catch (e) {
    console.log('S2 resolve error', (e as Error).message);
  }
  console.log('S2 executions after cancel+approve', world.executions, 'final status', (await p.store.getRun(task.runId))?.status);
  p.store.close();
}

// S3：第二个进程打开同一个库并 recover，而第一个进程仍在运行 → 序号冲突
{
  const path = db();
  const world = new FakeWorld();
  const p1 = boot(path, [new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }])]);
  const task = await p1.o.createTask({ title: 'x', prompt: 'y', agentId: 'claude', workflow: 'manual' });
  const second = new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }, { kind: 'tool', id: 'Z' }]);
  const p2 = boot(path, [second]);
  const report = await p2.o.recover();
  console.log('S3 second instance recover report', JSON.stringify(report), 'resume calls', second.calls.resume, 'executions', world.executions);
  try {
    await p1.o.sendMessage(task.id, 'claude', 'next');
    console.log('S3 first instance publish ok');
  } catch (e) {
    console.log('S3 first instance error:', (e as Error).message);
  }
  p1.store.close();
  p2.store.close();
}

// S4：工作流已推进到 test（awaiting=test）但派发前崩溃；恢复时续接的是 currentAgentId（claude）而不是 test
{
  const path = db();
  const world = new FakeWorld();
  const claude1 = new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }]);
  const test1 = new ScriptedAdapter(world, [], { id: 'test', kind: 'test' });
  const p1 = boot(path, [claude1, test1]);
  const task = await p1.o.createTask({ title: 'x', prompt: 'y', agentId: 'claude', testCommand: 'npm test' });
  // 模拟：claude 完成信号已持久化、工作流决策已提交，但 executeDirective 之前进程崩溃
  const run = (await p1.store.getRun(task.runId))!;
  run.agentSessions.claude!.status = 'completed';
  run.workflowState!.step = 'test';
  run.workflowState!.stepSeq += 1;
  run.workflowState!.awaitingAgentId = 'test';
  await p1.store.commit({ run });
  p1.store.close();
  const claude2 = new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }]);
  const test2 = new ScriptedAdapter(world, [], { id: 'test', kind: 'test' });
  const p2 = boot(path, [claude2, test2]);
  const report = await p2.o.recover();
  const after = await p2.store.getRun(task.runId);
  console.log('S4 report', JSON.stringify(report), 'claude resume', claude2.calls.resume, 'test start/resume', test2.calls.start, test2.calls.resume, 'status', after?.status, 'awaiting', after?.workflowState?.awaitingAgentId);
  p2.store.close();
}
