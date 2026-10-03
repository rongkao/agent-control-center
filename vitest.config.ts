import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // 整合測試會真實啟動服務、子程序和 SQLite：整套並行跑、機器繁忙（尤其是 Windows 上有安全軟體掃描）時 5 秒的預設時限太緊
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // 用到 git 的測試使用隔離的空配置（P1-11 / L-30）
    setupFiles: ['tests/setup/isolate-git.ts'],
    // 測試裡任何啟動服務的路徑都不能彈出瀏覽器（P0-1：非開發模式預設自動開啟訪問連結）；
    // Claude adapter 會唯讀轉交使用者級 settings.json（P0 第三批審查）：測試指向一個不存在的目錄，不讀本機真實的 ~/.claude/settings.json
    env: { ACC_NO_OPEN: '1', CLAUDE_CONFIG_DIR: join(tmpdir(), 'acc-tests-no-claude-config') }
  }
});
