import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P0-4 審查（low）：續跑 fail closed（RESUME_CWD_MISSING / RESUME_MODE_MISSING / CODEX_RESUME_CWD_MISMATCH）之後，
 * 再發訊息或重試只會走 sendToSession → consumeAgentCall(+1) → resume → 同樣的前置條件錯誤 → BLOCKED，
 * 非技術使用者照著“向 Agent 補充說明 / 帶說明重試”的提示操作，只會反覆看到同一個錯誤，還會耗盡 maxAgentCalls。
 *
 * 期望：編排器把這類會話標記為“無法續接”；之後操作員再發訊息直接得到明確的 409 說明（請換人接手 / 接受結果 / 停止），
 * 不扣呼叫預算、不再嘗試續接；換人接手照常可用。
 */

interface Box {
  repo: string;
  wt: string;
  db: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspaceBox(): Box {
  const root = mkdtempSync(join(tmpdir(), 'acc-resume-blocked-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'repo-worktrees', 'task-1');
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { repo, wt, db: join(root, 'agent-control.db') };
}

function boot(box: Box, runtime: FakeClaudeRuntime) {
  const store = new SqliteControlPlaneStore({ path: box.db });
  const bus = new EventBus({ log: () => undefined });
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: box.repo, log: () => undefined });
  orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo, log: () => undefined }));
  const codex = new WorkflowAgent({ id: 'codex', kind: 'codex', capabilities: ['implement'] });
  orchestrator.registerAdapter(codex);
  const rec = busRecorder(bus);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rec.dispose();
    store.close();
  };
  cleanups.push(close);
  return { store, bus, orchestrator, rec, codex, close };
}

describe('P0-4 審查：無法續接的會話不再反覆嘗試', () => {
  it('第一次續接失敗後標記為無法續接；再發訊息得到 409，不扣呼叫預算、不建立 SDK 查詢；換人接手照常可用', async () => {
    const box = workspaceBox();
    const disk = new FakeClaudeDisk();
    const runtime = new FakeClaudeRuntime(disk, async () => undefined);
    const first = boot(box, runtime);
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', cwd: box.wt });
    await first.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await first.bus.drain();
    // 舊版本寫下的殘缺快照：會話後設資料裡沒有 cwd
    const run = (await first.store.getRun(task.runId))!;
    delete run.agentSessions.claude!.metadata!.cwd;
    await first.store.commit({ run });
    first.close();

    const secondRuntime = new FakeClaudeRuntime(disk, async () => undefined);
    const second = boot(box, secondRuntime);
    await second.orchestrator.recover();
    await second.orchestrator.sendMessage(task.id, 'claude', 'continue');
    await second.bus.drain();
    const afterFirst = (await second.store.getRun(task.runId))!;
    expect(afterFirst.status).toBe('BLOCKED');
    expect(second.rec.events.find((e) => e.type === 'runtime.error' && e.data.code === 'ADAPTER_RESUME_FAILED')?.data.classifiedAs).toBe('RESUME_CWD_MISSING');
    expect(afterFirst.agentSessions.claude?.metadata?.resumeBlocked).toMatchObject({ code: 'RESUME_CWD_MISSING' });
    const callsUsed = afterFirst.budget.agentCallsUsed;
    const eventsBefore = (await second.store.listEvents(task.runId)).length;

    // 照著舊提示再補充說明一次：明確拒絕（409），不扣預算、不再嘗試續接、不寫新事件
    await expect(second.orchestrator.sendMessage(task.id, 'claude', 'please continue')).rejects.toMatchObject({ statusCode: 409 });
    await second.bus.drain();
    const afterSecond = (await second.store.getRun(task.runId))!;
    expect(afterSecond.budget.agentCallsUsed).toBe(callsUsed);
    expect(secondRuntime.queries).toHaveLength(0);
    expect((await second.store.listEvents(task.runId)).length).toBe(eventsBefore);

    // 可行的出路：換人接手
    await second.orchestrator.reassign(task.id, 'codex', 'take over');
    await second.bus.drain();
    expect(second.codex.calls[0]).toMatchObject({ via: 'start', cwd: box.wt });
  });
});
