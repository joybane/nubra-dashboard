import type { Instrument, PaneState, ViewType } from '../types';
import CandleChart from '../CandleChart';
import OptionChain from '../OptionChain';
import StraddleChart from '../StraddleChart';
import StrategyChart from '../StrategyChart';
import BasketOrder from '../BasketOrder';
import Backtest from '../Backtest';

const VIEW_LABELS: Record<ViewType, string> = {
  chart:       'Chart',
  optionchain: 'Option Chain',
  straddle:    'Straddle',
  strategy:    'Strategy',
  basket:      'Basket',
  backtest:    'Backtest',
};

interface PaneShellProps {
  pane:             PaneState;
  theme:            'dark' | 'light';
  isActive:         boolean;
  onActivate:       () => void;
  onViewChange:     (view: ViewType) => void;
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
        return <OptionChain instrument={pane.instrument} onNavigateToChart={onNavigateToChart} />;
      case 'straddle':
        return <StraddleChart instrument={pane.instrument} />;
      case 'strategy':
        return <StrategyChart instrument={pane.instrument} />;
      case 'basket':
        return <BasketOrder instrument={pane.instrument} />;
      case 'backtest':
        return <Backtest instrument={pane.instrument} />;
    }
  })();

  return (
    <div
      className={`flex flex-col h-full overflow-hidden transition-all ${
        isActive ? 'outline outline-1 outline-[var(--accent)] outline-offset-[-1px]' : ''
      }`}
    >
      {/* Pane header — view selector tabs */}
      <div
        onClick={onActivate}
        className="h-7 shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-1 gap-0.5 cursor-default"
      >
        {(Object.keys(VIEW_LABELS) as ViewType[]).map((v) => (
          <button
            key={v}
            onClick={(e) => { e.stopPropagation(); onActivate(); onViewChange(v); }}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-all ${
              pane.view === v
                ? 'bg-[var(--accent)] text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
        {isActive && (
          <span className="ml-auto text-[9px] text-[var(--accent)] pr-1">active</span>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden min-h-0">
        {viewEl}
      </div>
    </div>
  );
}
