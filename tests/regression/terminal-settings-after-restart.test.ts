import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator, TaskTerminalError } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * L-3（實測）：重啟後只為非終態 run 初始化事件序號；對已結束的任務呼叫 setHandoffPolicy 會先改快照、再發事件，
 * 事件序號撞上 UNIQUE（HTTP 500），而快照已經被改了。
 * 期望：已結束的任務明確拒絕（TaskTerminalError，409），快照和事件都不變。
 */

const quiet = () => undefined;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Windows 偶爾佔用
    }
  }
});

describe('L-3：重啟後修改已結束任務的設定', () => {
  it('明確拒絕（409），不改快照、不寫事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-l3-'));
    dirs.push(dir);
    const path = join(dir, 'acc.db');
    const store = new SqliteControlPlaneStore({ path });
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    orchestrator.registerAdapter(new ControlledAgent({ id: 'claude', kind: 'claude' }));
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    await orchestrator.cancelTask(task.id);
    await orchestrator.idle();
    await orchestrator.shutdown();
    store.close();

    // 重啟
    const store2 = new SqliteControlPlaneStore({ path });
    const restarted = new Orchestrator(store2, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    restarted.registerAdapter(new ControlledAgent({ id: 'claude', kind: 'claude' }));
    await restarted.recover();
    const before = await store2.getRun(task.runId);
    const eventsBefore = (await store2.listEvents(task.runId)).length;
    const error = await restarted.setHandoffPolicy(task.id, 'auto').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaskTerminalError);
    expect((error as { statusCode?: number }).statusCode).toBe(409);
    expect(await store2.getRun(task.runId)).toEqual(before);
    expect((await store2.listEvents(task.runId)).length).toBe(eventsBefore);
    await restarted.shutdown();
    store2.close();
  });
});
