import { test, expect } from 'vitest';
import {
  DTE_BUCKETS,
  MIN_SAMPLE,
  bucketFor,
  computeIvRank,
  dteFromExpiry,
  type IvObservation,
} from './ivRank.ts';

/** N observations at one DTE with the given IVs, dates walking backwards from 2026-06-01. */
function obs(dte: number, ivs: number[]): IvObservation[] {
  return ivs.map((iv, i) => ({
    date: new Date(Date.UTC(2026, 5, 1) - i * 86_400_000).toISOString().slice(0, 10),
    dte,
    iv,
  }));
}

const flat = (dte: number, n: number, iv: number) => obs(dte, Array(n).fill(iv));

test('buckets tile every rankable DTE with no gaps and no overlaps', () => {
  for (let d = 1; d <= 400; d++) {
    const hits = DTE_BUCKETS.filter((b) => d >= b.min && d <= b.max);
    expect(hits.length, `dte ${d} matched ${hits.length} buckets`).toBe(1);
  }
  expect(bucketFor(-1)).toBeNull();
  expect(bucketFor(NaN)).toBeNull();
  expect(bucketFor(1)!.key).toBe('1-2');
  expect(bucketFor(31)!.key).toBe('16-31');
  expect(bucketFor(90)!.key).toBe('32+');
});

/**
 * Expiry day must not rank. The 0-DTE ATM premium is nearly all remaining-minutes, so it
 * inverts to a collapsing vol (measured: 14.1 → 0.4 across one afternoon on 2025-11-04).
 * Ranked against 1-2 DTE history it would report a fresh 1-year low every expiry day.
 */
test('refuses to rank a 0-DTE selection instead of comparing it to 1-2 DTE history', () => {
  expect(bucketFor(0)).toBeNull();
  const sample = obs(
    1,
    Array.from({ length: 60 }, (_, i) => 12 + i * 0.1),
  );
  const r = computeIvRank(sample, 0, 4.2); // a typical expiry-afternoon reading
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.gap.reason).toBe('expiry-day');
  expect(r.gap.detail).toContain('countdown');
});

test('rank places the reading in the range, percentile in the distribution', () => {
  // 0..99 in steps of 1, all at 5 DTE. Reading 25 sits a quarter up the range and, because the
  // sample is uniform, a quarter of the way through the distribution too.
  const sample = obs(
    5,
    Array.from({ length: 100 }, (_, i) => i),
  );
  const r = computeIvRank(sample, 5, 25);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.stats.rank).toBeCloseTo((25 / 99) * 100, 6);
  expect(r.stats.percentile).toBeCloseTo(26, 6); // 0..25 inclusive = 26 of 100
  expect(r.stats.min).toBe(0);
  expect(r.stats.max).toBe(99);
  expect(r.stats.median).toBeCloseTo(49.5, 6);
  expect(r.stats.count).toBe(100);
});

/**
 * The reason both numbers are shown. One crisis print stretches the range so a genuinely
 * expensive reading looks mid-pack on rank, while percentile still calls it high.
 */
test('an outlier splits rank from percentile — which is the point of showing both', () => {
  const sample = obs(5, [
    ...Array(99)
      .fill(0)
      .map((_, i) => 10 + i * 0.05),
    60,
  ]);
  const r = computeIvRank(sample, 5, 14.5);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.stats.rank).toBeLessThan(15); // range dominated by the 60 print
  expect(r.stats.percentile).toBeGreaterThan(85); // but above nearly every session
});

test('a reading past the historical extreme clamps to 0/100 and the range shows why', () => {
  const sample = obs(
    5,
    Array.from({ length: 40 }, (_, i) => 12 + i * 0.1),
  );
  const hi = computeIvRank(sample, 5, 99);
  const lo = computeIvRank(sample, 5, 1);
  expect(hi.ok && hi.stats.rank).toBe(100);
  expect(hi.ok && hi.stats.percentile).toBe(100);
  expect(lo.ok && lo.stats.rank).toBe(0);
  expect(lo.ok && lo.stats.percentile).toBe(0);
  expect(hi.ok && hi.stats.max).toBeCloseTo(15.9, 6); // current (99) is outside it, visibly
});

/**
 * The core guard: index IV rises mechanically into expiry, so a 20-DTE reading must never be
 * ranked against the 0-DTE band. Same reading, two maturities, two verdicts.
 */
test('ranks only within the matching maturity band', () => {
  const sample = [
    ...obs(
      1,
      Array.from({ length: 30 }, (_, i) => 30 + i * 0.5),
    ), // expiry week: 30.0–44.5
    ...obs(
      20,
      Array.from({ length: 30 }, (_, i) => 10 + i * (5 / 29)),
    ), // run-up: 10.0–15.0
  ];
  const near = computeIvRank(sample, 1, 15);
  const far = computeIvRank(sample, 20, 15);
  expect(near.ok && near.stats.count).toBe(30);
  expect(far.ok && far.stats.count).toBe(30);
  expect(near.ok && near.stats.rank).toBe(0); // 15 is cheap for expiry week
  expect(far.ok && far.stats.rank).toBe(100); // the same 15 is dear at 20 DTE
});

test('refuses to rank a thin band instead of borrowing a shorter maturity', () => {
  const sample = [...flat(1, 200, 20), ...flat(60, MIN_SAMPLE - 1, 11)];
  const r = computeIvRank(sample, 60, 11);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.gap.reason).toBe('thin-sample');
  expect(r.gap.detail).toContain(`${MIN_SAMPLE - 1} historical session`);
  // Crucially it did NOT fall through to the well-populated 1-2 band.
  expect(r.gap.reason === 'thin-sample' && r.gap.bucket.key).toBe('32+');
});

test('reports the specific gap when there is no expiry or no live reading', () => {
  const sample = flat(5, 50, 13);
  const noDte = computeIvRank(sample, NaN, 13);
  const noNow = computeIvRank(sample, 5, NaN);
  expect(noDte.ok === false && noDte.gap.reason).toBe('no-dte');
  expect(noNow.ok === false && noNow.gap.reason).toBe('no-current');
});

test('a band with zero range reports mid-rank rather than dividing by zero', () => {
  const r = computeIvRank(flat(5, 30, 12), 5, 12);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(Number.isFinite(r.stats.rank)).toBe(true);
  expect(r.stats.rank).toBe(50);
  expect(r.stats.percentile).toBe(100);
});

test('the sample window reported is the observations used, not the request window', () => {
  const sample = obs(5, Array(40).fill(13)); // dates walk back from 2026-06-01
  const r = computeIvRank(sample, 5, 13);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.stats.to).toBe('2026-06-01');
  expect(r.stats.from).toBe('2026-04-23');
});

test('dteFromExpiry accepts both wire formats and treats expiry morning as 0 DTE', () => {
  const now = Date.UTC(2026, 6, 30, 4, 0); // 09:30 IST on 2026-07-30
  expect(dteFromExpiry('20260730', now)).toBe(0);
  expect(dteFromExpiry('2026-07-30', now)).toBe(0);
  expect(dteFromExpiry('20260806', now)).toBe(7);
  expect(dteFromExpiry('2026-08-25', now)).toBe(26);
  // Never negative: a stale past expiry reads 0 rather than poisoning bucketFor.
  expect(dteFromExpiry('2026-07-01', now)).toBe(0);
  expect(Number.isNaN(dteFromExpiry('not-a-date', now))).toBe(true);
});
