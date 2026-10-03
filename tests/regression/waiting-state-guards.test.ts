import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTestRunnerAdapter } from '@acc/adapters';
import { BudgetExhaustedError, EventBus, GateActionError, Orchestrator, STEP_INACTIVITY_TIMEOUT } from '@acc/core';
import type { AgentAdapter, CreateTaskInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { busRecorder } from './fakes/event-waiter.js';
import { fakeSpawner } from './fakes/fake-test-child.js';

/**
 * P0 第三批審查：等待人工的狀態不被“問 agent”、看門狗、重跑測試這些旁路改掉。
 *
 * 現象（修復前）：
 * - 評審閘門（WAITING_INPUT）或等待審批（WAITING_APPROVAL）時操作員問 agent，呼叫 / 輪次額度正好用滿：
 *   派發前的預算檢查發出 budget.exceeded，等待狀態被改成 BLOCKED(budget)；一鍵放寬恢復不了原來的等待
 *   （閘門上 resumeStep 沒有可接著做的步驟），等待審批時放寬又把同一步再派給正卡在審批上的 agent；
 * - 看門狗只看 run 是不是 RUNNING：RUNNING 但正在等的 agent 還有未決的工具審批時，15 分鐘後停掉它，審批卡還掛著；
 * - 工作流正在跑測試時點「重跑測試」：測試執行器拒絕（已經在跑），編排器把整個任務 fail closed 為 BLOCKED，
 *   正在跑的那次測試結果被丟棄。
 */

const quiet = () => undefined;
const MIN = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-waiting-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(agents: { claude?: AgentAdapter; codex?: AgentAdapter; tester?: AgentAdapter }, options: { now?: () => number } = {}) {
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet, ...(options.now ? { now: options.now } : {}) });
  const claude = agents.claude ?? new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = agents.codex ?? new ControlledAgent({ id: 'codex', kind: 'codex' });
  const tester = agents.tester ?? new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, [], { kind: 'test', passed: true });
  for (const adapter of [claude, codex, tester]) orchestrator.registerAdapter(adapter);
  const rec = busRecorder(bus);
  cleanups.push(async () => {
    rec.dispose();
    await orchestrator.shutdown();
  });
  return { store, bus, orchestrator, claude, codex, tester, rec };
}

const workflow = (cwd: string, extra: Partial<CreateTaskInput> = {}): CreateTaskInput => ({ title: 'fix', prompt: 'Fix the parser crash', agentId: 'claude', testCommand: 'npm test', cwd, ...extra });

describe('等待人工時問 agent 被預算拒絕：只拒絕這一次派發，不改變等待狀態', () => {
  it('評審閘門：409，任務仍在等你決定；閘門照常可以「接受結果」', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] }, [], { kind: 'reply', text: 'done' });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['review', 'analysis'] }, [], { kind: 'reply', text: 'answer' });
    const env = boot({ claude, codex });
    const task = await env.orchestrator.createTask(workflow(tempWorkspace(), { reviewGate: true, budget: { maxAgentCalls: 3 } }));
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('WAITING_INPUT');

    await env.orchestrator.sendMessage(task.id, 'codex', 'first question');
    await env.orchestrator.idle();
    const error = await env.orchestrator.sendMessage(task.id, 'codex', 'second question').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    expect((error as BudgetExhaustedError).statusCode).toBe(409);
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_INPUT');
    expect(run.blockedBy).toBeUndefined();
    expect(run.pendingInputs.map((x) => x.id)).toEqual(['review-gate']);
    expect(codex.calls).toHaveLength(1);

    await env.orchestrator.resolveGate(task.id, 'accept');
    expect((await env.store.getRun(task.runId))!.status).toBe('COMPLETED');
  });

  it('等待審批：409，任務仍是 WAITING_APPROVAL，審批仍然有效；批准後原來的 agent 照常繼續', async () => {
    const env = boot({});
    const claude = env.claude as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace(), { budget: { maxAgentCalls: 1 } }));
    await env.orchestrator.idle();
    await claude.emit('approval.required', { approvalId: 'appr-1', toolName: 'Bash', toolInput: { command: 'ls' }, summary: 'List' }, claude.sessionId, 'warning');
    await env.orchestrator.idle();

    const error = await env.orchestrator.sendMessage(task.id, 'codex', 'question').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BudgetExhaustedError);
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    expect(run.pendingApprovals.map((x) => x.id)).toEqual(['appr-1']);

    await env.orchestrator.resolveApproval(task.id, 'appr-1', 'approve');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(claude.approvals).toMatchObject([{ approvalId: 'appr-1', decision: 'approve' }]);
    // 沒有把同一步再派一次給正卡在審批上的 Claude
    expect(claude.calls).toHaveLength(1);
  });
});

describe('看門狗：正在等的 agent 卡在工具審批上不算“沒有動靜”', () => {
  it('RUNNING 但 Claude 還有未決的工具審批：超過閾值也不停掉它', async () => {
    const clock = { now: 1_000_000 };
    const env = boot({}, { now: () => clock.now });
    const claude = env.claude as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    await claude.emit('approval.required', { approvalId: 'appr-1', toolName: 'Bash', toolInput: { command: 'ls' }, summary: 'List' }, claude.sessionId, 'warning');
    await env.orchestrator.idle();
    // 其他路徑（例如離開 BLOCKED 時仍有別的 agent 的審批）會留下“RUNNING 且待審批還在”：直接構造這個狀態
    const run = (await env.store.getRun(task.runId))!;
    const record = (await env.store.getTask(task.id))!;
    run.status = 'RUNNING';
    record.status = 'RUNNING';
    await env.store.commit({ run, task: record });

    clock.now += 16 * MIN;
    await env.orchestrator.checkInactivity();
    await env.orchestrator.idle();
    expect(claude.cancelled).toHaveLength(0);
    const events = await env.store.listEvents(task.runId);
    expect(events.some((e) => e.data.code === STEP_INACTIVITY_TIMEOUT)).toBe(false);
    expect((await env.store.getRun(task.runId))!.pendingApprovals.map((x) => x.id)).toEqual(['appr-1']);
  });
});

describe('工作流正在跑測試時點「重跑測試」', () => {
  it('409（中文說明），任務不 BLOCKED；正在跑的那次測試照常出結果，工作流照常推進', async () => {
    const spawner = fakeSpawner();
    const tester = new LocalTestRunnerAdapter({ spawn: spawner.spawn, log: quiet, env: { PATH: process.env.PATH } });
    const env = boot({ tester });
    const claude = env.claude as ControlledAgent;
    const task = await env.orchestrator.createTask(workflow(tempWorkspace()));
    await env.orchestrator.idle();
    await claude.complete('implemented');
    await env.orchestrator.idle();
    const child = await spawner.next(1);
    expect((await env.store.getRun(task.runId))!.workflowState).toMatchObject({ step: 'test', awaitingAgentId: 'test' });

    const error = await env.orchestrator.sendMessage(task.id, 'test', 'run tests').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GateActionError);
    expect((error as GateActionError).statusCode).toBe(409);
    expect(String((error as Error).message)).toMatch(/測試正在執行/);
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(spawner.children).toHaveLength(1);

    child.finish(0, 'all green');
    await env.rec.waitFor((e) => e.type === 'run.completed');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(run.workflowState?.lastTest?.passed).toBe(true);
  });
});
