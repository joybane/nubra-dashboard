// Frontend mirror of server/backtest/types.ts (request + response shapes).
export type Underlying  = 'NIFTY' | 'SENSEX';
export type ExpiryFlag  = 'WEEK' | 'MONTH';
export type OptionType  = 'CALL' | 'PUT';
export type Side        = 'BUY' | 'SELL';
export type WeekdayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI';

export type StrikeMethod =
  | 'ATM' | 'CLOSEST_PREMIUM' | 'POINTS_FROM_SPOT' | 'PERCENT_FROM_SPOT' | 'FIXED_STRIKE' | 'DELTA';

export interface StrikeSelection {
  method:           StrikeMethod;
  atmOffset?:       number;
  premiumTarget?:   number;
  pointsFromSpot?:  number;
  percentFromSpot?: number;
  absoluteStrike?:  number;
  targetDelta?:     number;
}

export type SLTargetType =
  | 'NONE' | 'PREMIUM_PERCENT' | 'PREMIUM_ABSOLUTE' | 'UNDERLYING_POINTS' | 'UNDERLYING_PERCENT' | 'DELTA';

export interface SLTarget { type: SLTargetType; value?: number; }

export type TrailType = 'NONE' | 'LOCK' | 'TRAIL' | 'LOCK_AND_TRAIL' | 'TO_COST';
export interface TrailStop {
  type: TrailType; trigger?: number; lock?: number; step?: number; trail?: number;
}

export type ReentryMode = 'NONE' | 'ASAP' | 'COST' | 'REVERSE_ASAP';
export interface Reentry {
  mode: ReentryMode; max?: number; onStopLoss?: boolean; onTarget?: boolean;
}

export interface ExpirySelection { flag: ExpiryFlag; offset: number; }

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
  trail?:     TrailStop;
  reentry?:   Reentry;
}

export interface PortfolioRisk { maxProfit?: number; maxLoss?: number; }

export type SizingMode = 'FIXED' | 'CAPITAL_PERCENT' | 'VOLATILITY_TARGET' | 'MARTINGALE';
export interface PositionSizing {
  mode: SizingMode; capital?: number; riskPct?: number;
  baselineIv?: number; factor?: number; maxLots?: number;
}

export interface EntryFilters {
  dteMin?: number; dteMax?: number;
  ivMin?: number; ivMax?: number;
  premiumMin?: number; premiumMax?: number;
  waitTradePct?: number;
}

export type AdjustmentTrigger =
  | 'ON_ANY_LEG_SL' | 'ON_ANY_LEG_TGT' | 'ON_PORTFOLIO_SL' | 'ON_PORTFOLIO_TP';
export interface Adjustment {
  enabled: boolean; trigger: AdjustmentTrigger; replacementLegs: Leg[];
  maxAdjustments?: number; delayBars?: number;
}

export interface BacktestConfig {
  underlying:       Underlying;
  from:             string;
  to:               string;
  entryTime:        string;
  exitTime:         string;
  tradingDays?:     WeekdayCode[];
  lotSize:          number;
  slippagePct:      number;
  brokeragePerLot?: number;
  legs:             Leg[];
  portfolioRisk?:   PortfolioRisk;
  entryFilters?:    EntryFilters;
  sizing?:          PositionSizing;
  adjustments?:     Adjustment[];
}

export type ExitReason =
  | 'TARGET' | 'STOPLOSS' | 'EOD' | 'PORTFOLIO_TP' | 'PORTFOLIO_SL' | 'TRAIL_SL';

export interface TradeLegResult {
  legId: string; optionType: OptionType; side: Side; strike: number; expiry: string;
  lots: number; entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
  entrySpot: number; pnl: number; exitReason: ExitReason; seq?: number;
  highAfterEntry: number; lowAfterEntry: number;
}
export interface ChargeBreakdown {
  brokerage: number; stt: number; exchange: number; sebi: number;
  stampDuty: number; gst: number; slippage: number; total: number;
}
export interface DayTrade {
  date: string; entrySpot: number; exitSpot: number; legs: TradeLegResult[];
  grossPnl: number; costs: number; pnl: number; cumPnl: number; exitReason: ExitReason;
  margin: number; maxMargin: number; roiPct: number; charges?: ChargeBreakdown;
}

// Single-day intraday detail (P&L curve for one backtested day).
export interface IntradayLegPoint { legId: string; seq: number; pnl: number; price: number; }
export interface IntradayPoint { hhmm: string; spot: number; total: number; legs: IntradayLegPoint[]; }
export interface DayDetailResponse {
  ok: boolean; trade?: DayTrade; series?: IntradayPoint[]; error?: string;
}
export interface EquityPoint { date: string; cumPnl: number; drawdown: number; }
export interface MonthlyBucket { month: string; pnl: number; trades: number; wins: number; winRate: number; }
export interface WeekdayBucket { day: WeekdayCode; pnl: number; trades: number; winRate: number; }

export interface Metrics {
  totalTrades: number; wins: number; losses: number; winRate: number;
  totalPnl: number; avgPnl: number; avgWin: number; avgLoss: number;
  maxWin: number; maxLoss: number; profitFactor: number; expectancy: number;
  maxDrawdown: number; maxDrawdownPct: number; sharpe: number; sortino: number;
  calmar: number; longestWinStreak: number; longestLossStreak: number; totalCosts: number;
  recoveryFactor: number; sqn: number; payoffRatio: number; cagrPct: number; tail: number;
  // AlgoTest-report parity metrics
  expectancyRatio: number;     // avg P&L per trade / |avg loss|
  maxDdDays: number;           // calendar days of the deepest drawdown (peak→trough, inclusive)
  maxDdFrom: string;           // date the deepest drawdown began (first day in the red)
  maxDdTo: string;             // date the deepest drawdown bottomed
  maxTradesInDrawdown: number; // most consecutive trades spent below a prior equity peak
}

export interface MonteCarloPercentile {
  pct: number; finalEquity: number; maxDrawdown: number;
}
export interface MonteCarloResult {
  simulations: number; percentiles: MonteCarloPercentile[];
  medianCurve: number[]; p5Curve: number[]; p95Curve: number[];
}

export type StrategyGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export interface StrategyScore {
  grade: StrategyGrade; score: number;
  breakdown: { factor: string; score: number; weight: number }[];
}

export interface SweepParam {
  path: string; from: number; to: number; step: number; label?: string;
}
export interface SweepRequest {
  base: BacktestConfig; param1: SweepParam; param2?: SweepParam; metric: keyof Metrics;
}
export interface SweepCell {
  v1: number; v2?: number; metric: number; trades: number;
}
export interface SweepResponse {
  ok: boolean; cells: SweepCell[]; bestV1: number; bestV2?: number; bestMetric: number; error?: string;
}

export interface WalkForwardRequest {
  base: BacktestConfig; param: SweepParam; metric: keyof Metrics; windows: number; oosPct: number;
}
export interface WalkForwardWindow {
  index: number; isFrom: string; isTo: string; oosFrom: string; oosTo: string;
  bestParam: number; isMetric: number; oosPnl: number; oosTrades: number;
}
export interface WalkForwardResponse {
  ok: boolean; windows: WalkForwardWindow[]; oosTotalPnl: number; oosWinRate: number;
  efficiency: number; equityCurve: { date: string; cumPnl: number }[]; error?: string;
}

export interface BacktestResponse {
  ok: boolean; trades: DayTrade[]; metrics: Metrics; equityCurve: EquityPoint[];
  monthly: MonthlyBucket[]; weekday: WeekdayBucket[]; warnings: string[];
  tradingDaysScanned: number; config: BacktestConfig; error?: string;
  monteCarlo?: MonteCarloResult; score?: StrategyScore;
}

export interface UnderlyingMeta {
  underlying: Underlying; flags: ExpiryFlag[]; expiryCount: number;
  firstExpiry: string; lastExpiry: string;
}
export interface BacktestMeta { underlyings: UnderlyingMeta[]; }

// ── UI helpers ───────────────────────────────────────────────────────────────
let _legSeq = 0;
export function newLeg(partial: Partial<Leg> = {}): Leg {
  _legSeq += 1;
  return {
    id: `leg_${Date.now().toString(36)}_${_legSeq}`,
    enabled: true, optionType: 'CALL', side: 'SELL', lots: 1,
    expiry: { flag: 'WEEK', offset: 0 },
    strike: { method: 'ATM', atmOffset: 0 },
    stopLoss: { type: 'NONE' }, target: { type: 'NONE' },
    ...partial,
  };
}
