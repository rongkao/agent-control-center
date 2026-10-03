import { describe, expect, it } from 'vitest';
import { BEHAVIOR_VERSION, EventBus, Orchestrator } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeWorld, ScriptedAdapter } from '../fakes/scripted-adapter.js';

/**
 * P1-14 恢復與版本健壯性：
 * - 連續好幾次重啟都沒能做完任何一輪（每次續跑都崩），第 N 次之後不再自動續跑，進入帶原因的 BLOCKED；
 * - 行為版本不同的在途任務不自動續跑，說明由哪個版本建立；
 * - 新任務記錄建立它的行為版本與應用版本。
 */

function boot(store: InMemoryControlPlaneStore, maxRecoveryStreak = 2) {
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { log: () => undefined, appVersion: '9.9.9', maxRecoveryStreak });
  const world = new FakeWorld();
  // 永遠做不完的一輪（模擬每次續跑都在同一個地方崩潰）
  orchestrator.registerAdapter(new ScriptedAdapter(world, [{ kind: 'tool', id: 'tool-A' }]));
  orchestrator.registerAdapter(new ScriptedAdapter(world, [{ kind: 'complete' }], { id: 'test', name: 'Test', kind: 'test', capabilities: ['test'] }));
  return { orchestrator, bus };
}

describe('P1-14', () => {
  it('新任務記錄行為版本與應用版本', async () => {
    const store = new InMemoryControlPlaneStore();
    const { orchestrator } = boot(store);
    const task = await orchestrator.createTask({ title: 't', prompt: 'go', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();
    const run = (await store.getRun(task.runId))!;
    expect(run.createdBy).toEqual({ behavior: BEHAVIOR_VERSION, appVersion: '9.9.9' });
  });

  it('連續恢復超過上限且一輪都沒做完：不再自動續跑，BLOCKED（RECOVERY_ATTEMPTS_EXCEEDED）', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store);
    // 自動流程任務：重啟後一定會接著做當前步驟（實現步驟永遠做不完，模擬每次續跑都在同一個地方崩潰）
    const task = await first.orchestrator.createTask({ title: 't', prompt: 'go', agentId: 'claude', workflow: 'implementation-v1', testCommand: 'npm test' });
    await first.orchestrator.idle();
    let status = '';
    for (let i = 0; i < 4; i++) {
      const next = boot(store);
      const report = await next.orchestrator.recover();
      await next.orchestrator.idle();
      status = (await store.getRun(task.runId))!.status;
      if (report.blocked.includes(task.runId)) break;
    }
    const run = (await store.getRun(task.runId))!;
    expect(status).toBe('BLOCKED');
    expect(run.recovery?.streak).toBeGreaterThan(2);
    const events = await store.listEvents(task.runId);
    expect(events.some((e) => e.type === 'runtime.error' && e.data.code === 'RECOVERY_ATTEMPTS_EXCEEDED')).toBe(true);
  });

  it('行為版本不同的在途任務：不自動續跑，說明由哪個版本建立', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store, 10);
    const task = await first.orchestrator.createTask({ title: 't', prompt: 'go', agentId: 'claude', workflow: 'manual' });
    await first.orchestrator.idle();
    // 模擬由另一個行為版本建立
    const run = (await store.getRun(task.runId))!;
    run.createdBy = { behavior: BEHAVIOR_VERSION + 1, appVersion: '2.0.0' };
    await store.commit({ run });
    const second = boot(store, 10);
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.blocked).toContain(task.runId);
    const events = await store.listEvents(task.runId);
    const error = events.find((e) => e.type === 'runtime.error' && e.data.code === 'RECOVERY_VERSION_MISMATCH');
    expect(String(error?.data.message)).toContain('2.0.0');
  });
});
