import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, createChildProcessTransport } from '@acc/adapters';
import type { EventSink } from '@acc/core';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { captureUnhandledRejections, deferred, turnEventLoop } from './fakes/deferred.js';
import { FakeCodexChild } from './fakes/fake-codex-child.js';

/**
 * P0-2（H-14）：codex app-server 子程序的 stdin/stdout/stderr 一建立就掛 error 監聽，
 * 管道非同步報錯統一轉成傳輸關閉（CODEX_TRANSPORT_CLOSED），程序存活；寫入處理背壓，緩衝超過上限就斷開。
 */

type Emitted = Parameters<EventSink>[0];
const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

describe('codex 子程序傳輸：管道錯誤與背壓', () => {
  it('stdin 非同步報錯（write EOF）→ CODEX_TRANSPORT_CLOSED，程序存活，子程序被結束', async () => {
    const unhandled = captureUnhandledRejections();
    try {
      const server = new FakeCodexServer(new FakeCodexDisk(), () => [{ kind: 'message', text: 'ok' }]);
      const child = new FakeCodexChild({ server: server.transport });
      const adapter = new CodexAppServerAdapter({ transportFactory: () => createChildProcessTransport(child), log: () => undefined });
      const events: Emitted[] = [];
      const turnDone = deferred();
      const closed = deferred();
      const sink: EventSink = (event) => {
        events.push(event);
        if (event.type === 'agent.status' && event.data.status === 'completed') turnDone.resolve();
        if (event.type === 'runtime.error' && event.data.sessionClosed === true) closed.resolve();
      };
      const handle = await adapter.start({ ...ids, prompt: 'hi' }, sink);
      await turnDone.promise;

      // 子程序這時已經關閉了 stdin（但程序還沒退出）：下一次寫入由流非同步報錯
      child.failNextWrite = Object.assign(new Error('write EOF'), { code: 'EOF' });
      // P0-6：這次派發沒有送達——send 以“會話已關閉”報錯（編排器據此改走續接），不會再為它補一個 failed 終態
      await expect(adapter.send(handle.sessionId, 'more', sink)).rejects.toMatchObject({ code: 'ADAPTER_SESSION_CLOSED', message: expect.stringMatching(/stdin/) });
      await closed.promise;
      expect(events.some((x) => x.type === 'agent.status' && x.data.status === 'failed')).toBe(false);

      expect(events.find((x) => x.type === 'runtime.error')?.data).toMatchObject({ code: 'CODEX_TRANSPORT_CLOSED', retryable: true });
      expect(String(events.find((x) => x.type === 'runtime.error')?.data.message)).toMatch(/stdin error: write EOF/);
      expect(child.kills).toBe(1);
      await turnEventLoop();
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.dispose();
    }
  });

  it('stdout / stderr 報錯同樣轉成傳輸關閉，而不是未捕獲異常', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = new FakeCodexChild();
      const transport = createChildProcessTransport(child);
      const closed = deferred<string>();
      transport.onClose((reason) => closed.resolve(reason));
      child[stream].destroy(new Error('read ECONNRESET'));
      expect(await closed.promise).toMatch(new RegExp(`${stream} error: read ECONNRESET`));
      expect(() => transport.write('{}')).toThrow(/closed/);
    }
  });

  it('子程序不讀 stdin：寫緩衝超過上限就斷開，不會無限佔用記憶體', () => {
    const child = new FakeCodexChild({ highWaterMark: 16 });
    child.stuck = true;
    const transport = createChildProcessTransport(child, { maxBufferedBytes: 64 });
    const reasons: string[] = [];
    transport.onClose((reason) => reasons.push(reason));

    transport.write('x'.repeat(40)); // 41 位元組：超過 highWaterMark，但仍在上限內
    expect(reasons).toEqual([]);
    transport.write('y'.repeat(40)); // 累計 82 位元組 > 64：斷開
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/backpressure/);
    expect(child.kills).toBe(1);
    expect(() => transport.write('z')).toThrow(/closed/);
  });
});
