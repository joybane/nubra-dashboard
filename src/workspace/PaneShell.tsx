import type { Instrument, PaneState, ViewType } from '../types';
import CandleChart from '../CandleChart';
import OptionChain from '../OptionChain';
import StraddleChart from '../StraddleChart';
import StrategyChart from '../StrategyChart';
import BasketOrder from '../BasketOrder';
import Backtest from '../Backtest';
import NubraBacktest from '../NubraBacktest';
import Watchlist from '../Watchlist';
import Tracker from '../Tracker';

const VIEW_LABELS: Record<ViewType, string> = {
  chart:       'Chart',
  optionchain: 'Option Chain',
  straddle:    'Straddle',
  strategy:    'Strategy',
  basket:      'Basket',
  backtest:    'Backtest',
  nubrabacktest: 'Nubra BT',
  watchlist:   'Watchlist',
  tracker:     'Tracker',
};

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
      className={`flex flex-col h-full overflow-hidden transition-all ${
        isActive ? 'outline outline-1 outline-[var(--accent)] outline-offset-[-1px]' : ''
      }`}
    >


      {/* Content area */}
      <div className="flex-1 overflow-hidden min-h-0">
        {viewEl}
      </div>
    </div>
  );
}
