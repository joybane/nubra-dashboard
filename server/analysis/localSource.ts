/**
 * Builds an analysis day from the local parquet tree ("ATM Wise data").
 *
 * The tree's files are ATM-relative buckets whose absolute strike floats minute to minute;
 * `loadExpiryDay` already regroups them by the bars' own `strike` field, which is the only correct
 * reading (see dataLayer.ts). Spot is the tree's `spot` column, identical across every bar of a
 * minute. Compared with Nubra on 5 overlapping days it matched the NIFTY index exactly in 2025 and
 * drifted by a mean 0.2–0.8 points in 2026 — the validation report measures this across the full
 * overlap.
 */
import { loadExpiryDay, resolveExpiry } from '../backtest/dataLayer.ts';
import type { Underlying } from '../backtest/types.ts';
import {
  emptyGrid,
  minuteIndex,
  strikeCoverage,
  type EmptyDay,
  type Grid,
  type StoredDay,
} from './daySeries.ts';
import { isMonthly, type ExpiryCalendar } from './expiryCalendar.ts';

export async function buildLocalDay(
  underlying: Underlying,
  date: string,
  calendar: ExpiryCalendar,
): Promise<StoredDay> {
  const empty = (reason: string): EmptyDay => ({
    v: 1,
    underlying,
    date,
    source: 'local',
    empty: true,
    reason,
  });

  const resolved = await resolveExpiry(underlying, 'WEEK', date, 0);
  if (!resolved) return empty('no-expiry');
  const day = await loadExpiryDay(underlying, resolved.expiry, resolved.flag, date);
  if (!day.strikes.length) return empty('no-data');

  const spot = emptyGrid();
  for (const bars of day.call.values()) {
    for (const b of bars) {
      const i = minuteIndex(b.hhmm);
      if (i >= 0 && spot[i] == null && Number.isFinite(b.spot) && b.spot > 0) spot[i] = b.spot;
    }
  }

  let step = Infinity;
  for (let i = 1; i < day.strikes.length; i++) {
    const gap = day.strikes[i] - day.strikes[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  if (!Number.isFinite(step)) step = underlying === 'SENSEX' ? 100 : 50;

  const coverage = strikeCoverage(spot, step);
  if (!coverage) return empty('no-spot');

  const toGrid = (bars: { hhmm: string; close: number }[] | undefined): Grid | null => {
    if (!bars?.length) return null;
    const g = emptyGrid();
    let any = false;
    for (const b of bars) {
      const i = minuteIndex(b.hhmm);
      if (i >= 0 && Number.isFinite(b.close)) {
        g[i] = b.close;
        any = true;
      }
    }
    return any ? g : null;
  };

  const ce: Record<string, Grid> = {};
  const pe: Record<string, Grid> = {};
  for (const k of coverage.ce) {
    const g = toGrid(day.call.get(k));
    if (g) ce[String(k)] = g;
  }
  for (const k of coverage.pe) {
    const g = toGrid(day.put.get(k));
    if (g) pe[String(k)] = g;
  }
  if (!Object.keys(ce).length || !Object.keys(pe).length) return empty('no-option-data');

  return {
    v: 1,
    underlying,
    date,
    source: 'local',
    expiry: resolved.expiry,
    monthly: isMonthly(calendar, resolved.expiry),
    spot,
    ce,
    pe,
  };
}
