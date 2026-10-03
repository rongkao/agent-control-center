import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { ClaudeQueryDriver, echoScript } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { busRecorder, emitRecorder } from './fakes/event-waiter.js';

/**
 * P2-6 統一的提問（elicitation）：
 * - Claude 的 AskUserQuestion 與 Codex 的 item/tool/requestUserInput 都歸一成 kind='question' 的審批（帶 questions）；
 * - 操作員的答案按問題 ID 交回：Claude 寫進 AskUserQuestion 的 answers（問題原文 → 答案），Codex 回 {answers: {id: {answers}}}；
 * - 只接受審批裡有的問題 ID；機密問題的答案不寫進事件記錄。
 */

const quiet = () => undefined;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('P2-6：編排器', () => {
  it('答案交給 adapter；未知問題 ID 被丟棄；機密答案不進記錄', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    orchestrator.registerAdapter(claude);
    cleanups.push(() => orchestrator.shutdown());
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    await claude.emit(
      'approval.required',
      {
        approvalId: 'q-1',
        toolName: 'AskUserQuestion',
        kind: 'question',
        summary: 'Claude 想問你問題',
        questions: [
          { id: 'q0', header: 'DB', question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
          { id: 'q1', header: 'Token', question: 'API token?', options: [], allowOther: true, secret: true },
        ],
      },
      undefined,
      'warning',
    );
    await orchestrator.idle();
    expect((await store.getRun(task.runId))!.status).toBe('WAITING_APPROVAL');

    await orchestrator.resolveApproval(task.id, 'q-1', 'approve', 'once', { answers: { q0: ['SQLite'], q1: ['s3cr3t-value'], bogus: ['x'] } });
    await orchestrator.idle();
    expect(claude.approvals[0]).toMatchObject({ approvalId: 'q-1', decision: 'approve', answers: { q0: ['SQLite'], q1: ['s3cr3t-value'] } });
    expect(claude.approvals[0]!.answers).not.toHaveProperty('bogus');
    const resolved = (await store.listEvents(task.runId)).find((e) => e.type === 'approval.resolved')!;
    expect(resolved.data.answers).toEqual({ q0: ['SQLite'], q1: ['[機密，未記錄]'] });
    expect(JSON.stringify(await store.listEvents(task.runId))).not.toContain('s3cr3t-value');
  });
});

describe('P2-6：Claude AskUserQuestion', () => {
  it('以問題的形式請求審批；答案寫進 answers（問題原文 → 答案，多選用逗號分隔）', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acc-ask-'));
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const driver = new ClaudeQueryDriver(echoScript);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, defaultCwd: cwd });
    cleanups.push(() => adapter.dispose());
    const recorder = emitRecorder();
    const handle = await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'hi', mode: 'implement', cwd }, recorder.emit);
    const options: Options = (await driver.query(1)).options;
    const input = {
      questions: [
        { question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite', description: 'local' }, { label: 'Postgres', description: 'server' }] },
        { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
      ],
    };
    const decision = options.canUseTool!('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'toolu-q', requestId: 'req' } as Parameters<NonNullable<Options['canUseTool']>>[2]);
    const required = await recorder.waitFor((e) => e.type === 'approval.required');
    expect(required.data).toMatchObject({ kind: 'question', questions: [{ id: 'q0', question: 'Which DB?', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }, { id: 'q1', multiSelect: true }] });
    await adapter.approve(handle.sessionId, { approvalId: String(required.data.approvalId), decision: 'approve', answers: { q0: ['Postgres'], q1: ['A', 'B'] } }, recorder.emit);
    const result = (await decision) as PermissionResult & { updatedInput: Record<string, unknown> };
    expect(result.behavior).toBe('allow');
    expect(result.updatedInput.answers).toEqual({ 'Which DB?': 'Postgres', 'Which features?': 'A, B' });
  });
});

describe('P2-6：Codex requestUserInput', () => {
  it('以問題的形式請求審批；答案按問題 ID 交回', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), () => [
      { kind: 'userInput', id: 'ask', questions: [{ id: 'env', header: 'Env', question: 'Which environment?', options: [{ label: 'staging', description: '' }, { label: 'prod', description: '' }], isOther: false }] },
      { kind: 'message', text: 'ok' },
    ]);
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
    orchestrator.registerAdapter(new CodexAppServerAdapter({ transportFactory: () => server.transport }));
    const rec = busRecorder(bus);
    cleanups.push(async () => {
      rec.dispose();
      await orchestrator.shutdown();
    });
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'codex', workflow: 'manual' });
    const required = await rec.waitFor((e) => e.type === 'approval.required');
    expect(required.data).toMatchObject({ kind: 'question', toolName: 'request_user_input', questions: [{ id: 'env', question: 'Which environment?' }] });
    await orchestrator.idle();
    await orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve', 'once', { answers: { env: ['staging'] } });
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    expect(server.approvalResponses.find((r) => r.method === 'item/tool/requestUserInput')?.response).toEqual({ answers: { env: { answers: ['staging'] } } });
  });
});

describe('P2-6：過期與重啟後補投', () => {
  const ask = (agent: ControlledAgent, id: string) =>
    agent.emit('approval.required', { approvalId: id, toolName: 'AskUserQuestion', kind: 'question', summary: 'q', questions: [{ id: 'q0', header: 'H', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }, undefined, 'warning');

  it('超過 questionTimeoutMs 沒人回答：按跳過處理（空答案，resolvedBy=timeout），任務繼續', async () => {
    let now = Date.now();
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet, now: () => now, questionTimeoutMs: 10 * 60_000 });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    orchestrator.registerAdapter(claude);
    cleanups.push(() => orchestrator.shutdown());
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    await ask(claude, 'q-exp');
    await orchestrator.idle();
    expect(await orchestrator.expireQuestions()).toBe(0);
    now += 11 * 60_000;
    expect(await orchestrator.expireQuestions()).toBe(1);
    await orchestrator.idle();
    expect(claude.approvals[0]).toMatchObject({ approvalId: 'q-exp', decision: 'approve', answers: {} });
    const resolved = (await store.listEvents(task.runId)).find((e) => e.type === 'approval.resolved')!;
    expect(resolved.data.resolvedBy).toBe('timeout');
    expect((await store.getRun(task.runId))!.status).toBe('RUNNING');
  });

  it('答了之後程序崩潰、決定還沒交給 agent：重啟補投時帶上答案（機密答案除外）', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    // 模擬“決定記下了，但交給 agent 之前程序沒了”：approve 永遠不返回
    claude.approve = () => new Promise<void>(() => undefined);
    orchestrator.registerAdapter(claude);
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    await claude.emit(
      'approval.required',
      { approvalId: 'q-r', toolName: 'AskUserQuestion', kind: 'question', summary: 'q', questions: [{ id: 'q0', header: 'H', question: 'Which?', options: [{ label: 'A' }] }, { id: 'q1', header: 'P', question: 'Pw?', options: [], secret: true }] },
      undefined,
      'warning',
    );
    await orchestrator.idle();
    void orchestrator.resolveApproval(task.id, 'q-r', 'approve', 'once', { answers: { q0: ['A'], q1: ['hunter2'] } });
    await new Promise((r) => setTimeout(r, 100));
    expect((await store.getRun(task.runId))!.undeliveredDecisions?.[0]?.answers).toEqual({ q0: ['A'] });

    const restarted = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    const resumed: Array<Record<string, unknown>> = [];
    const agent2 = new ControlledAgent({ id: 'claude', kind: 'claude' });
    const original = agent2.resume.bind(agent2);
    agent2.resume = async (sessionId, input, emit) => {
      resumed.push(input as never);
      return original(sessionId, input, emit);
    };
    restarted.registerAdapter(agent2);
    cleanups.push(() => restarted.shutdown());
    await restarted.recover();
    await restarted.idle();
    expect((resumed[0]?.approval as { answers?: unknown } | undefined)?.answers).toEqual({ q0: ['A'] });
  });
});
