import React from 'react';

/** AI 向你提的問題（P2-6；與服務端的 ApprovalQuestion 一致）。 */
export interface Question {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

/** 從審批資料裡取出問題（不是問題時返回 undefined）。 */
export function questionsOf(data: Record<string, unknown>): Question[] | undefined {
  if (data.kind !== 'question' || !Array.isArray(data.questions)) return undefined;
  return (data.questions as Array<Record<string, unknown>>).map((q, i) => ({
    id: String(q.id ?? `q${i}`),
    header: String(q.header ?? ''),
    question: String(q.question ?? ''),
    options: Array.isArray(q.options) ? (q.options as Array<{ label: string; description?: string }>) : [],
    multiSelect: q.multiSelect === true,
    allowOther: q.allowOther === true,
    secret: q.secret === true,
  }));
}

/**
 * 回答 AI 的問題（P2-6）：每題選一個（或多個）選項，也可以自己填寫；「跳過」表示不回答，AI 會自己判斷。
 * 回車不提交（避免誤觸），提交用按鈕。
 */
export function QuestionForm({ questions, busy, onSubmit }: { questions: Question[]; busy: boolean; onSubmit: (answers: Record<string, string[]>) => void }) {
  const [picked, setPicked] = React.useState<Record<string, string[]>>({});
  const [other, setOther] = React.useState<Record<string, string>>({});

  const toggle = (q: Question, label: string) =>
    setPicked((current) => {
      const list = current[q.id] ?? [];
      if (q.multiSelect) return { ...current, [q.id]: list.includes(label) ? list.filter((x) => x !== label) : [...list, label] };
      return { ...current, [q.id]: list[0] === label ? [] : [label] };
    });

  const answers = (): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const q of questions) {
      const list = [...(picked[q.id] ?? [])];
      const text = other[q.id]?.trim();
      if (text) list.push(text);
      if (list.length) out[q.id] = list;
    }
    return out;
  };
  const complete = questions.every((q) => (picked[q.id]?.length ?? 0) > 0 || !!other[q.id]?.trim());

  return (
    <div className="question-form">
      {questions.map((q) => (
        <fieldset key={q.id}>
          <legend>
            {q.header && <span className="q-header">{q.header}</span>} {q.question}
          </legend>
          {q.options.map((o) => {
            const on = (picked[q.id] ?? []).includes(o.label);
            return (
              <button key={o.label} type="button" className={`q-option ${on ? 'on' : ''}`} aria-pressed={on} disabled={busy} onClick={() => toggle(q, o.label)}>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </button>
            );
          })}
          {(q.allowOther || q.options.length === 0) && (
            <input
              type={q.secret ? 'password' : 'text'}
              placeholder={q.options.length ? '其他（自己填寫）' : '你的回答'}
              value={other[q.id] ?? ''}
              disabled={busy}
              onChange={(e) => setOther((current) => ({ ...current, [q.id]: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            />
          )}
        </fieldset>
      ))}
      <div className="buttons">
        <button className="primary small" disabled={busy || !complete} onClick={() => onSubmit(answers())}>
          {busy ? '提交中…' : '送出回答'}
        </button>
        <button className="small" disabled={busy} title="不回答，讓 AI 自己判斷" onClick={() => onSubmit({})}>
          跳過
        </button>
      </div>
    </div>
  );
}
