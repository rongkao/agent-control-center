import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, resumePrompt } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P1-2 / M-9：執行到一半的副作用。
 * 服務在一個工具呼叫開始之後、結果出來之前崩潰：重啟後不盲目續跑（可能把它再做一次），任務進入 BLOCKED 並列出這個呼叫；
 * 操作員發訊息繼續時，續跑提示會點名這個“狀態不明”的呼叫，請 agent 先檢查是否已經做過。續跑提示的列表有上限。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('執行中副作用台賬', () => {
  it('tool.started 之後崩潰：恢復時 BLOCKED（SIDE_EFFECT_UNCERTAIN）並列出這個呼叫；之後發訊息續跑時提示它先檢查', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acc-inflight-'));
    cleanups.push(() => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // 忽略
      }
    });
    const db = join(root, 'acc.db');
    const disk = new FakeClaudeDisk();
    let first = true;
    const runtime = new FakeClaudeRuntime(disk, async (ctx) => {
      if (!first) return;
      first = false;
      // 發出一個工具呼叫，然後“崩潰”（永遠沒有結果）
      ctx.send({ type: 'assistant', parent_tool_use_id: null, session_id: ctx.sessionId, uuid: 'u', message: { content: [{ type: 'tool_use', id: 'toolu_deploy', name: 'Bash', input: { command: 'npm run deploy' } }] } } as never);
      await new Promise(() => undefined);
    });
    const boot = () => {
      const store = new SqliteControlPlaneStore({ path: db });
      const bus = new EventBus({ log: () => undefined });
      const orchestrator = new Orchestrator(store, bus, { defaultCwd: root, log: () => undefined });
      orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: root, log: () => undefined }));
      const rec = busRecorder(bus);
      return { store, orchestrator, rec };
    };

    const a = boot();
    const task = await a.orchestrator.createTask({ title: 't', prompt: 'deploy', agentId: 'claude', workflow: 'manual' });
    await a.rec.waitFor((e) => e.type === 'tool.started');
    await a.orchestrator.idle();
    // 程序“崩潰”：不發任何事件就停下（關閉流程不會寫事件，效果與強殺一樣）
    await a.orchestrator.shutdown();
    a.rec.dispose();
    a.store.close();

    const b = boot();
    cleanups.push(() => {
      b.rec.dispose();
      b.store.close();
    });
    const report = await b.orchestrator.recover();
    await b.orchestrator.idle();
    expect(report.blocked).toContain(task.runId);
    const events = await b.store.listEvents(task.runId);
    const error = events.find((e) => e.type === 'runtime.error' && e.data.code === 'SIDE_EFFECT_UNCERTAIN');
    expect(String(error?.data.message)).toContain('npm run deploy');

    // 操作員確認後繼續：先恢復任務再發訊息；續跑提示點名這個呼叫
    await b.orchestrator.sendMessage(task.id, 'claude', 'I checked, the deploy did not run. Continue.', { resume: true });
    await b.orchestrator.idle();
    const prompts = runtime.queries.at(-1)!.prompts.join('\n');
    expect(prompts).toContain('I checked');
    expect(prompts).toContain('npm run deploy');
    expect(prompts).toContain('may or may not have run');
  });

  it('續跑提示：只點名這個 agent 的狀態不明呼叫，已完成的呼叫最多列 10 個', () => {
    const text = resumePrompt({
      projectId: 'p',
      taskId: 't',
      runId: 'r',
      agentId: 'claude',
      reason: 'recovery',
      step: 's',
      completedSideEffectIds: Array.from({ length: 50 }, (_, i) => `id-${i}`),
      recentCompletedSideEffectIds: Array.from({ length: 12 }, (_, i) => `mine-${i}`),
      uncertainSideEffects: [{ id: 'x', name: 'Bash', summary: 'npm run deploy' }],
      lastSequence: 1,
    } as never);
    expect(text).toContain('npm run deploy');
    expect(text).not.toContain('id-0');
    expect(text).not.toContain('mine-0,');
    expect(text).toContain('mine-11');
  });
});
