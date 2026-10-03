import { createHash } from 'node:crypto';
import type { UnifiedEvent } from './types.js';

/**
 * OpenTelemetry 追蹤（P2-2，按 OTel GenAI 語義約定命名）。
 *
 * eventsToSpans 是純投影：同一個 run 的事件日誌無論重建多少次，得到的 trace / span ID 與層級完全相同
 * （ID 由 runId 和事件裡的穩定鍵雜湊得到）。層級：
 *   run → 工作流步驟（run.status 的 step 變化）→ agent 的一輪（agent.status 從工作到結束）→ 工具呼叫 / 等待審批。
 * 預設只含後設資料（工具名、狀態、token 數、耗時）；includeContent 時才附帶命令和工具輸入摘要。
 */

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 毫秒時間戳。 */
  start: number;
  end: number;
  attributes: Record<string, string | number | boolean>;
  status: 'ok' | 'error' | 'unset';
  events: Array<{ name: string; time: number; attributes?: Record<string, string | number | boolean> }>;
}

export interface SpanOptions {
  /** 附帶命令、工具輸入摘要等內容（預設不附帶）。 */
  includeContent?: boolean;
}

const hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** run 的 trace ID（32 位十六進位制）。 */
export function traceIdFor(runId: string): string {
  return hex(`acc-trace:${runId}`).slice(0, 32);
}

/** run 裡一個 span 的 ID（16 位十六進位制）。 */
export function spanIdFor(runId: string, key: string): string {
  return hex(`acc-span:${runId}:${key}`).slice(0, 16);
}

/** W3C traceparent：讓子程序（例如 Claude CLI）自己的 span 掛在 run 的根 span 下。 */
export function traceparentFor(runId: string): string {
  return `00-${traceIdFor(runId)}-${spanIdFor(runId, 'root')}-01`;
}

const TERMINAL_AGENT_STATUS = new Set(['completed', 'failed', 'cancelled']);
const PROVIDER: Record<string, string> = { claude: 'anthropic', codex: 'openai' };

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function eventsToSpans(events: readonly UnifiedEvent[], options: SpanOptions = {}): TraceSpan[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const first = sorted[0]!;
  const runId = first.runId;
  const traceId = traceIdFor(runId);
  const lastTime = sorted.at(-1)!.timestamp;
  const spans: TraceSpan[] = [];
  const make = (key: string, name: string, start: number, parent: TraceSpan | undefined, attributes: TraceSpan['attributes'] = {}): TraceSpan => {
    const span: TraceSpan = { traceId, spanId: spanIdFor(runId, key), parentSpanId: parent?.spanId, name, start, end: start, attributes, status: 'unset', events: [] };
    spans.push(span);
    return span;
  };

  const root = make('root', 'acc.run', first.timestamp, undefined, { 'acc.run_id': runId, 'acc.task_id': first.taskId, 'acc.project_id': first.projectId });
  let step: TraceSpan | undefined;
  let stepName: string | undefined;
  const turns = new Map<string, TraceSpan>();
  const tools = new Map<string, TraceSpan>();
  const approvals = new Map<string, TraceSpan>();
  const lastCumulative = new Map<string, Record<string, unknown>>();
  const close = (span: TraceSpan, at: number, status?: TraceSpan['status']) => {
    span.end = Math.max(span.start, at);
    if (status) span.status = status;
  };
  const parentFor = (agentId?: string) => (agentId ? turns.get(agentId) : undefined) ?? step ?? root;
  const openTurn = (event: UnifiedEvent) => {
    const agentId = event.agentId!;
    if (turns.has(agentId)) return turns.get(agentId)!;
    const span = make(`turn:${agentId}:${event.sequence}`, `invoke_agent ${agentId}`, event.timestamp, step ?? root, {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agentId,
      ...(PROVIDER[agentId] ? { 'gen_ai.system': PROVIDER[agentId]! } : {}),
    });
    turns.set(agentId, span);
    return span;
  };

  for (const event of sorted) {
    const d = event.data ?? {};
    switch (event.type) {
      case 'run.status': {
        const next = str(d.step);
        if (next && next !== stepName) {
          if (step) close(step, event.timestamp, 'ok');
          stepName = next;
          step = make(`step:${event.sequence}`, `step ${next}`, event.timestamp, root, { 'acc.step': next });
        }
        if (str(d.status)) root.attributes['acc.status'] = String(d.status);
        break;
      }
      case 'agent.started':
      case 'model.turn.started':
        if (event.agentId && event.sessionId) openTurn(event);
        break;
      case 'agent.status': {
        if (!event.agentId || !event.sessionId) break;
        const status = String(d.status ?? '');
        if (TERMINAL_AGENT_STATUS.has(status)) {
          const turn = turns.get(event.agentId);
          if (turn) {
            close(turn, event.timestamp, status === 'completed' ? 'ok' : 'error');
            turn.attributes['acc.agent.outcome'] = status;
            turns.delete(event.agentId);
          }
        } else {
          openTurn(event);
        }
        break;
      }
      case 'model.turn.completed': {
        if (!event.agentId) break;
        const turn = openTurn(event);
        const usage = (d.usage ?? {}) as Record<string, unknown>;
        const add = (key: string, value: number | undefined) => {
          if (value !== undefined && value > 0) turn.attributes[key] = Number(turn.attributes[key] ?? 0) + value;
        };
        // 用量有兩種口徑：這一輪的（inputTokens…），或會話累計的（cumulative，按會話求增量，與投影一致）
        const cumulative = usage.cumulative as Record<string, unknown> | undefined;
        let turnUsage: Record<string, unknown> = usage;
        if (cumulative && typeof cumulative === 'object') {
          const key = event.sessionId ?? event.agentId;
          const prev = lastCumulative.get(key) ?? {};
          turnUsage = Object.fromEntries(['inputTokens', 'outputTokens', 'costUsd'].map((k) => [k, (num(cumulative[k]) ?? 0) - (num(prev[k]) ?? 0)]));
          lastCumulative.set(key, cumulative);
        }
        add('gen_ai.usage.input_tokens', num(turnUsage.inputTokens));
        add('gen_ai.usage.output_tokens', num(turnUsage.outputTokens));
        add('acc.cost_usd', num(turnUsage.costUsd));
        if (str(usage.model) ?? str(d.model)) turn.attributes['gen_ai.request.model'] = String(usage.model ?? d.model);
        break;
      }
      case 'tool.started': {
        const id = str(d.toolCallId) ?? str(d.providerCallId) ?? event.id;
        const name = str(d.toolName) ?? 'tool';
        const span = make(`tool:${id}:${event.sequence}`, `execute_tool ${name}`, event.timestamp, parentFor(event.agentId), {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': name,
          'gen_ai.tool.call.id': id,
        });
        if (options.includeContent) {
          const input = (d.toolInput ?? d.input) as Record<string, unknown> | undefined;
          if (input) span.attributes['acc.tool.input'] = JSON.stringify(input).slice(0, 1000);
        }
        tools.set(id, span);
        break;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const id = str(d.toolCallId) ?? str(d.providerCallId) ?? event.id;
        const span = tools.get(id);
        if (span) {
          close(span, event.timestamp, event.type === 'tool.completed' ? 'ok' : 'error');
          if (num(d.exitCode) !== undefined) span.attributes['acc.tool.exit_code'] = num(d.exitCode)!;
          tools.delete(id);
        }
        break;
      }
      case 'approval.required': {
        const id = str(d.approvalId) ?? event.id;
        const span = make(`approval:${id}`, 'acc.approval.wait', event.timestamp, parentFor(event.agentId), {
          'acc.approval.id': id,
          'acc.approval.kind': str(d.kind) ?? 'tool',
          ...(str(d.toolName) ? { 'gen_ai.tool.name': String(d.toolName) } : {}),
        });
        approvals.set(id, span);
        break;
      }
      case 'approval.resolved': {
        const id = str(d.approvalId) ?? '';
        const span = approvals.get(id);
        if (span) {
          close(span, event.timestamp, d.decision === 'approve' ? 'ok' : 'error');
          span.attributes['acc.approval.decision'] = String(d.decision ?? '');
          span.attributes['acc.approval.resolved_by'] = String(d.resolvedBy ?? '');
          approvals.delete(id);
        }
        break;
      }
      case 'handoff.requested':
      case 'handoff.completed':
      case 'consult.answered':
      case 'checkpoint.created':
      case 'checkpoint.restored':
      case 'workspace.merged':
      case 'budget.exceeded':
      case 'safety.blocked':
        root.events.push({ name: event.type, time: event.timestamp, attributes: pickScalars(d, ['fromAgentId', 'toAgentId', 'kind', 'code', 'seq', 'files']) });
        break;
      case 'runtime.error':
        root.events.push({ name: 'exception', time: event.timestamp, attributes: { 'exception.type': String(d.code ?? 'runtime.error'), ...(options.includeContent && str(d.message) ? { 'exception.message': String(d.message).slice(0, 500) } : {}) } });
        break;
      case 'run.completed':
        root.status = 'ok';
        break;
      case 'run.failed':
        root.status = 'error';
        break;
      default:
        break;
    }
  }

  // 還沒結束的 span：結束在最後一個事件的時間，並標明未完成
  for (const open of [...turns.values(), ...tools.values(), ...approvals.values(), ...(step ? [step] : [])]) {
    if (open.end === open.start && open.status === 'unset') {
      close(open, lastTime);
      if (open !== step) open.attributes['acc.incomplete'] = true;
    }
  }
  if (step && step.end < lastTime && step.status === 'unset') close(step, lastTime);
  close(root, lastTime);
  return spans;
}

function pickScalars(data: Record<string, unknown>, keys: string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const v = data[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[`acc.${key}`] = v;
  }
  return out;
}

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
const otlpValue = (v: string | number | boolean): OtlpValue =>
  typeof v === 'string' ? { stringValue: v } : typeof v === 'boolean' ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
const otlpAttributes = (attrs: Record<string, string | number | boolean>) => Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) }));
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/** 轉成 OTLP/HTTP JSON（ExportTraceServiceRequest）。 */
export function spansToOtlp(spans: readonly TraceSpan[], resource: Record<string, string | number | boolean> = {}): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes({ 'service.name': 'agent-control-center', ...resource }) },
        scopeSpans: [
          {
            scope: { name: 'agent-control-center' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.parentSpanId ? 1 : 2,
              startTimeUnixNano: nanos(s.start),
              endTimeUnixNano: nanos(s.end),
              attributes: otlpAttributes(s.attributes),
              events: s.events.map((e) => ({ name: e.name, timeUnixNano: nanos(e.time), attributes: otlpAttributes(e.attributes ?? {}) })),
              status: { code: s.status === 'ok' ? 1 : s.status === 'error' ? 2 : 0 },
            })),
          },
        ],
      },
    ],
  };
}
