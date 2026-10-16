import React from 'react';
import type { Agent, AppConfig, BudgetAdjustResponse, CreateTaskBody, TaskDetail, TaskSummary, UnifiedEvent, UsageSummary } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 服務端給出的結構化錯誤碼（例如 TASK_BLOCKED、BUDGET_EXHAUSTED、TASK_TERMINAL）。 */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * 登入失效或訪問被拒絕（服務端返回 401 / 403）：全域性只記錄一次，介面顯示中文提示；
 * 之後不再發請求、不再重連 WebSocket，避免後台輪詢不停刷屏。
 */
export interface AuthProblem {
  status: number;
  /** 服務端給出的具體原因（可能為空）。 */
  detail?: string;
}

let authProblem: AuthProblem | undefined;
const authListeners = new Set<() => void>();

export function getAuthProblem(): AuthProblem | undefined {
  return authProblem;
}

function reportAuthProblem(problem: AuthProblem): void {
  if (authProblem) return;
  authProblem = problem;
  for (const listener of authListeners) listener();
}

function subscribeAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function useAuthProblem(): AuthProblem | undefined {
  return React.useSyncExternalStore(subscribeAuth, getAuthProblem);
}

export const AUTH_HINT = '請用啟動時開啟的連結重新進入。';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // 已經確認登入失效：不再發請求（後台輪詢會一直呼叫這裡）
  if (authProblem) throw new ApiError(authProblem.status, AUTH_HINT);
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : init?.headers,
  });
  const text = await response.text();
  let body: unknown;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined; // 非 JSON 響應（例如被拒絕時的說明頁）
    }
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | undefined)?.error;
    const code = (body as { code?: unknown } | undefined)?.code;
    const message = typeof error === 'string' ? error : error ? JSON.stringify(error) : `HTTP ${response.status}`;
    if (response.status === 401 || response.status === 403) {
      reportAuthProblem({ status: response.status, detail: typeof error === 'string' ? error : undefined });
      throw new ApiError(response.status, AUTH_HINT);
    }
    throw new ApiError(response.status, message, typeof code === 'string' ? code : undefined);
  }
  return body as T;
}

/**
 * 位址列裡帶著 ?token=（開發模式下頁面由 Vite 提供，服務端沒機會處理）：
 * 先從位址列去掉令牌，再用它向服務端換登入 Cookie。生產模式下服務端已經處理過，這裡什麼都不做。
 */
export async function completeLinkLogin(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return;
  params.delete('token');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}${location.hash}`);
  try {
    await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
  } catch {
    // 服務暫時連不上：後續請求會給出提示
  }
}

/** 探測登入狀態：401/403 時記錄登入問題並返回 false；服務連不上時返回 true（交給重連邏輯）。 */
async function authStillValid(): Promise<boolean> {
  if (authProblem) return false;
  try {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) {
      reportAuthProblem({ status: response.status });
      return false;
    }
  } catch {
    // 網路錯誤：服務可能正在重啟
  }
  return true;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  config: () => request<AppConfig>('/api/config'),
  agents: () => request<Agent[]>('/api/agents'),
  dashboard: () => request<TaskSummary[]>('/api/dashboard'),
  usage: () => request<UsageSummary>('/api/usage'),
  task: (taskId: string, after?: number) => request<TaskDetail & { incrementalAfter?: number }>(`/api/tasks/${taskId}${after ? `?after=${after}` : ''}`),
  createTask: (body: CreateTaskBody) => post<{ id: string }>('/api/tasks', body),
  /** resume：任務已阻塞時先恢復再傳送（使用者確認過的「恢復並傳送」，P0-7）。 */
  message: (taskId: string, agentId: string, message: string, resume?: boolean) => post(`/api/tasks/${taskId}/message`, { agentId, message, ...(resume ? { resume } : {}) }),
  /** rerun：把阻塞的這一步交還給負責它的 agent 重做（例如診斷的 Codex 登入失效，重新登入後再請它診斷）。 */
  gate: (taskId: string, action: 'accept' | 'review' | 'retry' | 'rerun', note?: string) => post(`/api/tasks/${taskId}/gate`, { action, note }),
  cancel: (taskId: string) => post(`/api/tasks/${taskId}/cancel`, {}),
  /** 改動審查（P2-3）：給 seq 時是那一輪的改動，不給時是任務到目前為止的全部改動。 */
  diff: (taskId: string, seq?: number) =>
    request<{ files: Array<{ status: 'A' | 'M' | 'D'; path: string }>; patch: string; truncated: boolean; from: number; to?: number }>(
      `/api/tasks/${taskId}/diff${seq !== undefined ? `?seq=${seq}` : ''}`,
    ),
  /** 合入閘門預覽（P2-4）：會執行的命令、改動的檔案、衝突預檢。 */
  mergePreview: (taskId: string) =>
    request<{
      baseBranch: string;
      branch: string;
      baseDirty: boolean;
      files: Array<{ status: string; path: string }>;
      conflicts: string[];
      secrets: Array<{ rule: string; name: string; path?: string; line?: number; preview: string }>;
      commands: { merge: string[]; apply: string[] } }>(
      `/api/tasks/${taskId}/merge-preview`,
    ),
  /** 合入（P2-4）：merge 保留提交，apply 只暫存。 */
  merge: (taskId: string, mode: 'merge' | 'apply', allowSecrets = false) =>
    post<{ ok: boolean; commit?: string; files: number }>(`/api/tasks/${taskId}/merge`, { mode, ...(allowSecrets ? { allowSecrets: true } : {}) }),
  /** 刪除任務的 worktree 與分支（P2-4）。 */
  cleanupWorktree: (taskId: string) => post<{ ok: boolean }>(`/api/tasks/${taskId}/worktree/cleanup`, {}),
  /** 多個 AI 各做一份（P2-11）。 */
  createGroup: (body: { prompt: string; agentIds: string[]; workflow?: 'implementation-v1' | 'manual'; testCommand?: string; cwd?: string }) =>
    post<{ groupId: string; tasks: Array<{ id: string }> }>('/api/groups', body),
  group: (groupId: string) =>
    request<{
      recommended?: string;
      candidates: Array<{
        taskId: string;
        index: number;
        agentId?: string;
        status: string;
        busy: boolean;
        testsPassed?: boolean;
        verdict?: string;
        costUsd: number;
        merged: boolean;
        cleaned: boolean;
        files: number;
        insertions: number;
        deletions: number;
      }>;
    }>(`/api/groups/${encodeURIComponent(groupId)}`),
  pickInGroup: (groupId: string, taskId: string, mode: 'merge' | 'apply') => post<{ ok: boolean }>(`/api/groups/${encodeURIComponent(groupId)}/pick`, { taskId, mode }),
  /** 從檢查點分叉出新任務（P2-3）。 */
  fork: (taskId: string, seq: number, prompt: string) => post<{ id: string }>(`/api/tasks/${taskId}/fork`, { seq, prompt }),
  /** 撤銷最後一輪（P2-3）。 */
  undo: (taskId: string) => post<{ ok: boolean; restored: string[]; to: number }>(`/api/tasks/${taskId}/undo`, {}),
  /** 放棄 / 歸檔（P1-12）：任務結束，重啟後不再恢復。 */
  abandon: (taskId: string) => post(`/api/tasks/${taskId}/abandon`, {}),
  /** 刪除已經結束的任務（P1-12）。 */
  deleteTask: (taskId: string) => request(`/api/tasks/${taskId}`, { method: 'DELETE', body: '{}' }),
  /** 只停下某個 agent 當前這一輪（P1-10）：任務和其他 agent 不受影響，下一條訊息自動續接。 */
  interrupt: (taskId: string, agentId: string) => post(`/api/tasks/${taskId}/interrupt`, { agentId }),
  /** 確認 AI 對測試配置的改動並執行測試（P0-8 / H-15）；digest 是介面上顯示的那份差異的摘要。 */
  confirmTestConfig: (taskId: string, digest: string) => post(`/api/tasks/${taskId}/test-config/confirm`, { digest }),
  handoff: (taskId: string, fromAgentId: string, toAgentId: string, content: string, instruction?: string, resume?: boolean) =>
    post(`/api/tasks/${taskId}/handoff`, { fromAgentId, toAgentId, content, instruction, ...(resume ? { resume } : {}) }),
  askBoth: (taskId: string, message: string, primaryAgentId = 'claude', resume?: boolean) =>
    post(`/api/tasks/${taskId}/ask-both`, { message, primaryAgentId, ...(resume ? { resume } : {}) }),
  /** 調整預算（P0-7）：relax = 一鍵放寬用完的那一項；也可以直接設定限額。因預算阻塞的任務隨後恢復。 */
  adjustBudget: (
    taskId: string,
    body: { relax?: boolean; resume?: boolean; maxTurns?: number; maxAgentCalls?: number; maxReviewRounds?: number; maxStallCount?: number; maxDurationMs?: number; maxEstimatedTokens?: number; maxCostUsd?: number },
  ) => post<BudgetAdjustResponse>(`/api/tasks/${taskId}/budget`, body),
  reassign: (taskId: string, toAgentId: string, note?: string) => post(`/api/tasks/${taskId}/reassign`, { toAgentId, note }),
  setHandoffPolicy: (taskId: string, handoffPolicy: 'ask' | 'auto') => post(`/api/tasks/${taskId}/settings`, { handoffPolicy }),
  continueTask: (taskId: string, agentId: string, message: string) => post<{ id: string }>(`/api/tasks/${taskId}/continue`, { agentId, message }),
  /** 方案額度（P1-7）。 */
  quota: () =>
    request<{ agents: Array<{ agentId: string; name: string; quota: { plan?: string; limitReached?: string; windows: Array<{ label: string; usedPercent: number; resetsAt?: number }> } }> }>(
      '/api/quota',
    ),
  /** 執行隔離（P2-8）。 */
  isolation: () =>
    request<{ agents: Array<{ agentId: string; name: string; status: { level: 'sandbox' | 'degraded'; ready: boolean; detail: string; setupHint?: string; canSetup?: boolean } }> }>(
      '/api/isolation',
    ),
  setupIsolation: (agentId: string) => post<{ ok: boolean; message: string }>(`/api/agents/${encodeURIComponent(agentId)}/isolation/setup`, {}),
  /** 自動放行（P2-7）：自主度與規則。 */
  policy: () =>
    request<{
      mode: 'ask' | 'rules' | 'unattended';
      maxConsecutive: number;
      rules: Array<{ id: string; toolName: string; agentId?: string; commandPrefix?: string; pathPrefix?: string; createdAt: number; note?: string }>;
    }>('/api/policy'),
  setAutonomy: (mode: 'ask' | 'rules' | 'unattended') => request<{ ok: boolean }>('/api/policy/mode', { method: 'PUT', body: JSON.stringify({ mode }) }),
  /** 從審批生成「以後都允許」的規則。 */
  addPolicyRule: (approvalId: string) => post<{ id: string }>('/api/policy/rules', { approvalId }),
  deletePolicyRule: (id: string) => request<{ ok: boolean }>(`/api/policy/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** resume：批准交接時對話任務已阻塞，先恢復任務再轉交（使用者確認過的「恢復並轉交」）。 */
  resolveApproval: (taskId: string, approvalId: string, decision: 'approve' | 'decline', scope?: 'once' | 'session', resume?: boolean, answers?: Record<string, string[]>) =>
    post(`/api/approvals/${encodeURIComponent(approvalId)}/resolve`, { taskId, decision, scope, ...(resume ? { resume } : {}), ...(answers ? { answers } : {}) }),
};

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized';

/**
 * WebSocket 事件流：斷線自動重連；每次（重新）連線成功都會呼叫 onReconnect，
 * 由呼叫方從 REST 拉取權威投影（UI 投影可隨時重建）。
 */
export function useEventStream(onEvent: (event: UnifiedEvent) => void, onReconnect: () => void): ConnectionState {
  const [state, setState] = React.useState<ConnectionState>('connecting');
  const handlers = React.useRef({ onEvent, onReconnect });
  handlers.current = { onEvent, onReconnect };

  React.useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      if (authProblem) {
        setState('unauthorized');
        return;
      }
      setState('connecting');
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws/events`);
      socket.onopen = () => {
        attempt = 0;
        setState('open');
        handlers.current.onReconnect();
      };
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message.data)) as UnifiedEvent;
          if (event.type !== 'system.connected') handlers.current.onEvent(event);
        } catch {
          // 忽略無法解析的訊息
        }
      };
      socket.onclose = () => {
        if (disposed) return;
        setState('closed');
        // 瀏覽器看不到 WS 升級被拒的狀態碼：先確認是不是登入失效；是的話停止重連並提示，不再刷屏
        void authStillValid().then((valid) => {
          if (disposed) return;
          if (!valid) {
            setState('unauthorized');
            return;
          }
          attempt += 1;
          retry = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt));
        });
      };
    };
    connect();
    // REST 請求發現登入失效時，同樣停止重連
    const unsubscribe = subscribeAuth(() => {
      clearTimeout(retry);
      setState('unauthorized');
    });
    return () => {
      disposed = true;
      unsubscribe();
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  return state;
}

/** 每秒重新整理一次（用於即時顯示耗時）。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
