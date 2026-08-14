// ─── Aggregate Vega / Theta over a delta-filtered near-the-money basket ──────────
//
// Implements two methodologies side-by-side, per the project spec:
//
//   • "mine"     — raw per-contract Greek summed over the qualifying basket
//                  (CE and PE kept separate). One open contract counts the same
//                  as a hundred thousand. This is the spec's primary metric.
//
//   • "industry" — notional / dollar-Greek aggregation: Σ (greek × OI × lotSize),
//                  the SpotGamma / dollar-Greek convention from the research, so
//                  the total reflects how much real exposure sits at each strike.
//
// …and two basket-membership rules:
//
//   • "fixed"    — Spec §2. Lock the (strike, type) keys that qualify at the first
//                  snapshot t_min and sum ONLY those, forever, even if their delta
//                  later drifts out of the band. Isolates pure Greek movement.
//
//   • "floating" — Spec §3. Re-apply the delta filter on every snapshot; a contract
//                  drops out the moment its delta leaves the band and a new strike
//                  joins the moment it enters. Reflects Greek + composition change.
//
// …and two baseline rules, which decide what t_min means:
//
//   • "session"  — t_min resets at every IST trading day, so the fixed basket re-locks and
//                  the difference series returns to zero at that day's FIRST snapshot — not
//                  at a fixed clock time (a partial day starts late, and MCX opens at 09:00).
//                  Each session is self-contained while the whole loaded window stays on screen.
//
//   • "window"   — one t_min for the entire loaded window (the original behavior). The
//                  difference series runs cumulatively and the fixed basket stays locked
//                  to the strikes that qualified on the window's first day.
//
// …and two composition rules, which decide what a membership CHANGE does to the level:
//
//   • "raw"      — nothing. The level is the current basket's plain Σ, so a strike joining or
//                  leaving steps the series by that strike's whole Greek. This is the spec as
//                  written and stays the default of buildSeries().
//
//   • "chained"  — splice it out. Both baskets are evaluated at the same snapshot and the
//                  difference is carried forward as an offset, so only Greek movement reaches
//                  the line. See the long note on buildSeries for why, and what it costs.
//
// Greek unit conventions match GexService.ts: theta is per calendar day, vega is
// per 1% (one vol-point) change in IV.

import { IST_OFFSET, chartTimeDayKey } from './utils.ts';

export type OptionType = 'CE' | 'PE';
export type GreekName = 'vega' | 'theta';
export type Method = 'mine' | 'industry';
export type Basket = 'fixed' | 'floating';
export type Baseline = 'session' | 'window';
export type Composition = 'raw' | 'chained';

// ─── Delta filter boundaries (Spec §1) ───────────────────────────────────────────
export const CE_DELTA_MIN = 0.05;
export const CE_DELTA_MAX = 0.609;
export const PE_DELTA_MIN = -0.609;
export const PE_DELTA_MAX = -0.05;

// ─── Ingest-time prune band (Spec §1 support, |delta|) ───────────────────────────
//
// Storing a whole expiry's legs per timestamp costs ~844k objects for a 7-day 1m window, and
// buildSeries walks all of them every redraw — measured 234 ms for three overlays, ~31% of a
// core against the 750 ms throttle. Pruning at ingest cut that to 45 ms (5.2x) for 84% fewer
// legs, with bit-identical output.
//
// This band MUST strictly contain the qualifying band above, because:
//   • the `fixed` basket keeps legs that qualified at t_min and have since drifted out, and
//   • ivAtDelta refuses to extrapolate, so it needs points bracketing 0.25 and 0.5.
// Narrowing it is therefore NOT safe — see the containment test in greekAggregator.test.ts.
export const PRUNE_DELTA_MIN = 0.02;
export const PRUNE_DELTA_MAX = 0.7;

/** True if a leg is worth storing at all. Unknown delta is kept — aggregation decides. */
export function withinPruneBand(delta: number | undefined): boolean {
  if (delta == null || !Number.isFinite(delta)) return true;
  const a = Math.abs(delta);
  return a >= PRUNE_DELTA_MIN && a <= PRUNE_DELTA_MAX;
}

// ─── Carry-forward and chaining constants ────────────────────────────────────────
//
// How long a leg survives on its last known values before buildSeries stops counting it.
// A thin wing strike routinely skips minutes in the broker's 1m series; 15 minutes of total
// silence is a leg that has genuinely gone (drifted past the prune band, or delisted), and
// evicting it is a real membership change rather than a data gap.
export const CARRY_STALE_MS = 15 * 60_000;

// How long a leg must disagree with its current membership before the membership actually
// flips, under `composition: 'chained'`. This is a dwell timer, NOT an MSCI-style retention
// band: the CE/PE delta thresholds are untouched, a leg simply cannot enter and leave on a
// momentary excursion. See the chaining note on buildSeries for why splice COUNT is the
// quantity that has to be bounded.
//
// Denominated in TIME, not in snapshots, because the two feeds that reach buildSeries sample
// ~30x apart: reconstructed history is 1m (HIST_INTERVAL) while the live tail is ~2s
// (SNAP_MIN_GAP_MS), both in useGreekOverlay. A snapshot count would mean a 2-minute debounce
// on history and a 4-second one live — i.e. essentially no protection exactly where the chart
// is densest, and a splice every time a strike breathed across Δ=0.609. The series has to have
// the same shape regardless of how often it is sampled.
//
// 60s reproduces the old count of 2 exactly on the 1m path: back then a leg flipped on its
// second consecutive disagreeing snapshot, which at 1m spacing is 60_000 ms elapsed.
export const MEMBERSHIP_DWELL_MS = 60_000;

/** One leg of an option-chain snapshot, reduced to the fields aggregation needs. */
export interface AggLeg {
  sp: number; // strike price (rupees)
  delta?: number;
  vega?: number;
  theta?: number;
  oi?: number;
  iv?: number; // decimal, not percent (0.1905 = 19.05%) — matches the broker's chain
  exp?: string; // expiry tag — keeps same-strike legs of different expiries distinct
}

/** A full option-chain snapshot at a single timestamp. */
export interface ChainSnapshot {
  ts: number; // epoch ms
  ce: AggLeg[];
  pe: AggLeg[];
}

export interface AggregateOptions {
  greek: GreekName;
  method: Method;
  basket: Basket;
  /** Contract multiplier / lot size — only used by the "industry" method. */
  lotSize?: number;
  /** Locked basket keys (from t_min). Required when basket === 'fixed'. */
  fixedKeys?: ReadonlySet<string>;
}

/** Totals for one snapshot, split by option type. */
export interface SideTotals {
  ce: number;
  pe: number;
}

/** One point in the output time series. */
export interface SeriesPoint {
  ts: number;
  ceTotal: number; // Spec §2 — cumulative absolute total
  peTotal: number;
  ceDiff: number; // Spec §3 — change from the opening baseline
  peDiff: number;
}

// ─── Predicates & keys ───────────────────────────────────────────────────────────

/** True if a leg's delta places it inside the near-the-money band for its type. */
export function qualifies(type: OptionType, delta: number | undefined): boolean {
  if (delta == null || Number.isNaN(delta)) return false;
  return type === 'CE'
    ? delta >= CE_DELTA_MIN && delta <= CE_DELTA_MAX
    : delta >= PE_DELTA_MIN && delta <= PE_DELTA_MAX;
}

/** Composite key locking a contract's identity across the timeline. */
export function legKey(sp: number, type: OptionType, exp?: string): string {
  return exp ? `${type}:${sp}:${exp}` : `${type}:${sp}`;
}

/**
 * Lock the immutable evaluation basket B_fixed at t_min (Spec §2, Step 2):
 * every (strike, type) that satisfies the delta filter at the opening snapshot.
 */
export function lockBasket(snapshot: ChainSnapshot): Set<string> {
  const keys = new Set<string>();
  for (const leg of snapshot.ce)
    if (qualifies('CE', leg.delta)) keys.add(legKey(leg.sp, 'CE', leg.exp));
  for (const leg of snapshot.pe)
    if (qualifies('PE', leg.delta)) keys.add(legKey(leg.sp, 'PE', leg.exp));
  return keys;
}

// ─── Per-leg contribution ────────────────────────────────────────────────────────

/** Value a single leg contributes to its side's total under the chosen method. */
function legValue(leg: AggLeg, greek: GreekName, method: Method, lotSize: number): number {
  const g = greek === 'vega' ? leg.vega : leg.theta;
  if (g == null || Number.isNaN(g)) return 0;
  if (method === 'mine') return g; // raw per-contract Greek
  return g * (leg.oi ?? 0) * lotSize; // notional / dollar-Greek
}

/** Whether a leg is part of the basket at this snapshot, given the membership rule. */
function isMember(
  leg: AggLeg,
  type: OptionType,
  basket: Basket,
  fixedKeys: ReadonlySet<string> | undefined,
): boolean {
  return basket === 'fixed'
    ? !!fixedKeys && fixedKeys.has(legKey(leg.sp, type, leg.exp)) // locked membership
    : qualifies(type, leg.delta); // live re-filter
}

/**
 * Aggregate one snapshot into CE/PE totals.
 * For "fixed" basket pass the locked keys from lockBasket(); for "floating" the
 * delta filter is applied live and fixedKeys is ignored.
 */
export function aggregateSnapshot(snapshot: ChainSnapshot, opts: AggregateOptions): SideTotals {
  const { greek, method, basket, lotSize = 1, fixedKeys } = opts;
  let ce = 0;
  let pe = 0;
  for (const leg of snapshot.ce) {
    if (isMember(leg, 'CE', basket, fixedKeys)) ce += legValue(leg, greek, method, lotSize);
  }
  for (const leg of snapshot.pe) {
    if (isMember(leg, 'PE', basket, fixedKeys)) pe += legValue(leg, greek, method, lotSize);
  }
  return { ce, pe };
}

// ─── Time series ─────────────────────────────────────────────────────────────────

export interface SeriesOptions extends Omit<AggregateOptions, 'fixedKeys'> {
  /** Where t_min sits. Defaults to 'session' — see the baseline note at the top. */
  baseline?: Baseline;
  /**
   * How basket composition changes are treated. Defaults to 'raw' — the spec's plain Σ, so
   * this function's default output is unchanged from before chaining existed. The app passes
   * 'chained'; see the chaining note on buildSeries.
   */
  composition?: Composition;
}

/** IST calendar day a snapshot's epoch-ms timestamp belongs to. */
export function snapshotDayKey(ts: number): string | null {
  return chartTimeDayKey(Math.floor(ts / 1000) + IST_OFFSET);
}

/**
 * Overlay `next` onto `prev`, keeping the last known value of every field `next` omits.
 *
 * The broker's 1m timeseries is per-field, so a leg can arrive carrying delta but no vega at
 * a given minute. Without this the leg stays in the basket (it has a delta, so it qualifies)
 * while contributing zero, which reads on the chart as a one-bar collapse of the whole total.
 */
function carryLeg(prev: AggLeg | undefined, next: AggLeg): AggLeg {
  if (!prev) return next;
  const keep = (a: number | undefined, b: number | undefined) =>
    a != null && Number.isFinite(a) ? a : b;
  return {
    ...prev,
    ...next,
    delta: keep(next.delta, prev.delta),
    vega: keep(next.vega, prev.vega),
    theta: keep(next.theta, prev.theta),
    oi: keep(next.oi, prev.oi),
    iv: keep(next.iv, prev.iv),
  };
}

/** Set equality by size + membership; both sides hold legKey strings. */
function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/**
 * Build the full CE/PE total + difference-from-open series across an ordered list
 * of snapshots (Spec §2 totals and §3 differences in one pass).
 *
 *   - `baseline: 'session'` (default) re-anchors t_min at each IST trading day: the fixed
 *     basket re-locks from that day's first snapshot and the difference series subtracts
 *     that day's opening totals. A multi-day window therefore reads as one self-contained
 *     run per session rather than a single cumulative sweep.
 *   - `baseline: 'window'` uses the first snapshot overall as the single t_min.
 *   - Snapshots are sorted by timestamp internally, so callers may pass historical
 *     (open→now) and live (now→running) ticks concatenated in any order.
 *   - `totals` under a floating basket are baseline-independent; only `diff` and fixed-basket
 *     membership respond to this setting.
 *
 * Legs are always carried forward on their last known values (see carryLeg) — a snapshot that
 * omits a leg, or a field of one, reads as unchanged rather than as zero.
 *
 * `composition: 'chained'` additionally removes the step a membership change puts in the
 * total. Vega peaks at Δ≈0.5 and CE_DELTA_MAX sits at 96% of that peak, so a strike crossing
 * the top edge takes a near-maximal contribution with it and the level jumps for reasons that
 * are not Greek movement. Chaining is the standard answer: evaluate the outgoing and incoming
 * baskets at the SAME snapshot and carry the difference forward as an offset — continuous
 * futures back-adjustment, the S&P divisor, and CPI chain-linking are all this algorithm, and
 * the continuous-time form is the Divisia index.
 *
 * Additive, not multiplicative: vega sums approach zero near expiry and a ratio adjustment
 * would blow up there.
 *
 * The offset is exact — both baskets are read off one snapshot, so unlike a futures roll there
 * is no estimation error per splice. What does accumulate is real movement made by a leg while
 * it was out of the basket, which the chain correctly declines to attribute to anyone; that
 * grows with the NUMBER of splices, hence MEMBERSHIP_DWELL. `baseline: 'session'` zeroes the
 * offset daily, capping drift.
 *
 * A chained level is an artifact in the same sense as a back-adjusted futures price: it
 * answers "what would this basket be worth had composition never changed", not "what is the
 * current basket worth". 'raw' remains available for the latter.
 */
export function buildSeries(
  snapshots: ReadonlyArray<ChainSnapshot>,
  opts: SeriesOptions,
): SeriesPoint[] {
  if (snapshots.length === 0) return [];

  const ordered = [...snapshots].sort((a, b) => a.ts - b.ts);
  const baseline = opts.baseline ?? 'session';
  const chained = (opts.composition ?? 'raw') === 'chained';

  // Re-anchor whenever the IST day changes ('session'), or once up front ('window').
  let anchored = false;
  let anchorDay: string | null = null;
  let fixedKeys: ReadonlySet<string> | undefined;
  let base: SideTotals = { ce: 0, pe: 0 };

  // Last known state per leg, so a gap in one leg's series is not read as a zero.
  const carry = new Map<string, { leg: AggLeg; type: OptionType; ts: number }>();
  // Effective membership, its dwell counters, and the accumulated chain offset.
  let members = new Set<string>();
  let prevMembers: Set<string> | null = null;
  // key → ts at which this leg first disagreed with its current membership (not a count).
  const dwell = new Map<string, number>();
  let offset: SideTotals = { ce: 0, pe: 0 };

  // One reusable snapshot for the carried chain — rebuilt per timestamp and never retained by
  // aggregateSnapshot or lockBasket, both of which read it synchronously.
  const filled: ChainSnapshot = { ts: 0, ce: [], pe: [] };
  const aggOpts = (keys: ReadonlySet<string>): AggregateOptions => ({
    greek: opts.greek,
    method: opts.method,
    basket: 'fixed', // membership is resolved below; aggregateSnapshot just applies the set
    lotSize: opts.lotSize,
    fixedKeys: keys,
  });

  const out: SeriesPoint[] = [];
  for (const snap of ordered) {
    const day = baseline === 'session' ? snapshotDayKey(snap.ts) : null;
    const reanchor = !anchored || (baseline === 'session' && day !== anchorDay);
    if (reanchor) {
      carry.clear();
      dwell.clear();
      members = new Set();
      prevMembers = null;
      offset = { ce: 0, pe: 0 };
    }

    for (const leg of snap.ce) {
      const k = legKey(leg.sp, 'CE', leg.exp);
      carry.set(k, { leg: carryLeg(carry.get(k)?.leg, leg), type: 'CE', ts: snap.ts });
    }
    for (const leg of snap.pe) {
      const k = legKey(leg.sp, 'PE', leg.exp);
      carry.set(k, { leg: carryLeg(carry.get(k)?.leg, leg), type: 'PE', ts: snap.ts });
    }
    for (const [k, v] of carry) if (snap.ts - v.ts > CARRY_STALE_MS) carry.delete(k);

    filled.ts = snap.ts;
    filled.ce.length = 0;
    filled.pe.length = 0;
    for (const v of carry.values()) (v.type === 'CE' ? filled.ce : filled.pe).push(v.leg);

    if (reanchor) {
      anchored = true;
      anchorDay = day;
      fixedKeys = opts.basket === 'fixed' ? lockBasket(filled) : undefined;
    }

    // ── Resolve membership for this snapshot ──
    if (opts.basket === 'fixed') {
      // Locked keys, minus any whose leg has aged out entirely.
      members = new Set<string>();
      for (const k of fixedKeys ?? []) if (carry.has(k)) members.add(k);
    } else if (reanchor || !chained) {
      // Spec §3: the live re-filter, applied every snapshot. Also used for the anchor snapshot
      // under chaining — the dwell timer governs changes, never the opening membership.
      members = new Set<string>();
      for (const [k, v] of carry) if (qualifies(v.type, v.leg.delta)) members.add(k);
    } else {
      for (const [k, v] of carry) {
        const want = qualifies(v.type, v.leg.delta);
        if (want === members.has(k)) {
          dwell.delete(k);
          continue;
        }
        const since = dwell.get(k) ?? snap.ts;
        if (snap.ts - since >= MEMBERSHIP_DWELL_MS) {
          if (want) members.add(k);
          else members.delete(k);
          dwell.delete(k);
        } else dwell.set(k, since);
      }
      // Ageing out is not chatter — CARRY_STALE_MS of silence leaves immediately.
      for (const k of members) if (!carry.has(k)) members.delete(k);
    }

    const raw = aggregateSnapshot(filled, aggOpts(members));
    // Only clone on an actual change: membership holds steady for most of a session, and this
    // runs once per snapshot per method against a 750 ms redraw throttle.
    if (chained && (prevMembers === null || !sameKeys(prevMembers, members))) {
      if (prevMembers) {
        const before = aggregateSnapshot(filled, aggOpts(prevMembers));
        offset = { ce: offset.ce + (before.ce - raw.ce), pe: offset.pe + (before.pe - raw.pe) };
      }
      prevMembers = new Set(members);
    }

    const ce = chained ? raw.ce + offset.ce : raw.ce;
    const pe = chained ? raw.pe + offset.pe : raw.pe;
    if (reanchor) base = { ce, pe };

    out.push({ ts: snap.ts, ceTotal: ce, peTotal: pe, ceDiff: ce - base.ce, peDiff: pe - base.pe });
  }
  return out;
}

// ─── Constant-delta IV measures ──────────────────────────────────────────────────
//
// Deliberately NOT routed through legValue()/Method. Summing raw IV across strikes is
// meaningless and the "industry" (greek × OI × lot) weighting is nonsense applied to a
// volatility, so IV gets its own aggregation and the Greek methods stay untouched.
//
// Measured at constant DELTA rather than at fixed strikes: a fixed-strike IV series drifts
// as spot walks away from the strike, whereas delta-anchored IV is spot-invariant and so
// stays comparable across a session. Standard skew/smile convention.

export type IvMeasure = 'atm' | 'rr25' | 'fly25';

/** One point of an IV series. `value` is in vol POINTS (percent), e.g. 19.05. */
export interface IvPoint {
  ts: number;
  value: number;
}

const ATM_DELTA = 0.5;
const WING_DELTA = 0.25;

/**
 * Linearly interpolate IV at a target delta within one option side. Returns NaN rather than
 * extrapolating when the target sits outside the strikes actually present, so a thin chain
 * yields a gap instead of an invented wing.
 */
export function ivAtDelta(legs: ReadonlyArray<AggLeg>, target: number): number {
  const pts: Array<[number, number]> = [];
  for (const l of legs) {
    if (l.delta == null || !Number.isFinite(l.delta)) continue;
    if (l.iv == null || !Number.isFinite(l.iv) || l.iv <= 0) continue;
    pts.push([l.delta, l.iv]);
  }
  if (pts.length < 2) return NaN;
  pts.sort((a, b) => a[0] - b[0]);
  if (target < pts[0][0] || target > pts[pts.length - 1][0]) return NaN;

  for (let i = 1; i < pts.length; i++) {
    const [d0, v0] = pts[i - 1];
    const [d1, v1] = pts[i];
    if (target <= d1) {
      if (d1 === d0) return v1;
      return v0 + ((target - d0) / (d1 - d0)) * (v1 - v0);
    }
  }
  return NaN;
}

/** Mean of the finite arguments; NaN when none are finite. */
function meanFinite(...vals: number[]): number {
  const ok = vals.filter((v) => Number.isFinite(v));
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN;
}

/** Group a snapshot's legs by expiry so each surface is interpolated on its own. */
function byExpiry(snap: ChainSnapshot): Map<string, { ce: AggLeg[]; pe: AggLeg[] }> {
  const out = new Map<string, { ce: AggLeg[]; pe: AggLeg[] }>();
  const push = (leg: AggLeg, side: 'ce' | 'pe') => {
    const k = leg.exp || '';
    let g = out.get(k);
    if (!g) {
      g = { ce: [], pe: [] };
      out.set(k, g);
    }
    g[side].push(leg);
  };
  for (const l of snap.ce) push(l, 'ce');
  for (const l of snap.pe) push(l, 'pe');
  return out;
}

/** One expiry's measure, in vol points. */
function measureFor(g: { ce: AggLeg[]; pe: AggLeg[] }, measure: IvMeasure): number {
  const atm = meanFinite(ivAtDelta(g.ce, ATM_DELTA), ivAtDelta(g.pe, -ATM_DELTA));
  if (measure === 'atm') return atm * 100;

  const call = ivAtDelta(g.ce, WING_DELTA);
  const put = ivAtDelta(g.pe, -WING_DELTA);
  if (!Number.isFinite(call) || !Number.isFinite(put)) return NaN;

  // Risk reversal = call wing minus put wing (skew). Butterfly = wing average over ATM (smile).
  if (measure === 'rr25') return (call - put) * 100;
  if (!Number.isFinite(atm)) return NaN;
  return (0.5 * (call + put) - atm) * 100;
}

/**
 * Build a constant-delta IV series. Each selected expiry is interpolated separately and the
 * per-expiry measures are averaged, since the same delta on two expiries carries different
 * IVs and pooling their strikes would smear the surface.
 *
 * Points whose measure cannot be computed are omitted, leaving a visible gap.
 */
export function buildIvSeries(
  snapshots: ReadonlyArray<ChainSnapshot>,
  opts: { measure: IvMeasure },
): IvPoint[] {
  const out: IvPoint[] = [];
  for (const snap of [...snapshots].sort((a, b) => a.ts - b.ts)) {
    const perExpiry: number[] = [];
    for (const g of byExpiry(snap).values()) perExpiry.push(measureFor(g, opts.measure));
    const value = meanFinite(...perExpiry);
    if (Number.isFinite(value)) out.push({ ts: snap.ts, value });
  }
  return out;
}
