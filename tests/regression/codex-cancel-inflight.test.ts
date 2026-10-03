import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter, type CodexTransport } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeCodexDisk, FakeCodexServer, type CodexScript } from '../fakes/fake-codex-server.js';
import { deferred, turnEventLoop, type Deferred } from './fakes/deferred.js';

/**
 * P0 第二批審查（P0-5 / H-5、H-6，Codex 部分）：turn/start 還在途中時按「停止」，這一輪不能在取消之後照樣執行。
 *
 * 復現（修復前，真實 CodexAppServerAdapter + 假 app-server）：adapter.start 先 thread/start、發出 agent.started（落盤時登記線上），
 * 然後才發 turn/start。回覆到達之前 session.activeTurnId 為空：這時按「停止」，cancel 不發 turn/interrupt，只把會話標成關閉；
 * 隨後 turn/start 被 app-server 接受，這一輪在 workspace-write 沙箱裡照常執行命令（通知因為會話已取消被丟棄，介面上看不到）。
 * start 返回後編排器發現派發許可失效，但 discardDispatch 因為“同一會話不重複取消”直接返回，本來能補發 turn/interrupt 的第二次取消被省掉了。
 * 給空閒 Codex 會話發訊息（sendToSession → turn/start）在途時停止也一樣，而且 send 返回後沒有複核。
 *
 * 期望：取消時 turn/start 還在途的，回覆一到就補發 turn/interrupt，這一輪不會執行任何命令；編排器在派發許可失效時一定再取消一次
 * （adapter 的 cancel 是冪等的），線上傳送返回後也按許可複核。
 */

const quiet = () => undefined;
const CWD = '/w';

/** 在 app-server 前面掛一個“閘門”：開啟時下一條 turn/start 請求先停住，模擬 app-server 還沒處理完。 */
class HoldingTransport {
  private hold?: { released: Deferred<void>; arrived: Deferred<void> };
  constructor(private readonly server: FakeCodexServer) {}

  /** 掛住下一條 turn/start：返回“請求已到達”與“放行”。 */
  holdNextTurnStart(): { arrived: Promise<void>; release: () => void } {
    const hold = { released: deferred(), arrived: deferred() };
    this.hold = hold;
    return { arrived: hold.arrived.promise, release: () => hold.released.resolve() };
  }

  readonly transport: CodexTransport = {
    write: (line) => {
      const message = JSON.parse(line) as { method?: string };
      const hold = this.hold;
      if (message.method === 'turn/start' && hold) {
        this.hold = undefined;
        hold.arrived.resolve();
        void hold.released.promise.then(() => this.server.transport.write(line));
        return;
      }
      this.server.transport.write(line);
    },
    onLine: (handler) => this.server.transport.onLine(handler),
    onClose: (handler) => this.server.transport.onClose(handler),
    close: () => this.server.transport.close(),
  };
}

function boot(script: CodexScript) {
  const disk = new FakeCodexDisk();
  const server = new FakeCodexServer(disk, script);
  const holding = new HoldingTransport(server);
  const adapter = new CodexAppServerAdapter({ transportFactory: () => holding.transport, defaultCwd: CWD, log: quiet });
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { defaultCwd: CWD, workspacePolicy: 'shared', log: quiet });
  orchestrator.registerAdapter(adapter);
  return { disk, server, holding, store, orchestrator };
}

const methods = (server: FakeCodexServer) => server.received.map((x) => x.method);

describe('Codex：turn/start 在途時停止', () => {
  it('首次啟動：agent.started 已落盤、turn/start 在途時按「停止」→ 補發 turn/interrupt，命令不會執行', async () => {
    const thinking = deferred();
    const env = boot(() => [{ kind: 'pause', until: thinking.promise }, { kind: 'command', id: 'edit-file', command: 'apply edit' }]);
    const held = env.holding.holdNextTurnStart();

    const creating = env.orchestrator.createTask({ title: 'chat', prompt: 'edit the file', agentId: 'codex', workflow: 'manual' });
    await held.arrived;
    const [task] = await env.store.listTasks();
    // 視窗：agent.started 已經落盤、會話已登記線上，turn/start 還沒有回覆
    expect(env.orchestrator.liveAgentIds(task!.runId)).toEqual(['codex']);

    await env.orchestrator.cancelTask(task!.id);
    expect((await env.store.getRun(task!.runId))?.status).toBe('CANCELLED');

    held.release();
    await creating;
    await env.orchestrator.idle();
    expect(methods(env.server)).toContain('turn/interrupt');

    // 模型“想完了”：這一輪已經被中斷，命令不會執行
    thinking.resolve();
    await turnEventLoop(5);
    expect(env.disk.executions).toEqual([]);
    expect(env.orchestrator.liveAgentIds(task!.runId)).toEqual([]);
    expect((await env.store.getRun(task!.runId))?.status).toBe('CANCELLED');
  });

  it('空閒會話再發訊息：turn/start 在途時按「停止」→ 補發 turn/interrupt，命令不會執行', async () => {
    const thinking = deferred();
    const env = boot((ctx) => (ctx.text.includes('edit') ? [{ kind: 'pause', until: thinking.promise }, { kind: 'command', id: 'edit-file', command: 'apply edit' }] : [{ kind: 'message', text: 'hello' }]));
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'say hello', agentId: 'codex', workflow: 'manual' });
    await env.orchestrator.idle();
    // 第一輪已經結束（等 turn/completed 到達）
    for (let i = 0; i < 20 && (await env.store.getRun(task.runId))?.agentSessions.codex?.status !== 'completed'; i++) await turnEventLoop();
    expect((await env.store.getRun(task.runId))?.agentSessions.codex?.status).toBe('completed');

    const held = env.holding.holdNextTurnStart();
    const sending = env.orchestrator.sendMessage(task.id, 'codex', 'second: edit the file');
    await held.arrived;
    await env.orchestrator.cancelTask(task.id);
    held.release();
    await sending;
    await env.orchestrator.idle();
    expect(methods(env.server).filter((m) => m === 'turn/start')).toHaveLength(2);
    expect(methods(env.server)).toContain('turn/interrupt');

    thinking.resolve();
    await turnEventLoop(5);
    expect(env.disk.executions).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('CANCELLED');
  });
});
