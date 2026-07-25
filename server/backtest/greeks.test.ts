import { test, expect } from 'vitest';
import { bsDelta, yearsToExpiry } from './greeks.ts';

// ─── bsDelta (Black-76) ──────────────────────────────────────────────────────────
test('bsDelta: ATM call delta is just above 0.5, ATM put just below -0.5', () => {
  const t = 7 / 365; // one week
  const call = bsDelta('CALL', 20000, 20000, 15, t);
  const put = bsDelta('PUT', 20000, 20000, 15, t);
  expect(call).toBeGreaterThan(0.5);
  expect(call).toBeLessThan(0.55);
  expect(put).toBeLessThan(-0.45);
  expect(put).toBeGreaterThan(-0.5);
});

test('bsDelta: call − put delta ≈ 1 at the same strike (put-call parity, r≈0)', () => {
  const t = 30 / 365;
  const call = bsDelta('CALL', 20000, 20500, 18, t);
  const put = bsDelta('PUT', 20000, 20500, 18, t);
  expect(call - put).toBeCloseTo(1, 5);
});

test('bsDelta: deep ITM call → ~1, deep OTM call → ~0', () => {
  const t = 30 / 365;
  expect(bsDelta('CALL', 25000, 15000, 15, t)).toBeGreaterThan(0.99);
  expect(bsDelta('CALL', 15000, 25000, 15, t)).toBeLessThan(0.01);
});

test('bsDelta: put delta is always negative, call delta always positive', () => {
  const t = 10 / 365;
  for (const k of [18000, 19000, 20000, 21000, 22000]) {
    expect(bsDelta('CALL', 20000, k, 20, t)).toBeGreaterThanOrEqual(0);
    expect(bsDelta('PUT', 20000, k, 20, t)).toBeLessThanOrEqual(0);
  }
});

test('bsDelta: degenerate inputs fall back to moneyness sign', () => {
  // zero time to expiry → intrinsic moneyness
  expect(bsDelta('CALL', 20100, 20000, 15, 0)).toBe(1); // ITM call
  expect(bsDelta('CALL', 19900, 20000, 15, 0)).toBe(0); // OTM call
  expect(bsDelta('PUT', 19900, 20000, 15, 0)).toBe(-1); // ITM put
  expect(bsDelta('PUT', 20100, 20000, 15, 0)).toBe(0); // OTM put
});

// ─── yearsToExpiry ────────────────────────────────────────────────────────────────
test('yearsToExpiry: positive and monotonic — earlier in the day is more time left', () => {
  const early = yearsToExpiry('2025-01-20', '09:30', '2025-01-23');
  const late = yearsToExpiry('2025-01-20', '14:30', '2025-01-23');
  expect(early).toBeGreaterThan(0);
  expect(early).toBeGreaterThan(late);
});

test('yearsToExpiry: past/at-expiry clamps to a tiny positive value (never 0 or negative)', () => {
  const t = yearsToExpiry('2025-01-25', '15:30', '2025-01-23');
  expect(t).toBeGreaterThan(0);
  expect(t).toBeLessThan(0.001);
});
