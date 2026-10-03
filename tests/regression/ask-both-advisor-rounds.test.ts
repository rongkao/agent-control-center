import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter, CreateTaskInput, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk } from '../fakes/fake-claude-runtime.js';
import { FakeCodexDisk, type CodexScript } from '../fakes/fake-codex-server.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { deferred } from './fakes/deferred.js';
import { busRecorder, emitRecorder } from './fakes/event-waiter.js';
import { PermissionModeClaudeRuntime } from './fakes/permission-mode-claude.js';
import { WorkspaceCodexServer } from './fakes/workspace-codex-server.js';
import { handoffRequestNotice } from '../../apps/web/src/approval-ui.js';

/**
 * P0 第三批審查：Ask Both 顧問“這一輪唯讀”的邊界。
 *
 * 現象（修復前）：
 * - 顧問正在以可寫方式做它自己的一輪時按「同時問」：Codex adapter 拒絕把唯讀的一步 steer 進可寫回合，
 *   編排器把整個任務 fail closed 為 BLOCKED（ADAPTER_SEND_FAILED，介面只有英文說明）；
 * - Claude adapter 在訊息入隊時就切換權限模式：正在進行的可寫一輪被中途降為 plan；
 *   反過來，唯讀的顧問輪還在進行（或排隊）時操作員再發一條普通訊息，模式又被切回 default，顧問輪以可寫模式執行；
 * - “這一輪唯讀”只在派發那一刻傳給 adapter，沒有持久化：預算停止後「放寬預算並繼續」、服務重啟後續跑，
 *   之前可寫的會話按會話啟動模式（workspace-write）續跑，和主 agent 同時寫同一個工作區；
 * - 主 agent 的會話是隻讀啟動的（它之前是顧問），給另一方的編排器說明卻寫著它 “has write access”（M-3 過渡）。
 */

const quiet = () => undefined;
const MIN = 60_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-askboth-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(agents: { claude?: AgentAdapter; codex?: AgentAdapter } = {}, options: { store?: InMemoryControlPlaneStore; now?: () => number } = {}) {
  const store = options.store ?? new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet, ...(options.now ? { now: options.now } : {}) });
  const claude = agents.claude ?? new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = agents.codex ?? new ControlledAgent({ id: 'codex', kind: 'codex' });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  const rec = busRecorder(bus);
  cleanups.push(async () => {
    rec.dispose();
    await orchestrator.shutdown();
  });
  return { store, bus, orchestrator, claude, codex, rec };
}

const chat = (cwd: string, agentId = 'claude', prompt = 'Fix the login bug'): CreateTaskInput => ({ title: 'chat', prompt, agentId, workflow: 'manual', cwd });

const completedTurns = (events: UnifiedEvent[], agentId: string) => events.filter((e) => e.agentId === agentId && e.type === 'agent.status' && e.data.status === 'completed').length;

describe('顧問正忙（可寫的一輪還沒結束）時按「同時問」', () => {
  it('Codex：任務不會 BLOCKED，這一輪只問主 agent，並用中文說明為什麼沒問 Codex', async () => {
    const gate = deferred();
    const disk = new FakeCodexDisk();
    const script: CodexScript = (ctx) => (ctx.text.includes('implement') ? [{ kind: 'pause', until: gate.promise }, { kind: 'message', text: 'implemented' }] : [{ kind: 'message', text: 'advice' }]);
    const server = new WorkspaceCodexServer(disk, script);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: quiet });
    const env = boot({ codex });
    cleanups.push(() => gate.resolve());
    const task = await env.orchestrator.createTask(chat(tempWorkspace()));
    await env.orchestrator.idle();
    // 操作員直接讓 Codex 做事：Codex 以可寫方式開始一輪長的工作
    await env.orchestrator.sendMessage(task.id, 'codex', 'please implement the parser');
    await env.orchestrator.idle();

    await env.orchestrator.askBoth(task.id, 'Any risks?');
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    expect(run.blockedBy).toBeUndefined();
    // 沒有把唯讀的一步塞進 Codex 正在進行的可寫回合
    expect(server.received.filter((x) => x.method === 'turn/steer')).toEqual([]);
    // 主 agent 照常收到問題
    expect((env.claude as ControlledAgent).calls.at(-1)).toMatchObject({ via: 'send', prompt: 'Any risks?' });
    const events = await env.store.listEvents(task.runId);
    const busy = events.find((e) => e.type === 'runtime.warning' && e.data.code === 'ASK_BOTH_ADVISOR_BUSY');
    expect(busy?.agentId).toBe('codex');
    expect(String(busy?.data.message)).toMatch(/Codex 正在工作/);
    expect(String(busy?.data.message)).toMatch(/只問/);
    // 只扣了實際派發的那一次呼叫
    expect(events.filter((e) => e.type === 'runtime.error')).toEqual([]);

    gate.resolve();
    await env.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');
  });

  it('Claude：正在進行的可寫一輪不會被中途降為 plan（這一輪不問它，說明原因）', async () => {
    const gate = deferred();
    const started = deferred();
    const runtime = new PermissionModeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      if (ctx.prompt.includes('implement')) {
        started.resolve();
        await gate.promise;
      }
    });
    const claude = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    const env = boot({ claude });
    cleanups.push(() => gate.resolve());
    const task = await env.orchestrator.createTask(chat(tempWorkspace(), 'claude', 'please implement the parser'));
    await started.promise;

    await env.orchestrator.askBoth(task.id, 'Any risks?', 'codex');
    await env.orchestrator.idle();
    // 正在進行的可寫一輪：權限模式沒有被改動
    expect(runtime.modeChanges[0]).toEqual([]);
    const events = await env.store.listEvents(task.runId);
    const busy = events.find((e) => e.type === 'runtime.warning' && e.data.code === 'ASK_BOTH_ADVISOR_BUSY');
    expect(busy?.agentId).toBe('claude');
    // Codex 成為主 agent，以可寫方式回答
    expect((env.codex as ControlledAgent).calls.at(-1)).toMatchObject({ via: 'start', mode: 'implement' });

    gate.resolve();
    await env.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    expect(runtime.turnModes[0]).toEqual(['default']);
    expect((await env.store.getRun(task.runId))!.status).toBe('RUNNING');
  });
});

describe('Claude adapter：每一輪在真正開始時才切換成它自己的權限模式', () => {
  const ids = { projectId: 'p', taskId: 't', runId: 'r' };

  it('可寫的一輪進行中又排進一個唯讀輪和一個普通輪：三輪依次是 default、plan、default，進行中的一輪從不被改', async () => {
    const gate = deferred();
    const started = deferred();
    const endModes: string[] = [];
    const runtime = new PermissionModeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      if (ctx.prompt === 'first') {
        started.resolve();
        await gate.promise;
      }
      endModes.push(String(ctx.options.permissionMode));
    });
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    cleanups.push(() => adapter.dispose());
    cleanups.push(() => gate.resolve());
    const rec = emitRecorder();
    const handle = await adapter.start({ ...ids, prompt: 'first', mode: 'implement', cwd: tempWorkspace() }, rec.emit);
    await started.promise;

    await adapter.send(handle.sessionId, 'advice please', rec.emit, { mode: 'analysis' });
    await adapter.send(handle.sessionId, 'normal work', rec.emit, { mode: 'implement' });
    // 第一輪還在進行：什麼都沒有切換
    expect(runtime.modeChanges[0]).toEqual([]);

    gate.resolve();
    await rec.waitFor(() => rec.events.filter((e) => e.type === 'agent.status' && e.data.status === 'completed').length >= 3);
    expect(runtime.turnModes[0]).toEqual(['default', 'plan', 'default']);
    expect(endModes).toEqual(['default', 'plan', 'default']);
    // 每一輪都以且只以一個終態結束
    expect(rec.events.filter((e) => e.type === 'agent.status' && (e.data.status === 'completed' || e.data.status === 'failed'))).toHaveLength(3);
  });

  it('編排器：唯讀的顧問輪進行中，操作員又給 Claude 發了一條普通訊息——顧問輪仍以 plan 做完，普通訊息之後才切回 default', async () => {
    const gate = deferred();
    const advising = deferred();
    const endModes: string[] = [];
    const runtime = new PermissionModeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      if (ctx.prompt.startsWith('[Orchestrator note]')) {
        advising.resolve();
        await gate.promise;
      }
      endModes.push(String(ctx.options.permissionMode));
    });
    const claude = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    const env = boot({ claude });
    cleanups.push(() => gate.resolve());
    const task = await env.orchestrator.createTask(chat(tempWorkspace()));
    await env.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();

    await env.orchestrator.askBoth(task.id, 'Any risks?', 'codex');
    await advising.promise;
    await env.orchestrator.sendMessage(task.id, 'claude', 'please also update the docs');
    await env.orchestrator.idle();
    // 顧問輪還在進行：沒有被切回可寫
    expect(runtime.modeChanges[0]).toEqual(['plan']);

    gate.resolve();
    await env.rec.waitFor(() => completedTurns(env.rec.events, 'claude') >= 3);
    await env.orchestrator.idle();
    expect(runtime.turnModes[0]).toEqual(['default', 'plan', 'default']);
    expect(endModes).toEqual(['default', 'plan', 'default']);
  });
});

describe('顧問這一輪的唯讀在「放寬預算並繼續」和重啟恢復之後仍然有效', () => {
  /** 之前可寫的 Codex（對話任務的主 agent）在「同時問」裡當顧問：這一輪停在唯讀回合裡。 */
  async function codexAdvising(options: { now?: () => number; store?: InMemoryControlPlaneStore; disk?: FakeCodexDisk; threadCwds?: Map<string, string> } = {}) {
    const disk = options.disk ?? new FakeCodexDisk();
    const threadCwds = options.threadCwds ?? new Map<string, string>();
    const hold = deferred();
    cleanups.push(() => hold.resolve());
    const script: CodexScript = (ctx) => (ctx.text.startsWith('[Orchestrator note] The same request') ? [{ kind: 'pause', until: hold.promise }, { kind: 'message', text: 'advice' }] : [{ kind: 'message', text: 'ok' }]);
    const server = new WorkspaceCodexServer(disk, script, threadCwds);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: quiet });
    const env = boot({ codex }, options);
    const task = await env.orchestrator.createTask(chat(tempWorkspace(), 'codex', 'please implement the parser'));
    await env.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    expect(server.paramsOf('thread/start')).toMatchObject({ sandbox: 'workspace-write' });

    await env.orchestrator.askBoth(task.id, 'Any risks?', 'claude');
    // 等 Codex 的顧問回合真正開始（turn/started 已經落盤，會話處於工作狀態）
    await env.rec.waitFor(() => env.rec.events.filter((e) => e.agentId === 'codex' && e.type === 'model.turn.started').length >= 2);
    await env.orchestrator.idle();
    const advisoryTurn = server.received.filter((x) => x.method === 'turn/start').at(-1)!.params as Record<string, unknown>;
    expect(advisoryTurn.sandboxPolicy).toMatchObject({ type: 'readOnly' });
    return { env, task, server, disk, threadCwds };
  }

  it('預算停止 → 放寬預算並繼續：Codex 續跑時仍是 read-only 沙箱', async () => {
    const clock = { now: 1_000_000 };
    const { env, task, server } = await codexAdvising({ now: () => clock.now });
    clock.now += 61 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!).toMatchObject({ status: 'BLOCKED', blockedBy: { source: 'budget' } });

    const result = await env.orchestrator.adjustBudget(task.id, { relax: true });
    await env.orchestrator.idle();
    expect(result.resumed).toBe(true);
    const resumed = server.received.filter((x) => x.method === 'thread/resume');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.params).toMatchObject({ sandbox: 'read-only' });
  });

  it('服務重啟後續跑：Codex 續跑時仍是 read-only 沙箱', async () => {
    const store = new InMemoryControlPlaneStore();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const { task } = await codexAdvising({ store, disk, threadCwds });

    // “重啟”：同一份資料，新的編排器和 adapter 實例
    const server2 = new WorkspaceCodexServer(disk, () => [{ kind: 'message', text: 'continued' }], threadCwds);
    const codex2 = new CodexAppServerAdapter({ transportFactory: () => server2.transport, log: quiet });
    const second = boot({ codex: codex2 }, { store });
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.resumed).toEqual([task.runId]);
    expect(server2.paramsOf('thread/resume')).toMatchObject({ sandbox: 'read-only' });
  });

  it('顧問這一輪做完之後，下一條普通訊息恢復會話原來的可寫模式', async () => {
    const clock = { now: 1_000_000 };
    const { env, task, server } = await codexAdvising({ now: () => clock.now });
    clock.now += 61 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.adjustBudget(task.id, { relax: true });
    await env.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed' && completedTurns(env.rec.events, 'codex') >= 2);
    await env.orchestrator.idle();
    await env.orchestrator.sendMessage(task.id, 'codex', 'now implement it');
    await env.orchestrator.idle();
    const last = server.received.filter((x) => x.method === 'turn/start').at(-1)!.params as Record<string, unknown>;
    expect(last.sandboxPolicy).toMatchObject({ type: 'workspaceWrite' });
  });

  it('顧問輪被預算停止後，操作員直接恢復並給 Codex 一條新的（可寫）指令：它在做這一輪時再「同時問」，仍按“正忙”處理，不會 BLOCKED', async () => {
    const clock = { now: 1_000_000 };
    const hold = deferred();
    cleanups.push(() => hold.resolve());
    const script: CodexScript = (ctx) =>
      ctx.text.startsWith('[Orchestrator note] The same request') || ctx.text.includes('implement it now') ? [{ kind: 'pause', until: hold.promise }, { kind: 'message', text: 'done' }] : [{ kind: 'message', text: 'ok' }];
    const server = new WorkspaceCodexServer(new FakeCodexDisk(), script);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport, log: quiet });
    const env = boot({ codex }, { now: () => clock.now });
    const task = await env.orchestrator.createTask(chat(tempWorkspace(), 'codex', 'please implement the parser'));
    await env.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.askBoth(task.id, 'Any risks?', 'claude');
    await env.rec.waitFor(() => env.rec.events.filter((e) => e.agentId === 'codex' && e.type === 'model.turn.started').length >= 2);
    clock.now += 61 * MIN;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('BLOCKED');

    // 不放寬預算，而是「恢復並傳送」一條新的指令給 Codex：這是新的一輪，按它自己的可寫模式續跑
    await env.orchestrator.sendMessage(task.id, 'codex', 'implement it now', { resume: true });
    await env.rec.waitFor(() => env.rec.events.filter((e) => e.agentId === 'codex' && e.type === 'model.turn.started').length >= 3);
    await env.orchestrator.idle();
    expect(server.paramsOf('thread/resume')).toMatchObject({ sandbox: 'workspace-write' });

    await env.orchestrator.askBoth(task.id, 'And now?', 'claude');
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('RUNNING');
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'runtime.warning' && e.data.code === 'ASK_BOTH_ADVISOR_BUSY' && e.agentId === 'codex')).toHaveLength(1);
    expect(server.received.filter((x) => x.method === 'turn/steer')).toEqual([]);
  });
});

describe('主 agent 的會話是隻讀啟動的（M-3 過渡）：說明文字按實際模式寫', () => {
  it('「同時問」選之前的唯讀顧問當主 agent：給另一方的說明不再聲稱它 “has write access”', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...chat(tempWorkspace()), askBoth: true });
    await env.orchestrator.idle();
    expect((env.codex as ControlledAgent).calls[0]).toMatchObject({ mode: 'analysis' });
    await (env.claude as ControlledAgent).complete('done');
    await (env.codex as ControlledAgent).complete('advice');
    await env.orchestrator.idle();

    await env.orchestrator.askBoth(task.id, 'What next?', 'codex');
    await env.orchestrator.idle();
    const advisory = (env.claude as ControlledAgent).calls.at(-1)!;
    expect(advisory.mode).toBe('analysis');
    expect(advisory.prompt).not.toMatch(/has write access/);
    expect(advisory.prompt).toMatch(/read-only/);
  });

  it('換隻讀的顧問接手（P1-4 / M-3）：唯讀的舊對話結束，為它開一個新的可寫對話，並告訴操作員', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...chat(tempWorkspace()), askBoth: true });
    await env.orchestrator.idle();
    await env.orchestrator.reassign(task.id, 'codex', 'Take over');
    await env.orchestrator.idle();
    const codex = env.codex as ControlledAgent;
    // 舊的唯讀會話沒有被放寬：接手走的是一個新的會話（start），模式是可寫的實現者
    expect(codex.calls.at(-1)).toMatchObject({ via: 'start', mode: 'implement' });
    const events = await env.store.listEvents(task.runId);
    const warning = events.find((e) => e.type === 'runtime.warning' && e.data.code === 'READ_ONLY_TAKEOVER');
    expect(warning?.agentId).toBe('codex');
    expect(String(warning?.data.message)).toMatch(/新的對話/);
  });
});

describe('權限傳遞契約的另一個方向：唯讀的來源不能借 auto 交接驅動可寫的目標', () => {
  it('Ask Both 裡唯讀的 Claude 顧問用 request_handoff 請求交給可寫的主 agent：auto 策略下也轉人工審批，不自動執行', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...chat(tempWorkspace(), 'codex'), askBoth: true, handoffPolicy: 'auto' });
    await env.orchestrator.idle();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    expect(claude.calls[0]).toMatchObject({ mode: 'analysis' });
    expect(codex.calls[0]).toMatchObject({ mode: 'implement' });
    const before = codex.calls.length;

    // 結構化的請求（confidence = confirmed），來源這一輪唯讀、目標可寫
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Apply my suggested patch', content: 'patch' });
    await env.orchestrator.idle();
    expect(codex.calls.slice(before)).toEqual([]);
    const run = (await env.store.getRun(task.runId))!;
    expect(run.settings?.autoHandoffsUsed).toBe(0);
    const approval = run.pendingApprovals.find((x) => x.payload?.kind === 'handoff');
    expect(approval?.payload).toMatchObject({ fromAgentId: 'claude', toAgentId: 'codex', readOnlySource: true, inferred: false });
    expect(handoffRequestNotice(approval?.payload)).toMatch(/只能讀/);
  });

  it('可寫的來源交給唯讀的目標（原來的方向）：auto 策略照常自動執行', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...chat(tempWorkspace()), askBoth: true, handoffPolicy: 'auto' });
    await env.orchestrator.idle();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Review', content: 'diff' });
    await env.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
    expect((await env.store.getRun(task.runId))!.settings?.autoHandoffsUsed).toBe(1);
  });
});
