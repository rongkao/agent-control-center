/**
 * 程序級兜底（P0-2 / H-2）。
 *
 * Node 15 起，未處理的 Promise 拒絕預設會讓整個程序以 exit 1 退出——一個 run 裡的 bug 會帶崩所有任務。
 * 正常路徑上的異常應當在各自的位置被轉成 runtime.error（編排反應佇列、adapter 的 safeEmit 等）；
 * 這裡是最後一道防線：只記錄日誌，不退出程序。
 *
 * 返回解除安裝函式（例如 Electron 主程序或測試裡需要撤銷時）。
 */
export type ProcessGuardLog = (message: string, error: unknown) => void;

export function installUnhandledRejectionGuard(log: ProcessGuardLog, target: NodeJS.EventEmitter = process): () => void {
  const handler = (reason: unknown) => {
    try {
      log('unhandled promise rejection (process kept alive)', reason);
    } catch {
      // 日誌失敗也不能讓程序退出
    }
  };
  target.on('unhandledRejection', handler);
  return () => {
    target.off('unhandledRejection', handler);
  };
}
