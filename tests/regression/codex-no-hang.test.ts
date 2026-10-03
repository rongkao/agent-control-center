import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeCodexDisk, FakeCodexServer, type CodexScript } from '../fakes/fake-codex-server.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P0-6（H-10 / H-11，Codex 部分）：Codex 的回合失敗、被中斷或 app-server 斷開之後，工作流按規則重試，不會卡住或誤入 BLOCKED。
 *
 * 復現（修復前）：
 * - probe 場景 6：app-server 在回合進行中崩潰 → handleClose 把會話標為關閉，發出 CODEX_TRANSPORT_CLOSED(retryable) + failed；
 *   工作流按可重試再派發一次，但會話還登記在線上表裡 → send 拋 “closed” → ADAPTER_SEND_FAILED → BLOCKED，
 *   本該自動重試 1 次的傳輸重試形同虛設，只能重啟整個控制面。
 * - 回合被中斷（interrupted，不是編排器請求的取消）時只發 waiting，工作流一直等下去。
 * - 派發途中 app-server 斷開（turn/start 發出後連線關閉）：send 拋錯 → BLOCKED。
 *
 * 期望：會話移出線上表，重試改走 resume（重新連線 app-server，thread/resume 原來的執行緒）；
 * 會話仍然線上時（只是這一輪失敗）續接直接在同一執行緒上繼續；被中斷的回合以 failed（可重試）結束。
 */

const quiet = () => undefined;
/** 假 app-server 的 thread/resume 固定回報 cwd '/w'：任務就建在 '/w'（續接時會核對 cwd，H-4）。 */
const CWD = '/w';
const TASK: CreateTaskInput = { title: 'fix', prompt: 'Fix the login bug', agentId: 'codex', testCommand: 'npm test' };

function boot(script: CodexScript, options: { tests?: boolean[]; onServer?: (server: FakeCodexServer, index: number) => void } = {}) {
  const disk = new FakeCodexDisk();
  const servers: FakeCodexServer[] = [];
  const adapter = new CodexAppServerAdapter({
    // 每次連線都是一個新的 app-server 程序（執行緒記錄在共享的 disk 裡，可以 thread/resume）
    transportFactory: () => {
      const server = new FakeCodexServer(disk, script);
      servers.push(server);
      options.onServer?.(server, servers.length);
      return server.transport;
    },
    defaultCwd: CWD,
    log: quiet,
  });
  const store = new InMemoryControlPlaneStore();
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: CWD, workspacePolicy: 'shared', log: quiet });
  const tester = new WorkflowAgent({ id: 'test', kind: 'test', capabilities: ['test'] }, (options.tests ?? []).map((passed) => ({ kind: 'test' as const, passed })), { kind: 'test', passed: true });
  orchestrator.registerAdapter(adapter);
  orchestrator.registerAdapter(tester);
  const rec = busRecorder(bus);
  return { store, bus, orchestrator, servers, tester, rec };
}

const outcome = (e: UnifiedEvent) => e.type === 'run.completed' || (e.type === 'run.status' && e.data.status === 'BLOCKED');
const methods = (server: FakeCodexServer) => server.received.map((x) => x.method);

describe('probe 場景 6：app-server 在回合進行中崩潰', () => {
  it('會話移出線上表，重試改走 thread/resume（新的 app-server 程序），工作流跑完', async () => {
    const env = boot(() => [{ kind: 'message', text: 'working on it' }]);
    let crashed = false;
    env.bus.subscribe((event) => {
      if (event.type === 'model.turn.started' && !crashed) {
        crashed = true;
        env.servers[0]!.crash('app-server crashed');
      }
    });
    const task = await env.orchestrator.createTask(TASK);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(events.find((e) => e.type === 'runtime.error')?.data).toMatchObject({ code: 'CODEX_TRANSPORT_CLOSED', retryable: true, sessionClosed: true });
    expect(events.some((e) => e.data.code === 'ADAPTER_SEND_FAILED')).toBe(false);
    expect(env.servers).toHaveLength(2);
    expect(methods(env.servers[1]!)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(env.servers[1]!.received[2]?.params).toMatchObject({ threadId: 'thread-1', cwd: CWD });
    expect(run.workflowState?.history.map((h) => h.outcome)).toEqual(['transient failure (CODEX_TRANSPORT_CLOSED); retrying', 'implementation turn completed', 'tests passed']);
  });
});

describe('回合失敗但執行緒仍然線上', () => {
  it('可重試的回合失敗（serverOverloaded）：續接直接在同一執行緒上開始新回合，不重新連線', async () => {
    let turns = 0;
    const env = boot(() => (turns++ === 0 ? [{ kind: 'error', info: 'serverOverloaded' }] : [{ kind: 'message', text: 'done' }]));
    const task = await env.orchestrator.createTask(TASK);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    expect((await env.store.getRun(task.runId))?.status).toBe('COMPLETED');
    expect(env.servers).toHaveLength(1);
    expect(methods(env.servers[0]!).filter((m) => m === 'turn/start')).toHaveLength(2);
    expect(methods(env.servers[0]!)).not.toContain('thread/resume');
  });

  it('不可重試的失敗（usageLimitExceeded）：進入帶原因的 BLOCKED；操作員「帶說明重試」後在同一執行緒上繼續', async () => {
    let turns = 0;
    const env = boot(() => (turns++ === 0 ? [{ kind: 'error', info: 'usageLimitExceeded' }] : [{ kind: 'message', text: 'done' }]));
    const task = await env.orchestrator.createTask(TASK);
    // 不可重試的錯誤一到就進入 BLOCKED（不等終態）；操作員看到橫幅再操作時，這一輪的終態早已到達
    await env.rec.waitFor(outcome);
    await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'failed');
    await env.orchestrator.idle();
    let run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.workflowState?.lastError).toMatchObject({ code: 'CODEX_USAGE_LIMIT_EXCEEDED', category: 'usage', retryable: false });

    await env.orchestrator.resolveGate(task.id, 'retry', 'The quota was raised, please continue.');
    await env.rec.waitFor((e) => e.type === 'run.completed');
    await env.orchestrator.idle();
    run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(env.servers).toHaveLength(1);
  });
});

describe('Codex 回合被 provider 中斷（interrupted）', () => {
  it('以 failed（可重試）結束而不是隻發 waiting：工作流重試一次後跑完', async () => {
    let turns = 0;
    const env = boot(() => (turns++ === 0 ? [{ kind: 'message', text: 'partial' }, { kind: 'interrupted' }] : [{ kind: 'message', text: 'done' }]));
    const task = await env.orchestrator.createTask(TASK);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(events.find((e) => e.data.code === 'CODEX_TURN_INTERRUPTED')?.data).toMatchObject({ retryable: true });
    expect(events.some((e) => e.type === 'agent.status' && e.data.status === 'waiting')).toBe(false);
    expect(run.workflowState?.history[0]?.outcome).toBe('transient failure (CODEX_TURN_INTERRUPTED); retrying');
  });
});

describe('派發途中 app-server 斷開', () => {
  it('turn/start 發出後連線關閉：編排器改走續接（透明重連），不進入 ADAPTER_SEND_FAILED / BLOCKED', async () => {
    const env = boot(() => [{ kind: 'message', text: 'done' }], {
      tests: [false, true],
      onServer: (server, index) => {
        if (index !== 1) return;
        // 第二次 turn/start（測試失敗後的重試步驟）發出後，app-server 還沒回復就退出了
        const write = server.transport.write;
        let turnStarts = 0;
        server.transport.write = (line) => {
          const message = JSON.parse(line) as { method?: string };
          if (message.method === 'turn/start' && ++turnStarts === 2) {
            setImmediate(() => server.crash('app-server exited while starting a turn'));
            return;
          }
          write(line);
        };
      },
    });
    const task = await env.orchestrator.createTask(TASK);
    await env.rec.waitFor(outcome);
    await env.orchestrator.idle();

    const run = (await env.store.getRun(task.runId))!;
    const events = await env.store.listEvents(task.runId);
    expect(run.status).toBe('COMPLETED');
    expect(events.some((e) => e.data.code === 'ADAPTER_SEND_FAILED')).toBe(false);
    expect(env.servers).toHaveLength(2);
    expect(methods(env.servers[1]!)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    // 這次派發沒有送達（由 send 的異常報告），所以不會再多出一個 failed 終態
    expect(events.filter((e) => e.type === 'agent.status' && e.data.status === 'failed')).toHaveLength(0);
    expect(run.workflowState?.history.map((h) => h.outcome)).toEqual(['implementation turn completed', 'tests failed (exit 1)', 'implementation turn completed', 'tests passed']);
  });
});
