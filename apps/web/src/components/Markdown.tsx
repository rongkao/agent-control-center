import React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * AI 回覆的 Markdown 渲染（P1-15 / M-26）：標題、列表、表格、程式碼塊（帶「複製」按鈕）。
 *
 * 安全：react-markdown 預設不渲染原始 HTML；圖片不自動載入（外鏈圖片可以被用來把資訊帶出去），只顯示成連結；
 * 連結一律在新視窗開啟，且不帶 Referer（訪問連結裡帶登入令牌，不能洩露）。
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">
      [圖片] {alt || (typeof src === 'string' ? src : '')}
    </a>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    const text = ref.current?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪貼簿不可用（例如非安全上下文）：靜默失敗
    }
  };
  return (
    <div className="md-code">
      <button className="md-copy" onClick={() => void copy()} title="複製程式碼">
        {copied ? '已複製' : '複製'}
      </button>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}
