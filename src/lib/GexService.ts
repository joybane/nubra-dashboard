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
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega:  number;
  rho:   number;
}

export function blackScholes(
  S: number,      // spot price
  K: number,      // strike price
  T: number,      // time to expiry in years
  r: number,      // risk-free rate (e.g. 0.07 for 7%)
  sigma: number,  // annualized implied volatility (e.g. 0.15 for 15%)
  type: 'CE' | 'PE',
): Greeks {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: type === 'CE' ? 1 : -1, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1  = normalCDF(d1);
  const Nd2  = normalCDF(d2);
  const Nnd1 = normalCDF(-d1);
  const Nnd2 = normalCDF(-d2);
  const nd1  = normalPDF(d1);
  const ert  = Math.exp(-r * T);

  const price = type === 'CE'
    ? S * Nd1 - K * ert * Nd2
    : K * ert * Nnd2 - S * Nnd1;

  const delta = type === 'CE' ? Nd1 : Nd1 - 1;

  const gamma = nd1 / (S * sigma * sqrtT);

  // Theta per calendar day (not per year)
  const theta = type === 'CE'
    ? (-(S * nd1 * sigma) / (2 * sqrtT) - r * K * ert * Nd2) / 365
    : (-(S * nd1 * sigma) / (2 * sqrtT) + r * K * ert * Nnd2) / 365;

  const vega = S * nd1 * sqrtT / 100; // per 1% change in vol

  const rho = type === 'CE'
    ? K * T * ert * Nd2 / 100
    : -K * T * ert * Nnd2 / 100;

  return { price, delta, gamma, theta, vega, rho };
}

// Convenience: compute IV from market price using Newton-Raphson
export function impliedVolatility(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: 'CE' | 'PE',
  maxIter = 50,
  tolerance = 1e-4,
): number {
  if (T <= 0 || marketPrice <= 0) return 0;

  let sigma = 0.3; // initial guess 30%
  for (let i = 0; i < maxIter; i++) {
    const { price, vega } = blackScholes(S, K, T, r, sigma, type);
    const diff = price - marketPrice;
    if (Math.abs(diff) < tolerance) break;
    if (vega < 1e-10) break;
    sigma -= diff / (vega * 100); // vega was divided by 100
    if (sigma <= 0.001) sigma = 0.001;
    if (sigma > 5) sigma = 5;
  }
  return sigma;
}

// Payoff at expiry for a position
export function payoffAtExpiry(
  spotAtExpiry: number,
  legs: Array<{ strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qty: number; premium: number }>,
): number {
  return legs.reduce((total, leg) => {
    const intrinsic = leg.type === 'CE'
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
