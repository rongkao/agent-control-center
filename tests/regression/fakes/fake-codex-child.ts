import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { CodexTransport } from '@acc/adapters';

/**
 * 假的 `codex app-server` 子程序：真實的 Node 流（stdin 為 Writable，stdout/stderr 為 PassThrough），
 * 用來驗證 codex-rpc 對管道錯誤和背壓的處理（H-14）。
 *
 * 可選地橋接到一個行傳輸（例如 FakeCodexServer.transport）：stdin 寫入的行轉給它，它發出的行寫回 stdout。
 */
export class FakeCodexChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly pid = 4242;
  /** 被結束的次數。 */
  kills = 0;
  /** 設定後，下一次寫入由流非同步報錯（模擬子程序已關閉 stdin：write EOF / EPIPE）。 */
  failNextWrite?: Error;
  /** true 時 stdin 不再消費資料（模擬子程序不讀 stdin），寫入會堆積在緩衝裡。 */
  stuck = false;
  /** stdin 收到的完整行。 */
  readonly written: string[] = [];

  constructor(options: { server?: CodexTransport; highWaterMark?: number } = {}) {
    super();
    let pending = '';
    this.stdin = new Writable({
      highWaterMark: options.highWaterMark,
      write: (chunk: Buffer, _encoding, callback) => {
        if (this.failNextWrite) {
          const error = this.failNextWrite;
          this.failNextWrite = undefined;
          // 與真實管道一致：錯誤不是同步丟擲，而是之後以 'error' 事件出現
          callback(error);
          return;
        }
        if (this.stuck) return; // 永不回呼：後續寫入全部留在緩衝裡
        pending += chunk.toString();
        let index = pending.indexOf('\n');
        while (index >= 0) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          this.written.push(line);
          options.server?.write(line);
          index = pending.indexOf('\n');
        }
        callback();
      },
    });
    options.server?.onLine((line) => this.stdout.write(`${line}\n`));
    options.server?.onClose(() => this.emit('exit', 1, null));
  }

  kill(): boolean {
    this.kills += 1;
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}
