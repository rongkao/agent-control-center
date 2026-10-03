import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter, ACP_PRESETS, detectAcpArgs, unpinnedNpxProblem } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import { FakeAcpAgent, type FakeAcpOptions } from '../fakes/fake-acp-agent.js';
import { busRecorder } from './fakes/event-waiter.js';

/**
 * P2-1 通用 ACP adapter（與假 ACP agent 端到端）：
 * - 一輪：流式回覆 + 完整回覆、工具呼叫、權限走 ACC 審批（批准 / 本會話都允許 / 拒絕）、以 completed 結束；
 * - 唯讀的一輪：改檔案的權限請求自動拒絕，有 plan 模式時切過去；
 * - 取消：這一輪以 cancelled 結束；
 * - 續接：優先 session/resume；只有 session/load 時回放期間的更新不進事件日誌、不進副作用台賬；
 * - 啟動前探測引數（--acp 不可用時回退 --experimental-acp）；npx 必須固定版本號。
 */

const quiet = () => undefined;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function boot(options: FakeAcpOptions = {}, store = new InMemoryControlPlaneStore(), fake = new FakeAcpAgent(options)) {
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const adapter = new AcpAdapter({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', transportFactory: () => fake.transport(), log: quiet, defaultCwd: process.cwd() });
  orchestrator.registerAdapter(adapter);
  const rec = busRecorder(bus);
  cleanups.push(async () => {
    rec.dispose();
    await orchestrator.shutdown();
  });
  return { store, bus, orchestrator, adapter, fake, rec };
}

describe('P2-1：ACP adapter', () => {
  it('一輪：回覆、工具呼叫、權限走審批（批准），以 completed 結束', async () => {
    const env = boot({ tool: { kind: 'edit', title: 'Edit src/a.ts' } });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'fix it', agentId: 'gemini', workflow: 'manual' });
    const required = await env.rec.waitFor((e) => e.type === 'approval.required');
    expect(required.data).toMatchObject({ toolName: 'edit', summary: 'Edit src/a.ts', allowSessionScope: true, providerCallId: 'call-1' });
    await env.orchestrator.idle();
    await env.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve', 'session');
    await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    await env.orchestrator.idle();
    expect(env.fake.permissionOutcomes[0]).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    const events = await env.store.listEvents(task.runId);
    expect(events.find((e) => e.type === 'agent.message' && e.data.direction === 'from-agent')?.data.message).toBe('Working on it.');
    expect(events.some((e) => e.type === 'tool.completed' && e.data.providerCallId === 'call-1')).toBe(true);
    expect(env.fake.prompts[0]).toContain('fix it');
  });

  it('拒絕：工具以失敗結束（改檔案的呼叫標記為可能已執行）', async () => {
    const env = boot({ tool: { kind: 'edit', title: 'Edit' } });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'gemini', workflow: 'manual' });
    const required = await env.rec.waitFor((e) => e.type === 'approval.required');
    await env.orchestrator.idle();
    await env.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'decline');
    await env.rec.waitFor((e) => e.type === 'tool.failed');
    expect(env.fake.permissionOutcomes[0]!.outcome).toMatchObject({ optionId: 'reject' });
  });

  it('唯讀的一輪：改檔案的權限請求自動拒絕；有 plan 模式時切過去', async () => {
    // 唯讀模式由編排器按步驟傳給 adapter（評審、診斷、Ask Both 的顧問）；這裡直接以 review 模式啟動
    const direct = new FakeAcpAgent({ tool: { kind: 'edit', title: 'Edit' }, modes: ['default', 'plan'] });
    const adapter = new AcpAdapter({ id: 'x', command: 'x', transportFactory: () => direct.transport(), log: quiet });
    cleanups.push(() => adapter.dispose());
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'look', mode: 'review', cwd: process.cwd() }, (e) => void events.push(e as never));
    for (let i = 0; i < 100 && !events.some((e) => e.type === 'agent.status' && e.data.status === 'completed'); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(direct.modeChanges).toEqual(['plan']);
    expect(direct.permissionOutcomes[0]!.outcome).toMatchObject({ optionId: 'reject' });
    expect(events.some((e) => e.type === 'approval.required')).toBe(false);
    expect(events.some((e) => e.type === 'runtime.warning' && e.data.code === 'ACP_READ_ONLY_DENIED')).toBe(true);
  });

  it('取消：這一輪以 cancelled 結束', async () => {
    const env = boot({ hang: true });
    const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'gemini', workflow: 'manual' });
    await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'coding');
    await env.orchestrator.cancelTask(task.id);
    await env.orchestrator.idle();
    expect((await env.store.getRun(task.runId))!.status).toBe('CANCELLED');
  });

  it('續接：只有 session/load 時回放的更新不進事件日誌和副作用台賬；支援 resume 時不回放', async () => {
    for (const resume of [false, true]) {
      const store = new InMemoryControlPlaneStore();
      const fake = new FakeAcpAgent({ resume, tool: { kind: 'read', title: 'Read' } });
      const env = boot({}, store, fake);
      const task = await env.orchestrator.createTask({ title: 't', prompt: 'p', agentId: 'gemini', workflow: 'manual' });
      const required = await env.rec.waitFor((e) => e.type === 'approval.required');
      await env.orchestrator.idle();
      await env.orchestrator.resolveApproval(task.id, String(required.data.approvalId), 'approve');
      await env.rec.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
      await env.orchestrator.idle();
      const before = (await store.listEvents(task.runId)).filter((e) => e.type === 'tool.completed').length;
      expect(before).toBe(1);

      // 新的 adapter 實例（程序重啟後）續接同一個會話
      const run = (await store.getRun(task.runId))!;
      const session = run.agentSessions.gemini!;
      const restarted = new AcpAdapter({ id: 'gemini', command: 'gemini', transportFactory: () => fake.transport(), log: quiet, defaultCwd: process.cwd() });
      cleanups.push(() => restarted.dispose());
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      const sinkPromise = new Promise<void>((resolve) => {
        void restarted.resume(
          String(session.metadata?.adapterSessionId ?? 'x'),
          { projectId: 'local', taskId: task.id, runId: task.runId, agentId: 'gemini', reason: 'message', message: 'continue', completedSideEffectIds: ['call-1'], metadata: { providerSessionId: session.providerSessionId, cwd: process.cwd() } } as never,
          (e) => {
            events.push(e as never);
            if ((e as { type: string }).type === 'agent.status' && String((e as { data: Record<string, unknown> }).data.status) === 'coding') resolve();
          },
        );
      });
      await sinkPromise;
      expect(fake.calls).toContain(resume ? 'resumeSession' : 'loadSession');
      // 回放出來的舊訊息、舊工具呼叫都沒有被當成新事件
      expect(events.filter((e) => e.type === 'tool.started' || e.type === 'tool.completed')).toEqual([]);
      expect(events.filter((e) => e.type === 'agent.message' && e.data.ephemeral === true)).toEqual([]);
      await restarted.dispose();
    }
  });
});

describe('P2-1：認證', () => {
  it('開會話要求認證時按 agent 提供的方式認證一次再重試：有 API key 用 API key，否則用第一個（已登入的快取）', async () => {
    for (const [envSource, expected] of [
      [{}, 'oauth-personal'],
      [{ GEMINI_API_KEY: 'k' }, 'gemini-api-key'],
    ] as const) {
      const fake = new FakeAcpAgent({ requireAuth: true });
      const adapter = new AcpAdapter({ id: 'gemini', command: 'gemini', envSource, transportFactory: () => fake.transport(), log: quiet });
      cleanups.push(() => adapter.dispose());
      const handle = await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'hi', cwd: process.cwd() }, () => undefined);
      expect(handle.providerSessionId).toBe('s1');
      expect(fake.authenticated).toEqual([expected]);
    }
  });
});

describe('P2-1：啟動前探測與版本固定', () => {
  it('--acp 不可用時回退到 --experimental-acp', () => {
    const candidates = ACP_PRESETS.gemini!.argCandidates!;
    expect(detectAcpArgs('Options:\n  --acp  Start in ACP mode\n', candidates)).toEqual(['--acp']);
    expect(detectAcpArgs('Options:\n  --experimental-acp  Starts the agent in ACP mode\n', candidates)).toEqual(['--experimental-acp']);
    expect(detectAcpArgs('', candidates)).toEqual(['--experimental-acp']);
    const adapter = new AcpAdapter({ id: 'gemini', command: 'gemini', argCandidates: candidates, helpProbe: () => '  --experimental-acp  ACP' });
    expect(adapter.launchArgs()).toEqual(['--experimental-acp']);
  });

  it('npx 必須固定版本號', () => {
    expect(unpinnedNpxProblem('npx', ['-y', '@agentclientprotocol/claude-agent-acp'])).toMatch(/固定版本號/);
    expect(unpinnedNpxProblem('npx', ['-y', '@agentclientprotocol/claude-agent-acp@latest'])).toMatch(/固定版本號/);
    expect(unpinnedNpxProblem('npx.cmd', ['@agentclientprotocol/claude-agent-acp@0.5.1'])).toBeUndefined();
    expect(unpinnedNpxProblem('gemini', ['--acp'])).toBeUndefined();
    const adapter = new AcpAdapter({ id: 'c', command: 'npx', args: ['-y', 'some-acp-agent'] });
    expect(adapter.info.ready).toBe(false);
    expect(adapter.info.notReadyReason).toMatch(/固定版本號/);
  });
});
