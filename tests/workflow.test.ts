import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { ControlPlaneStore, CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore, SqliteControlPlaneStore } from '@acc/storage';
import { WorkflowAgent, type TurnOutcome } from './fakes/workflow-agent.js';
import { tempDb } from './helpers.js';

function boot(opts: { claude?: TurnOutcome[]; codex?: TurnOutcome[]; tests?: boolean[]; store?: ControlPlaneStore } = {}) {
  const store = opts.store ?? new InMemoryControlPlaneStore();
  const bus = new EventBus();
  const orchestrator = new Orchestrator(store, bus);
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, opts.claude ?? []);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, opts.codex ?? [], { kind: 'reply', text: 'Looks fine.\nVERDICT: ACCEPT' });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test' }, (opts.tests ?? []).map((passed) => ({ kind: 'test' as const, passed })), { kind: 'test', passed: true });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  orchestrator.registerAdapter(tester);
  return { store, bus, orchestrator, claude, codex, tester };
}

const TASK: CreateTaskInput = { title: 'Fix login crash', prompt: 'The login page crashes on empty password.', agentId: 'claude', testCommand: 'npm test' };

async function snapshot(env: ReturnType<typeof boot>, runId: string) {
  return (await env.store.getRun(runId))!;
}

describe('implementation-v1 workflow', () => {
  it('success first try: implement → test pass → COMPLETED', async () => {
    const env = boot({ tests: [true] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);

    expect(run.status).toBe('COMPLETED');
    expect(env.claude.calls).toHaveLength(1);
    expect(env.claude.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    expect(env.claude.calls[0]?.prompt).toContain('The login page crashes on empty password.');
    expect(env.tester.calls[0]).toMatchObject({ via: 'start', mode: 'test', context: { testCommand: 'npm test' } });
    expect(env.codex.calls).toHaveLength(0);
    expect(run.workflowState?.history.map((x) => x.outcome)).toEqual(['implementation turn completed', 'tests passed']);
    const steps = (await env.store.listEvents(task.runId)).filter((x) => x.type === 'run.status').map((x) => x.data.step);
    expect(steps).toEqual(['queued', 'workflow:implement', 'workflow:test']);
  });

  it('first test fails, Claude retry succeeds (retry prompt carries the failing test output)', async () => {
    const env = boot({ tests: [false, true] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);

    expect(run.status).toBe('COMPLETED');
    expect(env.claude.calls.map((x) => x.via)).toEqual(['start', 'send']);
    expect(env.claude.calls[1]?.prompt).toMatch(/FAILED/);
    expect(env.claude.calls[1]?.prompt).toContain('FAIL: expected 2 got 3');
    expect(run.workflowState).toMatchObject({ retriesUsed: 1, rescueUsed: false });
  });

  it('repeated failure hands off to Codex rescue (read-only), then Claude applies the fix', async () => {
    const env = boot({ tests: [false, false, true], codex: [{ kind: 'reply', text: 'Root cause: null password not guarded. Fix: add a guard in login.ts.' }] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);

    expect(run.status).toBe('COMPLETED');
    expect(env.codex.calls[0]).toMatchObject({ via: 'start', mode: 'rescue' });
    expect(env.codex.calls[0]?.prompt).toMatch(/Do NOT modify any files/);
    expect(env.claude.calls.map((x) => x.via)).toEqual(['start', 'send', 'send']);
    expect(env.claude.calls[2]?.prompt).toContain('Root cause: null password not guarded');
    const handoffs = (await env.store.listEvents(task.runId)).filter((x) => x.type === 'handoff.requested').map((x) => `${x.data.fromAgentId}->${x.data.toAgentId}:${x.data.reason}`);
    expect(handoffs).toContain('claude->codex:rescue');
    expect(handoffs).toContain('codex->claude:fix');
    expect(run.workflowState?.handoffs.map((x) => x.id)).toEqual(expect.arrayContaining(['rescue#5', 'fix#6']));
  });

  it('still failing after rescue blocks for the operator; operator retry with instructions can finish it', async () => {
    const env = boot({ tests: [false, false, false, true] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    let run = await snapshot(env, task.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.currentStep).toBe('workflow:TESTS_FAILED');

    await env.orchestrator.resolveGate(task.id, 'retry', 'Also handle whitespace-only passwords');
    await env.orchestrator.idle();
    run = await snapshot(env, task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(env.claude.calls.at(-1)?.prompt).toContain('Also handle whitespace-only passwords');
  });

  it('other subscribers (e.g. WebSocket) receive events in strictly increasing sequence order', async () => {
    const env = boot({ tests: [false, false, true] });
    const seen: number[] = [];
    env.bus.subscribe((event) => {
      seen.push(event.sequence);
    });
    await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    expect(seen.length).toBeGreaterThan(20);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('records every message sent to an agent as conversation without polluting handoff outputs', async () => {
    const env = boot({ tests: [false, false, true], codex: [{ kind: 'reply', text: 'Root cause: X' }] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    const events = await env.store.listEvents(task.runId);
    const outgoing = events.filter((x) => x.type === 'agent.message' && x.data.direction === 'to-agent');
    expect(outgoing.map((x) => x.agentId)).toEqual(['claude', 'claude', 'codex', 'claude']);
    expect(outgoing[0]?.data).toMatchObject({ from: 'orchestrator' });
    expect(String(outgoing[0]?.data.message)).toContain('The login page crashes on empty password.');
    const run = await snapshot(env, task.runId);
    expect(run.workflowState?.lastOutputs.codex).toBe('Root cause: X');
    await env.orchestrator.sendMessage(task.id, 'claude', 'thanks').catch(() => undefined);
  });

    it('no test command: implementation completes the run directly', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...TASK, testCommand: undefined });
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
    expect(env.tester.calls).toHaveLength(0);
  });

  it('transient runtime failure is retried once; a second failure blocks', async () => {
    const ok = boot({ claude: [{ kind: 'fail', code: 'CLAUDE_OVERLOADED', retryable: true }], tests: [true] });
    const t1 = await ok.orchestrator.createTask(TASK);
    await ok.orchestrator.idle();
    expect((await snapshot(ok, t1.runId)).status).toBe('COMPLETED');
    expect(ok.claude.calls[1]?.prompt).toMatch(/transient runtime error/);

    const bad = boot({ claude: [{ kind: 'fail', code: 'CLAUDE_OVERLOADED', retryable: true }, { kind: 'fail', code: 'CLAUDE_OVERLOADED', retryable: true }] });
    const t2 = await bad.orchestrator.createTask(TASK);
    await bad.orchestrator.idle();
    const run = await snapshot(bad, t2.runId);
    expect(run.status).toBe('BLOCKED');
    expect(run.currentStep).toBe('workflow:AGENT_FAILED');

    const fatal = boot({ claude: [{ kind: 'fail', code: 'CLAUDE_AUTHENTICATION_FAILED', retryable: false }] });
    const t3 = await fatal.orchestrator.createTask(TASK);
    await fatal.orchestrator.idle();
    expect((await snapshot(fatal, t3.runId)).status).toBe('BLOCKED');
    expect(fatal.claude.calls).toHaveLength(1);
  });
});

describe('review manager (manual, bounded)', () => {
  it('review gate waits for the operator; accept completes without any review', async () => {
    const env = boot({ tests: [true] });
    const task = await env.orchestrator.createTask({ ...TASK, reviewGate: true });
    await env.orchestrator.idle();
    let run = await snapshot(env, task.runId);
    expect(run.status).toBe('WAITING_INPUT');
    expect(run.pendingInputs).toEqual([expect.objectContaining({ id: 'review-gate' })]);

    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();
    run = await snapshot(env, task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(run.pendingInputs).toEqual([]);
    expect(env.codex.calls).toHaveLength(0);
    expect(run.budget.reviewRoundsUsed).toBe(0);
  });

  it('SUGGEST_CHANGES → one implementation follow-up → final test → COMPLETED (no automatic second review)', async () => {
    const env = boot({ tests: [true, true], codex: [{ kind: 'reply', text: 'Please add a unit test for empty input.\nVERDICT: SUGGEST_CHANGES' }] });
    const task = await env.orchestrator.createTask({ ...TASK, reviewGate: true });
    await env.orchestrator.idle();
    await env.orchestrator.resolveGate(task.id, 'review');
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);

    expect(run.status).toBe('COMPLETED');
    expect(env.codex.calls).toHaveLength(1);
    expect(env.codex.calls[0]).toMatchObject({ mode: 'review' });
    expect(env.claude.calls.at(-1)?.prompt).toContain('Please add a unit test for empty input.');
    expect(env.tester.calls).toHaveLength(2);
    expect(run.workflowState?.review).toMatchObject({ verdict: 'SUGGEST_CHANGES', confidence: 'inferred' });
    expect(run.budget.reviewRoundsUsed).toBe(1);
  });

  it('review round limit prevents review loops', async () => {
    const env = boot({ tests: [true], codex: [{ kind: 'reply', text: 'Not sure about this.\nVERDICT: BLOCKED' }] });
    const task = await env.orchestrator.createTask({ ...TASK, reviewGate: true });
    await env.orchestrator.idle();
    await env.orchestrator.resolveGate(task.id, 'review');
    await env.orchestrator.idle();
    const run = await snapshot(env, task.runId);
    expect(run.status).toBe('WAITING_INPUT');
    expect(run.workflowState?.review?.verdict).toBe('BLOCKED');

    await expect(env.orchestrator.resolveGate(task.id, 'review')).rejects.toThrow(/Review round limit/);
    expect(env.codex.calls).toHaveLength(1);
    // 仍可由操作員接受
    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
  });

  it('manual tasks can be accepted (completed) by the operator; other gate actions are rejected', async () => {
    const env = boot({ claude: [{ kind: 'reply' }] });
    const task = await env.orchestrator.createTask({ ...TASK, workflow: 'manual' });
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('RUNNING');
    await expect(env.orchestrator.resolveGate(task.id, 'review')).rejects.toThrow(/only accept/);
    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();
    expect((await snapshot(env, task.runId)).status).toBe('COMPLETED');
  });

  it('operator handoff forwards one agent reply to another through the orchestrator (recorded)', async () => {
    const env = boot({ claude: [{ kind: 'reply', text: 'Plan: guard empty password' }], codex: [{ kind: 'reply', text: 'Looks risky: also trim spaces' }] });
    const task = await env.orchestrator.createTask({ ...TASK, workflow: 'manual' });
    await env.orchestrator.idle();
    await env.orchestrator.handoffMessage(task.id, 'claude', 'codex', 'Plan: guard empty password', 'Review this plan');
    await env.orchestrator.idle();
    expect(env.codex.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    expect(env.codex.calls[0]?.prompt).toContain('[Forwarded from claude by the operator]');
    expect(env.codex.calls[0]?.prompt).toContain('Plan: guard empty password');
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((x) => x.type === 'handoff.requested' || x.type === 'handoff.completed').map((x) => x.type)).toEqual(['handoff.requested', 'handoff.completed']);
    expect(events.find((x) => x.type === 'agent.message' && x.data.from === 'handoff')?.data).toMatchObject({ fromAgentId: 'claude', instruction: 'Review this plan' });
    await expect(env.orchestrator.handoffMessage(task.id, 'claude', 'claude', 'x')).rejects.toThrow(/two different agents/);
  });

  it('gate is rejected when the run is not waiting for the operator', async () => {
    const env = boot({ claude: [{ kind: 'silent' }] });
    const task = await env.orchestrator.createTask(TASK);
    await env.orchestrator.idle();
    await expect(env.orchestrator.resolveGate(task.id, 'accept')).rejects.toThrow(/not waiting/);
    await expect(env.orchestrator.resolveGate(task.id, 'retry')).rejects.toThrow();
  });
});

describe('workflow recovery', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('idle chat tasks are not poked after a restart; the next message resumes the session', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const store1 = new SqliteControlPlaneStore({ path: db.path });
    const first = boot({ store: store1 });
    const task = await first.orchestrator.createTask({ ...TASK, workflow: 'manual' });
    await first.orchestrator.idle();
    expect((await store1.getRun(task.runId))?.agentSessions.claude?.status).toBe('completed');
    store1.close();

    const store2 = new SqliteControlPlaneStore({ path: db.path });
    cleanups.push(() => store2.close());
    const second = boot({ store: store2 });
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.waiting).toEqual([task.runId]);
    expect(second.claude.calls).toHaveLength(0);
    expect((await store2.getRun(task.runId))?.status).toBe('RUNNING');

    await second.orchestrator.sendMessage(task.id, 'claude', 'hello again');
    await second.orchestrator.idle();
    expect(second.claude.calls).toEqual([expect.objectContaining({ via: 'resume', prompt: 'hello again' })]);
  });

  it('restart during WAITING_INPUT keeps the review gate identity and accepts after restart', async () => {
    const db = tempDb();
    cleanups.push(db.cleanup);
    const store1 = new SqliteControlPlaneStore({ path: db.path });
    const first = boot({ tests: [true], store: store1 });
    const task = await first.orchestrator.createTask({ ...TASK, reviewGate: true });
    await first.orchestrator.idle();
    expect((await store1.getRun(task.runId))?.status).toBe('WAITING_INPUT');
    store1.close();

    const store2 = new SqliteControlPlaneStore({ path: db.path });
    cleanups.push(() => store2.close());
    const second = boot({ store: store2 });
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.waiting).toEqual([task.runId]);
    const run = (await store2.getRun(task.runId))!;
    expect(run.pendingInputs[0]?.id).toBe('review-gate');
    expect(run.workflowState?.step).toBe('review-gate');

    await second.orchestrator.resolveGate(task.id, 'accept');
    await second.orchestrator.idle();
    expect((await store2.getRun(task.runId))?.status).toBe('COMPLETED');
    // 重啟後沒有重複呼叫任何 agent
    expect(second.claude.calls).toHaveLength(0);
    expect(second.tester.calls).toHaveLength(0);
  });
});
