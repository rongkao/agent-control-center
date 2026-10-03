import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_SNAPSHOT_SCHEMA_VERSION, createBudgetSnapshot } from '@acc/core';
import type { RunSnapshot, TaskRecord, UnifiedEvent } from '@acc/core';

/** 建立臨時目錄，返回資料庫路徑和清理函式。 */
export function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'acc-test-'));
  return { path: join(dir, 'agent-control.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-1',
    projectId: 'local',
    title: 'Fix crash',
    prompt: 'Fix it',
    status: 'RUNNING',
    workflow: 'implementation-v1',
    runId: 'run-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function makeRun(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION,
    runId: 'run-1',
    projectId: 'local',
    taskId: 'task-1',
    status: 'RUNNING',
    workflow: 'implementation-v1',
    currentStep: 'agent:claude',
    currentAgentId: 'claude',
    agentSessions: {},
    pendingApprovals: [],
    pendingInputs: [],
    budget: createBudgetSnapshot(),
    completedSideEffects: [],
    progressSinceLastTurn: false,
    lastSequence: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

export function makeEvent(sequence: number, overrides: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    id: `event-${sequence}`,
    projectId: 'local',
    taskId: 'task-1',
    runId: 'run-1',
    type: 'agent.message',
    severity: 'info',
    confidence: 'confirmed',
    timestamp: 1000 + sequence,
    sequence,
    data: { message: `m${sequence}` },
    ...overrides,
  };
}
