import { lazy, Suspense } from 'react';
import type { Instrument, PaneState, ViewType } from '../types';
import ErrorBoundary from '../components/ErrorBoundary';
import { VIEW_LABELS } from './viewConfig';

// Each view is code-split: the initial bundle only ships the shell, and a pane's
// view module is fetched the first time that view is shown (then cached). This
// keeps first paint fast even though the views total ~450 KB of source.
const CandleChart = lazy(() => import('../CandleChart'));
const OptionChain = lazy(() => import('../OptionChain'));
const StraddleChart = lazy(() => import('../StraddleChart'));
const StrategyChart = lazy(() => import('../StrategyChart'));
const BasketOrder = lazy(() => import('../BasketOrder'));
const Backtest = lazy(() => import('../Backtest'));
const NubraBacktest = lazy(() => import('../NubraBacktest'));
const Watchlist = lazy(() => import('../Watchlist'));
const Tracker = lazy(() => import('../Tracker'));

function PaneLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="spinner" />
    </div>
  );
}

interface PaneShellProps {
  pane:               PaneState;
  theme:              'dark' | 'light';
  isActive:           boolean;
  onActivate:         () => void;
  onViewChange:       (view: ViewType) => void;
  onNavigateToChart?: (inst: Instrument) => void;
}

export default function PaneShell({
  pane, theme, isActive, onActivate, onViewChange, onNavigateToChart,
}: PaneShellProps) {

  const viewEl = (() => {
    switch (pane.view) {
      case 'chart':
        return <CandleChart instrument={pane.instrument} theme={theme} />;
      case 'optionchain':
        return <OptionChain instrument={pane.instrument} onNavigateToChart={onNavigateToChart} onChangeView={onViewChange} />;
      case 'straddle':
        return <StraddleChart instrument={pane.instrument} />;
      case 'strategy':
        return <StrategyChart instrument={pane.instrument} />;
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
    }
  })();

  return (
    <div
      onMouseDown={onActivate}
      className={`flex flex-col h-full overflow-hidden transition-all ${
        isActive ? 'outline outline-1 outline-[var(--accent)] outline-offset-[-1px]' : ''
      }`}
    >


      {/* Content area */}
      <div className="flex-1 overflow-hidden min-h-0">
        <ErrorBoundary label={VIEW_LABELS[pane.view]}>
          <Suspense fallback={<PaneLoading />}>
            {viewEl}
          </Suspense>
        </ErrorBoundary>
      </div>
    </div>
  );
}
