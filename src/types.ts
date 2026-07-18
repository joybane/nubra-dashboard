// ─── Instrument ───────────────────────────────────────────────────────────────
export interface Instrument {
  ref_id?:          number;
  stock_name?:      string;
  nubra_name?:      string;
  zanskar_name?:    string;
  display_name?:    string;
  asset?:           string;
  symbol?:          string;
  exchange?:        string;
  derivative_type?: string;
  asset_type?:      string;
  option_type?:     string;
  expiry?:          string | number;
  strike_price?:    number;
  lot_size?:        number;
}

export type InstrumentType = 'INDEX' | 'STOCK' | 'FUT' | 'OPT' | 'ETF';

export function getInstrumentType(item: Instrument): InstrumentType {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type      || '').toUpperCase();
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (at === 'ETF') return 'ETF';
  return 'STOCK';
}

export function getSymbol(item: Instrument): string {
  return item.nubra_name || item.stock_name || item.asset || item.zanskar_name || item.symbol || '';
}

// ─── Chart / OHLCV ───────────────────────────────────────────────────────────
export interface OhlcBar {
  time:  number | { year: number; month: number; day: number };
  open:  number;
  high:  number;
  low:   number;
  close: number;
}

export interface VolBar {
  time:  number | { year: number; month: number; day: number };
  value: number;
  color: string;
}

// ─── Option chain ─────────────────────────────────────────────────────────────
export interface OptionLeg {
  sp:       number;   // strike in rupees
  ltp?:     number;   // last traded price (paise)
  ltpchg?:  number;
  iv?:      number;
  delta?:   number;
  gamma?:   number;
  theta?:   number;
  vega?:    number;
  oi?:      number;
  volume?:  number;
  prev_oi?: number;
}

export interface OptionChainData {
  ce:           OptionLeg[];
  pe:           OptionLeg[];
  atm?:         number;
  cp?:          number;
  currentprice?: number;
  all_expiries?: string[];
  asset?:       string;
  expiry?:      string;
  exchange?:    string;
}

// ─── WebSocket messages ───────────────────────────────────────────────────────
export interface WsOhlcvMsg  { type: 'ohlcv';        data: OhlcvData }
export interface WsTickMsg   { type: 'index_tick';   data: IndexTickData }
export interface WsOcMsg     { type: 'option_chain'; data: OptionChainData }
export interface WsStatusMsg { type: 'ws_status';    connected: boolean }
export interface WsAuthMsg   { type: 'auth_status';  status: string }
export interface WsPosLtpMsg { type: 'position_ltp'; data: { ref_id: number; ltp: number }[] }

export type WsMessage = WsOhlcvMsg | WsTickMsg | WsOcMsg | WsStatusMsg | WsAuthMsg | WsPosLtpMsg;

export interface OhlcvData {
  indexes?:     OhlcvBucket[];
  instruments?: OhlcvBucket[];
}

export interface OhlcvBucket {
  indexname?:        string;
  timestamp?:        string;
  open?:             string;
  high?:             string;
  low?:              string;
  close?:            string;
  bucket_timestamp?: string;
  cumulative_volume?:string;
}

export interface IndexTickData {
  indexes?:     IndexTick[];
  instruments?: IndexTick[];
}

export interface IndexTick {
  indexname?:     string;
  index_value?:   string;
  changepercent?: number;
  prev_close?:    string;
  volume?:        string;
}

// ─── Strategy / Basket ────────────────────────────────────────────────────────
export type OptionSide = 'CE' | 'PE';
export type OrderSide  = 'BUY' | 'SELL';

export interface BasketLeg {
  id:         string;
  instrument: Instrument | null;
  side:       OrderSide;
  optionType: OptionSide;
  strike:     number | null;
  expiry:     string;
  qty:        number;
  ltp?:       number;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────
export type StrategyType = 'straddle' | 'strangle' | 'iron_condor' | 'bull_call_spread' | 'bear_put_spread';

export interface BacktestParams {
  underlying:   string;
  exchange:     string;
  strategy:     StrategyType;
  startDate:    string;
  endDate:      string;
  entryTime:    string;
  exitTime:     string;
  strikeDist:   number;
  stopLossPct:  number;
  targetPct:    number;
}

export interface BacktestResult {
  date:       string;
  pnl:        number;
  entryPremium: number;
  exitPremium:  number;
  outcome:    'tp' | 'sl' | 'expiry';
}

// ─── Workspace ────────────────────────────────────────────────────────────────
export type ViewType = 'chart' | 'optionchain' | 'straddle' | 'strategy' | 'basket' | 'backtest' | 'nubrabacktest' | 'watchlist' | 'tracker';

export type LayoutType = 'single' | 'hsplit' | 'vsplit' | 'grid' | 'tleft' | 'tright';

export interface PaneState {
  id:         string;
  view:       ViewType;
  instrument: Instrument | null;
}

export interface WorkspaceState {
  layout: LayoutType;
  panes:  PaneState[];
  activePane: string;
}

// ─── Watchlist ────────────────────────────────────────────────────────────────
export interface WatchlistItem {
  id:           string;
  displayName:  string;
  underlying:   string;
  exchange:     string;
  ref_id?:      number;
  nubraName?:   string;
  optionType?:  'CE' | 'PE';
  strike?:      number;
  expiry?:      string;
  ltpAtAdd:     number;
}

// ─── Theme ───────────────────────────────────────────────────────────────────
export type Theme = 'dark' | 'light';

// ─── Paper Trading ────────────────────────────────────────────────────────────
export type PaperOrderType     = 'ORDER_TYPE_MARKET' | 'ORDER_TYPE_REGULAR' | 'ORDER_TYPE_STOPLOSS' | 'ORDER_TYPE_ICEBERG';
export type PaperOrderSide     = 'ORDER_SIDE_BUY' | 'ORDER_SIDE_SELL';
export type PaperDeliveryType  = 'ORDER_DELIVERY_TYPE_CNC' | 'ORDER_DELIVERY_TYPE_IDAY';
export type PaperOrderStatus   =
  | 'ORDER_STATUS_PENDING'
  | 'ORDER_STATUS_OPEN'
  | 'ORDER_STATUS_FILLED'
  | 'ORDER_STATUS_CANCELLED'
  | 'ORDER_STATUS_REJECTED';

export interface PaperRefData {
  ref_id?:          number;
  stock_name?:      string;
  zanskar_name?:    string;
  option_type?:     string;
  derivative_type?: string;
  exchange?:        string;
  lot_size?:        number;
  strike_price?:    number;
  expiry?:          string;
}

export interface PaperOrder {
  order_id:           number;
  ref_id:             number;
  basket_id?:         number;
  order_type:         PaperOrderType;
  order_side:         PaperOrderSide;
  order_price:        number;
  trigger_price?:     number;
  order_qty:          number;
  filled_qty:         number;
  avg_filled_price:   number;
  order_status:       PaperOrderStatus;
  order_time:         number;
  filled_time?:       number | null;
  last_modified?:     number | null;
  order_delivery_type: PaperDeliveryType;
  validity_type?:     string;
  display_name?:      string;
  LTP?:               number | null;
  tag?:               string;
  ref_data?:          PaperRefData;
  basket_group_id?:   string;
  strategy_name?:     string;
}

export interface PaperPosition {
  ref_id:             number;
  display_name?:      string;
  zanskar_name?:      string;
  order_side?:        string;
  qty:                number;
  avg_price:          number;
  last_traded_price:  number;
  pnl:                number;
  pnl_chg?:           number;
  unrealised_pnl?:    number;
  realised_pnl?:      number;
  product?:           string;
  derivative_type?:   string;
  option_type?:       string;
  strike_price?:      number;
  expiry?:            string;
  basket_group_id?:   string;
  strategy_name?:     string;
  entry_time?:        number;
  exit_time?:         number;
  exit_price?:        number;
  margin_required?:   number;
  lot_size?:          number;
}

export interface PaperHolding {
  ref_id:             number;
  display_name?:      string;
  nubra_name?:        string;
  symbol?:            string;
  quantity:           number;
  avg_price:          number;
  last_traded_price:  number;
  net_pnl:            number;
  net_pnl_chg?:       number;
  day_pnl?:           number;
  invested_value?:    number;
  current_value?:     number;
}
