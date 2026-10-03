import { describe, expect, it } from 'vitest';
import { attentionCount, attentionNotice, attentionTitle, stepLabel } from '../../apps/web/src/attention-ui.js';
import { paneLayout } from '../../apps/web/src/layout-ui.js';

/**
 * P1-10：介面不再直接露出內部程式碼（例如 operator:budget-resume），需要處理的事在後台也有提醒（M-28）。
 */

const ev = (type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id: 'e1', taskId: 't1', runId: 'r1', projectId: 'p', sequence: 1, timestamp: 0, severity: 'info', confidence: 'confirmed', type, data, ...extra }) as never;

describe('步驟程式碼翻成中文', () => {
  it.each([
    ['operator:budget-resume', '已放寬預算，繼續'],
    ['budget:maxDurationMs', '預算用完：執行時長'],
    ['agent:claude', 'claude 處理中'],
    ['workflow:test', '測試'],
    ['queued', '排隊中'],
  ])('%s → %s', (code, label) => {
    expect(stepLabel(code)).toBe(label);
  });
  it('認不出的程式碼原樣顯示，空值顯示為空', () => {
    expect(stepLabel('something-new')).toBe('something-new');
    expect(stepLabel(undefined)).toBe('');
  });
});

describe('後台提醒', () => {
  it('標籤頁標題帶上要處理的數量', () => {
    const tasks = [
      { pendingApprovals: 1, pendingInputs: 0, status: 'WAITING_APPROVAL' },
      { pendingApprovals: 0, pendingInputs: 0, status: 'BLOCKED' },
      { pendingApprovals: 0, pendingInputs: 0, status: 'RUNNING' },
    ] as never[];
    expect(attentionCount(tasks)).toBe(2);
    expect(attentionTitle(2)).toBe('(2) 需要你處理 · Agent Control Center');
    expect(attentionTitle(0)).toBe('Agent Control Center');
  });

  it('只對需要人處理的事彈通知：審批、交接、阻塞、等你決定、完成', () => {
    expect(attentionNotice(ev('approval.required', { approvalId: 'a1', toolName: 'Bash' }, { agentId: 'claude' }), '修 bug')).toEqual({
      title: '需要你審批',
      body: '「修 bug」裡 claude 想執行 Bash',
      tag: 'approval:a1',
    });
    expect(attentionNotice(ev('approval.required', { approvalId: 'handoff:x', kind: 'handoff', toAgentId: 'codex' }, { agentId: 'claude' }))?.title).toBe('需要你確認交接');
    expect(attentionNotice(ev('run.status', { status: 'BLOCKED', step: 'budget:maxDurationMs' }))?.body).toContain('預算用完：執行時長');
    expect(attentionNotice(ev('run.status', { status: 'WAITING_INPUT' }))?.title).toBe('等你決定');
    expect(attentionNotice(ev('run.completed', {}))?.title).toBe('任務完成');
    expect(attentionNotice(ev('run.status', { status: 'RUNNING' }))).toBeUndefined();
    expect(attentionNotice(ev('tool.started', { toolName: 'Read' }))).toBeUndefined();
    expect(attentionNotice(ev('handoff.requested', {}))).toBeUndefined();
  });
});

describe('對話窗格佈局（M-29）', () => {
  it('每個窗格不到 360px 時改成分頁；只有一個窗格或寬度未知時並排', () => {
    expect(paneLayout(1200, 2)).toBe('side-by-side');
    expect(paneLayout(700, 2)).toBe('tabs');
    expect(paneLayout(1000, 3)).toBe('tabs');
    expect(paneLayout(300, 1)).toBe('side-by-side');
    expect(paneLayout(0, 2)).toBe('side-by-side');
  });
});
