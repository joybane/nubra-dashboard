import { test, expect } from 'vitest';
import { calculateLocalBasketMargin, type BasketMarginOrder } from './marginEngine.ts';

// These tests characterize the LOCAL fallback margin engine (used only when the broker
// margin API is unavailable). They assert structural invariants that hold regardless of
// the configurable SPAN/exposure rates, so they stay valid even if the rates are tuned.
// They deliberately do NOT depend on an NSE SPAN risk file being present.

const shortCall = (strike: number, qty: number, ltp = 100): BasketMarginOrder => ({
  order_qty: qty,
  order_side: 'SELL',
  option_type: 'CE',
  strike,
  ltp,
  symbol: 'NIFTY',
  expiry: '20250130',
});

const longCall = (strike: number, qty: number, ltp = 50): BasketMarginOrder => ({
  order_qty: qty,
  order_side: 'BUY',
  option_type: 'CE',
  strike,
  ltp,
  symbol: 'NIFTY',
  expiry: '20250130',
});

test('returns null when no leg is a valid option (missing strike / type)', () => {
  expect(calculateLocalBasketMargin([])).toBeNull();
  expect(calculateLocalBasketMargin([{ order_qty: 50, order_side: 'SELL' }])).toBeNull();
});

test('naked short: total = span + exposure + premium, all integer paise, span > 0', () => {
  const r = calculateLocalBasketMargin([shortCall(20000, 50)])!;
  expect(r).not.toBeNull();
  expect(r.source).toBe('local-conservative-fallback');
  expect(r.span).toBeGreaterThan(0);
  expect(r.exposure).toBeGreaterThan(0);
  expect(r.opt_prem).toBe(0); // premium payable counts BUY legs only
  expect(r.total_margin).toBe(r.span + r.exposure + r.opt_prem);
  for (const v of [r.total_margin, r.span, r.exposure, r.opt_prem, r.margin_benefit]) {
    expect(Number.isInteger(v)).toBe(true); // paise are whole numbers
  }
});

test('long option: premium payable is captured in opt_prem (paise)', () => {
  const r = calculateLocalBasketMargin([longCall(20000, 50, 50)])!;
  expect(r).not.toBeNull();
  expect(r.opt_prem).toBe(Math.round(50 * 50 * 100)); // ltp × qty → paise
  expect(r.total_margin).toBe(r.span + r.exposure + r.opt_prem);
});

test('vertical spread earns a margin benefit vs the naked short alone', () => {
  const naked = calculateLocalBasketMargin([shortCall(20000, 50)])!;
  const spread = calculateLocalBasketMargin([shortCall(20000, 50), longCall(20200, 50, 40)])!;
  // Defined-risk spread must require less margin than the unhedged short leg.
  expect(spread.total_margin).toBeLessThan(naked.total_margin);
  expect(spread.margin_benefit).toBeGreaterThan(0);
});

test('quantities are treated by absolute size (sign carried by order_side)', () => {
  const a = calculateLocalBasketMargin([shortCall(20000, 50)])!;
  const b = calculateLocalBasketMargin([{ ...shortCall(20000, 50), order_qty: -50 }])!;
  expect(b.total_margin).toBe(a.total_margin);
});
