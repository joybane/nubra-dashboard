import { test, expect } from 'vitest';
import { existsSync } from 'fs';
import path from 'path';
import { DATA_ROOT } from './dataLayer.ts';
import { buildIvHistory, normalizeUnderlying } from './ivHistory.ts';

test('normalizeUnderlying maps the names the frontend actually sends', () => {
  expect(normalizeUnderlying('NIFTY')).toBe('NIFTY');
  expect(normalizeUnderlying('nifty 50')).toBe('NIFTY');
  expect(normalizeUnderlying('NIFTY50')).toBe('NIFTY');
  expect(normalizeUnderlying('SENSEX')).toBe('SENSEX');
  expect(normalizeUnderlying('sensex')).toBe('SENSEX');
});

/**
 * Must NOT fall through to a similarly-named index. Ranking BANKNIFTY vol against NIFTY's range
 * would look completely plausible on screen and be wrong, so an unknown underlying has to return
 * null and let the caller say "no baseline".
 */
test('normalizeUnderlying rejects underlyings we hold no data for', () => {
  for (const s of ['BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'RELIANCE', '', '   ']) {
    expect(normalizeUnderlying(s), s).toBeNull();
  }
});

// The rest reads the real parquet tree. Skipped rather than failed where it is absent, so the
// suite still runs on a checkout without the ~5 years of options data.
const haveData = existsSync(path.join(DATA_ROOT, 'NIFTY'));

test.skipIf(!haveData)(
  'buildIvHistory returns sane, DTE-tagged, in-window observations',
  async () => {
    const res = await buildIvHistory('NIFTY', 365);

    expect(res.und).toBe('NIFTY');
    expect(res.expiriesScanned).toBeGreaterThan(0);
    expect(res.observations.length).toBeGreaterThan(50);

    for (const o of res.observations) {
      expect(
        o.date >= res.from && o.date <= res.to,
        `${o.date} outside ${res.from}..${res.to}`,
      ).toBe(true);
      // 0 DTE is excluded: the reading there tracks remaining minutes, not volatility.
      expect(o.dte, `${o.date} is an expiry-day observation`).toBeGreaterThanOrEqual(1);
      // Plausibility floor. Also catches a units regression (0.126 vs 12.6) instantly.
      expect(o.iv, `${o.date} @${o.dte}`).toBeGreaterThanOrEqual(6);
      expect(o.iv).toBeLessThan(200);
    }

    // Sorted by (date, dte) — the client filters by band and by date range assuming this.
    for (let i = 1; i < res.observations.length; i++) {
      const a = res.observations[i - 1];
      const b = res.observations[i];
      expect(a.date < b.date || (a.date === b.date && a.dte <= b.dte)).toBe(true);
    }

    // One date carries at most one observation per expiry, so duplicates of (date, dte) would mean
    // the same expiry was scanned twice under both flags.
    const seen = new Set(res.observations.map((o) => `${o.date}|${o.dte}`));
    expect(seen.size).toBe(res.observations.length);
  },
);

/**
 * The window has to end where the DATA ends, not at wall-clock today.
 *
 * This tree is a static drop. Anchoring the trailing window to `now` walks it off the end of
 * the data, so the baseline shrinks by a day every day while still calling itself 365 days.
 * Measured 2026-08-14 against a tree stopping 2026-06-01: nominal 365 days, actual 292, and
 * the 1-2 DTE band down to 40 observations from 62 — heading for MIN_SAMPLE, past which
 * src/lib/ivRank.ts stops quoting a rank for expiry week at all.
 *
 * The distribution test below does eventually catch this, but only years after it starts,
 * which is no use. These two assertions fail immediately.
 */
test.skipIf(!haveData)('the window ends where the data ends, not at wall-clock today', async () => {
  const days = 365;
  const res = await buildIvHistory('NIFTY', days);
  const DAY = 86_400_000;

  // `to` may lead the newest observation slightly — a bucket's file stops at its own expiry and
  // 0 DTE is excluded — and on a live tree a weekend or holiday run puts a few days in. Months
  // of gap means the anchor is tracking the calendar instead of the data.
  const newest = res.observations[res.observations.length - 1].date;
  const lead = (Date.parse(res.to) - Date.parse(newest)) / DAY;
  expect(lead, `to=${res.to} but newest observation is ${newest}`).toBeLessThanOrEqual(10);

  // And the observations must actually span the window that was asked for, rather than the
  // leftover slice of it that still overlaps the data.
  const oldest = res.observations[0].date;
  const span = (Date.parse(newest) - Date.parse(oldest)) / DAY;
  expect(span, `${oldest}..${newest} is not ~${days} days of data`).toBeGreaterThan(days - 30);
});

/**
 * The distribution guard. If a future change let 0-DTE readings or vendor bad-days back in, the
 * low tail would sag long before any other test noticed — and a sagging low tail silently
 * inflates every IV rank, because rank is measured off the minimum.
 */
test.skipIf(!haveData)('every maturity band has a plausible distribution', async () => {
  // 365 on purpose: that is IV_RANK_DAYS in useGreekOverlay, so this guards the window the app
  // actually ranks against. A 5-year window has enough mass to hide a sagging recent tail.
  const res = await buildIvHistory('NIFTY', 365);
  const bands: [string, number, number][] = [
    ['1-2', 1, 2],
    ['3-7', 3, 7],
    ['8-15', 8, 15],
    ['16-31', 16, 31],
  ];
  for (const [label, lo, hi] of bands) {
    const v = res.observations
      .filter((o) => o.dte >= lo && o.dte <= hi)
      .map((o) => o.iv)
      .sort((a, b) => a - b);
    // Every band must clear MIN_SAMPLE in src/lib/ivRank.ts by a margin, or the app silently
    // stops offering a rank for that maturity.
    expect(v.length, `${label} sample`).toBeGreaterThan(40);
    const p = (q: number) => v[Math.floor(q * (v.length - 1))];
    // Thresholds are set against measured 1-year values (mins 6.1-8.9, medians 10.2-12.4). They
    // are loose enough not to be brittle but tight enough to catch the failure that matters:
    // 0-DTE readings leaking back in would drag p05 toward 2-5 and the median under 9.
    expect(v[0], `${label} min`).toBeGreaterThanOrEqual(6);
    expect(p(0.05), `${label} p05`).toBeGreaterThan(6);
    expect(p(0.5), `${label} median`).toBeGreaterThan(9);
    expect(p(0.5), `${label} median`).toBeLessThan(25);
  }
});

/**
 * The baseline is inverted with the app's own solver so it is directly comparable to the live
 * reading being ranked. `vendorIv` is carried alongside purely as a witness: it should track the
 * app's number closely, and if it ever stops doing so, either the solver or the vendor feed has
 * moved and the ranking is measuring something other than volatility.
 *
 * Measured 2026-07-30 over 312 one-year observations: mean bias +0.45, mean absolute 0.53.
 * The bounds are deliberately several times that — this is a tripwire, not a fit.
 */
test.skipIf(!haveData)(
  'the inverted baseline stays close to the vendor IV it replaced',
  async () => {
    const res = await buildIvHistory('NIFTY', 365);
    const diffs = res.observations.map((o) => o.iv - o.vendorIv);
    const meanAbs = diffs.reduce((a, d) => a + Math.abs(d), 0) / diffs.length;
    expect(meanAbs, 'mean |app - vendor|').toBeLessThan(2);

    // No wholesale divergence: the bulk of observations must sit within a vol point of each other.
    const close = diffs.filter((d) => Math.abs(d) < 1).length;
    expect(close / diffs.length, 'share within 1 vol point').toBeGreaterThan(0.75);

    for (const o of res.observations) {
      expect(Number.isFinite(o.vendorIv), `${o.date} vendorIv`).toBe(true);
    }
  },
);

test.skipIf(!haveData)('the per-expiry cache makes a repeat call effectively free', async () => {
  await buildIvHistory('NIFTY', 365); // warm
  const t0 = Date.now();
  const res = await buildIvHistory('NIFTY', 365);
  expect(Date.now() - t0).toBeLessThan(400);
  expect(res.observations.length).toBeGreaterThan(50);
});

test.skipIf(!haveData)('a wider window is a superset of a narrower one', async () => {
  const short = await buildIvHistory('NIFTY', 120);
  const long = await buildIvHistory('NIFTY', 700);
  expect(long.observations.length).toBeGreaterThan(short.observations.length);
  const longKeys = new Set(long.observations.map((o) => `${o.date}|${o.dte}|${o.iv}`));
  for (const o of short.observations) {
    expect(longKeys.has(`${o.date}|${o.dte}|${o.iv}`), `${o.date} @${o.dte}`).toBe(true);
  }
});
