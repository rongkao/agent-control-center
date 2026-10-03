import { describe, expect, it } from 'vitest';
import { RETRY_NOTE, blockedBanner, pendingApprovalBanner, type BlockedInput } from '../../apps/web/src/blocked-ui.js';

/**
 * P0-6（介面）：因為 agent 失敗、卡住（看門狗）等原因進入 BLOCKED 時，橫幅顯示真實原因，並給出一鍵出路。
 *
 * 現象（修復前）：橫幅只顯示“任務已阻塞：claude failed in step implement: CLAUDE_API_ERROR”這樣的英文程式碼，
 * 可選操作只寫在文字裡；“帶說明重試”要先填說明才能按，非技術使用者不知道下一步該做什麼。
 * 交接請求等待決定時橫幅寫著“Agent 已暫停”，其實 agent 並沒有停。
 *
 * 期望：原因用中文說清楚（登入失效、額度用完、服務繁忙、程式意外結束、長時間沒有動靜……），
 * 按鈕一鍵可用：「重試」（自動帶上說明）、「換 X 接手」、「停止」；續接前置條件不滿足時不提供註定失敗的「重試」。
 */

const AGENTS = [
  { id: 'claude', name: 'Claude', kind: 'claude' },
  { id: 'codex', name: 'Codex', kind: 'codex' },
  { id: 'test', name: 'Test Runner', kind: 'test' },
];

function workflowBlocked(overrides: { blockedBy: { source: string; code: string; agentId?: string }; lastError?: { agentId: string; code: string; category: string; retryable: boolean }; step?: string; events?: BlockedInput['events']; currentAction?: string }): BlockedInput {
  return {
    task: { currentAction: overrides.currentAction ?? 'blocked' },
    run: {
      status: 'BLOCKED',
      currentStep: `workflow:${overrides.blockedBy.code}`,
      blockedBy: overrides.blockedBy,
      workflowState: { step: overrides.step ?? 'implement', agents: { implement: 'claude', review: 'codex', test: 'test' }, lastError: overrides.lastError },
    },
    events: overrides.events ?? [],
    agents: AGENTS,
  };
}

const kinds = (banner: ReturnType<typeof blockedBanner>) => banner?.actions.map((a) => (a.agentId ? `${a.kind}:${a.agentId}` : a.kind));

describe('BLOCKED 橫幅：真實原因 + 一鍵出路', () => {
  it('不是 BLOCKED 時沒有橫幅', () => {
    const input = workflowBlocked({ blockedBy: { source: 'workflow', code: 'AGENT_FAILED' } });
    expect(blockedBanner({ ...input, run: { ...input.run, status: 'RUNNING' } })).toBeUndefined();
  });

  it('看門狗：長時間沒有動靜 → 說明是哪個 agent、哪一步、多久；可以重試、換人接手、停止', () => {
    const banner = blockedBanner(
      workflowBlocked({
        blockedBy: { source: 'workflow', code: 'STEP_INACTIVE' },
        step: 'rescue',
        events: [{ type: 'runtime.error', agentId: 'codex', data: { code: 'STEP_INACTIVITY_TIMEOUT', step: 'rescue', idleMs: 900_000, thresholdMs: 900_000 } }],
      }),
    )!;
    expect(banner.reason).toContain('Codex');
    expect(banner.reason).toContain('診斷');
    expect(banner.reason).toContain('15 分鐘');
    expect(banner.reason).toContain('沒有任何動靜');
    // 卡住的是診斷的 Codex（P0 第二批審查）：「重試」重跑診斷（rerun），另可讓實現者 Claude 自己繼續；不再提供「換 Codex 接手」
    expect(kinds(banner)).toEqual(['rerun', 'retry', 'stop']);
    expect(banner.actions[0]).toMatchObject({ label: '重試', note: RETRY_NOTE });
    expect(banner.actions.at(-1)).toMatchObject({ label: '停止', confirm: expect.any(String) });
  });

  it.each([
    [{ code: 'CLAUDE_AUTHENTICATION_FAILED', category: 'permission' }, /登入已失效/],
    [{ code: 'CLAUDE_API_ERROR', category: 'usage' }, /用量或額度/],
    [{ code: 'CODEX_USAGE_LIMIT_EXCEEDED', category: 'usage' }, /用量或額度/],
    [{ code: 'CLAUDE_OVERLOADED', category: 'runtime' }, /服務暫時繁忙/],
    [{ code: 'CLAUDE_RUNTIME_EXITED', category: 'runtime' }, /意外結束/],
    [{ code: 'CODEX_TRANSPORT_CLOSED', category: 'runtime' }, /中斷了連線/],
    [{ code: 'CODEX_TURN_INTERRUPTED', category: 'runtime' }, /被中斷/],
    [{ code: 'CLAUDE_ERROR_DURING_EXECUTION', category: 'runtime' }, /在「實現」這一步失敗了（CLAUDE_ERROR_DURING_EXECUTION）/],
  ])('agent 失敗（%o）：中文原因', (error, pattern) => {
    const banner = blockedBanner(workflowBlocked({ blockedBy: { source: 'workflow', code: 'AGENT_FAILED' }, lastError: { agentId: 'claude', retryable: false, ...error } }))!;
    expect(banner.reason).toMatch(pattern);
    expect(banner.reason).toContain('Claude');
    expect(kinds(banner)).toEqual(['retry', 'reassign:codex', 'stop']);
  });

  it('api_error_status 529 從錯誤事件裡讀取：說明是服務繁忙', () => {
    const banner = blockedBanner(
      workflowBlocked({
        blockedBy: { source: 'workflow', code: 'AGENT_FAILED' },
        lastError: { agentId: 'claude', code: 'CLAUDE_API_ERROR', category: 'runtime', retryable: true },
        events: [{ type: 'runtime.error', agentId: 'claude', data: { code: 'CLAUDE_API_ERROR', apiErrorStatus: 529 } }],
      }),
    )!;
    expect(banner.reason).toMatch(/服務暫時繁忙/);
  });

  it('續接前置條件不滿足：不提供註定失敗的「重試」，只給換人接手 / 停止', () => {
    const banner = blockedBanner(
      workflowBlocked({
        blockedBy: { source: 'runtime', code: 'ADAPTER_RESUME_FAILED', agentId: 'claude' },
        events: [{ type: 'runtime.error', agentId: 'claude', data: { code: 'ADAPTER_RESUME_FAILED', classifiedAs: 'RESUME_CWD_MISSING' } }],
      }),
    )!;
    expect(banner.reason).toMatch(/找不到這個對話原來的工作目錄/);
    expect(kinds(banner)).toEqual(['reassign:codex', 'stop']);
  });

  it('拒絕了審批：說明被拒絕的操作沒有執行，仍可一鍵重試', () => {
    const banner = blockedBanner(workflowBlocked({ blockedBy: { source: 'approval', code: 'APPROVAL_DECLINED', agentId: 'claude' } }))!;
    expect(banner.reason).toMatch(/你拒絕了一個操作/);
    expect(kinds(banner)).toEqual(['retry', 'reassign:codex', 'stop']);
  });

  it('測試在重試和診斷之後仍然失敗 / 預算用完：中文原因', () => {
    expect(blockedBanner(workflowBlocked({ blockedBy: { source: 'workflow', code: 'TESTS_FAILED' }, step: 'fix' }))!.reason).toMatch(/測試.*仍然失敗/);
    expect(blockedBanner(workflowBlocked({ blockedBy: { source: 'budget', code: 'maxTurns' } }))!.reason).toMatch(/預算上限（模型輪次）/);
  });

  it('對話任務（沒有工作流）：沒有工作流的「重試」，可以換人接手或停止', () => {
    const banner = blockedBanner({
      task: { currentAction: 'Session ownership conflict' },
      run: { status: 'BLOCKED', currentStep: 'blocked:SESSION_OWNERSHIP_CONFLICT', blockedBy: { source: 'runtime', code: 'SESSION_OWNERSHIP_CONFLICT', agentId: 'claude' }, primaryAgentId: 'claude' },
      events: [],
      agents: AGENTS,
    })!;
    expect(banner.reason).toContain('Session ownership conflict');
    expect(kinds(banner)).toEqual(['reassign:codex', 'stop']);
  });
});

describe('待審批橫幅', () => {
  it('只有交接請求：說明是誰請求交給誰，不寫“Agent 已暫停”', () => {
    const text = pendingApprovalBanner([{ agentId: 'claude', payload: { kind: 'handoff', fromAgentId: 'claude', toAgentId: 'codex' } }], AGENTS)!;
    expect(text).toContain('Claude 請求把工作交給 Codex');
    expect(text).not.toContain('已暫停');
  });

  it('有普通操作等待審批：Agent 已暫停', () => {
    expect(pendingApprovalBanner([{ agentId: 'claude', payload: { toolName: 'Bash' } }], AGENTS)).toBe('有 1 個操作等待你的審批，Agent 已暫停。');
    expect(pendingApprovalBanner([], AGENTS)).toBeUndefined();
  });
});
