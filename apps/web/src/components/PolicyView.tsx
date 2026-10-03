import React from 'react';
import { api } from '../api';
import { time } from '../format';

type Mode = 'ask' | 'rules' | 'unattended';
type Policy = Awaited<ReturnType<typeof api.policy>>;
type Isolation = Awaited<ReturnType<typeof api.isolation>>['agents'];

const MODES: Array<{ mode: Mode; title: string; text: string }> = [
  { mode: 'ask', title: '每次都問', text: '所有需要審批的操作都等你確認，規則暫時不生效。' },
  { mode: 'rules', title: '按規則', text: '符合「以後都允許」規則的操作自動放行，其餘等你確認。（預設）' },
  { mode: 'unattended', title: '無人值守', text: '除了高風險操作以外全部自動放行。適合你暫時離開、而且任務在獨立 worktree 裡的時候。' },
];

/**
 * 自動放行（P2-7）：自主度三檔、「以後都允許」的規則列表（可以撤銷）。
 * 高風險操作（刪除、強推、下載即執行、申請額外權限等）、交接和提問永遠交給你；連續自動放行達到上限後也會停下來問你一次。
 */
export function PolicyView({ onError }: { onError: (message: string) => void }) {
  const [policy, setPolicy] = React.useState<Policy>();
  const [isolation, setIsolation] = React.useState<Isolation>();
  const [settingUp, setSettingUp] = React.useState<string>();
  const load = React.useCallback(() => {
    api.policy().then(setPolicy, (e: Error) => onError(e.message));
    api.isolation().then((r) => setIsolation(r.agents), () => setIsolation([]));
  }, [onError]);
  const setup = (agentId: string) => {
    setSettingUp(agentId);
    api
      .setupIsolation(agentId)
      .then((r) => (r.ok ? load() : onError(r.message)), (e: Error) => onError(e.message))
      .finally(() => setSettingUp(undefined));
  };
  React.useEffect(load, [load]);

  if (!policy) return <section className="card">載入中…</section>;

  const setMode = (mode: Mode) => {
    api.setAutonomy(mode).then(load, (e: Error) => onError(e.message));
  };
  const remove = (id: string) => {
    if (!confirm('撤銷這條規則？之後同樣的操作會重新等你確認。')) return;
    api.deletePolicyRule(id).then(load, (e: Error) => onError(e.message));
  };

  return (
    <div className="policy-view">
      <section className="card">
        <h3>執行隔離</h3>
        {!isolation ? (
          <p className="muted">查詢中…</p>
        ) : isolation.length === 0 ? (
          <p className="muted">沒有需要檢查的 Agent。</p>
        ) : (
          <ul className="isolation-list">
            {isolation.map((a) => (
              <li key={a.agentId}>
                <span className={`iso-badge ${a.status.level}`}>{a.status.level === 'sandbox' ? '沙箱' : '未隔離'}</span> <b>{a.name}</b>
                <div className="muted small">{a.status.detail}</div>
                {a.status.setupHint && (
                  <div className="small">
                    開啟方式：<code>{a.status.setupHint}</code>
                  </div>
                )}
                {a.status.canSetup && (
                  <button className="small" disabled={settingUp === a.agentId} onClick={() => setup(a.agentId)}>
                    {settingUp === a.agentId ? '設定中…' : '設定沙箱'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h3>自主度</h3>
        <div className="mode-list" role="radiogroup" aria-label="自主度">
          {MODES.map((m) => (
            <button key={m.mode} role="radio" aria-checked={policy.mode === m.mode} className={`mode ${policy.mode === m.mode ? 'on' : ''}`} onClick={() => setMode(m.mode)}>
              <b>{m.title}</b>
              <small>{m.text}</small>
            </button>
          ))}
        </div>
        <p className="muted small">
          高風險的操作（刪除、強制推送、下載後直接執行、申請額外權限、涉及受保護路徑）、交接和提問永遠需要你確認；連續自動放行 {policy.maxConsecutive}{' '}
          次之後，也會停下來請你確認一次（你處理一次就重新計數）。
        </p>
      </section>
      <section className="card">
        <h3>「以後都允許」的規則</h3>
        {policy.rules.length === 0 ? (
          <p className="muted">還沒有規則。在審批卡片上按「以後都允許」就會加一條。</p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>工具</th>
                <th>範圍</th>
                <th>Agent</th>
                <th>建立時間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policy.rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <code>{r.toolName}</code>
                  </td>
                  <td>
                    {r.commandPrefix !== undefined ? (
                      <>
                        命令 <code>{r.commandPrefix}</code>（含後面加引數）
                      </>
                    ) : r.pathPrefix !== undefined ? (
                      <>
                        路徑 <code>{r.pathPrefix}</code> 之下
                      </>
                    ) : (
                      '不限'
                    )}
                  </td>
                  <td>{r.agentId ?? '全部'}</td>
                  <td>{time(r.createdAt)}</td>
                  <td>
                    <button className="danger small" onClick={() => remove(r.id)}>
                      撤銷
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
