import React from 'react';
import { APPROVAL_DIALOG_INITIAL_FOCUS, approvalDialogKeyAction, approvalRisk, handoffRequestNotice, type ApprovalDialogButton } from '../approval-ui';
import { time } from '../format';
import type { PendingApproval } from '../types';
import { QuestionForm, questionsOf } from './QuestionForm';

/**
 * 審批對話方塊：展示穩定的審批 ID、工具與引數，決定會原樣回傳給對應的 provider 呼叫。
 *
 * 鍵盤安全（L-21）：開啟時焦點在「稍後處理」上，回車不會直接批准；Tab 只在彈窗按鈕之間迴圈（焦點陷阱）；
 * 關閉後焦點回到開啟前的位置。提交中按鈕禁用；這條審批已經處理過（例如在另一個標籤頁或對話裡）時只剩「關閉」。
 */
export function ApprovalDialog({
  approval,
  busy,
  pending = true,
  onClose,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  /** 服務端仍把它列為待審批；false 時不再顯示批准 / 拒絕按鈕。 */
  pending?: boolean;
  onClose: () => void;
  onDecide: (decision: 'approve' | 'decline', answers?: Record<string, string[]>) => void;
}) {
  const payload = approval.payload ?? {};
  const toolInput = payload.toolInput as Record<string, unknown> | undefined;
  const command = typeof toolInput?.command === 'string' ? toolInput.command : undefined;
  // 高風險提示（P0-8：命令涉及受保護路徑）
  const risk = approvalRisk(payload);
  // 從文字推斷的交接請求（P0-9）：說明為什麼需要你確認
  const notice = handoffRequestNotice(payload);
  // AI 向你提問（P2-6）：顯示問題表單，不顯示批准 / 拒絕
  const questions = questionsOf(payload);
  const refs: Record<ApprovalDialogButton, React.RefObject<HTMLButtonElement | null>> = {
    later: React.useRef<HTMLButtonElement>(null),
    decline: React.useRef<HTMLButtonElement>(null),
    approve: React.useRef<HTMLButtonElement>(null),
  };
  const enabled: ApprovalDialogButton[] = pending && !busy ? ['later', 'decline', 'approve'] : ['later'];

  // 開啟時把焦點放在「稍後處理」上；關閉時還給開啟前獲得焦點的元素
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    refs[APPROVAL_DIALOG_INITIAL_FOCUS].current?.focus();
    return () => previous?.focus();
    // 只在彈窗開啟 / 關閉時執行（refs 本身是穩定的）
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const focused = (Object.keys(refs) as ApprovalDialogButton[]).find((name) => refs[name].current === active);
      const action = approvalDialogKeyAction({ key: e.key, shiftKey: e.shiftKey, isComposing: e.isComposing }, focused, enabled);
      switch (action.type) {
        case 'close':
          e.preventDefault();
          onClose();
          return;
        case 'focus':
          e.preventDefault();
          refs[action.button].current?.focus();
          return;
        case 'block':
          e.preventDefault();
          e.stopPropagation();
          return;
        default:
          return;
      }
    };
    // 捕獲階段：在焦點所在元素（例如「批准」按鈕）處理回車之前先攔下
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="審批" onClick={(e) => e.stopPropagation()}>
        <h3>需要你的審批</h3>
        <p className="lead">{approval.summary}</p>
        {risk && <div className="risk high">⚠ 高風險：{risk.text}</div>}
        {notice && <div className="risk notice">ℹ {notice}</div>}
        <dl>
          <dt>Agent</dt>
          <dd>{approval.agentId}</dd>
          <dt>工具</dt>
          <dd>{String(payload.toolName ?? '—')}</dd>
          {command && (
            <>
              <dt>命令</dt>
              <dd><code>{command}</code></dd>
            </>
          )}
          <dt>請求時間</dt>
          <dd>{time(approval.createdAt)}</dd>
          <dt>審批 ID</dt>
          <dd className="mono small">{approval.id}</dd>
        </dl>
        {toolInput && <pre className="log">{JSON.stringify((payload.fullInput as Record<string, unknown> | undefined) ?? toolInput, null, 2)}</pre>}
        {pending && questions ? (
          <>
            <QuestionForm questions={questions} busy={busy} onSubmit={(answers) => onDecide('approve', answers)} />
            <div className="actions end">
              <button ref={refs.later} onClick={onClose}>稍後處理</button>
            </div>
          </>
        ) : pending ? (
          <>
            <div className="actions end">
              <button ref={refs.later} onClick={onClose}>稍後處理</button>
              <button ref={refs.decline} className="danger" onClick={() => onDecide('decline')} disabled={busy}>拒絕</button>
              <button ref={refs.approve} className="primary" onClick={() => onDecide('approve')} disabled={busy}>
                {busy ? '提交中…' : '批准'}
              </button>
            </div>
            <p className="muted small">拒絕後任務會進入阻塞狀態，由你決定下一步；不會自動重試被拒絕的操作。批准請用滑鼠點選（按 Enter 不會批准）。</p>
          </>
        ) : (
          <>
            <p className="muted">這個審批已經處理過了（可能在對話裡或另一個分頁處理了），不需要再操作。</p>
            <div className="actions end">
              <button ref={refs.later} onClick={onClose}>關閉</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
