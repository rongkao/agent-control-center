import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, MAX_SNAPSHOT_SIDE_EFFECTS, Orchestrator, completedSideEffectIdsFromEvents } from '@acc/core';
import type { AgentResumeInput } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { ControlledAgent } from './fakes/controlled-agent.js';

/**
 * P2-10 / L-5 快照有界化：
 * - 快照每個事件都整份寫一次，副作用台賬不能無限增長：只保留最近 MAX_SNAPSHOT_SIDE_EFFECTS 個，另記總數；
 * - 完整台賬從事件日誌重建（與投影規則一致），續跑時完整交給 adapter，已完成的呼叫不重放。
 */

const quiet = () => undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** 記錄續跑輸入的 ControlledAgent。 */
class RecordingAgent extends ControlledAgent {
  readonly resumes: AgentResumeInput[] = [];
  override async resume(sessionId: string, input: AgentResumeInput, emit: Parameters<ControlledAgent['resume']>[2]): Promise<void> {
    this.resumes.push(input);
    return super.resume(sessionId, input, emit);
  }
}

describe('P2-10：快照有界化', () => {
  it('台賬只保留最近一段並記總數；續跑時從事件日誌交出完整台賬', async () => {
    const store = new InMemoryControlPlaneStore();
    const bus = new EventBus({ log: quiet });
    const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
    const agent = new RecordingAgent({ id: 'claude', kind: 'claude' }, { resumable: true });
    orchestrator.registerAdapter(agent);
    cleanups.push(() => orchestrator.shutdown());
    const task = await orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await orchestrator.idle();

    const total = MAX_SNAPSHOT_SIDE_EFFECTS + 50;
    for (let i = 0; i < total; i += 1) {
      await agent.emit('tool.started', { providerCallId: `call-${i}`, toolName: 'Edit', toolInput: { file_path: `src/f${i}.ts` } });
      await agent.emit('tool.completed', { providerCallId: `call-${i}`, toolName: 'Edit', toolInput: { file_path: `src/f${i}.ts` } });
    }
    // 重複完成同一個呼叫：不重複計數
    await agent.emit('tool.completed', { providerCallId: `call-${total - 1}`, toolName: 'Edit' });
    // 執行過的失敗呼叫同樣算副作用
    await agent.emit('tool.failed', { providerCallId: 'call-failed', toolName: 'Bash', executed: true });
    await orchestrator.idle();

    const run = (await store.getRun(task.runId))!;
    expect(run.completedSideEffects).toHaveLength(MAX_SNAPSHOT_SIDE_EFFECTS);
    expect(run.completedSideEffects.at(-1)!.id).toBe('call-failed');
    expect(run.sideEffectCount).toBe(total + 1);

    const ids = completedSideEffectIdsFromEvents(await store.listEvents(task.runId));
    expect(ids).toHaveLength(total + 1);
    expect(ids[0]).toBe('call-0');

    // 程序崩潰後重啟（不呼叫 shutdown）：新的編排器接管同一個儲存，續接仍在進行的會話——完整台賬交給 adapter
    const bus2 = new EventBus({ log: quiet });
    const restarted = new Orchestrator(store, bus2, { workspacePolicy: 'shared', log: quiet });
    const agent2 = new RecordingAgent({ id: 'claude', kind: 'claude' }, { resumable: true });
    restarted.registerAdapter(agent2);
    cleanups.push(() => restarted.shutdown());
    await restarted.recover();
    await restarted.idle();
    expect(agent2.resumes).toHaveLength(1);
    expect(agent2.resumes[0]!.completedSideEffectIds).toHaveLength(total + 1);
    expect(agent2.resumes[0]!.completedSideEffectIds[0]).toBe('call-0');
  });
});
