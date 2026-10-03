/**
 * Codex App Server 手動冒煙測試（TASKS.md P1.1 驗收；P0-8 起同時核對安全收緊）。
 *
 * 用法：npx tsx scripts/smoke-codex.ts
 *
 * - 複用本機 Codex 的 ChatGPT 登入，會消耗少量真實用量；
 * - 只在系統臨時目錄裡工作，使用記憶體儲存：不連線正在執行的控制台服務，也不讀寫 Agent Control Center 的資料目錄；
 * - 在臨時目錄中讓 Codex 寫一個檔案（如需審批，腳本代表操作員批准；標成高風險的請求一律拒絕）；
 * - 列印統一事件流並校驗：審批身份、工具完成、用量、檔案落盤。
 *
 * P0-8 的核對（收緊之後在真實環境裡仍然能認證、跑完一輪，並且）：
 * - thread/start 帶 approvalsReviewer=user 和執行緒配置（features.multi_agent=false、shell_environment_policy.inherit=core）後服務端照常接受；
 * - app-server 程序只拿到白名單環境：假的 SMOKE_PROBE_API_KEY 根本不會傳給它；
 * - Codex 執行的命令只繼承核心變數：傳給 app-server 的 CODEX_SMOKE_PROBE（非核心變數）在命令裡讀不到。
 * 依賴模型配合的核對（Codex 沒有執行那條命令時）只提示“未驗證”，不算失敗。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';

const workspace = mkdtempSync(join(tmpdir(), 'acc-codex-smoke-'));
// P0-8：探針（都不是真實的憑據）。前者會傳給 app-server 但不應該出現在命令裡；後者根本不應該傳給 app-server
process.env.CODEX_SMOKE_PROBE = `codex-probe-${randomUUID()}`;
process.env.SMOKE_PROBE_API_KEY = `smoke-probe-${randomUUID()}`;

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orchestrator = new Orchestrator(store, bus);
const adapter = new CodexAppServerAdapter({ defaultCwd: workspace, model: process.env.ACC_CODEX_MODEL || undefined });
orchestrator.registerAdapter(adapter);

let taskId = '';
let done = false;
const events: UnifiedEvent[] = [];
bus.subscribe(async (event) => {
  events.push(event);
  const detail = event.data.code ?? event.data.status ?? event.data.toolName ?? event.data.action ?? '';
  console.log(`#${event.sequence} ${event.type} ${detail}`);
  if (event.type === 'approval.required' && taskId) {
    // 標成高風險（涉及受保護路徑）的請求一律拒絕，其餘代表操作員批准
    const decision = event.data.risk === 'high' ? 'decline' : 'approve';
    console.log(`   -> 操作員${decision === 'approve' ? '批准' : '拒絕（高風險）'} ${String(event.data.approvalId)} ${String(event.data.toolName ?? '')}`);
    setTimeout(() => void orchestrator.resolveApproval(taskId, String(event.data.approvalId), decision), 0);
  }
  if (event.type === 'agent.status' && (event.data.status === 'completed' || event.data.status === 'failed')) done = true;
  if (event.type === 'runtime.error' || event.type === 'budget.exceeded') done = true;
});

console.log(`工作目錄：${workspace}`);
const task = await orchestrator.createTask({
  title: 'codex smoke',
  prompt: [
    'Do these steps in order:',
    '1. Create a file named hello.txt in the current directory containing exactly the text: hi',
    `2. Run this exact shell command and include its output in your reply: node -e "console.log('PROBE=' + (process.env.CODEX_SMOKE_PROBE ? 'SET' : 'UNSET') + ' KEY=' + (process.env.SMOKE_PROBE_API_KEY ? 'SET' : 'UNSET'))"`,
    '3. Reply with DONE.',
  ].join('\n'),
  agentId: 'codex',
});
taskId = task.id;

const deadline = Date.now() + 240_000;
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

const run = await store.getRun(task.runId);
const usage = await store.listUsage(task.runId);
const file = join(workspace, 'hello.txt');

// P0-8 核對：命令輸出裡的探針結果
const probeOutput = events
  .filter((e) => (e.type === 'tool.completed' || e.type === 'tool.failed') && typeof e.data.output === 'string' && String(e.data.output).includes('PROBE='))
  .map((e) => String(e.data.output));
const threadStarted = events.some((e) => e.type === 'agent.started' && e.agentId === 'codex');
const checks: Array<{ name: string; status: 'ok' | 'fail' | 'unverified'; detail?: string }> = [
  { name: 'thread/start 帶 approvalsReviewer=user 與執行緒配置後服務端照常接受', status: threadStarted ? 'ok' : 'fail' },
  { name: '命令只繼承核心變數：讀不到傳給 app-server 的 CODEX_SMOKE_PROBE', status: probeOutput.length === 0 ? 'unverified' : probeOutput.some((o) => o.includes('PROBE=UNSET')) && !probeOutput.some((o) => o.includes('PROBE=SET')) ? 'ok' : 'fail', detail: probeOutput.join(' | ').slice(0, 200) },
  { name: '環境變數白名單：命令讀不到 SMOKE_PROBE_API_KEY', status: probeOutput.length === 0 ? 'unverified' : probeOutput.some((o) => o.includes('KEY=UNSET')) && !probeOutput.some((o) => o.includes('KEY=SET')) ? 'ok' : 'fail' },
];

console.log('\n結果：');
console.log(`  任務狀態      ${run?.status} / agent ${run?.agentSessions.codex?.status}`);
console.log(`  原生 session  ${run?.agentSessions.codex?.providerSessionId}`);
console.log(`  已完成副作用  ${run?.completedSideEffects.map((x) => x.name).join(', ') || '(無)'}`);
console.log(`  用量記錄      ${usage.map((u) => `${u.inputTokens}/${u.outputTokens}`).join(', ') || '(無)'}`);
console.log(`  hello.txt     ${existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '(不存在)'}`);
console.log('\nP0-8 核對：');
for (const check of checks) console.log(`  [${check.status === 'ok' ? '通過' : check.status === 'fail' ? '失敗' : '未驗證'}] ${check.name}${check.detail ? `（${check.detail}）` : ''}`);
const ok = done && existsSync(file) && usage.length > 0 && checks.every((check) => check.status !== 'fail');
console.log(ok ? '\n✓ 冒煙測試通過' : '\n✗ 冒煙測試未通過');
adapter.dispose();
process.exit(ok ? 0 : 1);
