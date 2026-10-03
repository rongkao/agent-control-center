/**
 * 會話歸屬登記（P1.3）。
 *
 * 規則：一個會話在生命週期內只有一個 adapter/runtime 持有者。
 * - (runId, agentId) 同一時刻只能有一個會話槽位：啟動前先 reserve，防止併發重複啟動；
 * - provider 原生會話 ID 只能歸屬一個 (runId, agentId)：跨 run 複用視為衝突（需要顯式遷移流程）；
 * - 同一槽位不允許換 adapter 型別。
 *
 * 記憶體登記表只負責本程序內的併發；跨重啟/跨 run 的唯一性由儲存層查詢保證（見 Orchestrator）。
 */
export interface SessionClaim {
  runId: string;
  agentId: string;
  adapterType: string;
  providerSessionId?: string;
}

export class SessionOwnershipError extends Error {
  readonly code = 'SESSION_OWNERSHIP_CONFLICT';
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionOwnershipError';
  }
}

type Slot = SessionClaim & { state: 'pending' | 'attached' };

const slotKey = (runId: string, agentId: string) => `${runId}\u0000${agentId}`;

export class SessionRegistry {
  private slots = new Map<string, Slot>();
  private providers = new Map<string, SessionClaim>();

  /** 啟動前佔位；已有槽位（啟動中或已掛接）時拒絕。 */
  reserve(runId: string, agentId: string, adapterType: string): void {
    const existing = this.slots.get(slotKey(runId, agentId));
    if (existing) {
      throw new SessionOwnershipError(`Session slot ${agentId} in run ${runId} is already ${existing.state}`, {
        runId,
        agentId,
        state: existing.state,
        reason: 'slot-taken',
      });
    }
    this.slots.set(slotKey(runId, agentId), { runId, agentId, adapterType, state: 'pending' });
  }

  /** 掛接會話（啟動完成或重啟恢復時）。 */
  attach(claim: SessionClaim): void {
    const key = slotKey(claim.runId, claim.agentId);
    const slot = this.slots.get(key);
    if (slot && slot.adapterType !== claim.adapterType) {
      throw new SessionOwnershipError(`Session slot ${claim.agentId} is owned by adapter ${slot.adapterType}`, {
        ...claim,
        ownerAdapterType: slot.adapterType,
        reason: 'adapter-mismatch',
      });
    }
    if (slot?.state === 'attached' && slot.providerSessionId && claim.providerSessionId && slot.providerSessionId !== claim.providerSessionId) {
      throw new SessionOwnershipError(`Session slot ${claim.agentId} already attached to ${slot.providerSessionId}`, {
        ...claim,
        ownerProviderSessionId: slot.providerSessionId,
        reason: 'slot-attached',
      });
    }
    if (claim.providerSessionId) {
      const owner = this.providers.get(claim.providerSessionId);
      if (owner && (owner.runId !== claim.runId || owner.agentId !== claim.agentId)) {
        throw new SessionOwnershipError(`Provider session ${claim.providerSessionId} is owned by ${owner.agentId} in run ${owner.runId}`, {
          ...claim,
          ownerRunId: owner.runId,
          ownerAgentId: owner.agentId,
          reason: 'provider-session-owned',
        });
      }
      this.providers.set(claim.providerSessionId, claim);
    }
    this.slots.set(key, { ...claim, state: 'attached' });
  }

  /** 釋放槽位（啟動失敗、會話被取消/拒絕時）。 */
  release(runId: string, agentId: string): void {
    const key = slotKey(runId, agentId);
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.providerSessionId) this.providers.delete(slot.providerSessionId);
    this.slots.delete(key);
  }

  get(runId: string, agentId: string): (SessionClaim & { state: 'pending' | 'attached' }) | undefined {
    const slot = this.slots.get(slotKey(runId, agentId));
    return slot ? { ...slot } : undefined;
  }
}
