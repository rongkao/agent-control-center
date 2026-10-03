import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { completeLinkLogin } from './api';
import './styles.css';

// 先完成“帶令牌連結”的登入（開發模式下由前端換 Cookie），再渲染介面，避免第一批請求被拒
void completeLinkLogin().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
});
