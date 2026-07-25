import { test, expect } from 'vitest';
import { blackScholes, impliedVolatility, payoffAtExpiry, daysToExpiry } from './GexService.ts';

// ─── blackScholes (Black-76 futures model) ─────────────────────────────────────────
test('blackScholes: ATM greeks have the expected signs and magnitudes', () => {
  const g = blackScholes(20000, 20000, 30 / 365, 0.07, 0.15, 'CE');
  expect(g.price).toBeGreaterThan(0);
  expect(g.delta).toBeGreaterThan(0.5); // ATM call slightly above 0.5
  expect(g.delta).toBeLessThan(0.55);
  expect(g.gamma).toBeGreaterThan(0);
  expect(g.vega).toBeGreaterThan(0);
  expect(g.theta).toBeLessThan(0); // long option decays
});

test('blackScholes: call and put deltas differ by the discount factor (~1)', () => {
  const call = blackScholes(20000, 20500, 30 / 365, 0, 0.18, 'CE');
  const put = blackScholes(20000, 20500, 30 / 365, 0, 0.18, 'PE');
  expect(call.delta - put.delta).toBeCloseTo(1, 4);
});

test('blackScholes: degenerate (T=0) returns intrinsic value', () => {
  const call = blackScholes(20100, 20000, 0, 0.07, 0.15, 'CE');
  expect(call.price).toBe(100); // max(0, 20100-20000)
  const put = blackScholes(19900, 20000, 0, 0.07, 0.15, 'PE');
  expect(put.price).toBe(100); // max(0, 20000-19900)
});

test('impliedVolatility: round-trips the vol used to price the option', () => {
  const sigma = 0.22;
  const { price } = blackScholes(20000, 20200, 21 / 365, 0.07, sigma, 'CE');
  const recovered = impliedVolatility(price, 20000, 20200, 21 / 365, 0.07, 'CE');
  expect(recovered).toBeCloseTo(sigma, 2);
});

// ─── payoffAtExpiry ────────────────────────────────────────────────────────────────
test('payoffAtExpiry: long call profits above strike + premium', () => {
  const legs = [{ strike: 100, type: 'CE' as const, side: 'BUY' as const, qty: 1, premium: 5 }];
  expect(payoffAtExpiry(120, legs)).toBe(15); // intrinsic 20 − premium 5
  expect(payoffAtExpiry(100, legs)).toBe(-5); // expires ATM → lose premium
  expect(payoffAtExpiry(80, legs)).toBe(-5); // expires OTM → lose premium
});

test('payoffAtExpiry: short put caps profit at premium, loses below strike', () => {
  const legs = [{ strike: 100, type: 'PE' as const, side: 'SELL' as const, qty: 1, premium: 4 }];
  expect(payoffAtExpiry(110, legs)).toBe(4); // OTM → keep premium
  expect(payoffAtExpiry(90, legs)).toBe(-6); // intrinsic 10, minus 4 premium, short → -6
});

test('payoffAtExpiry: a long straddle is symmetric around the strike', () => {
  const legs = [
    { strike: 100, type: 'CE' as const, side: 'BUY' as const, qty: 1, premium: 5 },
    { strike: 100, type: 'PE' as const, side: 'BUY' as const, qty: 1, premium: 5 },
  ];
  expect(payoffAtExpiry(115, legs)).toBe(payoffAtExpiry(85, legs)); // ±15 from strike
  expect(payoffAtExpiry(100, legs)).toBe(-10); // both expire worthless → lose both premiums
});

// ─── daysToExpiry ────────────────────────────────────────────────────────────────
test('daysToExpiry: never negative, accepts YYYYMMDD and ISO', () => {
  expect(daysToExpiry('20200101')).toBe(0); // long past → clamped to 0
  expect(daysToExpiry('2020-01-01')).toBe(0);
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  expect(daysToExpiry(future)).toBeGreaterThan(4);
});
