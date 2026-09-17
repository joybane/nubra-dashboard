import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import UiIcon from '../components/UiIcon';
import type { Instrument, PaneState, Theme, ViewType } from '../types';
import ErrorBoundary from '../components/ErrorBoundary';
import { VIEW_LABELS } from './viewConfig';

// Each view is code-split: the initial bundle only ships the shell, and a pane's
// view module is fetched the first time that view is shown (then cached). This
// keeps first paint fast even though the views total ~450 KB of source.
const CandleChart = lazy(() => import('../CandleChart'));
const OptionChain = lazy(() => import('../OptionChain'));
const BasketOrder = lazy(() => import('../BasketOrder'));
const Backtest = lazy(() => import('../Backtest'));
const NubraBacktest = lazy(() => import('../NubraBacktest'));
const Watchlist = lazy(() => import('../Watchlist'));
const Tracker = lazy(() => import('../Tracker'));
const Analysis = lazy(() => import('../Analysis'));

function PaneLoading() {
  return (
    <div className="pane-loading" role="status" aria-label="Loading view">
      <div className="pane-loading-header"><div className="skeleton h-7 w-32" /><div className="skeleton h-7 w-20" /><div className="skeleton h-7 w-20" /></div>
      <div className="pane-loading-grid"><span>Preparing your workspace…</span></div>
    </div>
  );
}

interface PaneShellProps {
  pane: PaneState;
  theme: Theme;
  isActive: boolean;
  onActivate: () => void;
  onViewChange: (view: ViewType) => void;
  onNavigateToChart?: (inst: Instrument) => void;
}

export default function PaneShell({
  pane,
  theme,
  isActive,
  onActivate,
  onViewChange,
  onNavigateToChart,
}: PaneShellProps) {
  const [maximized, setMaximized] = useState(false);
  const focusButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!maximized) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"], [role="menu"]')) {
        setMaximized(false);
        focusButton.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [maximized]);
  const viewEl = (() => {
    switch (pane.view) {
      case 'chart':
        return <CandleChart instrument={pane.instrument} theme={theme} />;
      case 'optionchain':
        return (
          <OptionChain
            instrument={pane.instrument}
            onNavigateToChart={onNavigateToChart}
            onChangeView={onViewChange}
          />
        );
      case 'basket':
        return <BasketOrder instrument={pane.instrument} />;
      case 'backtest':
        return <Backtest instrument={pane.instrument} />;
      case 'nubrabacktest':
        return <NubraBacktest instrument={pane.instrument} theme={theme} />;
      case 'watchlist':
        return <Watchlist onNavigateToChart={onNavigateToChart} />;
      case 'tracker':
        return <Tracker instrument={pane.instrument} theme={theme} />;
      case 'analysis':
        return <Analysis theme={theme} onChangeView={onViewChange} />;
    }
  })();

  return (
    <div
      onMouseDown={onActivate}
      onFocusCapture={onActivate}
      className={`pane-surface flex flex-col h-full overflow-hidden ${isActive ? 'is-active' : ''} ${maximized ? 'is-maximized' : ''}`}
    >
      {/* Content area */}
      <div className="flex-1 overflow-hidden min-h-0">
        <ErrorBoundary label={VIEW_LABELS[pane.view]}>
          <Suspense fallback={<PaneLoading />}>{viewEl}</Suspense>
        </ErrorBoundary>
      </div>
      {pane.view !== 'optionchain' && <button ref={focusButton} className="shell-icon-button pane-focus-button" aria-label={maximized ? 'Restore pane' : 'Maximize pane'} aria-expanded={maximized} title={maximized ? 'Restore pane (Esc)' : 'Maximize pane'} onClick={() => setMaximized((v) => !v)}><UiIcon name={maximized ? 'restore' : 'expand'} size={16} /></button>}
    </div>
  );
}
