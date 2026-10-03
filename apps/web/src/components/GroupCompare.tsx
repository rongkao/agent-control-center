import React from 'react';
import { api } from '../api';
import { STATUS_LABEL, usd } from '../format';
import type { TaskStatus } from '../types';

type Group = Awaited<ReturnType<typeof api.group>>;

/**
 * 多個實現擇一（P2-11）：同一個要求由幾個 AI 各做一份。這裡並排比較（狀態、測試、評審、改動大小、花費），
 * 給出按確定性規則推薦的一個；選定後合入它，其餘的放棄並刪除 worktree。
 */
export function GroupCompare({ groupId, currentTaskId, onChanged, onError }: { groupId: string; currentTaskId: string; onChanged: () => void; onError: (m: string) => void }) {
  const [group, setGroup] = React.useState<Group>();
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(() => {
    api.group(groupId).then(setGroup, (e: Error) => onError(e.message));
  }, [groupId, onError]);
  React.useEffect(load, [load]);

  if (!group) return <section className="card">載入比較中…</section>;
  const done = group.candidates.some((c) => c.merged);
  const pick = async (taskId: string, mode: 'merge' | 'apply') => {
    if (!confirm(`選第 ${group.candidates.find((c) => c.taskId === taskId)!.index + 1} 份合入主倉庫？其餘的會被放棄、worktree 會被刪除。`)) return;
    setBusy(true);
    try {
      await api.pickInGroup(groupId, taskId, mode);
      load();
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card group-compare">
      <div className="row between">
        <h3>比較 {group.candidates.length} 份實現</h3>
        <button className="small" onClick={load}>
          重新整理
        </button>
      </div>
      <table className="rules">
        <thead>
          <tr>
            <th>#</th>
            <th>AI</th>
            <th>狀態</th>
            <th>測試</th>
            <th>評審</th>
            <th>改動</th>
            <th>花費</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {group.candidates.map((c) => (
            <tr key={c.taskId} className={c.taskId === currentTaskId ? 'current' : ''}>
              <td>
                {c.index + 1}
                {group.recommended === c.taskId && !done && <span className="iso-badge sandbox"> 推薦</span>}
              </td>
              <td>{c.agentId ?? '—'}</td>
              <td>{c.merged ? '已合入' : c.cleaned ? '已放棄' : (STATUS_LABEL[c.status as TaskStatus] ?? c.status)}</td>
              <td>{c.testsPassed === undefined ? '—' : c.testsPassed ? '✓ 通過' : '✗ 失敗'}</td>
              <td>{c.verdict ?? '—'}</td>
              <td>
                {c.files} 個檔案 <span className="muted small">+{c.insertions} −{c.deletions}</span>
              </td>
              <td>{usd(c.costUsd)}</td>
              <td>
                {!done && !c.cleaned && (
                  <button className="primary small" disabled={busy || group.candidates.some((x) => x.busy) || c.files === 0} onClick={() => void pick(c.taskId, 'merge')}>
                    選這份
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        推薦規則：測試通過 &gt; 評審接受 &gt; 已完成 &gt; 改動少 &gt; 花費少。{group.candidates.some((x) => x.busy) ? '還有 AI 在工作，做完後才能選。' : ''}
        各份的詳細改動可以開啟對應任務的「改動」頁簽檢視。
      </p>
    </section>
  );
}
