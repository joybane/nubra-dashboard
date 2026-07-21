import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

if (typeof window !== 'undefined') {
  const isNullError = (msg: string | undefined) => msg?.includes('Value is null') || msg?.includes('Value is undefined');
  window.addEventListener('error', (e) => {
    if (isNullError(e.message) || isNullError(e.error?.message)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return true;
    }
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    if (isNullError(e.reason?.message)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

// Force high-DPI rendering for Canvas/Lightweight-Charts on 100% scale displays
if (typeof window !== 'undefined') {
  const originalDPR = window.devicePixelRatio || 1;
  if (originalDPR < 2) {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => 2
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
