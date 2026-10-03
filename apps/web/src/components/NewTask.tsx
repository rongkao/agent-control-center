import React from 'react';
import { api } from '../api';
import type { Agent, AppConfig, CreateTaskBody } from '../types';

/**
 * 新建：預設就是“直接對話”——寫一句話發給某個 agent 即開始。
 * 需要自動流程（實現 → 測試 → 失敗重試 / Codex 診斷 → 修復）時再展開選項。
 */
export function NewTask({ agents, config, onCreated, onError }: { agents: Agent[]; config?: AppConfig; onCreated: (taskId: string) => void; onError: (m: string) => void }) {
  const [prompt, setPrompt] = React.useState('');
  const [agentId, setAgentId] = React.useState('claude');
  const [auto, setAuto] = React.useState(false);
  const [testCommand, setTestCommand] = React.useState('');
  const [cwd, setCwd] = React.useState('');
  const [reviewGate, setReviewGate] = React.useState(false);
  const [worktree, setWorktree] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [autoHandoff, setAutoHandoff] = React.useState(false);
  // 多個 AI 各做一份（P2-11）
  const [compare, setCompare] = React.useState(false);

  const talkable = agents.filter((a) => a.kind !== 'test');
  const canWorktree = Boolean(cwd.trim()) || Boolean(config?.workspaceIsGit);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      if (compare) {
        const result = await api.createGroup({
          prompt: prompt.trim(),
          agentIds: talkable.filter((a) => a.ready).map((a) => a.id).slice(0, 4),
          workflow: auto ? 'implementation-v1' : 'manual',
          testCommand: auto ? testCommand.trim() || undefined : undefined,
          cwd: cwd.trim() || undefined,
        });
        setPrompt('');
        onCreated(result.tasks[0]!.id);
        return;
      }
      const both = agentId === '__both__';
      const body: CreateTaskBody = {
        prompt: prompt.trim(),
        agentId: both ? (talkable[0]?.id ?? 'claude') : agentId,
        askBoth: both && !auto ? true : undefined,
        handoffPolicy: autoHandoff ? 'auto' : 'ask',
        workflow: auto ? 'implementation-v1' : 'manual',
        testCommand: auto ? testCommand.trim() || undefined : undefined,
        reviewGate: auto ? reviewGate : undefined,
        cwd: cwd.trim() || undefined,
        worktree: worktree || undefined,
      };
      const task = await api.createTask(body);
      setPrompt('');
      onCreated(task.id);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card composer">
      <div className="row between">
        <h3>新對話</h3>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} title="先和誰說">
          {talkable.map((a) => (
            <option key={a.id} value={a.id}>對 {a.name} 說</option>
          ))}
          {talkable.length > 1 && <option value="__both__">同時問 {talkable.map((a) => a.name).join(' + ')}</option>}
        </select>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        placeholder="直接說你想做什麼，Enter 傳送（Shift+Enter 換行）"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <details className="options">
        <summary>更多選項（工作目錄 / 自動流程 / worktree）</summary>
        <label className="field">
          工作目錄
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={config?.workspace ?? '預設工作區'} />
        </label>
        <div className="checks">
          <label title="在倉庫內為此任務建立獨立 git 分支和目錄，互不幹擾">
            <input type="checkbox" checked={worktree} disabled={!canWorktree} onChange={(e) => setWorktree(e.target.checked)} />
            使用獨立 worktree
          </label>
          <label title="同一個要求交給每個可用的 AI，各自在獨立的 worktree 裡做一份；做完後在「改動」頁簽比較、選一份合入（花費是單份的幾倍）">
            <input type="checkbox" checked={compare} disabled={!canWorktree || talkable.filter((a) => a.ready).length < 2} onChange={(e) => setCompare(e.target.checked)} />
            多個 AI 各做一份，再選一份
          </label>
          <label title="AI 主動請求把工作交給另一個 AI 時自動放行（每個任務最多 4 次，超出後再問你）">
            <input type="checkbox" checked={autoHandoff} onChange={(e) => setAutoHandoff(e.target.checked)} />
            AI 互相交接不用問我
          </label>
          <label title="自動：實現 → 跑測試 → 失敗重試一次 → 仍失敗交 Codex 診斷 → 修復 → 再測試">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自動流程
          </label>
        </div>
        {auto && (
          <div className="form-grid">
            <label>
              測試命令
              <input value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="例如 npm test" />
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={reviewGate} onChange={(e) => setReviewGate(e.target.checked)} />
              完成前等我確認
            </label>
          </div>
        )}
      </details>
      <button className="primary" disabled={busy || !prompt.trim()} onClick={() => void submit()}>
        {busy ? '傳送中…' : auto ? '開始自動流程' : '傳送'}
      </button>
    </div>
  );
}
