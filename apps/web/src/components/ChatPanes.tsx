import React from 'react';
import { QuestionForm, questionsOf, type Question } from './QuestionForm';
import { ApiError, api } from '../api';
import { approvalCardState, approvalRisk, approvalStillPendingAfter, createSubmitGuard, handoffRequestNotice, resumeHandoffConfirm, sessionScopeOffered } from '../approval-ui';
import type { Agent, PendingApproval, UnifiedEvent } from '../types';
import { Markdown } from './Markdown';
import { paneLayout } from '../layout-ui';

/**
 * 對話窗格：每個 agent 一個聊天視窗。
 * - 你在窗格底部直接輸入，回車傳送（Shift+Enter 換行）；
 * - 回覆逐字流式顯示（臨時事件），完成後替換為持久化的完整回覆；
 * - 工具呼叫、審批（可直接批准/拒絕）、狀態變化按時間穿插顯示。
 */
interface Props {
  taskId: string;
  events: UnifiedEvent[];
  agents: Agent[];
  agentIds: string[];
  activeAgentId?: string;
  /** agentId → 會話狀態（coding / reviewing / testing / completed …） */
  sessionStatus: Record<string, string>;
  pendingApprovals: PendingApproval[];
  /** agentId → 正在流式輸出的文字 */
  streams: Record<string, string>;
  terminal: boolean;
  /** 對話任務已阻塞時，傳送前請使用者確認的文字（確認後「恢復並傳送」，P0-7）；不需要確認時為空。 */
  blockedConfirm?: string;
  onSent: () => void;
  onContinued: (newTaskId: string) => void;
  onError: (message: string) => void;
}

/**
 * 傳送（P0-7 / H-8）：對話任務已阻塞時先請使用者確認，確認後帶 resume 傳送（服務端先恢復任務，因預算阻塞的先放寬預算）。
 * 介面還沒重新整理、服務端已經阻塞時（409 TASK_BLOCKED）同樣說明原因、請使用者確認後重發。
 * 預算不夠被拒絕時（409 BUDGET_EXHAUSTED，P0 第三批審查：自動流程等你決定時只拒絕這一次、任務狀態不變）：說明原因，
 * 使用者確認後一鍵放寬預算（再給一份同樣的額度）並重新傳送。返回是否已經傳送。
 */
async function sendMaybeResume(taskId: string, blockedConfirm: string | undefined, send: (resume: boolean) => Promise<unknown>): Promise<boolean> {
  if (blockedConfirm) {
    if (!confirm(blockedConfirm)) return false;
    await send(true);
    return true;
  }
  try {
    await send(false);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'BUDGET_EXHAUSTED') {
      if (!confirm(`${error.message}\n\n要放寬預算（再給一份同樣的額度）並重新傳送嗎？`)) return false;
      await api.adjustBudget(taskId, { relax: true });
      await send(false);
      return true;
    }
    if (!(error instanceof ApiError) || error.code !== 'TASK_BLOCKED') throw error;
    if (!confirm(`${error.message}\n\n確定要恢復任務並傳送嗎？`)) return false;
    await send(true);
    return true;
  }
}

/**
 * 提交審批（P0 第二批審查）：批准交接時對話任務已阻塞（409 TASK_BLOCKED，審批仍待處理），說明原因並請使用者確認
 * 「恢復並轉交」，確認後帶 resume 重新提交（服務端先恢復任務再轉交）。返回是否已經提交（使用者取消時為 false）。
 */
export async function resolveApprovalWithResume(
  taskId: string,
  approvalId: string,
  decision: 'approve' | 'decline',
  scope?: 'once' | 'session',
  answers?: Record<string, string[]>,
): Promise<boolean> {
  try {
    await api.resolveApproval(taskId, approvalId, decision, scope, false, answers);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'BUDGET_EXHAUSTED' && decision === 'approve') {
      // 預算不夠執行這次交接（審批仍待處理，P0 第三批審查）：一鍵放寬預算後重新批准
      if (!confirm(`${error.message}\n\n要放寬預算（再給一份同樣的額度）並重新批准嗎？`)) return false;
      await api.adjustBudget(taskId, { relax: true });
      await api.resolveApproval(taskId, approvalId, decision, scope, false, answers);
      return true;
    }
    if (!(error instanceof ApiError) || error.code !== 'TASK_BLOCKED' || decision !== 'approve') throw error;
    if (!confirm(resumeHandoffConfirm(error.message))) return false;
    await api.resolveApproval(taskId, approvalId, decision, scope, true, answers);
    return true;
  }
}

type Item =
  | { kind: 'user'; id: string; at: number; from: string; text: string }
  | { kind: 'reply'; id: string; at: number; text: string }
  | { kind: 'tool'; id: string; at: number; name: string; input: string; output?: string; status: 'running' | 'ok' | 'failed'; exitCode?: number }
  | {
      kind: 'approval';
      id: string;
      at: number;
      approvalId: string;
      text: string;
      detail: string;
      /** 完整輸入（M-19）：摘要被截斷時可以展開檢視。 */
      full?: string;
      resolved?: string;
      handoff?: { to: string; instruction: string };
      /** 交接請求的說明（P0-9：從文字推斷的請求需要你確認）。 */
      notice?: string;
      /** 是否提供「本會話都允許」（P0-8 / M-15：執行時不允許時不提供）。 */
      allowSession?: boolean;
      /** 高風險提示（P0-8：命令涉及受保護路徑）。 */
      risk?: string;
      /** AI 向你提的問題（P2-6）。 */
      questions?: Question[];
    }
  | { kind: 'status'; id: string; at: number; text: string; tone: 'info' | 'warn' | 'error' };

const clock = (ts: number) => new Date(ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });

/** 完整輸入（M-19）：和摘要不一樣（摘要被截斷）時才返回，用於「展開完整內容」。 */
function fullInputText(data: Record<string, unknown>): string | undefined {
  if (!data.fullInput || typeof data.fullInput !== 'object') return undefined;
  const full = JSON.stringify(data.fullInput, null, 2);
  return full === JSON.stringify(data.toolInput ?? {}, null, 2) ? undefined : full;
}

function toolInput(data: Record<string, unknown>): string {
  const input = (data.toolInput ?? {}) as Record<string, unknown>;
  const main = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.files;
  if (main !== undefined) return Array.isArray(main) ? main.join(', ') : String(main);
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json;
}

const TERMINAL_RUN_STATUSES = new Set(['CANCELLED', 'COMPLETED', 'FAILED']);

function buildItems(events: UnifiedEvent[], agentId: string): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  const approvals = new Map<string, Extract<Item, { kind: 'approval' }>>();
  for (const e of events) {
    // 任務結束：還沒處理的審批全部作廢（服務端在同一次投影裡把它們標為 voided，不會再執行）
    if ((e.type === 'run.status' && TERMINAL_RUN_STATUSES.has(String(e.data.status))) || e.type === 'run.completed' || e.type === 'run.failed') {
      for (const item of approvals.values()) item.resolved ??= '已作廢（任務已結束）';
      continue;
    }
    if (e.agentId !== agentId) continue;
    const d = e.data;
    switch (e.type) {
      case 'agent.message':
        if (d.direction === 'to-agent' && d.from === 'handoff') {
          // 交接：顯示“轉自誰 + 你的要求”，被轉發的原文可展開
          items.push({ kind: 'user', id: e.id, at: e.timestamp, from: `轉自 ${String(d.fromAgentId)}`, text: `${String(d.instruction ?? '')}\n\n——— 轉發內容 ———\n${String(d.forwarded ?? '')}` });
        } else if (d.direction === 'to-agent' && d.askBoth) {
          items.push({ kind: 'user', id: e.id, at: e.timestamp, from: d.advisory ? '你（同時問兩個 · 唯讀給意見）' : '你（同時問兩個）', text: String(d.original ?? d.message ?? '') });
        } else if (d.direction === 'to-agent') items.push({ kind: 'user', id: e.id, at: e.timestamp, from: d.from === 'operator' ? '你' : '編排器', text: String(d.message ?? '') });
        else items.push({ kind: 'reply', id: e.id, at: e.timestamp, text: String(d.message ?? '') });
        break;
      case 'tool.started': {
        const item: Extract<Item, { kind: 'tool' }> = { kind: 'tool', id: e.id, at: e.timestamp, name: String(d.toolName ?? 'tool'), input: toolInput(d), status: 'running' };
        tools.set(String(d.toolCallId ?? e.id), item);
        items.push(item);
        break;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const item = tools.get(String(d.toolCallId ?? ''));
        const patch = {
          status: (e.type === 'tool.completed' ? 'ok' : 'failed') as 'ok' | 'failed',
          output: typeof d.output === 'string' ? d.output : undefined,
          exitCode: typeof d.exitCode === 'number' ? d.exitCode : undefined,
        };
        if (item) Object.assign(item, patch);
        else items.push({ kind: 'tool', id: e.id, at: e.timestamp, name: String(d.toolName ?? 'tool'), input: '', ...patch });
        break;
      }
      case 'approval.required': {
        const approvalId = String(d.approvalId ?? e.id);
        const item: Extract<Item, { kind: 'approval' }> =
          d.kind === 'handoff'
            ? { kind: 'approval', id: e.id, at: e.timestamp, approvalId, text: String(d.summary ?? ''), detail: '', handoff: { to: String(d.toAgentId), instruction: String(d.instruction ?? '') }, notice: handoffRequestNotice(d) }
            : d.kind === 'question'
              ? { kind: 'approval', id: e.id, at: e.timestamp, approvalId, text: String(d.summary ?? 'AI 想問你問題'), detail: '', questions: questionsOf(d) }
              : { kind: 'approval', id: e.id, at: e.timestamp, approvalId, text: String(d.summary ?? '需要審批'), detail: toolInput(d), full: fullInputText(d), allowSession: sessionScopeOffered(d), risk: approvalRisk(d)?.text };
        approvals.set(approvalId, item);
        items.push(item);
        break;
      }
      case 'approval.resolved': {
        const item = approvals.get(String(d.approvalId ?? ''));
        // 只認第一次處理結果（同一審批只會被消費一次）
        if (item && !item.resolved) {
          item.resolved =
            d.resolvedBy === 'timeout'
              ? `已跳過（${String((d.policy as { reason?: string } | undefined)?.reason ?? '逾時')}，AI 自己判斷）`
              : d.resolvedBy === 'policy'
              ? `已自動放行（${String((d.policy as { reason?: string } | undefined)?.reason ?? '審批策略')}）`
              : d.resolvedBy === 'orchestrator' && d.reason === 'run-terminal'
              ? '已自動拒絕（任務已結束）'
              : d.resolvedBy === 'orchestrator' && d.withdrawn === true
                ? '已作廢（重新派發這一步之前停掉了原來的一輪）'
              : item.handoff
                ? d.decision === 'approve' ? `已同意，交給 ${item.handoff.to}` : '已拒絕交接'
                : d.resolvedBy === 'reassign' ? '已作廢（換人接手）' : d.decision === 'approve' ? (d.scope === 'session' ? '已批准（本會話都允許）' : '已批准') : '已拒絕';
        }
        break;
      }
      case 'agent.status':
        if (d.status === 'completed' && typeof d.testPassed === 'boolean') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: d.testPassed ? '測試通過' : `測試失敗（exit ${String(d.exitCode ?? 'n/a')}）`, tone: d.testPassed ? 'info' : 'error' });
        } else if (d.status === 'failed' || d.status === 'cancelled') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: d.status === 'failed' ? '出錯停止' : '已停止', tone: d.status === 'failed' ? 'error' : 'warn' });
        }
        break;
      case 'handoff.requested':
        if (d.origin === 'agent') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: `請求交給 ${String(d.toAgentId)}：${String(d.instruction ?? '')}${e.confidence === 'inferred' ? '（從文字識別）' : ''}`, tone: 'info' });
        } else if (d.reason === 'agent-request' && d.auto) {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: `按自動策略接收來自 ${String(d.fromAgentId)} 的交接`, tone: 'info' });
        }
        break;
      case 'agent.started':
        if (d.resumed) items.push({ kind: 'status', id: e.id, at: e.timestamp, text: '服務重啟後已續接會話', tone: 'info' });
        break;
      case 'runtime.warning':
        // 受保護路徑（P0-8）：寫入被拒絕、或 Codex 在沙箱內直接改了受保護檔案——在對話裡說明，操作員知道發生了什麼
        if (d.code === 'PROTECTED_PATH_WRITE_DENIED' || d.code === 'PROTECTED_PATH_WRITE_DETECTED') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: String(d.message ?? d.action ?? ''), tone: d.code === 'PROTECTED_PATH_WRITE_DETECTED' ? 'error' : 'warn' });
        }
        // 交接請求的目標不合法、adapter 發了只有編排器才能發的事件（P0-9）：在對話裡說明被攔下了
        if ((d.code === 'HANDOFF_REQUEST_REJECTED' || d.code === 'ADAPTER_EVENT_REJECTED') && typeof d.message === 'string') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: d.message, tone: 'warn' });
        }
        // 同時問時這個 agent 正在工作沒有問它、交接內容併入自動流程、接手的 agent 只能讀（P0 第三批審查）：在它的對話裡說明
        if ((d.code === 'ASK_BOTH_ADVISOR_BUSY' || d.code === 'HANDOFF_MERGED_INTO_WORKFLOW' || d.code === 'READ_ONLY_TAKEOVER') && typeof d.message === 'string') {
          items.push({ kind: 'status', id: e.id, at: e.timestamp, text: d.message, tone: d.code === 'READ_ONLY_TAKEOVER' ? 'warn' : 'info' });
        }
        break;
      case 'runtime.error':
      case 'safety.blocked':
        items.push({ kind: 'status', id: e.id, at: e.timestamp, text: `${e.type === 'safety.blocked' ? '安全攔截' : '錯誤'}：${String(d.message ?? d.code ?? '')}${e.confidence === 'inferred' ? '（推斷）' : ''}`, tone: 'error' });
        break;
      default:
        break;
    }
  }
  return items;
}

export function ChatPanes(props: Props) {
  const { agentIds, agents } = props;
  const [single, setSingle] = React.useState<string | undefined>();
  // 視窗太窄、並排時每個窗格不到 MIN_PANE_WIDTH（M-29）：自動改成一次只看一個（分頁），不再把窗格擠成一條
  const areaRef = React.useRef<HTMLElement>(null);
  const [width, setWidth] = React.useState<number>(0);
  React.useEffect(() => {
    const el = areaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const narrow = paneLayout(width, agentIds.length) === 'tabs';
  const current = single && agentIds.includes(single) ? single : narrow ? (props.activeAgentId && agentIds.includes(props.activeAgentId) ? props.activeAgentId : agentIds[0]) : undefined;
  const shown = current ? [current] : agentIds;
  return (
    <section className="chat-area" ref={areaRef}>
      {!props.terminal && agentIds.filter((id) => agents.find((a) => a.id === id)?.kind !== 'test').length > 1 && (
        <AskBothBar taskId={props.taskId} agents={agents.filter((a) => a.kind !== 'test')} blockedConfirm={props.blockedConfirm} onSent={props.onSent} onError={props.onError} />
      )}
      <div className="chat-toolbar">
        <div className="segmented">
          {!narrow && (
            <button className={!current ? 'on' : ''} onClick={() => setSingle(undefined)}>全部並排</button>
          )}
          {agentIds.map((id) => (
            <button key={id} className={current === id ? 'on' : ''} onClick={() => setSingle(id)}>
              {narrow ? '' : '只看 '}
              {agents.find((a) => a.id === id)?.name ?? id}
              {props.pendingApprovals.some((a) => a.agentId === id) && <span className="tab-dot" title="等你審批" />}
            </button>
          ))}
        </div>
      </div>
      <div className="chat-grid" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
        {shown.map((id) => (
          <Pane key={id} agentId={id} agent={agents.find((a) => a.id === id)} {...props} />
        ))}
      </div>
    </section>
  );
}

function Pane({
  agentId,
  agent,
  taskId,
  events,
  sessionStatus,
  pendingApprovals,
  streams,
  terminal,
  blockedConfirm,
  onSent,
  onContinued,
  onError,
  agents: allAgents,
}: Props & { agentId: string; agent?: Agent }) {
  const items = React.useMemo(() => buildItems(events, agentId), [events, agentId]);
  const stream = streams[agentId] ?? '';
  const ref = React.useRef<HTMLDivElement>(null);
  const [follow, setFollow] = React.useState(true);
  const [text, setText] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const isTest = agent?.kind === 'test';
  // 該 agent 自己的會話處於活動狀態才算“正在工作”；等審批時不顯示思考中
  const waitingApproval = pendingApprovals.some((a) => a.agentId === agentId);
  const working = !terminal && !waitingApproval && ['starting', 'planning', 'coding', 'reviewing', 'testing'].includes(sessionStatus[agentId] ?? '');
  const [interrupting, setInterrupting] = React.useState(false);
  // 只停下這個 AI 的這一輪（P1-10 / M-27）：任務繼續，之後再發訊息會接回原來的對話
  const interrupt = async () => {
    if (interrupting) return;
    setInterrupting(true);
    try {
      await api.interrupt(taskId, agentId);
      onSent();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setInterrupting(false);
    }
  };
  const pending = new Set(pendingApprovals.map((a) => a.id));

  React.useEffect(() => {
    if (!follow) return;
    const frame = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items, stream, follow]);

  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      if (terminal) {
        const next = await api.continueTask(taskId, agentId, message);
        onContinued(next.id);
      } else {
        if (!(await sendMaybeResume(taskId, blockedConfirm, (resume) => api.message(taskId, agentId, message, resume)))) return;
        onSent();
      }
      setText('');
      setFollow(true);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  // 可以把本 agent 的回覆轉給哪些 agent（排除自己和測試執行器）
  const forwardTargets = allAgents.filter((a) => a.id !== agentId && a.kind !== 'test');
  const forward = async (toAgentId: string, content: string, instruction: string) => {
    try {
      if (!(await sendMaybeResume(taskId, blockedConfirm, (resume) => api.handoff(taskId, agentId, toAgentId, content, instruction, resume)))) return;
      onSent();
    } catch (error) {
      onError((error as Error).message);
    }
  };

  // 審批提交：提交中按鈕禁用，雙擊只發一次請求；提交成功後不再顯示按鈕（H-12 前端部分）
  const submitGuard = React.useRef(createSubmitGuard());
  const [submitting, setSubmitting] = React.useState<ReadonlySet<string>>(() => new Set());
  const [submitted, setSubmitted] = React.useState<ReadonlySet<string>>(() => new Set());
  const decide = async (approvalId: string, decision: 'approve' | 'decline', scope?: 'once' | 'session', answers?: Record<string, string[]>) => {
    if (!submitGuard.current.tryBegin(approvalId)) return;
    setSubmitting((current) => new Set(current).add(approvalId));
    try {
      if (!(await resolveApprovalWithResume(taskId, approvalId, decision, scope, answers))) return;
      setSubmitted((current) => new Set(current).add(approvalId));
      onSent();
    } catch (error) {
      // 409：已經處理過（例如另一個分頁先處理了）或任務已結束——不再顯示按鈕，重新整理後顯示結果。
      // 預算不夠 / 任務已阻塞時審批沒有被消費：按鈕保留，按提示放寬預算或恢復之後還能再批准
      if (error instanceof ApiError && error.status === 409) {
        if (!approvalStillPendingAfter(error.code)) setSubmitted((current) => new Set(current).add(approvalId));
        onSent();
      }
      onError((error as Error).message);
    } finally {
      submitGuard.current.end(approvalId);
      setSubmitting((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
    }
  };

  return (
    <div className={`chat-pane ${working ? 'working' : ''}`}>
      <div className="chat-head">
        <span className={`avatar ${agent?.kind ?? agentId}`}>{(agent?.name ?? agentId).slice(0, 1)}</span>
        <b>{agent?.name ?? agentId}</b>
        {working && <span className="typing">● 正在工作</span>}
        {working && !isTest && (
          <button className="link small pane-interrupt" disabled={interrupting} onClick={() => void interrupt()} title="只停下這個 AI 現在這一輪，任務不會結束；之後再發訊息會接回原來的對話">
            {interrupting ? '停下中…' : '⏹ 停下這一輪'}
          </button>
        )}
        {waitingApproval && <span className="typing warn">● 等你審批</span>}
        {/* 這一輪以失敗結束（出錯、程式意外退出或斷線，P0-6）：不再顯示“正在工作”，並告訴使用者怎麼繼續 */}
        {!terminal && !isTest && sessionStatus[agentId] === 'failed' && (
          <span className="typing warn" title="這一輪出錯或程式意外中斷了；再發一條訊息，系統會自動重新接上原來的對話">● 這一輪中斷了，再發訊息會自動重新接上</span>
        )}
        {!follow && (
          <button className="link small" onClick={() => setFollow(true)}>回到最新 ↓</button>
        )}
      </div>
      <div
        className="chat-body"
        ref={ref}
        onScroll={() => {
          const el = ref.current;
          if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {items.length === 0 && !stream && <div className="chat-empty">{isTest ? '測試執行器：工作流會在這裡自動跑測試。' : `在下面輸入，直接和 ${agent?.name ?? agentId} 對話。`}</div>}
        {items.map((item) => (
          <ChatItem
            key={item.id}
            item={item}
            pending={item.kind === 'approval' && pending.has(item.approvalId)}
            submitting={item.kind === 'approval' && submitting.has(item.approvalId)}
            submitted={item.kind === 'approval' && submitted.has(item.approvalId)}
            onDecide={decide}
            forwardTargets={terminal || isTest ? [] : forwardTargets}
            onForward={forward}
          />
        ))}
        {stream && (
          <div className="msg reply streaming">
            <div className="bubble md-bubble">
              <Markdown text={stream} />
              <span className="cursor">▌</span>
            </div>
          </div>
        )}
        {working && !stream && <div className="thinking">思考中<span className="dots">…</span></div>}
      </div>
      {!isTest && (
        <div className="chat-input">
          <textarea
            rows={2}
            value={text}
            placeholder={terminal ? `任務已結束，輸入即可「繼續對話」（會帶上前情提要）` : `對 ${agent?.name ?? agentId} 說…（Enter 傳送，Shift+Enter 換行）`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary" disabled={!text.trim() || sending} onClick={() => void send()}>
            {sending ? '…' : terminal ? '繼續對話' : '傳送'}
          </button>
        </div>
      )}
    </div>
  );
}

/** 同時問兩個：主 agent（預設 Claude）可寫，其餘唯讀給意見。 */
function AskBothBar({ taskId, agents, blockedConfirm, onSent, onError }: { taskId: string; agents: Agent[]; blockedConfirm?: string; onSent: () => void; onError: (m: string) => void }) {
  const [text, setText] = React.useState('');
  const [primary, setPrimary] = React.useState(agents[0]?.id ?? 'claude');
  const [sending, setSending] = React.useState(false);
  const send = async () => {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    try {
      if (!(await sendMaybeResume(taskId, blockedConfirm, (resume) => api.askBoth(taskId, message, primary, resume)))) return;
      setText('');
      onSent();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSending(false);
    }
  };
  const names = agents.map((a) => a.name).join(' + ');
  return (
    <div className="ask-both">
      <input
        value={text}
        placeholder={`同時問 ${names}…（Enter 傳送）`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <select value={primary} onChange={(e) => setPrimary(e.target.value)} title="誰可以改檔案（其他唯讀給意見）">
        {agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name} 可改檔案</option>
        ))}
      </select>
      <button className="primary" disabled={!text.trim() || sending} onClick={() => void send()}>{sending ? '…' : '同時問'}</button>
    </div>
  );
}

/** 轉發時給接收方的預設要求。 */
function defaultInstruction(to: Agent): string {
  return to.kind === 'codex'
    ? '請評審上面這段內容，指出問題、風險和具體改進建議。'
    : '請根據上面的意見進行處理，完成後簡要說明你改了什麼。';
}

function ChatItem({
  item,
  pending,
  submitting,
  submitted,
  onDecide,
  forwardTargets,
  onForward,
}: {
  item: Item;
  pending: boolean;
  submitting: boolean;
  submitted: boolean;
  onDecide: (id: string, d: 'approve' | 'decline', scope?: 'once' | 'session', answers?: Record<string, string[]>) => void;
  forwardTargets: Agent[];
  onForward: (toAgentId: string, content: string, instruction: string) => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const [target, setTarget] = React.useState<Agent | undefined>();
  const [instruction, setInstruction] = React.useState('');
  const [sending, setSending] = React.useState(false);
  switch (item.kind) {
    case 'user': {
      const long = item.text.length > 400;
      return (
        <div className={`msg user ${item.from === '你' ? 'me' : item.from.startsWith('轉自') ? 'handoff' : 'orchestrator'}`}>
          <div className="meta">{item.from} · {clock(item.at)}</div>
          <div className="bubble">
            {long && !open ? `${item.text.slice(0, 400)}…` : item.text}
            {long && <button className="link small block" onClick={() => setOpen(!open)}>{open ? '收起' : '展開全文'}</button>}
          </div>
        </div>
      );
    }
    case 'reply':
      return (
        <div className="msg reply">
          <div className="meta">{clock(item.at)}</div>
          <div className="bubble md-bubble">
            <Markdown text={item.text} />
          </div>
          {forwardTargets.length > 0 && !target && (
            <div className="forward-actions">
              {forwardTargets.map((a) => (
                <button
                  key={a.id}
                  className="link small"
                  onClick={() => {
                    setTarget(a);
                    setInstruction(defaultInstruction(a));
                  }}
                >
                  ↪ 轉給 {a.name}
                </button>
              ))}
            </div>
          )}
          {target && (
            <div className="forward-box">
              <div className="small muted">把這段回覆轉給 {target.name}，並要求它：</div>
              <textarea rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
              <div className="row gap">
                <button
                  className="primary small"
                  disabled={sending || !instruction.trim()}
                  onClick={async () => {
                    setSending(true);
                    await onForward(target.id, item.text, instruction.trim());
                    setSending(false);
                    setTarget(undefined);
                  }}
                >
                  {sending ? '傳送中…' : `發給 ${target.name}`}
                </button>
                <button className="small" onClick={() => setTarget(undefined)}>取消</button>
              </div>
            </div>
          )}
        </div>
      );
    case 'tool':
      return (
        <div className={`tool-line ${item.status}`}>
          <button className="tool-toggle" onClick={() => setOpen(!open)} disabled={!item.output}>
            <span className="icon">{item.status === 'running' ? '⟳' : item.status === 'ok' ? '✓' : '✗'}</span>
            <b>{item.name}</b>
            <code>{item.input || '—'}</code>
            {item.exitCode !== undefined && <span className="exit">exit {item.exitCode}</span>}
            {item.output && <span className="more">{open ? '▾' : '▸'}</span>}
          </button>
          {open && item.output && <pre>{item.output}</pre>}
        </div>
      );
    case 'approval': {
      // 待處理 → 可操作；提交中 → 按鈕禁用；已處理（或剛提交成功、等重新整理）→ 不再顯示按鈕
      const state = approvalCardState({ pending, submitting, submitted });
      const busy = state === 'submitting';
      return (
        <div className={`approval-card ${state !== 'resolved' ? 'pending' : ''} ${item.handoff ? 'handoff' : ''}`}>
          <div className="title">{item.questions ? '❓' : item.handoff ? '🔁' : '🔐'} {item.text}</div>
          {item.detail && <code className="detail">{item.detail}</code>}
          {item.full && (
            <details className="approval-full">
              <summary>展開完整內容</summary>
              <pre>{item.full}</pre>
            </details>
          )}
          {item.risk && state !== 'resolved' && <div className="risk high">⚠ 高風險：{item.risk}</div>}
          {item.notice && state !== 'resolved' && <div className="risk notice">ℹ {item.notice}</div>}
          {state !== 'resolved' && item.questions ? (
            <QuestionForm questions={item.questions} busy={busy} onSubmit={(answers) => onDecide(item.approvalId, 'approve', undefined, answers)} />
          ) : state !== 'resolved' && item.handoff ? (
            <div className="buttons">
              <button className="primary small" disabled={busy} onClick={() => onDecide(item.approvalId, 'approve')}>{busy ? '提交中…' : `同意交給 ${item.handoff.to}`}</button>
              <button className="small" disabled={busy} onClick={() => onDecide(item.approvalId, 'decline')}>不用</button>
            </div>
          ) : state !== 'resolved' ? (
            <div className="buttons">
              <button className="primary small" disabled={busy} onClick={() => onDecide(item.approvalId, 'approve')}>{busy ? '提交中…' : '批准這一次'}</button>
              {item.allowSession !== false && (
                <button className="small" disabled={busy} title="本會話內同類操作不再逐個詢問（只在這個會話內有效，不會寫進任何設定檔）" onClick={() => onDecide(item.approvalId, 'approve', 'session')}>本會話都允許</button>
              )}
              {!item.risk && (
                <button
                  className="small"
                  disabled={busy}
                  title="建立一條規則：以後同樣的操作自動放行（可以在「自動放行」頁撤銷）；這一次也會批准"
                  onClick={() => {
                    void api.addPolicyRule(item.approvalId).then(
                      () => onDecide(item.approvalId, 'approve'),
                      (e: Error) => alert(e.message),
                    );
                  }}
                >
                  以後都允許
                </button>
              )}
              <button className="danger small" disabled={busy} onClick={() => onDecide(item.approvalId, 'decline')}>拒絕</button>
            </div>
          ) : (
            <div className="resolved">{item.resolved ?? (pending ? '已提交，處理中…' : '已處理')}</div>
          )}
        </div>
      );
    }
    case 'status':
      return <div className={`status-line ${item.tone}`}>— {item.text} · {clock(item.at)}</div>;
  }
}
