/**
 * 端到端冒煙測試（P2.1 驗收）：真實 Claude + 真實 Codex + 本地測試執行器，由 implementation-v1 工作流驅動。
 *
 * 用法：npx tsx scripts/smoke-workflow.ts
 *
 * 在臨時目錄放一個有 bug 的 add.js 和測試腳本，任務交給工作流：
 * 實現 → 執行測試 →（失敗則重試 / Codex 診斷 / 修復）→ 完成。腳本代表操作員批准所有審批。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter, LocalTestRunnerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, isTerminal } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';

const workspace = mkdtempSync(join(tmpdir(), 'acc-workflow-smoke-'));
writeFileSync(join(workspace, 'add.js'), 'module.exports = function add(a, b) {\n  return a - b;\n};\n');
writeFileSync(
  join(workspace, 'test.js'),
  "const add = require('./add');\nif (add(2, 3) !== 5) { console.error('FAIL: add(2, 3) = ' + add(2, 3)); process.exit(1); }\nconsole.log('PASS');\n",
);

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orchestrator = new Orchestrator(store, bus);
const codex = new CodexAppServerAdapter({ defaultCwd: workspace });
orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ defaultCwd: workspace }));
orchestrator.registerAdapter(codex);
orchestrator.registerAdapter(new LocalTestRunnerAdapter({ defaultCwd: workspace, timeoutMs: 60_000 }));

let taskId = '';
bus.subscribe(async (event) => {
  const detail = event.data.step ?? event.data.code ?? event.data.toolName ?? event.data.status ?? '';
  if (!['agent.message', 'model.turn.started'].includes(event.type)) console.log(`#${event.sequence} ${event.agentId ?? '-'} ${event.type} ${detail}`);
  if (event.type === 'approval.required' && taskId) {
    setTimeout(() => void orchestrator.resolveApproval(taskId, String(event.data.approvalId), 'approve').catch(() => undefined), 0);
  }
});

console.log(`工作目錄：${workspace}`);
const task = await orchestrator.createTask({
  title: 'Fix add()',
  prompt: 'add.js returns the wrong result. Fix the add function so that `node test.js` passes. Do not modify test.js.',
  agentId: 'claude',
  testCommand: 'node test.js',
  cwd: workspace,
});
taskId = task.id;

const deadline = Date.now() + 6 * 60_000;
let run = await store.getRun(task.runId);
while (run && !isTerminal(run.status) && run.status !== 'BLOCKED' && run.status !== 'WAITING_INPUT' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  run = await store.getRun(task.runId);
}

console.log('\n結果：');
console.log(`  任務狀態  ${run?.status}（步驟 ${run?.currentStep}）`);
console.log(`  工作流    ${run?.workflowState?.history.map((x) => `${x.step}:${x.outcome}`).join(' → ')}`);
console.log(`  add.js    ${JSON.stringify(readFileSync(join(workspace, 'add.js'), 'utf8'))}`);
console.log(`  呼叫次數  ${run?.budget.agentCallsUsed}，用量記錄 ${(await store.listUsage(task.runId)).length} 條`);
codex.dispose();
const ok = run?.status === 'COMPLETED' && run.workflowState?.lastTest?.passed === true;
console.log(ok ? '\n✓ 端到端冒煙測試通過' : '\n✗ 端到端冒煙測試未通過');
process.exit(ok ? 0 : 1);
