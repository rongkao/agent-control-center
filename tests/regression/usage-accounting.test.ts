import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, claudeTurnUsage } from '@acc/adapters';
import { EventBus, Orchestrator, budgetLimitsProblem, createBudgetSnapshot, dispatchViolation, runtimeViolations } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-7 / M-17：用量口徑。
 * - Claude 的 total_cost_usd、modelUsage 是整個會話的累計值（續接後的第一條結果還帶著之前各輪）：必須按會話求增量，不能每輪相加；
 *   modelUsage 包含子 agent；輸入 token 要包含快取讀寫。
 * - 美元上限 maxCostUsd：超出時阻塞，用滿時不再派發。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const modelUsage = (input: number, output: number, cacheRead: number, cost: number) => ({
  'claude-main': { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: 0, costUSD: cost, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0 },
});

describe('claudeTurnUsage', () => {
  it('有 modelUsage 時交出累計值：包含子 agent 的模型、輸入含快取讀寫', () => {
    const usage = claudeTurnUsage({
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {
        main: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, costUSD: 0.3, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0 },
        subagent: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01, webSearchRequests: 0, contextWindow: 0, maxOutputTokens: 0 },
      },
      total_cost_usd: 0.31,
      duration_ms: 5,
    } as never);
    expect(usage.cumulative).toEqual({ costUsd: 0.31, inputTokens: 1310, outputTokens: 55, cacheReadTokens: 1000, cacheWriteTokens: 200 });
  });
});

describe('按會話求增量', () => {
  it('三輪累計花費 0.10 → 0.25 → 0.40：每輪分別記 0.10、0.15、0.15；重啟續接後不重複計算', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-usage-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const db = join(root, 'acc.db');
    const disk = new FakeClaudeDisk();
    // 會話累計值：按 prompt 決定（續接後 SDK 從記錄裡接著累計）
    const cumulative: Record<string, [number, number]> = { one: [1000, 0.1], two: [2500, 0.25], three: [4000, 0.4] };
    const runtime = new FakeClaudeRuntime(disk, async () => undefined, (ctx) => {
      const [input, cost] = cumulative[ctx.prompt] ?? [0, 0];
      return { total_cost_usd: cost, modelUsage: modelUsage(input, input / 10, 0, cost) };
    });

    const boot = () => {
      const store = new SqliteControlPlaneStore({ path: db });
      const bus = new EventBus({ log: () => undefined });
      const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
      orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
      const rec = busRecorder(bus);
      return { store, orchestrator, rec, close: () => (rec.dispose(), store.close()) };
    };

    const first = boot();
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'one', agentId: 'claude', workflow: 'manual' });
    await first.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    let before = first.rec.events.length;
    await first.orchestrator.sendMessage(task.id, 'claude', 'two');
    await first.rec.waitFor((e) => first.rec.events.indexOf(e) >= before && e.type === 'agent.status' && e.data.status === 'completed');
    await first.orchestrator.idle();
    await first.orchestrator.shutdown();
    first.close();

    // 重啟：同一個會話續接，SDK 的第一條結果帶著之前的累計值
    const second = boot();
    cleanups.push(second.close);
    await second.orchestrator.recover();
    before = second.rec.events.length;
    await second.orchestrator.sendMessage(task.id, 'claude', 'three');
    await second.rec.waitFor((e) => second.rec.events.indexOf(e) >= before && e.type === 'agent.status' && e.data.status === 'completed');
    await second.orchestrator.idle();

    const usage = await second.store.listUsage(task.runId);
    expect(usage.map((u) => u.costUsd)).toEqual([0.1, 0.15, 0.15]);
    expect(usage.map((u) => u.inputTokens)).toEqual([1000, 1500, 1500]);
    const loaded = await second.store.loadRun(task.runId);
    const budget = loaded?.status === 'ok' ? loaded.snapshot.budget : undefined;
    expect(budget?.costUsdUsed).toBeCloseTo(0.4, 6);
    expect(budget?.estimatedTokensUsed).toBe(4000 + 400);
  });
});

describe('美元上限 maxCostUsd', () => {
  it('超出時是執行時違規；用滿時不再派發；可以是小數', () => {
    const snap = createBudgetSnapshot({ maxCostUsd: 1.5 });
    snap.costUsdUsed = 1.5;
    expect(runtimeViolations(snap)).not.toContain('maxCostUsd');
    expect(dispatchViolation(snap)).toBe('maxCostUsd');
    snap.costUsdUsed = 1.6;
    expect(runtimeViolations(snap)).toContain('maxCostUsd');
    expect(budgetLimitsProblem({ maxCostUsd: 2.5 })).toBeUndefined();
    expect(budgetLimitsProblem({ maxTurns: 2.5 })).toBeDefined();
    expect(budgetLimitsProblem({ maxCostUsd: -1 })).toBeDefined();
  });
});

describe('全域性每日上限 ACC_DAILY_MAX_COST_USD', () => {
  it('今天的估算花費達到上限後：新建任務與發訊息都被拒絕（409），不寫入任務', async () => {
    const { DailyBudgetError } = await import('@acc/core');
    const root = mkdtempSync(join(tmpdir(), 'acc-daily-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const store = new SqliteControlPlaneStore({ path: join(root, 'acc.db') });
    cleanups.push(() => store.close());
    const bus = new EventBus({ log: () => undefined });
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined, () => ({ total_cost_usd: 0.6, modelUsage: modelUsage(1000, 100, 0, 0.6) }));
    const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined, dailyMaxCostUsd: 0.5 });
    orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
    const rec = busRecorder(bus);
    cleanups.push(() => rec.dispose());
    // 第一個任務花掉 0.6（超過 0.5 的每日上限）
    const task = await orchestrator.createTask({ title: 't', prompt: 'one', agentId: 'claude', workflow: 'manual' });
    await rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    await orchestrator.idle();
    await expect(orchestrator.createTask({ title: 't2', prompt: 'two', agentId: 'claude', workflow: 'manual' })).rejects.toBeInstanceOf(DailyBudgetError);
    expect(await store.listTasks()).toHaveLength(1);
    await expect(orchestrator.sendMessage(task.id, 'claude', 'more')).rejects.toBeInstanceOf(DailyBudgetError);
  });
});
