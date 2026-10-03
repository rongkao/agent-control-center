import type { EventBus, EventSink, UnifiedEvent } from '@acc/core';

type Emitted = Parameters<EventSink>[0];

interface Waiter<T> {
  predicate: (event: T) => boolean;
  resolve: (event: T) => void;
}

/**
 * 按條件等待事件（替代輪詢 + sleep）：已經出現過的事件立即返回，否則在它到達時 resolve。
 * 超時交給 vitest 的用例超時處理，不依賴機器快慢。
 */
class EventLog<T> {
  readonly events: T[] = [];
  private waiters: Array<Waiter<T>> = [];

  record(event: T): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.predicate(event)) continue;
      this.waiters = this.waiters.filter((x) => x !== waiter);
      waiter.resolve(event);
    }
  }

  waitFor(predicate: (event: T) => boolean): Promise<T> {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise<T>((resolve) => this.waiters.push({ predicate, resolve }));
  }
}

/** adapter 合約測試用：收集 adapter 直接發出的事件。 */
export function emitRecorder(): { emit: EventSink; events: Emitted[]; waitFor(predicate: (event: Emitted) => boolean): Promise<Emitted> } {
  const log = new EventLog<Emitted>();
  return {
    emit: (event) => {
      log.record(event);
    },
    events: log.events,
    waitFor: (predicate) => log.waitFor(predicate),
  };
}

/**
 * 編排器測試用：訂閱事件匯流排的反應階段（'post'）。
 *
 * 必須在編排器之後訂閱：同一事件的反應按訂閱順序依次執行，所以記錄到某個事件時，編排器對它的反應已經執行完，
 * 由它引發的後續反應也已經排進佇列——隨後呼叫 `bus.drain()` 就能等到它們全部結束，再斷言快照或關閉資料庫。
 * （觀察者階段收到事件時反應還沒入隊，那時 drain 會過早返回。）
 */
export function busRecorder(bus: EventBus): { events: UnifiedEvent[]; waitFor(predicate: (event: UnifiedEvent) => boolean): Promise<UnifiedEvent>; dispose(): void } {
  const log = new EventLog<UnifiedEvent>();
  const dispose = bus.subscribe((event) => log.record(event), { phase: 'post' });
  return { events: log.events, waitFor: (predicate) => log.waitFor(predicate), dispose };
}
