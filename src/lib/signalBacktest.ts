/**
 * Signal Backtest tab — client types, defaults, formatting and CSV export.
 *
 * Mirrors the response of POST /api/signal-backtest/run (server/signalBacktest/routes.ts). Kept
 * separate from the Analysis tab's own helpers on purpose: that tab is left untouched.
 */

export type SignalUnderlying = 'NIFTY' | 'SENSEX';
export type LegChoice = 'CE' | 'PE' | 'BOTH';
export type Side = 'BUY' | 'SELL';
export type StrikeMode = 'OTM' | 'PREMIUM';

export const LOT_SIZE: Record<SignalUnderlying, number> = { NIFTY: 65, SENSEX: 20 };

/** A ₹ entry-price range, inclusive: [min, max]. */
export type PremiumRange = [number, number];

/** The Analysis finder's parameters — the signal definition. */
export interface SignalParams {
  entryTime: string;
  exitTime: string;
  closeTolerance: number;
  minGapMinutes: number;
  minAbsPnl: number;
  qty: number;
  side: Side;
  strikeOffset: number;
  rankBy: 'total' | 'legGap';
  legMismatchPct: number;
}

export interface TradeParams {
  legs: LegChoice;
  side: Side;
  strikeMode: StrikeMode;
  otmSteps: number;
  /** Override of `otmSteps` by trading days to expiry ("0" = the expiry day); a missing key uses `otmSteps`. */
  otmStepsByDte: Record<string, number>;
  cePremiumMin: number;
  cePremiumMax: number;
  pePremiumMin: number;
  pePremiumMax: number;
  /** Override of the CE / PE range above by trading days to expiry; a missing key uses it. */
  cePremiumByDte: Record<string, PremiumRange>;
  pePremiumByDte: Record<string, PremiumRange>;
  /** Premium mode trades only the expiry distances with a range chosen from the data's tiers. */
  premiumTiersOnly: boolean;
  delayMinutes: number;
  lots: number;
  exitTime: string;
}

/** Same defaults as the Analysis tab, so the signals match what it shows. */
export const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  entryTime: '09:15',
  exitTime: '15:29',
  closeTolerance: 1,
  minGapMinutes: 30,
  minAbsPnl: 0,
  qty: 65,
  side: 'SELL',
  strikeOffset: 2,
  rankBy: 'legGap',
  legMismatchPct: 50,
};

export const DEFAULT_TRADE_PARAMS: TradeParams = {
  legs: 'BOTH',
  side: 'SELL',
  strikeMode: 'OTM',
  otmSteps: 2,
  otmStepsByDte: {},
  cePremiumMin: 40,
  cePremiumMax: 60,
  pePremiumMin: 40,
  pePremiumMax: 60,
  cePremiumByDte: {},
  pePremiumByDte: {},
  premiumTiersOnly: true,
  delayMinutes: 1,
  lots: 1,
  exitTime: '15:29',
};

export interface LegTrade {
  kind: 'CE' | 'PE';
  strike: number;
  entryOpen: number | null;
  entryClose: number;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  exitFallback: boolean;
  pnl: number;
  maxProfit: number;
  maxProfitTime: string;
  maxLoss: number;
  maxLossTime: string;
  basis: 'ohlc' | 'close';
}

export interface SignalTrade {
  entryTime: string;
  entrySpot: number;
  atm: number;
  step: number;
  /** OTM steps used that day (weekday override or default); null in premium mode. */
  otmSteps: number | null;
  qty: number;
  side: Side;
  legs: LegTrade[];
  exitTime: string;
  pnl: number;
  maxProfit: number;
  maxProfitTime: string;
  maxLoss: number;
  maxLossTime: string;
  basis: 'ohlc' | 'close' | 'mixed';
}

/** One option's greeks, per option unit. `iv` is in vol points (14.5 = 14.5%); vega is per vol point. */
export interface LegGreeks {
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export type GreekKey = keyof LegGreeks;

export interface MomentGreeks {
  CE: LegGreeks | null;
  PE: LegGreeks | null;
}

/** The reference strangle's greeks at the signal's two minutes; null where a leg could not be priced. */
export interface SignalGreeks {
  t1: MomentGreeks;
  t2: MomentGreeks;
}

export interface SignalInfo {
  legs: { ceStrike: number; peStrike: number; entryTime: string; entrySpot: number };
  /** Absent when the server predates the greeks columns — restart it. */
  greeks?: SignalGreeks;
  t1: string;
  t2: string;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  ceDelta: number;
  peDelta: number;
  totalDelta: number;
  gap: number;
}

export interface SignalBacktestRow {
  date: string;
  source: 'nubra' | 'local';
  expiry: string;
  /**
   * Trading days to the expiry: 0 on the expiry day, 1 the day before it, and so on. Absent when the
   * server predates it (restart it); null when the expiry is not after the date.
   */
  dte?: number | null;
  ohlcSource: 'nubra-wide' | 'parquet' | null;
  signal: SignalInfo;
  trade: SignalTrade;
}

interface Extreme {
  date: string;
  value: number;
}

/** One tier of sellable premiums at a distance from expiry. Picking it sells inside [low, high]. */
export interface PremiumSet {
  low: number;
  high: number;
  median: number;
  /** Prices in the tier, over all days and strikes. */
  points: number;
  /** % of the days at that distance with at least one strike priced inside [low, high]. */
  coverage: number;
}

export interface ExpiryDaySets {
  /** Trading days to expiry: 0 = the expiry day, 1 = the day before it. */
  dte: number;
  /** Days at this distance the sets were built from. */
  days: number;
  CE: PremiumSet[];
  PE: PremiumSet[];
}

/** One entry per distance from expiry the run saw. Built from the same days, entry minutes and strikes as its trades. */
export interface PremiumSetsResponse {
  expiryDays: ExpiryDaySets[];
}

export interface SignalBacktestSummary {
  daysScanned: number;
  daysWithSignal: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  best: Extreme | null;
  worst: Extreme | null;
  avgMaxProfit: number;
  avgMaxLoss: number;
  biggestMaxProfit: Extreme | null;
  biggestMaxLoss: Extreme | null;
  nubraDays: number;
  localDays: number;
  ohlcTrades: number;
  closeTrades: number;
  skipped: Record<string, number>;
  ms: number;
}

export interface WideStatus {
  ok: true;
  nubraDays: number;
  wideDays: number;
  brokerSession: boolean;
  sync: {
    running: boolean;
    underlying: string | null;
    done: number;
    total: number;
    failed: number;
    lastError: string | null;
  };
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const;

/** "₹25.5 – 43.5": trailing zeros dropped, so half-rupee ends read as 25.5 and whole ones as 40. */
export function rangeText(low: number, high: number): string {
  const f = (v: number) => String(Math.round(v * 100) / 100);
  return `₹${f(low)} – ${f(high)}`;
}

export const sameRange = (a: PremiumRange | null | undefined, b: PremiumRange | null | undefined) =>
  a != null && b != null && a[0] === b[0] && a[1] === b[1];

/** The expiry distances the pickers offer before a run has shown which exist: 0 = expiry day … 4. */
export const DEFAULT_DTES = [0, 1, 2, 3, 4] as const;

/** "Exp", "Exp−1", "Exp−2"… — short enough for a button or a line of settings text. */
export const dteShort = (dte: number): string => (dte === 0 ? 'Exp' : `Exp−${dte}`);

const validDte = (k: string) => /^\d{1,2}$/.test(k);

/** Ranges by expiry distance from saved settings or a hand edit: anything malformed is dropped. */
export function cleanRangeMap(raw: unknown): Record<string, PremiumRange> {
  const out: Record<string, PremiumRange> = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!validDte(k) || !Array.isArray(v) || v.length !== 2) continue;
    const lo = Number(v[0]);
    const hi = Number(v[1]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && lo <= hi)
      out[String(+k)] = [lo, hi];
  }
  return out;
}

/** OTM steps by expiry distance from saved settings or a hand edit: only whole numbers 0 – 10 survive. */
export function cleanStepMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (validDte(k) && typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10) {
      out[String(+k)] = v;
    }
  }
  return out;
}

/** The distances a map has an entry for, nearest to expiry first. */
const dtesOf = (m: Record<string, unknown> | undefined): number[] =>
  Object.keys(m ?? {})
    .map(Number)
    .sort((a, b) => a - b);

const otmLabel = (n: number) => (n === 0 ? 'ATM' : `OTM ${n}`);

/** One line describing the strike rule, e.g. "OTM 2", "OTM 2 (Exp 3, Exp−1 1)" or "CE ₹40–60 / PE ₹40–60". */
export function strikeRule(t: TradeParams): string {
  if (t.strikeMode === 'OTM') {
    const overrides = dtesOf(t.otmStepsByDte).flatMap((d) => {
      const n = t.otmStepsByDte[String(d)];
      return n === t.otmSteps ? [] : [`${dteShort(d)} ${n}`];
    });
    return overrides.length
      ? `${otmLabel(t.otmSteps)} (${overrides.join(', ')})`
      : otmLabel(t.otmSteps);
  }
  const ce = t.legs !== 'PE' ? t.cePremiumByDte : {};
  const pe = t.legs !== 'CE' ? t.pePremiumByDte : {};
  if (t.premiumTiersOnly) {
    const all = [...new Set([...dtesOf(ce), ...dtesOf(pe)])].sort((a, b) => a - b);
    const chosen = all.flatMap((d) =>
      [
        ce[String(d)] ? `${dteShort(d)} CE ${rangeText(...ce[String(d)])}` : '',
        pe[String(d)] ? `${dteShort(d)} PE ${rangeText(...pe[String(d)])}` : '',
      ].filter(Boolean),
    );
    return chosen.length
      ? `premium tiers (${chosen.join(', ')})`
      : 'premium tiers (none chosen yet)';
  }
  const parts: string[] = [];
  if (t.legs !== 'PE') parts.push(`CE ₹${t.cePremiumMin}–${t.cePremiumMax}`);
  if (t.legs !== 'CE') parts.push(`PE ₹${t.pePremiumMin}–${t.pePremiumMax}`);
  const perDistance = dtesOf(ce).length + dtesOf(pe).length > 0;
  return parts.join(' / ') + (perDistance ? ' + ranges by days to expiry' : '');
}

export interface SignalBacktestResponse {
  ok: true;
  underlying: SignalUnderlying;
  signalParams: SignalParams;
  tradeParams: TradeParams;
  from: string | null;
  to: string | null;
  includeLocalOnly: boolean;
  useHighLow: boolean;
  rows: SignalBacktestRow[];
  skipped: Array<{ date: string; source: 'nubra' | 'local'; reason: string }>;
  summary: SignalBacktestSummary;
  /** Absent when the server predates the premium sets — restart it. */
  premiumSets?: PremiumSetsResponse;
}

/** GET /api/signal-backtest/day — what the chart under a row draws. Grids are 375 one-minute slots from 09:15. */
export type Grid = Array<number | null>;

export interface SignalDayResponse {
  ok: true;
  underlying: SignalUnderlying;
  date: string;
  source: 'nubra' | 'local';
  expiry: string;
  ceStrike: number;
  peStrike: number;
  spot: Grid;
  ce: Grid;
  pe: Grid;
  greeks: { CE: Record<GreekKey, Grid>; PE: Record<GreekKey, Grid>; forward: Grid };
  /** The legs the trade sold, with their closes every minute (null = no price stored for it). Absent on an older server. */
  legs?: Array<{ kind: 'CE' | 'PE'; strike: number; close: Grid | null }>;
}

// ── Which days: weekday and days-to-expiry filter ─────────────────────────────

/** Which rows to show. Empty = no restriction on that axis; both axes must match. */
export interface RowFilter {
  /** Monday = 0 … Friday = 4. */
  weekdays: number[];
  /** Trading days to expiry: 0 = expiry day, 1 = the day before. */
  dte: number[];
}

export const NO_FILTER: RowFilter = { weekdays: [], dte: [] };

export const filterActive = (f: RowFilter): boolean => f.weekdays.length > 0 || f.dte.length > 0;

/** Monday = 0 … Friday = 4 for an ISO date; null on a weekend. */
export function weekdayIndex(date: string): number | null {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5 ? dow - 1 : null;
}

export function filterRows(rows: SignalBacktestRow[], f: RowFilter): SignalBacktestRow[] {
  if (!filterActive(f)) return rows;
  return rows.filter((r) => {
    if (f.weekdays.length) {
      const d = weekdayIndex(r.date);
      if (d == null || !f.weekdays.includes(d)) return false;
    }
    // A row with no known days-to-expiry cannot be said to match one.
    return !f.dte.length || (r.dte != null && f.dte.includes(r.dte));
  });
}

/** "Expiry day", "1 day before", "2 days before"… */
export function dteLabel(dte: number): string {
  if (dte === 0) return 'Expiry day';
  return `${dte} day${dte === 1 ? '' : 's'} before`;
}

/** The mark shown on a row: only the expiry day and the day before it get one. */
export function dteBadge(dte: number | null | undefined): 'EXPIRY' | 'EXPIRY−1' | null {
  return dte === 0 ? 'EXPIRY' : dte === 1 ? 'EXPIRY−1' : null;
}

/** "Mon, Tue · Expiry day, 1 day before" — what a filter is set to, for a line of text. */
export function describeFilter(f: RowFilter): string {
  const parts: string[] = [];
  if (f.weekdays.length) parts.push(f.weekdays.map((i) => WEEKDAYS[i]).join(', '));
  if (f.dte.length) parts.push(f.dte.map(dteLabel).join(', '));
  return parts.join(' · ');
}

/** The headline numbers of a set of trades — for the rows a filter leaves, not just the whole run. */
export function tradeStats(rows: SignalBacktestRow[]): {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
} {
  const pnls = rows.map((r) => r.trade.pnl);
  const total = pnls.reduce((s, v) => s + v, 0);
  const wins = pnls.filter((v) => v > 0).length;
  const n = rows.length;
  return {
    trades: n,
    wins,
    losses: pnls.filter((v) => v < 0).length,
    winRate: n ? Math.round((wins / n) * 10000) / 100 : 0,
    totalPnl: Math.round(total * 100) / 100,
    avgPnl: n ? Math.round((total / n) * 100) / 100 : 0,
  };
}

// ── Day chart: P&L through the trade ──────────────────────────────────────────

const SESSION_SLOTS = 375;

/** Grid slot of an 'HH:MM' in the 375-minute session that starts at 09:15. */
export function slotOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m - (9 * 60 + 15);
}

/** What the leg was sold or bought at: the mean of the entry minute's open and close, else the close. */
export const legEntryPrice = (leg: LegTrade): number =>
  leg.entryOpen != null ? (leg.entryOpen + leg.entryClose) / 2 : leg.entryClose;

/**
 * Mark-to-market ₹ P&L through the trade, per leg and in total, every minute from entry to exit —
 * what the table's P&L is the last point of. Entry is the leg's entry price (mean of the entry
 * minute's open and close, or the close alone), so the line starts at zero at the fill; after that
 * every minute is the close against that entry. A minute with no price is left empty, never filled
 * forward, and the total only exists where every leg has one.
 *
 * `closes` holds each traded leg's per-minute closes, in the order of `trade.legs`.
 */
export function tradePnlSeries(
  trade: SignalTrade,
  closes: Array<Grid | null | undefined>,
): { legs: Grid[]; total: Grid } {
  const sign = trade.side === 'BUY' ? 1 : -1;
  const entryIdx = slotOf(trade.entryTime);
  const legs = trade.legs.map((leg, n): Grid => {
    const series: Grid = new Array(SESSION_SLOTS).fill(null);
    const close = closes[n];
    if (!close) return series;
    const entry = legEntryPrice(leg);
    const exitIdx = slotOf(leg.exitTime);
    series[entryIdx] = 0;
    for (let m = entryIdx + 1; m <= exitIdx; m++) {
      const price = close[m];
      if (price != null) series[m] = Math.round(sign * (price - entry) * trade.qty * 100) / 100;
    }
    return series;
  });
  const total: Grid = new Array(SESSION_SLOTS).fill(null);
  for (let m = 0; m < SESSION_SLOTS; m++) {
    if (!legs.length || legs.some((s) => s[m] == null)) continue;
    total[m] = Math.round(legs.reduce((sum, s) => sum + s[m]!, 0) * 100) / 100;
  }
  return { legs, total };
}

// ── Greeks ────────────────────────────────────────────────────────────────────

/** Display order, name and precision. Names are spelled out: a bare Θ was not read as theta. Gamma is tiny on an index, so it gets the extra places. */
export const GREEKS: ReadonlyArray<{ key: GreekKey; label: string; digits: number }> = [
  { key: 'iv', label: 'IV', digits: 2 },
  { key: 'delta', label: 'Delta', digits: 3 },
  { key: 'gamma', label: 'Gamma', digits: 5 },
  { key: 'theta', label: 'Theta', digits: 2 },
  { key: 'vega', label: 'Vega', digits: 2 },
];

/** t2 minus t1 for one greek of one leg; null if either end could not be priced. */
export function greekChange(
  t1: LegGreeks | null | undefined,
  t2: LegGreeks | null | undefined,
  key: GreekKey,
): number | null {
  if (!t1 || !t2) return null;
  return Math.round((t2[key] - t1[key]) * 1e6) / 1e6;
}

/**
 * A greek's value at the table's precision; `signed` forces a leading + on positives (for changes).
 * Anything that rounds to zero prints as an unsigned zero — "-0.00000" would read as a move.
 */
export function fmtGreek(key: GreekKey, value: number | null | undefined, signed = false): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const digits = GREEKS.find((g) => g.key === key)?.digits ?? 2;
  const text = value.toFixed(digits);
  if (Number(text) === 0) return (0).toFixed(digits);
  return signed && value > 0 ? `+${text}` : text;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function inr(n: number | null | undefined, signed = true): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '-' : '') : n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return 'text-[var(--text-muted)]';
  return n > 0 ? 'text-[#22c55e]' : 'text-[#ef4444]';
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v == null) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LEG_COLUMNS = [
  'strike',
  'entry open',
  'entry close',
  'entry price',
  'exit time',
  'exit price',
  'exit fallback',
  'P&L',
  'max profit',
  'max profit time',
  'max loss',
  'max loss time',
  'basis',
];

function legCells(leg: LegTrade | undefined): Array<string | number | boolean | null> {
  if (!leg) return LEG_COLUMNS.map(() => null);
  return [
    leg.strike,
    leg.entryOpen,
    leg.entryClose,
    leg.entryPrice,
    leg.exitTime,
    leg.exitPrice,
    leg.exitFallback,
    leg.pnl,
    leg.maxProfit,
    leg.maxProfitTime,
    leg.maxLoss,
    leg.maxLossTime,
    leg.basis,
  ];
}

const GREEK_SIDES = ['CE', 'PE'] as const;
const GREEK_COLUMNS = GREEK_SIDES.flatMap((side) =>
  GREEKS.flatMap((g) =>
    (['t1', 't2', 'change'] as const).map((when) => `ref ${side} ${g.key} ${when}`),
  ),
);

/** The reference legs' greeks at t1, at t2 and the change, in the same order as `GREEK_COLUMNS`. */
function greekCells(greeks: SignalGreeks | undefined): Array<number | null> {
  return GREEK_SIDES.flatMap((side) =>
    GREEKS.flatMap((g) => {
      const a = greeks?.t1[side] ?? null;
      const b = greeks?.t2[side] ?? null;
      return [a?.[g.key] ?? null, b?.[g.key] ?? null, greekChange(a, b, g.key)];
    }),
  );
}

/** One line per trade; CE and PE leg details side by side (blank when that leg was not traded). */
export function buildCsv(rows: SignalBacktestRow[]): string {
  const header = [
    'date',
    'source',
    'expiry',
    'days to expiry',
    'ref CE strike',
    'ref PE strike',
    'signal t1',
    'signal t2',
    'spot t1',
    'spot t2',
    'ref CE t1',
    'ref CE t2',
    'ref PE t1',
    'ref PE t2',
    'ref ΔCE',
    'ref ΔPE',
    'ref gap',
    'entry time',
    'entry spot',
    'ATM',
    'OTM steps',
    'side',
    'qty',
    ...LEG_COLUMNS.map((c) => `CE ${c}`),
    ...LEG_COLUMNS.map((c) => `PE ${c}`),
    'trade P&L',
    'trade max profit',
    'trade max profit time',
    'trade max loss',
    'trade max loss time',
    'basis',
    'high/low source',
    ...GREEK_COLUMNS,
  ];
  const lines = rows.map((r) => {
    const s = r.signal;
    const t = r.trade;
    return [
      r.date,
      r.source,
      r.expiry,
      r.dte,
      s.legs.ceStrike,
      s.legs.peStrike,
      s.t1,
      s.t2,
      s.spot1,
      s.spot2,
      s.ce1,
      s.ce2,
      s.pe1,
      s.pe2,
      s.ceDelta,
      s.peDelta,
      s.gap,
      t.entryTime,
      t.entrySpot,
      t.atm,
      t.otmSteps,
      t.side,
      t.qty,
      ...legCells(t.legs.find((l) => l.kind === 'CE')),
      ...legCells(t.legs.find((l) => l.kind === 'PE')),
      t.pnl,
      t.maxProfit,
      t.maxProfitTime,
      t.maxLoss,
      t.maxLossTime,
      t.basis,
      r.ohlcSource,
      ...greekCells(s.greeks),
    ]
      .map(csvCell)
      .join(',');
  });
  return [header.map(csvCell).join(','), ...lines].join('\r\n') + '\r\n';
}
