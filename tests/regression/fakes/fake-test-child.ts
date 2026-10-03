import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

/**
 * 測試執行器用的假子程序（P0-6）：不啟動任何真實程序，由測試決定它什麼時候輸出、什麼時候以什麼退出碼結束。
 * 沒有 pid，所以取消時 adapter 不會去結束任何真實的程序樹。
 */
export class FakeTestChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;

  constructor(readonly command: string) {
    super();
  }

  /** 程序結束（close 事件）。 */
  finish(code: number | null, output = ''): void {
    if (output) this.stdout.write(output);
    this.emit('close', code);
  }

  kill(): boolean {
    this.finish(null);
    return true;
  }
}

/** 注入給 LocalTestRunnerAdapter 的 spawn：記錄每次啟動的假子程序。 */
export function fakeSpawner(): { spawn: (command: string) => ChildProcess; children: FakeTestChild[]; next(n: number): Promise<FakeTestChild> } {
  const children: FakeTestChild[] = [];
  const waiters: Array<{ n: number; resolve: (child: FakeTestChild) => void }> = [];
  return {
    children,
    spawn: (command: string) => {
      const child = new FakeTestChild(command);
      children.push(child);
      for (const waiter of waiters.filter((x) => x.n === children.length)) waiter.resolve(child);
      return child as unknown as ChildProcess;
    },
    next: (n: number) => {
      const existing = children[n - 1];
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ n, resolve }));
    },
  };
}
