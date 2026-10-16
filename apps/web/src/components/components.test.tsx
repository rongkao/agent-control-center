// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingApproval, TaskDetail } from '../types';
import { ApprovalDialog } from './ApprovalDialog';
import { ChangesView } from './ChangesView';
import { QuestionForm } from './QuestionForm';
import { askText } from './TextPrompt';

/**
 * 元件測試（P1-11 / M-30）：在 happy-dom 裡真的渲染元件、點按鈕、按鍵盤，驗證使用者看到和做到的行為。
 */

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('QuestionForm：回答 AI 的問題', () => {
  const questions = [
    { id: 'q0', header: 'DB', question: '用哪個資料庫？', options: [{ label: 'SQLite', description: '本機' }, { label: 'Postgres' }] },
    { id: 'q1', header: '功能', question: '要哪些功能？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
  ];

  it('每題都選了才能送出；多選題可以選多個；送出時按題目 ID 交回', () => {
    const onSubmit = vi.fn();
    render(<QuestionForm questions={questions} busy={false} onSubmit={onSubmit} />);
    const send = screen.getByRole('button', { name: '送出回答' });
    expect(send).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: /SQLite/ }));
    expect(send).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    fireEvent.click(screen.getByRole('button', { name: 'B' }));
    expect(send).toHaveProperty('disabled', false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledWith({ q0: ['SQLite'], q1: ['A', 'B'] });
  });

  it('單選題再點一次會取消；「跳過」交回空答案', () => {
    const onSubmit = vi.fn();
    render(<QuestionForm questions={questions.slice(0, 1)} busy={false} onSubmit={onSubmit} />);
    const sqlite = screen.getByRole('button', { name: /SQLite/ });
    fireEvent.click(sqlite);
    expect(sqlite.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(sqlite);
    expect(sqlite.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '跳過' }));
    expect(onSubmit).toHaveBeenCalledWith({});
  });
});

describe('askText：頁內輸入對話方塊（取代 Electron 不支援的 prompt）', () => {
  it('輸入後按確定回傳文字；按取消回傳 null；必填時空白不能確定', async () => {
    const first = askText({ title: '從這一輪分叉', confirmLabel: '建立', required: true });
    const confirm = await screen.findByRole('button', { name: '建立' });
    expect(confirm).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '換個做法' } });
    fireEvent.click(confirm);
    await expect(first).resolves.toBe('換個做法');

    const second = askText({ title: '換人接手' });
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    await expect(second).resolves.toBeNull();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('ApprovalDialog：鍵盤安全（L-21）', () => {
  const approval: PendingApproval = {
    id: 'ap-1',
    agentId: 'claude',
    summary: 'Claude 想執行 npm test',
    payload: { toolName: 'Bash', toolInput: { command: 'npm test' } },
    createdAt: Date.now(),
    status: 'pending',
  };

  it('打開時焦點在「稍後處理」；按 Enter 不會批准；用滑鼠點「批准」才會', () => {
    const onDecide = vi.fn();
    const onClose = vi.fn();
    render(<ApprovalDialog approval={approval} busy={false} onClose={onClose} onDecide={onDecide} />);
    expect(document.activeElement?.textContent).toBe('稍後處理');
    const approve = screen.getByRole('button', { name: '批准' });
    approve.focus();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(approve);
    expect(onDecide).toHaveBeenCalledWith('approve');
  });

  it('AI 的提問顯示成問題表單，不顯示批准 / 拒絕', () => {
    const question: PendingApproval = {
      ...approval,
      payload: { kind: 'question', questions: [{ id: 'q0', header: 'H', question: '選哪個？', options: [{ label: '甲' }, { label: '乙' }] }] },
    };
    const onDecide = vi.fn();
    render(<ApprovalDialog approval={question} busy={false} onClose={() => undefined} onDecide={onDecide} />);
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '甲' }));
    fireEvent.click(screen.getByRole('button', { name: '送出回答' }));
    expect(onDecide).toHaveBeenCalledWith('approve', { q0: ['甲'] });
  });
});

describe('ChangesView：沒有檢查點時', () => {
  it('說明原因（工作目錄不是 git 倉庫），不顯示撤銷按鈕', () => {
    const detail = {
      task: { id: 't1', title: 't', prompt: 'p', status: 'RUNNING', workflow: 'manual', runId: 'r1', createdAt: 0, updatedAt: 0, projectId: 'local' },
      run: { checkpoints: [] },
      events: [],
      approvals: [],
      usage: [],
    } as unknown as TaskDetail;
    render(<ChangesView detail={detail} onChanged={() => undefined} onError={() => undefined} />);
    expect(screen.getByText(/不是 git 倉庫/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /撤銷最後一輪/ })).toBeNull();
  });
});
