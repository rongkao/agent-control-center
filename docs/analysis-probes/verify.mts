// 唯讀驗證腳本：在臨時資料庫上覆現審計中的幾個恢復/持久化場景（不修改專案檔案）
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

// S1：終態 run 重啟後 setHandoffPolicy → 序號衝突；快照已被改寫但沒有事件
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

// S2：手動任務兩個 agent，cancel 只停 currentAgentId；另一個 agent 的審批在 CANCELLED 後仍可批准並執行
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

// S3：第二個程序開啟同一個庫並 recover，而第一個程序仍在執行 → 序號衝突
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

// S4：工作流已推進到 test（awaiting=test）但派發前崩潰；恢復時續接的是 currentAgentId（claude）而不是 test
{
  const path = db();
  const world = new FakeWorld();
  const claude1 = new ScriptedAdapter(world, [{ kind: 'tool', id: 'A' }]);
  const test1 = new ScriptedAdapter(world, [], { id: 'test', kind: 'test' });
  const p1 = boot(path, [claude1, test1]);
  const task = await p1.o.createTask({ title: 'x', prompt: 'y', agentId: 'claude', testCommand: 'npm test' });
  // 模擬：claude 完成訊號已持久化、工作流決策已提交，但 executeDirective 之前程序崩潰
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
