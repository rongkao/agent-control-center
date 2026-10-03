/** 可由測試顯式放行的 Promise：替代 sleep，讓非同步時序由測試確定性地控制。 */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (error) => {
      settled = true;
      rej(error);
    };
  });
  // 避免測試未等待時產生未處理拒絕
  promise.catch(() => undefined);
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

/**
 * 記錄測試期間產生的未處理 Promise 拒絕（H-2：Node 24 預設會因此退出程序）。
 * 用完必須 dispose，恢復原有監聽。
 */
export function captureUnhandledRejections(): { reasons: unknown[]; dispose(): void } {
  const reasons: unknown[] = [];
  const handler = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', handler);
  return { reasons, dispose: () => process.off('unhandledRejection', handler) };
}

/**
 * 讓出若干輪事件迴圈（setImmediate），使已經排隊的 I/O 回呼和未處理拒絕檢測有機會執行。
 * 這不是按時間等待：只推進事件迴圈，不依賴機器快慢。
 */
export async function turnEventLoop(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
