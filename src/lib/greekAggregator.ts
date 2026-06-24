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
// Greek unit conventions match GexService.ts: theta is per calendar day, vega is
// per 1% (one vol-point) change in IV.

export type OptionType = 'CE' | 'PE';
export type GreekName  = 'vega' | 'theta';
export type Method     = 'mine' | 'industry';
export type Basket     = 'fixed' | 'floating';

// ─── Delta filter boundaries (Spec §1) ───────────────────────────────────────────
export const CE_DELTA_MIN = 0.05;
export const CE_DELTA_MAX = 0.609;
export const PE_DELTA_MIN = -0.609;
export const PE_DELTA_MAX = -0.05;

/** One leg of an option-chain snapshot, reduced to the fields aggregation needs. */
export interface AggLeg {
  sp:     number;   // strike price (rupees)
  delta?: number;
  vega?:  number;
  theta?: number;
  oi?:    number;
  exp?:   string;   // expiry tag — keeps same-strike legs of different expiries distinct
}

/** A full option-chain snapshot at a single timestamp. */
export interface ChainSnapshot {
  ts: number;       // epoch ms
  ce: AggLeg[];
  pe: AggLeg[];
}

export interface AggregateOptions {
  greek:   GreekName;
  method:  Method;
  basket:  Basket;
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
  ts:      number;
  ceTotal: number;   // Spec §2 — cumulative absolute total
  peTotal: number;
  ceDiff:  number;   // Spec §3 — change from the opening baseline
  peDiff:  number;
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
  for (const leg of snapshot.ce) if (qualifies('CE', leg.delta)) keys.add(legKey(leg.sp, 'CE', leg.exp));
  for (const leg of snapshot.pe) if (qualifies('PE', leg.delta)) keys.add(legKey(leg.sp, 'PE', leg.exp));
  return keys;
}

// ─── Per-leg contribution ────────────────────────────────────────────────────────

/** Value a single leg contributes to its side's total under the chosen method. */
function legValue(leg: AggLeg, greek: GreekName, method: Method, lotSize: number): number {
  const g = greek === 'vega' ? leg.vega : leg.theta;
  if (g == null || Number.isNaN(g)) return 0;
  if (method === 'mine') return g;                       // raw per-contract Greek
  return g * (leg.oi ?? 0) * lotSize;                    // notional / dollar-Greek
}

/** Whether a leg is part of the basket at this snapshot, given the membership rule. */
function isMember(
  leg: AggLeg,
  type: OptionType,
  basket: Basket,
  fixedKeys: ReadonlySet<string> | undefined,
): boolean {
  return basket === 'fixed'
    ? !!fixedKeys && fixedKeys.has(legKey(leg.sp, type, leg.exp))  // locked membership
    : qualifies(type, leg.delta);                                 // live re-filter
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

/**
 * Build the full CE/PE total + difference-from-open series across an ordered list
 * of snapshots (Spec §2 totals and §3 differences in one pass).
 *
 *   - The baseline (t_min) is the first snapshot. For "fixed" basket the locked
 *     keys are taken from it; for both baskets the opening totals become the
 *     static constants the difference series subtracts.
 *   - Snapshots are sorted by timestamp internally, so callers may pass historical
 *     (open→now) and live (now→running) ticks concatenated in any order.
 */
export function buildSeries(
  snapshots: ReadonlyArray<ChainSnapshot>,
  opts: Omit<AggregateOptions, 'fixedKeys'>,
): SeriesPoint[] {
  if (snapshots.length === 0) return [];

  const ordered = [...snapshots].sort((a, b) => a.ts - b.ts);
  const baseline = ordered[0];
  const fixedKeys = opts.basket === 'fixed' ? lockBasket(baseline) : undefined;
  const full: AggregateOptions = { ...opts, fixedKeys };

  const base = aggregateSnapshot(baseline, full);

  return ordered.map((snap) => {
    const { ce, pe } = aggregateSnapshot(snap, full);
    return {
      ts:      snap.ts,
      ceTotal: ce,
      peTotal: pe,
      ceDiff:  ce - base.ce,
      peDiff:  pe - base.pe,
    };
  });
}
