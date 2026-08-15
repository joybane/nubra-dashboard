import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

// ─── lightweight-charts assertion shield ─────────────────────────────────────
//
// The charting library asserts internally with "Value is null" / "Value is undefined" when it
// is asked about a chart, pane or series that has already been removed. Those escape as
// unhandled errors a frame after the teardown that caused them, with nothing left to catch
// them, and Vite's dev overlay then covers the app over a chart that is already gone.
//
// This used to swallow *any* error whose message matched, from anywhere, and say nothing —
// which also hid genuine `x.y of null` bugs in application code, since React surfaces those
// with the same wording. Two changes: the frame must actually come from the charting library
// (application frames are left to fail loudly, as they should), and a suppressed error is
// still logged, so it shows up while debugging instead of vanishing.
//
// The real fix for the disposal race lives in `src/lib/chartLifecycle.ts`; this is the net
// under it, not a substitute for it.
if (typeof window !== 'undefined') {
  const isDisposalAssertion = (msg: string | undefined) =>
    !!msg && (msg.includes('Value is null') || msg.includes('Value is undefined'));

  const isFromChartingLib = (stack: string | undefined) =>
    !!stack && /lightweight-charts|\/charts-[A-Za-z0-9_-]+\.js/.test(stack);

  window.addEventListener(
    'error',
    (e) => {
      const err = e.error as Error | undefined;
      if (!isDisposalAssertion(e.message) && !isDisposalAssertion(err?.message)) return;
      if (!isFromChartingLib(err?.stack)) return; // an app bug — let it through
      console.warn('[charts] suppressed post-disposal assertion:', err?.message ?? e.message);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener(
    'unhandledrejection',
    (e) => {
      const reason = e.reason as Error | undefined;
      if (!isDisposalAssertion(reason?.message)) return;
      if (!isFromChartingLib(reason?.stack)) return;
      console.warn('[charts] suppressed post-disposal rejection:', reason?.message);
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

// Force high-DPI rendering for Canvas/Lightweight-Charts on 100% scale displays
if (typeof window !== 'undefined') {
  const originalDPR = window.devicePixelRatio || 1;
  if (originalDPR < 2) {
    Object.defineProperty(window, 'devicePixelRatio', {
      get: () => 2,
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
