import { test, expect } from 'vitest';
import { bsDelta, bsPrice, calendarYearsToExpiry, impliedVolPct, yearsToExpiry } from './greeks.ts';

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

// ─── calendarYearsToExpiry ────────────────────────────────────────────────────────
test('calendarYearsToExpiry: reads as plain calendar time, and is monotonic across the day boundary', () => {
  // 30 days out really is ~30/365 of a year — yearsToExpiry reports ~1/3 of that.
  expect(calendarYearsToExpiry('2026-08-25', '10:00', '2026-09-24') * 365).toBeCloseTo(30.23, 1);
  expect(calendarYearsToExpiry('2026-08-25', '10:00', '2027-08-25')).toBeCloseTo(1, 2);
  const ts = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-09-04']
    .map(e => calendarYearsToExpiry('2026-08-25', '10:00', e));
  for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
});

// ─── bsPrice / impliedVolPct ──────────────────────────────────────────────────────
test('bsPrice: put-call parity holds at r=0 (C − P = S − K)', () => {
  const t = calendarYearsToExpiry('2026-08-25', '10:00', '2026-09-04');
  for (const k of [23000, 24000, 25000]) {
    const c = bsPrice('CALL', 24000, k, 15, t);
    const p = bsPrice('PUT', 24000, k, 15, t);
    expect(c - p).toBeCloseTo(24000 - k, 3);
  }
});

test('bsPrice: its own slope reproduces bsDelta', () => {
  const t = calendarYearsToExpiry('2026-08-25', '10:00', '2026-09-04');
  for (const k of [23500, 24000, 24500]) {
    const fd = (bsPrice('CALL', 24001, k, 15, t) - bsPrice('CALL', 23999, k, 15, t)) / 2;
    expect(fd).toBeCloseTo(bsDelta('CALL', 24000, k, 15, t), 3);
  }
});

test('impliedVolPct: round-trips back to the premium it was solved from', () => {
  const t = calendarYearsToExpiry('2026-08-25', '10:00', '2026-09-04');
  for (const [ot, k, prem] of [['CALL', 24000, 150], ['CALL', 24300, 120], ['PUT', 23800, 100]] as const) {
    const iv = impliedVolPct(ot, 24000, k, prem, t);
    expect(iv).not.toBeNull();
    expect(bsPrice(ot, 24000, k, iv!, t)).toBeCloseTo(prem, 2);
  }
});

test('impliedVolPct: returns null when the premium carries no time value to solve from', () => {
  const t = calendarYearsToExpiry('2026-08-25', '10:00', '2026-09-04');
  expect(impliedVolPct('CALL', 24000, 22000, 1900, t)).toBeNull(); // below intrinsic
  expect(impliedVolPct('CALL', 24000, 24000, 0, t)).toBeNull();
});
