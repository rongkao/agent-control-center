// 子程序夾具（由 tests/regression/process-guard.test.ts 用 `node --import tsx` 啟動）：
// 故意製造一個未處理的 Promise 拒絕，驗證服務端的全域性兜底只記錄日誌、不讓程序退出。
// 傳入 --no-guard 時不安裝兜底，用來證明當前 Node 版本下這種拒絕確實會讓程序退出。
import { installUnhandledRejectionGuard } from '../../../apps/server/src/process-guards.ts';

if (!process.argv.includes('--no-guard')) {
  installUnhandledRejectionGuard((message, error) => {
    process.stdout.write(`LOGGED ${message}: ${error instanceof Error ? error.message : String(error)}\n`);
    // 記錄之後程序繼續執行：再跑一輪事件迴圈證明它還活著
    setImmediate(() => process.stdout.write('ALIVE\n'));
  });
}

void Promise.reject(new Error('p0-2 deliberate rejection'));
