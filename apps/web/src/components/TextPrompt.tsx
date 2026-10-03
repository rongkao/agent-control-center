import React from 'react';
import { createRoot } from 'react-dom/client';

/**
 * 頁面內的文字輸入對話方塊，取代 window.prompt()：桌面版（Electron）不支援 prompt()，呼叫了也不會彈出。
 * askText 回傳輸入的文字；按「取消」、Esc 或點背景時回傳 null。
 */
export function askText(options: { title: string; message?: string; placeholder?: string; initial?: string; confirmLabel?: string; required?: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const done = (value: string | null) => {
      root.unmount();
      host.remove();
      previous?.focus();
      resolve(value);
    };
    root.render(<TextPromptDialog {...options} onDone={done} />);
  });
}

function TextPromptDialog({
  title,
  message,
  placeholder,
  initial = '',
  confirmLabel = '確定',
  required = false,
  onDone,
}: {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  confirmLabel?: string;
  required?: boolean;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = React.useState(initial);
  const input = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => input.current?.focus(), []);
  const disabled = required && !value.trim();
  return (
    <div className="modal-backdrop" onClick={() => onDone(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {message && <p className="lead" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
        <textarea
          ref={input}
          rows={3}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onDone(null);
            // Ctrl+Enter 確定（Enter 換行，避免誤送）
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !disabled) onDone(value);
          }}
          style={{ width: '100%', boxSizing: 'border-box' }}
        />
        <div className="actions end">
          <button onClick={() => onDone(null)}>取消</button>
          <button className="primary" disabled={disabled} onClick={() => onDone(value)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
