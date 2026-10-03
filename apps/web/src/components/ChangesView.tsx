import React from 'react';
import { api } from '../api';
import { time } from '../format';
import type { TaskDetail } from '../types';
import { GroupCompare } from './GroupCompare';

interface DiffResult {
  files: Array<{ status: 'A' | 'M' | 'D'; path: string }>;
  patch: string;
  truncated: boolean;
  from: number;
  to?: number;
}

const STATUS_TEXT: Record<string, string> = { A: '新增', M: '修改', D: '刪除' };

/**
 * 改動審查（P2-3 / P2-4）：列出這個任務的檢查點（任務開始時 + 每一輪改過檔案之後），
 * 可以看每一輪改了什麼、任務到目前為止改了什麼，也可以撤銷最後一輪。
 */
export function ChangesView({ detail, onChanged, onError }: { detail: TaskDetail; onChanged: () => void; onError: (m: string) => void }) {
  const checkpoints = detail.run?.checkpoints ?? [];
  const [selected, setSelected] = React.useState<number | 'all'>('all');
  const [diff, setDiff] = React.useState<DiffResult>();
  const [loading, setLoading] = React.useState(false);
  const [undoing, setUndoing] = React.useState(false);
  const taskId = detail.task.id;
  const lastSeq = checkpoints.at(-1)?.seq;

  React.useEffect(() => {
    let cancelled = false;
    if (checkpoints.length === 0) return;
    setLoading(true);
    api
      .diff(taskId, selected === 'all' ? undefined : selected)
      .then((d) => !cancelled && setDiff(d))
      .catch((e: Error) => !cancelled && onError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // lastSeq：有新的檢查點（新的一輪或撤銷）時重新整理
  }, [taskId, selected, lastSeq, checkpoints.length, onError]);

  if (checkpoints.length === 0) {
    return (
      <section className="card">
        <h3>改動</h3>
        <p className="muted">這個任務沒有檢查點：工作目錄不是 git 倉庫（或者功能沒有開啟），所以沒辦法顯示和撤銷改動。</p>
      </section>
    );
  }

  // 從檢查點分叉（P2-3）：需要工作目錄是 git 倉庫；新任務出現在左邊的任務列表裡
  const fork = async (seq: number) => {
    const prompt = window.prompt('從這一輪結束時的狀態開一個新任務（在新的 worktree 裡，原任務不受影響）。\n請輸入新任務要做什麼：');
    if (!prompt?.trim()) return;
    try {
      await api.fork(taskId, seq, prompt.trim());
      onChanged();
      alert('已建立分叉任務，可以在左邊的任務列表裡開啟。');
    } catch (e) {
      onError((e as Error).message);
    }
  };

  const undo = async () => {
    if (!confirm('確定撤銷最後一輪嗎？這一輪改過的檔案會恢復到上一輪結束時的樣子（新增的檔案會被刪除）。之後如果你手動改過這些檔案，也會一起被恢復。')) return;
    setUndoing(true);
    try {
      await api.undo(taskId);
      setSelected('all');
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setUndoing(false);
    }
  };

  return (
    <>
      {detail.run?.group ? (
      <GroupCompare groupId={detail.run.group.id} currentTaskId={detail.task.id} onChanged={onChanged} onError={onError} />
    ) : (
      detail.run?.workspace?.kind === 'worktree' && <MergeGate detail={detail} onChanged={onChanged} onError={onError} />
    )}
      <div className="changes">
        <section className="card">
          <div className="row between">
            <h3>改動</h3>
            <button
              className="danger"
              disabled={undoing || checkpoints.length < 2}
              onClick={() => void undo()}
              title="把工作區恢復到上一輪結束時的樣子（記錄會保留，不會刪除歷史）"
            >
              {undoing ? '撤銷中…' : '↶ 撤銷最後一輪'}
            </button>
          </div>
          <div className="checkpoint-list">
            <button className={selected === 'all' ? 'on' : ''} onClick={() => setSelected('all')}>
              <b>到目前為止的全部改動</b>
              <small>相對任務開始時</small>
            </button>
            {[...checkpoints].reverse().map((c) =>
              c.seq === 0 ? (
                <div key={c.seq} className="checkpoint base">
                  <b>任務開始時</b>
                  <small>{time(c.at)}</small>
                </div>
              ) : (
                <div key={c.seq} className="checkpoint-row">
                  <button className={selected === c.seq ? 'on' : ''} onClick={() => setSelected(c.seq)}>
                    <b>{c.restoreOf !== undefined ? `↶ ${c.label}` : c.label}</b>
                    <small>
                      {c.files} 個檔案 · {time(c.at)}
                    </small>
                  </button>
                  <button className="link small fork" title="從這一輪結束時的狀態開一個新任務（在新的 worktree 裡），原任務不受影響" onClick={() => void fork(c.seq)}>
                    分叉
                  </button>
                </div>
              ),
            )}
          </div>
        </section>
        <section className="card">
          {loading && <p className="muted">載入中…</p>}
          {!loading && diff && (
            <>
              {diff.files.length === 0 ? (
                <p className="muted">沒有改動。</p>
              ) : (
                <ul className="diff-files">
                  {diff.files.map((f) => (
                    <li key={f.path}>
                      <span className={`diff-status s-${f.status}`}>{STATUS_TEXT[f.status] ?? f.status}</span> <code>{f.path}</code>
                    </li>
                  ))}
                </ul>
              )}
              {diff.patch && <DiffPatch patch={diff.patch} />}
              {diff.truncated && <p className="muted">改動太多，只顯示了前面一部分。</p>}
            </>
          )}
        </section>
      </div>
    </>
  );
}

type Preview = Awaited<ReturnType<typeof api.mergePreview>>;

/**
 * 合入閘門（P2-4）：獨立 worktree 的任務，改動不會自動進入主倉庫。
 * 先預覽（改動的檔案、衝突預檢、會執行的命令），再選擇 merge（保留提交）或 apply（只暫存，自己提交）；合入後可以刪除 worktree。
 */
function MergeGate({ detail, onChanged, onError }: { detail: TaskDetail; onChanged: () => void; onError: (m: string) => void }) {
  const ws = detail.run!.workspace!;
  const taskId = detail.task.id;
  const [preview, setPreview] = React.useState<Preview>();
  const [busy, setBusy] = React.useState(false);
  // 操作員確認掃描到的“金鑰”是誤報（P2-9）
  const [allowSecrets, setAllowSecrets] = React.useState(false);

  const load = React.useCallback(() => {
    api.mergePreview(taskId).then(setPreview, (e: Error) => onError(e.message));
  }, [taskId, onError]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setPreview(undefined);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (ws.cleanedAt) {
    return (
      <section className="card merge-gate">
        <h3>合入主倉庫</h3>
        <p className="muted">
          worktree 和分支 {ws.branch} 已經刪除。
          {ws.merged ? '改動在刪除之前已經合入。' : ''}
        </p>
      </section>
    );
  }

  return (
    <section className="card merge-gate">
      <div className="row between">
        <h3>合入主倉庫</h3>
        <span className="muted">
          分支 <code>{ws.branch}</code>
        </span>
      </div>
      {ws.merged ? (
        <>
          <p>
            ✓ 已經合入（
            {ws.merged.mode === 'merge' ? 'merge，保留提交' : 'apply，改動暫存在主倉庫，還需要你自己提交'}
            ）。
          </p>
          <button disabled={busy} onClick={() => confirm('刪除這個任務的 worktree 目錄和分支？') && void act(() => api.cleanupWorktree(taskId))}>
            刪除 worktree 和分支
          </button>
        </>
      ) : !preview ? (
        <>
          <p className="muted">這個任務在獨立的 worktree 裡工作，改動不會自動進入主倉庫。先預覽，確認後再合入。</p>
          <button disabled={busy} onClick={load}>
            預覽合入
          </button>
        </>
      ) : (
        <>
          <p>
            {preview.files.length} 個檔案要合入 <code>{preview.baseBranch}</code>。
          </p>
          {preview.conflicts.length > 0 && (
            <p className="merge-warn">⚠ 和主倉庫有衝突：{preview.conflicts.join('、')}。可以讓 AI 先在 worktree 裡合併主分支、解決衝突，再來合入。</p>
          )}
          {preview.secrets.length > 0 && (
            <div className="merge-warn">
              ⚠ 新增的內容裡有疑似金鑰，預設不合入。請讓 AI 改用環境變數或設定檔：
              <ul>
                {preview.secrets.slice(0, 10).map((f, i) => (
                  <li key={i}>
                    <code>
                      {f.path}:{f.line}
                    </code>{' '}
                    {f.name}（{f.preview}）
                  </li>
                ))}
              </ul>
              <label>
                <input type="checkbox" checked={allowSecrets} onChange={(e) => setAllowSecrets(e.target.checked)} />{' '}
                我確認這些是誤報，仍然合入（會記錄在事件裡）
              </label>
            </div>
          )}
          {preview.baseDirty && <p className="merge-warn">⚠ 主倉庫有還沒提交的改動，請先提交或 git stash，再合入。</p>}
          <details>
            <summary>會執行的命令</summary>
            <pre className="diff-patch">{preview.commands.merge.join('\n')}</pre>
          </details>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button
              className="primary"
              disabled={
                busy || preview.conflicts.length > 0 || preview.baseDirty || preview.files.length === 0 || (preview.secrets.length > 0 && !allowSecrets)
              }
              onClick={() => void act(() => api.merge(taskId, 'merge', allowSecrets))}
            >
              合入（merge，保留提交）
            </button>
            <button
              disabled={
                busy || preview.conflicts.length > 0 || preview.baseDirty || preview.files.length === 0 || (preview.secrets.length > 0 && !allowSecrets)
              }
              onClick={() => void act(() => api.merge(taskId, 'apply', allowSecrets))}
            >
              只套用改動（暫存，自己提交）
            </button>
            <button disabled={busy} onClick={load}>
              重新檢查
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function DiffPatch({ patch }: { patch: string }) {
  const lines = patch.split('\n');
  return (
    <pre className="diff-patch">
      {lines.map((line, i) => {
        const cls =
          line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')
            ? 'meta'
            : line.startsWith('@@')
              ? 'hunk'
              : line.startsWith('+')
                ? 'add'
                : line.startsWith('-')
                  ? 'del'
                  : '';
        return (
          <span key={i} className={cls}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}
