// ── IV rank / IV percentile against a DTE-matched historical baseline ────────
//
// Two standard readings of "is vol expensive right now", both computed from the
// observation list `/api/iv-history` returns:
//
//   rank       (current − min) / (max − min) × 100 — where today sits inside the
//              historical RANGE. Sensitive to a single outlier day defining an end.
//   percentile share of historical observations at or below today — where today
//              sits inside the DISTRIBUTION. Robust to outliers; the better of
//              the two when the range has one spike in it.
//
// Both are reported, because they disagree in exactly the situation you want to
// notice: one crisis print can leave rank at 20 while percentile says 85.
//
// Why buckets instead of a constant-maturity series
// ─────────────────────────────────────────────────
// Index IV rises mechanically as expiry approaches, so a range built from mixed
// maturities measures the calendar as much as the vol. The parquet tree cannot
// support a daily constant-maturity series (see server/backtest/ivHistory.ts), so
// observations are grouped into maturity bands and a live reading is ranked only
// within its own band. A far-dated selection whose band holds no data reports no
// rank rather than borrowing a shorter one.

import { expiryInstantMs } from './utils';

export interface IvObservation {
  date: string;
  dte: number;
  iv: number;
}

export interface DteBucket {
  key: string;
  min: number;
  max: number;
  label: string;
}

// Boundaries follow how index options actually behave rather than round numbers:
// 1-2 is the expiry-week gamma regime, 3-7 the rest of a weekly's life, 8-15 and
// 16-31 the two halves of a monthly's run-up.
//
// Bands start at 1, not 0, and that is deliberate. At 0 DTE the ATM premium is
// nearly all remaining-minutes, so its implied vol measures the countdown rather
// than the market — on 2025-11-04 the reading fell 14.1 → 0.4 over one afternoon
// with nothing happening to NIFTY. The server drops 0-DTE observations for that
// reason (MIN_DTE in server/backtest/ivHistory.ts) and this refuses to rank a
// 0-DTE selection, because comparing an expiry-morning reading to 1-2 DTE history
// would report a fresh 1-year low every single expiry day.
export const DTE_BUCKETS: DteBucket[] = [
  { key: '1-2', min: 1, max: 2, label: '1–2 DTE' },
  { key: '3-7', min: 3, max: 7, label: '3–7 DTE' },
  { key: '8-15', min: 8, max: 15, label: '8–15 DTE' },
  { key: '16-31', min: 16, max: 31, label: '16–31 DTE' },
  { key: '32+', min: 32, max: Infinity, label: '32+ DTE' },
];

/** The maturity band a given days-to-expiry falls in. Null for 0 or negative DTE. */
export function bucketFor(dte: number): DteBucket | null {
  if (!Number.isFinite(dte) || dte < 1) return null;
  return DTE_BUCKETS.find((b) => dte >= b.min && dte <= b.max) ?? null;
}

/** Minimum sample before a rank is worth quoting at all. */
export const MIN_SAMPLE = 20;

export interface IvRankStats {
  /** Band the live reading was ranked in. */
  bucket: DteBucket;
  dte: number;
  current: number;
  /** 0-100, clamped: a fresh high reads 100 with `current` above `max`. */
  rank: number;
  /** 0-100, share of the sample at or below `current`. */
  percentile: number;
  min: number;
  max: number;
  median: number;
  count: number;
  /** Date range of the observations actually used. */
  from: string;
  to: string;
}

/** Why no stats could be produced — surfaced verbatim so the UI never guesses. */
export type IvRankGap =
  | { reason: 'no-dte'; detail: string }
  | { reason: 'expiry-day'; detail: string }
  | { reason: 'no-current'; detail: string }
  | { reason: 'thin-sample'; detail: string; bucket: DteBucket; count: number };

export type IvRankResult = { ok: true; stats: IvRankStats } | { ok: false; gap: IvRankGap };

function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return NaN;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rank `current` (vol points) among observations sharing its maturity band.
 *
 * `current` and the observations must be in the same units — both vol points.
 * The parquet stores 12.658 for 12.66 %, and buildIvSeries emits vol points too,
 * so they already agree; see the unit note on IvPoint in greekAggregator.
 */
export function computeIvRank(
  observations: ReadonlyArray<IvObservation>,
  dte: number,
  current: number,
): IvRankResult {
  const bucket = bucketFor(dte);
  if (!bucket) {
    return Number.isFinite(dte) && dte < 1
      ? {
          ok: false,
          gap: {
            reason: 'expiry-day',
            detail: 'expiry-day IV is a countdown, not a vol level — pick a later expiry',
          },
        }
      : { ok: false, gap: { reason: 'no-dte', detail: 'no expiry selected' } };
  }
  if (!Number.isFinite(current)) {
    return { ok: false, gap: { reason: 'no-current', detail: 'no live ATM IV yet' } };
  }

  const inBand = observations.filter(
    (o) => o.dte >= bucket.min && o.dte <= bucket.max && Number.isFinite(o.iv),
  );
  if (inBand.length < MIN_SAMPLE) {
    return {
      ok: false,
      gap: {
        reason: 'thin-sample',
        detail: `only ${inBand.length} historical session${inBand.length === 1 ? '' : 's'} at ${bucket.label}`,
        bucket,
        count: inBand.length,
      },
    };
  }

  const values = inBand.map((o) => o.iv).sort((a, b) => a - b);
  const min = values[0];
  const max = values[values.length - 1];
  const span = max - min;
  // A degenerate band (every session at the same vol) has no range to place a
  // reading inside; call it mid-range rather than dividing by zero.
  const rank = span > 0 ? Math.min(100, Math.max(0, ((current - min) / span) * 100)) : 50;
  const atOrBelow = values.filter((v) => v <= current).length;

  const dates = inBand.map((o) => o.date).sort();
  return {
    ok: true,
    stats: {
      bucket,
      dte,
      current,
      rank,
      percentile: (atOrBelow / values.length) * 100,
      min,
      max,
      median: median(values),
      count: values.length,
      from: dates[0],
      to: dates[dates.length - 1],
    },
  };
}

/**
 * Calendar days from now to an expiry, accepting both wire formats the chain
 * uses ('YYYYMMDD' and 'YYYY-MM-DD'). Expiry is taken as the exchange's close —
 * 15:30 IST on NSE/BSE, 23:30 on MCX — matching yearsToExpiry in useGreekOverlay,
 * so a reading taken on expiry morning is 0 DTE rather than −1.
 */
export function dteFromExpiry(expiry: string, nowMs = Date.now(), exchange?: string): number {
  const end = expiryInstantMs(expiry, exchange);
  if (!Number.isFinite(end)) return NaN;
  return Math.max(0, Math.round((end - nowMs) / 86_400_000));
}
