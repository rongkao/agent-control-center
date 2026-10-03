/**
 * 桌面版的服務端程序（在 Electron 的 utilityProcess 裡執行，使用 Electron 內建的 Node 24）。
 *
 * 和命令列入口（apps/server/src/index.ts）做同樣的事：啟動服務、優雅關閉、把錯誤說清楚；
 * 不同的是不開瀏覽器，而是把帶令牌的訪問連結交給主程序，由主程序的視窗載入。
 * 與主程序之間的訊息：
 *   子 → 主：{ type: 'ready', accessUrl, url, workspace, dataDir, warnings } / { type: 'failed', message, code } / { type: 'fatal', message }
 *   主 → 子：{ type: 'shutdown' }
 */
import { startServer, type RunningServer } from '@acc/server';

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parent = (process as unknown as { parentPort?: ParentPort }).parentPort;
const post = (message: Record<string, unknown>) => parent?.postMessage(message);

let server: RunningServer | undefined;
let shuttingDown = false;

/** 優雅關閉：停止全部 agent 執行時、關閉資料庫、釋放單實例鎖，然後退出。 */
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  // 兜底：關閉卡住時 10 秒後強制退出
  setTimeout(() => process.exit(code), 10_000).unref();
  void (server?.close() ?? Promise.resolve()).finally(() => process.exit(code));
}

/** 啟動失敗的說明：已知錯誤只給中文原因，未知錯誤附上堆疊。 */
function describeFailure(error: unknown): { message: string; code?: string } {
  const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : undefined;
  if (code?.startsWith('ACC_')) return { message: (error as Error).message, code };
  return { message: (error as Error)?.stack ?? String(error), code };
}

const webRoot = process.env.ACC_DESKTOP_WEB_ROOT || undefined;
const preferredPort = Number(process.env.ACC_PORT ?? 8788);

async function start(port: number): Promise<RunningServer> {
  return startServer({
    port,
    webRoot,
    onShutdownRequest: () => shutdown(0),
    onFatal: (error) => {
      post({ type: 'fatal', message: error.message });
      process.exitCode = 1;
      setImmediate(() => void (server?.closed ?? Promise.resolve()).finally(() => process.exit(1)));
    },
  });
}

parent?.on('message', (event) => {
  if ((event.data as { type?: unknown } | undefined)?.type === 'shutdown') shutdown(0);
});

try {
  try {
    server = await start(preferredPort);
  } catch (error) {
    // 預設的埠被別的程式佔用：改用系統分配的空閒埠（桌面版不需要固定的埠）
    if ((error as { code?: unknown }).code !== 'ACC_PORT_IN_USE' || process.env.ACC_PORT) throw error;
    server = await start(0);
  }
  post({ type: 'ready', accessUrl: server.accessUrl, url: server.url, workspace: server.workspace, dataDir: server.paths.dataDir, warnings: server.warnings ?? [] });
} catch (error) {
  post({ type: 'failed', ...describeFailure(error) });
  setTimeout(() => process.exit(1), 200);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown(0));
