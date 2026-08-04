import { test, expect } from 'vitest';
import {
  blackScholes,
  forwardFromParity,
  forwardFromSpot,
  impliedVolatility,
  mcxFutureSymbol,
  mcxUnderlyingFutureExpiry,
  payoffAtExpiry,
  daysToExpiry,
  RISK_FREE,
} from './GexService.ts';

// ─── MCX: which future an option expiry settles into ──────────────────────────
// Verified live 2026-08-03 — each chain's `cp` equalled its future's LTP exactly.
const CRUDE_FUT = ['20260819', '20260921', '20261019', '20261119', '20261218', '20270119'];

test('mcxUnderlyingFutureExpiry: picks the nearest future expiring on or after the option', () => {
  expect(mcxUnderlyingFutureExpiry('20260817', CRUDE_FUT)).toBe('20260819');
  expect(mcxUnderlyingFutureExpiry('20260917', CRUDE_FUT)).toBe('20260921');
  expect(mcxUnderlyingFutureExpiry('20261015', CRUDE_FUT)).toBe('20261019');
});

test('mcxUnderlyingFutureExpiry: an option expiring the same day as its future takes that future', () => {
  expect(mcxUnderlyingFutureExpiry('20260819', CRUDE_FUT)).toBe('20260819');
});

test('mcxUnderlyingFutureExpiry: order of the input list does not matter', () => {
  expect(mcxUnderlyingFutureExpiry('20260817', [...CRUDE_FUT].reverse())).toBe('20260819');
});

test('mcxUnderlyingFutureExpiry: returns null rather than a stale future once none is left', () => {
  expect(mcxUnderlyingFutureExpiry('20270201', CRUDE_FUT)).toBeNull();
  expect(mcxUnderlyingFutureExpiry('20260817', [])).toBeNull();
});

test('mcxFutureSymbol: builds the zanskar name, which is also the trading symbol', () => {
  expect(mcxFutureSymbol('CRUDEOIL', '20260819')).toBe('FUT_CRUDEOIL_20260819');
  expect(mcxFutureSymbol('crudeoil', '20260819')).toBe('FUT_CRUDEOIL_20260819');
  expect(mcxFutureSymbol('NATGASMINI', '20260824')).toBe('FUT_NATGASMINI_20260824');
});

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

/**
 * Every analytic Greek must equal the finite difference of this function's OWN price, or the
 * two disagree and one of them is lying. This is what caught the theta bug: delta and vega
 * matched to ~1e-6 while theta was out by up to 4.8/day and sign-flipped for ITM strikes,
 * because the spot-model theta formula had been used on the Black-76 branch.
 */
test('blackScholes: analytic Greeks match finite differences of its own price', () => {
  const r = RISK_FREE;
  const F = 25000;
  const sigma = 0.13;
  const price = (f: number, K: number, T: number, s: number, t: 'CE' | 'PE') =>
    blackScholes(f, K, T, r, s, t).price;

  for (const T of [7 / 365, 30 / 365, 90 / 365]) {
    for (const K of [23000, 24000, 25000, 26000, 27000]) {
      for (const type of ['CE', 'PE'] as const) {
        const g = blackScholes(F, K, T, r, sigma, type);
        const where = `${type} K=${K} T=${Math.round(T * 365)}d`;

        const hF = 1;
        const fdDelta =
          (price(F + hF, K, T, sigma, type) - price(F - hF, K, T, sigma, type)) / (2 * hF);
        expect(Math.abs(g.delta - fdDelta), `delta ${where}`).toBeLessThan(1e-4);

        const hS = 1e-4; // analytic vega is per 1 vol point, hence /100
        const fdVega =
          (price(F, K, T, sigma + hS, type) - price(F, K, T, sigma - hS, type)) / (2 * hS) / 100;
        expect(Math.abs(g.vega - fdVega), `vega ${where}`).toBeLessThan(1e-2);

        const hT = 1 / 365 / 24; // one hour; analytic theta is per calendar day, hence /365
        const fdTheta =
          -(price(F, K, T + hT, sigma, type) - price(F, K, T - hT, sigma, type)) / (2 * hT) / 365;
        expect(Math.abs(g.theta - fdTheta), `theta ${where}`).toBeLessThan(1e-3);

        // gamma = d(delta)/dF
        const fdGamma =
          (blackScholes(F + hF, K, T, r, sigma, type).delta -
            blackScholes(F - hF, K, T, r, sigma, type).delta) /
          (2 * hF);
        expect(Math.abs(g.gamma - fdGamma), `gamma ${where}`).toBeLessThan(1e-7);

        // rho per 1% rate move, F held fixed (F is an input here, not derived from spot)
        const hr = 1e-6;
        const fdRho =
          (blackScholes(F, K, T, r + hr, sigma, type).price -
            blackScholes(F, K, T, r - hr, sigma, type).price) /
          (2 * hr) /
          100;
        expect(Math.abs(g.rho - fdRho), `rho ${where}`).toBeLessThan(1e-4);
      }
    }
  }
});

test('blackScholes: ITM theta is positive under Black-76 as the discount unwinds', () => {
  // Not a bug: a deep-ITM option is worth ~df*(F-K) and df rises toward 1 as T falls.
  // The spot model has no such term, so this is a genuine model difference.
  expect(blackScholes(25000, 21000, 7 / 365, RISK_FREE, 0.13, 'CE').theta).toBeGreaterThan(0);
  expect(blackScholes(25000, 29000, 7 / 365, RISK_FREE, 0.13, 'PE').theta).toBeGreaterThan(0);
  // ATM still decays, in both models.
  expect(blackScholes(25000, 25000, 7 / 365, RISK_FREE, 0.13, 'CE').theta).toBeLessThan(0);
  expect(blackScholes(25000, 25000, 7 / 365, RISK_FREE, 0.13, 'PE').theta).toBeLessThan(0);
});

test('blackScholes: spot branch keeps the spot-model theta and rho', () => {
  // isFutures=false must be unaffected by the Black-76 theta/rho fixes — verify against the
  // textbook spot formulas directly.
  const S = 25000,
    K = 25000,
    T = 30 / 365,
    r = RISK_FREE,
    sigma = 0.13;
  const g = blackScholes(S, K, T, r, sigma, 'CE', false);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const Nd2 = 0.5 * (1 + erfApprox(d2 / Math.SQRT2));
  const ert = Math.exp(-r * T);
  expect(g.theta).toBeCloseTo((-(S * nd1 * sigma) / (2 * sqrtT) - r * K * ert * Nd2) / 365, 3);
  expect(g.rho).toBeCloseTo((K * T * ert * Nd2) / 100, 3);
  // Spot-model rho is positive for a call; Black-76 rho is negative (pure discounting).
  expect(g.rho).toBeGreaterThan(0);
  expect(blackScholes(S, K, T, r, sigma, 'CE', true).rho).toBeLessThan(0);
});

/** Abramowitz & Stegun 7.1.26 erf, to check the spot theta independently of normalCDF. */
function erfApprox(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}

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

// ─── forward vs spot ───────────────────────────────────────────────────────────────
test('forwardFromSpot: compounds spot at the risk-free rate', () => {
  expect(forwardFromSpot(20000, 0.07, 30 / 365)).toBeCloseTo(
    20000 * Math.exp((0.07 * 30) / 365),
    8,
  );
  expect(forwardFromSpot(20000, 0.07, 0)).toBe(20000);
});

test('forwardFromParity: recovers the forward a CE/PE pair was priced from', () => {
  const F = 24231.48,
    K = 24250,
    T = 5.19 / 365,
    r = RISK_FREE,
    sigma = 0.11;
  const C = blackScholes(F, K, T, r, sigma, 'CE').price;
  const P = blackScholes(F, K, T, r, sigma, 'PE').price;
  expect(forwardFromParity(K, C, P, r, T)).toBeCloseTo(F, 6);
});

test('forwardFromParity: detects a negative basis, as NIFTY actually shows', () => {
  // Real live figures (2026-07-30): spot 24257.45, K=24250 pair C=102.85 / P=121.35.
  // Parity implies 24231.48 — a basis 26 points BELOW spot. Inverting the broker's own
  // IV+delta independently gave 24232.12, agreeing to 0.6 points.
  const implied = forwardFromParity(24250, 102.85, 121.35, RISK_FREE, 5.19 / 365);
  expect(implied).toBeCloseTo(24231.5, 0);
  expect(implied).toBeLessThan(24257.45); // discount to spot
  expect(implied).toBeLessThan(forwardFromSpot(24257.45, RISK_FREE, 5.19 / 365));
});

test('impliedVolatility: a real sub-spot-intrinsic ITM call prices off the parity forward', () => {
  // NIFTY 23500 CE traded 739.40 with spot 24257.45 — BELOW spot-intrinsic (757.45), which is
  // only possible because the forward sits under spot. Spot-derived forwards reject it as
  // sub-intrinsic; the parity forward prices it.
  const T = 5.19 / 365;
  const Fpar = forwardFromParity(24250, 102.85, 121.35, RISK_FREE, T);
  expect(impliedVolatility(739.4, Fpar, 23500, T, RISK_FREE, 'CE')).toBeGreaterThan(0);
  expect(
    impliedVolatility(739.4, forwardFromSpot(24257.45, RISK_FREE, T), 23500, T, RISK_FREE, 'CE'),
  ).toBeNaN();
});

/**
 * The regression guard for the forward bug. Prices that satisfy put-call parity for a given
 * forward must invert to ONE volatility on both sides. Passing spot where the forward
 * belongs splits them — calls look cheap so their IV is pushed up, puts look rich so theirs
 * is pulled down — which is exactly the phantom CE-vs-PE skew the overlay was showing.
 *
 * A naive round-trip cannot catch this: pricing and inverting through the same wrong argument
 * agrees with itself. Parity is what makes the error observable.
 */
test('impliedVolatility: parity-consistent CE/PE prices invert to the same vol', () => {
  const F = 20000,
    K = 20200,
    T = 30 / 365,
    r = 0.07,
    sigma = 0.2;
  const call = blackScholes(F, K, T, r, sigma, 'CE').price;
  const put = blackScholes(F, K, T, r, sigma, 'PE').price;

  // Sanity: these prices really do satisfy put-call parity for forward F.
  expect(call - put).toBeCloseTo(Math.exp(-r * T) * (F - K), 6);

  const ivCall = impliedVolatility(call, F, K, T, r, 'CE');
  const ivPut = impliedVolatility(put, F, K, T, r, 'PE');
  expect(ivCall).toBeCloseTo(sigma, 4);
  expect(ivPut).toBeCloseTo(sigma, 4);
  expect(Math.abs(ivCall - ivPut)).toBeLessThan(1e-4);

  // Feeding spot instead of the forward is what produced the asymmetry.
  const S = F * Math.exp(-r * T);
  expect(forwardFromSpot(S, r, T)).toBeCloseTo(F, 6);
  const badCall = impliedVolatility(call, S, K, T, r, 'CE');
  const badPut = impliedVolatility(put, S, K, T, r, 'PE');
  expect(badCall).toBeGreaterThan(sigma);
  expect(badPut).toBeLessThan(sigma);
  expect(Math.abs(badCall - badPut)).toBeGreaterThan(1e-3);
});

// ─── solver robustness ─────────────────────────────────────────────────────────────
test('impliedVolatility: returns NaN rather than a fabricated default', () => {
  const T = 0.1,
    r = 0.07;
  const df = Math.exp(-r * T);
  expect(impliedVolatility(0, 20000, 20000, T, r, 'CE')).toBeNaN(); // no price
  expect(impliedVolatility(-5, 20000, 20000, T, r, 'CE')).toBeNaN(); // negative price
  expect(impliedVolatility(100, 20000, 20000, 0, r, 'CE')).toBeNaN(); // expired
  expect(impliedVolatility(100, 0, 20000, T, r, 'CE')).toBeNaN(); // no forward
  // Below intrinsic → no volatility reproduces it.
  expect(impliedVolatility(df * 1000 - 10, 21000, 20000, T, r, 'CE')).toBeNaN();
  // Above the discounted forward → likewise unreachable.
  expect(impliedVolatility(df * 21000 + 1, 21000, 20000, T, r, 'CE')).toBeNaN();
});

test('impliedVolatility: never returns a wrong finite vol across moneyness/vol/tenor', () => {
  const F = 20000,
    r = 0.07;
  for (const K of [16000, 19000, 20000, 21000, 25000]) {
    for (const sigma of [0.08, 0.15, 0.35, 0.9]) {
      for (const T of [1 / 365, 7 / 365, 60 / 365]) {
        for (const type of ['CE', 'PE'] as const) {
          const { price } = blackScholes(F, K, T, r, sigma, type);
          const rec = impliedVolatility(price, F, K, T, r, type);
          if (!Number.isFinite(rec)) continue; // legitimately unpriceable — caller drops it
          // Assert on price, not sigma: where vega is tiny a wide sigma band still reprices
          // correctly, and repricing is the actual contract.
          const back = blackScholes(F, K, T, r, rec, type).price;
          expect(Math.abs(back - price)).toBeLessThan(1e-3);
        }
      }
    }
  }
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
