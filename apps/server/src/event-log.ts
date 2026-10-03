import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UnifiedEvent } from '@acc/core';

/**
 * 可讀事件日誌：每個統一事件一行，同時輸出到控制台並追加到 logs/events.log。
 * 只用於人工排查；持久真相仍是資料庫裡的事件日誌。
 */
const LABEL: Record<string, string> = {
  'run.started': '任務開始',
  'run.status': '狀態',
  'run.completed': '任務完成',
  'run.failed': '任務失敗',
  'agent.started': 'Agent 啟動',
  'agent.status': 'Agent 狀態',
  'agent.message': '對話',
  'model.turn.started': '輪次開始',
  'model.turn.completed': '輪次結束',
  'tool.started': '工具開始',
  'tool.completed': '工具完成',
  'tool.failed': '工具失敗',
  'handoff.requested': '交接請求',
  'handoff.completed': '交接完成',
  'approval.required': '需要審批',
  'approval.resolved': '審批結果',
  'approval.delivered': '審批已送達',
  'safety.blocked': '安全攔截',
  'budget.exceeded': '超出預算',
  'budget.stalled': '停滯',
  'runtime.warning': '警告',
  'runtime.error': '錯誤',
};

const oneLine = (value: unknown, max = 160) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export function formatEvent(event: UnifiedEvent): string {
  const d = event.data;
  let detail = '';
  switch (event.type) {
    case 'agent.message':
      detail = d.direction === 'to-agent' ? `${d.from === 'operator' ? '你' : '編排器'} → ${event.agentId}: ${oneLine(d.message)}` : `${event.agentId}: ${oneLine(d.message)}`;
      break;
    case 'tool.started': {
      const input = (d.toolInput ?? {}) as Record<string, unknown>;
      detail = `${String(d.toolName)} ${oneLine(input.command ?? input.file_path ?? input.pattern ?? '', 120)}`;
      break;
    }
    case 'tool.completed':
    case 'tool.failed':
      detail = `${String(d.toolName)}${typeof d.exitCode === 'number' ? ` exit=${d.exitCode}` : ''} ${oneLine(d.output, 100)}`;
      break;
    case 'approval.required':
      detail = `${oneLine(d.summary)} [${String(d.approvalId)}]`;
      break;
    case 'approval.resolved':
      detail = `${String(d.decision)} [${String(d.approvalId)}]`;
      break;
    case 'run.status':
      detail = `${String(d.status)} ${String(d.step ?? '')}${d.reason ? ` · ${oneLine(d.reason)}` : ''}`;
      break;
    case 'handoff.requested':
    case 'handoff.completed':
      detail = `${String(d.fromAgentId)} → ${String(d.toAgentId)} (${String(d.reason ?? d.contextRef ?? '')})`;
      break;
    case 'budget.exceeded':
    case 'budget.stalled':
      detail = `${String(d.limit)} ${String(d.used)}/${String(d.max)}`;
      break;
    default:
      detail = oneLine(d.code ?? d.status ?? d.action ?? d.reason ?? d.message ?? '');
  }
  const time = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
  const who = (event.agentId ?? '系統').padEnd(6);
  const confidence = event.confidence === 'inferred' ? ' (推斷)' : '';
  return `${time} [任務 ${event.taskId.slice(0, 8)}] #${String(event.sequence).padStart(3)} ${who} ${LABEL[event.type] ?? event.type}${confidence} ${detail}`;
}

/** 事件日誌單個檔案的大小上限（位元組，P1-12）：超過就輪轉成 events.log.1 … events.log.3。 */
export const EVENT_LOG_MAX_BYTES = 20 * 1024 * 1024;
const EVENT_LOG_KEEP = 3;

/** 超過上限時輪轉：events.log.2 → .3，.1 → .2，events.log → .1（最舊的被覆蓋）。失敗隻影響日誌，不影響執行。 */
function rotateIfNeeded(file: string, maxBytes: number): void {
  try {
    if (!existsSync(file) || statSync(file).size < maxBytes) return;
    for (let i = EVENT_LOG_KEEP - 1; i >= 1; i -= 1) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  } catch {
    // 忽略
  }
}

export function createEventLogger(dir: string, options: { echo?: boolean; maxBytes?: number } = {}): (event: UnifiedEvent) => void {
  // echo=false：只寫檔案，不輸出到控制台（測試或嵌入桌面外殼時使用）
  const echo = options.echo ?? true;
  let file: string | undefined;
  let written = 0;
  try {
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'events.log');
    rotateIfNeeded(file, options.maxBytes ?? EVENT_LOG_MAX_BYTES);
  } catch {
    file = undefined;
  }
  return (event) => {
    const line = formatEvent(event);
    if (echo) process.stdout.write(`${line}\n`);
    if (file) {
      // 每寫 200 行檢查一次大小，免得每一行都去 stat 檔案
      if (++written % 200 === 0) rotateIfNeeded(file, options.maxBytes ?? EVENT_LOG_MAX_BYTES);
      try {
        appendFileSync(file, `${line}\n`, 'utf8');
      } catch {
        // 日誌檔案寫入失敗不影響執行
      }
    }
  };
}
