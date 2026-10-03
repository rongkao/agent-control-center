import { describe, expect, it } from 'vitest';
import { EventBus } from '@acc/core';
import type { UnifiedEvent } from '@acc/core';
import { deferred, turnEventLoop } from './fakes/deferred.js';

/**
 * P0-2 審查：drain()/idle() 必須看得到“正在落盤或正在通知觀察者、還沒排進反應佇列”的事件。
 *
 * 現象（修復前）：publish 先 await 持久化、再逐個 await 觀察者，最後才把反應排進佇列；
 * 這期間呼叫 drain()，如果佇列裡恰好沒有更早的反應，drain 直接返回——反應還沒執行，
 * 用它代替 sleep 的斷言就依賴時序，也不能用於“等所有已釋出事件的反應都處理完”的優雅關閉。
 *
 * 期望：publish 一開始（分配序號時）就登記為進行中，drain 同時等待進行中的 publish；持久化失敗時撤銷登記。
 */

const quiet = () => undefined;

type PublishInput = Parameters<EventBus['publish']>[0];
const input = (runId: string): PublishInput => ({
  projectId: 'local',
  taskId: `task-${runId}`,
  runId,
  type: 'agent.message',
  severity: 'info',
  confidence: 'confirmed',
  data: { message: 'hi' },
});

describe('EventBus.drain 覆蓋進行中的 publish', () => {
  it('觀察者得知事件已落盤後立刻 drain：該事件的反應在 drain 返回前已經執行', async () => {
    const bus = new EventBus({ log: quiet });
    const reacted: number[] = [];
    bus.subscribe(() => undefined, { phase: 'persist' });
    const observed = new Promise<UnifiedEvent>((resolve) => bus.subscribe((event) => resolve(event)));
    bus.subscribe((event) => void reacted.push(event.sequence), { phase: 'post' });

    void bus.publish(input('run-1'));
    await observed;
    await bus.drain();
    expect(reacted).toEqual([1]);
  });

  it('持久化還沒完成時 drain 不會提前返回；按 run 過濾時同樣等待', async () => {
    const bus = new EventBus({ log: quiet });
    const gate = deferred();
    const reacted: string[] = [];
    bus.subscribe(async () => gate.promise, { phase: 'persist' });
    bus.subscribe((event) => void reacted.push(event.runId), { phase: 'post' });

    const published = bus.publish(input('run-1'));
    let drained = false;
    const all = bus.drain().then(() => (drained = true));
    let drainedRun = false;
    const one = bus.drain('run-1').then(() => (drainedRun = true));
    // 另一個 run 沒有進行中的事件：立即返回
    await bus.drain('run-2');
    await turnEventLoop();
    expect(drained).toBe(false);
    expect(drainedRun).toBe(false);

    gate.resolve();
    await published;
    await Promise.all([all, one]);
    expect(reacted).toEqual(['run-1']);
  });

  it('持久化失敗：publish reject，登記被撤銷，drain 不會掛起', async () => {
    const bus = new EventBus({ log: quiet });
    const reacted: number[] = [];
    bus.subscribe(() => {
      throw new Error('disk full');
    }, { phase: 'persist' });
    bus.subscribe((event) => void reacted.push(event.sequence), { phase: 'post' });

    const published = bus.publish(input('run-1'));
    const drained = bus.drain();
    await expect(published).rejects.toThrow(/disk full/);
    await drained;
    await bus.drain('run-1');
    expect(reacted).toEqual([]);
  });
});
