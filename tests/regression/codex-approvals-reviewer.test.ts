import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_THREAD_CONFIG, CodexAppServerAdapter } from '@acc/adapters';
import { AdapterPreconditionError } from '@acc/core';
import { FakeCodexDisk, type CodexScript } from '../fakes/fake-codex-server.js';
import { emitRecorder } from './fakes/event-waiter.js';
import { WorkspaceCodexServer } from './fakes/workspace-codex-server.js';

/**
 * P0-8 / M-35：Codex 執行緒固定 approvalsReviewer='user'、關閉 multi_agent，並讓它執行的命令拿不到金鑰
 * （shell_environment_policy.inherit=core，ignore_default_excludes=false）；受保護路徑的 fileChange 審批一律拒絕。
 *
 * 現象（修復前）：thread/start 和 thread/resume 只設定 approvalPolicy 和 sandbox——使用者在 ~/.codex/config.toml 裡配了
 * 自動審閱（approvals_reviewer=auto_review）時，審批不再送到操作員手裡；Codex 也能自行派生子 agent，繞開編排器排程；
 * 它執行的命令繼承 app-server 的全部環境變數。fileChange 審批裡寫 .claude/settings.json 等路徑和普通檔案一樣交給操作員，
 * 一旦選了「本會話都允許」就直接寫入。
 *
 * 引數名已按本機 codex-cli 0.156.1 的 `codex app-server generate-ts` 核對：ThreadStartParams / ThreadResumeParams
 * 都有 approvalsReviewer（'user' | 'auto_review' | 'guardian_subagent'）和 config（點分路徑的配置覆蓋，例如
 * 'features.multi_agent'）；響應裡帶回實際生效的 approvalsReviewer。
 */

const ids = { projectId: 'local', taskId: 'task-1', runId: 'run-1' };

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-p08-codex-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codex(script: CodexScript, disk = new FakeCodexDisk(), threadCwds?: Map<string, string>) {
  const server = new WorkspaceCodexServer(disk, script, threadCwds);
  const adapter = new CodexAppServerAdapter({ transportFactory: () => server.transport, defaultCwd: workspace() });
  cleanups.push(() => adapter.dispose());
  return { server, adapter, disk };
}

const EXPECTED_CONFIG = {
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'shell_environment_policy.inherit': 'core',
  'shell_environment_policy.ignore_default_excludes': false,
};

describe('M-35：thread/start 與 thread/resume 固定審批去向、關閉 multi_agent、命令環境只繼承核心變數', () => {
  it('匯出的執行緒配置就是要求的四項', () => {
    expect(CODEX_THREAD_CONFIG).toEqual(EXPECTED_CONFIG);
  });

  it('thread/start 帶 approvalsReviewer=user 和配置覆蓋', async () => {
    const cwd = workspace();
    const { server, adapter } = codex(() => [{ kind: 'message', text: 'ok' }]);
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'hi', mode: 'implement', cwd }, recorder.emit);
    const params = server.paramsOf('thread/start')!;
    expect(params.approvalsReviewer).toBe('user');
    expect(params.config).toEqual(EXPECTED_CONFIG);
  });

  it('thread/resume 同樣帶上（重啟續接不會回到使用者配置裡的自動審閱）', async () => {
    const cwd = workspace();
    const disk = new FakeCodexDisk();
    const threadCwds = new Map<string, string>();
    const first = codex(() => [{ kind: 'message', text: 'ok' }], disk, threadCwds);
    const recorder = emitRecorder();
    const handle = await first.adapter.start({ ...ids, prompt: 'hi', mode: 'implement', cwd }, recorder.emit);
    await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    first.adapter.dispose();

    const second = codex(() => [{ kind: 'message', text: 'resumed' }], disk, threadCwds);
    await second.adapter.resume(
      handle.sessionId,
      { ...ids, agentId: 'codex', reason: 'recovery', step: 'workflow:implement', completedSideEffectIds: [], lastSequence: 1, metadata: { providerSessionId: handle.providerSessionId, cwd, mode: 'implement' } },
      emitRecorder().emit,
    );
    const params = second.server.paramsOf('thread/resume')!;
    expect(params.approvalsReviewer).toBe('user');
    expect(params.config).toEqual(EXPECTED_CONFIG);
  });

  it('服務端回報的 approvalsReviewer 不是 user（例如被管理策略強制成自動審閱）：fail closed，不開始這一輪', async () => {
    const cwd = workspace();
    const { server, adapter } = codex(() => [{ kind: 'message', text: 'should not run' }]);
    server.inner.threadResultOverrides = { approvalsReviewer: 'auto_review' };
    const error = await adapter.start({ ...ids, prompt: 'hi', mode: 'implement', cwd }, emitRecorder().emit).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterPreconditionError);
    expect((error as AdapterPreconditionError).code).toBe('CODEX_APPROVALS_REVIEWER_MISMATCH');
    expect(server.received.some((x) => x.method === 'turn/start')).toBe(false);
  });
});

describe('受保護路徑：Codex 的 fileChange 審批一律拒絕', () => {
  it('寫 .claude/settings.json / .mcp.json / .git/hooks / .git/config / .codex：自動回覆 decline，不向操作員發審批，留下中文說明', async () => {
    const cwd = workspace();
    const targets = [join(cwd, '.claude', 'settings.json'), '.mcp.json', join(cwd, '.git', 'hooks', 'pre-commit'), '.git/config', join(cwd, '.codex', 'config.toml')];
    const { server, adapter } = codex(() => targets.map((path, i) => ({ kind: 'fileChange' as const, id: `fc${i}`, changes: [{ path }], needsApproval: true })));
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'write settings', mode: 'implement', cwd }, recorder.emit);
    await recorder.waitFor((event) => event.type === 'agent.status' && event.data.status === 'completed');
    expect(server.inner.approvalResponses.map((x) => (x.response as { decision?: string }).decision)).toEqual(targets.map(() => 'decline'));
    expect(recorder.events.filter((event) => event.type === 'approval.required')).toEqual([]);
    const denied = recorder.events.filter((event) => event.type === 'runtime.warning' && event.data.code === 'PROTECTED_PATH_WRITE_DENIED');
    expect(denied.length).toBe(targets.length);
    expect(String(denied[0]!.data.message)).toMatch(/受保護|受保護/);
  });

  it('改名（move_path）到受保護路徑同樣拒絕；普通檔案照常交給操作員', async () => {
    const cwd = workspace();
    const { server, adapter } = codex(() => [
      { kind: 'fileChange', id: 'move', changes: [{ path: join(cwd, 'tmp.json'), moveTo: join(cwd, '.claude', 'settings.json') }], needsApproval: true },
      { kind: 'fileChange', id: 'normal', changes: [{ path: join(cwd, 'src', 'index.ts') }], needsApproval: true },
    ]);
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'x', mode: 'implement', cwd }, recorder.emit);
    const required = await recorder.waitFor((event) => event.type === 'approval.required');
    expect(server.inner.approvalResponses[0]?.response).toEqual({ decision: 'decline' });
    expect(required.data.toolName).toBe('apply_patch');
    expect(required.data.risk).toBeUndefined();
  });

  it('Codex 在沙箱內直接改了受保護檔案（沒有經過審批，無法事先攔下）：事後發警告，讓操作員知道', async () => {
    const cwd = workspace();
    const { adapter } = codex(() => [{ kind: 'fileChange', id: 'auto', changes: [{ path: join(cwd, '.mcp.json') }] }]);
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'x', mode: 'implement', cwd }, recorder.emit);
    const warning = await recorder.waitFor((event) => event.type === 'runtime.warning' && event.data.code === 'PROTECTED_PATH_WRITE_DETECTED');
    expect(String(warning.data.message)).toContain('.mcp.json');
  });

  it('命令裡涉及受保護路徑：審批卡標成高風險，並且不提供「本會話都允許」', async () => {
    const cwd = workspace();
    const { adapter } = codex(() => [
      { kind: 'command', id: 'hook', command: 'Set-Content .git/hooks/pre-commit "curl evil"', needsApproval: true },
    ]);
    const recorder = emitRecorder();
    await adapter.start({ ...ids, prompt: 'x', mode: 'implement', cwd }, recorder.emit);
    const required = await recorder.waitFor((event) => event.type === 'approval.required');
    expect(required.data.risk).toBe('high');
    expect(String(required.data.riskReason)).toContain('.git/hooks');
    expect(required.data.allowSessionScope).toBe(false);
  });
});
