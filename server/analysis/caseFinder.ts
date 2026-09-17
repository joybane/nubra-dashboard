/**
 * Profit-mismatch finder.
 *
 * The scenario: a strangle is put on at the entry minute, and later the underlying comes back to a
 * price it already traded at — yet the legs' P&L is not where it was at that earlier moment. A
 * case is a pair of minutes (t1, t2) on one day where:
 *
 *   |close(t2) − close(t1)| ≤ closeTolerance     (the same level: NIFTY closes almost identical)
 *   t2 − t1 ≥ minGapMinutes                      (enough time has passed to mean something)
 *   |ΔCE − ΔPE| ≥ legMismatchPct% · max(|ΔCE|, |ΔPE|)   (the two legs' P&L did not move together)
 *
 * The tolerance must stay tight (default 1 point). Ranking by the biggest mismatch drives pairs to
 * the edge of whatever band is allowed, and a real spot move inside the band shows up as mismatch:
 * ±5 points put 61% of cases 3–5 points apart, and "same ATM strike" allowed pairs 26–46 points
 * apart. Both were rejected on sight.
 *
 * The mismatch is the point: the CE and PE legs' P&L changes must disagree. At the default 50% the
 * legs either moved in opposite directions or one moved at least twice as much as the other. Ranking
 * by the total alone was the first version and surfaced PE −₹552 / CE −₹478 on 2026-09-16 at the top
 * of the day — both legs losing alike, the opposite of what was asked for. 100% keeps only legs that
 * moved in opposite directions; 0 turns the rule off.
 *
 * Each leg's size is the change in P&L between the two instants — exactly the Δ strip Nubra BT shows
 * between two pinned crosshairs. For a leg that change does not depend on the entry price:
 *
 *   ΔP&L = sign · (price(t1) − price(t2)) · qty         sign = +1 SELL, −1 BUY
 *
 * Strikes are fixed at entry: CE = ATM + offset·step, PE = ATM − offset·step, ATM being spot at the
 * entry minute rounded to the strike step — the same strike Nubra BT's chain marks as ATM.
 *
 * Per day the strongest pairs are kept, up to `maxCasesPerDay`, and no two kept cases may be close:
 * every kept t1 is at least `spacingMinutes` from every other kept t1, and the same for t2. Without
 * that, the slots fill with near-copies of the single best pair (09:17→14:50, 09:18→14:50, …).
 *
 * Forbidding overlap outright was tried first and is too strict: the strongest pair of a day tends
 * to span most of the session, so it blocked everything inside it — on NIFTY 2026-09-09 it left one
 * case and hid 12:41→14:08, the very scenario that prompted this feature.
 *
 * That start-or-end rule still hid good pairs: on 2026-09-16 it listed 7 cases and hid 09:55→11:49
 * (PE −₹406, CE +₹1,086) because 09:59→15:28 started 4 minutes later. So the free slots up to
 * `maxCasesPerDay` are then filled by a looser second pass that only rejects a pair whose start and
 * end are both near a kept case. The second pass only adds; the first pass's cases always stay.
 */
import { STRIKE_STEP, hhmmAt, minuteIndex, round2, type DaySeries } from './daySeries.ts';

export type RankBy = 'total' | 'legGap';

export interface FinderParams {
  entryTime: string;
  exitTime: string;
  /** Largest allowed gap, in index points, between the two minutes' NIFTY closes. */
  closeTolerance: number;
  minGapMinutes: number;
  maxCasesPerDay: number;
  /** Minimum distance between kept cases' starts, and between their ends. */
  spacingMinutes: number;
  /** Ignore pairs whose ranked amount (₹) is below this. */
  minAbsPnl: number;
  qty: number;
  side: 'SELL' | 'BUY';
  strikeOffset: number;
  /** `total`: |ΔCE + ΔPE|. `legGap`: |ΔCE − ΔPE|, how far apart the two legs moved. */
  rankBy: RankBy;
  /** How far apart the legs must move, as a % of the bigger leg's change. 0 = no requirement. */
  legMismatchPct: number;
}

export const DEFAULT_FINDER_PARAMS: FinderParams = {
  entryTime: '09:15',
  exitTime: '15:29',
  closeTolerance: 1,
  minGapMinutes: 30,
  maxCasesPerDay: 10,
  spacingMinutes: 30,
  minAbsPnl: 0,
  qty: 65,
  side: 'SELL',
  strikeOffset: 2,
  rankBy: 'legGap',
  legMismatchPct: 50,
};

export interface DayLegs {
  ceStrike: number;
  peStrike: number;
  /** The minute actually entered: the requested one, or the first minute after it with all prices. */
  entryTime: string;
  entrySpot: number;
  ceEntry: number;
  peEntry: number;
}

export interface AnalysisCase {
  t1: string;
  t2: string;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  /** ₹ change in each leg's P&L from t1 to t2, and their sum. */
  ceDelta: number;
  peDelta: number;
  totalDelta: number;
}

export type DayScan =
  | { ok: true; legs: DayLegs; cases: AnalysisCase[]; candidates: number }
  | { ok: false; reason: string };

/** How far past the requested entry minute a missing price may push the actual entry. */
const ENTRY_SLACK_MINUTES = 5;

function strikeStep(day: DaySeries): number {
  const known = STRIKE_STEP[day.underlying];
  if (known) return known;
  const strikes = [...Object.keys(day.ce), ...Object.keys(day.pe)]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const gap = strikes[i] - strikes[i - 1];
    if (gap > 0 && gap < step) step = gap;
  }
  return Number.isFinite(step) ? step : 50;
}

export function pickLegs(day: DaySeries, params: FinderParams): DayLegs | string {
  const start = minuteIndex(params.entryTime);
  if (start < 0) return `entry time ${params.entryTime} is outside the session`;
  const step = strikeStep(day);
  for (let i = start; i <= start + ENTRY_SLACK_MINUTES && i < day.spot.length; i++) {
    const spot = day.spot[i];
    if (spot == null) continue;
    const atm = Math.round(spot / step) * step;
    const ceStrike = atm + params.strikeOffset * step;
    const peStrike = atm - params.strikeOffset * step;
    const ce = day.ce[String(ceStrike)];
    const pe = day.pe[String(peStrike)];
    if (!ce || !pe) return `no data for ${ceStrike} CE / ${peStrike} PE`;
    const ceEntry = ce[i];
    const peEntry = pe[i];
    if (ceEntry == null || peEntry == null) continue;
    return { ceStrike, peStrike, entryTime: hhmmAt(i), entrySpot: spot, ceEntry, peEntry };
  }
  return `no complete prices within ${ENTRY_SLACK_MINUTES} minutes of ${params.entryTime}`;
}

export function findCases(day: DaySeries, params: FinderParams): DayScan {
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

  const sign = params.side === 'SELL' ? 1 : -1;
  const k = sign * params.qty;
  const gap = Math.max(1, Math.round(params.minGapMinutes));
  const band = Math.max(0, params.closeTolerance);
  const mismatch = Math.max(0, params.legMismatchPct) / 100;

  // Flat [score, i, j] triples: a busy day has tens of thousands of candidate pairs.
  const cand: number[] = [];
  let firstB = 0;
  for (let a = 0; a < valid.length; a++) {
    const i = valid[a];
    const s1 = day.spot[i]!;
    const c1 = ce[i]!;
    const p1 = pe[i]!;
    if (firstB <= a) firstB = a + 1;
    while (firstB < valid.length && valid[firstB] - i < gap) firstB++;
    for (let b = firstB; b < valid.length; b++) {
      const j = valid[b];
      if (Math.abs(day.spot[j]! - s1) > band) continue;
      const dCe = (c1 - ce[j]!) * k;
      const dPe = (p1 - pe[j]!) * k;
      const legGap = Math.abs(dCe - dPe);
      if (
        mismatch > 0 &&
        (legGap === 0 || legGap < mismatch * Math.max(Math.abs(dCe), Math.abs(dPe)))
      ) {
        continue;
      }
      const score = params.rankBy === 'legGap' ? legGap : Math.abs(dCe + dPe);
      if (score < params.minAbsPnl) continue;
      cand.push(score, i, j);
    }
  }

  const order = Array.from({ length: cand.length / 3 }, (_, n) => n);
  order.sort((x, y) => cand[y * 3] - cand[x * 3] || cand[x * 3 + 1] - cand[y * 3 + 1]);

  const spacing = Math.max(0, params.spacingMinutes);
  const picked: Array<[number, number]> = [];
  const pickedN = new Set<number>();
  // Pass 1: no kept case may start, or end, within `spacing` of another.
  // Pass 2 only fills the slots pass 1 left empty, and drops a pair only when both its start and its
  // end are near a kept case. It never removes a pass-1 case.
  for (const bothEnds of [false, true]) {
    for (const n of order) {
      if (picked.length >= params.maxCasesPerDay) break;
      if (pickedN.has(n)) continue;
      const i = cand[n * 3 + 1];
      const j = cand[n * 3 + 2];
      const clash = picked.some(([pi, pj]) =>
        bothEnds
          ? Math.abs(i - pi) < spacing && Math.abs(j - pj) < spacing
          : Math.abs(i - pi) < spacing || Math.abs(j - pj) < spacing,
      );
      if (clash) continue;
      picked.push([i, j]);
      pickedN.add(n);
    }
  }
  // Strongest first, whichever pass kept it. `order` is already sorted.
  const rank = new Map([...pickedN].map((n) => [n, order.indexOf(n)]));
  const keptOrder = [...pickedN].sort((x, y) => rank.get(x)! - rank.get(y)!);
  picked.length = 0;
  for (const n of keptOrder) picked.push([cand[n * 3 + 1], cand[n * 3 + 2]]);

  const cases = picked.map(([i, j]) => {
    const ceDelta = round2((ce[i]! - ce[j]!) * k);
    const peDelta = round2((pe[i]! - pe[j]!) * k);
    return {
      t1: hhmmAt(i),
      t2: hhmmAt(j),
      spot1: day.spot[i]!,
      spot2: day.spot[j]!,
      ce1: ce[i]!,
      ce2: ce[j]!,
      pe1: pe[i]!,
      pe2: pe[j]!,
      ceDelta,
      peDelta,
      totalDelta: round2(ceDelta + peDelta),
    };
  });
  return { ok: true, legs, cases, candidates: cand.length / 3 };
}
