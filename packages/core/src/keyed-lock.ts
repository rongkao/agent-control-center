/**
 * 按 key（runId）序列化的非同步鎖。
 *
 * 用於保證同一個 run 的“讀取快照 → 投影 → 原子提交”不會交錯執行。
 * 注意：不可重入。持有鎖期間禁止 publish 事件或呼叫 adapter（它們會回呼事件處理器再次加鎖）。
 */
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
