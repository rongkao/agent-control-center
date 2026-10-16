import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator, createBudgetSnapshot, nearlyExhausted, remainingCostUsd } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeCodexDisk, FakeCodexServer } from '../fakes/fake-codex-server.js';
import { ClaudeQueryDriver, echoScript } from './fakes/claude-query-driver.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { emitRecorder } from './fakes/event-waiter.js';

/**
 * P1-7 用量與花費的收尾：
 * - 剩餘美元預算交給 Claude 的 maxBudgetUsd（它自己在上限內停下）；
 * - 任何一項預算用到 80% 時，派發給 AI 的訊息附上收尾提醒；
 * - Codex 的方案額度（account/rateLimits/read）歸一成 QuotaStatus，顯示在「用量」頁。
 */

const quiet = () => undefined;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('P1-7：預算收尾', () => {
  it('剩餘美元與快用完的預算', () => {
    const b = createBudgetSnapshot({ maxTurns: 10, maxCostUsd: 2 });
    expect(remainingCostUsd(b)).toBe(2);
    expect(nearlyExhausted(b)).toEqual([]);
    b.turnsUsed = 8;
    b.costUsdUsed = 1.5;
    expect(remainingCostUsd(b)).toBe(0.5);
    expect(nearlyExhausted(b)).toEqual(['turns 80% used']);
    expect(remainingCostUsd(createBudgetSnapshot({}))).toBeUndefined();
  });

  it('同一條指令底下的後續派發（AI 自動交接）：預算快用完時附上收尾提醒；你的新指令開新視窗，不附', async () => {
    const store = new InMemoryControlPlaneStore();
    const orchestrator = new Orchestrator(store, new EventBus({ log: quiet }), { workspacePolicy: 'shared', log: quiet });
    const claude = new ControlledAgent({ id: 'claude', kind: 'claude' });
    const codex = new ControlledAgent({ id: 'codex', kind: 'codex' });
    orchestrator.registerAdapter(claude);
    orchestrator.registerAdapter(codex);
    cleanups.push(() => orchestrator.shutdown());
    const task = await orchestrator.createTask({ title: 't', prompt: 'first', agentId: 'claude', workflow: 'manual', handoffPolicy: 'auto', budget: { maxTurns: 5, maxAgentCalls: 50 } });
    await orchestrator.idle();
    expect(claude.calls[0]!.prompt).not.toContain('[Orchestrator note]');
    // 這個視窗已經用掉 4 輪（80%）
    const run = (await store.getRun(task.runId))!;
    run.budget.turnsUsed = (run.budget.window?.turns ?? 0) + 4;
    await store.commit({ run });
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'please review', content: 'diff' });
    await orchestrator.idle();
    expect(codex.calls[0]!.prompt).toContain('turns 80% used');
    expect(codex.calls[0]!.prompt).toContain('Wrap up');
  });

  it('Claude：剩餘美元預算成為 SDK 的 maxBudgetUsd', async () => {
    const driver = new ClaudeQueryDriver(echoScript);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: driver.queryFn, log: quiet });
    cleanups.push(() => adapter.dispose());
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'hi', cwd: process.cwd(), remainingCostUsd: 1.25 }, emitRecorder().emit);
    expect((await driver.query(1)).options.maxBudgetUsd).toBe(1.25);
  });

  it('Codex：方案額度', async () => {
    const server = new FakeCodexServer(new FakeCodexDisk(), () => []);
    const codex = new CodexAppServerAdapter({ transportFactory: () => server.transport });
    cleanups.push(() => codex.dispose());
    expect(await codex.quota()).toEqual({
      plan: 'plus',
      windows: [
        { label: '每 5 小時', usedPercent: 42, resetsAt: 1_800_000_000_000 },
        { label: '每週', usedPercent: 91 },
      ],
    });
  });
});
