import { randomUUID } from 'node:crypto';
import type { EventSink, EventType, UnifiedEvent } from './types.js';

/**
 * adapter 可以透過 sink 發出的事件型別（P0-9 / L-1）：會話、訊息、模型輪次、工具、交接請求、審批請求、安全攔截、執行時警告 / 錯誤。
 * 其餘型別只有編排器才能發（ORCHESTRATOR_ONLY_EVENT_TYPES）：adapter 發了會被拒絕，並記一條 runtime.warning。
 */
export const ADAPTER_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'agent.started',
  'agent.status',
  'agent.message',
  'model.turn.started',
  'model.turn.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'handoff.requested',
  'approval.required',
  'safety.blocked',
  'runtime.warning',
  'runtime.error',
]);

/** 只有編排器才能發的事件：run 狀態遷移、審批決定、預算、交接完成（adapter 發了就能給自己“完成任務”、放行審批、加預算）。 */
export const ORCHESTRATOR_ONLY_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'run.started',
  'run.status',
  'run.completed',
  'run.failed',
  'approval.resolved',
  'approval.delivered',
  'checkpoint.created',
  'checkpoint.restored',
  'workspace.merged',
  'workspace.cleaned',
  'consult.answered',
  'budget.exceeded',
  'budget.stalled',
  'budget.extended',
  'handoff.completed',
]);

/** adapter 的事件被拒絕時記錄的警告程式碼（data.eventType / data.reason 說明是什麼、為什麼）。 */
export const ADAPTER_EVENT_REJECTED = 'ADAPTER_EVENT_REJECTED';
/** adapter 的事件帶著不屬於它的身份（別的任務、別的 agent）時記錄的警告程式碼：事件仍按 sink 固定的身份記錄。 */
export const ADAPTER_EVENT_IDENTITY_FIXED = 'ADAPTER_EVENT_IDENTITY_FIXED';

/**
 * adapter 事件被拒絕的原因：
 * - orchestrator-only：編排器專屬的事件型別；
 * - unknown-type：不認識的事件型別；
 * - missing-session：沒有會話身份（sessionId）——編排器把不帶會話身份的事件當成它自己發的，adapter 不能冒充；
 * - handoff-approval：偽造交接審批（approval.required 的 kind=handoff 只由編排器按策略生成）；
 * - to-agent-message：偽造“發給 agent 的訊息”（只由編排器記錄，介面上會顯示成操作員或編排器說的話）。
 */
export type AdapterEventRejection = 'orchestrator-only' | 'unknown-type' | 'missing-session' | 'handoff-approval' | 'to-agent-message';

/**
 * sink 固定的身份（P0-9 / L-1）：由編排器在把 sink 交給 adapter 時決定，adapter 發出的事件一律歸屬這個任務、這個 run、這個 agent。
 * 事件的來源（source）由會話身份表達：adapter 的事件必須帶 sessionId，編排器自己的事件不帶。
 */
export interface SinkIdentity {
  projectId: string;
  taskId: string;
  runId: string;
  agentId: string;
}

type SinkInput = Parameters<EventSink>[0];

/** 按白名單檢查 adapter 發來的事件；允許時返回 undefined。 */
export function screenAdapterEvent(input: SinkInput): AdapterEventRejection | undefined {
  const type = input.type;
  if (ORCHESTRATOR_ONLY_EVENT_TYPES.has(type)) return 'orchestrator-only';
  if (!ADAPTER_EVENT_TYPES.has(type)) return 'unknown-type';
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return 'missing-session';
  const data = input.data ?? {};
  if (type === 'approval.required' && data.kind === 'handoff') return 'handoff-approval';
  if (type === 'agent.message' && data.direction === 'to-agent') return 'to-agent-message';
  return undefined;
}

/** adapter 發出的交接請求：一律是 agent 的請求（origin=agent），去掉只有編排器執行交接時才寫的 reason / auto。 */
function agentHandoffRequest(data: Record<string, unknown>): Record<string, unknown> {
  const { reason: _reason, auto: _auto, ...rest } = data;
  return { ...rest, origin: 'agent' };
}

/** 被拒絕時給操作員看的說明（繁體中文，與介面一致）。 */
function rejectionMessage(agentId: string, type: string, reason: AdapterEventRejection): string {
  switch (reason) {
    case 'orchestrator-only':
      return `${agentId} 試圖發出只有編排器才能發的事件（${type}），已拒絕，任務狀態沒有改變。`;
    case 'unknown-type':
      return `${agentId} 發出了無法識別的事件（${type}），已忽略。`;
    case 'missing-session':
      return `${agentId} 發出的事件（${type}）沒有對話身份、無法確認來源，已拒絕。`;
    case 'handoff-approval':
      return `${agentId} 試圖自己建立交接審批，已拒絕；交接請求只能由編排器按策略處理。`;
    case 'to-agent-message':
      return `${agentId} 試圖冒充發給 AI 的訊息，已拒絕。`;
  }
}

export type EventHandler = (event: UnifiedEvent) => Promise<void> | void;
/** 編排反應失敗時的處理（例如轉成該 run 的 runtime.error 並 fail closed）。 */
export type ReactionErrorHandler = (error: unknown, event: UnifiedEvent) => Promise<void> | void;
/** 事件匯流排的日誌出口：觀察者/反應失敗、以及異常處理器本身失敗時使用。 */
export type EventBusLog = (message: string, error?: unknown) => void;

export interface SubscribeOptions {
  /**
   * - 'persist'：持久化（事件追加 + 快照投影，同一事務）。失敗時 publish reject——事件沒有落盤，呼叫方必須知道；
   *   此時觀察者和反應都不會執行。
   * - 'normal'（預設）：觀察者（WebSocket 推送、可讀日誌等）。在持久化成功後按訂閱順序執行；
   *   異常只記錄，不影響 publish 的結果（事件已經落盤）。
   * - 'post'：編排反應（預算檢查、工作流推進、agent 主動交接請求等，會引發新事件或呼叫 adapter）。
   *   放進按 run 序列的非同步佇列執行，與 publish 的呼叫棧脫鉤：publish 不等待反應完成，
   *   反應丟擲的異常交給 onError（預設記錄日誌），絕不會回到發事件的 adapter。
   *   這樣也保證觀察者先按 sequence 看到觸發事件，再看到由它引發的後續事件。
   */
  phase?: 'persist' | 'normal' | 'post';
  /** 僅 'post'：反應丟擲異常時的處理。 */
  onError?: ReactionErrorHandler;
}

export interface EventBusOptions {
  log?: EventBusLog;
  /**
   * 脫敏（P2-9）：adapter 發出的事件資料在落盤、廣播之前經過它（見 redaction.ts 的 createRedactor）。預設不處理。
   */
  redact?: <T>(value: T) => T;
}

interface Reaction {
  handler: EventHandler;
  onError?: ReactionErrorHandler;
}

const defaultLog: EventBusLog = (message, error) => {
  console.error(`[acc] ${message}`, error ?? '');
};

export class EventBus {
  private persistListeners = new Set<EventHandler>();
  private listeners = new Set<EventHandler>();
  private postListeners = new Set<Reaction>();
  /** 臨時事件（例如逐字流式片段）訂閱者：只用於即時展示，不持久化、不參與投影。 */
  private ephemeralListeners = new Set<EventHandler>();
  private sequenceByRun = new Map<string, number>();
  /** 每個 run 反應佇列的隊尾（佇列空時刪除）。 */
  private reactionTails = new Map<string, Promise<void>>();
  /**
   * 每個 run 進行中的 publish（正在落盤或通知觀察者、反應還沒排進佇列）：drain 同時等待它們。
   * publish 一開始就同步登記，落盤失敗或反應入隊之後撤銷。
   */
  private inflight = new Map<string, Set<Promise<void>>>();
  private readonly log: EventBusLog;
  private readonly redact: <T>(value: T) => T;

  constructor(options: EventBusOptions = {}) {
    this.log = options.log ?? defaultLog;
    this.redact = options.redact ?? (<T>(value: T) => value);
  }

  subscribe(handler: EventHandler, options: SubscribeOptions = {}): () => void {
    if (options.phase === 'post') {
      const reaction: Reaction = { handler, onError: options.onError };
      this.postListeners.add(reaction);
      return () => this.postListeners.delete(reaction);
    }
    const set = options.phase === 'persist' ? this.persistListeners : this.listeners;
    set.add(handler);
    return () => set.delete(handler);
  }

  /** 訂閱臨時事件（data.ephemeral === true）。 */
  subscribeEphemeral(handler: EventHandler): () => void {
    this.ephemeralListeners.add(handler);
    return () => this.ephemeralListeners.delete(handler);
  }

  /**
   * 交給 adapter 的事件入口（P0-9 / L-1）：adapter 發出的每個事件都經過這裡。
   * - 身份欄位（projectId、taskId、runId、agentId）一律改成 identity：adapter 不能把事件寫進別的任務、不能冒充別的 agent；
   *   帶著不一致的身份時仍按 identity 記錄，並留下一條 ADAPTER_EVENT_IDENTITY_FIXED 警告；
   * - 剝離 adapter 自帶的 id / sequence / timestamp：事件 ID、run 內序號、時間都由控制面分配；
   * - 只允許白名單內的事件型別（ADAPTER_EVENT_TYPES），並且必須帶會話身份；編排器專屬的寫法（偽造交接審批、
   *   偽造“發給 agent 的訊息”）同樣拒絕。被拒絕的事件不落盤、不投影，記一條 ADAPTER_EVENT_REJECTED 警告
   *   （不帶會話身份，不算 agent 的動靜），run 狀態不變；
   * - handoff.requested 一律是 agent 的請求（origin 固定為 agent，去掉只有編排器才寫的 reason / auto）；
   * - 事件資料經過脫敏（P2-9）：已知金鑰環境變數的值與常見金鑰格式被替換成「[已遮蔽:…]」。
   * 同一個 sink 反覆出現同一種違規只記一次警告。臨時事件（逐字流式輸出）同樣固定身份、按白名單過濾，被拒絕時直接丟棄。
   * 被拒絕不會拋給 adapter（adapter 自己沒有可以處理的辦法）；落盤失敗照舊 reject。
   */
  createSink(identity: SinkIdentity): EventSink {
    /** 這個 sink 已經記過的警告：同一種違規只記一次，不刷屏。 */
    const warned = new Set<string>();
    return async (input) => {
      const ephemeral = input.data?.ephemeral === true;
      const rejection = screenAdapterEvent(input);
      if (rejection) {
        if (ephemeral) return;
        await this.warnOnce(identity, warned, `${rejection}:${String(input.type)}`, {
          code: ADAPTER_EVENT_REJECTED,
          eventType: input.type,
          reason: rejection,
          attemptedSessionId: input.sessionId,
          message: rejectionMessage(identity.agentId, String(input.type), rejection),
        });
        return;
      }
      const fixed = (['projectId', 'taskId', 'runId', 'agentId'] as const).filter((field) => input[field] !== undefined && input[field] !== identity[field]);
      const event = {
        type: input.type,
        severity: input.severity,
        confidence: input.confidence,
        sessionId: input.sessionId,
        // 脫敏（P2-9）：模型輸出、工具輸入輸出裡的金鑰在這裡遮掉，之後的落盤、廣播、日誌都看不到原文
        data: this.redact(input.type === 'handoff.requested' ? agentHandoffRequest(input.data ?? {}) : (input.data ?? {})),
        ...identity,
      };
      if (ephemeral) {
        this.publishEphemeral(event);
        return;
      }
      await this.publish(event);
      if (fixed.length > 0) {
        await this.warnOnce(identity, warned, 'identity', {
          code: ADAPTER_EVENT_IDENTITY_FIXED,
          fields: fixed,
          eventType: input.type,
          attemptedSessionId: input.sessionId,
          message: `${identity.agentId} 發出的事件帶著不屬於它的身份（${fixed.join('、')}），已按它所在的任務記錄。`,
        });
      }
    };
  }

  /** 以編排器的名義為這個 adapter 記一條警告（同一個 sink 同一個 key 只記一次）；記錄失敗只寫日誌，不拋給 adapter。 */
  private async warnOnce(identity: SinkIdentity, warned: Set<string>, key: string, data: Record<string, unknown>): Promise<void> {
    if (warned.has(key)) {
      this.safeLog(`adapter ${identity.agentId} (run ${identity.runId}): ${String(data.code)} ${String(data.eventType ?? '')} again`, undefined);
      return;
    }
    warned.add(key);
    try {
      // 不帶會話身份：這是編排器的記錄，不算 agent 的動靜，也不會被當成 agent 的終態或錯誤
      await this.publish({ ...identity, type: 'runtime.warning', severity: 'warning', confidence: 'confirmed', data });
    } catch (error) {
      this.safeLog(`failed to record ${String(data.code)} for adapter ${identity.agentId} (run ${identity.runId})`, error);
    }
  }

  /**
   * 臨時事件：不分配 run 內序號、不寫事件日誌、不經過編排器投影，只推送給即時展示。
   * 訂閱者異常被吞掉，絕不影響 adapter 的訊息泵。
   */
  publishEphemeral(input: Omit<UnifiedEvent, 'id' | 'sequence' | 'timestamp'> & Partial<Pick<UnifiedEvent, 'id' | 'sequence' | 'timestamp'>>): void {
    const event: UnifiedEvent = { ...input, id: input.id ?? randomUUID(), timestamp: input.timestamp ?? Date.now(), sequence: 0 };
    for (const listener of this.ephemeralListeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // 忽略
      }
    }
  }

  /**
   * 釋出一個事件：持久化 → 通知觀察者 → 把編排反應排進該 run 的佇列。
   *
   * 只在持久化失敗時 reject（M-10）：呼叫方據此可以區分“事件沒落盤”和“後續處理失敗”，
   * 後者由反應自己的 onError 處理，不會讓一個已經落盤的事件被當成傳送失敗。
   */
  async publish(
    input: Omit<UnifiedEvent, 'id' | 'sequence' | 'timestamp'> & Partial<Pick<UnifiedEvent, 'id' | 'sequence' | 'timestamp'>>,
  ): Promise<UnifiedEvent> {
    const current = this.sequenceByRun.get(input.runId) ?? 0;
    const sequence = input.sequence ?? current + 1;
    this.sequenceByRun.set(input.runId, Math.max(current, sequence));

    const event: UnifiedEvent = {
      ...input,
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? Date.now(),
      sequence,
    };

    // 在第一次 await 之前同步登記：drain 從這一刻起就能看到這個事件（包括它隨後排進佇列的反應）
    const settle = this.trackInflight(event.runId);
    try {
      try {
        for (const listener of this.persistListeners) {
          await listener(event);
        }
      } catch (error) {
        // 沒有落盤（持久化失敗，或持久化階段的前置條件不滿足，例如審批已被處理）：
        // 這個序號之後還沒有分配給別的事件時收回，避免事件日誌出現空洞
        if (input.sequence === undefined && this.sequenceByRun.get(input.runId) === sequence) this.sequenceByRun.set(input.runId, sequence - 1);
        throw error;
      }
      for (const listener of this.listeners) {
        try {
          await listener(event);
        } catch (error) {
          this.safeLog(`event observer failed on ${event.type} #${event.sequence} (run ${event.runId})`, error);
        }
      }
      if (this.postListeners.size > 0) {
        const reactions = [...this.postListeners];
        void this.enqueueReaction(event.runId, async () => {
          for (const reaction of reactions) {
            try {
              await reaction.handler(event);
            } catch (error) {
              await this.reportReactionError(reaction.onError, error, event);
            }
          }
        });
      }
    } finally {
      // 反應已經入隊（或落盤失敗、不會有反應）：撤銷登記，此後由反應佇列的隊尾接著被 drain 等待
      settle();
    }

    return event;
  }

  /** 登記一個進行中的 publish，返回撤銷函式。 */
  private trackInflight(runId: string): () => void {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let set = this.inflight.get(runId);
    if (!set) {
      set = new Set();
      this.inflight.set(runId, set);
    }
    set.add(pending);
    const owner = set;
    return () => {
      release();
      owner.delete(pending);
      if (owner.size === 0 && this.inflight.get(runId) === owner) this.inflight.delete(runId);
    };
  }

  /**
   * 把一個編排反應排進該 run 的序列佇列：同一 run 的反應嚴格按入隊順序一個接一個執行，
   * 不同 run 之間互不阻塞。返回的 Promise 在該反應執行完後 resolve，永遠不會 reject
   * （反應丟擲的異常交給 onError；onError 自己失敗時只記錄日誌）。
   *
   * 注意：不要在反應內部 await 同一個 run 的 drain()（會等待自己）。
   */
  enqueueReaction(runId: string, reaction: () => Promise<void> | void, onError?: (error: unknown) => Promise<void> | void): Promise<void> {
    const previous = this.reactionTails.get(runId) ?? Promise.resolve();
    const current = previous.then(async () => {
      try {
        await reaction();
      } catch (error) {
        if (!onError) {
          this.safeLog(`orchestrator reaction failed (run ${runId})`, error);
          return;
        }
        try {
          await onError(error);
        } catch (handlerError) {
          this.safeLog(`reaction error handler failed (run ${runId})`, handlerError);
        }
      }
    });
    this.reactionTails.set(runId, current);
    void current.then(() => {
      if (this.reactionTails.get(runId) === current) this.reactionTails.delete(runId);
    });
    return current;
  }

  /**
   * 等待反應佇列清空，包括等待期間新排進來的反應（測試、優雅關閉用）。
   * 也等待進行中的 publish（正在落盤或通知觀察者、反應還沒入隊的事件）：drain 返回時，
   * 呼叫它之前已經開始釋出的每個事件，其反應都已執行完。
   * runId 為空時等待所有 run。不等待 adapter 自己的後台工作（例如仍在進行的模型輪次）。
   * 不要在反應或觀察者內部 drain 同一個 run（會等待自己）。
   */
  async drain(runId?: string): Promise<void> {
    for (;;) {
      const pending: Array<Promise<void>> = [];
      for (const [key, tail] of this.reactionTails) if (runId === undefined || key === runId) pending.push(tail);
      for (const [key, set] of this.inflight) if (runId === undefined || key === runId) pending.push(...set);
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  seedSequence(runId: string, sequence: number): void {
    this.sequenceByRun.set(runId, sequence);
  }

  private async reportReactionError(onError: ReactionErrorHandler | undefined, error: unknown, event: UnifiedEvent): Promise<void> {
    if (!onError) {
      this.safeLog(`orchestrator reaction failed on ${event.type} #${event.sequence} (run ${event.runId})`, error);
      return;
    }
    try {
      await onError(error, event);
    } catch (handlerError) {
      this.safeLog(`reaction error handler failed on ${event.type} #${event.sequence} (run ${event.runId})`, handlerError);
    }
  }

  private safeLog(message: string, error: unknown): void {
    try {
      this.log(message, error);
    } catch {
      // 日誌本身失敗也不能影響事件流
    }
  }
}
