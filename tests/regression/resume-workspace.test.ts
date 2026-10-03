import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeAgentSdkAdapter, CodexAppServerAdapter, sameWorkspacePath } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { AgentMode, AgentResumeInput } from '@acc/core';
import { SqliteControlPlaneStore } from '@acc/storage';
import { FakeClaudeDisk, FakeClaudeRuntime, type FakeScript } from '../fakes/fake-claude-runtime.js';
import { FakeCodexDisk, type CodexScript } from '../fakes/fake-codex-server.js';
import { WorkflowAgent } from '../fakes/workflow-agent.js';
import { deferred } from './fakes/deferred.js';
import { busRecorder, emitRecorder } from './fakes/event-waiter.js';
import { WorkspaceCodexServer } from './fakes/workspace-codex-server.js';

/**
 * H-4 / P0-4：續跑時使用持久化的 cwd 和 mode。
 *
 * 現象（修復前）：編排器已經把會話的 cwd 和 mode 放進了 resumeInput.metadata，但
 * - Claude 的 resume 固定用 adapter 的 defaultCwd，也不傳 mode → 重啟後評審/分析會話從 plan 模式變回 default（可寫），
 *   而且跑在主倉庫裡；
 * - Codex 的 thread/resume 固定用 defaultCwd → 用 worktree 建立的任務重啟後在主倉庫裡寫程式碼。
 *
 * 期望：兩個 adapter 都從 metadata 讀取 cwd 和 mode；讀不到就 fail closed（結構化錯誤 → 編排器發 runtime.error，
 * run 進入帶原因的 BLOCKED），絕不回退到 defaultCwd；Codex 續接後比對服務端回報的 cwd（規範化後），不一致就 fail closed。
 *
 * 覆蓋編排器的三條續跑路徑：重啟恢復（recover）、審批後續跑（resolveApproval）、操作員再發訊息（sendMessage）。
 * 所有等待都由事件驅動（emitRecorder / busRecorder），不按時間 sleep。
 */

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };
const READ_ONLY_MODES: AgentMode[] = ['review', 'rescue', 'analysis'];

interface Box {
  /** 主倉庫（adapter 與編排器的 defaultCwd）。 */
  repo: string;
  /** 為任務建立的 worktree（任務真正的工作目錄）。 */
  wt: string;
  db: string;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** 真實存在的臨時目錄：主倉庫與它旁邊的 worktree。 */
function workspaceBox(): Box {
  const root = mkdtempSync(join(tmpdir(), 'acc-h4-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'repo-worktrees', 'task-1');
  mkdirSync(repo, { recursive: true });
  mkdirSync(wt, { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { repo, wt, db: join(root, 'agent-control.db') };
}

function resumeInput(agentId: string, metadata: Record<string, unknown>): AgentResumeInput {
  return { ...ids, agentId, reason: 'recovery', step: 'workflow:review', completedSideEffectIds: [], lastSequence: 1, metadata };
}

/** 開啟一個“程序”：SQLite 儲存 + 事件匯流排 + 編排器（defaultCwd 指向主倉庫，用來證明續跑不會回退到它）。 */
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
  // 清理按後進先出執行：先關庫，再刪目錄
  cleanups.push(close);
  return { store, bus, orchestrator, rec, close };
}

const worktreeTask = (box: Box, reviewAgentId: string) => ({
  title: 'worktree task',
  prompt: 'implement the fix',
  agentId: 'impl',
  reviewAgentId,
  reviewGate: true,
  cwd: box.wt,
  workspace: { kind: 'worktree' as const, repoPath: box.repo, branch: 'acc/task-1' },
});

describe('H-4 ClaudeAgentSdkAdapter.resume 使用持久化的 cwd 與 mode（fake-claude-runtime）', () => {
  it.each([...READ_ONLY_MODES, 'implement' as const])('mode=%s：query options 用 metadata 裡的 worktree cwd；唯讀模式續跑後仍是 plan', async (mode) => {
    const box = workspaceBox();
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
    const first = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo });
    const c1 = emitRecorder();
    const handle = await first.start({ ...ids, prompt: 'go', cwd: box.wt, mode }, c1.emit);
    await c1.waitFor((e) => e.type === 'model.turn.completed');

    // 模擬重啟：新的 adapter 實例，defaultCwd 是主倉庫
    const second = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo });
    const c2 = emitRecorder();
    await second.resume(handle.sessionId, resumeInput('claude', { providerSessionId: handle.providerSessionId, cwd: box.wt, mode }), c2.emit);

    const expected = mode === 'implement' ? 'default' : 'plan';
    expect(runtime.queries[0]?.options).toMatchObject({ cwd: box.wt, permissionMode: expected });
    expect(runtime.queries[1]?.options).toMatchObject({ resume: 'native-session-1', cwd: box.wt, permissionMode: expected });
    await c2.waitFor((e) => e.type === 'model.turn.completed');
  });

  it('metadata 裡沒有 cwd（或不是絕對路徑）：fail closed，不建立 SDK 查詢，不回退到 defaultCwd', async () => {
    const box = workspaceBox();
    for (const cwd of [undefined, '', '   ', 'relative/task-1']) {
      const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
      const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo });
      const metadata = { providerSessionId: 'native-session-7', mode: 'review', ...(cwd === undefined ? {} : { cwd }) };
      await expect(adapter.resume('claude-s', resumeInput('claude', metadata), emitRecorder().emit), `cwd=${String(cwd)}`).rejects.toMatchObject({
        code: 'RESUME_CWD_MISSING',
        category: 'runtime',
        retryable: false,
      });
      expect(runtime.queries).toHaveLength(0);
    }
  });

  it('metadata 裡沒有 mode（或不是已知模式）：fail closed，不會預設成可寫模式', async () => {
    const box = workspaceBox();
    for (const mode of [undefined, 'yolo']) {
      const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
      const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo });
      const metadata = { providerSessionId: 'native-session-7', cwd: box.wt, ...(mode === undefined ? {} : { mode }) };
      await expect(adapter.resume('claude-s', resumeInput('claude', metadata), emitRecorder().emit), `mode=${String(mode)}`).rejects.toMatchObject({
        code: 'RESUME_MODE_MISSING',
      });
      expect(runtime.queries).toHaveLength(0);
    }
  });
});

describe('H-4 CodexAppServerAdapter thread/resume 使用持久化的 cwd 與 mode（fake-codex-server）', () => {
  function codexPair(box: Box, disk: FakeCodexDisk, threadCwds: Map<string, string>, script: CodexScript = () => [{ kind: 'message', text: 'ok' }]) {
    const server = new WorkspaceCodexServer(disk, script, threadCwds);
    const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: box.repo });
    return { server, adapter };
  }

  /** 先在 worktree 裡啟動一個執行緒，返回它的會話標識（模擬重啟前的程序）。 */
  async function startedThread(box: Box, disk: FakeCodexDisk, threadCwds: Map<string, string>, mode: AgentMode) {
    const first = codexPair(box, disk, threadCwds);
    const c = emitRecorder();
    const handle = await first.adapter.start({ ...ids, prompt: 'go', cwd: box.wt, mode }, c.emit);
    await c.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    expect(first.server.paramsOf('thread/start')).toMatchObject({ cwd: box.wt });
    return handle;
  }

  it.each([...READ_ONLY_MODES, 'implement' as const])('mode=%s：thread/resume 帶 worktree cwd，唯讀模式仍是 read-only 沙箱', async (mode) => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const handle = await startedThread(box, disk, threadCwds, mode);

    const second = codexPair(box, disk, threadCwds);
    const c = emitRecorder();
    await second.adapter.resume(handle.sessionId, resumeInput('codex', { providerSessionId: handle.providerSessionId, cwd: box.wt, mode }), c.emit);

    const readOnly = mode !== 'implement';
    expect(second.server.paramsOf('thread/resume')).toMatchObject({
      threadId: 'thread-1',
      cwd: box.wt,
      approvalPolicy: 'on-request',
      sandbox: readOnly ? 'read-only' : 'workspace-write',
    });
    expect(second.server.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-1', cwd: box.wt });
    // 續接後的會話狀態與啟動時一致：唯讀會話顯示為評審中，而不是編碼中
    expect(c.events.find((e) => e.type === 'agent.status')?.data.status).toBe(readOnly ? 'reviewing' : 'coding');
    await c.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
  });

  it('metadata 裡沒有 cwd：fail closed，不發 thread/resume，不回退到 defaultCwd', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const handle = await startedThread(box, disk, threadCwds, 'review');
    for (const cwd of [undefined, 'relative/task-1']) {
      const second = codexPair(box, disk, threadCwds);
      const metadata = { providerSessionId: handle.providerSessionId, mode: 'review', ...(cwd === undefined ? {} : { cwd }) };
      await expect(second.adapter.resume(handle.sessionId, resumeInput('codex', metadata), emitRecorder().emit), `cwd=${String(cwd)}`).rejects.toMatchObject({
        code: 'RESUME_CWD_MISSING',
        category: 'runtime',
        retryable: false,
      });
      expect(second.server.received.map((x) => x.method)).not.toContain('thread/resume');
    }
  });

  it('metadata 裡沒有 mode：fail closed（修復前會退回 workspace-write 可寫沙箱）', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const handle = await startedThread(box, disk, threadCwds, 'review');
    const second = codexPair(box, disk, threadCwds);
    await expect(
      second.adapter.resume(handle.sessionId, resumeInput('codex', { providerSessionId: handle.providerSessionId, cwd: box.wt }), emitRecorder().emit),
    ).rejects.toMatchObject({ code: 'RESUME_MODE_MISSING' });
    expect(second.server.received.map((x) => x.method)).not.toContain('thread/resume');
  });

  it('服務端回報的 cwd 與期望不一致：fail closed，不開始新回合', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const handle = await startedThread(box, disk, threadCwds, 'review');
    const second = codexPair(box, disk, threadCwds);
    second.server.resumeCwdOverride = box.repo;
    await expect(
      second.adapter.resume(handle.sessionId, resumeInput('codex', { providerSessionId: handle.providerSessionId, cwd: box.wt, mode: 'review' }), emitRecorder().emit),
    ).rejects.toMatchObject({ code: 'CODEX_RESUME_CWD_MISMATCH', category: 'runtime', retryable: false });
    expect(second.server.received.map((x) => x.method)).toContain('thread/resume');
    expect(second.server.received.map((x) => x.method)).not.toContain('turn/start');
    expect(disk.executions).toEqual([]);
  });

  it('cwd 比較先規範化：同一目錄的不同寫法（大小寫 / 分隔符 / 結尾分隔符 / 長路徑前綴）視為一致', async () => {
    const box = workspaceBox();
    const variants =
      process.platform === 'win32'
        ? [box.wt.toUpperCase(), box.wt.replace(/\\/g, '/'), `${box.wt}\\`, `\\\\?\\${box.wt}`]
        : [`${box.wt}/`, `${box.wt}/./`, join(box.wt, '..', 'task-1')];
    for (const reported of variants) {
      const disk = new FakeCodexDisk();
      const threadCwds = new Map<string, string>();
      const handle = await startedThread(box, disk, threadCwds, 'review');
      const second = codexPair(box, disk, threadCwds);
      second.server.resumeCwdOverride = reported;
      const c = emitRecorder();
      await expect(
        second.adapter.resume(handle.sessionId, resumeInput('codex', { providerSessionId: handle.providerSessionId, cwd: box.wt, mode: 'review' }), c.emit),
        `reported=${reported}`,
      ).resolves.toBeUndefined();
      await c.waitFor((e) => e.type === 'agent.status' && e.data.status === 'completed');
    }
  });
});

describe('H-4 工作目錄規範化比較（sameWorkspacePath，與宿主平台無關）', () => {
  it('Windows：不區分大小寫，統一分隔符，忽略結尾分隔符與長路徑前綴（\\\\?\\），解析 . 與 ..', () => {
    // 用正斜槓書寫、再換成反斜槓，避免在原始碼裡層層轉義
    const w = (path: string) => path.replace(/\//g, '\\');
    const same: Array<[string, string]> = [
      [w('C:/Work/Repo/wt'), 'c:/work/repo/wt'],
      [w('C:/Work/Repo/wt/'), w('C:/Work/Repo/wt')],
      [w('//?/C:/Work/Repo/wt'), w('C:/Work/Repo/wt')],
      [w('//?/UNC/server/share/wt'), w('//server/share/wt')],
      [w('C:/Work/Repo/./x/../wt'), w('C:/Work/Repo/wt')],
    ];
    for (const [a, b] of same) expect(sameWorkspacePath(a, b, 'win32'), `${a} vs ${b}`).toBe(true);
    expect(sameWorkspacePath(w('C:/Work/Repo/wt'), w('C:/Work/Repo'), 'win32')).toBe(false);
    expect(sameWorkspacePath(w('C:/Work/Repo'), w('D:/Work/Repo'), 'win32')).toBe(false);
  });

  it('POSIX：區分大小寫，忽略結尾分隔符，解析 . 與 ..', () => {
    expect(sameWorkspacePath('/work/repo/wt/', '/work/repo/wt', 'linux')).toBe(true);
    expect(sameWorkspacePath('/work/repo/./x/../wt', '/work/repo/wt', 'linux')).toBe(true);
    expect(sameWorkspacePath('/Work/Repo/wt', '/work/repo/wt', 'linux')).toBe(false);
    expect(sameWorkspacePath('/work/repo/wt', '/work/repo', 'linux')).toBe(false);
  });
});

describe('H-4 編排器 + SQLite 重啟續接：worktree cwd + 唯讀模式（Claude）', () => {
  function bootClaude(box: Box, disk: FakeClaudeDisk, script: FakeScript) {
    const proc = openProcess(box);
    const runtime = new FakeClaudeRuntime(disk, script);
    proc.orchestrator.registerAdapter(new WorkflowAgent({ id: 'impl' }));
    proc.orchestrator.registerAdapter(new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, defaultCwd: box.repo }));
    return { ...proc, runtime };
  }

  it('重啟恢復（recover）：正在評審的 Claude 會話按 worktree cwd、plan 模式續接', async () => {
    const box = workspaceBox();
    const disk = new FakeClaudeDisk();
    // 重啟前的評審回合一直沒結束（程序在它工作時崩潰）
    const hold = deferred();
    const script: FakeScript = async (ctx) => {
      if (!ctx.resumed) await hold.promise;
    };

    const first = bootClaude(box, disk, script);
    const task = await first.orchestrator.createTask(worktreeTask(box, 'claude'));
    await first.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await first.bus.drain();
    await first.orchestrator.resolveGate(task.id, 'review');
    await first.bus.drain();
    expect(first.runtime.queries[0]?.options).toMatchObject({ cwd: box.wt, permissionMode: 'plan' });
    const before = await first.store.getRun(task.runId);
    expect(before?.status).toBe('RUNNING');
    // 編排器確實把 cwd 與 mode 持久化在會話後設資料裡（resumeInput 的來源）
    expect(before?.agentSessions.claude?.metadata).toMatchObject({ mode: 'review', cwd: box.wt });
    first.close();

    const second = bootClaude(box, disk, script);
    const report = await second.orchestrator.recover();
    expect(report.resumed).toEqual([task.runId]);
    expect(second.runtime.queries).toHaveLength(1);
    expect(second.runtime.queries[0]?.options).toMatchObject({ resume: 'native-session-1', cwd: box.wt, permissionMode: 'plan' });
    // 續接後的評審回合正常結束，工作流繼續推進（評審結論無法解析 → 回到人工閘門）
    await second.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await second.bus.drain();
  });

  it('操作員再發訊息（sendMessage）：對話任務裡唯讀顧問（analysis）的 Claude 續跑後仍是 plan、仍在 worktree', async () => {
    const box = workspaceBox();
    const disk = new FakeClaudeDisk();
    const script: FakeScript = async () => undefined;

    const first = bootClaude(box, disk, script);
    const task = await first.orchestrator.createTask({ title: 'ask both', prompt: 'what is wrong?', agentId: 'impl', workflow: 'manual', askBoth: true, cwd: box.wt });
    await first.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await first.bus.drain();
    expect(first.runtime.queries[0]?.options).toMatchObject({ cwd: box.wt, permissionMode: 'plan' });
    expect((await first.store.getRun(task.runId))?.agentSessions.claude?.metadata).toMatchObject({ mode: 'analysis', cwd: box.wt });
    first.close();

    const second = bootClaude(box, disk, script);
    const report = await second.orchestrator.recover();
    // 空閒的對話會話重啟時不打擾，下一條訊息再續接
    expect(report.waiting).toEqual([task.runId]);
    await second.orchestrator.sendMessage(task.id, 'claude', 'any other risks?');
    expect(second.runtime.queries[0]?.options).toMatchObject({ resume: 'native-session-1', cwd: box.wt, permissionMode: 'plan' });
    await second.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await second.bus.drain();
  });

  it('會話後設資料裡沒有 cwd：續跑 fail closed，run 進入帶原因的 BLOCKED，不回退到 defaultCwd', async () => {
    const box = workspaceBox();
    const disk = new FakeClaudeDisk();
    const script: FakeScript = async () => undefined;

    const first = bootClaude(box, disk, script);
    const task = await first.orchestrator.createTask({ title: 'chat', prompt: 'hi', agentId: 'claude', workflow: 'manual', cwd: box.wt });
    await first.rec.waitFor((e) => e.agentId === 'claude' && e.type === 'agent.status' && e.data.status === 'completed');
    await first.bus.drain();
    // 模擬舊版本寫下的殘缺快照：會話後設資料裡沒有 cwd
    const run = (await first.store.getRun(task.runId))!;
    delete run.agentSessions.claude!.metadata!.cwd;
    await first.store.commit({ run });
    first.close();

    const second = bootClaude(box, disk, script);
    await second.orchestrator.recover();
    await second.orchestrator.sendMessage(task.id, 'claude', 'continue');
    await second.bus.drain();

    expect(second.runtime.queries).toHaveLength(0);
    expect((await second.store.getRun(task.runId))?.status).toBe('BLOCKED');
    const error = second.rec.events.find((e) => e.type === 'runtime.error' && e.data.code === 'ADAPTER_RESUME_FAILED');
    expect(error).toMatchObject({ agentId: 'claude', confidence: 'confirmed', data: { classifiedAs: 'RESUME_CWD_MISSING', category: 'runtime', retryable: false } });
  });
});

describe('H-4 編排器 + SQLite 重啟續接：worktree cwd + review 模式（Codex）', () => {
  function bootCodex(box: Box, disk: FakeCodexDisk, threadCwds: Map<string, string>, script: CodexScript) {
    const proc = openProcess(box);
    const server = new WorkspaceCodexServer(disk, script, threadCwds);
    proc.orchestrator.registerAdapter(new WorkflowAgent({ id: 'impl' }));
    proc.orchestrator.registerAdapter(new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: box.repo }));
    return { ...proc, server };
  }

  /** 程序 1：實現完成 → 操作員請求評審 → Codex 在 worktree 裡以 review 模式開始評審。 */
  async function startReview(first: ReturnType<typeof bootCodex>, box: Box) {
    const task = await first.orchestrator.createTask(worktreeTask(box, 'codex'));
    await first.rec.waitFor((e) => e.type === 'run.status' && e.data.status === 'WAITING_INPUT');
    await first.bus.drain();
    await first.orchestrator.resolveGate(task.id, 'review');
    expect(first.server.paramsOf('thread/start')).toMatchObject({ cwd: box.wt, sandbox: 'read-only' });
    return task;
  }

  it('審批後續跑（resolveApproval）：thread/resume 帶 worktree cwd 與 read-only 沙箱', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const script: CodexScript = () => [
      { kind: 'command', id: 'R', command: 'git diff --stat', needsApproval: true },
      { kind: 'message', text: 'Looks good.' },
    ];

    const first = bootCodex(box, disk, threadCwds, script);
    const task = await startReview(first, box);
    await first.rec.waitFor((e) => e.type === 'approval.required');
    await first.bus.drain();
    const waiting = await first.store.getRun(task.runId);
    expect(waiting?.status).toBe('WAITING_APPROVAL');
    expect(waiting?.agentSessions.codex?.metadata).toMatchObject({ mode: 'review', cwd: box.wt });
    const approvalId = waiting!.pendingApprovals[0]!.id;
    first.close();

    const second = bootCodex(box, disk, threadCwds, script);
    expect((await second.orchestrator.recover()).waiting).toEqual([task.runId]);
    await second.orchestrator.resolveApproval(task.id, approvalId, 'approve');
    expect(second.server.paramsOf('thread/resume')).toMatchObject({ threadId: 'thread-1', cwd: box.wt, sandbox: 'read-only' });
    expect(second.server.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-1', cwd: box.wt });
    await second.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await second.bus.drain();
    expect(disk.executions).toEqual(['R']);
  });

  it('重啟恢復（recover）：正在評審的 Codex 執行緒按 worktree cwd、read-only 沙箱續接', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const script: CodexScript = (ctx) => [{ kind: 'message', text: ctx.resumed ? 'Review finished.' : 'Reading the diff…' }];

    const first = bootCodex(box, disk, threadCwds, script);
    // 重啟前的評審回合一直沒結束
    first.server.holdTurnCompletion = true;
    const task = await startReview(first, box);
    await first.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.message' && e.data.message === 'Reading the diff…');
    await first.bus.drain();
    const before = await first.store.getRun(task.runId);
    expect(before?.status).toBe('RUNNING');
    expect(before?.agentSessions.codex).toMatchObject({ status: 'reviewing', metadata: { mode: 'review', cwd: box.wt } });
    first.close();

    const second = bootCodex(box, disk, threadCwds, script);
    const report = await second.orchestrator.recover();
    expect(report.resumed).toEqual([task.runId]);
    expect(second.server.paramsOf('thread/resume')).toMatchObject({ threadId: 'thread-1', cwd: box.wt, sandbox: 'read-only' });
    expect(second.server.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-1', cwd: box.wt });
    await second.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.status' && e.data.status === 'completed');
    await second.bus.drain();
  });

  it('Codex 續接後回報的 cwd 不是 worktree：fail closed，run 進入帶原因的 BLOCKED，不開始新回合', async () => {
    const box = workspaceBox();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const script: CodexScript = () => [{ kind: 'message', text: 'Reading the diff…' }];

    const first = bootCodex(box, disk, threadCwds, script);
    first.server.holdTurnCompletion = true;
    const task = await startReview(first, box);
    await first.rec.waitFor((e) => e.agentId === 'codex' && e.type === 'agent.message' && e.data.message === 'Reading the diff…');
    await first.bus.drain();
    first.close();

    const second = bootCodex(box, disk, threadCwds, script);
    // 服務端沒有採用我們要求的目錄，而是回到了主倉庫
    second.server.resumeCwdOverride = box.repo;
    const report = await second.orchestrator.recover();
    await second.bus.drain();

    expect(report.blocked).toEqual([task.runId]);
    expect(second.server.received.map((x) => x.method)).toContain('thread/resume');
    expect(second.server.received.map((x) => x.method)).not.toContain('turn/start');
    expect((await second.store.getRun(task.runId))?.status).toBe('BLOCKED');
    const error = second.rec.events.find((e) => e.type === 'runtime.error' && e.data.code === 'ADAPTER_RESUME_FAILED');
    expect(error).toMatchObject({ agentId: 'codex', confidence: 'confirmed', data: { classifiedAs: 'CODEX_RESUME_CWD_MISMATCH', retryable: false } });
  });
});
