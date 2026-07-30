// Black-Scholes Greeks — client-side computation
// Does not depend on broker returning Greeks

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const INV_SQRT_2 = 1 / Math.sqrt(2);

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

function normalCDF(x: number): number {
  // Horner's method approximation (Abramowitz & Stegun 26.2.17)
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) * INV_SQRT_2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export function blackScholes(
  S: number, // spot or futures price
  K: number, // strike price
  T: number, // time to expiry in years
  r: number, // risk-free rate (e.g. 0.07 for 7%)
  sigma: number, // annualized implied volatility (e.g. 0.15 for 15%)
  type: 'CE' | 'PE',
  isFutures = true, // Default to Futures/Forward model (Black-76), standard for NSE Index Options
): Greeks {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: type === 'CE' ? 1 : -1, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(T);
  // Black-76 for Futures/Forwards: d1 uses 0.5 * sigma^2 * T without additional drift r*T
  const drift = isFutures ? 0.5 * sigma * sigma : r + 0.5 * sigma * sigma;
  const d1 = (Math.log(S / K) + drift * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normalCDF(d1);
  const Nd2 = normalCDF(d2);
  const Nnd1 = normalCDF(-d1);
  const Nnd2 = normalCDF(-d2);
  const nd1 = normalPDF(d1);
  const df = isFutures ? Math.exp(-r * T) : 1;
  const ert = Math.exp(-r * T);

  const price =
    type === 'CE'
      ? isFutures
        ? df * (S * Nd1 - K * Nd2)
        : S * Nd1 - K * ert * Nd2
      : isFutures
        ? df * (K * Nnd2 - S * Nnd1)
        : K * ert * Nnd2 - S * Nnd1;

  const delta = type === 'CE' ? Nd1 * (isFutures ? df : 1) : (Nd1 - 1) * (isFutures ? df : 1);
  const gamma = (nd1 * (isFutures ? df : 1)) / (S * sigma * sqrtT);

  // Theta per calendar day. The two models need different formulas — using the spot-model
  // theta on the Black-76 branch (which is what this did) is wrong by up to ~4.8/day and
  // flips sign for ITM strikes, because it omits the r·price term the discount factor
  // contributes. Derivation: with F·n(d1) = K·n(d2), ∂C/∂T = −r·C + df·F·n(d1)·σ/(2√T),
  // so theta = −∂C/∂T = r·C − df·F·n(d1)·σ/(2√T), identical for calls and puts.
  //
  // Under Black-76 a deep-ITM option has POSITIVE theta: its price is ≈ df·(F−K) and the
  // discount factor unwinds toward 1 as expiry approaches, so it gains. That is correct —
  // do not "fix" it back to negative; long-option-theta-is-negative holds for the spot
  // model, not the discounted-forward model.
  const theta = isFutures
    ? (-(df * S * nd1 * sigma) / (2 * sqrtT) + r * price) / 365
    : type === 'CE'
      ? (-(S * nd1 * sigma) / (2 * sqrtT) - r * K * ert * Nd2) / 365
      : (-(S * nd1 * sigma) / (2 * sqrtT) + r * K * ert * Nnd2) / 365;

  const vega = (S * nd1 * sqrtT * (isFutures ? df : 1)) / 100; // per 1% change in vol

  // Rho per 1% rate move. Same split as theta: the spot formulas below are correct for the
  // spot model but wrong on the Black-76 branch, where r enters only through the discount
  // factor — C = e^{-rT}(…), so ∂C/∂r = −T·C for calls and puts alike. Nothing reads rho
  // today, but a wrong value in a public interface is a trap for the next caller.
  const rho = isFutures
    ? (-T * price) / 100
    : type === 'CE'
      ? (K * T * ert * Nd2) / 100
      : (-K * T * ert * Nnd2) / 100;

  return { price, delta, gamma, theta, vega, rho };
}

/**
 * Forward price for a spot quote. Black-76 (the `isFutures` branch above) prices off the
 * FORWARD, not the spot, so callers holding an index/spot level must convert first —
 * passing spot straight in understates the forward, which makes calls look cheap and puts
 * look rich. The inversion then absorbs that gap in opposite directions per side, showing
 * up as a phantom CE-vs-PE skew.
 */
export function forwardFromSpot(S: number, r: number, T: number): number {
  return S * Math.exp(r * T);
}

/**
 * Market-implied forward from put-call parity at a common strike: F = K + (C − P)·e^{rT}.
 *
 * PREFER THIS over forwardFromSpot whenever a CE/PE pair is available. Measured against a live
 * NIFTY chain (2026-07-30, spot 24257.45, 5.2 days to expiry, 122 populated legs):
 *
 *   forward source            unpriceable   mean |IV − brokerIV|
 *   parity (this function)        0/122          0.13 vol pts
 *   spot                         11/122          0.79 vol pts
 *   spot·e^{rT}                  14/122          1.33 vol pts
 *
 * Two independent estimates agreed on the true forward to 0.6 points — parity said 24231.48,
 * inverting the broker's own IV+delta said 24232.12 — i.e. a basis 26 points BELOW spot.
 * NIFTY futures routinely trade at a discount (negative cost of carry is the very reason
 * Black-76 suits NIFTY), so compounding spot at +r moves the forward the WRONG WAY and makes
 * deep-ITM calls look sub-intrinsic, which the no-arb guard then rejects.
 */
export function forwardFromParity(
  K: number,
  callPrice: number,
  putPrice: number,
  r: number,
  T: number,
): number {
  return K + (callPrice - putPrice) * Math.exp(r * T);
}

/**
 * Risk-free rate used by every client-side Greek reconstruction, so the overlay, the strategy
 * view and the backtest views all price legs off one forward convention.
 *
 * NOTE: this is a plain cost-of-carry proxy. NIFTY futures often trade at a discount to the
 * theoretical forward (negative cost of carry is common, and is the reason Black-76 is
 * preferred for NIFTY in the first place), so `S·e^{rT}` overstates the real forward somewhat.
 * A dividend-yield term (`S·e^{(r−q)T}`, q ≈ 1.5%) or the actual matching-expiry futures price
 * would be closer. That is a level correction and shifts CE and PE IV together; it does NOT
 * reintroduce the CE-vs-PE asymmetry that came from mismatching the forward and the discount.
 */
export const RISK_FREE = 0.07;

const IV_MIN = 1e-4;
const IV_MAX = 5;

/**
 * Compute IV from market price. `F` is the FORWARD (see forwardFromSpot) since this inverts
 * the Black-76 branch of blackScholes.
 *
 * Newton-Raphson alone is not safe here: vega collapses toward zero for deep ITM/OTM strikes
 * and near expiry, so the iteration either stalls or diverges and returns a junk sigma that
 * looks like a real answer. This brackets the problem instead — reject prices with no finite
 * IV up front, seed from Brenner-Subrahmanyam, run Newton, and fall back to bisection on
 * [IV_MIN, IV_MAX] whenever Newton leaves the bracket or loses gradient.
 *
 * Returns NaN when no finite IV exists or the solve fails — never a fabricated default.
 * Callers must check with Number.isFinite and decide whether to drop the point.
 */
export function impliedVolatility(
  marketPrice: number,
  F: number,
  K: number,
  T: number,
  r: number,
  type: 'CE' | 'PE',
  maxIter = 50,
  tolerance = 1e-4,
): number {
  if (!(T > 0) || !(marketPrice > 0) || !(F > 0) || !(K > 0)) return NaN;

  // No-arbitrage bounds for the discounted forward model. A price at or outside these has
  // no finite volatility that reproduces it.
  const df = Math.exp(-r * T);
  const lower = df * (type === 'CE' ? Math.max(0, F - K) : Math.max(0, K - F));
  const upper = df * (type === 'CE' ? F : K);
  if (marketPrice <= lower + 1e-9 || marketPrice >= upper - 1e-9) return NaN;

  const priceAt = (sigma: number) => blackScholes(F, K, T, r, sigma, type).price;

  // Brenner-Subrahmanyam closed-form seed — far better than a flat 0.3, especially near ATM.
  let sigma = Math.min(IV_MAX, Math.max(IV_MIN, (SQRT_2PI / Math.sqrt(T)) * (marketPrice / F)));

  for (let i = 0; i < maxIter; i++) {
    const { price, vega } = blackScholes(F, K, T, r, sigma, type);
    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) return sigma;
    if (!(vega > 1e-10)) break; // gradient gone — hand over to bisection
    const next = sigma - diff / (vega * 100); // vega is per 1%, undo the scaling
    if (!Number.isFinite(next) || next <= IV_MIN || next >= IV_MAX) break;
    sigma = next;
  }

  // Bisection fallback: price is monotonic in sigma, so a sign change brackets the root.
  let lo = IV_MIN;
  let hi = IV_MAX;
  let fLo = priceAt(lo) - marketPrice;
  const fHi = priceAt(hi) - marketPrice;
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi) || fLo * fHi > 0) return NaN;

  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const fMid = priceAt(mid) - marketPrice;
    if (!Number.isFinite(fMid)) return NaN;
    if (Math.abs(fMid) < tolerance || hi - lo < 1e-8) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return 0.5 * (lo + hi);
}

// Payoff at expiry for a position
export function payoffAtExpiry(
  spotAtExpiry: number,
  legs: Array<{
    strike: number;
    type: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    qty: number;
    premium: number;
  }>,
): number {
  return legs.reduce((total, leg) => {
    const intrinsic =
      leg.type === 'CE'
        ? Math.max(0, spotAtExpiry - leg.strike)
        : Math.max(0, leg.strike - spotAtExpiry);

    const legPnl = (intrinsic - leg.premium) * leg.qty * (leg.side === 'BUY' ? 1 : -1);
    return total + legPnl;
  }, 0);
}

// Days between two dates
export function daysToExpiry(expiry: string): number {
  const exp = /^\d{8}$/.test(expiry)
    ? new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`)
    : new Date(expiry);
  const now = new Date();
  const diff = exp.getTime() - now.getTime();
  return Math.max(0, diff / (1000 * 60 * 60 * 24));
}
