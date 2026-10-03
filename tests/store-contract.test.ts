import { afterEach, describe, expect, it } from 'vitest';
import { RUN_SNAPSHOT_SCHEMA_VERSION, SnapshotLoadError } from '@acc/core';
import type { ControlPlaneStore } from '@acc/core';
import { InMemoryControlPlaneStore, SqliteControlPlaneStore } from '@acc/storage';
import { makeEvent, makeRun, makeTask, tempDb } from './helpers.js';

type RawWritable = ControlPlaneStore & {
  putRawRun(row: { runId: string; taskId: string; status: string; schemaVersion: number; json: string }): void;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const factories: Array<[string, () => RawWritable]> = [
  ['memory', () => new InMemoryControlPlaneStore()],
  [
    'sqlite',
    () => {
      const db = tempDb();
      const store = new SqliteControlPlaneStore({ path: db.path });
      cleanups.push(() => {
        store.close();
        db.cleanup();
      });
      return store;
    },
  ],
];

describe.each(factories)('ControlPlaneStore contract (%s)', (_name, create) => {
  it('commits event + task + snapshot together', async () => {
    const store = create();
    await store.commit({ task: makeTask(), run: makeRun(), event: makeEvent(1) });
    expect((await store.getTask('task-1'))?.title).toBe('Fix crash');
    expect((await store.getRun('run-1'))?.status).toBe('RUNNING');
    expect(await store.listEvents('run-1')).toHaveLength(1);
    expect(await store.getLastSequence('run-1')).toBe(1);
  });

  it('rolls back the whole unit when the event conflicts', async () => {
    const store = create();
    await store.commit({ task: makeTask(), run: makeRun(), event: makeEvent(1) });
    await expect(
      store.commit({
        event: makeEvent(1, { id: 'other-id' }),
        task: makeTask({ status: 'COMPLETED' }),
        run: makeRun({ status: 'COMPLETED' }),
      }),
    ).rejects.toThrow();
    expect((await store.getTask('task-1'))?.status).toBe('RUNNING');
    expect((await store.getRun('run-1'))?.status).toBe('RUNNING');
    expect(await store.listEvents('run-1')).toHaveLength(1);
  });

  it('returns events ordered by sequence and honours afterSequence', async () => {
    const store = create();
    await store.commit({ task: makeTask(), run: makeRun() });
    for (const seq of [3, 1, 2]) await store.appendEvent(makeEvent(seq));
    expect((await store.listEvents('run-1')).map((x) => x.sequence)).toEqual([1, 2, 3]);
    expect((await store.listEvents('run-1', 2)).map((x) => x.sequence)).toEqual([3]);
    const [first] = await store.listEvents('run-1');
    expect(first).toEqual(makeEvent(1));
  });

  it('lists only non-terminal runs as recoverable', async () => {
    const store = create();
    await store.commit({ task: makeTask(), run: makeRun() });
    await store.commit({ task: makeTask({ id: 'task-2', runId: 'run-2' }), run: makeRun({ runId: 'run-2', taskId: 'task-2', status: 'COMPLETED' }) });
    await store.commit({ task: makeTask({ id: 'task-3', runId: 'run-3' }), run: makeRun({ runId: 'run-3', taskId: 'task-3', status: 'WAITING_APPROVAL' }) });
    const runIds = (await store.listRecoverableRuns()).map((x) => x.runId).sort();
    expect(runIds).toEqual(['run-1', 'run-3']);
  });

  it('persists approvals and usage records', async () => {
    const store = create();
    await store.commit({
      task: makeTask(),
      run: makeRun(),
      approvals: [
        { id: 'ap-1', runId: 'run-1', taskId: 'task-1', agentId: 'claude', providerCallId: 'toolu_1', status: 'pending', request: { summary: 'x' }, createdAt: 5 },
      ],
      usage: [{ id: 'u-1', runId: 'run-1', agentId: 'claude', inputTokens: 10, outputTokens: 5, providerReported: true, createdAt: 6 }],
    });
    await store.commit({
      approvals: [
        {
          id: 'ap-1',
          runId: 'run-1',
          taskId: 'task-1',
          agentId: 'claude',
          providerCallId: 'toolu_1',
          status: 'approved',
          request: { summary: 'x' },
          decision: { decision: 'approve' },
          createdAt: 5,
          resolvedAt: 9,
        },
      ],
    });
    expect(await store.getApproval('ap-1')).toMatchObject({ status: 'approved', providerCallId: 'toolu_1', resolvedAt: 9 });
    expect(await store.listApprovals('run-1')).toHaveLength(1);
    const [usage] = await store.listUsage('run-1');
    expect(usage).toMatchObject({ id: 'u-1', inputTokens: 10, outputTokens: 5, providerReported: true, createdAt: 6 });
  });

  it('fails closed on unknown newer snapshot schema without rewriting it', async () => {
    const store = create();
    await store.commit({ task: makeTask() });
    const json = JSON.stringify({ ...makeRun(), schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1, futureField: true });
    store.putRawRun({ runId: 'run-1', taskId: 'task-1', status: 'RUNNING', schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1, json });
    expect(await store.loadRun('run-1')).toMatchObject({ status: 'unsupported-schema', schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1 });
    await expect(store.getRun('run-1')).rejects.toBeInstanceOf(SnapshotLoadError);
    expect((await store.listRecoverableRuns())[0]?.status).toBe('unsupported-schema');
  });
});

describe('SqliteControlPlaneStore durability', () => {
  it('survives close/reopen and keeps provider session identity', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const first = new SqliteControlPlaneStore({ path: db.path });
    await first.commit({
      task: makeTask(),
      run: makeRun({
        agentSessions: {
          claude: { agentId: 'claude', adapterType: 'claude', providerSessionId: 'native-abc', ownerInstanceId: 'inst-1', status: 'coding' },
        },
      }),
      event: makeEvent(1),
    });
    first.close();

    const second = new SqliteControlPlaneStore({ path: db.path });
    expect((await second.getRun('run-1'))?.agentSessions.claude?.providerSessionId).toBe('native-abc');
    expect(second.listAgentSessions('run-1')).toEqual([
      { agentId: 'claude', providerSessionId: 'native-abc', ownerInstanceId: 'inst-1', status: 'coding' },
    ]);
    expect(await second.getLastSequence('run-1')).toBe(1);
    second.close();
  });
});
