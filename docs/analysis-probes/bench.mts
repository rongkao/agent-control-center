import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteControlPlaneStore } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/storage/src/sqlite-store.ts';
import { projectEvent, createBudgetSnapshot, RUN_SNAPSHOT_SCHEMA_VERSION } from 'file:///D:/codes/ai/AgentBox/agent-control-center-claude/packages/core/src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'accbench-'));
const store = new SqliteControlPlaneStore({ path: join(dir, 'b.db') });
const now = Date.now();
const taskId = randomUUID(), runId = randomUUID();
const task: any = { id: taskId, projectId: 'local', title: 't', prompt: 'p', status: 'RUNNING', workflow: 'manual', runId, createdAt: now, updatedAt: now };
const run: any = { schemaVersion: RUN_SNAPSHOT_SCHEMA_VERSION, runId, projectId: 'local', taskId, status: 'RUNNING', workflow: 'manual', currentStep: 'x', currentAgentId: 'claude',
  agentSessions: { claude: { agentId: 'claude', adapterType: 'claude', status: 'coding', metadata: { adapterSessionId: 's1' } } }, pendingApprovals: [], pendingInputs: [],
  budget: { ...createBudgetSnapshot({}), startedAt: now }, completedSideEffects: [], progressSinceLastTurn: false, lastSequence: 0, createdAt: now, updatedAt: now };
await store.commit({ task, run });
const N = Number(process.argv[2] ?? 6000);
const out = 'x'.repeat(500);
let t0 = performance.now(); let bucket = Math.floor(N / 4);
for (let i = 1; i <= N; i++) {
  const ev: any = { id: randomUUID(), projectId: 'local', taskId, runId, sequence: i, timestamp: Date.now(), type: 'tool.completed', severity: 'info', confidence: 'confirmed', agentId: 'claude', sessionId: 's1', data: { toolCallId: randomUUID(), toolName: 'Bash', output: out, action: 'Bash completed' } };
  const t = await store.getTask(taskId);
  const l: any = await store.loadRun(runId);
  const r = l.snapshot;
  const p = projectEvent(t!, r, ev);
  await store.commit({ event: ev, task: t, run: r, approvals: p.approvals, usage: p.usage });
  await store.loadRun(runId); // enforceBudget
  if (i % bucket === 0) { console.log(`events ${i - bucket + 1}-${i}: avg ${((performance.now() - t0) / bucket).toFixed(2)} ms/event`); t0 = performance.now(); }
  if (i === 300 || i === 1000) { const l2: any = await store.loadRun(runId); console.log(`  at ${i}: snapshot ${(JSON.stringify(l2.snapshot).length/1024).toFixed(1)} KB`); }
}
const l3: any = await store.loadRun(runId);
console.log(`final snapshot ${(JSON.stringify(l3.snapshot).length/1024).toFixed(1)} KB`);
store.close();
