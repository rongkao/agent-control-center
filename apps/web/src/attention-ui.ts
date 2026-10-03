import { STEP_LABEL, budgetLabel } from './blocked-ui';
import type { TaskSummary, UnifiedEvent } from './types';

/**
 * 需要人處理的提醒與步驟文案（P1-10：M-28 後台提醒、介面不露內部程式碼）。純函式，便於測試。
 */

export const APP_TITLE = 'Agent Control Center';

/** 需要你處理的任務數：待審批、等你決定、已阻塞。 */
export function attentionCount(tasks: readonly TaskSummary[]): number {
  return tasks.filter((t) => t.pendingApprovals > 0 || t.pendingInputs > 0 || t.status === 'BLOCKED').length;
}

/** 瀏覽器標籤頁標題：有要處理的事就在最前面顯示數字，切到別的標籤頁也看得到。 */
export function attentionTitle(count: number): string {
  return count > 0 ? `(${count}) 需要你處理 · ${APP_TITLE}` : APP_TITLE;
}

export interface AttentionNotice {
  title: string;
  body: string;
  /** 同一件事只提醒一次（瀏覽器按 tag 合併通知）。 */
  tag: string;
}

/**
 * 這個事件是否值得在頁面不在前台時彈出系統通知：需要審批、需要你決定、任務停下、任務完成。
 * 其他事件（工具呼叫、逐字輸出……）一律不提醒。
 */
export function attentionNotice(event: UnifiedEvent, taskTitle?: string): AttentionNotice | undefined {
  const where = taskTitle ? `「${clip(taskTitle, 40)}」` : '一個任務';
  const agent = event.agentId ? ` ${event.agentId}` : '';
  switch (event.type) {
    case 'approval.required': {
      const tag = `approval:${String(event.data.approvalId ?? event.id)}`;
      // 交接請求也是一種審批（編排器發出，kind=handoff）；只提醒這一次，不再對 handoff.requested 單獨提醒
      if (event.data.kind === 'handoff') {
        const to = typeof event.data.toAgentId === 'string' ? event.data.toAgentId : '另一個 AI';
        return { title: '需要你確認交接', body: `${where}裡${agent} 想把工作交給 ${to}`, tag };
      }
      const tool = typeof event.data.toolName === 'string' ? event.data.toolName : '一個操作';
      return { title: '需要你審批', body: `${where}裡${agent} 想執行 ${tool}`, tag };
    }
    case 'run.status': {
      const status = event.data.status;
      if (status === 'BLOCKED') return { title: '任務停下來了', body: `${where}需要你處理：${stepLabel(String(event.data.step ?? ''))}`, tag: `blocked:${event.taskId}` };
      if (status === 'WAITING_INPUT') return { title: '等你決定', body: `${where}等你確認下一步`, tag: `input:${event.taskId}` };
      return undefined;
    }
    case 'run.completed':
      return { title: '任務完成', body: `${where}已經完成`, tag: `done:${event.taskId}` };
    default:
      return undefined;
  }
}

/**
 * 把快照裡的步驟程式碼（例如 operator:budget-resume、budget:maxDurationMs、agent:claude、workflow:test）翻成中文。
 * 認不出的程式碼原樣顯示（總比什麼都不顯示好）。
 */
export function stepLabel(step: string | undefined): string {
  if (!step) return '';
  const [kind, rest = ''] = splitOnce(step, ':');
  switch (kind) {
    case 'queued':
      return '排隊中';
    case 'abandoned':
      return '已放棄（歸檔）';
    case 'agent':
      return rest ? `${rest} 處理中` : '處理中';
    case 'workflow':
      return STEP_LABEL[rest] ?? rest;
    case 'budget':
      return `預算用完：${budgetLabel(rest)}`;
    case 'operator':
      return OPERATOR_STEP[rest] ?? '你的操作';
    case 'watchdog':
      return '長時間沒有動靜';
    case 'handoff':
      return '交接中';
    default:
      return STEP_LABEL[step] ?? step;
  }
}

const OPERATOR_STEP: Record<string, string> = {
  'budget-resume': '已放寬預算，繼續',
  resume: '已恢復，繼續',
  retry: '重試中',
  reassign: '換人接手',
  accept: '已接受結果',
  cancel: '已停止',
  message: '你發了訊息',
};

function splitOnce(text: string, sep: string): [string, string?] {
  const i = text.indexOf(sep);
  return i < 0 ? [text] : [text.slice(0, i), text.slice(i + 1)];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
