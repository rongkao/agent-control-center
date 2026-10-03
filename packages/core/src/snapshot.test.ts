import { describe, expect, it } from 'vitest';
import { createBudgetSnapshot } from './budget.js';
import {
  RUN_SNAPSHOT_SCHEMA_VERSION,
  SnapshotLoadError,
  deserializeRunSnapshot,
  loadRunSnapshot,
  serializeRunSnapshot,
} from './snapshot.js';
import type { RunSnapshot } from './types.js';

function snapshot(): RunSnapshot {
  return {
    schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION,
    runId: 'run-1',
    projectId: 'local',
    taskId: 'task-1',
    status: 'WAITING_APPROVAL',
    workflow: 'implementation-v1',
    currentStep: 'agent:claude',
    currentAgentId: 'claude',
    agentSessions: {
      claude: { agentId: 'claude', adapterType: 'claude', providerSessionId: 'native-1', status: 'waiting', metadata: { adapterSessionId: 's-1' } },
    },
    pendingApprovals: [
      { id: 'approval-B', agentId: 'claude', sessionId: 's-1', providerCallId: 'toolu_123', summary: 'rm -rf build', createdAt: 1, status: 'pending' },
    ],
    pendingInputs: [],
    budget: createBudgetSnapshot(),
    completedSideEffects: [{ id: 'tool-A', agentId: 'claude', eventId: 'e-1', completedAt: 1 }],
    resumeCursor: { step: 'agent:claude', reason: 'approval', agentId: 'claude', approvalId: 'approval-B' },
    progressSinceLastTurn: true,
    lastEventId: 'e-2',
    lastSequence: 7,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('RunSnapshot versioning', () => {
  it('JSON round-trip preserves pending approval identity and side-effect ledger', () => {
    const original = snapshot();
    const restored = deserializeRunSnapshot(serializeRunSnapshot(original));
    expect(restored).toEqual(original);
    expect(restored.pendingApprovals[0]).toMatchObject({ id: 'approval-B', providerCallId: 'toolu_123', status: 'pending' });
    expect(restored.resumeCursor?.approvalId).toBe('approval-B');
    expect(restored.completedSideEffects.map((x) => x.id)).toEqual(['tool-A']);
  });

  it('migrates v1 snapshots forward across the migration boundary', () => {
    const { completedSideEffects: _a, progressSinceLastTurn: _b, resumeCursor: _c, ...rest } = snapshot();
    const v1 = { ...rest, schemaVersion: 1 };
    const migrated = deserializeRunSnapshot(JSON.stringify(v1));
    expect(migrated.schemaVersion).toBe(RUN_SNAPSHOT_SCHEMA_VERSION);
    expect(migrated.completedSideEffects).toEqual([]);
    expect(migrated.progressSinceLastTurn).toBe(false);
    expect(migrated.pendingApprovals[0]?.id).toBe('approval-B');
  });

  it('fails closed on unknown newer schema version', () => {
    const future = { ...snapshot(), schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1 };
    expect(() => deserializeRunSnapshot(JSON.stringify(future))).toThrowError(SnapshotLoadError);
    try {
      deserializeRunSnapshot(JSON.stringify(future));
    } catch (error) {
      expect((error as SnapshotLoadError).code).toBe('SNAPSHOT_SCHEMA_UNSUPPORTED');
    }
    const result = loadRunSnapshot(JSON.stringify(future), { runId: 'run-1', taskId: 'task-1' });
    expect(result).toMatchObject({ status: 'unsupported-schema', schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION + 1 });
  });

  it('refuses to serialize a snapshot with a foreign schema version', () => {
    expect(() => serializeRunSnapshot({ ...snapshot(), schemaVersion: 99 })).toThrowError(/Refusing to write/);
  });

  it('reports corrupted snapshots explicitly', () => {
    expect(loadRunSnapshot('{not json', { runId: 'r', taskId: 't' }).status).toBe('corrupted');
    const missing = { ...snapshot() } as Partial<RunSnapshot>;
    delete missing.pendingApprovals;
    expect(loadRunSnapshot(JSON.stringify(missing), { runId: 'r', taskId: 't' }).status).toBe('corrupted');
  });
});
