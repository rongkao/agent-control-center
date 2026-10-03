import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_HANDOFF_TOOL, ClaudeAgentSdkAdapter } from '@acc/adapters';
import { EventBus, Orchestrator } from '@acc/core';
import type { CreateTaskInput, UnifiedEvent } from '@acc/core';
import { InMemoryControlPlaneStore } from '@acc/storage';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { FakeClaudeDisk, FakeClaudeRuntime } from '../fakes/fake-claude-runtime.js';
import { ControlledAgent } from './fakes/controlled-agent.js';
import { busRecorder, emitRecorder } from './fakes/event-waiter.js';
import { PermissionModeClaudeRuntime } from './fakes/permission-mode-claude.js';

/**
 * P0-9：權限傳遞契約。
 *
 * 在交接（操作員轉發、agent 請求、auto 交接）、換人接手、Ask Both、重啟續跑這幾條路徑上，唯讀模式和拒絕規則都不會被放寬：
 * - 會話以唯讀模式（Ask Both 的顧問、評審、診斷）啟動過，之後經任何路徑再派發給它，這一輪仍是隻讀（編排器傳給 adapter 的模式）；
 * - Ask Both 的顧問這一輪一律唯讀——即使它之前是可寫的主 agent（以前沿用會話啟動時的可寫模式，顧問能改檔案）；
 * - 真實的 Claude adapter：唯讀就是 plan 模式；每次（重新）拉起執行時都固定 settingSources: []、strictMcpConfig、受保護路徑鉤子；
 * - 由編排器策略產生的放行（auto 交接、request_handoff 自動放行、重啟後按操作員的批准放行一次）一律只算這一次，
 *   不會擴大為會話級；只有操作員顯式選擇「本會話都允許」才是會話級。
 */

const quiet = () => undefined;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acc-perm-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function boot(store = new InMemoryControlPlaneStore(), agents?: { claude?: ControlledAgent | ClaudeAgentSdkAdapter; codex?: ControlledAgent }) {
  const bus = new EventBus({ log: quiet });
  const orchestrator = new Orchestrator(store, bus, { workspacePolicy: 'shared', log: quiet });
  const claude = agents?.claude ?? new ControlledAgent({ id: 'claude', kind: 'claude' });
  const codex = agents?.codex ?? new ControlledAgent({ id: 'codex', kind: 'codex' });
  orchestrator.registerAdapter(claude);
  orchestrator.registerAdapter(codex);
  const rec = busRecorder(bus);
  cleanups.push(async () => {
    rec.dispose();
    await orchestrator.shutdown();
  });
  return { store, bus, orchestrator, claude, codex, rec };
}

const chat = (cwd: string, agentId = 'claude'): CreateTaskInput => ({ title: 'chat', prompt: 'Fix the login bug', agentId, workflow: 'manual', cwd });

/** 等到 Claude 完成了 n 輪（agent.status completed）。 */
function claudeTurns(rec: ReturnType<typeof busRecorder>, n: number) {
  return rec.waitFor(() => rec.events.filter((x) => x.agentId === 'claude' && x.type === 'agent.status' && x.data.status === 'completed').length >= n);
}

describe('權限傳遞契約：唯讀的會話經任何路徑再派發都仍是隻讀（編排器 → adapter 的模式）', () => {
  /** Claude 是可寫的主 agent，Codex 以唯讀顧問身份回答過一次（會話啟動模式為 analysis）。 */
  async function withAdvisor(policy: 'ask' | 'auto' = 'ask') {
    const env = boot();
    const task = await env.orchestrator.createTask({ ...chat(tempWorkspace()), askBoth: true, handoffPolicy: policy });
    await env.orchestrator.idle();
    const codex = env.codex as ControlledAgent;
    const claude = env.claude as ControlledAgent;
    expect(claude.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    expect(codex.calls[0]).toMatchObject({ via: 'start', mode: 'analysis' });
    return { env, task, codex, claude };
  }

  it('操作員轉發給唯讀顧問：仍是隻讀', async () => {
    const { env, task, codex } = await withAdvisor();
    await env.orchestrator.handoffMessage(task.id, 'claude', 'codex', 'my diff', 'Please double-check');
    await env.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
  });

  it('agent 請求、操作員批准的交接：仍是隻讀', async () => {
    const { env, task, codex, claude } = await withAdvisor();
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Review', content: 'diff' });
    await env.orchestrator.idle();
    const approval = (await env.store.getRun(task.runId))!.pendingApprovals[0]!;
    await env.orchestrator.resolveApproval(task.id, approval.id, 'approve');
    await env.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
  });

  it('auto 交接：仍是隻讀，並且不產生任何（會話級的）批准記錄', async () => {
    const { env, task, codex, claude } = await withAdvisor('auto');
    await claude.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'codex', instruction: 'Review', content: 'diff' });
    await env.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
    const events: UnifiedEvent[] = await env.store.listEvents(task.runId);
    expect(events.filter((e) => e.type === 'approval.resolved')).toEqual([]);
    expect(codex.approvals).toEqual([]);
  });

  it('換人接手給唯讀顧問：舊的唯讀會話不被放寬，接手用的是新開的會話（P1-4 / M-3）', async () => {
    const { env, task, codex } = await withAdvisor();
    const sendsBefore = codex.calls.filter((c) => c.via === 'send').length;
    await env.orchestrator.reassign(task.id, 'codex', 'Take over');
    await env.orchestrator.idle();
    // 沒有任何一次可寫的派發落在舊的唯讀會話上：舊會話上沒有新的 send，接手是新的 start
    expect(codex.calls.filter((c) => c.via === 'send').length).toBe(sendsBefore);
    expect(codex.calls.at(-1)).toMatchObject({ via: 'start', mode: 'implement' });
  });

  it('Ask Both：之前可寫的主 agent 這一輪當顧問時是隻讀的', async () => {
    const env = boot();
    const task = await env.orchestrator.createTask(chat(tempWorkspace()));
    await env.orchestrator.idle();
    const claude = env.claude as ControlledAgent;
    const codex = env.codex as ControlledAgent;
    expect(claude.calls[0]).toMatchObject({ via: 'start', mode: 'implement' });
    // Claude 先把自己可寫的那一輪做完（P0 第三批審查：可寫的一輪還沒結束時「同時問」不再問它，見 ask-both-advisor-rounds.test.ts）
    await claude.complete('done');
    await env.orchestrator.idle();
    // 改由 Codex 當主 agent：Claude 這一輪是隻讀顧問
    await env.orchestrator.askBoth(task.id, 'Any other risks?', 'codex');
    await env.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'start', mode: 'implement' });
    expect(claude.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
    // 再同時問一次（顧問已有隻讀 / 可寫會話）：顧問仍是隻讀
    await env.orchestrator.askBoth(task.id, 'And now?', 'codex');
    await env.orchestrator.idle();
    expect(claude.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
  });

  it('重啟續跑：唯讀顧問續上之後仍是隻讀，之後的交接也是', async () => {
    const store = new InMemoryControlPlaneStore();
    const first = boot(store);
    const task = await first.orchestrator.createTask({ ...chat(tempWorkspace()), askBoth: true });
    await first.orchestrator.idle();

    // “重啟”（程序崩潰，不經過關閉流程）：同一份資料，新的編排器和 adapter 實例（兩個會話重啟前都在工作）
    const second = boot(store);
    const report = await second.orchestrator.recover();
    await second.orchestrator.idle();
    expect(report.resumed).toEqual([task.runId]);
    const claude = second.claude as ControlledAgent;
    const codex = second.codex as ControlledAgent;
    expect(codex.calls[0]).toMatchObject({ via: 'resume', mode: 'analysis', reason: 'recovery' });
    expect(claude.calls[0]).toMatchObject({ via: 'resume', mode: 'implement', reason: 'recovery' });

    await second.orchestrator.handoffMessage(task.id, 'claude', 'codex', 'diff', 'Check it');
    await second.orchestrator.idle();
    expect(codex.calls.at(-1)).toMatchObject({ via: 'send', mode: 'analysis' });
  });
});

describe('權限傳遞契約：真實的 Claude adapter（plan 模式與拒絕規則）', () => {
  /** 每次拉起執行時都必須帶上的拒絕規則：不載入任何 settings、不接配置檔案裡的 MCP、受保護路徑鉤子。 */
  function expectDenyRules(options: Options) {
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.hooks?.PreToolUse?.length ?? 0).toBeGreaterThan(0);
    expect(options.allowedTools ?? []).not.toContain(CLAUDE_HANDOFF_TOOL);
  }

  function realClaude(disk: FakeClaudeDisk) {
    const runtime = new PermissionModeClaudeRuntime(disk, async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    return { runtime, adapter };
  }

  it('Ask Both 的顧問 → 操作員轉發 → auto 交接 → 重啟後續接：一直是 plan，拒絕規則一直都在', async () => {
    const cwd = tempWorkspace();
    const disk = new FakeClaudeDisk();
    const store = new InMemoryControlPlaneStore();
    const first = realClaude(disk);
    const env = boot(store, { claude: first.adapter });
    const task = await env.orchestrator.createTask({ ...chat(cwd, 'codex'), askBoth: true, handoffPolicy: 'auto' });
    await claudeTurns(env.rec, 1);
    await env.orchestrator.idle();

    // 顧問以 plan 啟動
    expect(first.runtime.queries).toHaveLength(1);
    expect(first.runtime.queries[0]!.options.permissionMode).toBe('plan');
    expectDenyRules(first.runtime.queries[0]!.options);

    // 操作員轉發給它
    await env.orchestrator.handoffMessage(task.id, 'codex', 'claude', 'diff', 'Check it');
    await claudeTurns(env.rec, 2);
    // auto 交接給它（結構化請求）
    const codex = env.codex as ControlledAgent;
    await codex.emit('handoff.requested', { origin: 'agent', via: 'tool', toAgentId: 'claude', instruction: 'Review', content: 'diff' });
    await claudeTurns(env.rec, 3);
    await env.orchestrator.idle();
    expect(first.runtime.turnModes[0]).toEqual(['plan', 'plan', 'plan']);
    // 從來沒有被切回可寫
    expect(first.runtime.modeChanges[0]).toEqual([]);
    await env.orchestrator.shutdown();

    // 重啟：新的 adapter 實例；下一次交接走續接，重新拉起的執行時仍是 plan、拒絕規則仍在
    const second = realClaude(disk);
    const restarted = boot(store, { claude: second.adapter });
    await restarted.orchestrator.recover();
    await restarted.orchestrator.idle();
    await restarted.orchestrator.handoffMessage(task.id, 'codex', 'claude', 'diff 2', 'Check it again');
    await claudeTurns(restarted.rec, 1);
    await restarted.orchestrator.idle();
    expect(second.runtime.queries).toHaveLength(1);
    expect(second.runtime.queries[0]!.options.resume).toBeTruthy();
    expect(second.runtime.queries[0]!.options.permissionMode).toBe('plan');
    expectDenyRules(second.runtime.queries[0]!.options);
    expect(second.runtime.modeChanges[0]).toEqual([]);
  });

  it('之前可寫的 Claude 在 Ask Both 裡當顧問：這一輪切到 plan', async () => {
    const cwd = tempWorkspace();
    const { runtime, adapter } = realClaude(new FakeClaudeDisk());
    const env = boot(undefined, { claude: adapter });
    const task = await env.orchestrator.createTask(chat(cwd));
    await claudeTurns(env.rec, 1);
    expect(runtime.queries[0]!.options.permissionMode).toBe('default');
    await env.orchestrator.askBoth(task.id, 'Any other risks?', 'codex');
    await claudeTurns(env.rec, 2);
    await env.orchestrator.idle();
    expect(runtime.modeChanges[0]).toEqual(['plan']);
    expect(runtime.turnModes[0]).toEqual(['default', 'plan']);
  });
});

describe('由編排器策略產生的放行一律只算這一次', () => {
  it('Claude 的 request_handoff 自動放行：不帶任何權限更新（不會變成會話級）', async () => {
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    cleanups.push(() => adapter.dispose());
    await adapter.start({ projectId: 'p', taskId: 't', runId: 'r', prompt: 'hi', cwd: tempWorkspace() }, () => undefined);
    const decision = await runtime.queries[0]!.options.canUseTool!(
      CLAUDE_HANDOFF_TOOL,
      { to: 'codex', instruction: 'x' },
      { signal: new AbortController().signal, toolUseID: 't1', requestId: 'r', mcpServer: { name: 'acc', source: 'sdk' } } as never,
    );
    expect(decision).toEqual({ behavior: 'allow', updatedInput: { to: 'codex', instruction: 'x' }, toolUseID: 't1' });
  });

  it('重啟後按操作員的批准放行：即使當時選的是「本會話都允許」，也只放行重新發起的那一次', async () => {
    const cwd = tempWorkspace();
    const runtime = new FakeClaudeRuntime(new FakeClaudeDisk(), async () => undefined);
    const adapter = new ClaudeAgentSdkAdapter({ queryFn: runtime.queryFn, log: quiet });
    cleanups.push(() => adapter.dispose());
    const rec = emitRecorder();
    await adapter.resume(
      'claude-restarted',
      {
        projectId: 'p',
        taskId: 't',
        runId: 'r',
        agentId: 'claude',
        reason: 'approval',
        step: 'agent:claude',
        approval: { approvalId: 'appr-1', decision: 'approve', scope: 'session' },
        approvalRequest: { toolName: 'Bash', toolInput: { command: 'npm test' } },
        completedSideEffectIds: [],
        lastSequence: 0,
        metadata: { providerSessionId: 'native-session-9', cwd, mode: 'implement' },
      },
      rec.emit,
    );
    const canUseTool = runtime.queries[0]!.options.canUseTool!;
    const ctx = (id: string) => ({ signal: new AbortController().signal, toolUseID: id, requestId: 'r', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }] }) as never;
    const first = await canUseTool('Bash', { command: 'npm test' }, ctx('toolu-1'));
    expect(first).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' }, toolUseID: 'toolu-1' });
    // 第二次同樣的呼叫重新詢問操作員
    void canUseTool('Bash', { command: 'npm test' }, ctx('toolu-2'));
    const asked = await rec.waitFor((e) => e.type === 'approval.required');
    expect(asked.data).toMatchObject({ toolName: 'Bash' });
  });
});
