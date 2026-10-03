import { describe, expect, it } from 'vitest';
import { CLAUDE_HANDOFF_TOOL, ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, RUN_SNAPSHOT_SCHEMA_VERSION, deserializeRunSnapshot } from '@acc/core';
import type { CreateTaskInput, EventSink, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from './fakes/fake-claude-runtime.js';
import { FakeCodexDisk, FakeCodexServer } from './fakes/fake-codex-server.js';
import { WorkflowAgent, type TurnOutcome } from './fakes/workflow-agent.js';
import { makeRun } from './helpers.js';

function boot(opts: { claude?: TurnOutcome[]; codex?: TurnOutcome[]; tests?: boolean[]; claudeFallback?: TurnOutcome } = {}) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus());
  const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, opts.claude ?? [], opts.claudeFallback);
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' }, opts.codex ?? []);
  const tester = new WorkflowAgent({ id: 'test', kind: 'test' }, (opts.tests ?? []).map((passed) => ({ kind: 'test' as const, passed })), { kind: 'test', passed: true });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  orchestrator.registerAdapter(tester);
  return { store, orchestrator, claude, codex, tester };
}

const CHAT: CreateTaskInput = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual' };
const types = (events: UnifiedEvent[]) => events.map((x) => x.type);

describe('agent-initiated handoff requests', () => {
  it('policy ask (default): becomes an operator approval; approve forwards through the orchestrator', async () => {
    const env = boot({ claude: [{ kind: 'handoff', to: 'codex', instruction: 'Please review my fix', text: 'Fixed null check in login.ts' }] });
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('WAITING_APPROVAL');
    const approval = run.pendingApprovals[0]!;
    expect(approval.payload).toMatchObject({ kind: 'handoff', fromAgentId: 'claude', toAgentId: 'codex', instruction: 'Please review my fix' });
    expect(env.codex.calls).toHaveLength(0);

    await env.orchestrator.resolveApproval(task.id, approval.id, 'approve');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(env.codex.calls[0]?.prompt).toContain('Fixed null check in login.ts');
    expect(env.codex.calls[0]?.prompt).toContain('at the request of claude, approved by the operator');
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((x) => x.type === 'handoff.requested').map((x) => x.data.origin ?? x.data.reason)).toEqual(['agent', 'agent-request']);
  });

  it('declining a handoff request does not block the task', async () => {
    const env = boot({ claude: [{ kind: 'handoff', to: 'codex', instruction: 'Review' }] });
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    const approvalId = (await env.store.getRun(task.runId))!.pendingApprovals[0]!.id;
    await env.orchestrator.resolveApproval(task.id, approvalId, 'decline');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
    expect(env.codex.calls).toHaveLength(0);
  });

  it('policy auto: executes immediately, up to the limit, then falls back to operator approval', async () => {
    const request: TurnOutcome = { kind: 'handoff', to: 'codex', instruction: 'Review again' };
    const env = boot({ claude: [request, request, request, request, request] });
    const task = await env.orchestrator.createTask({ ...CHAT, handoffPolicy: 'auto' });
    await env.orchestrator.idle();
    for (let i = 0; i < 4; i++) {
      await env.orchestrator.sendMessage(task.id, 'claude', `round ${i}`);
      await env.orchestrator.idle();
    }
    const run = (await env.store.getRun(task.runId))!;
    // 第 1~4 次自動執行，第 5 次超出上限轉為審批
    expect(env.codex.calls).toHaveLength(4);
    expect(run.settings).toMatchObject({ handoffPolicy: 'auto', autoHandoffsUsed: 4 });
    expect(run.status).toBe('WAITING_APPROVAL');
    expect(run.pendingApprovals[0]?.payload).toMatchObject({ kind: 'handoff', autoLimitReached: true });
  });

  it('workflow tasks always ask, even with policy auto; invalid targets are rejected', async () => {
    const env = boot({ claude: [{ kind: 'handoff', to: 'codex', instruction: 'Take a look' }], tests: [true] });
    const task = await env.orchestrator.createTask({ ...CHAT, workflow: 'implementation-v1', testCommand: 'npm test', handoffPolicy: 'auto' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.pendingApprovals[0]?.payload).toMatchObject({ kind: 'handoff' });

    const bad = boot({ claude: [{ kind: 'handoff', to: 'test', instruction: 'Run' }] });
    const t2 = await bad.orchestrator.createTask(CHAT);
    await bad.orchestrator.idle();
    const events = await bad.store.listEvents(t2.runId);
    expect(events.find((x) => x.data.code === 'HANDOFF_REQUEST_REJECTED')?.data).toMatchObject({ reason: 'cannot hand off to the test runner' });
    expect((await bad.store.getRun(t2.runId))!.pendingApprovals).toHaveLength(0);
  });

  it('policy can be changed per task', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.orchestrator.setHandoffPolicy(task.id, 'auto');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.settings?.handoffPolicy).toBe('auto');
  });
});

describe('ask both', () => {
  it('sends to both agents: the primary may write, the other answers read-only', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...CHAT, askBoth: true });
    await env.orchestrator.idle();
    expect(env.claude.calls[0]).toMatchObject({ via: 'start', mode: 'implement', prompt: 'Fix the login bug' });
    expect(env.codex.calls[0]).toMatchObject({ via: 'start', mode: 'analysis' });
    expect(env.codex.calls[0]?.prompt).toContain('do NOT modify any files');
    const outgoing = (await env.store.listEvents(task.runId)).filter((x) => x.type === 'agent.message' && x.data.direction === 'to-agent');
    expect(outgoing.map((x) => [x.agentId, x.data.askBoth, x.data.advisory ?? false])).toEqual(
      expect.arrayContaining([
        ['claude', true, false],
        ['codex', true, true],
      ]),
    );
    // 已有會話時也可以隨時同時問兩個
    await env.orchestrator.askBoth(task.id, 'Any other risks?');
    await env.orchestrator.idle();
    expect(env.claude.calls.at(-1)).toMatchObject({ via: 'send', prompt: 'Any other risks?' });
    expect(env.codex.calls.at(-1)?.prompt).toContain('Any other risks?');
  });
});

describe('reassign', () => {
  it('chat: stops the busy agent and hands the task over with context', async () => {
    const env = boot({ claude: [{ kind: 'reply', text: 'Half way: edited login.ts' }], claudeFallback: { kind: 'silent' } });
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'claude', 'continue');
    await env.orchestrator.idle();
    await env.orchestrator.reassign(task.id, 'codex', 'Finish the remaining tests');
    await env.orchestrator.idle();
    expect(env.claude.cancels).toBe(1);
    expect(env.codex.calls[0]?.prompt).toContain('Half way: edited login.ts');
    expect(env.codex.calls[0]?.prompt).toContain('Finish the remaining tests');
    const events = await env.store.listEvents(task.runId);
    expect(events.find((x) => x.type === 'handoff.requested')?.data).toMatchObject({ reason: 'reassign', fromAgentId: 'claude', toAgentId: 'codex' });
    await expect(env.orchestrator.reassign(task.id, 'test')).rejects.toThrow(/test runner/);
  });

  it('workflow: a blocked task is continued by the new implementer, who then owns the remaining steps', async () => {
    const env = boot({ tests: [false, false, false, true] });
    const task = await env.orchestrator.createTask({ ...CHAT, workflow: 'implementation-v1', testCommand: 'npm test' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('BLOCKED');

    await env.orchestrator.reassign(task.id, 'codex', 'Try a different approach');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(run.workflowState?.agents).toMatchObject({ implement: 'codex', review: 'claude' });
    const reassigned = env.codex.calls.find((c) => c.prompt.includes('reassigned this task to you'));
    expect(reassigned?.prompt).toContain('Try a different approach');
    expect(run.workflowState?.history.some((h) => h.outcome === 'reassigned from claude')).toBe(true);
  });
});

describe('adapters expose structured / text handoff requests', () => {
  it('Claude registers request_handoff as an in-process tool and auto-allows it', async () => {
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn });
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'hi' }, () => undefined);
    const options = runtime.queries[0]!.options;
    expect(Object.keys(options.mcpServers ?? {})).toContain('acc');
    // P0-8 / M-13：不再寫進 allowedTools（避免整個跳過 canUseTool），由 canUseTool 核對來源是 ACC 自己的程序內 MCP 後自動放行
    expect(options.allowedTools ?? []).not.toContain(CLAUDE_HANDOFF_TOOL);
    const decision = await options.canUseTool!(CLAUDE_HANDOFF_TOOL, { to: 'codex', instruction: 'x' }, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r', mcpServer: { name: 'acc', source: 'sdk' } });
    expect(decision).toMatchObject({ behavior: 'allow' });
  });

  it('Codex text marker becomes an inferred handoff request and Codex is told the protocol', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), () => [{ kind: 'message', text: 'Root cause found in parser.\nHANDOFF@claude: apply the fix in parser.ts' }]);
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport });
    const events: Array<Parameters<EventSink>[0]> = [];
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'diagnose' }, (e) => {
      events.push(e);
    });
    const deadline = Date.now() + 2000;
    while (!events.some((e) => e.type === 'handoff.requested') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const request = events.find((e) => e.type === 'handoff.requested')!;
    expect(request).toMatchObject({ confidence: 'inferred', data: { origin: 'agent', via: 'text', toAgentId: 'claude', instruction: 'apply the fix in parser.ts' } });
    expect(String(request.data.content)).toContain('Root cause found in parser.');
    expect(String((server.received.find((x) => x.method === 'thread/start')?.params as { developerInstructions?: string }).developerInstructions)).toContain('HANDOFF@<agent>');
  });
});

describe('snapshot v4', () => {
  it('migrates v3 snapshots (no settings) and keeps default handoff policy', () => {
    const v3 = { ...makeRun(), schemaVersion: 3 };
    const migrated = deserializeRunSnapshot(JSON.stringify(v3));
    expect(migrated.schemaVersion).toBe(RUN_SNAPSHOT_SCHEMA_VERSION);
    expect(migrated.settings).toBeUndefined();
    expect(types([])).toEqual([]);
  });
});
