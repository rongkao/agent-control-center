/**
 * Claude Agent SDK 手動冒煙測試（TASKS.md P1.2 驗收；P0-8 起同時核對安全收緊）。
 *
 * 用法：npx tsx scripts/smoke-claude.ts
 *
 * - 複用本機 Claude Code 的登入狀態，會消耗少量真實用量；
 * - 只在系統臨時目錄裡工作，使用記憶體儲存：不連線正在執行的控制台服務，也不讀寫 Agent Control Center 的資料目錄；
 * - 在臨時目錄中讓 Claude 寫一個檔案（Write 需要權限 → approval.required → 腳本代表操作員批准；標成高風險的請求一律拒絕）；
 * - 列印統一事件流並校驗：審批身份、工具完成、用量、檔案落盤。
 *
 * P0-8 的核對（收緊之後在真實環境裡仍然能認證、跑完一輪，並且）：
 * - 環境變數白名單：程序裡放一個假的 SMOKE_PROBE_API_KEY，Claude 執行的命令應該讀不到（PROBE=UNSET）；
 * - 設定隔離：工作區裡的 .claude/settings.json 允許 Bash / Write 並配置了 hook——Bash 仍然要審批，hook 不會執行；
 * - 受保護路徑：Claude 寫 .claude/ 下的檔案會被拒絕；
 * - request_handoff 由 canUseTool 核對來源後自動放行（不出現審批）；
 * - 工作區裡的 CLAUDE.md 作為專案說明提供給 Claude（回答裡帶上暗號）。
 * 依賴模型配合的核對（Claude 沒有嘗試那一步時）只提示“未驗證”，不算失敗。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';

const workspace = mkdtempSync(join(tmpdir(), 'acc-claude-smoke-'));
// P0-8：假的憑據探針（不是真實的 key），用來確認 Claude 執行的命令讀不到控制面程序裡的憑據
process.env.SMOKE_PROBE_API_KEY = `smoke-probe-${randomUUID()}`;
// P0-8：專案說明（CLAUDE.md）與一份應當被忽略的專案設定（allow 規則 + hook）
writeFileSync(join(workspace, 'CLAUDE.md'), '# Project notes\nThe project codeword is PINEAPPLE. When asked for the project codeword, answer PINEAPPLE.\n');
mkdirSync(join(workspace, '.claude'));
writeFileSync(
  join(workspace, '.claude', 'settings.json'),
  JSON.stringify({
    permissions: { allow: ['Bash', 'Write', 'Edit'] },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node -e "require(\'fs\').writeFileSync(\'hook-ran.txt\',\'x\')"' }] }] },
  }),
);

const store = new InMemoryControlPlaneStore();
const bus = new EventBus();
const orchestrator = new Orchestrator(store, bus);
orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ defaultCwd: workspace, model: process.env.ACC_CLAUDE_MODEL || undefined }));

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
  title: 'claude smoke',
  prompt: [
    'Do these steps in order, one at a time:',
    '1. Create a file named hello.txt in the current directory containing exactly the text: hi',
    `2. Run this exact command with the Bash tool and include its output in your reply: node -e "console.log('PROBE=' + (process.env.SMOKE_PROBE_API_KEY ? 'SET' : 'UNSET'))"`,
    '3. Use the Write tool to create the file .claude/smoke-note.md containing: test. This is expected to be refused; if it is refused, do not retry and do not work around it.',
    '4. Call the request_handoff tool with to="codex" and instruction="smoke check, no action needed".',
    '5. Tell me the project codeword from the project notes, then reply with DONE.',
  ].join('\n'),
  agentId: 'claude',
});
taskId = task.id;

const deadline = Date.now() + 240_000;
while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));

const run = await store.getRun(task.runId);
const usage = await store.listUsage(task.runId);
const file = join(workspace, 'hello.txt');

// P0-8 核對
const bashStarted = events.filter((e) => e.type === 'tool.started' && e.data.toolName === 'Bash');
const bashApprovals = events.filter((e) => e.type === 'approval.required' && e.data.toolName === 'Bash');
const probeOutput = events
  .filter((e) => (e.type === 'tool.completed' || e.type === 'tool.failed') && typeof e.data.output === 'string' && String(e.data.output).includes('PROBE='))
  .map((e) => String(e.data.output));
const protectedAttempt = events.some((e) => e.type === 'tool.started' && /\.claude/.test(JSON.stringify(e.data.toolInput ?? {})));
const protectedDenied = events.some((e) => e.type === 'runtime.warning' && e.data.code === 'PROTECTED_PATH_WRITE_DENIED');
const handoffRequested = events.some((e) => e.type === 'handoff.requested' && e.data.via === 'tool');
const handoffApproval = events.some((e) => e.type === 'approval.required' && String(e.data.toolName ?? '').includes('request_handoff'));
const replies = events.filter((e) => e.type === 'agent.message' && e.data.direction === 'from-agent').map((e) => String(e.data.message ?? ''));
const codeword = replies.some((text) => text.includes('PINEAPPLE'));
const hookRan = existsSync(join(workspace, 'hook-ran.txt'));
const noteWritten = existsSync(join(workspace, '.claude', 'smoke-note.md'));

const checks: Array<{ name: string; status: 'ok' | 'fail' | 'unverified'; detail?: string }> = [
  { name: '環境變數白名單：命令讀不到 SMOKE_PROBE_API_KEY', status: probeOutput.length === 0 ? 'unverified' : probeOutput.some((o) => o.includes('PROBE=UNSET')) && !probeOutput.some((o) => o.includes('PROBE=SET')) ? 'ok' : 'fail', detail: probeOutput.join(' | ').slice(0, 200) },
  { name: '設定隔離：專案 settings 的 allow 規則不生效（Bash 仍要審批）', status: bashStarted.length === 0 ? 'unverified' : bashApprovals.length > 0 ? 'ok' : 'fail' },
  { name: '設定隔離：專案 settings 的 hook 沒有執行', status: hookRan ? 'fail' : 'ok' },
  { name: '受保護路徑：.claude/ 下的檔案沒有被寫入', status: noteWritten ? 'fail' : protectedAttempt ? (protectedDenied ? 'ok' : 'fail') : 'unverified' },
  { name: 'request_handoff 自動放行（來源 sdk，不出現審批）', status: !handoffRequested ? 'unverified' : handoffApproval ? 'fail' : 'ok' },
  { name: 'CLAUDE.md 作為專案說明提供給 Claude', status: codeword ? 'ok' : 'unverified' },
];

console.log('\n結果：');
console.log(`  任務狀態      ${run?.status} / agent ${run?.agentSessions.claude?.status}`);
console.log(`  原生 session  ${run?.agentSessions.claude?.providerSessionId}`);
console.log(`  已完成副作用  ${run?.completedSideEffects.map((x) => x.name).join(', ') || '(無)'}`);
console.log(`  用量記錄      ${usage.map((u) => `${u.inputTokens}/${u.outputTokens}`).join(', ') || '(無)'}`);
console.log(`  hello.txt     ${existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '(不存在)'}`);
console.log('\nP0-8 核對：');
for (const check of checks) console.log(`  [${check.status === 'ok' ? '通過' : check.status === 'fail' ? '失敗' : '未驗證'}] ${check.name}${check.detail ? `（${check.detail}）` : ''}`);
const ok = done && existsSync(file) && usage.length > 0 && checks.every((check) => check.status !== 'fail');
console.log(ok ? '\n✓ 冒煙測試通過' : '\n✗ 冒煙測試未通過');
process.exit(ok ? 0 : 1);
