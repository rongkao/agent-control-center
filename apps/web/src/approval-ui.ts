/**
 * 審批互動的純函式規則（P0-5：L-21 與 H-12 的前端部分），與 React 元件分開，便於單獨測試。
 *
 * - 審批彈窗：初始焦點在「稍後處理」；Tab / Shift+Tab 在彈窗按鈕之間迴圈（焦點陷阱）；回車絕不直接批准。
 * - 審批卡：提交過程中按鈕禁用（防雙擊）；提交成功或已處理之後不再顯示按鈕。
 */

/** 審批彈窗裡的按鈕，按 Tab 順序排列。 */
export type ApprovalDialogButton = 'later' | 'decline' | 'approve';

export const APPROVAL_DIALOG_BUTTONS: readonly ApprovalDialogButton[] = ['later', 'decline', 'approve'];

/** 彈窗開啟時的初始焦點：「稍後處理」。剛開啟時按回車只會關閉彈窗，不會批准。 */
export const APPROVAL_DIALOG_INITIAL_FOCUS: ApprovalDialogButton = 'later';

export type DialogKeyAction =
  /** 關閉彈窗（稍後處理）。 */
  | { type: 'close' }
  /** 把焦點移到指定按鈕（並阻止瀏覽器預設的 Tab 行為）。 */
  | { type: 'focus'; button: ApprovalDialogButton }
  /** 攔下這個按鍵（阻止瀏覽器預設行為，例如回車觸發「批准」）。 */
  | { type: 'block' }
  /** 交給瀏覽器預設處理。 */
  | { type: 'default' };

/**
 * 彈窗開啟期間的按鍵處理規則。
 * @param key 按鍵（KeyboardEvent 的 key / shiftKey / isComposing）
 * @param focused 當前獲得焦點的彈窗按鈕；焦點不在彈窗按鈕上（彈窗外或彈窗內的文字區域）時為 undefined
 * @param enabled 當前可用的按鈕（提交中「批准」「拒絕」不可用）
 */
export function approvalDialogKeyAction(
  key: { key: string; shiftKey?: boolean; isComposing?: boolean },
  focused: ApprovalDialogButton | undefined,
  enabled: readonly ApprovalDialogButton[] = APPROVAL_DIALOG_BUTTONS,
): DialogKeyAction {
  // 輸入法組字中的按鍵交給瀏覽器
  if (key.isComposing) return { type: 'default' };
  switch (key.key) {
    case 'Escape':
      return { type: 'close' };
    case 'Tab': {
      const order = APPROVAL_DIALOG_BUTTONS.filter((button) => enabled.includes(button));
      if (order.length === 0) return { type: 'block' };
      const index = focused ? order.indexOf(focused) : -1;
      const next = key.shiftKey ? (index <= 0 ? order.length - 1 : index - 1) : index < 0 || index >= order.length - 1 ? 0 : index + 1;
      return { type: 'focus', button: order[next]! };
    }
    case 'Enter':
      // 回車從不批准：焦點在「批准」上或不在任何按鈕上時一律攔下（批准只能用滑鼠點選或按空格鍵）；
      // 焦點在「稍後處理」/「拒絕」上時照常觸發該按鈕
      return focused === 'later' || focused === 'decline' ? { type: 'default' } : { type: 'block' };
    default:
      return { type: 'default' };
  }
}

/** 對話內審批卡的顯示狀態。 */
export type ApprovalCardState = 'actionable' | 'submitting' | 'resolved';

/**
 * @param pending 服務端仍把它列為待審批
 * @param submitting 本頁面正在提交這條審批
 * @param submitted 本頁面已經成功提交（等待重新整理）
 */
export function approvalCardState(input: { pending: boolean; submitting: boolean; submitted: boolean }): ApprovalCardState {
  // 已處理，或剛提交成功還沒重新整理：不再顯示按鈕，避免重複提交
  if (!input.pending || input.submitted) return 'resolved';
  return input.submitting ? 'submitting' : 'actionable';
}

/**
 * 防重複提交：同一個 key（審批 ID）在上一次提交結束之前不能再次開始。
 * 狀態儲存在呼叫方的 ref 裡，不依賴 React 重新渲染——雙擊時第二次點選在按鈕變成禁用之前就會被擋下。
 */
export function createSubmitGuard(): { tryBegin(key: string): boolean; end(key: string): void; isActive(key: string): boolean } {
  const active = new Set<string>();
  return {
    tryBegin(key) {
      if (active.has(key)) return false;
      active.add(key);
      return true;
    },
    end(key) {
      active.delete(key);
    },
    isActive(key) {
      return active.has(key);
    },
  };
}

/**
 * 審批提交得到 409 之後，這條審批是否仍然待處理（P0 第二批審查）：任務已阻塞（TASK_BLOCKED）、預算不夠（BUDGET_EXHAUSTED）時
 * 服務端沒有消費它——按鈕要保留，使用者按提示恢復任務或放寬預算之後還能再批准。其餘 409（已經處理過、任務已結束）不再顯示按鈕。
 */
export function approvalStillPendingAfter(code: string | undefined): boolean {
  return code === 'TASK_BLOCKED' || code === 'BUDGET_EXHAUSTED';
}

/** 批准交接時對話任務已阻塞：請使用者確認「恢復並轉交」的文字（服務端的說明裡已經寫了阻塞原因）。 */
export function resumeHandoffConfirm(serverMessage: string): string {
  return `${serverMessage}\n\n確定要恢復任務並轉交嗎？（會先恢復任務，再把內容轉交過去）`;
}

/**
 * 審批卡 / 審批彈窗是否提供「本會話都允許」（P0-8 / M-15）：
 * - 交接請求沒有會話級的說法；
 * - 審批請求標明 allowSessionScope=false（Claude 的 suppressAlwaysAllowRule、沒有可用的會話級規則、命令涉及受保護路徑）時不提供；
 * - 沒有這個欄位的舊記錄沿用原來的行為（提供）。服務端對不允許的會話級批准也只按“這一次”處理。
 */
export function sessionScopeOffered(payload: Record<string, unknown> | undefined): boolean {
  if (!payload) return true;
  if (payload.kind === 'handoff') return false;
  return payload.allowSessionScope !== false;
}

/**
 * 交接請求的說明（P0-9 / H-13）：從文字推斷出的請求（例如 Codex 回覆最後一行的 HANDOFF@ 標記）一律交給操作員確認，
 * 不會被自動執行。auto 策略下另外說明為什麼這次沒有自動執行。結構化的請求、普通審批沒有這條說明。
 */
export function handoffRequestNotice(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload?.kind !== 'handoff') return undefined;
  if (payload.inferred === true) {
    return payload.policy === 'auto' ? '這是從文字推斷的請求，需要你確認（自動交接只會自動執行 AI 透過正式工具提出的請求）。' : '這是從文字推斷的請求，需要你確認。';
  }
  // 唯讀的 agent 請求交給會改檔案的 agent（P0 第三批審查）：自動交接不會替它做這個決定
  // 兩個 AI 在來回交接（P1-8）：自動交接不會替你繼續踢下去
  if (payload.pingPong === true) return '兩個 AI 正在來回互相交接，可能在原地打轉，所以這次需要你確認（自動交接暫停）。可以拒絕後直接告訴它們下一步怎麼做。';
  if (payload.readOnlySource === true) return '提出請求的 AI 這一輪只能讀、不能改檔案，而接手的 AI 可以改檔案，所以需要你確認（自動交接不會自動執行這類請求）。';
  return undefined;
}

/** 審批請求的風險提示（P0-8）：命令涉及受保護路徑時服務端標成 high，並給出中文說明。 */
export function approvalRisk(payload: Record<string, unknown> | undefined): { level: 'high'; text: string } | undefined {
  if (payload?.risk !== 'high') return undefined;
  const text = typeof payload.riskReason === 'string' && payload.riskReason ? payload.riskReason : '這個操作涉及受保護的路徑，請仔細確認後再批准。';
  return { level: 'high', text };
}
