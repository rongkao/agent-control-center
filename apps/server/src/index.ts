import { openBrowser, shouldOpenBrowser, startServer } from './server.js';
import type { RunningServer } from './server.js';

/**
 * 命令列入口：只負責啟動、關閉和把錯誤說清楚。
 * 啟動邏輯在 server.ts（startServer），測試和以後的桌面外殼直接呼叫它。
 *
 * 引數：--dev 表示開發模式（npm run dev）：放行 Vite 開發伺服器的 Origin，不自動開啟瀏覽器（--watch 會反覆重啟）。
 * 非開發模式（npm start / npm run start:real）啟動後自動用系統瀏覽器開啟帶令牌的訪問連結；ACC_NO_OPEN=1 可關閉。
 */

const dev = process.argv.slice(2).includes('--dev');
let server: RunningServer | undefined;
let shuttingDown = false;

/** 優雅關閉：停止全部 agent 執行時、關閉資料庫、釋放單實例鎖，然後退出。重複呼叫只執行一次。 */
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write('\n正在關閉 Agent Control Center……\n');
  // 兜底：關閉卡住時 10 秒後強制退出，不留下掛著的程序
  setTimeout(() => process.exit(code), 10_000).unref();
  void (server?.close() ?? Promise.resolve()).finally(() => process.exit(code));
}

/** 啟動失敗的說明：已知錯誤只給中文原因，未知錯誤附上堆疊便於排查。 */
function describeFailure(error: unknown): string {
  const known = typeof (error as { code?: unknown })?.code === 'string' && String((error as { code: string }).code).startsWith('ACC_');
  if (known) return `Agent Control Center 啟動失敗：\n${(error as Error).message}`;
  return `Agent Control Center 啟動失敗：\n${(error as Error)?.stack ?? String(error)}`;
}

try {
  server = await startServer({
    dev,
    // 租約丟失等致命錯誤：服務會自行關閉；等關閉完成後以非零碼退出
    // 介面或桌面外殼呼叫 POST /api/shutdown
    onShutdownRequest: () => shutdown(0),
    onFatal: (error) => {
      process.stderr.write(`\n${error.message}\n`);
      process.exitCode = 1;
      setImmediate(() => {
        void (server?.closed ?? Promise.resolve()).finally(() => process.exit(1));
      });
    },
  });
} catch (error) {
  process.stderr.write(`\n${describeFailure(error)}\n\n`);
  process.exit(1);
}

// 使用者是非技術人員：自動開啟帶令牌的訪問連結，不需要自己去終端裡複製
if (server && shouldOpenBrowser({ env: process.env, dev })) {
  process.stdout.write('正在用預設瀏覽器開啟控制台……（不想自動開啟可以設定 ACC_NO_OPEN=1）\n');
  openBrowser(server.accessUrl, {
    onError: () => process.stdout.write('沒能自動開啟瀏覽器，請複製上面的“訪問連結”到瀏覽器位址列開啟。\n'),
  });
}

// Ctrl+C、Ctrl+Break（Windows）、關閉終端視窗或被要求終止：優雅關閉（停止 agent 執行時、關閉資料庫、釋放單實例鎖）
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.once(signal, () => shutdown(0));
}
