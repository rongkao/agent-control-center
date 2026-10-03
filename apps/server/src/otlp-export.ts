import { eventsToSpans, spansToOtlp } from '@acc/core';
import type { ControlPlaneStore, EventBus, UnifiedEvent } from '@acc/core';

/**
 * OTLP 匯出（P2-2）：任務結束時把這個 run 的事件投影成 span，以 OTLP/HTTP JSON 發給 ACC_OTLP_ENDPOINT
 * （例如本機的 Phoenix：http://localhost:6006）。預設只發後設資料；ACC_OTLP_CONTENT=1 才附帶命令和工具輸入摘要。
 * 傳送失敗只記日誌，不影響任務。trace ID 由 runId 決定，重複傳送同一個 run 不會產生新的 trace。
 */
export interface OtlpExporterOptions {
  endpoint: string;
  headers?: Record<string, string>;
  includeContent?: boolean;
  store: ControlPlaneStore;
  bus: EventBus;
  log: (message: string, error?: unknown) => void;
  fetchFn?: typeof fetch;
}

const TERMINAL_STATUS = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** 解析 ACC_OTLP_HEADERS（k=v,k2=v2）。 */
export function parseOtlpHeaders(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function startOtlpExporter(options: OtlpExporterOptions): () => void {
  const url = `${options.endpoint.replace(/\/+$/, '')}/v1/traces`;
  const fetchFn = options.fetchFn ?? fetch;
  const exported = new Set<string>();
  const isTerminal = (event: UnifiedEvent) =>
    event.type === 'run.completed' || event.type === 'run.failed' || (event.type === 'run.status' && TERMINAL_STATUS.has(String(event.data.status)));

  const exportRun = async (runId: string) => {
    const events = await options.store.listEvents(runId);
    const spans = eventsToSpans(events, { includeContent: options.includeContent });
    if (spans.length === 0) return;
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(spansToOtlp(spans)),
    });
    if (!response.ok) throw new Error(`OTLP endpoint answered ${response.status}`);
  };

  return options.bus.subscribe(
    (event) => {
      if (!isTerminal(event) || exported.has(event.runId)) return;
      exported.add(event.runId);
      // 不阻塞事件處理：等這一刻已經落盤的事件都能讀到之後再匯出
      setTimeout(() => {
        exportRun(event.runId).catch((error: unknown) => options.log(`OTLP export failed for run ${event.runId}`, error));
      }, 200).unref?.();
    },
    { phase: 'normal' },
  );
}
