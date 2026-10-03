import { stepLabel } from '../attention-ui';
import { STATUS_LABEL, STEP_LABEL, time } from '../format';
import type { TaskSummary } from '../types';

export function TaskList({ tasks, selected, onSelect }: { tasks: TaskSummary[]; selected?: string; onSelect: (taskId: string) => void }) {
  if (!tasks.length) return <p className="muted pad">還沒有任務。在上方建立第一個任務。</p>;
  return (
    <div className="task-list">
      {tasks.map((t) => (
        <button key={t.taskId} className={`task-item ${selected === t.taskId ? 'selected' : ''}`} onClick={() => onSelect(t.taskId)}>
          <div className="row between">
            <b>{t.title}</b>
            <span className={`status ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
          </div>
          <small>
            {t.workflowStep ? (STEP_LABEL[t.workflowStep] ?? t.workflowStep) : stepLabel(t.step)} · {t.currentAgentId ?? '-'} · {time(t.updatedAt)}
          </small>
          <div className="badges">
            {t.pendingApprovals > 0 && <span className="badge warn">待審批 {t.pendingApprovals}</span>}
            {t.pendingInputs > 0 && <span className="badge warn">等你決定</span>}
            {t.recovered && <span className="badge info">重啟後已恢復</span>}
            {t.blocker && <span className="badge bad" title={t.blocker}>阻塞</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
