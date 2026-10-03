import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '@acc/adapters';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { emitRecorder } from './fakes/event-waiter.js';

/**
 * P1-3：
 * - L-9：用過時的 turnId 做 steer 被服務端拒絕時，訊息改用 turn/start 送達，而不是讓任務阻塞；
 * - M-1：Claude 還有排隊的訊息時，這一輪的 completed 不算這一步做完（見 orchestrator.workflowSignalOf，這裡測 Codex 的回退路徑）。
 */
describe('L-9：steer 被拒後改走 turn/start', () => {
  it('回合進行中發訊息但 steer 被拒：訊息以新的一輪送達，不拋錯', async () => {
    let release: () => void = () => undefined;
    const pause = new Promise<void>((resolve) => (release = resolve));
    const server = new FakeCodexServer(new FakeCodexDisk(), (ctx) => (ctx.text === 'first' ? [{ kind: 'pause', until: pause }, { kind: 'message', text: 'one' }] : [{ kind: 'message', text: 'two' }]));
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: '/repo', log: () => undefined });
    const rec = emitRecorder();
    const handle = await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'first' } as never, rec.emit);
    await rec.waitFor((e) => e.type === 'model.turn.started');
    server.rejectSteer = true;
    await adapter.send(handle.sessionId, 'second', rec.emit);
    release();
    const methods = server.received.map((x) => x.method);
    expect(methods).toContain('turn/steer');
    expect(methods.filter((m) => m === 'turn/start').length).toBe(2);
    await rec.waitFor((e) => e.type === 'agent.message' && e.data.message === 'two');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentSdkAdapter, LocalTestRunnerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

describe('M-1：實現步驟中途插話', () => {
  it('第一輪做完時還有排隊的訊息：不進入測試；最後一輪做完才跑測試', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-m1-'));
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    const bus = new EventBus({ log: () => undefined });
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined, workspacePolicy: 'shared' });
    let release: () => void = () => undefined;
    const firstTurn = new Promise<void>((resolve) => (release = resolve));
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async (ctx) => {
      if (ctx.prompt.includes('implement it')) await firstTurn;
    });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
    orchestrator.registerAdapter(new LocalTestRunnerAdapter({ defaultCwd: root, log: () => undefined }));
    const rec = busRecorder(bus);
    try {
      const task = await orchestrator.createTask({ title: 'wf', prompt: 'implement it', agentId: 'claude', workflow: 'implementation-v1', testCommand: 'node -e "process.exit(0)"' });
      await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'coding');
      // 操作員中途插話：排在第一輪後面
      await orchestrator.sendMessage(task.id, 'claude', 'also add a comment');
      release();
      const first = await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
      expect(first.data.queuedTurns).toBe(1);
      await rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed' && e.id !== first.id);
      await orchestrator.idle();
      const testStart = rec.events.findIndex((e) => e.agentId === 'test' && e.type === 'tool.started');
      const lastClaudeDone = rec.events.map((e, i) => (e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed' ? i : -1)).filter((i) => i >= 0).pop()!;
      expect(testStart).toBeGreaterThan(lastClaudeDone);
      expect(runtime.queries[0]!.prompts.some((p) => p.includes('also add a comment'))).toBe(true);
    } finally {
      await orchestrator.shutdown();
      rec.dispose();
      store.close();
      // Windows 上剛結束的測試程序可能還短暫佔著目錄：多試幾次
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // 臨時目錄偶爾被安全軟體短暫佔用：留在系統臨時目錄裡無害，不讓它影響測試結果
      }
    }
  }, 30_000);
});
