import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 環境自檢（npm run doctor，P1-16）：Node 版本、依賴、關鍵檔案、Claude / Codex 的登入與版本。
 * 只檢查檔案或環境變數是否存在，不讀取、不列印任何憑據內容。發現問題時退出碼為 1。
 */

// 用 fileURLToPath 得到本機路徑：Windows 上 URL 的 pathname 是 /D:/… 這樣的形式，直接用會把所有檔案都判成“缺失”（L-25）
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let problems = 0;
const ok = (text) => console.log(`  ✓ ${text}`);
const bad = (text) => {
  problems += 1;
  console.log(`  ✗ ${text}`);
};
const info = (text) => console.log(`  · ${text}`);

console.log('Agent Control Center 環境自檢\n');

console.log('Node.js');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 24) ok(`版本 ${process.version}`);
else bad(`版本 ${process.version}：需要 Node 24 或更新版本（用到了內建的 node:sqlite）。請到 https://nodejs.org 安裝。`);

console.log('\n專案檔案');
const required = [
  'package.json',
  'packages/core/src/orchestrator.ts',
  'packages/adapters/src/claude-agent-sdk-adapter.ts',
  'packages/adapters/src/codex-app-server-adapter.ts',
  'apps/server/src/index.ts',
  'apps/web/src/main.tsx',
];
const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length === 0) ok('關鍵檔案都在');
else for (const file of missing) bad(`缺少 ${file}`);
if (fs.existsSync(path.join(root, 'node_modules'))) ok('依賴已安裝');
else bad('依賴還沒安裝：請在專案目錄執行 npm install');

console.log('\nClaude');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const claudeLogin =
  fs.existsSync(path.join(claudeDir, '.credentials.json')) ||
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some((n) => process.env[n]) ||
  process.platform === 'darwin';
if (claudeLogin) ok('找到登入資訊');
else bad('沒有找到 Claude 的登入資訊：請在終端機執行一次 claude 並完成登入（或設定 ANTHROPIC_API_KEY）');

console.log('\nCodex（可選：只用 Claude 的話可以忽略）');
const codexBin = process.env.ACC_CODEX_BIN || 'codex';
const version = spawnSync(`${codexBin.includes(' ') ? `"${codexBin}"` : codexBin} --version`, { shell: true, encoding: 'utf8', timeout: 15_000, windowsHide: true });
const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${version.stdout ?? ''}`);
if (!match) {
  info('沒有找到 codex 命令：需要用 Codex 的話請執行 npm install -g @openai/codex');
} else {
  if (`${match[1]}.${match[2]}` === '0.156') ok(`版本 ${match[0]}`);
  else info(`版本 ${match[0]}（測試過的是 0.156.x；大多數情況下仍能用）`);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (fs.existsSync(path.join(codexHome, 'auth.json')) || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) ok('找到登入資訊');
  else bad('沒有找到 Codex 的登入資訊：請執行 codex login');
}

console.log('\n設定檔');
if (fs.existsSync(path.join(root, '.env'))) ok('找到 .env（啟動時會自動讀取）');
else info('沒有 .env：使用預設設定。需要改設定時，把 .env.example 複製成 .env 再修改');

console.log(problems === 0 ? '\n一切正常。執行 npm run start:real 啟動（會自動開啟瀏覽器）。' : `\n發現 ${problems} 個問題，請按上面的提示處理。`);
if (problems) process.exitCode = 1;
