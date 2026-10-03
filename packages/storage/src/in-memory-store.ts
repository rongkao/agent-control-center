import { isTerminal, loadRunSnapshot, serializeRunSnapshot, unwrapRunLoad } from '@acc/core';
import type {
  ApprovalRecord,
  ControlPlaneStore,
  RunLoadResult,
  RunSnapshot,
  SessionOwnerRecord,
  StoreCommit,
  TaskRecord,
  UnifiedEvent,
  UsageRecord,
} from '@acc/core';

interface StoredRun {
  runId: string;
  taskId: string;
  status: string;
  json: string;
}

/**
 * 記憶體儲存：語義與 SQLite 儲存一致（快照按 JSON 序列化儲存、commit 原子、事件 (runId, sequence) 唯一），
 * 用於測試和 ACC_STORE=memory 模式。
 */
export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private tasks = new Map<string, TaskRecord>();
  private runs = new Map<string, StoredRun>();
  private events = new Map<string, UnifiedEvent[]>();
  private eventIds = new Set<string>();
  private approvals = new Map<string, ApprovalRecord>();
  private usage = new Map<string, UsageRecord>();

  async listTasks(): Promise<TaskRecord[]> {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((x) => structuredClone(x));
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  async upsertTask(task: TaskRecord): Promise<void> {
    await this.commit({ task });
  }

  async getRun(runId: string): Promise<RunSnapshot | undefined> {
    return unwrapRunLoad(await this.loadRun(runId));
  }

  async loadRun(runId: string): Promise<RunLoadResult | undefined> {
    const row = this.runs.get(runId);
    return row ? loadRunSnapshot(row.json, { runId: row.runId, taskId: row.taskId }) : undefined;
  }

  async listRecoverableRuns(): Promise<RunLoadResult[]> {
    return [...this.runs.values()]
      .filter((row) => !isTerminal(row.status as RunSnapshot['status']))
      .map((row) => loadRunSnapshot(row.json, { runId: row.runId, taskId: row.taskId }));
  }

  async upsertRun(snapshot: RunSnapshot): Promise<void> {
    await this.commit({ run: snapshot });
  }

  async appendEvent(event: UnifiedEvent): Promise<void> {
    await this.commit({ event });
  }

  async listEvents(runId: string, afterSequence = 0): Promise<UnifiedEvent[]> {
    return (this.events.get(runId) ?? [])
      .filter((x) => x.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((x) => structuredClone(x));
  }

  async getLastSequence(runId: string): Promise<number> {
    return (this.events.get(runId) ?? []).reduce((max, x) => Math.max(max, x.sequence), 0);
  }

  /** 刪除一個任務的全部資料（P1-12）。 */
  async deleteTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const runId = task.runId;
    this.tasks.delete(taskId);
    this.runs.delete(runId);
    for (const event of this.events.get(runId) ?? []) this.eventIds.delete(event.id);
    this.events.delete(runId);
    for (const [id, approval] of this.approvals) if (approval.runId === runId) this.approvals.delete(id);
    for (const [id, usage] of this.usage) if (usage.runId === runId) this.usage.delete(id);
    return true;
  }

  async commit(unit: StoreCommit): Promise<void> {
    // 先做全部校驗/序列化，全部通過後再寫入，模擬事務的全有或全無
    const { event } = unit;
    if (event) {
      if (this.eventIds.has(event.id)) throw new Error(`Duplicate event id: ${event.id}`);
      if ((this.events.get(event.runId) ?? []).some((x) => x.sequence === event.sequence)) {
        throw new Error(`Duplicate event sequence ${event.sequence} for run ${event.runId}`);
      }
    }
    const runJson = unit.run ? serializeRunSnapshot(unit.run) : undefined;

    if (event) {
      const list = this.events.get(event.runId) ?? [];
      list.push(structuredClone(event));
      this.events.set(event.runId, list);
      this.eventIds.add(event.id);
    }
    if (unit.task) this.tasks.set(unit.task.id, structuredClone(unit.task));
    if (unit.run && runJson) {
      this.runs.set(unit.run.runId, { runId: unit.run.runId, taskId: unit.run.taskId, status: unit.run.status, json: runJson });
    }
    for (const approval of unit.approvals ?? []) this.approvals.set(approval.id, structuredClone(approval));
    for (const usage of unit.usage ?? []) this.usage.set(usage.id, structuredClone(usage));
  }

  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : undefined;
  }

  async listApprovals(runId: string): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((x) => x.runId === runId).map((x) => structuredClone(x));
  }

  async listUsage(runId: string): Promise<UsageRecord[]> {
    return [...this.usage.values()].filter((x) => x.runId === runId).map((x) => structuredClone(x));
  }

  async findSessionsByProviderId(providerSessionId: string): Promise<SessionOwnerRecord[]> {
    const out: SessionOwnerRecord[] = [];
    for (const row of this.runs.values()) {
      const loaded = loadRunSnapshot(row.json, { runId: row.runId, taskId: row.taskId });
      if (loaded.status !== 'ok') continue;
      for (const session of Object.values(loaded.snapshot.agentSessions)) {
        if (session.providerSessionId === providerSessionId) {
          out.push({ runId: row.runId, agentId: session.agentId, adapterType: session.adapterType, providerSessionId, ownerInstanceId: session.ownerInstanceId });
        }
      }
    }
    return out;
  }

  /** 僅測試用：直接寫入原始快照 JSON（模擬未來版本或損壞資料）。 */
  putRawRun(row: StoredRun): void {
    this.runs.set(row.runId, { ...row });
  }
}
