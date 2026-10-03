import { RESUME_BLOCK_REASON, STEP_LABEL, budgetDuration } from './blocked-ui';
import type { TaskStatus, UnifiedEvent } from './types';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  CREATED: '已建立',
  QUEUED: '排隊中',
  RUNNING: '執行中',
  WAITING_INPUT: '等待你決定',
  WAITING_APPROVAL: '等待審批',
  BLOCKED: '已阻塞',
  FAILED: '失敗',
  CANCELLED: '已停止',
  COMPLETED: '已完成',
};

export const TERMINAL: ReadonlySet<string> = new Set(['FAILED', 'CANCELLED', 'COMPLETED']);

/** 工作流步驟的中文名稱（與阻塞橫幅共用，定義在 blocked-ui.ts）。 */
export { STEP_LABEL };

export const AGENT_STATUS_LABEL: Record<string, string> = {
  idle: '空閒',
  starting: '啟動中',
  planning: '規劃中',
  coding: '編碼中',
  reviewing: '評審中',
  testing: '測試中',
  waiting: '等待中',
  blocked: '已阻塞',
  failed: '失敗',
  completed: '本輪完成',
  cancelled: '已停止',
};

export const EVENT_LABEL: Record<string, string> = {
  'run.started': '任務開始',
  'run.status': '狀態變化',
  'run.completed': '任務完成',
  'run.failed': '任務失敗',
  'agent.started': 'Agent 啟動',
  'agent.status': 'Agent 狀態',
  'agent.message': 'Agent 回覆',
  'model.turn.started': '模型輪次開始',
  'model.turn.completed': '模型輪次結束',
  'tool.started': '工具開始',
  'tool.completed': '工具完成',
  'tool.failed': '工具失敗',
  'handoff.requested': '交接請求',
  'handoff.completed': '交接完成',
  'approval.required': '需要審批',
  'approval.resolved': '審批已處理',
  'approval.delivered': '審批已送達',
  'checkpoint.created': '檢查點',
  'checkpoint.restored': '撤銷了一輪',
  'workspace.merged': '已合入主倉庫',
  'workspace.cleaned': '已刪除 worktree',
  'consult.answered': '諮詢有了答覆',
  'safety.blocked': '安全攔截',
  'budget.exceeded': '超出預算',
  'budget.stalled': '停滯',
  'budget.extended': '預算已調整',
  'runtime.warning': '執行時警告',
  'runtime.error': '執行時錯誤',
};

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 事件的一句話描述（只使用統一事件欄位）。 */
export function describe(event: UnifiedEvent): string {
  const d = event.data;
  const pick = (...keys: string[]) => keys.map((k) => d[k]).find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  switch (event.type) {
    case 'agent.message':
      return pick('message') ?? '';
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed': {
      const input = d.toolInput as Record<string, unknown> | undefined;
      const detail = typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : '';
      return [pick('toolName'), detail, typeof d.exitCode === 'number' ? `exit ${d.exitCode}` : ''].filter(Boolean).join(' · ');
    }
    case 'handoff.requested':
    case 'handoff.completed':
      return `${String(d.fromAgentId)} → ${String(d.toAgentId)}（${String(d.reason ?? d.contextRef ?? '')}）`;
    case 'run.status':
      return [STATUS_LABEL[d.status as TaskStatus] ?? String(d.status), pick('step'), pick('reason')].filter(Boolean).join(' · ');
    case 'budget.exceeded':
    case 'budget.stalled': {
      const fmt = (value: unknown) => (d.limit === 'maxDurationMs' && typeof value === 'number' ? budgetDuration(value) : String(value));
      const text = `${BUDGET_LIMIT_LABEL[String(d.limit)] ?? String(d.limit)}：${fmt(d.used)} / ${fmt(d.max)}`;
      if (d.whileBlocked === true) return `${text}（任務已阻塞，停下了仍在工作的 AI）`;
      // 等你決定（審批 / 評審閘門）期間仍在工作的 AI 超出預算：只停下它，任務仍然等你決定（P0 第二批審查）
      if (d.whileWaiting === true) return `${text}（停下了仍在工作的 AI，任務仍然等你決定）`;
      return text;
    }
    case 'budget.extended':
      return describeBudgetExtended(d);
    default:
      return pick('action', 'summary', 'message', 'code', 'reason', 'status') ?? '';
  }
}

const BUDGET_LIMIT_LABEL: Record<string, string> = {
  maxTurns: '模型輪次',
  maxAgentCalls: 'Agent 呼叫',
  maxReviewRounds: '評審輪次',
  maxStallCount: '連續無進展',
  maxDurationMs: '工作時長',
  maxEstimatedTokens: 'Token',
  maxCostUsd: '估算花費',
};

/** budget.extended 的一句話說明（P0-7）：誰因為什麼調整了預算。 */
function describeBudgetExtended(d: Record<string, unknown>): string {
  const changes = d.changes && typeof d.changes === 'object' ? Object.entries(d.changes as Record<string, { from?: number; to?: number }>) : [];
  const fmt = (limit: string, value: number | undefined) => (value === undefined ? '—' : limit === 'maxDurationMs' ? budgetDuration(value) : String(value));
  const changed = changes.map(([limit, c]) => `${BUDGET_LIMIT_LABEL[limit] ?? limit} ${fmt(limit, c.from)} → ${fmt(limit, c.to)}`).join('，');
  const renewed = d.renew === true ? '重新計算預算（再給一份同樣的額度）' : '';
  const who = d.reason === 'gate' ? `閘門決定（${String(d.gateAction ?? '')}）` : d.reason === 'resume' ? '恢復任務' : d.reason === 'reassign' ? '換人接手' : '操作員';
  return [who, changed, renewed].filter(Boolean).join('：');
}

/** 阻塞原因是“續跑前置條件不滿足”時返回中文說明，否則返回 undefined。 */
export function resumeBlockReason(event: UnifiedEvent | undefined): string | undefined {
  return event ? RESUME_BLOCK_REASON[String(event.data.classifiedAs)] : undefined;
}

/** 工作流給操作員的提示（服務端為英文）→ 本地化。 */
export function operatorPrompt(text: string | undefined): string {
  if (!text) return '等待你的決定。';
  if (/^Tests passed/i.test(text)) return '測試已通過：可以接受結果，或發起一輪評審。';
  if (/^Implementation completed/i.test(text)) return '實現已完成：可以接受結果，或發起一輪評審。';
  const verdict = /^Review verdict (\w+)/i.exec(text)?.[1];
  if (verdict) return `評審結論為 ${verdict}：可以接受結果、寫下說明後重試，或停止任務。`;
  return text;
}

/** NextAction → 人類可讀的“下一步編排動作”。 */
export function describeNextAction(action: unknown): string | undefined {
  if (!action || typeof action !== 'object') return undefined;
  const a = action as Record<string, unknown>;
  switch (a.type) {
    case 'CONTINUE':
      return `繼續由 ${String(a.agentId)} 處理`;
    case 'HANDOFF':
      return `交接：${String(a.fromAgentId)} → ${String(a.toAgentId)}（${String(a.reason)}）`;
    case 'WAIT_INPUT':
      return `等你決定 · ${operatorPrompt(String(a.prompt))}`;
    case 'WAIT_APPROVAL':
      return `等待審批 ${String(a.approvalId)}`;
    case 'FINAL':
      return '任務結束';
    case 'FAIL': {
      const error = a.error as Record<string, unknown> | undefined;
      return `停止並交由人工處理：${String(error?.message ?? error?.code ?? '')}`;
    }
    default:
      return undefined;
  }
}

/** 美元金額（估算）：小於 1 美分顯示“< US$0.01”。 */
export function usd(n: number): string {
  if (!n) return 'US$0';
  if (n < 0.01) return '< US$0.01';
  return `US$${n.toFixed(2)}`;
}
