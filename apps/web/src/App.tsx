import React from 'react';
import { AUTH_HINT, ApiError, api, getAuthProblem, useAuthProblem, useEventStream } from './api';
import { attentionCount, attentionNotice, attentionTitle } from './attention-ui';
import { NewTask } from './components/NewTask';
import { TaskDetail } from './components/TaskDetail';
import { TaskList } from './components/TaskList';
import { UsageView } from './components/UsageView';
import { PolicyView } from './components/PolicyView';
import type { Agent, AppConfig, TaskDetail as Detail, TaskSummary, UnifiedEvent, UsageSummary } from './types';

type View = 'tasks' | 'usage' | 'policy';

export function App() {
  const [view, setView] = React.useState<View>('tasks');
  const viewRef = React.useRef(view);
  viewRef.current = view;
  // 切到用量頁時拉一次最新彙總
  React.useEffect(() => {
    if (view === 'usage') void api.usage().then(setUsage).catch(() => undefined);
  }, [view]);
  const [config, setConfig] = React.useState<AppConfig>();
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [tasks, setTasks] = React.useState<TaskSummary[]>([]);
  const [selected, setSelected] = React.useState<string>();
  const [detail, setDetail] = React.useState<Detail>();
  const [usage, setUsage] = React.useState<UsageSummary>();
  const [toast, setToast] = React.useState<string>();
  /** 讀屏軟體播報的最近一條需要處理的事（P1-15：aria-live）。 */
  const [announcement, setAnnouncement] = React.useState('');
  const [inboxOpen, setInboxOpen] = React.useState(false);
  /** 逐字流式片段：taskId → agentId → 正在輸出的文字（只在記憶體中，完整回覆到達後清空）。 */
  const [streams, setStreams] = React.useState<Record<string, Record<string, string>>>({});
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  const tasksRef = React.useRef(tasks);
  tasksRef.current = tasks;
  /** 系統通知的授權狀態（瀏覽器不支援時為 unsupported）。 */
  const [notifyPermission, setNotifyPermission] = React.useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  const authProblem = useAuthProblem();

  const showError = React.useCallback((message: string) => {
    // 登入失效時介面已經顯示了整頁提示，不再逐條彈出錯誤
    if (getAuthProblem()) return;
    setToast(message);
    setTimeout(() => setToast((current) => (current === message ? undefined : current)), 6000);
  }, []);

  const refreshList = React.useCallback(async () => {
    const list = await api.dashboard();
    setTasks(list);
    setSelected((current) => (current && list.some((t) => t.taskId === current) ? current : list[0]?.taskId));
  }, []);

  const detailRef = React.useRef(detail);
  detailRef.current = detail;
  const refreshDetail = React.useCallback(async () => {
    const id = selectedRef.current;
    if (!id) return setDetail(undefined);
    // 已經有這個任務的事件時只拉新增的部分（P1-9 / M-22），按 id 合併；換了任務才拉全量
    const current = detailRef.current?.task.id === id ? detailRef.current : undefined;
    const after = current?.events.length ? current.events[current.events.length - 1]!.sequence : undefined;
    let next: Awaited<ReturnType<typeof api.task>>;
    try {
      next = await api.task(id, after);
    } catch (error) {
      // 任務已經被刪除（P1-12）：取消選中，不再反覆報錯
      if (error instanceof ApiError && error.status === 404 && selectedRef.current === id) {
        setSelected(undefined);
        setDetail(undefined);
        return;
      }
      throw error;
    }
    if (selectedRef.current !== id) return;
    if (next.incrementalAfter === undefined) return setDetail(next);
    setDetail((prev) => {
      if (!prev || prev.task.id !== id) return prev;
      const known = new Set(prev.events.map((e) => e.id));
      const added = next.events.filter((e) => !known.has(e.id));
      const events = added.length ? [...prev.events, ...added].sort((a, b) => a.sequence - b.sequence) : prev.events;
      return { ...next, events };
    });
  }, []);

  const refreshAll = React.useCallback(async () => {
    try {
      const [c, a] = await Promise.all([api.config(), api.agents()]);
      setConfig(c);
      setAgents(a);
      await Promise.all([refreshList(), refreshDetail(), viewRef.current === 'usage' ? api.usage().then(setUsage) : Promise.resolve()]);
    } catch (error) {
      showError(`無法連線服務：${(error as Error).message}`);
    }
  }, [refreshList, refreshDetail, showError]);

  // WebSocket 事件先做本地增量投影，再做節流的權威重新整理
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scheduleRefresh = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void refreshList().catch(() => undefined);
      void refreshDetail().catch(() => undefined);
      // 用量彙總只在開啟用量頁時重新整理（P1-9 / M-11）
      if (viewRef.current === 'usage') void api.usage().then(setUsage).catch(() => undefined);
    }, 300);
  }, [refreshList, refreshDetail]);

  // 逐字流式片段先攢在緩衝裡，每一幀最多更新一次介面（P1-9 / M-23）：「同時問」兩個 AI 一起輸出時不再每個字都重畫整個頁面
  const pendingDeltas = React.useRef(new Map<string, { taskId: string; agentId: string; text: string }>());
  const flushScheduled = React.useRef(false);
  const queueDelta = React.useCallback((taskId: string, agentId: string, delta: string) => {
    const key = `${taskId}/${agentId}`;
    const entry = pendingDeltas.current.get(key);
    if (entry) entry.text += delta;
    else pendingDeltas.current.set(key, { taskId, agentId, text: delta });
    if (flushScheduled.current) return;
    flushScheduled.current = true;
    const flush = () => {
      flushScheduled.current = false;
      const batch = [...pendingDeltas.current.values()];
      pendingDeltas.current = new Map();
      if (!batch.length) return;
      setStreams((prev) => {
        const next = { ...prev };
        for (const { taskId: t, agentId: a, text } of batch) next[t] = { ...next[t], [a]: (next[t]?.[a] ?? '') + text };
        return next;
      });
    };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState === 'visible') requestAnimationFrame(flush);
    else setTimeout(flush, 50);
  }, []);

  const onEvent = React.useCallback(
    (event: UnifiedEvent) => {
      const agentId = event.agentId;
      if (event.data.ephemeral === true) {
        // 流式片段只追加到記憶體緩衝，不觸發重新整理
        const delta = typeof event.data.delta === 'string' ? event.data.delta : '';
        if (agentId && delta) queueDelta(event.taskId, agentId, delta);
        return;
      }
      // 完整回覆、工具呼叫或本輪結束到達時，清空該 agent 的流式緩衝
      if (agentId && ((event.type === 'agent.message' && event.data.direction !== 'to-agent') || event.type === 'tool.started' || event.type === 'agent.status')) {
        // 還沒刷到介面上的片段一併丟掉：完整回覆已經到了
        pendingDeltas.current.delete(`${event.taskId}/${agentId}`);
        setStreams((prev) => (prev[event.taskId]?.[agentId] ? { ...prev, [event.taskId]: { ...prev[event.taskId], [agentId]: '' } } : prev));
      }
      // 需要處理的事同時交給讀屏軟體播報（aria-live，P1-15）
      {
        const spoken = attentionNotice(event, tasksRef.current.find((t) => t.taskId === event.taskId)?.title);
        if (spoken) setAnnouncement(`${spoken.title}：${spoken.body}`);
      }
      // 頁面不在前台時，需要你處理的事彈出系統通知（M-28）；點通知回到這個任務
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notice = attentionNotice(event, tasksRef.current.find((t) => t.taskId === event.taskId)?.title);
        if (notice) {
          try {
            const n = new Notification(notice.title, { body: notice.body, tag: notice.tag });
            n.onclick = () => {
              window.focus();
              setSelected(event.taskId);
              n.close();
            };
          } catch {
            // 某些環境（例如沒有通知服務）會拋錯：忽略，標籤頁標題仍然會提醒
          }
        }
      }
      if (event.taskId === selectedRef.current) {
        setDetail((current) => {
          if (!current || current.task.id !== event.taskId || current.events.some((e) => e.id === event.id)) return current;
          return { ...current, events: [...current.events, event].sort((a, b) => a.sequence - b.sequence) };
        });
      }
      scheduleRefresh();
    },
    [scheduleRefresh],
  );

  // 斷線重連後從 REST 全量對賬；殘留的半截流式氣泡一併清掉（L-16）
  const connection = useEventStream(onEvent, () => {
    setStreams({});
    void refreshAll();
  });

  // 兜底對賬：WebSocket 事件驅動的重新整理偶爾失敗時，定期從 REST 拉取權威投影
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !getAuthProblem()) {
        void refreshList().catch(() => undefined);
        void refreshDetail().catch(() => undefined);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [refreshList, refreshDetail]);

  React.useEffect(() => {
    void refreshDetail().catch((error) => showError((error as Error).message));
  }, [selected, refreshDetail, showError]);

  const activeByAgent = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === 'RUNNING' && t.currentAgentId) activeByAgent.set(t.currentAgentId, (activeByAgent.get(t.currentAgentId) ?? 0) + 1);
  }
  const attention = attentionCount(tasks);

  // 標籤頁標題顯示要處理的數量：切到別的標籤頁也能看到（M-28）
  React.useEffect(() => {
    document.title = attentionTitle(attention);
  }, [attention]);

  return (
    <div className="shell">
      <aside>
        <div className="brand">✦ Agent Control</div>
        <nav>
          <button className={`nav ${view === 'tasks' ? 'active' : ''}`} onClick={() => setView('tasks')}>
            ⌂ 工作台 {attention > 0 && <span className="count warn">{attention}</span>}
          </button>
          <button className={`nav ${view === 'usage' ? 'active' : ''}`} onClick={() => setView('usage')}>▦ 用量</button>
          <button className={`nav ${view === 'policy' ? 'active' : ''}`} onClick={() => setView('policy')}>🛡 安全</button>
        </nav>
        <h4>Agents</h4>
        {agents.map((a) => (
          <div key={a.id} className="agent-mini">
            <span className={`avatar ${a.kind}`}>{a.name.slice(0, 1)}</span>
            <span>
              <b>{a.name}</b>
              <small>{!a.ready ? '未就緒（滑鼠移上來看原因）' : activeByAgent.get(a.id) ? `正在處理 ${activeByAgent.get(a.id)} 個任務` : '空閒'}</small>
            </span>
            <i className={a.ready ? 'ready' : ''} title={a.ready ? '執行時就緒' : a.notReadyReason ?? '執行時未就緒'} />
          </div>
        ))}
        {notifyPermission === 'default' && (
          <button
            className="link small notify-optin"
            title="需要你審批或任務停下時，即使這個頁面在後台也會彈出提醒"
            onClick={() => void Notification.requestPermission().then(setNotifyPermission).catch(() => undefined)}
          >
            🔔 開啟桌面提醒
          </button>
        )}
        {config && (
          <div className="env">
            <div>執行模式：<b>{config.runtimeMode === 'real' ? '真實' : '模擬'}</b></div>
            <div>儲存：{config.storeMode}</div>
            <div title={config.workspace}>工作區：{config.workspace}</div>
            {config.recovery && config.recovery.waiting.length + config.recovery.blocked.length + config.recovery.resumed.length > 0 && (
              <div className="recovered">啟動時恢復了 {config.recovery.waiting.length + config.recovery.blocked.length + config.recovery.resumed.length} 個任務</div>
            )}
          </div>
        )}
      </aside>

      <main>
        <header>
          <div>
            <h1>Claude + Codex 多 Agent 控制台</h1>
            <p>確定性編排 · 審批與預算可控 · 重啟可恢復</p>
          </div>
          <div className="row gap">
            {/* 跨任務的審批收件箱（P1-10）：所有等你處理的任務集中在一處，點一下跳過去 */}
            {attention > 0 && (
              <div className="inbox">
                <button className="pill warn" aria-expanded={inboxOpen} onClick={() => setInboxOpen(!inboxOpen)}>
                  需要你處理 {attention}
                </button>
                {inboxOpen && (
                  <div className="inbox-menu" role="menu">
                    {tasks
                      .filter((t) => t.pendingApprovals > 0 || t.pendingInputs > 0 || t.status === 'BLOCKED')
                      .map((t) => (
                        <button
                          key={t.taskId}
                          role="menuitem"
                          onClick={() => {
                            setView('tasks');
                            setSelected(t.taskId);
                            setInboxOpen(false);
                          }}
                        >
                          <b>{t.title}</b>
                          <small>{t.pendingApprovals > 0 ? `待審批 ${t.pendingApprovals}` : t.pendingInputs > 0 ? '等你決定' : '已停下'}</small>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
            <span className={`pill ${config?.runtimeMode === 'real' ? 'real' : ''}`}>runtime: {config?.runtimeMode ?? '…'}</span>
            <span className={`pill conn ${connection}`}>
              {connection === 'open' ? '● 即時連線' : connection === 'connecting' ? '○ 連線中' : connection === 'unauthorized' ? '○ 需要重新登入' : '○ 已斷開，重連中'}
            </span>
          </div>
        </header>

        {view === 'usage' ? (
          <UsageView usage={usage} agents={agents} />
        ) : view === 'policy' ? (
          <PolicyView onError={showError} />
        ) : (
          <div className="workbench">
            <div className="left">
              <NewTask
                agents={agents}
                config={config}
                onError={showError}
                onCreated={(id) => {
                  setSelected(id);
                  void refreshAll();
                }}
              />
              <section className="card">
                <h3>任務</h3>
                <TaskList tasks={tasks} selected={selected} onSelect={setSelected} />
              </section>
            </div>
            <div className="right">
              {detail ? (
                <TaskDetail
                  key={detail.task.id}
                  detail={detail}
                  agents={agents}
                  streams={streams[detail.task.id] ?? {}}
                  onError={showError}
                  onChanged={() => void refreshAll()}
                  onContinued={(id) => {
                    setSelected(id);
                    void refreshAll();
                  }}
                />
              ) : (
                <section className="card empty">
                  <h3>選擇或建立一個任務</h3>
                  <p className="muted">這裡會顯示：哪個 Agent 在工作、處於什麼狀態、剛發生了什麼、為什麼阻塞、是否需要審批、消耗了多少預算，以及編排器的下一步動作。</p>
                </section>
              )}
            </div>
          </div>
        )}
      </main>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
      {authProblem && (
        <div className="auth-overlay" role="alertdialog" aria-modal="true" aria-labelledby="auth-title" aria-describedby="auth-desc">
          <div className="auth-card">
            <h2 id="auth-title">{authProblem.status === 403 ? '無法存取控制台' : '需要重新登入'}</h2>
            <p id="auth-desc">{AUTH_HINT}</p>
            <p className="muted">
              啟動服務（npm start）時瀏覽器會自動開啟正確的連結；如果沒有自動開啟，請到啟動服務的終端視窗，複製「訪問連結」那一行的網址，貼到瀏覽器網址列開啟。
            </p>
            {authProblem.detail && <p className="muted small">{authProblem.detail}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
