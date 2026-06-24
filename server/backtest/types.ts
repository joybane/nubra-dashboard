// ─────────────────────────────────────────────────────────────────────────────
// Backtest engine — shared schema types (server side).
// The frontend mirrors this shape in src/backtest/types.ts.
//
// MVP NOTE: the full competitor/Stoxxo feature set is represented here, but only
// a subset is *executed* by the engine in this phase. Fields marked "reserved"
// are validated/accepted but ignored until a later phase. The schema does not
// change between phases — reserved fields simply start being honoured.
// ─────────────────────────────────────────────────────────────────────────────

export type Underlying = 'NIFTY' | 'SENSEX';
export type ExpiryFlag = 'WEEK' | 'MONTH';
export type OptionType = 'CALL' | 'PUT';
export type Side       = 'BUY' | 'SELL';

// ── Strike selection ─────────────────────────────────────────────────────────
// Implemented: ATM, CLOSEST_PREMIUM, POINTS_FROM_SPOT, PERCENT_FROM_SPOT,
//              FIXED_STRIKE, DELTA (Phase 4, Black-Scholes delta from IV).
export type StrikeMethod =
  | 'ATM'
  | 'CLOSEST_PREMIUM'
  | 'POINTS_FROM_SPOT'
  | 'PERCENT_FROM_SPOT'
  | 'FIXED_STRIKE'
  | 'DELTA';

export interface StrikeSelection {
  method:          StrikeMethod;
  atmOffset?:      number;  // ATM: ± strike steps (e.g. +2 = 2 strikes OTM/ITM by sign)
  premiumTarget?:  number;  // CLOSEST_PREMIUM: pick strike whose entry premium ≈ this
  pointsFromSpot?: number;  // POINTS_FROM_SPOT: signed offset in index points
  percentFromSpot?:number;  // PERCENT_FROM_SPOT: signed % of spot
  absoluteStrike?: number;  // FIXED_STRIKE
  targetDelta?:    number;  // DELTA: pick strike whose |delta| ≈ this (0–1, e.g. 0.25)
}

// ── Stop-loss / target ───────────────────────────────────────────────────────
// Implemented: NONE, PREMIUM_PERCENT, PREMIUM_ABSOLUTE, UNDERLYING_POINTS,
//              UNDERLYING_PERCENT, DELTA (Phase 4 — exit when |delta| crosses value).
// For a STOP, DELTA fires when |delta| ≥ value (option moving ITM / gaining
// directional risk). For a TARGET, DELTA fires when |delta| ≤ value (decayed OTM).
export type SLTargetType =
  | 'NONE'
  | 'PREMIUM_PERCENT'
  | 'PREMIUM_ABSOLUTE'
  | 'UNDERLYING_POINTS'
  | 'UNDERLYING_PERCENT'
  | 'DELTA';

export interface SLTarget {
  type:   SLTargetType;
  value?: number;
}

// ── Trailing stop (Phase 2) ──────────────────────────────────────────────────
// All thresholds are in PREMIUM POINTS measured in the favourable direction
// (premium falling for a SELL, rising for a BUY). The stop only ever tightens.
//   LOCK            once favourable move ≥ trigger, lock `lock` pts of profit.
//   TRAIL           once favourable move ≥ trigger, for every `step` further pts
//                   favourable, move the stop by `trail` pts.
//   LOCK_AND_TRAIL  lock at trigger, then trail beyond it.
//   TO_COST         once favourable move ≥ trigger, move the stop to entry (B/E).
export type TrailType = 'NONE' | 'LOCK' | 'TRAIL' | 'LOCK_AND_TRAIL' | 'TO_COST';

export interface TrailStop {
  type:     TrailType;
  trigger?: number;  // favourable premium move (pts) that activates the trail
  lock?:    number;  // LOCK / LOCK_AND_TRAIL: profit (pts) to lock
  step?:    number;  // TRAIL: favourable move increment (pts)
  trail?:   number;  // TRAIL: stop movement per step (pts)
}

// ── Re-entry (Phase 2) ───────────────────────────────────────────────────────
//   ASAP          re-enter the same leg at the next bar after exit.
//   COST          re-enter when premium returns to the original entry price.
//   REVERSE_ASAP  re-enter at the next bar but with the side flipped.
export type ReentryMode = 'NONE' | 'ASAP' | 'COST' | 'REVERSE_ASAP';

export interface Reentry {
  mode:        ReentryMode;
  max?:        number;   // max re-entries per leg per day (default 0)
  onStopLoss?: boolean;  // re-enter after a stop-loss exit (default true)
  onTarget?:   boolean;  // re-enter after a target exit (default false)
}

export interface ExpirySelection {
  flag:   ExpiryFlag;  // WEEK | MONTH
  offset: number;      // 0 = nearest expiry ≥ trade date, 1 = next, ...
}

export interface Leg {
  id:         string;
  enabled:    boolean;
  optionType: OptionType;
  side:       Side;
  lots:       number;
  expiry:     ExpirySelection;
  strike:     StrikeSelection;
  stopLoss:   SLTarget;
  target:     SLTarget;
  trail?:     TrailStop;  // Phase 2 — optional, default NONE
  reentry?:   Reentry;    // Phase 2 — optional, default NONE
}

// ── Entry filters (Phase 2) ──────────────────────────────────────────────────
// Day-level gates evaluated at entry. A day failing any active filter is skipped.
export interface EntryFilters {
  dteMin?:       number;  // reference expiry days-to-expiry ≥ this
  dteMax?:       number;  // reference expiry days-to-expiry ≤ this
  ivMin?:        number;  // reference contract IV at entry ≥ this
  ivMax?:        number;  // reference contract IV at entry ≤ this
  premiumMin?:   number;  // combined per-unit entry premium of all legs ≥ this
  premiumMax?:   number;  // combined per-unit entry premium of all legs ≤ this
  waitTradePct?: number;  // delay entry until reference premium moves this % from entryTime
}

export interface PortfolioRisk {
  maxProfit?: number;  // absolute ₹ on combined MTM → square off all (0/undef = off)
  maxLoss?:   number;  // absolute ₹ loss (positive number) → square off all
}

// ── Position sizing (Phase 4) ────────────────────────────────────────────────
// Scales each leg's lots dynamically per day. FIXED keeps leg.lots as-is.
//   CAPITAL_PERCENT   risk `riskPct` of `capital` per day; lots derived from the
//                     combined entry premium × lotSize (premium-at-risk proxy).
//   VOLATILITY_TARGET target a fixed daily ₹ vol; lots scale inversely with the
//                     reference contract IV at entry vs `baselineIv`.
//   MARTINGALE        multiply base lots by `factor` for each consecutive losing
//                     day (reset on a win), capped at `maxLots`.
export type SizingMode = 'FIXED' | 'CAPITAL_PERCENT' | 'VOLATILITY_TARGET' | 'MARTINGALE';

export interface PositionSizing {
  mode:        SizingMode;
  capital?:    number;   // CAPITAL_PERCENT: account capital ₹
  riskPct?:    number;   // CAPITAL_PERCENT: % of capital to deploy per day
  baselineIv?: number;   // VOLATILITY_TARGET: IV at which lots = base
  factor?:     number;   // MARTINGALE: lot multiplier per consecutive loss
  maxLots?:    number;   // MARTINGALE/CAPITAL: hard cap on total lots multiple
}

// ── Position adjustment (Phase 5) ────────────────────────────────────────────
// When a leg (or the portfolio) hits SL/target, optionally exit ALL open legs
// and enter a fresh set of replacement legs. This models real-world adjustments
// like shifting strikes, rolling, or switching to a hedge strategy.
//
// Trigger:
//   ON_ANY_LEG_SL   any single leg's stop-loss fires
//   ON_ANY_LEG_TGT  any single leg's target fires
//   ON_PORTFOLIO_SL  portfolio-level maxLoss fires
//   ON_PORTFOLIO_TP  portfolio-level maxProfit fires
//
// Action: close all open legs immediately, then open `replacementLegs` at the
// next bar. The replacement legs use the CURRENT spot (at adjustment time) for
// strike selection, not the original entry spot.
//
// `maxAdjustments` caps how many times this can fire per day (default 1).
export type AdjustmentTrigger =
  | 'ON_ANY_LEG_SL'
  | 'ON_ANY_LEG_TGT'
  | 'ON_PORTFOLIO_SL'
  | 'ON_PORTFOLIO_TP';

export interface Adjustment {
  enabled:          boolean;
  trigger:          AdjustmentTrigger;
  replacementLegs:  Leg[];          // the new legs to enter after exiting
  maxAdjustments?:  number;         // per day cap (default 1)
  delayBars?:       number;         // bars to wait before re-entering (default 0 = next bar)
}

export type WeekdayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI';

export interface BacktestConfig {
  underlying:     Underlying;
  from:           string;        // yyyy-mm-dd (inclusive)
  to:             string;        // yyyy-mm-dd (inclusive)
  entryTime:      string;        // HH:MM IST
  exitTime:       string;        // HH:MM IST — hard square-off
  tradingDays?:   WeekdayCode[]; // optional weekday filter (default all)
  lotSize:        number;        // contract multiplier (qty per lot)
  slippagePct:    number;        // % slippage applied to every fill
  brokeragePerLot?: number;      // flat ₹ per lot per side (default 0)
  legs:           Leg[];
  portfolioRisk?: PortfolioRisk;
  entryFilters?:  EntryFilters;  // Phase 2 — optional day-level gates
  sizing?:        PositionSizing; // Phase 4 — optional dynamic lot sizing
  adjustments?:   Adjustment[];   // Phase 5 — optional position adjustments
}

// ── Results ──────────────────────────────────────────────────────────────────
export type ExitReason =
  | 'TARGET' | 'STOPLOSS' | 'EOD' | 'PORTFOLIO_TP' | 'PORTFOLIO_SL' | 'TRAIL_SL';

export interface TradeLegResult {
  legId:      string;
  optionType: OptionType;
  side:       Side;
  strike:     number;
  expiry:     string;
  lots:       number;
  entryTime:  string;
  exitTime:   string;
  entryPrice: number;  // post-slippage fill
  exitPrice:  number;  // post-slippage fill
  entrySpot:  number;  // underlying spot at this episode's entry (re-entries differ)
  pnl:        number;  // ₹, includes lotSize & lots, net of slippage, gross of charges
  exitReason: ExitReason;
  seq?:       number;  // 0 = original entry, 1+ = re-entry episode index
  highAfterEntry: number;  // highest premium seen after entry (intraday)
  lowAfterEntry:  number;  // lowest premium seen after entry (intraday)
}

// Itemised statutory + broker cost stack for one day (Indian index F&O).
export interface ChargeBreakdown {
  brokerage:   number;  // flat ₹/order (or 0.03% if lower), entry + exit per leg
  stt:         number;  // securities transaction tax — sell-side premium
  exchange:    number;  // exchange transaction charges — both sides
  sebi:        number;  // SEBI turnover fee — both sides
  stampDuty:   number;  // stamp duty — buy-side premium
  gst:         number;  // 18% on (brokerage + exchange + sebi)
  slippage:    number;  // modelled slippage cost (gross − net fills)
  total:       number;  // sum of all of the above (== DayTrade.costs)
}

export interface DayTrade {
  date:       string;
  entrySpot:  number;
  exitSpot:   number;
  legs:       TradeLegResult[];
  grossPnl:   number;
  costs:      number;
  pnl:        number;   // net = gross − costs
  cumPnl:     number;
  exitReason: ExitReason; // dominant reason for the day
  margin:     number;   // approximate margin to ENTER the initial legs (SPAN-like estimate)
  maxMargin:  number;   // peak concurrent margin during the day (≥ margin; re-entry/adjustment)
  roiPct:     number;   // % return on margin
  charges?:   ChargeBreakdown; // itemised cost stack (item 5)
}

// ── Single-day detail (intraday P&L curve for one backtested day) ──────────────
export interface IntradayLegPoint {
  legId: string;
  seq:   number;
  pnl:   number;   // ₹ mark-to-market for this leg/episode at this minute (gross)
  price: number;   // option premium (raw) at this minute
}
export interface IntradayPoint {
  hhmm:  string;
  spot:  number;
  total: number;   // total ₹ MTM across all legs (gross)
  legs:  IntradayLegPoint[];
}
export interface DayDetailResponse {
  ok:      boolean;
  trade?:  DayTrade;
  series?: IntradayPoint[];
  error?:  string;
}

export interface EquityPoint {
  date:     string;
  cumPnl:   number;
  drawdown: number;  // ₹ below running peak (≤ 0)
}

export interface MonthlyBucket {
  month:    string;  // yyyy-MM
  pnl:      number;
  trades:   number;
  wins:     number;
  winRate:  number;
}

export interface WeekdayBucket {
  day:     WeekdayCode;
  pnl:     number;
  trades:  number;
  winRate: number;
}

export interface Metrics {
  totalTrades:    number;
  wins:           number;
  losses:         number;
  winRate:        number;
  totalPnl:       number;
  avgPnl:         number;
  avgWin:         number;
  avgLoss:        number;
  maxWin:         number;
  maxLoss:        number;
  profitFactor:   number;   // gross profit / gross loss
  expectancy:     number;   // avg ₹ per trade
  maxDrawdown:    number;   // ₹ (positive magnitude)
  maxDrawdownPct: number;   // vs peak equity
  sharpe:         number;   // annualised on daily P&L
  sortino:        number;
  calmar:         number;   // annualised return / maxDD (P&L based proxy)
  longestWinStreak:  number;
  longestLossStreak: number;
  totalCosts:     number;
  // Phase 3 extended
  recoveryFactor: number;   // totalPnl / maxDrawdown
  sqn:            number;   // System Quality Number = sqrt(N) * mean / stdDev
  payoffRatio:    number;   // avgWin / |avgLoss|
  cagrPct:        number;   // annualised return proxy (mean daily × 252 / risk capital × 100)
  tail:           number;   // tail ratio = 95th percentile / |5th percentile| of daily P&L
  // AlgoTest-report parity metrics
  expectancyRatio:     number; // avg P&L per trade / |avg loss|
  maxDdDays:           number; // calendar days of the deepest drawdown (peak→trough, inclusive)
  maxDdFrom:           string; // date the deepest drawdown began (first day in the red)
  maxDdTo:             string; // date the deepest drawdown bottomed
  maxTradesInDrawdown: number; // most consecutive trades spent below a prior equity peak
}

// ── Monte Carlo ─────────────────────────────────────────────────────────────
export interface MonteCarloPercentile {
  pct:         number;   // 5, 25, 50, 75, 95
  finalEquity: number;
  maxDrawdown: number;
}
export interface MonteCarloResult {
  simulations:  number;
  percentiles:  MonteCarloPercentile[];
  medianCurve:  number[];  // median equity at each trade index
  p5Curve:      number[];
  p95Curve:     number[];
}

// ── Strategy Score ──────────────────────────────────────────────────────────
export type StrategyGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export interface StrategyScore {
  grade:      StrategyGrade;
  score:      number;   // 0–100
  breakdown:  { factor: string; score: number; weight: number }[];
}

// ── Parameter Sweep ─────────────────────────────────────────────────────────
export interface SweepParam {
  path:  string;   // dot-path into BacktestConfig, e.g. "legs.0.stopLoss.value"
  from:  number;
  to:    number;
  step:  number;
  label?: string;
}
export interface SweepRequest {
  base:    BacktestConfig;
  param1:  SweepParam;
  param2?: SweepParam;       // optional 2nd axis for heatmap
  metric:  keyof Metrics;    // which metric to optimise
}
export interface SweepCell {
  v1:      number;           // param1 value
  v2?:     number;           // param2 value (if 2D)
  metric:  number;           // the selected metric's value
  trades:  number;
}
export interface SweepResponse {
  ok:      boolean;
  cells:   SweepCell[];
  bestV1:  number;
  bestV2?: number;
  bestMetric: number;
}

// ── Walk-forward optimisation ─────────────────────────────────────────────────
export interface WalkForwardRequest {
  base:      BacktestConfig;
  param:     SweepParam;     // single parameter optimised in each in-sample window
  metric:    keyof Metrics;  // metric maximised in-sample
  windows:   number;         // number of in-sample/out-of-sample splits
  oosPct:    number;         // % of each window reserved for out-of-sample (e.g. 30)
}
export interface WalkForwardWindow {
  index:      number;
  isFrom:     string;  isTo:  string;
  oosFrom:    string;  oosTo: string;
  bestParam:  number;
  isMetric:   number;
  oosPnl:     number;
  oosTrades:  number;
}
export interface WalkForwardResponse {
  ok:            boolean;
  windows:       WalkForwardWindow[];
  oosTotalPnl:   number;   // stitched out-of-sample P&L
  oosWinRate:    number;   // % of windows with positive OOS P&L
  efficiency:    number;   // OOS total / sum of in-sample-implied P&L proxy (0–1+)
  equityCurve:   { date: string; cumPnl: number }[];
  error?:        string;
}

export interface BacktestResponse {
  ok:          boolean;
  trades:      DayTrade[];
  metrics:     Metrics;
  equityCurve: EquityPoint[];
  monthly:     MonthlyBucket[];
  weekday:     WeekdayBucket[];
  warnings:    string[];
  tradingDaysScanned: number;
  config:      BacktestConfig;
  monteCarlo?: MonteCarloResult;
  score?:      StrategyScore;
}

// ── Meta (data coverage) ─────────────────────────────────────────────────────
export interface UnderlyingMeta {
  underlying:  Underlying;
  flags:       ExpiryFlag[];
  expiryCount: number;
  firstExpiry: string;
  lastExpiry:  string;
}
export interface BacktestMeta {
  underlyings: UnderlyingMeta[];
}
