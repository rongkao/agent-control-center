import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, RUN_SNAPSHOT_SCHEMA_VERSION } from '@acc/core';
import type { AgentAdapter, TaskRecord } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter, type ScriptStep } from './fakes/scripted-adapter.js';
import { tempDb } from './helpers.js';

/** 一個“服務端程序”：獨立的 store 連線 + EventBus + Orchestrator + adapter 實例。 */
function bootProcess(dbPath: string, adapters: AgentAdapter[]) {
  const store = new SqliteControlPlaneStore({ path: dbPath });
  const bus = new EventBus();
  const orchestrator = new Orchestrator(store, bus);
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, bus, orchestrator };
}

const SCRIPT: ScriptStep[] = [
  { kind: 'tool', id: 'tool-A', name: 'write_file' },
  { kind: 'approval', id: 'approval-B', providerCallId: 'toolu_B', summary: 'Run shell command' },
  { kind: 'tool', id: 'tool-B', name: 'bash' },
  { kind: 'complete' },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function setup() {
  const db = tempDb();
  cleanups.push(db.cleanup);
  return db.path;
}

async function createTask(orchestrator: Orchestrator): Promise<TaskRecord> {
  const task = await orchestrator.createTask({ title: 'Recovery', prompt: 'do work', agentId: 'claude' });
  // 編排反應是非同步排隊執行的：斷言（以及模擬崩潰關閉資料庫）之前先等它們處理完
  await orchestrator.idle();
  return task;
}

describe('approval pause/resume (in-process)', () => {
  it('enters WAITING_APPROVAL and resumes the same logical step via adapter.approve', async () => {
    const world = new FakeWorld();
    const adapter = new ScriptedAdapter(world, SCRIPT);
    const p = bootProcess(setup(), [adapter]);
    cleanups.push(() => p.store.close());

    const task = await createTask(p.orchestrator);
    const waiting = await p.store.getRun(task.runId);
    expect(waiting?.status).toBe('WAITING_APPROVAL');
    expect(waiting?.resumeCursor).toMatchObject({ step: 'workflow:implement', approvalId: 'approval-B' });
    expect(await p.store.getApproval('approval-B')).toMatchObject({ status: 'pending', providerCallId: 'toolu_B' });

    await p.orchestrator.resolveApproval(task.id, 'approval-B', 'approve');
    await p.orchestrator.idle();

    const done = await p.store.getRun(task.runId);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.currentStep).toBe('workflow:implement');
    expect(world.executions).toEqual(['tool-A', 'tool-B']);
    expect(adapter.calls).toMatchObject({ start: 1, approve: 1, resume: 0 });
    expect(await p.store.getApproval('approval-B')).toMatchObject({ status: 'approved' });
  });

  it('decline blocks the run and never executes the gated tool', async () => {
    const world = new FakeWorld();
    const p = bootProcess(setup(), [new ScriptedAdapter(world, SCRIPT)]);
    cleanups.push(() => p.store.close());

    const task = await createTask(p.orchestrator);
    await p.orchestrator.resolveApproval(task.id, 'approval-B', 'decline');
    await p.orchestrator.idle();

    expect((await p.store.getRun(task.runId))?.status).toBe('BLOCKED');
    expect(world.executions).toEqual(['tool-A']);
    expect(await p.store.getApproval('approval-B')).toMatchObject({ status: 'declined' });
  });

  it('rejects resolving the same approval twice', async () => {
    const p = bootProcess(setup(), [new ScriptedAdapter(new FakeWorld(), SCRIPT)]);
    cleanups.push(() => p.store.close());
    const task = await createTask(p.orchestrator);
    await p.orchestrator.resolveApproval(task.id, 'approval-B', 'approve');
    await p.orchestrator.idle();
    // P0-5：重複提交得到結構化的 409（已經處理過），而不是籠統的“找不到”
    await expect(p.orchestrator.resolveApproval(task.id, 'approval-B', 'approve')).rejects.toMatchObject({ statusCode: 409, code: 'APPROVAL_ALREADY_RESOLVED' });
  });
});

describe('crash/restart recovery (TEST_PLAN mandatory scenario)', () => {
  it('pending approval survives restart and resuming does not re-execute tool A', async () => {
    const dbPath = setup();
    const world = new FakeWorld();

    // 程序 1：工具 A 完成，審批 B 請求，然後“崩潰”
    const firstAdapter = new ScriptedAdapter(world, SCRIPT);
    const first = bootProcess(dbPath, [firstAdapter]);
    const task = await createTask(first.orchestrator);
    const before = await first.store.getRun(task.runId);
    expect(before?.status).toBe('WAITING_APPROVAL');
    const lastSequenceBefore = await first.store.getLastSequence(task.runId);
    first.store.close();

    // 程序 2：新的 store 連線、新的 adapter 實例（記憶體會話全部丟失）
    const secondAdapter = new ScriptedAdapter(world, SCRIPT);
    const second = bootProcess(dbPath, [secondAdapter]);
    cleanups.push(() => second.store.close());

    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.waiting).toEqual([task.runId]);

    const recovered = await second.store.getRun(task.runId);
    expect(recovered?.status).toBe('WAITING_APPROVAL');
    expect(recovered?.recovery?.count).toBe(1);
    expect(recovered?.pendingApprovals).toEqual(before?.pendingApprovals);
    expect(recovered?.pendingApprovals[0]).toMatchObject({ id: 'approval-B', providerCallId: 'toolu_B' });

    await second.orchestrator.resolveApproval(task.id, 'approval-B', 'approve');
    await second.orchestrator.idle();

    // 斷言：A 只執行一次，B 執行一次，run 完成；沒有第二次 start
    expect(world.executions).toEqual(['tool-A', 'tool-B']);
    expect(firstAdapter.calls.start + secondAdapter.calls.start).toBe(1);
    expect(secondAdapter.calls.resume).toBe(1);
    expect(secondAdapter.resumeInputs[0]).toMatchObject({
      reason: 'approval',
      step: 'workflow:implement',
      approval: { approvalId: 'approval-B', decision: 'approve', providerCallId: 'toolu_B' },
      completedSideEffectIds: ['tool-A'],
    });
    expect((await second.store.getRun(task.runId))?.status).toBe('COMPLETED');

    // 事件序號在重啟後繼續單調遞增，沒有覆蓋舊事件
    const events = await second.store.listEvents(task.runId);
    const sequences = events.map((x) => x.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(Math.min(...events.filter((x) => x.sequence > lastSequenceBefore).map((x) => x.sequence))).toBe(lastSequenceBefore + 1);
    expect(events.some((x) => x.type === 'runtime.warning' && x.data.code === 'RUN_RECOVERED')).toBe(true);
  });

  it('RUNNING run whose adapter cannot resume fails closed to BLOCKED', async () => {
    const dbPath = setup();
    const world = new FakeWorld();
    // 腳本只執行一個工具就停在“執行中”
    const script: ScriptStep[] = [{ kind: 'tool', id: 'tool-A' }];

    const first = bootProcess(dbPath, [new ScriptedAdapter(world, script)]);
    const task = await createTask(first.orchestrator);
    expect((await first.store.getRun(task.runId))?.status).toBe('RUNNING');
    first.store.close();

    const second = bootProcess(dbPath, [new ScriptedAdapter(world, script, {}, { resumable: false })]);
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();

    expect(report.blocked).toEqual([task.runId]);
    expect((await second.store.getRun(task.runId))?.status).toBe('BLOCKED');
    const events = await second.store.listEvents(task.runId);
    expect(events.some((x) => x.type === 'runtime.error' && x.data.code === 'RUNTIME_DISCONNECTED')).toBe(true);
    expect(world.executions).toEqual(['tool-A']);
  });

  it('RUNNING run with a resumable adapter reconnects and skips completed side effects', async () => {
    const dbPath = setup();
    const world = new FakeWorld();
    const script: ScriptStep[] = [{ kind: 'tool', id: 'tool-A' }];

    const first = bootProcess(dbPath, [new ScriptedAdapter(world, script)]);
    const task = await createTask(first.orchestrator);
    first.store.close();

    const resumed = new ScriptedAdapter(world, [...script, { kind: 'tool', id: 'tool-C' }, { kind: 'complete' }]);
    const second = bootProcess(dbPath, [resumed]);
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();

    expect(report.resumed).toEqual([task.runId]);
    expect(resumed.resumeInputs[0]).toMatchObject({ reason: 'recovery', completedSideEffectIds: ['tool-A'] });
    expect(world.executions).toEqual(['tool-A', 'tool-C']);
    expect((await second.store.getRun(task.runId))?.status).toBe('COMPLETED');
  });

  it('unknown newer snapshot schema produces a critical incident and is never overwritten', async () => {
    const dbPath = setup();
    const first = bootProcess(dbPath, [new ScriptedAdapter(new FakeWorld(), SCRIPT)]);
    const task = await createTask(first.orchestrator);
    const future = JSON.stringify({ ...(await first.store.getRun(task.runId)), schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1 });
    first.store.putRawRun({ runId: task.runId, taskId: task.id, status: 'WAITING_APPROVAL', schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1, json: future });
    first.store.close();

    const second = bootProcess(dbPath, [new ScriptedAdapter(new FakeWorld(), SCRIPT)]);
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();

    expect(report.failedClosed).toEqual([task.runId]);
    expect((await second.store.getTask(task.id))?.status).toBe('BLOCKED');
    const incident = (await second.store.listEvents(task.runId)).find((x) => x.data.code === 'SNAPSHOT_SCHEMA_UNSUPPORTED');
    expect(incident).toMatchObject({ type: 'runtime.error', severity: 'critical', confidence: 'confirmed' });
    // 快照原樣保留，等待新版本程式處理
    expect(await second.store.loadRun(task.runId)).toMatchObject({ status: 'unsupported-schema' });
    await expect(second.orchestrator.resolveApproval(task.id, 'approval-B', 'approve')).rejects.toThrow();
  });

  it('corrupted snapshot fails closed', async () => {
    const dbPath = setup();
    const first = bootProcess(dbPath, [new ScriptedAdapter(new FakeWorld(), SCRIPT)]);
    const task = await createTask(first.orchestrator);
    first.store.putRawRun({ runId: task.runId, taskId: task.id, status: 'WAITING_APPROVAL', schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION, json: '{"broken":' });
    first.store.close();

    const second = bootProcess(dbPath, [new ScriptedAdapter(new FakeWorld(), SCRIPT)]);
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.failedClosed).toEqual([task.runId]);
    expect((await second.store.getTask(task.id))?.status).toBe('BLOCKED');
  });

  it('terminal runs are not resumed', async () => {
    const dbPath = setup();
    const world = new FakeWorld();
    const script: ScriptStep[] = [{ kind: 'tool', id: 'tool-A' }, { kind: 'complete' }];
    const first = bootProcess(dbPath, [new ScriptedAdapter(world, script)]);
    const task = await createTask(first.orchestrator);
    expect((await first.store.getRun(task.runId))?.status).toBe('COMPLETED');
    first.store.close();

    const adapter = new ScriptedAdapter(world, script);
    const second = bootProcess(dbPath, [adapter]);
    cleanups.push(() => second.store.close());
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report).toEqual({ resumed: [], waiting: [], blocked: [], failedClosed: [] });
    expect(adapter.calls.resume).toBe(0);
    expect(world.executions).toEqual(['tool-A']);
  });
});
