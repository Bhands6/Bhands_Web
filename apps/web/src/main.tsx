import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/desktop.css';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA：仅生产环境注册 Service Worker（开发时避免缓存干扰 HMR）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW 注册失败不影响正常使用
    });
  });
}
