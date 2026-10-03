import React from 'react';
import { ApiError, api, useNow } from '../api';
import { approvalStillPendingAfter, createSubmitGuard } from '../approval-ui';
import { activeWorkMs, blockedBanner, blockedSendConfirm, budgetRows, pendingApprovalBanner, type BlockedAction } from '../blocked-ui';
import { AGENT_STATUS_LABEL, EVENT_LABEL, STATUS_LABEL, STEP_LABEL, TERMINAL, describe, describeNextAction, duration, operatorPrompt, time, tokens, usd } from '../format';
import { TEST_CONFIG_KIND_LABEL, diffLineClass, testConfigActions, testConfigExplanation, testConfigRevertNote, testConfigTitle } from '../test-config-ui';
import type { Agent, PendingApproval, TaskDetail as Detail, UnifiedEvent } from '../types';
import { ApprovalDialog } from './ApprovalDialog';
import { ChatPanes, resolveApprovalWithResume } from './ChatPanes';
import { ChangesView } from './ChangesView';

interface Props {
  detail: Detail;
  agents: Agent[];
  /** agentId → 正在流式輸出的文字 */
  streams: Record<string, string>;
  onChanged: () => void;
  onContinued: (taskId: string) => void;
  onError: (message: string) => void;
}

export function TaskDetail({ detail, agents, streams, onChanged, onContinued, onError }: Props) {
  const { task, run, events } = detail;
  const [tab, setTab] = React.useState<'chat' | 'changes' | 'details'>('chat');
  const [approval, setApproval] = React.useState<PendingApproval | undefined>();
  const [busy, setBusy] = React.useState(false);
  // 審批提交保護（防雙擊，H-12 前端部分）
  const submitGuard = React.useRef(createSubmitGuard());
  const status = run?.status ?? task.status;
  const ws = run?.workflowState;
  // 任務工作區：工作流任務在 workflowState 裡，對話任務在 run.workspace 裡（v5）
  const workspace = ws?.cwd ? { cwd: ws.cwd, kind: ws.workspace?.kind, branch: ws.workspace?.branch } : run?.workspace;
  const terminal = TERMINAL.has(status);
  const waitingOperator = status === 'WAITING_INPUT' || (status === 'BLOCKED' && Boolean(ws));
  // 手動模式沒有工作流閘門：執行中或阻塞時都可以由操作員接受結果並結束
  const canAccept = waitingOperator || (!ws && !terminal && (status === 'RUNNING' || status === 'BLOCKED'));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (error) {
      // 測試配置被改過（P0-8 / H-15）：服務端已經記下差異，重新整理後上方會出現確認卡片
      if (error instanceof ApiError && error.code === 'TEST_CONFIG_CHANGED') onChanged();
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pendingApproval = run?.pendingApprovals[0];
  const nextAction =
    status === 'WAITING_APPROVAL' && pendingApproval
      ? `等你審批：${pendingApproval.summary}（批准後繼續由 ${pendingApproval.agentId} 處理）`
      : [...events].reverse().map((e) => describeNextAction(e.data.nextAction)).find(Boolean);
  const lastEvent = events.at(-1);
  const activeAgentId = status === 'RUNNING' ? (ws?.awaitingAgentId ?? task.currentAgentId) : status === 'WAITING_APPROVAL' ? pendingApproval?.agentId : undefined;

  return (
    <div className="detail">
      <section className="card task-head compact">
        <div className="row between">
          <div className="head-main">
            <div className="meta">
              {task.workflow === 'manual' ? '對話' : '自動流程'}
              {workspace?.kind === 'worktree' ? ` · worktree ${workspace.branch ?? ''}` : ''}
              {workspace?.cwd ? ` · ${workspace.cwd}` : ''}
            </div>
            <h2 title={task.prompt}>{task.title}</h2>
          </div>
          <div className="row gap">
            <div className="segmented">
              <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>對話</button>
              <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>
                改動{(run?.checkpoints?.length ?? 0) > 1 ? ` ${(run?.checkpoints?.length ?? 1) - 1}` : ''}
              </button>
              <button className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>詳情</button>
            </div>
            <span className={`status big ${status}`}>{STATUS_LABEL[status] ?? status}</span>
          </div>
        </div>
        {ws && <Stepper history={ws.history} current={ws.step} testCommand={ws.testCommand} />}
        {!terminal && nextAction && <div className="next-line">下一步：{nextAction}</div>}
        {terminal && (
          <div className="row gap task-archive-actions">
            {/* 匯出與刪除（P1-12）：匯出是 JSON Lines（任務 + 全部事件），刪除會清掉這個任務的全部記錄 */}
            <a className="link small" href={`/api/tasks/${task.id}/export`} download>
              匯出記錄
            </a>
            {/* 追蹤（P2-2）：OTLP JSON，只含後設資料，可以匯入 Phoenix / Jaeger 檢視每一輪、每個工具、等審批的耗時 */}
            <a className="link small" href={`/api/tasks/${task.id}/trace`} download={`trace-${task.id.slice(0, 8)}.json`} title="OpenTelemetry 格式（只含中繼資料），可以匯入 Phoenix / Jaeger 檢視耗時">
              下載追蹤
            </a>
            <button
              className="link small danger-text"
              disabled={busy}
              onClick={() => confirm('確定刪除這個任務嗎？它的對話、事件和用量記錄會全部清除，無法恢復。') && act(() => api.deleteTask(task.id))}
            >
              刪除任務
            </button>
          </div>
        )}
      </section>

      <Banners detail={detail} agents={agents} busy={busy} onAct={act} />

      {!terminal && ws?.testConfigReview && <TestConfigCard detail={detail} busy={busy} onAct={act} />}

      {(waitingOperator || canAccept || !terminal) && (
        <GateBar detail={detail} agents={agents} busy={busy} terminal={terminal} waitingOperator={waitingOperator} canAccept={canAccept} onAct={act} />
      )}

      {tab === 'changes' ? (
        <ChangesView detail={detail} onChanged={onChanged} onError={onError} />
      ) : tab === 'chat' ? (
        <ChatPanes
          taskId={task.id}
          events={events}
          agents={agents}
          agentIds={chatAgentIds(detail, agents)}
          activeAgentId={activeAgentId}
          sessionStatus={Object.fromEntries(Object.entries(run?.agentSessions ?? {}).map(([id, s]) => [id, s.status]))}
          pendingApprovals={run?.pendingApprovals ?? []}
          streams={streams}
          terminal={terminal}
          blockedConfirm={run ? blockedSendConfirm({ task, run, events, agents }) : undefined}
          onSent={onChanged}
          onContinued={onContinued}
          onError={onError}
        />
      ) : (
        <>
          <section className="card">
            <div className="facts">
              <Fact label="正在工作" value={working(status, ws?.awaitingAgentId ?? task.currentAgentId)} />
              <Fact label="剛剛發生" value={lastEvent ? `${EVENT_LABEL[lastEvent.type] ?? lastEvent.type} · ${describe(lastEvent).slice(0, 80)}` : '—'} />
              <Fact label="下一步編排動作" value={terminal ? '無（任務已結束）' : (nextAction ?? '—')} strong />
              {ws?.testCommand && <Fact label="測試命令" value={ws.testCommand} mono />}
            </div>
            <p className="prompt">{task.prompt}</p>
          </section>
          <section className="agents-grid">
            {agentIds(detail).map((id) => (
              <AgentCard key={id} id={id} detail={detail} agent={agents.find((a) => a.id === id)} onApproval={setApproval} />
            ))}
          </section>
          <div className="two-col">
            <IncidentCenter detail={detail} onApproval={setApproval} />
            {run && <BudgetCard detail={detail} />}
          </div>
          {ws && ws.handoffs.length > 0 && <Handoffs detail={detail} />}
          {ws?.lastTest && (
            <section className="card">
              <h3>最近一次測試 <span className={`tag ${ws.lastTest.passed ? 'ok' : 'bad'}`}>{ws.lastTest.passed ? '通過' : `失敗（exit ${ws.lastTest.exitCode ?? 'n/a'}）`}</span></h3>
              <pre className="log">{ws.lastTest.outputTail || '(無輸出)'}</pre>
            </section>
          )}
          {ws?.review && (
            <section className="card">
              <h3>評審結論 <span className="tag inferred" title="從評審文字解析，屬於推斷結果">{ws.review.verdict} · 推斷</span></h3>
              <pre className="log">{ws.review.summary}</pre>
            </section>
          )}
          <EventStream events={events} />
        </>
      )}

      {approval && run && (
        <ApprovalDialog
          approval={approval}
          pending={run.pendingApprovals.some((a) => a.id === approval.id)}
          onClose={() => setApproval(undefined)}
          onDecide={(decision, answers) => {
            // 防雙擊：上一次提交結束之前不再發請求（不依賴按鈕的禁用狀態重新渲染）
            if (!submitGuard.current.tryBegin(approval.id)) return;
            void act(async () => {
              try {
                if (!(await resolveApprovalWithResume(task.id, approval.id, decision, undefined, answers))) return;
                setApproval(undefined);
              } catch (error) {
                // 已經處理過 / 任務已結束（409）：關掉彈窗並重新整理，再提示原因。
                // 預算不夠 / 任務已阻塞時審批沒有被消費：彈窗保留，按提示處理之後還能再批准
                if (error instanceof ApiError && error.status === 409 && !approvalStillPendingAfter(error.code)) {
                  setApproval(undefined);
                  onChanged();
                }
                throw error;
              } finally {
                submitGuard.current.end(approval.id);
              }
            });
          }}
          busy={busy}
        />
      )}
    </div>
  );
}

/** 對話窗格里顯示哪些 agent：所有可對話的 agent（Claude/Codex）+ 本任務用到的測試執行器。 */
function chatAgentIds(detail: Detail, agents: Agent[]): string[] {
  const ids = agents.filter((a) => a.kind !== 'test').map((a) => a.id);
  const ws = detail.run?.workflowState;
  const testId = ws?.agents.test ?? 'test';
  if (ws?.testCommand || detail.run?.agentSessions[testId]) ids.push(testId);
  return ids;
}

/** “誰在工作”：等待人工時明確指出是在等你，而不是某個 agent。 */
function working(status: string, agentId: string | undefined): string {
  if (TERMINAL.has(status)) return '—（任務已結束）';
  if (status === 'WAITING_INPUT') return '等你決定';
  if (status === 'WAITING_APPROVAL') return `${agentId ?? 'Agent'}（已暫停，等你審批）`;
  if (status === 'BLOCKED') return '無（已阻塞，等你處理）';
  return agentId ?? '—';
}

function Fact({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className={`fact ${strong ? 'strong' : ''}`}>
      <span>{label}</span>
      <b className={mono ? 'mono' : ''} title={value}>{value}</b>
    </div>
  );
}

function Stepper({ history, current, testCommand }: { history: Array<{ step: string; outcome: string }>; current: string; testCommand?: string }) {
  // 已走過的步驟軌跡（重試/診斷/評審只在實際發生時出現）+ 當前步驟 + 剩餘計劃
  const trail = dedupeAdjacent([...history.map((h) => h.step), current]);
  const planned = [...trail];
  if (current !== 'done') {
    if (testCommand && !trail.includes('test')) planned.push('test');
    planned.push('done');
  }
  const currentIndex = trail.length - 1;
  return (
    <div className="steps">
      {planned.map((step, i) => {
        const state = i < currentIndex || (i === currentIndex && current === 'done') ? 'done' : i === currentIndex ? 'active' : '';
        return (
          <React.Fragment key={`${step}-${i}`}>
            {i > 0 && <div className={`line ${i <= currentIndex ? 'done' : ''}`} />}
            <div className={`step ${state}`} title={history[i]?.outcome ?? ''}>
              <i>{state === 'done' ? '✓' : i + 1}</i>
              {STEP_LABEL[step] ?? step}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

function dedupeAdjacent(steps: string[]): string[] {
  return steps.filter((s, i) => i === 0 || steps[i - 1] !== s);
}

/**
 * 橫幅：快照不可讀、重啟恢復、待審批、等你決定、已阻塞。
 * 已阻塞時顯示真實原因（中文），並直接給出一鍵出路（重試 / 換人接手 / 停止，P0-6），不用先去找流程控制條。
 */
function Banners({ detail, agents, busy, onAct }: { detail: Detail; agents: Agent[]; busy: boolean; onAct: (fn: () => Promise<unknown>) => void }) {
  const { run, runLoadStatus, task } = detail;
  const banners: Array<{ kind: string; text: string; actions?: BlockedAction[] }> = [];
  if (runLoadStatus && runLoadStatus !== 'ok') {
    banners.push({ kind: 'critical', text: `執行快照無法讀取（${runLoadStatus}）。需要更新程式或人工處理，系統不會自動繼續。` });
  }
  if (run?.recovery) {
    banners.push({ kind: 'info', text: `此任務在服務重啟後已恢復（第 ${run.recovery.count} 次，${time(run.recovery.recoveredAt)}）。已完成的操作不會被重放。` });
  }
  // 任務結束後遺留的審批已作廢（舊版本留下的快照裡可能還列著）：不再提示等待審批
  const pendingText = run && !TERMINAL.has(run.status) ? pendingApprovalBanner(run.pendingApprovals, agents) : undefined;
  if (pendingText) banners.push({ kind: 'warn', text: pendingText });
  if (run?.status === 'WAITING_INPUT') {
    banners.push({ kind: 'warn', text: operatorPrompt(run.pendingInputs[0]?.prompt) });
  }
  const blocked = run ? blockedBanner({ task, run, events: detail.events, agents }) : undefined;
  if (blocked) banners.push({ kind: 'critical', text: blocked.hint ? `${blocked.reason} ${blocked.hint}` : blocked.reason, actions: blocked.actions });
  if (!banners.length) return null;

  const perform = (action: BlockedAction) => {
    if (action.confirm && !confirm(action.confirm)) return;
    if (action.kind === 'relax') {
      // 一鍵放寬預算並繼續（P0-7）：沒能恢復時把原因告訴使用者（例如仍然不夠、或者需要走閘門）
      onAct(async () => {
        const result = await api.adjustBudget(task.id, { relax: true });
        if (!result.resumed && result.message) throw new Error(result.message);
      });
    } else if (action.kind === 'retry') onAct(() => api.gate(task.id, 'retry', action.note));
    // 重跑阻塞的這一步（交還給負責它的 agent，例如重新請 Codex 診斷）
    else if (action.kind === 'rerun') onAct(() => api.gate(task.id, 'rerun', action.note));
    else if (action.kind === 'reassign' && action.agentId) onAct(() => api.reassign(task.id, action.agentId!));
    else if (action.kind === 'stop') onAct(() => api.cancel(task.id));
  };
  return (
    <div className="banners">
      {banners.map((b, i) => (
        <div key={i} className={`banner ${b.kind}${b.actions ? ' with-actions' : ''}`}>
          <span>{b.text}</span>
          {b.actions && (
            <span className="banner-actions">
              {b.actions.map((action) => (
                <button
                  key={`${action.kind}:${action.agentId ?? ''}`}
                  className={`small ${(action.kind === 'retry' || action.kind === 'rerun' || action.kind === 'relax') && action === b.actions![0] ? 'primary' : action.kind === 'stop' ? 'danger' : ''}`}
                  disabled={busy}
                  title={action.title}
                  onClick={() => perform(action)}
                >
                  {action.label}
                </button>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * 測試配置確認卡片（P0-8 / H-15）：AI 改過測試配置時測試不會自動執行，這裡顯示逐檔案的差異，
 * 並給出一鍵出路：確認並執行測試 / 讓 AI 改回去 / 不跑測試直接接受結果（停止在流程控制條上）。
 */
function TestConfigCard({ detail, busy, onAct }: { detail: Detail; busy: boolean; onAct: (fn: () => Promise<unknown>) => void }) {
  const { task, run } = detail;
  const ws = run?.workflowState;
  const review = ws?.testConfigReview;
  if (!run || !ws || !review) return null;
  const actions = testConfigActions(run.status);
  return (
    <section className="card test-config-review">
      <h3>⚠ {testConfigTitle(review)}</h3>
      <p className="muted">{testConfigExplanation(ws.testCommand)}</p>
      {review.changes.map((change) => (
        <details key={change.path} open={review.changes.length <= 3}>
          <summary>
            <b className="mono">{change.path}</b> <span className="tag">{TEST_CONFIG_KIND_LABEL[change.kind] ?? change.kind}</span>
            {change.note && <small className="muted"> · {change.note}</small>}
          </summary>
          {change.diff ? (
            <pre className="log diff">
              {change.diff.split('\n').map((line, i) => (
                <span key={i} className={`diff-line ${diffLineClass(line)}`}>
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
          ) : (
            <p className="muted small">（不顯示內容）</p>
          )}
        </details>
      ))}
      <div className="actions">
        {actions.includes('confirm') && (
          <button className="primary" disabled={busy} onClick={() => onAct(() => api.confirmTestConfig(task.id, review.digest))}>
            確認這些改動並執行測試
          </button>
        )}
        {actions.includes('revert') && (
          <button disabled={busy} title="把這些改動退回給 AI，請它改回原樣後再測試" onClick={() => onAct(() => api.gate(task.id, 'retry', testConfigRevertNote(review)))}>
            讓 AI 改回去
          </button>
        )}
        {actions.includes('accept') && (
          <button
            disabled={busy}
            title="不執行測試，直接把目前的結果當作完成"
            onClick={() => confirm('不執行測試，直接接受目前的結果並結束任務？') && onAct(() => api.gate(task.id, 'accept'))}
          >
            不跑測試，直接接受結果
          </button>
        )}
      </div>
      <p className="muted small">確認之前如果測試設定又被改了，系統會更新差異並請你重新確認。</p>
    </section>
  );
}

/** 流程控制條：評審 / 帶說明重試 / 接受結果 / 停止。和 agent 說話請直接在對話窗格里輸入。 */
function GateBar({
  detail,
  agents,
  busy,
  terminal,
  waitingOperator,
  canAccept,
  onAct,
}: {
  detail: Detail;
  agents: Agent[];
  busy: boolean;
  terminal: boolean;
  waitingOperator: boolean;
  canAccept: boolean;
  onAct: (fn: () => Promise<unknown>) => void;
}) {
  const { task, run } = detail;
  const [note, setNote] = React.useState('');
  // 當前負責的 agent：工作流為實現者，對話為主 agent（Ask Both 之後最近被派發的可能只是顧問）
  const currentImplementer = run?.workflowState?.agents.implement ?? run?.primaryAgentId ?? run?.currentAgentId ?? task.currentAgentId;
  const reassignTargets = agents.filter((a) => a.kind !== 'test' && a.id !== currentImplementer);
  const policy = run?.settings?.handoffPolicy ?? 'ask';
  const ws = run?.workflowState;
  const reviewLeft = run ? run.budget.maxReviewRounds - run.budget.reviewRoundsUsed : 0;
  // 自動流程正在等測試結果，或者測試執行器正在跑（手動重跑）
  const testRunning = Boolean(ws && ((run?.status === 'RUNNING' && ws.awaitingAgentId === ws.agents.test) || run?.budget.workingAgentIds?.includes(ws.agents.test)));
  if (terminal) return null;
  return (
    <section className="gate-bar">
      {waitingOperator && ws && (
        <>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="給實現 Agent 的補充說明（用於「帶說明重試」）" />
          <button disabled={busy || !note.trim()} onClick={() => onAct(async () => { await api.gate(task.id, 'retry', note.trim()); setNote(''); })}>帶說明重試</button>
          <button disabled={busy || reviewLeft <= 0} title={reviewLeft > 0 ? `剩餘評審輪次 ${reviewLeft}` : '評審輪次已用完'} onClick={() => onAct(() => api.gate(task.id, 'review'))}>
            請 Codex 評審（{Math.max(0, reviewLeft)}）
          </button>
        </>
      )}
      {ws?.testCommand && (
        // 自動流程正在跑測試時不能再點（P0 第三批審查：以前會讓整個任務 BLOCKED，正在跑的那次結果被丟棄）
        <button
          disabled={busy || testRunning}
          title={testRunning ? '測試正在執行中，跑完後結果會自動顯示' : `執行 ${ws.testCommand}`}
          onClick={() => onAct(() => api.message(task.id, ws.agents.test, 'run tests'))}
        >
          {testRunning ? '測試執行中…' : '重跑測試'}
        </button>
      )}
      {/* 換人接手用按鈕（L-22）：以前是下拉框，鍵盤方向鍵一動就會誤觸發；點按鈕後還要在對話方塊裡確認 */}
      {reassignTargets.map((a) => (
        <button
          key={a.id}
          disabled={busy}
          title="停止當前 Agent 的工作，把任務連同上下文交給另一個 Agent 繼續"
          onClick={() => {
            const reason = prompt(`確定換 ${a.name} 接手嗎？
目前的 AI 會停下，任務連同上下文交給 ${a.name} 繼續。

有什麼要特別交代的嗎？（可留空，按「取消」則不換）`, '');
            if (reason === null) return;
            onAct(() => api.reassign(task.id, a.id, reason || undefined));
          }}
        >
          換 {a.name} 接手
        </button>
      ))}
      <label className="policy" title="AI 主動請求把工作交給另一個 AI 時怎麼處理">
        AI 互相交接：
        <select value={policy} disabled={busy} onChange={(e) => onAct(() => api.setHandoffPolicy(task.id, e.target.value as 'ask' | 'auto'))}>
          <option value="ask">每次問我</option>
          <option value="auto">自動（最多 {run?.settings?.maxAutoHandoffs ?? 4} 次）</option>
        </select>
        {policy === 'auto' && run?.settings && <small>已用 {run.settings.autoHandoffsUsed}</small>}
      </label>
      <span className="grow" />
      <button className="green" disabled={!canAccept || busy} onClick={() => onAct(() => api.gate(task.id, 'accept'))}>接受結果並結束</button>
      {task.status === 'BLOCKED' || detail.run?.status === 'BLOCKED' ? (
        <button
          disabled={busy}
          title="不打算再處理這個任務：把它歸檔（標為失敗），之後重啟服務也不會再恢復它"
          onClick={() => confirm('確定放棄這個任務嗎？它會被歸檔，之後不會再恢復。') && onAct(() => api.abandon(task.id))}
        >
          放棄
        </button>
      ) : null}
      <button className="danger" disabled={busy} onClick={() => confirm('確定停止此任務？') && onAct(() => api.cancel(task.id))}>停止</button>
    </section>
  );
}

function agentIds(detail: Detail): string[] {
  const ids = new Set<string>();
  const ws = detail.run?.workflowState;
  if (ws) {
    ids.add(ws.agents.implement);
    if (ws.testCommand) ids.add(ws.agents.test);
    if (ws.rescueUsed || ws.reviewGate || ws.review) ids.add(ws.agents.review);
  }
  for (const id of Object.keys(detail.run?.agentSessions ?? {})) ids.add(id);
  if (!ids.size && detail.task.currentAgentId) ids.add(detail.task.currentAgentId);
  return [...ids];
}

function AgentCard({ id, detail, agent, onApproval }: { id: string; detail: Detail; agent?: Agent; onApproval: (a: PendingApproval) => void }) {
  // 每秒重新整理的時鐘只放在需要顯示耗時的葉子元件裡（L-13）：不再讓整個任務詳情（包括對話窗格）每秒重畫
  const now = useNow();
  const { run, events } = detail;
  const session = run?.agentSessions[id];
  const mine = events.filter((e) => e.agentId === id);
  const started = mine.find((e) => e.type === 'agent.started');
  const last = mine.at(-1);
  const lastAction = [...mine].reverse().find((e) => typeof e.data.action === 'string');
  const status = session?.status ?? 'idle';
  const active = !TERMINAL.has(run?.status ?? '') && ['starting', 'planning', 'coding', 'reviewing', 'testing'].includes(status);
  const approval = run?.pendingApprovals.find((a) => a.agentId === id);
  const error = [...mine].reverse().find((e) => e.type === 'runtime.error');
  const awaiting = run?.workflowState?.awaitingAgentId === id;
  const lastTurn = [...mine].reverse().find((e) => e.type === 'agent.status' && (e.data.status === 'completed' || e.data.status === 'failed'));
  const elapsedEnd = active || awaiting ? now : (lastTurn?.timestamp ?? last?.timestamp ?? now);

  return (
    <div className={`card agent-card ${awaiting ? 'selected' : ''}`}>
      <div className="agent-title">
        <span className={`avatar ${agent?.kind ?? id}`}>{(agent?.name ?? id).slice(0, 1).toUpperCase()}</span>
        <div>
          <b>{agent?.name ?? id}</b>
          <small>{agent?.ready ? '執行時就緒' : '執行時未就緒'}{session?.providerSessionId ? ` · ${session.providerSessionId.slice(0, 18)}` : ''}</small>
        </div>
        <span className={`agent-status ${status} ${active ? 'pulse' : ''}`}>{AGENT_STATUS_LABEL[status] ?? status}</span>
      </div>
      <dl>
        <dt>當前動作</dt>
        <dd>{lastAction ? String(lastAction.data.action) : awaiting ? '等待派發' : '—'}</dd>
        <dt>耗時</dt>
        <dd>{started ? duration(elapsedEnd - started.timestamp) : '—'}</dd>
        <dt>最近事件</dt>
        <dd>{last ? `${time(last.timestamp)} · ${EVENT_LABEL[last.type] ?? last.type}` : '—'}</dd>
        {(approval || (error && run?.status === 'BLOCKED')) && (
          <>
            <dt>阻塞</dt>
            <dd className="blocker">
              {approval ? (
                <button className="link" onClick={() => onApproval(approval)}>等待審批：{approval.summary}</button>
              ) : (
                String(error?.data.code ?? '')
              )}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

type IncidentKind = 'safety' | 'approval' | 'runtime' | 'budget' | 'inferred';
const INCIDENT_LABEL: Record<IncidentKind, string> = {
  safety: '已證實的安全 / 策略攔截',
  approval: '需要審批',
  runtime: '執行時 / 權限錯誤',
  budget: '配額 / 預算',
  inferred: '推斷（未證實）',
};

function IncidentCenter({ detail, onApproval }: { detail: Detail; onApproval: (a: PendingApproval) => void }) {
  const groups: Record<IncidentKind, UnifiedEvent[]> = { safety: [], approval: [], runtime: [], budget: [], inferred: [] };
  for (const e of detail.events) {
    // 推斷出的事件永遠單獨歸類，不與已證實的 provider 決策混在一起
    if (e.confidence === 'inferred' && (e.type === 'runtime.error' || e.type === 'safety.blocked')) groups.inferred.push(e);
    else if (e.type === 'safety.blocked') groups.safety.push(e);
    else if (e.type === 'budget.exceeded' || e.type === 'budget.stalled' || (e.type === 'runtime.error' && e.data.category === 'usage')) groups.budget.push(e);
    else if (e.type === 'runtime.error') groups.runtime.push(e);
  }
  const pending = detail.run?.pendingApprovals ?? [];
  const total = pending.length + groups.safety.length + groups.runtime.length + groups.budget.length + groups.inferred.length;

  return (
    <section className="card incidents">
      <h3>事件中心 <span className="count">{total}</span></h3>
      {total === 0 && <p className="muted">沒有需要處理的事項。</p>}
      {pending.length > 0 && (
        <div className="incident-group approval">
          <h4>{INCIDENT_LABEL.approval}</h4>
          {pending.map((a) => (
            <div key={a.id} className="incident">
              <b>{a.agentId}</b>
              <span>{a.summary}</span>
              <button className="primary small" onClick={() => onApproval(a)}>處理</button>
            </div>
          ))}
        </div>
      )}
      {(['safety', 'runtime', 'budget', 'inferred'] as IncidentKind[]).map(
        (kind) =>
          groups[kind].length > 0 && (
            <div key={kind} className={`incident-group ${kind}`}>
              <h4>
                {INCIDENT_LABEL[kind]}
                {kind === 'inferred' && <span className="tag inferred">僅根據文字推斷</span>}
              </h4>
              {groups[kind].slice(-6).map((e) => (
                <div key={e.id} className="incident">
                  <time>{time(e.timestamp)}</time>
                  <b>{e.agentId ?? '系統'}</b>
                  <span>{String(e.data.code ?? e.data.limit ?? '')} {String(e.data.message ?? e.data.reason ?? '')}</span>
                  <span className={`tag ${e.confidence}`}>{e.confidence === 'confirmed' ? '已證實' : '推斷'}</span>
                </div>
              ))}
            </div>
          ),
      )}
    </section>
  );
}

function BudgetCard({ detail }: { detail: Detail }) {
  const now = useNow();
  const run = detail.run!;
  const b = run.budget;
  const reported = detail.usage.reduce((n, u) => n + (u.inputTokens ?? 0) + (u.outputTokens ?? 0), 0);
  // 按當前計數視窗顯示（P0-7）：時長只統計 AI 實際工作的時間，等你決定、對話空閒、服務停機都不算
  const rows = budgetRows(b, now);
  const conversation = !run.workflowState;
  const scope = conversation
    ? '對話任務的限額按「每條指令」計算：你每發一條訊息都重新計算。'
    : b.window
      ? `自 ${time(b.window.at)} 重新計算（${b.window.reason === 'gate' ? '閘門決定' : b.window.reason === 'reassign' ? '換人接手' : '放寬預算'}）。`
      : '整個任務共用一份額度；「重試 / 評審 / 放寬預算」時重新計算。';
  return (
    <section className="card budget">
      <h3>預算消耗</h3>
      {rows.map(({ label, used, max, kind }) => {
        const pct = Math.min(100, Math.round((used / Math.max(1, max)) * 100));
        const fmt = (n: number) => (kind === 'duration' ? duration(n) : kind === 'tokens' ? tokens(n) : kind === 'usd' ? usd(n) : String(n));
        return (
          <div key={label} className="budget-row">
            <span>{label}</span>
            <div className="bar"><i className={pct >= 100 ? 'full' : pct >= 75 ? 'high' : ''} style={{ width: `${pct}%` }} /></div>
            <small>{fmt(used)} / {fmt(max)}</small>
          </div>
        );
      })}
      <p className="muted small">{scope}工作時長只計 AI 實際工作的時間。</p>
      <p className="muted small">
        累計：模型輪次 {b.turnsUsed} · 呼叫 {b.agentCallsUsed} · 工作時長 {duration(activeWorkMs(b, now))} · Token：輸入+輸出 {tokens(reported)}（{detail.usage.length} 輪上報）· 已完成副作用{' '}
        {run.sideEffectCount ?? run.completedSideEffects.length} 個
      </p>
    </section>
  );
}

function Handoffs({ detail }: { detail: Detail }) {
  const [open, setOpen] = React.useState<string | undefined>();
  const handoffs = detail.run?.workflowState?.handoffs ?? [];
  return (
    <section className="card">
      <h3>交接記錄</h3>
      {handoffs.map((h) => (
        <div key={h.id} className="handoff">
          <button className="link" onClick={() => setOpen(open === h.id ? undefined : h.id)}>
            {time(h.at)} · {h.from ?? '編排器'} → {h.to} · {STEP_LABEL[h.step] ?? h.step}
          </button>
          {open === h.id && <pre className="log">{h.context}</pre>}
        </div>
      ))}
    </section>
  );
}

function EventStream({ events }: { events: UnifiedEvent[] }) {
  const [filter, setFilter] = React.useState<'all' | 'important'>('important');
  const shown = events.filter((e) => filter === 'all' || !['model.turn.started', 'agent.status'].includes(e.type) || e.data.status === 'completed' || e.data.status === 'failed');
  return (
    <section className="card">
      <div className="row between">
        <h3>事件流</h3>
        <div className="segmented">
          <button className={filter === 'important' ? 'on' : ''} onClick={() => setFilter('important')}>重要</button>
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>全部</button>
        </div>
      </div>
      <div className="events">
        {[...shown].reverse().map((e) => (
          <div key={e.id} className={`event sev-${e.severity}`}>
            <span className="seq">#{e.sequence}</span>
            <time>{time(e.timestamp)}</time>
            <b>{e.agentId ?? '系統'}</b>
            <span className="etype">{EVENT_LABEL[e.type] ?? e.type}</span>
            <small title={describe(e)}>{describe(e)}</small>
            {e.confidence === 'inferred' && <span className="tag inferred">推斷</span>}
          </div>
        ))}
      </div>
    </section>
  );
}
