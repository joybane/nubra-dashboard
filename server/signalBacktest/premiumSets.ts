/**
 * Premium sets: where the sellable option prices at a distance from expiry actually bunch.
 *
 * Selling a strike because it is "OTM 2" says nothing about what it pays — on the expiry day that is
 * ₹3, four days out ₹40. A premium seller wants to pick a tier ("around ₹10", "around ₹35") and sell
 * inside it. So for each distance from expiry (trading days: 0 = the expiry day, 1 = the day before…)
 * and each side this takes the entry-minute price of every strike a premium rule could sell
 * (`premiumUniverse`), across all the days at that distance, and finds the tiers those prices fall
 * into, however many there are. Distance from expiry, not weekday, because the expiry weekday has
 * moved: a Monday has been the expiry day, the day before it, or neither.
 *
 * Tiers are found in log price, because a tier is a ratio ("twice the premium"), not a ₹ distance:
 * a smoothed histogram is cut at its valleys, so a gap in the prices separates two sets. Where prices
 * spread evenly with no valley, a set that would span more than `MAX_SPAN` is cut into equal-ratio
 * bands instead (about ±20%: a tier is a price to sell around, not a stretch of the chain), so a set
 * never reads "₹4 – ₹60". Each set reports its typical range (10th–90th
 * percentile, widened outward to a tidy ₹ step), its median, how many prices it holds, and its
 * coverage: on what share of those days at least one strike was priced inside it — which is what
 * decides how often a premium rule finds something to sell.
 */
import type { PremiumUniverse } from './trade.ts';

export interface PremiumSet {
  /** Typical range, ₹, widened outward to a tidy step (0.1 under ₹5, 0.5 under ₹50, 1 above). Picking the set applies it. */
  low: number;
  high: number;
  median: number;
  /** Prices in the set, over all days and strikes. */
  points: number;
  /** % of the days at this distance from expiry on which at least one strike was priced inside [low, high]. */
  coverage: number;
}

export interface ExpiryDaySets {
  /** Trading days to expiry: 0 = the expiry day, 1 = the day before it. */
  dte: number;
  /** Days at this distance that contributed. */
  days: number;
  CE: PremiumSet[];
  PE: PremiumSet[];
}

export interface PremiumSetsResponse {
  /** One entry per distance from expiry seen in the run, nearest to expiry first. */
  expiryDays: ExpiryDaySets[];
}

/** Smoothing width in ln price, ≈ ±10%: prices closer than that count as one bunch. */
const BANDWIDTH = 0.1;
/** A valley at or below this fraction of the smaller neighbouring peak separates two sets. */
const VALLEY_RATIO = 0.8;
/** No set may span more than this ratio (90th ÷ 10th percentile); wider ones are cut into bands. */
const MAX_SPAN = 1.5;
/** A set smaller than this share of the prices (and at least MIN_POINTS) is folded into its neighbour. */
const MIN_SHARE = 0.04;
const MIN_POINTS = 5;
const GRID = 240;

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Cut points (ln price) at the significant valleys of the smoothed distribution. */
function valleyCuts(xs: number[]): number[] {
  const x0 = xs[0] - 3 * BANDWIDTH;
  const x1 = xs[xs.length - 1] + 3 * BANDWIDTH;
  const dx = (x1 - x0) / (GRID - 1);
  const reach = Math.ceil((4 * BANDWIDTH) / dx);
  const density = new Array<number>(GRID).fill(0);
  for (const x of xs) {
    const c = Math.round((x - x0) / dx);
    for (let g = Math.max(0, c - reach); g <= Math.min(GRID - 1, c + reach); g++) {
      const d = (x0 + g * dx - x) / BANDWIDTH;
      density[g] += Math.exp(-0.5 * d * d);
    }
  }

  // Local maxima and minima, ignoring flat stretches. The grid has empty margins on both sides, so
  // the curve rises first and falls last: peaks and valleys alternate, peak first.
  const peaks: number[] = [];
  const valleys: number[] = []; // valleys[i] lies between peaks[i] and peaks[i + 1]
  let dir = 0;
  for (let g = 1; g < GRID; g++) {
    const d = density[g] - density[g - 1];
    if (d === 0) continue;
    const now = d > 0 ? 1 : -1;
    if (dir === 1 && now === -1) peaks.push(g - 1);
    if (dir === -1 && now === 1) valleys.push(g - 1);
    dir = now;
  }
  if (valleys.length !== peaks.length - 1) return [];

  // A valley only counts if it is deep enough. The shallowest too-shallow valley goes first, taking
  // the lower of its two peaks with it, until every remaining valley is deep.
  for (;;) {
    let worst = -1;
    let worstRatio = VALLEY_RATIO;
    for (let i = 0; i < valleys.length; i++) {
      const ratio = density[valleys[i]] / Math.min(density[peaks[i]], density[peaks[i + 1]]);
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = i;
      }
    }
    if (worst < 0) break;
    const drop = density[peaks[worst]] <= density[peaks[worst + 1]] ? worst : worst + 1;
    peaks.splice(drop, 1);
    valleys.splice(worst, 1);
  }
  return valleys.map((g) => x0 + g * dx);
}

/** Fold every group smaller than the floor into whichever neighbour has the closer median. */
function foldSmall(groups: number[][], total: number): number[][] {
  const floor = floorFor(total);
  const med = (g: number[]) => g[Math.floor(g.length / 2)];
  const out = groups.map((g) => [...g]);
  for (;;) {
    if (out.length < 2) return out;
    let small = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].length < floor && (small < 0 || out[i].length < out[small].length)) small = i;
    }
    if (small < 0) return out;
    const left = small > 0 ? Math.abs(Math.log(med(out[small]) / med(out[small - 1]))) : Infinity;
    const right =
      small < out.length - 1 ? Math.abs(Math.log(med(out[small + 1]) / med(out[small]))) : Infinity;
    const into = left <= right ? small - 1 : small + 1;
    out[into] = [...out[into], ...out[small]].sort((a, b) => a - b);
    out.splice(small, 1);
  }
}

/** The share and count below which a set is too thin to be a tier. */
const floorFor = (total: number) => Math.max(MIN_POINTS, Math.ceil(MIN_SHARE * total));

/** Drop every group under the floor — unless that would drop them all, then keep what there is. */
function dropSmall(groups: number[][], total: number): number[][] {
  const kept = groups.filter((g) => g.length >= floorFor(total));
  return kept.length ? kept : groups;
}

/**
 * Cut a group whose typical range spans more than MAX_SPAN into equal-ratio bands. The two end bands
 * also take whatever lies beyond the 10th and 90th percentile, so a band is checked again (and cut
 * again) until every one is within the span — a long tail ends up as bands of its own, not as the
 * far end of a wide one.
 */
function capSpan(group: number[]): number[][] {
  const lo = quantile(group, 0.1);
  const hi = quantile(group, 0.9);
  if (!(lo > 0) || hi / lo <= MAX_SPAN) return [group];
  const bands = Math.ceil(Math.log(hi / lo) / Math.log(MAX_SPAN));
  const edge = (j: number) => lo * Math.pow(hi / lo, j / bands);
  const out: number[][] = Array.from({ length: bands }, () => []);
  for (const p of group) {
    let b = 0;
    while (b < bands - 1 && p >= edge(b + 1)) b++;
    out[b].push(p);
  }
  // A band that took the whole group (all prices equal, or one tail point apart) cannot be cut.
  return out.filter((g) => g.length).flatMap((g) => (g.length === group.length ? [g] : capSpan(g)));
}

/**
 * Split prices into ascending groups: cut at the valleys of the smoothed log-price distribution, fold
 * the tiny ones into a neighbour, then cut any group that is still too wide. Fewer than
 * `MIN_POINTS * 2` prices are returned as the one group they are.
 */
export function groupPrices(prices: number[]): number[][] {
  const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!sorted.length) return [];
  if (sorted.length < MIN_POINTS * 2) return [sorted];
  const cuts = valleyCuts(sorted.map(Math.log));
  const groups: number[][] = Array.from({ length: cuts.length + 1 }, () => []);
  for (const p of sorted) {
    const x = Math.log(p);
    let g = 0;
    while (g < cuts.length && x > cuts[g]) g++;
    groups[g].push(p);
  }
  // Fold the tiny valley groups into a neighbour, cut what is too wide, then leave out the slivers
  // that cutting leaves (a thin tail band): merging them back would only make a wide hybrid.
  const capped = foldSmall(
    groups.filter((g) => g.length),
    sorted.length,
  ).flatMap(capSpan);
  return dropSmall(capped, sorted.length);
}

/**
 * The rounding step for a price: a tenth of a rupee under ₹5, half a rupee under ₹50, a rupee above.
 * Fixed half-rupee steps were a third of the width of a ₹1.5 tier and made neighbours overlap.
 */
const stepFor = (v: number) => (v < 5 ? 0.1 : v < 50 ? 0.5 : 1);
const round2 = (v: number) => Math.round(v * 100) / 100;
const floorNice = (v: number) => round2(Math.floor(v / stepFor(v) + 1e-9) * stepFor(v));
const ceilNice = (v: number) => round2(Math.ceil(v / stepFor(v) - 1e-9) * stepFor(v));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** One weekday-side's sets. `perDay` holds each day's own prices, for the coverage figure. */
export function summariseSets(perDay: number[][]): PremiumSet[] {
  const days = perDay.filter((d) => d.length);
  const groups = groupPrices(days.flat());
  return groups.map((g) => {
    let low = floorNice(quantile(g, 0.1));
    const high = ceilNice(quantile(g, 0.9));
    if (high <= low) low = Math.max(0, round2(high - stepFor(high)));
    const covered = days.filter((d) => d.some((p) => p >= low && p <= high)).length;
    return {
      low,
      high,
      median: r1(quantile(g, 0.5)),
      points: g.length,
      coverage: days.length ? Math.round((covered / days.length) * 100) : 0,
    };
  });
}

/** Collects each day's premium universe, then turns them into sets per expiry distance and side. */
export function createPremiumSetsBuilder() {
  const byDte = new Map<number, { CE: number[][]; PE: number[][] }>();
  return {
    /** `dte`: trading days from the day to its expiry; a day whose distance is unknown is left out. */
    add(dte: number | null, universe: PremiumUniverse): void {
      if (dte == null) return;
      let d = byDte.get(dte);
      if (!d) {
        d = { CE: [], PE: [] };
        byDte.set(dte, d);
      }
      d.CE.push(universe.CE);
      d.PE.push(universe.PE);
    },
    build(): PremiumSetsResponse {
      return {
        expiryDays: [...byDte]
          .sort(([a], [b]) => a - b)
          .map(([dte, d]) => ({
            dte,
            days: Math.max(
              d.CE.filter((x) => x.length).length,
              d.PE.filter((x) => x.length).length,
            ),
            CE: summariseSets(d.CE),
            PE: summariseSets(d.PE),
          })),
      };
    },
  };
}
