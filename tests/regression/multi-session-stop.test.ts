import { describe, expect, it } from 'vitest';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentAdapter } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { GatedAgent } from './fakes/gated-agent.js';

/**
 * P0-5（H-5）：編排器不再依賴單一的 currentAgentId 做終止和恢復。
 *
 * 復現：
 * - probe 場景 4：Ask Both 之後 currentAgentId 變成 codex，取消任務只停掉了 codex，持有寫權限的 Claude 繼續改檔案
 *   （claudeCancelled=false）；預算停止、手動 accept 同樣只停一個；
 * - probe3 場景 B：Ask Both 時重啟，恢復只看 currentAgentId（已答完的 Codex），仍在工作的 Claude 既沒被續跑、也沒 fail closed；
 * - 換人接手取交接來源時用的也是 currentAgentId：Ask Both 之後變成了顧問 Codex。
 *
 * 期望：取消、預算停止、accept 都遍歷該 run 的全部線上會話；恢復檢查該 run 的全部會話；
 * 對話任務顯式記錄主 agent（primaryAgentId），換人接手的交接來源用它。
 */

const quiet = () => undefined;

function boot(adapters: AgentAdapter[], options: { now?: () => number; store?: InMemoryControlPlaneStore; instanceId?: string } = {}) {
  const store = options.store ?? new InMemoryControlPlaneStore();
  const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet, now: options.now, instanceId: options.instanceId });
  for (const adapter of adapters) orchestrator.registerAdapter(adapter);
  return { store, orchestrator };
}

function askBothAgents() {
  const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
  const codex = new GatedAgent({ id: 'codex', kind: 'codex', capabilities: ['analysis'] });
  return { claude, codex };
}

const CHAT = { title: 'chat', prompt: 'Fix the login bug', agentId: 'claude', workflow: 'manual', askBoth: true } as const;

describe('H-5：終止類操作遍歷全部線上會話（probe 場景 4）', () => {
  it('Ask Both 後取消：Claude 和 Codex 都被停止', async () => {
    const { claude, codex } = askBothAgents();
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual(['claude', 'codex']);

    await env.orchestrator.cancelTask(task.id);
    await env.orchestrator.idle();
    expect({ claude: claude.cancels, codex: codex.cancels }).toEqual({ claude: 1, codex: 1 });
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);
    expect((await env.store.getRun(task.runId))?.status).toBe('CANCELLED');

    // 重複按「停止」：冪等，不再重複取消
    await env.orchestrator.cancelTask(task.id);
    expect({ claude: claude.cancels, codex: codex.cancels }).toEqual({ claude: 1, codex: 1 });
  });

  it('Ask Both 後預算超限：兩個 agent 都被停止，run 進入 BLOCKED', async () => {
    let clock = 1_000_000;
    const { claude, codex } = askBothAgents();
    const env = boot([claude, codex], { now: () => clock });
    const task = await env.orchestrator.createTask({ ...CHAT, budget: { maxDurationMs: 5_000 } });
    await env.orchestrator.idle();

    clock += 5_000;
    await env.orchestrator.checkBudgets();
    await env.orchestrator.idle();
    const run = (await env.store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    expect(run.blockedBy).toMatchObject({ source: 'budget', code: 'maxDurationMs' });
    expect({ claude: claude.cancels, codex: codex.cancels }).toEqual({ claude: 1, codex: 1 });
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);
  });

  it('Ask Both 後「接受結果並結束」：兩個 agent 都被停止，任務完成', async () => {
    const { claude, codex } = askBothAgents();
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();

    await env.orchestrator.resolveGate(task.id, 'accept');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.status).toBe('COMPLETED');
    expect({ claude: claude.cancels, codex: codex.cancels }).toEqual({ claude: 1, codex: 1 });
    expect(env.orchestrator.liveAgentIds(task.runId)).toEqual([]);
  });
});

describe('H-5：重啟恢復檢查全部會話（probe3 場景 B）', () => {
  async function askBothThenRestart(claudeAfterRestart: AgentAdapter) {
    const store = new InMemoryControlPlaneStore();
    // 程序 1：Claude（主，可寫）還在工作；Codex（顧問）已經答完
    const first = boot([new WorkflowAgent({ id: 'claude', kind: 'claude' }, [], { kind: 'silent' }), new WorkflowAgent({ id: 'codex', kind: 'codex' })], { store, instanceId: 'instance-1' });
    const task = await first.orchestrator.createTask(CHAT);
    await first.orchestrator.idle();
    // probe3 B 的前提：之後又問了 Codex 一句，currentAgentId 指向已經答完的 Codex
    await first.orchestrator.sendMessage(task.id, 'codex', 'Any other risks?');
    await first.orchestrator.idle();
    const before = (await store.getRun(task.runId))!;
    expect(before.currentAgentId).toBe('codex');
    expect(before.agentSessions.claude?.status).toBe('starting');
    expect(before.agentSessions.codex?.status).toBe('completed');

    // 程序 2：同一個庫，新的編排器與 adapter 實例
    const codexAfterRestart = new WorkflowAgent({ id: 'codex', kind: 'codex' });
    const second = boot([claudeAfterRestart, codexAfterRestart], { store, instanceId: 'instance-2' });
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    return { store, task, report, second, codexAfterRestart };
  }

  it('仍在工作的 Claude 被續跑；已答完的 Codex 不被打擾', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [], { kind: 'silent' });
    const { store, task, report, second, codexAfterRestart } = await askBothThenRestart(claude);
    expect(report.resumed).toEqual([task.runId]);
    expect(claude.calls).toEqual([expect.objectContaining({ via: 'resume', prompt: 'recovery' })]);
    expect(codexAfterRestart.calls).toEqual([]);
    expect(second.orchestrator.liveAgentIds(task.runId)).toEqual(['claude']);
    expect((await store.getRun(task.runId))?.status).toBe('RUNNING');
  });

  it('仍在工作的 Claude 無法續接：fail closed 為 BLOCKED（RUNTIME_DISCONNECTED 指向 Claude），不再當作空閒', async () => {
    // GatedAgent 沒有 resume
    const claude = new GatedAgent({ id: 'claude', kind: 'claude', capabilities: ['implement'] });
    const { store, task, report } = await askBothThenRestart(claude);
    expect(report.blocked).toEqual([task.runId]);
    const run = (await store.getRun(task.runId))!;
    expect(run.status).toBe('BLOCKED');
    const incident = (await store.listEvents(task.runId)).find((e) => e.type === 'runtime.error' && e.data.code === 'RUNTIME_DISCONNECTED');
    expect(incident?.agentId).toBe('claude');
  });
});

describe('H-5：對話任務顯式記錄主 agent（primaryAgentId）', () => {
  it('Ask Both 之後再問 Codex，換 Codex 接手：交接來源是主 agent Claude，接手後主 agent 變為 Codex', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' }, [{ kind: 'reply', text: 'Half way: edited login.ts' }]);
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask(CHAT);
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.primaryAgentId).toBe('claude');

    await env.orchestrator.sendMessage(task.id, 'codex', 'What do you think?');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.currentAgentId).toBe('codex');

    await env.orchestrator.reassign(task.id, 'codex', 'Please finish the remaining tests');
    await env.orchestrator.idle();
    const events = await env.store.listEvents(task.runId);
    expect(events.find((e) => e.type === 'handoff.requested' && e.data.reason === 'reassign')?.data).toMatchObject({ fromAgentId: 'claude', toAgentId: 'codex' });
    expect(codex.calls.at(-1)?.prompt).toContain('Half way: edited login.ts');
    expect((await env.store.getRun(task.runId))?.primaryAgentId).toBe('codex');
  });

  it('Ask Both 不指定主 agent 時沿用任務記錄的主 agent；指定了就更新', async () => {
    const claude = new WorkflowAgent({ id: 'claude', kind: 'claude' });
    const codex = new WorkflowAgent({ id: 'codex', kind: 'codex' });
    const env = boot([claude, codex]);
    const task = await env.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'codex', workflow: 'manual' });
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.primaryAgentId).toBe('codex');

    await env.orchestrator.askBoth(task.id, 'Any risks?');
    await env.orchestrator.idle();
    const outgoing = (await env.store.listEvents(task.runId)).filter((e) => e.type === 'agent.message' && e.data.direction === 'to-agent' && e.data.askBoth);
    expect(outgoing.map((e) => [e.agentId, e.data.advisory ?? false])).toEqual(expect.arrayContaining([['codex', false], ['claude', true]]));

    await env.orchestrator.askBoth(task.id, 'Now you write it', 'claude');
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))?.primaryAgentId).toBe('claude');
  });
});
