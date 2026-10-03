import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex 協議漂移檢查（npm run check:codex-protocol，P1-11 / L-28）。
 *
 * codex-protocol.ts 裡的型別是按 codex-cli 0.156.1 的 `codex app-server generate-ts` 手工摘錄的；Codex 會自動升級，
 * 上游改了方法名或欄位名時手抄的型別發現不了。這個腳本用本機的 codex 重新生成型別（放在系統臨時目錄），
 * 檢查 adapter 實際用到的每一個方法、通知和欄位是否仍然存在。缺了任何一個就以非零碼退出。
 */

const bin = process.env.ACC_CODEX_BIN || 'codex';
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-codex-ts-'));

// adapter 用到的方法、通知、服務端請求和欄位（改 adapter 時同步維護這張表）
const REQUIRED = [
  // 客戶端請求
  '"initialize"', '"thread/start"', '"thread/resume"', '"turn/start"', '"turn/steer"', '"turn/interrupt"',
  // 通知
  '"turn/started"', '"turn/completed"', '"item/started"', '"item/completed"', '"item/agentMessage/delta"',
  '"thread/tokenUsage/updated"', '"thread/status/changed"', '"serverRequest/resolved"',
  // 服務端請求（審批）
  '"item/commandExecution/requestApproval"', '"item/fileChange/requestApproval"', '"item/permissions/requestApproval"',
  // 服務端請求（提問，P2-6）
  '"item/tool/requestUserInput"', 'isOther', 'isSecret',
  // Windows 沙箱（P2-8）
  '"windowsSandbox/readiness"', '"windowsSandbox/setupStart"', '"windowsSandbox/setupCompleted"',
  // 欄位
  'approvalsReviewer', 'developerInstructions', 'expectedTurnId', 'sandboxPolicy', 'approvalPolicy',
  'cachedInputTokens', 'reasoningOutputTokens', 'totalTokens',
];

try {
  const quoted = bin.includes(' ') && !bin.startsWith('"') ? `"${bin}"` : bin;
  const version = spawnSync(`${quoted} --version`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const gen = spawnSync(`${quoted} app-server generate-ts --out "${out}"`, { shell: true, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  if (gen.status !== 0) {
    console.error(`無法產生 Codex 協議型別（codex 沒有安裝，或版本太舊不支援 generate-ts）：\n${gen.stderr || gen.stdout}`);
    process.exit(2);
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(out);
  const all = files.join('\n');
  const missing = REQUIRED.filter((name) => !all.includes(name));
  console.log(`Codex ${String(version.stdout).trim()}：產生了 ${files.length} 個型別檔案，檢查 ${REQUIRED.length} 個名稱。`);
  if (missing.length) {
    console.error(`協議有變化，adapter 用到的這些名稱在新版本裡找不到：\n  ${missing.join('\n  ')}\n請對照新生成的型別更新 packages/adapters/src/codex-protocol.ts 與 adapter。`);
    process.exitCode = 1;
  } else {
    console.log('adapter 用到的方法、通知與欄位都還在。');
  }
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
