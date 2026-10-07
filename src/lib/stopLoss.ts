/**
 * Stop-loss analysis for the Signal Backtest tab: how deep trades go before they close, and what a
 * stop of a given size would have done — computed from each trade's stop path (`trade.stop`), so
 * any stop can be judged exactly, on whatever rows the day filter leaves.
 *
 * A stop is either on the whole trade or on each leg alone (a leg that is stopped is squared off;
 * the others run to the exit), sized as a % of the premium it covers or in ₹ per lot. Fills are at
 * the stop, or where the price was when a minute began past it. Gross, like the rest of the tab.
 */
import type { SignalBacktestRow, SignalTrade, StopPath } from './signalBacktest';

export type StopScope = 'trade' | 'leg';
export type StopUnit = 'pct' | 'rs';

export interface StopRule {
  scope: StopScope;
  unit: StopUnit;
  /** In `unit`; 0 or less = no stop. */
  value: number;
}

/** Rows whose trades carry stop paths — all of them, unless the server predates the feature. */
export const hasStopPaths = (rows: SignalBacktestRow[]): boolean =>
  rows.length > 0 && rows.every((r) => r.trade.stop);

/** A stop in `unit` turned into ₹ for this path: a share of its premium, or ₹ per lot × lots. */
export function stopRupees(path: StopPath, unit: StopUnit, value: number, lots: number): number {
  return unit === 'pct' ? (value / 100) * path.premium : value * lots;
}

/** Where a ₹ stop fires on a path, and the ₹ loss it fills at; null when it is never reached. */
export function stopHit(path: StopPath, rupees: number): { slot: number; loss: number } | null {
  if (!(rupees > 0)) return null;
  for (const [slot, depth, start] of path.steps) {
    if (depth >= rupees) return { slot, loss: Math.max(rupees, start) };
  }
  return null;
}

/** The deepest a path went, ₹ (0 when it never went below entry). */
export const deepest = (path: StopPath): number => path.steps.at(-1)?.[1] ?? 0;

/** A path's deepest dip in `unit`: % of its premium, or ₹ per lot. */
export function dipIn(path: StopPath, unit: StopUnit, lots: number): number {
  const d = deepest(path);
  if (unit === 'pct') return path.premium > 0 ? (d / path.premium) * 100 : 0;
  return d / lots;
}

/** The paths a scope looks at, each with the P&L it ends on with no stop. */
function unitsOf(trade: SignalTrade, scope: StopScope): Array<{ path: StopPath; pnl: number }> {
  if (!trade.stop) return [];
  if (scope === 'trade') return [{ path: trade.stop.trade, pnl: trade.pnl }];
  return trade.stop.legs.map((path, i) => ({ path, pnl: trade.legs[i].pnl }));
}

export interface StoppedTrade {
  /** The trade's P&L with the stop. */
  pnl: number;
  /** Units stopped: 0/1 on the whole trade, 0..legs per leg. */
  stopped: number;
  /** First minute a stop fired, or null. */
  slot: number | null;
}

/** One trade under a stop rule. */
export function applyStop(trade: SignalTrade, rule: StopRule, lots: number): StoppedTrade {
  let pnl = 0;
  let stopped = 0;
  let slot: number | null = null;
  for (const u of unitsOf(trade, rule.scope)) {
    const hit = stopHit(u.path, stopRupees(u.path, rule.unit, rule.value, lots));
    if (hit) {
      pnl -= hit.loss;
      stopped++;
      if (slot == null || hit.slot < slot) slot = hit.slot;
    } else pnl += u.pnl;
  }
  return { pnl, stopped, slot };
}

export interface StopStats {
  /** The stop, in the rule's unit. */
  level: number;
  trades: number;
  /** % of days the stop fired (on the whole trade, or on at least one leg). */
  hitPct: number;
  /** Per leg only: % of legs stopped. */
  legsHitPct: number | null;
  /** % of trades (or legs) that would have closed in profit and were stopped instead. */
  winnersStoppedPct: number;
  /** % of trades (or legs) that would have closed at a loss and were stopped. */
  losersStoppedPct: number;
  pnl: number;
  basePnl: number;
  /** pnl − basePnl: what the stop added (+) or cost (−). */
  delta: number;
  /** Mean ₹ loss of a stopped trade (or leg). */
  avgStopLoss: number | null;
}

const pct = (n: number, of: number) => (of ? (n / of) * 100 : 0);

/** What a stop rule does over a set of rows. */
export function stopStats(rows: SignalBacktestRow[], rule: StopRule, lots: number): StopStats {
  let pnl = 0;
  let basePnl = 0;
  let daysHit = 0;
  let units = 0;
  let unitsHit = 0;
  let winners = 0;
  let winnersHit = 0;
  let losers = 0;
  let losersHit = 0;
  let stopLoss = 0;
  for (const r of rows) {
    let dayHit = false;
    for (const u of unitsOf(r.trade, rule.scope)) {
      units++;
      basePnl += u.pnl;
      const win = u.pnl > 0;
      if (win) winners++;
      else losers++;
      const hit = stopHit(u.path, stopRupees(u.path, rule.unit, rule.value, lots));
      if (hit) {
        dayHit = true;
        unitsHit++;
        stopLoss += hit.loss;
        pnl -= hit.loss;
        if (win) winnersHit++;
        else losersHit++;
      } else pnl += u.pnl;
    }
    if (dayHit) daysHit++;
  }
  return {
    level: rule.value,
    trades: rows.length,
    hitPct: pct(daysHit, rows.length),
    legsHitPct: rule.scope === 'leg' ? pct(unitsHit, units) : null,
    winnersStoppedPct: pct(winnersHit, winners),
    losersStoppedPct: pct(losersHit, losers),
    pnl,
    basePnl,
    delta: pnl - basePnl,
    avgStopLoss: unitsHit ? -stopLoss / unitsHit : null,
  };
}

/** Every trade's (or leg's) deepest dip in `unit`, unsorted. */
export function dipsOf(
  rows: SignalBacktestRow[],
  scope: StopScope,
  unit: StopUnit,
  lots: number,
): number[] {
  return rows.flatMap((r) => unitsOf(r.trade, scope).map((u) => dipIn(u.path, unit, lots)));
}

/**
 * The dip at least `share` of the values reached: a stop no larger than it fires on at least that
 * share of trades (per leg: of legs).
 */
export function reachedBy(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // The epsilon keeps (1 − 0.9) × 10 = 0.999… from landing one place low.
  const idx = Math.min(sorted.length - 1, Math.floor((1 - share) * sorted.length + 1e-9));
  return sorted[idx];
}

/** The shares the data's stop levels are taken at, most-often-hit first. */
export const LEVEL_SHARES = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05] as const;

/** A stop level rounded the way it is shown and typed: 0.1 % or ₹1. */
export const roundLevel = (v: number, unit: StopUnit): number =>
  unit === 'pct' ? Math.round(v * 10) / 10 : Math.round(v);

/**
 * Stop levels taken from the data, not chosen: the dip that 95 %, 90 %… 5 % of trades (or legs)
 * reached. Each comes with what that stop would have done. Repeats and zero levels are dropped.
 */
export function dataLevels(
  rows: SignalBacktestRow[],
  scope: StopScope,
  unit: StopUnit,
  lots: number,
): Array<{ share: number; stats: StopStats }> {
  const dips = dipsOf(rows, scope, unit, lots);
  const seen = new Set<number>();
  const out: Array<{ share: number; stats: StopStats }> = [];
  for (const share of LEVEL_SHARES) {
    const level = roundLevel(reachedBy(dips, share), unit);
    if (!(level > 0) || seen.has(level)) continue;
    seen.add(level);
    out.push({ share, stats: stopStats(rows, { scope, unit, value: level }, lots) });
  }
  return out;
}

/**
 * The stop that would have made the most over these rows. A stop's P&L only changes where it
 * crosses some trade's (or leg's) deepest dip, so every dip that happened is tried — no grid to
 * fall between. One sweep, levels rising: each unit's first step deep enough only moves forward.
 * Null when nothing dipped. Hindsight on this sample.
 */
export function bestStop(
  rows: SignalBacktestRow[],
  scope: StopScope,
  unit: StopUnit,
  lots: number,
): StopStats | null {
  const units = rows.flatMap((r) => unitsOf(r.trade, scope));
  const levels = [...new Set(units.map((u) => roundLevel(dipIn(u.path, unit, lots), unit)))]
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (!levels.length) return null;
  const at = units.map(() => 0);
  let bestLevel = levels[0];
  let bestPnl = -Infinity;
  for (const level of levels) {
    let pnl = 0;
    units.forEach((u, i) => {
      const rupees = stopRupees(u.path, unit, level, lots);
      const steps = u.path.steps;
      while (at[i] < steps.length && steps[at[i]][1] < rupees) at[i]++;
      pnl += at[i] < steps.length ? -Math.max(rupees, steps[at[i]][2]) : u.pnl;
    });
    if (pnl > bestPnl) {
      bestPnl = pnl;
      bestLevel = level;
    }
  }
  return stopStats(rows, { scope, unit, value: bestLevel }, lots);
}

export interface DipSummary {
  n: number;
  mean: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  /** % that never went below entry. */
  neverRedPct: number;
}

export function dipSummary(values: number[]): DipSummary | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: values.length,
    mean: values.reduce((s, v) => s + v, 0) / values.length,
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
    neverRedPct: pct(values.filter((v) => v <= 0).length, values.length),
  };
}

/** Rows split into winners and losers, by the P&L each unit closes on with no stop. */
export function dipsByOutcome(
  rows: SignalBacktestRow[],
  scope: StopScope,
  unit: StopUnit,
  lots: number,
): { winners: number[]; losers: number[] } {
  const winners: number[] = [];
  const losers: number[] = [];
  for (const r of rows) {
    for (const u of unitsOf(r.trade, scope)) {
      (u.pnl > 0 ? winners : losers).push(dipIn(u.path, unit, lots));
    }
  }
  return { winners, losers };
}
