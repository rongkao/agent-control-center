import type { BlockedBy, RunSnapshot, TaskRecord, UnifiedEvent, UsageRecord } from './types.js';

/**
 * 唯讀投影（可隨時重建）：用量彙總（P3.3）與任務摘要（P3.1/P3.2）。
 * 不屬於恢復所需的持久真相，只服務 UI。
 */

export interface UsageCounters {
  agentCalls: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** P1-7：估算美元花費（只有上報美元的 provider，目前是 Claude）。 */
  costUsd: number;
  /** P1-7：今天（服務端本地時間）的估算美元花費。 */
  costUsdToday: number;
  /** 由 provider 上報的 token 數；其餘為估算。 */
  reportedTokens: number;
  durationMs: number;
  failures: number;
  testFailures: number;
  stalls: number;
  budgetBlocks: number;
  reviewRounds: number;
}

export interface UsageSummary {
  runs: number;
  activeRuns: number;
  totals: UsageCounters;
  byAgent: Array<{ agentId: string } & UsageCounters>;
}

const zero = (): UsageCounters => ({
  agentCalls: 0,
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  costUsd: 0,
  costUsdToday: 0,
  reportedTokens: 0,
  durationMs: 0,
  failures: 0,
  testFailures: 0,
  stalls: 0,
  budgetBlocks: 0,
  reviewRounds: 0,
});

const ACTIVE = new Set(['CREATED', 'QUEUED', 'RUNNING', 'WAITING_INPUT', 'WAITING_APPROVAL', 'BLOCKED']);

export function summarizeUsage(items: Array<{ run: RunSnapshot; usage: UsageRecord[]; events: UnifiedEvent[] }>, now = Date.now()): UsageSummary {
  const totals = zero();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const byAgent = new Map<string, UsageCounters>();
  const agent = (id: string | undefined) => {
    const key = id ?? 'orchestrator';
    let counters = byAgent.get(key);
    if (!counters) {
      counters = zero();
      byAgent.set(key, counters);
    }
    return counters;
  };

  for (const { run, usage, events } of items) {
    totals.agentCalls += run.budget.agentCallsUsed;
    totals.reviewRounds += run.budget.reviewRoundsUsed;
    for (const record of usage) {
      const tokens = (record.inputTokens ?? 0) + (record.outputTokens ?? 0);
      for (const c of [totals, agent(record.agentId)]) {
        c.inputTokens += record.inputTokens ?? 0;
        c.outputTokens += record.outputTokens ?? 0;
        c.cachedTokens += record.cachedTokens ?? 0;
        c.costUsd += record.costUsd ?? 0;
        if (record.createdAt >= todayStart) c.costUsdToday += record.costUsd ?? 0;
        c.durationMs += record.durationMs ?? 0;
        if (record.providerReported) c.reportedTokens += tokens;
      }
    }
    for (const event of events) {
      const targets = [totals, agent(event.agentId)];
      const add = (field: keyof UsageCounters) => targets.forEach((c) => (c[field] += 1));
      switch (event.type) {
        case 'agent.started':
          // 每次派發給已有會話不會產生 agent.started，按會話啟動數統計各 agent 的呼叫
          agent(event.agentId).agentCalls += 1;
          break;
        case 'model.turn.completed':
          add('turns');
          break;
        case 'runtime.error':
          add('failures');
          break;
        case 'tool.failed':
          if (event.data.toolName === 'test') add('testFailures');
          else add('failures');
          break;
        case 'budget.stalled':
          add('stalls');
          break;
        case 'budget.exceeded':
          add('budgetBlocks');
          break;
        default:
          break;
      }
    }
  }

  return {
    runs: items.length,
    activeRuns: items.filter((x) => ACTIVE.has(x.run.status)).length,
    totals,
    byAgent: [...byAgent.entries()].filter(([id]) => id !== 'orchestrator').map(([agentId, c]) => ({ agentId, ...c })),
  };
}

export interface TaskSummary {
  taskId: string;
  runId: string;
  title: string;
  status: string;
  step: string;
  workflowStep?: string;
  currentAgentId?: string;
  currentAction?: string;
  pendingApprovals: number;
  pendingInputs: number;
  recovered?: { count: number; at: number };
  blocker?: string;
  /** 結構化的阻塞原因（P0-5，僅 BLOCKED 時）：來源與程式碼，便於介面給出對應的出路。 */
  blockedBy?: Pick<BlockedBy, 'source' | 'code' | 'agentId' | 'approvalId'>;
  updatedAt: number;
  createdAt: number;
}

/** 任務列表摘要：包含阻塞原因、待審批/待輸入數量與重啟恢復標記。 */
export function summarizeTask(task: TaskRecord, run: RunSnapshot | undefined, loadStatus?: string): TaskSummary {
  return {
    taskId: task.id,
    runId: task.runId,
    title: task.title,
    status: task.status,
    step: run?.currentStep ?? (loadStatus ? `snapshot:${loadStatus}` : 'unknown'),
    workflowStep: run?.workflowState?.step,
    currentAgentId: task.currentAgentId,
    currentAction: task.currentAction,
    pendingApprovals: run?.pendingApprovals.length ?? 0,
    pendingInputs: run?.pendingInputs.length ?? 0,
    recovered: run?.recovery ? { count: run.recovery.count, at: run.recovery.recoveredAt } : undefined,
    blocker: task.status === 'BLOCKED' ? (task.currentAction ?? run?.currentStep) : undefined,
    blockedBy: run?.status === 'BLOCKED' && run.blockedBy ? blockedBySummary(run.blockedBy) : undefined,
    updatedAt: task.updatedAt,
    createdAt: task.createdAt,
  };
}

function blockedBySummary(blockedBy: BlockedBy): Pick<BlockedBy, 'source' | 'code' | 'agentId' | 'approvalId'> {
  return {
    source: blockedBy.source,
    code: blockedBy.code,
    ...(blockedBy.agentId ? { agentId: blockedBy.agentId } : {}),
    ...(blockedBy.approvalId ? { approvalId: blockedBy.approvalId } : {}),
  };
}

/**
 * 交接時附帶的活動摘要（P1-4，參考 smolagents 的執行摘要）：由編排器從事件記錄確定性生成，不經過 LLM。
 * 只看這個 agent 最近一次收到指令之後做的事：執行過的命令及退出碼、寫過的檔案、測試結果。同一份事件日誌生成的摘要逐字相同。
 */
export function activitySummary(events: readonly UnifiedEvent[], agentId: string, maxLines = 20): string {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]!;
    if (e.agentId === agentId && e.type === 'agent.message' && e.data.direction === 'to-agent') {
      start = i;
      break;
    }
  }
  const started = new Map<string, { name: string; target: string }>();
  const lines: string[] = [];
  const files = new Set<string>();
  for (const e of events.slice(start)) {
    if (e.type === 'tool.started' && e.agentId === agentId) {
      const input = (e.data.toolInput ?? {}) as Record<string, unknown>;
      const name = String(e.data.toolName ?? 'tool');
      const target = String(input.command ?? input.file_path ?? input.path ?? input.pattern ?? '').slice(0, 160);
      if (typeof e.data.toolCallId === 'string') started.set(e.data.toolCallId, { name, target });
      if (typeof input.file_path === 'string' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name)) files.add(input.file_path);
    }
    if ((e.type === 'tool.completed' || e.type === 'tool.failed') && e.agentId === agentId) {
      const call = typeof e.data.toolCallId === 'string' ? started.get(e.data.toolCallId) : undefined;
      const name = call?.name ?? String(e.data.toolName ?? 'tool');
      if (/^(Read|Grep|Glob|LS|ToolSearch|TodoWrite)$/.test(name)) continue;
      const result = e.type === 'tool.completed' ? 'ok' : e.data.declined === true ? 'declined' : 'failed';
      const exit = typeof e.data.exitCode === 'number' ? ` (exit ${e.data.exitCode})` : '';
      lines.push(`- ${name}${call?.target ? `: ${call.target}` : ''} -> ${result}${exit}`);
    }
    if (e.type === 'agent.status' && e.data.status === 'completed' && typeof e.data.testPassed === 'boolean') {
      lines.push(`- tests: ${e.data.testPassed ? 'passed' : 'failed'}${typeof e.data.exitCode === 'number' ? ` (exit ${e.data.exitCode})` : ''}`);
    }
  }
  if (lines.length === 0 && files.size === 0) return '';
  const shown = lines.slice(-maxLines);
  const out: string[] = [];
  if (lines.length > shown.length) out.push(`(${lines.length - shown.length} earlier actions omitted)`);
  out.push(...shown);
  if (files.size > 0) out.push(`files written: ${[...files].slice(0, 20).join(', ')}`);
  return out.join('\n');
}
