import React from 'react';
import { api } from '../api';
import { duration, time, tokens, usd } from '../format';
import type { Agent, UsageSummary } from '../types';

/** 用量面板（P3.3）：呼叫、耗時、上報/估算 token、評審輪次、失敗、停滯。 */
export function UsageView({ usage, agents }: { usage?: UsageSummary; agents: Agent[] }) {
  if (!usage) return <p className="muted pad">載入中…</p>;
  const t = usage.totals;
  const totalTokens = t.inputTokens + t.outputTokens;
  const cards: Array<[string, string, string?]> = [
    ['任務', String(usage.runs), `進行中 ${usage.activeRuns}`],
    ['Agent 呼叫', String(t.agentCalls), `模型輪次 ${t.turns}`],
    ['估算花費', usd(t.costUsd), `今天 ${usd(t.costUsdToday)} · 只有 Claude 上報，按官方價格估算（訂閱登入時不是實際帳單）`],
    ['Token', tokens(totalTokens), `輸入 ${tokens(t.inputTokens)}（含快取）· 輸出 ${tokens(t.outputTokens)} · 快取讀取 ${tokens(t.cachedTokens)}`],
    ['上報 / 估算', `${tokens(t.reportedTokens)} / ${tokens(Math.max(0, totalTokens - t.reportedTokens))}`, 'provider 上報的 token 與估算值'],
    ['模型耗時', duration(t.durationMs)],
    ['評審輪次', String(t.reviewRounds)],
    ['失敗', String(t.failures), `測試失敗 ${t.testFailures}`],
    ['停滯 / 預算阻塞', `${t.stalls} / ${t.budgetBlocks}`],
  ];
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  return (
    <div className="usage-view">
      <QuotaCard />
      <div className="stat-grid">
        {cards.map(([label, value, hint]) => (
          <div key={label} className="card stat">
            <span>{label}</span>
            <b>{value}</b>
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>
      <section className="card">
        <h3>按 Agent</h3>
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>會話</th>
              <th>輪次</th>
              <th>輸入</th>
              <th>輸出</th>
              <th>快取</th>
              <th>估算花費</th>
              <th>耗時</th>
              <th>失敗</th>
              <th>測試失敗</th>
              <th>停滯</th>
            </tr>
          </thead>
          <tbody>
            {usage.byAgent.map((a) => (
              <tr key={a.agentId}>
                <td>{name(a.agentId)}</td>
                <td>{a.agentCalls}</td>
                <td>{a.turns}</td>
                <td>{tokens(a.inputTokens)}</td>
                <td>{tokens(a.outputTokens)}</td>
                <td>{tokens(a.cachedTokens)}</td>
                <td>{a.costUsd ? usd(a.costUsd) : '—'}</td>
                <td>{duration(a.durationMs)}</td>
                <td>{a.failures}</td>
                <td>{a.testFailures}</td>
                <td>{a.stalls}</td>
              </tr>
            ))}
            {!usage.byAgent.length && (
              <tr>
                <td colSpan={11} className="muted">暫無資料</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

type Quota = Awaited<ReturnType<typeof api.quota>>['agents'];

/** 方案額度（P1-7）：例如 Codex 訂閱的每週用量；快用完時以顏色提醒。 */
function QuotaCard() {
  const [quota, setQuota] = React.useState<Quota>();
  React.useEffect(() => {
    api.quota().then((r) => setQuota(r.agents), () => setQuota([]));
  }, []);
  if (!quota || quota.length === 0) return null;
  return (
    <section className="card quota">
      <h3>方案額度</h3>
      {quota.map((a) => (
        <div key={a.agentId} className="quota-agent">
          <b>{a.name}</b>
          {a.quota.plan && <span className="muted small"> 方案：{a.quota.plan}</span>}
          {a.quota.limitReached && <span className="iso-badge degraded"> 已用完</span>}
          {a.quota.windows.map((w) => (
            <div key={w.label} className="quota-row">
              <span className="quota-label">{w.label}</span>
              <span className="quota-bar">
                <span className={w.usedPercent >= 90 ? 'hot' : w.usedPercent >= 70 ? 'warm' : ''} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
              </span>
              <span className="quota-pct">{w.usedPercent}%</span>
              {w.resetsAt && <span className="muted small">{time(w.resetsAt)} 重置</span>}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
