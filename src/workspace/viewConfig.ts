import type { LayoutType, ViewType } from '../types';

/**
 * Single source of truth for pane view labels and workspace layout options.
 * Previously duplicated across Navbar and PaneShell — keep it here so the two
 * can never drift out of sync.
 */
export const VIEW_LABELS: Record<ViewType, string> = {
  chart: 'Chart',
  optionchain: 'Option Chain',
  straddle: 'Straddle',
  strategy: 'Strategy',
  basket: 'Basket',
  backtest: 'Backtest',
  nubrabacktest: 'Nubra BT',
  watchlist: 'Watchlist',
  tracker: 'Tracker',
};

export const VIEW_ORDER = Object.keys(VIEW_LABELS) as ViewType[];

export interface LayoutOption {
  id: LayoutType;
  label: string;
  short: string;
}

export const LAYOUT_OPTIONS: LayoutOption[] = [
  { id: 'single', label: 'Single Pane', short: 'Single' },
  { id: 'hsplit', label: 'Horizontal Split', short: 'H-Split' },
  { id: 'vsplit', label: 'Vertical Split', short: 'V-Split' },
  { id: 'grid', label: '2×2 Grid', short: 'Grid' },
  { id: 'tleft', label: 'T-Left Layout', short: 'T-Left' },
  { id: 'tright', label: 'T-Right Layout', short: 'T-Right' },
];
