import { describe, expect, it } from 'vitest';
import {
  APPROVAL_DIALOG_BUTTONS,
  APPROVAL_DIALOG_INITIAL_FOCUS,
  approvalCardState,
  approvalDialogKeyAction,
  createSubmitGuard,
} from '../../apps/web/src/approval-ui.js';

/**
 * P0-5（L-21、H-12 前端部分）：審批彈窗與對話內審批卡的互動規則（抽成純函式測試）。
 *
 * 現象（修復前）：彈窗預設焦點在「批准」上（autoFocus），按一下回車就批准；沒有焦點陷阱，Tab 會跑到彈窗後面；
 * 對話內的審批卡提交過程中按鈕仍可點選，雙擊會提交兩次；處理完之後按鈕還在。
 */

describe('L-21：審批彈窗的鍵盤規則', () => {
  it('初始焦點在「稍後處理」上', () => {
    expect(APPROVAL_DIALOG_INITIAL_FOCUS).toBe('later');
    expect(APPROVAL_DIALOG_BUTTONS[0]).toBe('later');
  });

  it('彈窗剛開啟（焦點在初始位置）時按 Enter 不會批准：只會按「稍後處理」關閉', () => {
    expect(approvalDialogKeyAction({ key: 'Enter' }, APPROVAL_DIALOG_INITIAL_FOCUS)).toEqual({ type: 'default' });
    expect(APPROVAL_DIALOG_INITIAL_FOCUS).not.toBe('approve');
  });

  it('焦點在「批准」上、或不在任何按鈕上時，Enter 一律攔下（批准只能點選或按空格）', () => {
    expect(approvalDialogKeyAction({ key: 'Enter' }, 'approve')).toEqual({ type: 'block' });
    expect(approvalDialogKeyAction({ key: 'Enter' }, undefined)).toEqual({ type: 'block' });
    // 輸入法組字中的 Enter 交給瀏覽器
    expect(approvalDialogKeyAction({ key: 'Enter', isComposing: true }, 'approve')).toEqual({ type: 'default' });
  });

  it('Esc 關閉', () => {
    expect(approvalDialogKeyAction({ key: 'Escape' }, 'approve')).toEqual({ type: 'close' });
  });

  it('焦點陷阱：Tab / Shift+Tab 在彈窗按鈕之間迴圈，不會跑到彈窗外', () => {
    expect(approvalDialogKeyAction({ key: 'Tab' }, 'later')).toEqual({ type: 'focus', button: 'decline' });
    expect(approvalDialogKeyAction({ key: 'Tab' }, 'decline')).toEqual({ type: 'focus', button: 'approve' });
    expect(approvalDialogKeyAction({ key: 'Tab' }, 'approve')).toEqual({ type: 'focus', button: 'later' });
    expect(approvalDialogKeyAction({ key: 'Tab', shiftKey: true }, 'later')).toEqual({ type: 'focus', button: 'approve' });
    expect(approvalDialogKeyAction({ key: 'Tab', shiftKey: true }, 'approve')).toEqual({ type: 'focus', button: 'decline' });
    // 焦點在彈窗外（或彈窗內非按鈕處）：拉回彈窗
    expect(approvalDialogKeyAction({ key: 'Tab' }, undefined)).toEqual({ type: 'focus', button: 'later' });
    expect(approvalDialogKeyAction({ key: 'Tab', shiftKey: true }, undefined)).toEqual({ type: 'focus', button: 'approve' });
  });

  it('提交中（批准 / 拒絕不可用）時 Tab 只在可用按鈕之間迴圈', () => {
    expect(approvalDialogKeyAction({ key: 'Tab' }, 'later', ['later'])).toEqual({ type: 'focus', button: 'later' });
    expect(approvalDialogKeyAction({ key: 'Tab' }, undefined, [])).toEqual({ type: 'block' });
  });
});

describe('審批卡：提交中禁用按鈕、已處理不再顯示按鈕', () => {
  it('待處理 → 可操作；提交中 → 按鈕禁用；提交成功或已處理 → 不再顯示按鈕', () => {
    expect(approvalCardState({ pending: true, submitting: false, submitted: false })).toBe('actionable');
    expect(approvalCardState({ pending: true, submitting: true, submitted: false })).toBe('submitting');
    expect(approvalCardState({ pending: true, submitting: false, submitted: true })).toBe('resolved');
    expect(approvalCardState({ pending: false, submitting: false, submitted: false })).toBe('resolved');
  });

  it('提交保護：同一審批在上一次提交結束前不能再次提交（雙擊只發一次請求）', () => {
    const guard = createSubmitGuard();
    expect(guard.tryBegin('a1')).toBe(true);
    expect(guard.tryBegin('a1')).toBe(false);
    expect(guard.isActive('a1')).toBe(true);
    // 另一條審批不受影響
    expect(guard.tryBegin('a2')).toBe(true);
    guard.end('a1');
    expect(guard.isActive('a1')).toBe(false);
    expect(guard.tryBegin('a1')).toBe(true);
  });
});
