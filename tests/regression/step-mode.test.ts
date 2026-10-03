import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk } from '../fakes/fake-claude-runtime.js';
import { FakeCodexDisk, type CodexScript } from '../fakes/fake-codex-server.js';
import { deferred } from './fakes/deferred.js';
import { busRecorder } from './fakes/event-waiter.js';
import { PermissionModeClaudeRuntime } from './fakes/permission-mode-claude.js';
import { WorkspaceCodexServer } from './fakes/workspace-codex-server.js';

/**
 * P0-4 審查（medium）：唯讀步驟續跑 / 繼續同一會話時，用的是“會話啟動時的 mode”，不是當前步驟的 mode。
 *
 * 場景：「對 Codex 說」+「自動流程」（或 Claude 同時負責實現和評審）：實現者和評審者是同一個 agent，
 * 會話以 implement 模式啟動。到了 review（或 rescue）步驟，dispatchToAgent 發現已有會話就直接 send，丟掉了步驟的 mode：
 * (1) 線上評審回合：Codex turn/start 不帶沙箱覆蓋，仍是 workspace-write；Claude 不切換權限模式，仍是 default（可寫）；
 * (2) 評審中途重啟：resumeInput 取會話後設資料裡的 mode=implement，thread/resume 發出 sandbox:'workspace-write'，Claude 續跑為 default。
 *
 * 期望：派發和續跑都按“當前步驟”計算有效權限——取會話啟動模式和步驟模式裡更嚴格的那個，絕不放寬：
 * - 線上：Codex 在 turn/start 帶 sandboxPolicy 覆蓋；Claude 呼叫 query.setPermissionMode('plan')；回到實現步驟時恢復；
 * - 續跑：從工作流當前步驟推出模式（review / rescue 視為唯讀）。
 */

const REVIEW_MARKER = 'Review the current changes in the workspace';

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
  const root = mkdtempSync(join(tmpdir(), 'acc-step-mode-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'repo-worktrees', 'task-1');
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { repo, wt, db: join(root, 'agent-control.db') };
}

function openProcess(box: Box) {
  const store = new SqliteControlPlaneStore({ path: box.db });
  const bus = new EventBus();
  const orchestrator = new Orchestrator(store, bus, { defaultCwd: box.repo });
  const rec = busRecorder(bus);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    rec.dispose();
    store.close();
  };
  cleanups.push(close);
  return { store, bus, orchestrator, rec, close };
}

/** 同一個 agent 既負責實現又負責評審；測試通過後停在人工閘門。 */
const sameAgentTask = (box: Box, agentId: string) => ({
  title: 'same agent reviews its own work',
  prompt: 'implement the fix',
  agentId,
  reviewAgentId: agentId,
  reviewGate: true,
  cwd: box.wt,
  // 假執行時的回合只有文字回覆（不算語義進展）：放寬停滯上限，避免三輪之後被停滯檢測打斷
  budget: { maxStallCount: 10 },
});

describe('P0-4 審查：Codex 同時負責實現和評審', () => {
  function bootCodex(box: Box, disk: FakeCodexDisk, threadCwds: Map<string, string>, script: CodexScript) {
    const proc = openProcess(box);
    const server = new WorkspaceCodexServer(disk, script, threadCwds);
    proc.orchestrator.registerAdapter(new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: box.repo }));
    return { ...proc, server };
  }

  const turnStarts = (server: WorkspaceCodexServer) => server.received.filter((x) => x.method === 'turn/start').map((x) => x.params as Record<string, unknown>);

  it('線上：評審回合的 turn/start 覆蓋為唯讀沙箱；評審後回到實現步驟時恢復可寫', async () => {
    const box = workspaceBox();
    const script: CodexScript = (ctx) => [{ kind: 'message', text: ctx.text.includes(REVIEW_MARKER) ? 'Please rename x.\nVERDICT: SUGGEST_CHANGES' : 'implemented' }];
    const proc = bootCodex(box, new FakeCodexDisk(), new Map(), script);
    const task = await proc.orchestrator.createTask(sameAgentTask(box, 'codex'));
    await proc.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await proc.bus.drain();
    expect(proc.server.paramsOf('thread/start')).toMatchObject({ cwd: box.wt, sandbox: 'workspace-write' });

    await proc.orchestrator.resolveGate(task.id, 'review');
    // 評審給出修改建議 → 回到實現者（同一個 Codex）按評審修改 → 沒有測試命令，直接完成
    await proc.rec.waitFor((e) => e.type === 'run.completed');
    await proc.bus.drain();

    const starts = turnStarts(proc.server);
    const review = starts.find((p) => JSON.stringify(p.input).includes(REVIEW_MARKER));
    expect(review?.sandboxPolicy).toMatchObject({ type: 'readOnly' });
    const reviewFix = starts.at(-1)!;
    expect(JSON.stringify(reviewFix.input)).toContain("Address the reviewer's suggested changes");
    expect(reviewFix.sandboxPolicy).toMatchObject({ type: 'workspaceWrite' });
  });

  it('評審中途重啟：thread/resume 用唯讀沙箱（修復前按會話啟動模式發出 workspace-write）', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const script: CodexScript = (ctx) => [{ kind: 'message', text: ctx.text.includes(REVIEW_MARKER) ? 'Reading the diff…' : ctx.resumed ? 'Review finished.' : 'implemented' }];

    const first = bootCodex(box, disk, threadCwds, script);
    const task = await first.orchestrator.createTask(sameAgentTask(box, 'codex'));
    await first.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await first.bus.drain();
    // 評審回合一直沒結束（程序在它工作時崩潰）
    first.server.holdTurnCompletion = true;
    await first.orchestrator.resolveGate(task.id, 'review');
    await first.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.message' && e.data.message === 'Reading the diff…');
    await first.bus.drain();
    expect((await first.store.getRun(task.runId))?.workflowState?.step).toBe('review');
    first.close();

    const second = bootCodex(box, disk, threadCwds, script);
    const report = await second.orchestrator.recover();
    expect(report.resumed).toEqual([task.runId]);
    expect(second.server.paramsOf('thread/resume')).toMatchObject({ threadId: 'thread-1', cwd: box.wt, sandbox: 'read-only' });
    await second.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await second.bus.drain();
  });
});

describe('P0-4 審查：Claude 同時負責實現和評審', () => {
  function bootClaude(box: Box, runtime: PermissionModeClaudeRuntime) {
    const proc = openProcess(box);
    proc.orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo }));
    return proc;
  }

  it('線上：評審回合開始前切換到 plan 模式', async () => {
    const box = workspaceBox();
    const runtime = new PermissionModeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
    const proc = bootClaude(box, runtime);
    const task = await proc.orchestrator.createTask(sameAgentTask(box, 'claude'));
    await proc.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await proc.bus.drain();
    expect(runtime.queries[0]?.options).toMatchObject({ cwd: box.wt, permissionMode: 'default' });

    await proc.orchestrator.resolveGate(task.id, 'review');
    // 評審結論無法解析 → 回到人工閘門
    await proc.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT' && e.sequence > 0 && runtime.queries[0]!.prompts.length === 2);
    await proc.bus.drain();
    expect(runtime.queries).toHaveLength(1);
    expect(runtime.modeChanges[0]).toEqual(['plan']);
    // 評審這一輪開始時已經是 plan 模式
    expect(runtime.turnModes[0]).toEqual(['default', 'plan']);
  });

  it('評審中途重啟：Claude 以 plan 模式續跑（修復前按會話啟動模式續跑為 default）', async () => {
    const box = workspaceBox();
    const disk = new FakeClaudeDisk();
    const hold = deferred();
    const script = async (ctx: { prompt: string; resumed: boolean }) => {
      if (!ctx.resumed && ctx.prompt.includes(REVIEW_MARKER)) await hold.promise;
    };

    const firstRuntime = new PermissionModeClaudeRuntime(disk, script);
    const first = bootClaude(box, firstRuntime);
    const task = await first.orchestrator.createTask(sameAgentTask(box, 'claude'));
    await first.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await first.bus.drain();
    await first.orchestrator.resolveGate(task.id, 'review');
    await first.bus.drain();
    expect((await first.store.getRun(task.runId))?.workflowState?.step).toBe('review');
    first.close();

    const secondRuntime = new PermissionModeClaudeRuntime(disk, script);
    const second = bootClaude(box, secondRuntime);
    const report = await second.orchestrator.recover();
    expect(report.resumed).toEqual([task.runId]);
    expect(secondRuntime.queries[0]?.options).toMatchObject({ resume: 'native-session-1', cwd: box.wt, permissionMode: 'plan' });
    await second.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await second.bus.drain();
  });
});
