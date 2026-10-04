/**
 * The first profit-mismatch case of a day, as it would have been seen live.
 *
 * The Analysis tab's `findCases` ranks every pair of the whole session and keeps the strongest, so
 * its cases are chosen with hindsight: at 11:49 nobody could know that 09:55→11:49 would end up
 * among the day's best. Entering trades on those would backtest information the trader never had.
 *
 * Here a case exists at minute t2 as soon as ANY earlier minute t1 pairs with it under the very same
 * conditions `findCases` applies to a candidate — same close (±closeTolerance), at least
 * minGapMinutes apart, legs disagreeing by legMismatchPct, score ≥ minAbsPnl. Every one of those
 * conditions reads only minutes ≤ t2, so the first such t2 is the moment the live tracker would
 * have fired. Missing minutes are skipped, never filled forward, exactly as in `findCases`.
 *
 * The reference strangle (whose CE and PE P&L changes are compared) is the Analysis one: ATM ±
 * strikeOffset at the entry minute, picked by the Analysis `pickLegs`.
 */
import { pickLegs, type DayLegs, type FinderParams } from '../analysis/caseFinder.ts';
import { hhmmAt, minuteIndex, round2, type DaySeries } from '../analysis/daySeries.ts';

export interface FirstSignal {
  /** Reference strangle the mismatch is measured on. */
  legs: DayLegs;
  t1: string;
  t2: string;
  /** Grid index of t2 — the minute the case became observable (at its close). */
  t2Index: number;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  /** ₹ change in each reference leg's P&L from t1 to t2, as `findCases` reports it. */
  ceDelta: number;
  peDelta: number;
  totalDelta: number;
  /** |ceDelta − peDelta|. */
  gap: number;
}

export type SignalResult = { ok: true; signal: FirstSignal } | { ok: false; reason: string };

export function firstSignal(day: DaySeries, params: FinderParams): SignalResult {
  const legs = pickLegs(day, params);
  if (typeof legs === 'string') return { ok: false, reason: legs };

  const ce = day.ce[String(legs.ceStrike)];
  const pe = day.pe[String(legs.peStrike)];
  const from = minuteIndex(legs.entryTime);
  const exitIdx = minuteIndex(params.exitTime);
  const to = exitIdx < 0 ? day.spot.length - 1 : exitIdx;

  const valid: number[] = [];
  for (let i = from; i <= to; i++) {
    if (day.spot[i] != null && ce[i] != null && pe[i] != null) valid.push(i);
  }

  const k = (params.side === 'SELL' ? 1 : -1) * params.qty;
  const gap = Math.max(1, Math.round(params.minGapMinutes));
  const band = Math.max(0, params.closeTolerance);
  const mismatch = Math.max(0, params.legMismatchPct) / 100;

  for (let b = 0; b < valid.length; b++) {
    const j = valid[b];
    const s2 = day.spot[j]!;
    const c2 = ce[j]!;
    const p2 = pe[j]!;
    let best = -1;
    let bestI = -1;
    // Every valid i at least `gap` minutes before j; ascending, so ties keep the earliest t1.
    for (let a = 0; a < b && j - valid[a] >= gap; a++) {
      const i = valid[a];
      if (Math.abs(s2 - day.spot[i]!) > band) continue;
      const dCe = (ce[i]! - c2) * k;
      const dPe = (pe[i]! - p2) * k;
      const legGap = Math.abs(dCe - dPe);
      if (
        mismatch > 0 &&
        (legGap === 0 || legGap < mismatch * Math.max(Math.abs(dCe), Math.abs(dPe)))
      ) {
        continue;
      }
      const score = params.rankBy === 'legGap' ? legGap : Math.abs(dCe + dPe);
      if (score < params.minAbsPnl) continue;
      if (score > best) {
        best = score;
        bestI = i;
      }
    }
    if (bestI < 0) continue;

    const ceDelta = round2((ce[bestI]! - c2) * k);
    const peDelta = round2((pe[bestI]! - p2) * k);
    return {
      ok: true,
      signal: {
        legs,
        t1: hhmmAt(bestI),
        t2: hhmmAt(j),
        t2Index: j,
        spot1: day.spot[bestI]!,
        spot2: s2,
        ce1: ce[bestI]!,
        ce2: c2,
        pe1: pe[bestI]!,
        pe2: p2,
        ceDelta,
        peDelta,
        totalDelta: round2(ceDelta + peDelta),
        gap: round2(Math.abs(ceDelta - peDelta)),
      },
    };
  }
  return { ok: false, reason: 'no signal' };
}
