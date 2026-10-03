import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpAdapter, ClaudeAgentSdkAdapter, CodexAppServerAdapter, LocalTestRunnerAdapter, MockAgentAdapter } from '@acc/adapters';
import { FakeAcpAgent, type FakeAcpOptions } from '../fakes/fake-acp-agent.js';
import type { AgentAdapter, AgentStartInput, EventSink } from '@acc/core';
import { FakeCodexDisk, FakeCodexServer, type CodexScript } from '../fakes/fake-codex-server.js';
import { ClaudeQueryDriver, echoScript, type DriverScript } from './fakes/claude-query-driver.js';
import { deferred, turnEventLoop } from './fakes/deferred.js';
import { emitRecorder } from './fakes/event-waiter.js';
import { fakeSpawner, type FakeTestChild } from './fakes/fake-test-child.js';

/**
 * P0-6（H-10 / M-32）：AgentAdapter 的終態合約，四種實現（Claude、Codex、測試執行器、Mock）共用同一組斷言。
 *
 * 合約：每個派發出去的回合（start 的首輪、send、resume 引發的一輪）必須以且只以一個終態結束——
 * （P0 第二批審查補上了 resume 引發的一輪與重複取消的斷言：cancel 必須冪等，編排器在派發許可失效時會再取消一次）
 * agent.status completed / failed / cancelled，並儘量帶上回合 ID（data.turnId）。
 * 執行時報錯、程序崩潰或以退出碼 0 意外退出、provider 自己中斷回合，都要給出終態；取消之後執行時殘留的結果不能再產生第二個終態。
 *
 * 復現（修復前）：Claude 的 result 為 error_* / is_error 時只發 runtime.error、不發終態（probe5）；
 * Claude CLI 以退出碼 0 結束時什麼都不發，介面一直顯示“編碼中”；Codex 回合被中斷時只發 waiting；
 * Mock 取消之後定時器照樣發出 completed（兩個終態）。現有測試從不斷言終態，所以一直沒發現。
 */

type Emitted = Parameters<EventSink>[0];
type Recorder = ReturnType<typeof emitRecorder>;

const quiet = () => undefined;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const terminals = (events: Emitted[]) => events.filter((e) => e.type === 'agent.status' && TERMINAL.has(String(e.data.status)));
const closedSignals = (events: Emitted[]) => events.filter((e) => e.data.sessionClosed === true);

const INPUT: AgentStartInput = {
  projectId: 'local',
  taskId: 'task-1',
  runId: 'run-1',
  prompt: 'first',
  cwd: process.platform === 'win32' ? 'C:\\repo' : '/repo',
  mode: 'implement',
  context: { testCommand: 'npm test' },
};

interface Rig {
  adapter: AgentAdapter;
  rec: Recorder;
  /** 這一輪已經在執行時裡開始（用於取消 / 丟失執行時之前的同步點）。 */
  inProgress: Promise<void>;
  /** 讓執行時丟失（崩潰、斷開、程序退出）。 */
  lose?: () => void;
}

interface Harness {
  name: string;
  /** 每一輪都會自己正常結束。 */
  normal(): Rig;
  /** 第一輪開始後一直不結束（直到被取消）。 */
  hanging(): Rig;
  /** 第一輪以執行時報告的錯誤結束。 */
  failing?(): Rig;
  /** 第一輪進行中執行時丟失（lose()）。 */
  lostMidTurn?(): Rig;
  /** 一輪正常結束之後執行時丟失（lose()）：會話已經空閒，不能再多出一個終態。 */
  lostIdle?(): Rig;
  /** provider 自己中斷了這一輪（不是編排器請求的取消）。 */
  interrupted?(): Rig;
  /** 等到出現 n 個終態。 */
  waitTerminals(rig: Rig, n: number): Promise<void>;
  /** 讓殘留的非同步事件浮現（證明終態之後不會再有終態）。 */
  flush(): Promise<void>;
  setup?(): void;
  teardown?(): void;
}

const waitForTerminals = (rig: Rig, n: number) => rig.rec.waitFor(() => terminals(rig.rec.events).length >= n).then(() => undefined);

// ---------------------------------------------------------------- Claude（真實 adapter + 可逐步驅動的假 query）
function claudeRig(script: DriverScript, inProgress: Promise<void> = Promise.resolve(), lose?: () => void): Rig {
  const driver = new ClaudeQueryDriver(script);
  return { adapter: new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet }), rec: emitRecorder(), inProgress, lose };
}

const claude: Harness = {
  name: 'Claude',
  normal: () => claudeRig(echoScript),
  hanging: () => {
    const started = deferred();
    return claudeRig(async (q) => {
      q.init();
      await q.nextPrompt();
      started.resolve(); // 這一輪開始了，但一直不給 result
    }, started.promise);
  },
  failing: () =>
    claudeRig(async (q) => {
      q.init();
      await q.nextPrompt();
      q.assistantError('overloaded');
      q.result({ isError: true, apiErrorStatus: 529, text: 'API Error: 529 overloaded' });
    }),
  lostMidTurn: () => {
    const started = deferred();
    const lost = deferred();
    return claudeRig(
      async (q) => {
        q.init();
        await q.nextPrompt();
        started.resolve();
        await lost.promise;
        q.end(); // CLI 以退出碼 0 結束：訊息流正常結束，但這一輪沒有 result
      },
      started.promise,
      () => lost.resolve(),
    );
  },
  lostIdle: () => {
    const done = deferred();
    const lost = deferred();
    return claudeRig(
      async (q) => {
        q.init();
        await q.nextPrompt();
        q.result();
        done.resolve();
        await lost.promise;
        q.end();
      },
      done.promise,
      () => lost.resolve(),
    );
  },
  waitTerminals: waitForTerminals,
  flush: () => turnEventLoop(10),
};

// ---------------------------------------------------------------- Codex（真實 adapter + 假 app-server）
function codexRig(script: CodexScript, inProgress?: (rec: Recorder) => Promise<void>): Rig {
  const server = new FakeCodexServer(new FakeCodexDisk(), script);
  const rec = emitRecorder();
  return {
    adapter: new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: INPUT.cwd, log: quiet }),
    rec,
    inProgress: inProgress ? inProgress(rec) : Promise.resolve(),
    lose: () => server.crash('app-server crashed'),
  };
}

/** 需要審批的命令：這一輪停在審批上，直到被取消或執行時丟失。 */
const awaitingApproval: CodexScript = () => [{ kind: 'command', id: 'X', command: 'npm run long', needsApproval: true }];
const approvalRequested = (rec: Recorder) => rec.waitFor((e) => e.type === 'approval.required').then(() => undefined);

const codex: Harness = {
  name: 'Codex',
  normal: () => codexRig(() => [{ kind: 'message', text: 'ok' }]),
  hanging: () => codexRig(awaitingApproval, approvalRequested),
  failing: () => codexRig(() => [{ kind: 'error', info: 'usageLimitExceeded' }]),
  lostMidTurn: () => codexRig(awaitingApproval, approvalRequested),
  lostIdle: () => codexRig(() => [{ kind: 'message', text: 'ok' }], (rec) => rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed').then(() => undefined)),
  interrupted: () => codexRig(() => [{ kind: 'message', text: 'partial' }, { kind: 'interrupted' }]),
  waitTerminals: waitForTerminals,
  flush: () => turnEventLoop(20),
};

// ---------------------------------------------------------------- 測試執行器（真實 adapter + 假子程序）
let children: FakeTestChild[] = [];

function testRunnerRig(finish: 'ok' | 'never' | 'spawn-error'): Rig {
  const spawner = fakeSpawner();
  children = spawner.children;
  const spawn = (command: string) => {
    const child = spawner.spawn(command);
    const fake = spawner.children.at(-1)!;
    if (finish === 'ok') setImmediate(() => fake.finish(0, 'all tests passed\n'));
    if (finish === 'spawn-error') setImmediate(() => fake.emit('error', Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const rec = emitRecorder();
  return {
    adapter: new LocalTestRunnerAdapter({ spawn, log: quiet }),
    rec,
    inProgress: finish === 'never' ? spawner.next(1).then(() => undefined) : Promise.resolve(),
  };
}

const testRunner: Harness = {
  name: '測試執行器',
  normal: () => testRunnerRig('ok'),
  hanging: () => testRunnerRig('never'),
  // 子程序啟動失敗（只有 error、沒有 close）：這一輪也必須結束（測試失敗），不能一直等下去
  failing: () => testRunnerRig('spawn-error'),
  waitTerminals: waitForTerminals,
  flush: async () => {
    // 被取消的程序最終會退出：讓它的 close 事件到達，證明 adapter 不會因此再發一個終態
    for (const child of children) if (child.listenerCount('close') > 0) child.finish(null);
    await turnEventLoop(10);
  },
};

// ---------------------------------------------------------------- Mock（定時器驅動，用假時鐘推進）
const mock: Harness = {
  name: 'Mock',
  normal: () => ({ adapter: new MockAgentAdapter({ id: 'claude', name: 'Claude', kind: 'claude', ready: true, capabilities: ['implement'] }, { log: quiet }), rec: emitRecorder(), inProgress: Promise.resolve() }),
  hanging: () => mock.normal(),
  waitTerminals: async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  },
  flush: async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  },
  setup: () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
  teardown: () => vi.useRealTimers(),
};

// ---------------------------------------------------------------- ACP（真實 adapter + 記憶體裡的假 ACP agent，P2-1）
function acpRig(options: FakeAcpOptions): Rig {
  const fake = new FakeAcpAgent(options);
  let transport: ReturnType<FakeAcpAgent['transport']> | undefined;
  const rec = emitRecorder();
  return {
    adapter: new AcpAdapter({
      id: 'gemini',
      command: 'gemini',
      log: quiet,
      transportFactory: () => (transport = fake.transport()),
    }),
    rec,
    inProgress: rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'coding').then(() => undefined),
    lose: () => transport?.close(),
  };
}

const acpHarness: Harness = {
  name: 'ACP',
  normal: () => acpRig({}),
  hanging: () => acpRig({ hang: true }),
  failing: () => acpRig({ fail: true }),
  lostMidTurn: () => acpRig({ hang: true }),
  lostIdle: () => acpRig({}),
  waitTerminals: waitForTerminals,
  flush: () => turnEventLoop(20),
};

describe.each([claude, codex, testRunner, mock, acpHarness])('AgentAdapter 終態合約：$name', (h) => {
  beforeEach(() => h.setup?.());
  afterEach(() => h.teardown?.());

  it('每個派發出去的回合（start 的首輪、send）以且只以一個終態結束，終態帶回合 ID', async () => {
    const rig = h.normal();
    const handle = await rig.adapter.start(INPUT, rig.rec.emit);
    await h.waitTerminals(rig, 1);
    await rig.adapter.send(handle.sessionId, 'second', rig.rec.emit);
    await h.waitTerminals(rig, 2);
    await h.flush();

    const done = terminals(rig.rec.events);
    expect(done.map((e) => e.data.status)).toEqual(['completed', 'completed']);
    for (const event of done) {
      expect(event.sessionId).toBe(handle.sessionId);
      expect(typeof event.data.turnId === 'string' && event.data.turnId.length > 0).toBe(true);
    }
    expect(new Set(done.map((e) => e.data.turnId)).size).toBe(2);
  });

  it('續接引發的一輪（會話仍在本程序裡）同樣以且只以一個終態結束，終態帶新的回合 ID', async () => {
    const rig = h.normal();
    const handle = await rig.adapter.start(INPUT, rig.rec.emit);
    await h.waitTerminals(rig, 1);
    await rig.adapter.resume!(
      handle.sessionId,
      {
        projectId: INPUT.projectId,
        taskId: INPUT.taskId,
        runId: INPUT.runId,
        agentId: rig.adapter.info.id,
        reason: 'message',
        message: 'continue',
        step: 'implement',
        completedSideEffectIds: [],
        lastSequence: 0,
        metadata: { providerSessionId: handle.providerSessionId ?? handle.sessionId, cwd: INPUT.cwd, mode: INPUT.mode, testCommand: 'npm test' },
      },
      rig.rec.emit,
    );
    await h.waitTerminals(rig, 2);
    await h.flush();

    const done = terminals(rig.rec.events);
    expect(done.map((e) => e.data.status)).toEqual(['completed', 'completed']);
    for (const event of done) expect(typeof event.data.turnId === 'string' && event.data.turnId.length > 0).toBe(true);
    expect(new Set(done.map((e) => e.data.turnId)).size).toBe(2);
  });

  it('重複取消是冪等的（編排器在派發許可失效時會再取消一次）：仍然只有一個終態 cancelled', async () => {
    const rig = h.hanging();
    const handle = await rig.adapter.start(INPUT, rig.rec.emit);
    await rig.inProgress;
    await rig.adapter.cancel(handle.sessionId, rig.rec.emit);
    await rig.adapter.cancel(handle.sessionId, rig.rec.emit);
    await h.flush();

    expect(terminals(rig.rec.events).map((e) => e.data.status)).toEqual(['cancelled']);
  });

  it('取消進行中的回合：只有一個終態 cancelled，執行時殘留的結果不會再產生終態', async () => {
    const rig = h.hanging();
    const handle = await rig.adapter.start(INPUT, rig.rec.emit);
    await rig.inProgress;
    await rig.adapter.cancel(handle.sessionId, rig.rec.emit);
    await h.flush();

    expect(terminals(rig.rec.events).map((e) => e.data.status)).toEqual(['cancelled']);
  });

  it.runIf(h.failing)('執行時報告錯誤：這一輪仍然以且只以一個終態結束', async () => {
    const rig = h.failing!();
    await rig.adapter.start(INPUT, rig.rec.emit);
    await h.waitTerminals(rig, 1);
    await h.flush();

    const done = terminals(rig.rec.events);
    expect(done).toHaveLength(1);
    if (h.name !== '測試執行器') {
      // provider 報錯：先有歸一化的 runtime.error，再以 failed 結束
      expect(done[0]!.data.status).toBe('failed');
      expect(rig.rec.events.some((e) => e.type === 'runtime.error')).toBe(true);
    } else {
      // 測試命令沒能執行：按測試失敗結束（fail closed），工作流據此進入重試 / 診斷
      expect(done[0]!.data).toMatchObject({ status: 'completed', testPassed: false });
    }
  });

  it.runIf(h.lostMidTurn)('這一輪進行中執行時丟失（崩潰 / 斷開 / 以退出碼 0 退出）：發出 sessionClosed 的錯誤和一個 failed', async () => {
    const rig = h.lostMidTurn!();
    await rig.adapter.start(INPUT, rig.rec.emit);
    await rig.inProgress;
    rig.lose!();
    await h.waitTerminals(rig, 1);
    await h.flush();

    expect(terminals(rig.rec.events).map((e) => e.data.status)).toEqual(['failed']);
    const closed = closedSignals(rig.rec.events);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ type: 'runtime.error', data: { retryable: true } });
  });

  it.runIf(h.lostIdle)('會話空閒時執行時丟失：只報告會話已關閉，不會給已經結束的回合再加一個終態', async () => {
    const rig = h.lostIdle!();
    await rig.adapter.start(INPUT, rig.rec.emit);
    await rig.inProgress;
    await h.waitTerminals(rig, 1);
    rig.lose!();
    await rig.rec.waitFor((e) => e.data.sessionClosed === true);
    await h.flush();

    expect(terminals(rig.rec.events).map((e) => e.data.status)).toEqual(['completed']);
    expect(closedSignals(rig.rec.events)).toHaveLength(1);
  });

  it.runIf(h.interrupted)('provider 自己中斷了這一輪：以 failed 結束（可重試），不再只發 waiting', async () => {
    const rig = h.interrupted!();
    await rig.adapter.start(INPUT, rig.rec.emit);
    await h.waitTerminals(rig, 1);
    await h.flush();

    const done = terminals(rig.rec.events);
    expect(done.map((e) => e.data.status)).toEqual(['failed']);
    expect(done[0]!.data).toMatchObject({ interrupted: true });
    expect(typeof done[0]!.data.turnId).toBe('string');
    expect(rig.rec.events.find((e) => e.type === 'runtime.error')?.data).toMatchObject({ code: 'CODEX_TURN_INTERRUPTED', retryable: true });
    expect(rig.rec.events.some((e) => e.type === 'agent.status' && e.data.status === 'waiting')).toBe(false);
  });
});
