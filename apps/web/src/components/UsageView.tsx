import { duration, tokens, usd } from '../format';
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
