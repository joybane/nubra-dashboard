import { test, expect } from 'vitest';
import {
  qualifies,
  legKey,
  lockBasket,
  aggregateSnapshot,
  buildSeries,
  buildIvSeries,
  ivAtDelta,
  snapshotDayKey,
  withinPruneBand,
  CE_DELTA_MIN,
  CE_DELTA_MAX,
  PE_DELTA_MIN,
  PE_DELTA_MAX,
  PRUNE_DELTA_MIN,
  PRUNE_DELTA_MAX,
  CARRY_STALE_MS,
  MEMBERSHIP_DWELL,
  type ChainSnapshot,
} from './greekAggregator.ts';

// ─── §1  Delta filter boundaries ─────────────────────────────────────────────────
test('qualifies: CE band is [0.05, 0.609], PE band is [-0.609, -0.05]', () => {
  // CE
  expect(qualifies('CE', 0.05)).toBe(true); // inclusive lower
  expect(qualifies('CE', 0.609)).toBe(true); // inclusive upper
  expect(qualifies('CE', 0.3)).toBe(true);
  expect(qualifies('CE', 0.049)).toBe(false); // too deep OTM
  expect(qualifies('CE', 0.61)).toBe(false); // too deep ITM
  // PE (mirrored sign)
  expect(qualifies('PE', -0.05)).toBe(true);
  expect(qualifies('PE', -0.609)).toBe(true);
  expect(qualifies('PE', -0.3)).toBe(true);
  expect(qualifies('PE', -0.049)).toBe(false);
  expect(qualifies('PE', -0.61)).toBe(false);
  // missing / NaN never qualifies
  expect(qualifies('CE', undefined)).toBe(false);
  expect(qualifies('PE', NaN)).toBe(false);
});

// ─── Ingest prune band must strictly contain everything downstream reads ─────────
test('prune band contains the qualifying band and both IV interpolation targets', () => {
  // If this ever fails, legs the `fixed` basket or ivAtDelta depend on are being thrown away
  // at ingest and the overlay silently loses data with no error anywhere.
  expect(PRUNE_DELTA_MIN).toBeLessThan(CE_DELTA_MIN);
  expect(PRUNE_DELTA_MAX).toBeGreaterThan(CE_DELTA_MAX);
  expect(-PRUNE_DELTA_MIN).toBeGreaterThan(PE_DELTA_MAX);
  expect(-PRUNE_DELTA_MAX).toBeLessThan(PE_DELTA_MIN);

  // ivAtDelta interpolates at 0.5 and 0.25 and refuses to extrapolate, so the band must
  // bracket both targets with room on either side.
  for (const target of [0.5, 0.25]) {
    expect(PRUNE_DELTA_MIN).toBeLessThan(target);
    expect(PRUNE_DELTA_MAX).toBeGreaterThan(target);
  }

  // Anything the delta filter admits must survive the prune.
  for (const d of [CE_DELTA_MIN, 0.3, CE_DELTA_MAX, PE_DELTA_MIN, -0.3, PE_DELTA_MAX]) {
    expect(withinPruneBand(d), `qualifying delta ${d} must survive`).toBe(true);
  }
  // Far OTM / deep ITM go.
  expect(withinPruneBand(0.001)).toBe(false);
  expect(withinPruneBand(0.99)).toBe(false);
  expect(withinPruneBand(-0.001)).toBe(false);
  // Unknown delta is kept — aggregation decides, not the prune.
  expect(withinPruneBand(undefined)).toBe(true);
  expect(withinPruneBand(NaN)).toBe(true);
});

test('pruning is behaviour-preserving for totals and IV measures', () => {
  const legs = (side: 1 | -1) =>
    Array.from({ length: 40 }, (_, i) => {
      const d = side * (0.005 + i * 0.025); // 0.005 … ~0.98, spans well past the band
      return {
        sp: 23000 + i * 50,
        delta: d,
        vega: 10 + i,
        theta: -1 - i * 0.1,
        oi: 1000 + i,
        iv: 0.12 + i * 0.001,
      };
    });
  const snap: ChainSnapshot = { ts: D1_OPEN, ce: legs(1), pe: legs(-1) };
  const pruned: ChainSnapshot = {
    ts: D1_OPEN,
    ce: snap.ce.filter((l) => withinPruneBand(l.delta)),
    pe: snap.pe.filter((l) => withinPruneBand(l.delta)),
  };
  expect(pruned.ce.length).toBeLessThan(snap.ce.length); // something was actually dropped

  for (const method of ['mine', 'industry'] as const) {
    for (const basket of ['fixed', 'floating'] as const) {
      const a = aggregateSnapshot(snap, {
        greek: 'vega',
        method,
        basket,
        lotSize: 65,
        fixedKeys: lockBasket(snap),
      });
      const b = aggregateSnapshot(pruned, {
        greek: 'vega',
        method,
        basket,
        lotSize: 65,
        fixedKeys: lockBasket(pruned),
      });
      expect(b.ce, `${method}/${basket} ce`).toBeCloseTo(a.ce, 9);
      expect(b.pe, `${method}/${basket} pe`).toBeCloseTo(a.pe, 9);
    }
  }
  for (const measure of ['atm', 'rr25', 'fly25'] as const) {
    expect(buildIvSeries([pruned], { measure })[0].value, measure).toBeCloseTo(
      buildIvSeries([snap], { measure })[0].value,
      9,
    );
  }
});

// ─── §2  Lock the basket at t_min ────────────────────────────────────────────────
test('lockBasket: captures only qualifying (strike,type) keys at t_min', () => {
  const t0: ChainSnapshot = {
    ts: 0,
    ce: [
      { sp: 100, delta: 0.55, vega: 10, theta: -2, oi: 100 }, // in band
      { sp: 110, delta: 0.04, vega: 8, theta: -1, oi: 100 }, // too OTM → excluded
      { sp: 90, delta: 0.7, vega: 12, theta: -3, oi: 100 }, // too ITM → excluded
    ],
    pe: [
      { sp: 100, delta: -0.45, vega: 9, theta: -2, oi: 100 }, // in band
    ],
  };
  const keys = lockBasket(t0);
  expect([...keys].sort()).toEqual([legKey(100, 'CE'), legKey(100, 'PE')].sort());
});

// ─── mine vs industry magnitudes ─────────────────────────────────────────────────
test('aggregateSnapshot: industry = mine × OI × lotSize for a single contract', () => {
  const snap: ChainSnapshot = {
    ts: 0,
    ce: [{ sp: 100, delta: 0.5, vega: 10, theta: -2, oi: 250 }],
    pe: [],
  };
  const mine = aggregateSnapshot(snap, { greek: 'vega', method: 'mine', basket: 'floating' });
  const industry = aggregateSnapshot(snap, {
    greek: 'vega',
    method: 'industry',
    basket: 'floating',
    lotSize: 50,
  });
  expect(mine.ce).toBe(10);
  expect(industry.ce).toBe(10 * 250 * 50);
});

test('aggregateSnapshot: theta uses the theta field, not vega', () => {
  const snap: ChainSnapshot = {
    ts: 0,
    ce: [{ sp: 100, delta: 0.5, vega: 10, theta: -2.5, oi: 1 }],
    pe: [{ sp: 100, delta: -0.5, vega: 9, theta: -1.5, oi: 1 }],
  };
  const r = aggregateSnapshot(snap, { greek: 'theta', method: 'mine', basket: 'floating' });
  expect(r.ce).toBe(-2.5);
  expect(r.pe).toBe(-1.5);
});

// ─── fixed vs floating under delta drift ─────────────────────────────────────────
// Strike 100 CE qualifies at t0 (Δ=0.55) but drifts deep ITM at t1 (Δ=0.80).
// Strike 110 CE is OTM at t0 (Δ=0.04, excluded) but drifts into band at t1 (Δ=0.20).
const drift: ChainSnapshot[] = [
  {
    ts: 1000,
    ce: [
      { sp: 100, delta: 0.55, vega: 10, theta: -2, oi: 1 },
      { sp: 110, delta: 0.04, vega: 5, theta: -1, oi: 1 }, // excluded at t0
    ],
    pe: [],
  },
  {
    ts: 2000,
    ce: [
      { sp: 100, delta: 0.8, vega: 6, theta: -1, oi: 1 }, // drifted ITM
      { sp: 110, delta: 0.2, vega: 7, theta: -2, oi: 1 }, // drifted into band
    ],
    pe: [],
  },
];

test('fixed basket: holds t_min membership despite delta drift', () => {
  const series = buildSeries(drift, { greek: 'vega', method: 'mine', basket: 'fixed' });
  // t0: only strike 100 qualifies → 10
  expect(series[0].ceTotal).toBe(10);
  expect(series[0].ceDiff).toBe(0);
  // t1: still ONLY strike 100 (locked), now vega 6; strike 110 ignored though it qualifies live
  expect(series[1].ceTotal).toBe(6);
  expect(series[1].ceDiff).toBe(6 - 10); // -4
});

test('floating basket: re-filters live so membership churns', () => {
  const series = buildSeries(drift, { greek: 'vega', method: 'mine', basket: 'floating' });
  // t0: only strike 100 in band → 10
  expect(series[0].ceTotal).toBe(10);
  // t1: strike 100 left the band, strike 110 entered → only 110 counts → 7
  expect(series[1].ceTotal).toBe(7);
  expect(series[1].ceDiff).toBe(7 - 10); // -3
});

// ─── §3  Difference from open + unordered input ──────────────────────────────────
test('buildSeries: baseline is earliest ts even if snapshots passed out of order', () => {
  const out: ChainSnapshot[] = [
    { ts: 3000, ce: [{ sp: 100, delta: 0.5, vega: 20, theta: -2, oi: 1 }], pe: [] },
    { ts: 1000, ce: [{ sp: 100, delta: 0.5, vega: 12, theta: -2, oi: 1 }], pe: [] }, // open
    { ts: 2000, ce: [{ sp: 100, delta: 0.5, vega: 15, theta: -2, oi: 1 }], pe: [] },
  ];
  const series = buildSeries(out, { greek: 'vega', method: 'mine', basket: 'floating' });
  expect(series.map((p) => p.ts)).toEqual([1000, 2000, 3000]); // sorted
  expect(series[0].ceDiff).toBe(0); // baseline = 12
  expect(series[1].ceDiff).toBe(15 - 12); // +3
  expect(series[2].ceDiff).toBe(20 - 12); // +8
});

test('buildSeries: empty input yields empty series', () => {
  expect(buildSeries([], { greek: 'vega', method: 'mine', basket: 'fixed' })).toEqual([]);
});

// ─── Baseline: session vs window ─────────────────────────────────────────────────
// Two IST trading days. 09:20 IST = 03:50 UTC, 15:00 IST = 09:30 UTC.
const D1_OPEN = Date.UTC(2026, 6, 27, 3, 50);
const D1_LATE = Date.UTC(2026, 6, 27, 9, 30);
const D2_OPEN = Date.UTC(2026, 6, 28, 3, 50);
const D2_LATE = Date.UTC(2026, 6, 28, 9, 30);

const ce = (vega: number, delta = 0.5, sp = 100) => ({ sp, delta, vega, theta: -2, oi: 1 });

const twoDays: ChainSnapshot[] = [
  { ts: D1_OPEN, ce: [ce(10)], pe: [] },
  { ts: D1_LATE, ce: [ce(14)], pe: [] },
  { ts: D2_OPEN, ce: [ce(30)], pe: [] }, // day 2 opens at a different level
  { ts: D2_LATE, ce: [ce(36)], pe: [] },
];

test('snapshotDayKey: buckets epoch-ms into IST calendar days', () => {
  expect(snapshotDayKey(D1_OPEN)).toBe('2026-07-27');
  expect(snapshotDayKey(D1_LATE)).toBe('2026-07-27');
  expect(snapshotDayKey(D2_OPEN)).toBe('2026-07-28');
});

test('baseline session: diff re-anchors at each session open', () => {
  const s = buildSeries(twoDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    baseline: 'session',
  });
  expect(s[0].ceDiff).toBe(0); // day 1 open
  expect(s[1].ceDiff).toBe(14 - 10); // +4 within day 1
  expect(s[2].ceDiff).toBe(0); // day 2 re-anchors, NOT 30 - 10
  expect(s[3].ceDiff).toBe(36 - 30); // +6 within day 2
});

test('baseline window: diff runs cumulatively from the first snapshot', () => {
  const s = buildSeries(twoDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    baseline: 'window',
  });
  expect(s[0].ceDiff).toBe(0);
  expect(s[1].ceDiff).toBe(14 - 10);
  expect(s[2].ceDiff).toBe(30 - 10); // +20 — carries across the day boundary
  expect(s[3].ceDiff).toBe(36 - 10); // +26
});

test('baseline defaults to session', () => {
  const dflt = buildSeries(twoDays, { greek: 'vega', method: 'mine', basket: 'floating' });
  const explicit = buildSeries(twoDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    baseline: 'session',
  });
  expect(dflt).toEqual(explicit);
});

// Strike 100 qualifies on day 1 then drifts deep ITM; strike 110 is out of band on day 1
// but in band on day 2. Under 'session' the basket re-locks each morning, so day 2 tracks
// 110; under 'window' it stays welded to day 1's pick.
const driftAcrossDays: ChainSnapshot[] = [
  { ts: D1_OPEN, ce: [ce(10, 0.55, 100), ce(5, 0.04, 110)], pe: [] },
  { ts: D2_OPEN, ce: [ce(6, 0.8, 100), ce(7, 0.2, 110)], pe: [] },
];

test('baseline session: fixed basket re-locks membership each day', () => {
  const s = buildSeries(driftAcrossDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'fixed',
    baseline: 'session',
  });
  expect(s[0].ceTotal).toBe(10); // day 1 locks strike 100
  expect(s[1].ceTotal).toBe(7); // day 2 re-locks onto strike 110 (the one in band)
});

test('baseline window: fixed basket stays locked to the first day', () => {
  const s = buildSeries(driftAcrossDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'fixed',
    baseline: 'window',
  });
  expect(s[0].ceTotal).toBe(10);
  expect(s[1].ceTotal).toBe(6); // still strike 100, now deep ITM
});

test('baseline does not affect floating totals — mine is unchanged', () => {
  const session = buildSeries(twoDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    baseline: 'session',
  });
  const window = buildSeries(twoDays, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    baseline: 'window',
  });
  expect(session.map((p) => p.ceTotal)).toEqual(window.map((p) => p.ceTotal));
  expect(session.map((p) => p.ceTotal)).toEqual([10, 14, 30, 36]);
  // industry likewise: the method weighting is untouched by the baseline
  const ind = buildSeries(twoDays, {
    greek: 'vega',
    method: 'industry',
    basket: 'floating',
    lotSize: 50,
    baseline: 'session',
  });
  expect(ind.map((p) => p.ceTotal)).toEqual([10 * 50, 14 * 50, 30 * 50, 36 * 50]);
});

// ─── Constant-delta IV ───────────────────────────────────────────────────────────
test('ivAtDelta: interpolates linearly and refuses to extrapolate', () => {
  const legs = [
    { sp: 105, delta: 0.2, iv: 0.18 },
    { sp: 100, delta: 0.5, iv: 0.14 },
    { sp: 95, delta: 0.8, iv: 0.16 },
  ];
  expect(ivAtDelta(legs, 0.5)).toBeCloseTo(0.14, 8);
  expect(ivAtDelta(legs, 0.35)).toBeCloseTo(0.16, 8); // midway between 0.20 and 0.50
  expect(ivAtDelta(legs, 0.05)).toBeNaN(); // outside the strikes present
  expect(ivAtDelta(legs, 0.95)).toBeNaN();
  expect(ivAtDelta([{ sp: 100, delta: 0.5, iv: 0.14 }], 0.5)).toBeNaN(); // needs two points
  expect(
    ivAtDelta(
      [
        { sp: 100, delta: 0.5 },
        { sp: 105, delta: 0.2 },
      ],
      0.3,
    ),
  ).toBeNaN(); // no iv
});

/** Flat smile at `iv` across both sides, wide enough in delta to cover 25Δ and 50Δ. */
function flatSmile(ts: number, iv: number): ChainSnapshot {
  return {
    ts,
    ce: [
      { sp: 105, delta: 0.15, iv },
      { sp: 100, delta: 0.5, iv },
      { sp: 95, delta: 0.85, iv },
    ],
    pe: [
      { sp: 95, delta: -0.15, iv },
      { sp: 100, delta: -0.5, iv },
      { sp: 105, delta: -0.85, iv },
    ],
  };
}

test('buildIvSeries: ATM recovers the level of a flat smile, in vol points', () => {
  const s = buildIvSeries([flatSmile(D1_OPEN, 0.1905)], { measure: 'atm' });
  expect(s).toHaveLength(1);
  expect(s[0].value).toBeCloseTo(19.05, 6); // decimal in, percent out
});

test('buildIvSeries: flat smile has zero skew and zero smile', () => {
  const snap = [flatSmile(D1_OPEN, 0.2)];
  expect(buildIvSeries(snap, { measure: 'rr25' })[0].value).toBeCloseTo(0, 6);
  expect(buildIvSeries(snap, { measure: 'fly25' })[0].value).toBeCloseTo(0, 6);
});

test('buildIvSeries: 25Δ risk reversal signs with the skew direction', () => {
  // Puts bid over calls (the usual index shape) → negative risk reversal.
  const putSkew: ChainSnapshot = {
    ts: D1_OPEN,
    ce: [
      { sp: 105, delta: 0.15, iv: 0.16 },
      { sp: 100, delta: 0.5, iv: 0.18 },
      { sp: 95, delta: 0.85, iv: 0.2 },
    ],
    pe: [
      { sp: 95, delta: -0.15, iv: 0.26 },
      { sp: 100, delta: -0.5, iv: 0.18 },
      { sp: 105, delta: -0.85, iv: 0.14 },
    ],
  };
  expect(buildIvSeries([putSkew], { measure: 'rr25' })[0].value).toBeLessThan(0);

  // Mirror it → calls bid over puts → positive.
  const callSkew: ChainSnapshot = {
    ts: D1_OPEN,
    ce: putSkew.pe.map((l) => ({ ...l, delta: -l.delta! })),
    pe: putSkew.ce.map((l) => ({ ...l, delta: -l.delta! })),
  };
  expect(buildIvSeries([callSkew], { measure: 'rr25' })[0].value).toBeGreaterThan(0);
});

test('buildIvSeries: butterfly is positive when wings sit above ATM', () => {
  const smile: ChainSnapshot = {
    ts: D1_OPEN,
    ce: [
      { sp: 105, delta: 0.15, iv: 0.26 },
      { sp: 100, delta: 0.5, iv: 0.18 },
      { sp: 95, delta: 0.85, iv: 0.26 },
    ],
    pe: [
      { sp: 95, delta: -0.15, iv: 0.26 },
      { sp: 100, delta: -0.5, iv: 0.18 },
      { sp: 105, delta: -0.85, iv: 0.26 },
    ],
  };
  expect(buildIvSeries([smile], { measure: 'fly25' })[0].value).toBeGreaterThan(0);
});

test('buildIvSeries: omits snapshots whose measure cannot be computed', () => {
  const thin: ChainSnapshot = { ts: D1_LATE, ce: [{ sp: 100, delta: 0.5, iv: 0.2 }], pe: [] };
  const series = buildIvSeries([flatSmile(D1_OPEN, 0.2), thin], { measure: 'atm' });
  expect(series.map((p) => p.ts)).toEqual([D1_OPEN]); // the thin snapshot is dropped, not faked
});

test('buildIvSeries: averages each expiry separately rather than pooling strikes', () => {
  // Same deltas on two expiries carrying different IVs — pooling would smear them together.
  const multi: ChainSnapshot = {
    ts: D1_OPEN,
    ce: [
      { sp: 105, delta: 0.15, iv: 0.1, exp: 'A' },
      { sp: 100, delta: 0.5, iv: 0.1, exp: 'A' },
      { sp: 95, delta: 0.85, iv: 0.1, exp: 'A' },
      { sp: 105, delta: 0.15, iv: 0.3, exp: 'B' },
      { sp: 100, delta: 0.5, iv: 0.3, exp: 'B' },
      { sp: 95, delta: 0.85, iv: 0.3, exp: 'B' },
    ],
    pe: [
      { sp: 95, delta: -0.15, iv: 0.1, exp: 'A' },
      { sp: 100, delta: -0.5, iv: 0.1, exp: 'A' },
      { sp: 105, delta: -0.85, iv: 0.1, exp: 'A' },
      { sp: 95, delta: -0.15, iv: 0.3, exp: 'B' },
      { sp: 100, delta: -0.5, iv: 0.3, exp: 'B' },
      { sp: 105, delta: -0.85, iv: 0.3, exp: 'B' },
    ],
  };
  // Mean of the two flat surfaces: (10 + 30) / 2 = 20 vol points.
  expect(buildIvSeries([multi], { measure: 'atm' })[0].value).toBeCloseTo(20, 6);
});

// ─── Carry-forward: a gap in the data is not a zero ──────────────────────────────
const MIN = 60_000;
const totals = (s: ChainSnapshot[], composition?: 'raw' | 'chained') =>
  buildSeries(s, { greek: 'vega', method: 'mine', basket: 'floating', composition }).map(
    (p) => p.ceTotal,
  );

test('carry: a leg missing its vega for one snapshot holds its last value', () => {
  // The broker's 1m series is per-field, so delta can print without vega. Before carryLeg
  // this leg still qualified (it has a delta) but contributed 0 — a one-bar hole in the total.
  const s: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [{ sp: 100, delta: 0.5, vega: 10, theta: -2, oi: 1 }], pe: [] },
    { ts: D1_OPEN + MIN, ce: [{ sp: 100, delta: 0.5, oi: 1 }], pe: [] }, // vega absent
    { ts: D1_OPEN + 2 * MIN, ce: [{ sp: 100, delta: 0.5, vega: 12, theta: -2, oi: 1 }], pe: [] },
  ];
  expect(totals(s)).toEqual([10, 10, 12]);
});

test('carry: a leg absent from a snapshot entirely still counts', () => {
  const s: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [ce(10, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
    { ts: D1_OPEN + MIN, ce: [ce(10, 0.5, 100)], pe: [] }, // strike 110 did not print
  ];
  expect(totals(s)).toEqual([17, 17]);
});

test('carry: a leg silent past CARRY_STALE_MS is dropped, not carried forever', () => {
  const s: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [ce(10, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
    { ts: D1_OPEN + CARRY_STALE_MS + MIN, ce: [ce(10, 0.5, 100)], pe: [] },
  ];
  expect(totals(s)).toEqual([17, 10]);
});

test('carry: theta and oi are carried per-field too, so industry survives a gap', () => {
  const s: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [{ sp: 100, delta: 0.5, vega: 10, theta: -2, oi: 300 }], pe: [] },
    { ts: D1_OPEN + MIN, ce: [{ sp: 100, delta: 0.5 }], pe: [] }, // everything but delta gone
  ];
  const ind = buildSeries(s, {
    greek: 'theta',
    method: 'industry',
    basket: 'floating',
    lotSize: 50,
  });
  expect(ind.map((p) => p.ceTotal)).toEqual([-2 * 300 * 50, -2 * 300 * 50]);
});

// ─── Chaining: membership changes must not step the level ────────────────────────
// Strike 100 is in band throughout and its vega walks 10 → 13. Strike 110 is in band from
// t1 onward, so under `raw` the total jumps by 7 when it joins.
const joiner: ChainSnapshot[] = [
  { ts: D1_OPEN, ce: [ce(10, 0.5, 100)], pe: [] },
  { ts: D1_OPEN + MIN, ce: [ce(11, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
  { ts: D1_OPEN + 2 * MIN, ce: [ce(12, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
  { ts: D1_OPEN + 3 * MIN, ce: [ce(13, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
];

test('composition defaults to raw — buildSeries output is unchanged without opting in', () => {
  const dflt = buildSeries(joiner, { greek: 'vega', method: 'mine', basket: 'floating' });
  const raw = buildSeries(joiner, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    composition: 'raw',
  });
  expect(dflt).toEqual(raw);
  expect(dflt.map((p) => p.ceTotal)).toEqual([10, 18, 19, 20]); // the step at t1 is real
});

test('chained: a leg joining the basket adds no step — only Greek movement survives', () => {
  // 110 joins at t1 but the dwell timer holds it out until t2, where the splice absorbs it.
  // What is left is exactly strike 100's own vega path.
  expect(totals(joiner, 'chained')).toEqual([10, 11, 12, 13]);
});

test('chained: the diff series tracks Greek movement, not composition', () => {
  const s = buildSeries(joiner, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    composition: 'chained',
  });
  expect(s.map((p) => p.ceDiff)).toEqual([0, 1, 2, 3]);
});

test('chained: a leg leaving the basket adds no step either', () => {
  const leaver: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [ce(10, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
    { ts: D1_OPEN + MIN, ce: [ce(11, 0.5, 100), ce(7, 0.04, 110)], pe: [] }, // 110 leaves band
    { ts: D1_OPEN + 2 * MIN, ce: [ce(12, 0.5, 100), ce(7, 0.04, 110)], pe: [] },
    { ts: D1_OPEN + 3 * MIN, ce: [ce(13, 0.5, 100), ce(7, 0.04, 110)], pe: [] },
  ];
  expect(totals(leaver)).toEqual([17, 11, 12, 13]); // raw drops 110 the instant it leaves
  expect(totals(leaver, 'chained')).toEqual([17, 18, 19, 20]); // chained keeps walking
});

test('dwell: a one-snapshot excursion across the edge does not flip membership', () => {
  const blip: ChainSnapshot[] = [
    { ts: D1_OPEN, ce: [ce(10, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
    { ts: D1_OPEN + MIN, ce: [ce(10, 0.5, 100), ce(7, 0.04, 110)], pe: [] }, // one bar out
    { ts: D1_OPEN + 2 * MIN, ce: [ce(10, 0.5, 100), ce(7, 0.2, 110)], pe: [] }, // back in
  ];
  expect(totals(blip)).toEqual([17, 10, 17]); // raw shows the hole
  expect(totals(blip, 'chained')).toEqual([17, 17, 17]); // dwell absorbs it, no splice at all
  expect(MEMBERSHIP_DWELL).toBeGreaterThan(1); // the above is only true for a real dwell
});

test('chained: session re-anchor zeroes the offset so drift cannot cross days', () => {
  const twoSessions: ChainSnapshot[] = [
    ...joiner, // day 1 accumulates an offset of -7
    { ts: D2_OPEN, ce: [ce(30, 0.5, 100), ce(7, 0.2, 110)], pe: [] },
  ];
  const s = buildSeries(twoSessions, {
    greek: 'vega',
    method: 'mine',
    basket: 'floating',
    composition: 'chained',
    baseline: 'session',
  });
  expect(s[4].ceTotal).toBe(37); // day 2 opens on its own raw sum, offset discarded
  expect(s[4].ceDiff).toBe(0);
});

test('chained: a fixed basket has no membership churn, so it is a no-op', () => {
  for (const baseline of ['session', 'window'] as const) {
    const raw = buildSeries(driftAcrossDays, {
      greek: 'vega',
      method: 'mine',
      basket: 'fixed',
      baseline,
    });
    const chained = buildSeries(driftAcrossDays, {
      greek: 'vega',
      method: 'mine',
      basket: 'fixed',
      baseline,
      composition: 'chained',
    });
    expect(chained, baseline).toEqual(raw);
  }
});
