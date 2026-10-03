import React from 'react';

/**
 * 介面出錯時的兜底（P1-10）：某個元件渲染拋錯時不再整頁白屏，而是顯示中文說明和「重新載入」按鈕。
 * 服務端和 AI 的工作不受影響（介面只是事件的投影，重新載入後從服務端拉取最新狀態）。
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[acc] UI error', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <h2>介面出了點問題</h2>
        <p>AI 和任務不受影響，重新載入頁面就能看到最新狀態。</p>
        <pre>{this.state.error.message}</pre>
        <button className="primary" onClick={() => location.reload()}>
          重新載入
        </button>
      </div>
    );
  }
}
