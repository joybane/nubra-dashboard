// Run:  node --experimental-strip-types --test src/lib/greekAggregator.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  qualifies,
  legKey,
  lockBasket,
  aggregateSnapshot,
  buildSeries,
  type ChainSnapshot,
} from './greekAggregator.ts';

// ─── §1  Delta filter boundaries ─────────────────────────────────────────────────
test('qualifies: CE band is [0.05, 0.609], PE band is [-0.609, -0.05]', () => {
  // CE
  assert.equal(qualifies('CE', 0.05), true);    // inclusive lower
  assert.equal(qualifies('CE', 0.609), true);   // inclusive upper
  assert.equal(qualifies('CE', 0.30), true);
  assert.equal(qualifies('CE', 0.049), false);  // too deep OTM
  assert.equal(qualifies('CE', 0.61), false);   // too deep ITM
  // PE (mirrored sign)
  assert.equal(qualifies('PE', -0.05), true);
  assert.equal(qualifies('PE', -0.609), true);
  assert.equal(qualifies('PE', -0.30), true);
  assert.equal(qualifies('PE', -0.049), false);
  assert.equal(qualifies('PE', -0.61), false);
  // missing / NaN never qualifies
  assert.equal(qualifies('CE', undefined), false);
  assert.equal(qualifies('PE', NaN), false);
});

// ─── §2  Lock the basket at t_min ────────────────────────────────────────────────
test('lockBasket: captures only qualifying (strike,type) keys at t_min', () => {
  const t0: ChainSnapshot = {
    ts: 0,
    ce: [
      { sp: 100, delta: 0.55, vega: 10, theta: -2, oi: 100 }, // in band
      { sp: 110, delta: 0.04, vega: 8,  theta: -1, oi: 100 }, // too OTM → excluded
      { sp: 90,  delta: 0.70, vega: 12, theta: -3, oi: 100 }, // too ITM → excluded
    ],
    pe: [
      { sp: 100, delta: -0.45, vega: 9, theta: -2, oi: 100 }, // in band
    ],
  };
  const keys = lockBasket(t0);
  assert.deepEqual([...keys].sort(), [legKey(100, 'CE'), legKey(100, 'PE')].sort());
});

// ─── mine vs industry magnitudes ─────────────────────────────────────────────────
test('aggregateSnapshot: industry = mine × OI × lotSize for a single contract', () => {
  const snap: ChainSnapshot = {
    ts: 0,
    ce: [{ sp: 100, delta: 0.50, vega: 10, theta: -2, oi: 250 }],
    pe: [],
  };
  const mine = aggregateSnapshot(snap, { greek: 'vega', method: 'mine', basket: 'floating' });
  const industry = aggregateSnapshot(snap, { greek: 'vega', method: 'industry', basket: 'floating', lotSize: 50 });
  assert.equal(mine.ce, 10);
  assert.equal(industry.ce, 10 * 250 * 50);
});

test('aggregateSnapshot: theta uses the theta field, not vega', () => {
  const snap: ChainSnapshot = {
    ts: 0,
    ce: [{ sp: 100, delta: 0.50, vega: 10, theta: -2.5, oi: 1 }],
    pe: [{ sp: 100, delta: -0.50, vega: 9, theta: -1.5, oi: 1 }],
  };
  const r = aggregateSnapshot(snap, { greek: 'theta', method: 'mine', basket: 'floating' });
  assert.equal(r.ce, -2.5);
  assert.equal(r.pe, -1.5);
});

// ─── fixed vs floating under delta drift ─────────────────────────────────────────
// Strike 100 CE qualifies at t0 (Δ=0.55) but drifts deep ITM at t1 (Δ=0.80).
// Strike 110 CE is OTM at t0 (Δ=0.04, excluded) but drifts into band at t1 (Δ=0.20).
const drift: ChainSnapshot[] = [
  {
    ts: 1000,
    ce: [
      { sp: 100, delta: 0.55, vega: 10, theta: -2, oi: 1 },
      { sp: 110, delta: 0.04, vega: 5,  theta: -1, oi: 1 }, // excluded at t0
    ],
    pe: [],
  },
  {
    ts: 2000,
    ce: [
      { sp: 100, delta: 0.80, vega: 6, theta: -1, oi: 1 }, // drifted ITM
      { sp: 110, delta: 0.20, vega: 7, theta: -2, oi: 1 }, // drifted into band
    ],
    pe: [],
  },
];

test('fixed basket: holds t_min membership despite delta drift', () => {
  const series = buildSeries(drift, { greek: 'vega', method: 'mine', basket: 'fixed' });
  // t0: only strike 100 qualifies → 10
  assert.equal(series[0].ceTotal, 10);
  assert.equal(series[0].ceDiff, 0);
  // t1: still ONLY strike 100 (locked), now vega 6; strike 110 ignored though it qualifies live
  assert.equal(series[1].ceTotal, 6);
  assert.equal(series[1].ceDiff, 6 - 10); // -4
});

test('floating basket: re-filters live so membership churns', () => {
  const series = buildSeries(drift, { greek: 'vega', method: 'mine', basket: 'floating' });
  // t0: only strike 100 in band → 10
  assert.equal(series[0].ceTotal, 10);
  // t1: strike 100 left the band, strike 110 entered → only 110 counts → 7
  assert.equal(series[1].ceTotal, 7);
  assert.equal(series[1].ceDiff, 7 - 10); // -3
});

// ─── §3  Difference from open + unordered input ──────────────────────────────────
test('buildSeries: baseline is earliest ts even if snapshots passed out of order', () => {
  const out: ChainSnapshot[] = [
    { ts: 3000, ce: [{ sp: 100, delta: 0.5, vega: 20, theta: -2, oi: 1 }], pe: [] },
    { ts: 1000, ce: [{ sp: 100, delta: 0.5, vega: 12, theta: -2, oi: 1 }], pe: [] }, // open
    { ts: 2000, ce: [{ sp: 100, delta: 0.5, vega: 15, theta: -2, oi: 1 }], pe: [] },
  ];
  const series = buildSeries(out, { greek: 'vega', method: 'mine', basket: 'floating' });
  assert.deepEqual(series.map(p => p.ts), [1000, 2000, 3000]); // sorted
  assert.equal(series[0].ceDiff, 0);        // baseline = 12
  assert.equal(series[1].ceDiff, 15 - 12);  // +3
  assert.equal(series[2].ceDiff, 20 - 12);  // +8
});

test('buildSeries: empty input yields empty series', () => {
  assert.deepEqual(buildSeries([], { greek: 'vega', method: 'mine', basket: 'fixed' }), []);
});
