import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { deferred, turnEventLoop } from './fakes/deferred.js';
import { GatedAgent } from './fakes/gated-agent.js';

/**
 * P0-5（第一批遺留）：操作員的公共命令按任務序列，與編排反應併發時不再出現 SessionOwnershipError；
 * createTask 用一個全域性鍵，“工作區檢查 + 提交”成為原子操作。
 *
 * 現象（修復前）：
 * - 兩條訊息同時發給還沒有會話的 Codex：第二條在佔位時撞上第一條的啟動，得到 SessionOwnershipError（HTTP 409），
 *   並留下一條 SESSION_OWNERSHIP_CONFLICT；
 * - Claude 請求交接、策略為 auto 時，編排反應正在啟動 Codex，操作員此時給 Codex 發訊息同樣撞車；
 * - 兩個任務同時用同一個工作區建立：兩邊的工作區檢查都在對方提交之前完成，雙雙通過。
 *
 * 期望：同一 agent 的“有會話就傳送、沒有就啟動”在一把按 (run, agent) 的鎖裡完成；操作員命令按任務排隊；
 * 這些鎖都不是 run 鎖，鎖內照樣可以發事件、調 adapter（run 鎖內不 publish、不調 adapter 的不變數不變）。
 */

const quiet = () => undefined;
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function boot(adapters: AgentAdapter[], options: { workspacePolicy?: 'exclusive' | 'shared' } = {}) {
  const store = new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: options.workspacePolicy ?? 'shared', log: quiet });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, orchestrator };
}

describe('操作員命令與編排反應不再撞車', () => {
  it('兩條訊息同時發給還沒有會話的 Codex：Codex 只啟動一次，第二條走同一會話傳送，沒有歸屬衝突', async () => {
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new GatedAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    codex.startGate = deferred();
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();

    const first = env.orchestrator.sendMessage(task.id, 'codex', 'review A');
    const second = env.orchestrator.sendMessage(task.id, 'codex', 'review B');
    await codex.startCalled.promise;
    codex.startGate.resolve();
    const results = await Promise.allSettled([first, second]);
    await env.orchestrator.idle();

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(codex.starts.map((s) => s.prompt)).toEqual(['review A']);
    expect(codex.sends.map((s) => s.message)).toEqual(['review B']);
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.data.code === 'SESSION_OWNERSHIP_CONFLICT')).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('編排反應（auto 交接）正在啟動 Codex 時操作員也給 Codex 發訊息：不撞車，訊息送到同一會話', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'handoff', to: 'codex', instruction: 'Please review', text: 'patched login.ts' }]);
    const codex = new GatedAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    codex.startGate = deferred();
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto' });

    // 編排反應已經在啟動 Codex（交接）
    const started = await codex.startCalled.promise;
    expect(started.prompt).toContain('patched login.ts');
    const operator = env.orchestrator.sendMessage(task.id, 'codex', 'also check the tests');
    codex.startGate.resolve();
    await operator;
    await env.orchestrator.idle();

    expect(codex.starts).toHaveLength(1);
    expect(codex.sends.map((s) => s.message)).toEqual(['also check the tests']);
    const events = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.data.code === 'SESSION_OWNERSHIP_CONFLICT' || e.data.code === 'ORCHESTRATOR_REACTION_FAILED')).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('同一任務的操作員命令按順序執行：先發的訊息先送達', async () => {
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const codex = new GatedAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
    codex.startGate = deferred();
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'claude', workflow: 'manual' });
    await env.orchestrator.idle();

    // 第一條命令卡在 Codex 的啟動上；第二條命令（發給 Claude）排在它後面，不會插隊
    const first = env.orchestrator.sendMessage(task.id, 'codex', 'first');
    await codex.startCalled.promise;
    const second = env.orchestrator.sendMessage(task.id, 'claude', 'second');
    const order: string[] = [];
    void first.then(() => order.push('first'));
    void second.then(() => order.push('second'));
    // 推進幾輪事件迴圈（不是按時間等待）：沒有排隊的話第二條早就送達了
    await turnEventLoop(5);
    expect(claude.sends).toEqual([]);
    codex.startGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(claude.sends.map((s) => s.message)).toEqual(['second']);
  });
});

describe('createTask 的“工作區檢查 + 提交”是原子的', () => {
  it('兩個任務同時用同一個工作區建立：只有一個成功，另一個得到工作區衝突', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acc-cmdq-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const env = boot([new WorkflowAgent({ id: 'claude', kind: 'claude' }, [], { kind: 'silent' })], { workspacePolicy: 'exclusive' });

    const results = await Promise.allSettled([
      env.orchestrator.createTask({ title: 'a', prompt: 'p', agentId: 'claude', cwd: dir }),
      env.orchestrator.createTask({ title: 'b', prompt: 'p', agentId: 'claude', cwd: dir }),
    ]);
    await env.orchestrator.idle();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)).toMatch(/Workspace conflict/);
    expect(await env.store.listTasks()).toHaveLength(1);
  });
});
