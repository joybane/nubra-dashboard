/**
 * P&L analysis for the Signal Backtest tab, on the rows the day filter leaves: how the results are
 * spread, which profit targets and stop-losses get hit and how often, what a target and a stop do
 * together (whichever fires first decides the trade), what paths trades take, and which conditions
 * the biggest losses and wins come from.
 *
 * Capital is the premium collected: (CE + PE entry price) × lot size, per lot — the most a short
 * trade can make. Sizes are a % of it, or ₹ per lot. Everything is on the whole trade.
 *
 * Fills: a target fills at the target; a stop at the stop, or where the minute began when it jumped
 * through. When the target and the stop are both crossed inside one minute, 1-minute data cannot
 * say which came first, so the stop is assumed (the cautious reading) and such days are counted.
 * Gross of charges and slippage, like the rest of the tab.
 */
import type { SignalBacktestRow, StopPath } from './signalBacktest';
import { reachedBy, roundLevel } from './stopLoss';

export type PnlUnit = 'pct' | 'rs';

export interface ExitPlan {
  unit: PnlUnit;
  /** Profit target in `unit`; 0 = none. */
  target: number;
  /** Stop-loss in `unit`; 0 = none. */
  sl: number;
}

/** Rows that carry both paths — all of them, unless the server predates this view. */
export const hasPnlPaths = (rows: SignalBacktestRow[]): boolean =>
  rows.length > 0 && rows.every((r) => r.trade.stop && r.trade.target);

/** ₹ capital of the trade for the run's lots (the premium collected). */
const capitalOf = (r: SignalBacktestRow): number => r.trade.stop!.trade.premium;

/** A size in `unit` as ₹ for this trade. */
export function toRupees(r: SignalBacktestRow, unit: PnlUnit, v: number, lots: number): number {
  return unit === 'pct' ? (v / 100) * capitalOf(r) : v * lots;
}

/** A ₹ amount of this trade in `unit`: % of its capital, or ₹ per lot. */
export function inUnit(r: SignalBacktestRow, unit: PnlUnit, rupees: number, lots: number): number {
  if (unit === 'pct') return capitalOf(r) > 0 ? (rupees / capitalOf(r)) * 100 : 0;
  return rupees / lots;
}

const lastDepth = (p: StopPath): number => p.steps.at(-1)?.[1] ?? 0;
/** Best ₹ profit the trade showed between entry and exit (0 if it never went green). */
export const peakRs = (r: SignalBacktestRow): number => lastDepth(r.trade.target!);
/** Deepest ₹ loss it showed (0 if it never went red). */
export const dipRs = (r: SignalBacktestRow): number => lastDepth(r.trade.stop!.trade);

/** The first step reaching ₹ `rupees`, or null. */
function cross(path: StopPath, rupees: number): [number, number, number] | null {
  if (!(rupees > 0)) return null;
  for (const step of path.steps) if (step[1] >= rupees) return step;
  return null;
}

export type Outcome = 'target' | 'sl' | 'both' | 'none';

/** One trade under a plan: how it ended, at what ₹ P&L, and in which minute (null: held to exit). */
export function runPlan(
  r: SignalBacktestRow,
  plan: ExitPlan,
  lots: number,
): { outcome: Outcome; pnl: number; slot: number | null } {
  const tRs = toRupees(r, plan.unit, plan.target, lots);
  const sRs = toRupees(r, plan.unit, plan.sl, lots);
  const t = cross(r.trade.target!, tRs);
  const s = cross(r.trade.stop!.trade, sRs);
  if (!t && !s) return { outcome: 'none', pnl: r.trade.pnl, slot: null };
  if (t && (!s || t[0] < s[0])) return { outcome: 'target', pnl: tRs, slot: t[0] };
  const loss = -Math.max(sRs, s![2]);
  return { outcome: t && t[0] === s![0] ? 'both' : 'sl', pnl: loss, slot: s![0] };
}

export interface PlanStats {
  plan: ExitPlan;
  trades: number;
  /** % of days the target fired first. */
  targetPct: number;
  /** % of days the stop fired first (not counting the same-minute ones). */
  slPct: number;
  /** % of days both were crossed in the same minute (counted as the stop). */
  bothPct: number;
  /** % of days neither fired: held to the exit. */
  nonePct: number;
  /** Average ₹ P&L of the days held to the exit. */
  noneAvg: number | null;
  pnl: number;
  basePnl: number;
  delta: number;
}

const share = (n: number, of: number) => (of ? (n / of) * 100 : 0);

export function planStats(rows: SignalBacktestRow[], plan: ExitPlan, lots: number): PlanStats {
  const count: Record<Outcome, number> = { target: 0, sl: 0, both: 0, none: 0 };
  let pnl = 0;
  let basePnl = 0;
  let noneSum = 0;
  for (const r of rows) {
    const o = runPlan(r, plan, lots);
    count[o.outcome]++;
    pnl += o.pnl;
    basePnl += r.trade.pnl;
    if (o.outcome === 'none') noneSum += o.pnl;
  }
  const n = rows.length;
  return {
    plan,
    trades: n,
    targetPct: share(count.target, n),
    slPct: share(count.sl, n),
    bothPct: share(count.both, n),
    nonePct: share(count.none, n),
    noneAvg: count.none ? noneSum / count.none : null,
    pnl,
    basePnl,
    delta: pnl - basePnl,
  };
}

// ── Levels and boundaries ─────────────────────────────────────────────────────

/** Each trade's best profit, or deepest loss, in `unit`. */
export function excursions(
  rows: SignalBacktestRow[],
  which: 'peak' | 'dip',
  unit: PnlUnit,
  lots: number,
): number[] {
  return rows.map((r) => inUnit(r, unit, which === 'peak' ? peakRs(r) : dipRs(r), lots));
}

/** The shares the tables take their levels at, most-often-hit first. */
export const TABLE_SHARES = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05] as const;

/**
 * Where a target (or stop) stops being hit: the level 90 % of days reached, the ones only 10 %, 5 %
 * and 1 % reached, and the furthest any day went — beyond which it was never hit.
 */
export interface Boundaries {
  by90: number;
  by50: number;
  by10: number;
  by5: number;
  by1: number;
  max: number;
  /** % of days that never got there at all (never green for a target, never red for a stop). */
  zeroPct: number;
}

export function boundaries(values: number[]): Boundaries | null {
  if (!values.length) return null;
  return {
    by90: reachedBy(values, 0.9),
    by50: reachedBy(values, 0.5),
    by10: reachedBy(values, 0.1),
    by5: reachedBy(values, 0.05),
    by1: reachedBy(values, 0.01),
    max: Math.max(...values),
    zeroPct: share(values.filter((v) => v <= 0).length, values.length),
  };
}

export interface LevelRow {
  share: number;
  level: number;
  stats: PlanStats;
  /** Target rows: % of the days it fired that would have closed lower without it (it helped). */
  helpedPct: number | null;
}

/** Target levels (only a target set) or stop levels (only a stop set) taken from the data. */
export function levelRows(
  rows: SignalBacktestRow[],
  which: 'target' | 'sl',
  unit: PnlUnit,
  lots: number,
): LevelRow[] {
  const values = excursions(rows, which === 'target' ? 'peak' : 'dip', unit, lots);
  const seen = new Set<number>();
  const out: LevelRow[] = [];
  for (const sh of TABLE_SHARES) {
    const level = roundLevel(reachedBy(values, sh), unit);
    if (!(level > 0) || seen.has(level)) continue;
    seen.add(level);
    const plan: ExitPlan = {
      unit,
      target: which === 'target' ? level : 0,
      sl: which === 'sl' ? level : 0,
    };
    let fired = 0;
    let helped = 0;
    if (which === 'target') {
      for (const r of rows) {
        const o = runPlan(r, plan, lots);
        if (o.outcome !== 'target') continue;
        fired++;
        if (r.trade.pnl < o.pnl) helped++;
      }
    }
    out.push({
      share: sh,
      level,
      stats: planStats(rows, plan, lots),
      helpedPct: which === 'target' ? share(helped, fired) : null,
    });
  }
  return out;
}

/** Grid axes: the levels that 90 %, 75 %, 50 %, 25 % and 10 % (and 5 % for stops) of days reached. */
export const GRID_TARGET_SHARES = [0.9, 0.75, 0.5, 0.25, 0.1] as const;
export const GRID_SL_SHARES = [0.9, 0.75, 0.5, 0.25, 0.1, 0.05] as const;

/** Distinct data levels at the given shares, in `unit`; 0 is kept as "none". */
export function axisLevels(values: number[], shares: readonly number[], unit: PnlUnit): number[] {
  const out = new Set<number>([0]);
  for (const sh of shares) {
    const v = roundLevel(reachedBy(values, sh), unit);
    if (v > 0) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The target and stop pair that would have made the most here, each searched over the levels 95 %,
 * 90 %… 5 % of days reached (and none). Hindsight on this sample.
 */
export function bestPlan(rows: SignalBacktestRow[], unit: PnlUnit, lots: number): PlanStats | null {
  if (!rows.length) return null;
  const fine = Array.from({ length: 19 }, (_, i) => 0.95 - i * 0.05);
  const targets = axisLevels(excursions(rows, 'peak', unit, lots), fine, unit);
  const sls = axisLevels(excursions(rows, 'dip', unit, lots), fine, unit);
  let best: PlanStats | null = null;
  for (const target of targets) {
    for (const sl of sls) {
      const s = planStats(rows, { unit, target, sl }, lots);
      if (!best || s.pnl > best.pnl) best = s;
    }
  }
  return best;
}

// ── How results are spread ────────────────────────────────────────────────────

export interface Slice {
  /** 1 = the worst tenth of days … 10 = the best. */
  n: number;
  trades: number;
  /** P&L range of the slice, in `unit`. */
  lo: number;
  hi: number;
  avg: number;
  /** ₹ P&L of the slice for the run's lots. */
  total: number;
}

/** Days ranked by P&L (in `unit`) and cut into ten equal slices, worst first. */
export function slices(rows: SignalBacktestRow[], unit: PnlUnit, lots: number): Slice[] {
  const ranked = rows
    .map((r) => ({ v: inUnit(r, unit, r.trade.pnl, lots), rs: r.trade.pnl }))
    .sort((a, b) => a.v - b.v);
  const out: Slice[] = [];
  for (let k = 0; k < 10; k++) {
    const part = ranked.slice(
      Math.round((k * ranked.length) / 10),
      Math.round(((k + 1) * ranked.length) / 10),
    );
    if (!part.length) continue;
    out.push({
      n: k + 1,
      trades: part.length,
      lo: part[0].v,
      hi: part[part.length - 1].v,
      avg: part.reduce((s, p) => s + p.v, 0) / part.length,
      total: part.reduce((s, p) => s + p.rs, 0),
    });
  }
  return out;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export type PathKind = 'clean-win' | 'scare-win' | 'reversal-loss' | 'straight-loss';

export const PATH_LABEL: Record<PathKind, string> = {
  'clean-win': 'Won without a scare',
  'scare-win': 'Won after a scare',
  'reversal-loss': 'Lost after being in profit',
  'straight-loss': 'Lost without ever being in profit',
};

export interface PathGroup {
  kind: PathKind;
  trades: number;
  pct: number;
  /** Average P&L, peak and dip in `unit`. */
  avg: number;
  avgPeak: number;
  avgDip: number;
  /** ₹ P&L for the run's lots. */
  total: number;
}

/**
 * Every trade in one of four paths. A winner had a scare when its dip reached `scare`; a loser had
 * been in profit when its peak reached `inProfit` (both in `unit`).
 */
export function pathGroups(
  rows: SignalBacktestRow[],
  unit: PnlUnit,
  lots: number,
  scare: number,
  inProfit: number,
): PathGroup[] {
  const kinds: PathKind[] = ['clean-win', 'scare-win', 'reversal-loss', 'straight-loss'];
  const acc = new Map(kinds.map((k) => [k, { n: 0, v: 0, peak: 0, dip: 0, rs: 0 }]));
  for (const r of rows) {
    const peak = inUnit(r, unit, peakRs(r), lots);
    const dip = inUnit(r, unit, dipRs(r), lots);
    const kind: PathKind =
      r.trade.pnl > 0
        ? dip >= scare
          ? 'scare-win'
          : 'clean-win'
        : peak >= inProfit
          ? 'reversal-loss'
          : 'straight-loss';
    const a = acc.get(kind)!;
    a.n++;
    a.v += inUnit(r, unit, r.trade.pnl, lots);
    a.peak += peak;
    a.dip += dip;
    a.rs += r.trade.pnl;
  }
  return kinds.map((kind) => {
    const a = acc.get(kind)!;
    return {
      kind,
      trades: a.n,
      pct: share(a.n, rows.length),
      avg: a.n ? a.v / a.n : 0,
      avgPeak: a.n ? a.peak / a.n : 0,
      avgDip: a.n ? a.dip / a.n : 0,
      total: a.rs,
    };
  });
}

/** Per session hour, the % of trades whose best point and whose worst point fell in it. */
export function extremeHours(
  rows: SignalBacktestRow[],
): Array<{ hour: string; peakPct: number; dipPct: number }> {
  const hourOf = (slot: number) => Math.floor((9 * 60 + 15 + slot) / 60);
  const peaks = new Map<number, number>();
  const dips = new Map<number, number>();
  for (const r of rows) {
    const p = r.trade.target!.steps.at(-1);
    const d = r.trade.stop!.trade.steps.at(-1);
    if (p) peaks.set(hourOf(p[0]), (peaks.get(hourOf(p[0])) ?? 0) + 1);
    if (d) dips.set(hourOf(d[0]), (dips.get(hourOf(d[0])) ?? 0) + 1);
  }
  const hours = [...new Set([...peaks.keys(), ...dips.keys()])].sort((a, b) => a - b);
  return hours.map((h) => ({
    hour: `${String(h).padStart(2, '0')}:00`,
    peakPct: share(peaks.get(h) ?? 0, rows.length),
    dipPct: share(dips.get(h) ?? 0, rows.length),
  }));
}

// ── Where the biggest losses and wins come from ───────────────────────────────

export interface DriverBucket {
  label: string;
  trades: number;
  winPct: number;
  /** Average P&L in `unit`. */
  avg: number;
  total: number;
  /** Of all the big-loss (big-win) days, the % in this bucket. */
  bigLossShare: number;
  bigWinShare: number;
  /** bigLossShare ÷ the bucket's share of all days: 1 = as often as anywhere, 2 = twice as often. */
  lossLift: number;
  winLift: number;
}

export interface Driver {
  name: string;
  buckets: DriverBucket[];
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A bucket's label and where it sorts. */
type Keyed = [label: string, order: number];

/** Quartile buckets of a measure, labelled by their range. Null measures are left out. */
function quartiles(
  rows: SignalBacktestRow[],
  measure: (r: SignalBacktestRow) => number | null,
  fmt: (v: number) => string,
): Map<SignalBacktestRow, Keyed> {
  const vals = rows
    .map((r) => measure(r))
    .filter((v): v is number => v != null && Number.isFinite(v))
    .sort((a, b) => a - b);
  const out = new Map<SignalBacktestRow, Keyed>();
  if (vals.length < 8) return out;
  const cut = [0.25, 0.5, 0.75].map((q) => vals[Math.floor(q * vals.length)]);
  const edges = [vals[0], ...cut, vals[vals.length - 1]];
  const names = ['lowest quarter', '2nd quarter', '3rd quarter', 'highest quarter'];
  for (const r of rows) {
    const v = measure(r);
    if (v == null || !Number.isFinite(v)) continue;
    const q = v < cut[0] ? 0 : v < cut[1] ? 1 : v < cut[2] ? 2 : 3;
    out.set(r, [`${fmt(edges[q])} – ${fmt(edges[q + 1])} (${names[q]})`, q]);
  }
  return out;
}

/**
 * Big losses are the worst tenth of these days and big wins the best tenth (by P&L in `unit`). Each
 * driver splits the days into buckets and says how the big ones fall across them.
 */
export function drivers(
  rows: SignalBacktestRow[],
  unit: PnlUnit,
  lots: number,
  dteName: (dte: number) => string,
): { drivers: Driver[]; bigLossAt: number; bigWinAt: number } {
  const value = new Map(rows.map((r) => [r, inUnit(r, unit, r.trade.pnl, lots)]));
  const sorted = [...value.values()].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(rows.length / 10));
  const bigLossAt = sorted[k - 1] ?? 0;
  const bigWinAt = sorted[sorted.length - k] ?? 0;
  const bigLoss = new Set(rows.filter((r) => value.get(r)! <= bigLossAt && value.get(r)! < 0));
  const bigWin = new Set(rows.filter((r) => value.get(r)! >= bigWinAt && value.get(r)! > 0));

  const pct2 = (v: number) => `${v.toFixed(2)}%`;
  const rs0 = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
  const spotMove = (r: SignalBacktestRow) =>
    r.trade.exitSpot == null
      ? null
      : ((r.trade.exitSpot - r.trade.entrySpot) / r.trade.entrySpot) * 100;
  const keyed: Array<[string, (r: SignalBacktestRow) => Keyed | null]> = [
    ['Days to expiry', (r) => (r.dte == null ? null : [dteName(r.dte), r.dte])],
    [
      'Weekday',
      (r) => {
        const d = new Date(`${r.date}T00:00:00Z`).getUTCDay();
        return [WEEKDAY[d], d];
      },
    ],
    [
      'Entry time',
      (r) => {
        const h = Number(r.trade.entryTime.slice(0, 2));
        return [`${String(h).padStart(2, '0')}:00 – ${String(h + 1).padStart(2, '0')}:00`, h];
      },
    ],
    ['Year', (r) => [r.date.slice(0, 4), Number(r.date.slice(0, 4))]],
    [
      'Spot direction',
      (r) => {
        const m = spotMove(r);
        return m == null ? null : m >= 0 ? ['Spot ended higher', 0] : ['Spot ended lower', 1];
      },
    ],
  ];
  const quart: Array<[string, Map<SignalBacktestRow, Keyed>]> = [
    [
      'Capital (premium collected per lot)',
      quartiles(rows, (r) => r.trade.stop!.trade.premium / lots, rs0),
    ],
    [
      'How far spot ended from entry',
      quartiles(
        rows,
        (r) => {
          const m = spotMove(r);
          return m == null ? null : Math.abs(m);
        },
        pct2,
      ),
    ],
    [
      'Spot range while in the trade (high − low)',
      quartiles(
        rows,
        (r) =>
          r.trade.spotHigh == null || r.trade.spotLow == null
            ? null
            : ((r.trade.spotHigh - r.trade.spotLow) / r.trade.entrySpot) * 100,
        pct2,
      ),
    ],
    ['Signal size (ref leg gap)', quartiles(rows, (r) => r.signal.gap, rs0)],
  ];

  const build = (
    name: string,
    keyOf: (r: SignalBacktestRow) => Keyed | null | undefined,
  ): Driver => {
    const groups = new Map<string, { order: number; rows: SignalBacktestRow[] }>();
    for (const r of rows) {
      const key = keyOf(r);
      if (key == null) continue;
      const g = groups.get(key[0]) ?? { order: key[1], rows: [] };
      g.rows.push(r);
      groups.set(key[0], g);
    }
    const buckets = [...groups.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([label, { rows: g }]): DriverBucket => {
        const losses = g.filter((r) => bigLoss.has(r)).length;
        const wins = g.filter((r) => bigWin.has(r)).length;
        const daysShare = g.length / rows.length;
        const lossShare = bigLoss.size ? losses / bigLoss.size : 0;
        const winShare = bigWin.size ? wins / bigWin.size : 0;
        return {
          label,
          trades: g.length,
          winPct: share(g.filter((r) => r.trade.pnl > 0).length, g.length),
          avg: g.reduce((s, r) => s + value.get(r)!, 0) / g.length,
          total: g.reduce((s, r) => s + r.trade.pnl, 0),
          bigLossShare: lossShare * 100,
          bigWinShare: winShare * 100,
          lossLift: daysShare ? lossShare / daysShare : 0,
          winLift: daysShare ? winShare / daysShare : 0,
        };
      });
    return { name, buckets };
  };

  return {
    drivers: [
      ...keyed.map(([name, f]) => build(name, f)),
      ...quart.map(([name, m]) => build(name, (r) => m.get(r))),
    ].filter((d) => d.buckets.length > 1),
    bigLossAt,
    bigWinAt,
  };
}

/**
 * The buckets where big losses (or wins) are most over-represented, for the headline: at least
 * `minTrades` days and a lift of 1.3 or more, strongest first.
 */
export function standouts(
  list: Driver[],
  which: 'loss' | 'win',
  minTrades = 15,
  limit = 4,
): Array<{ driver: string; bucket: DriverBucket }> {
  return list
    .flatMap((d) => d.buckets.map((bucket) => ({ driver: d.name, bucket })))
    .filter(
      ({ bucket }) =>
        bucket.trades >= minTrades && (which === 'loss' ? bucket.lossLift : bucket.winLift) >= 1.3,
    )
    .sort((a, b) =>
      which === 'loss'
        ? b.bucket.lossLift - a.bucket.lossLift
        : b.bucket.winLift - a.bucket.winLift,
    )
    .slice(0, limit);
}
