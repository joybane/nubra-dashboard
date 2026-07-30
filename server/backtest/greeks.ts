// ─────────────────────────────────────────────────────────────────────────────
// Black-Scholes greeks — used for DELTA-based strike selection and SL/target.
// Risk-free rate is assumed ~0 (intraday Indian index options); dividend 0.
// IV in the parquet is a percentage (e.g. 12.5 = 12.5%); time in years.
// ─────────────────────────────────────────────────────────────────────────────
import type { OptionType } from './types.ts';

// standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26)
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Black-Scholes / Black-76 option delta. ivPct is the IV percentage; tYears years to expiry. */
export function bsDelta(
  optionType: OptionType,
  spot: number,
  strike: number,
  ivPct: number,
  tYears: number,
  isFutures = true,
): number {
  if (!(spot > 0) || !(strike > 0) || !(ivPct > 0) || !(tYears > 0)) {
    // degenerate: fall back to moneyness sign
    if (optionType === 'CALL') return spot >= strike ? 1 : 0;
    return spot <= strike ? -1 : 0;
  }
  const sigma = ivPct / 100;
  // Black-76 drift for Futures/Forward pricing (standard for NSE index options)
  const d1 =
    (Math.log(spot / strike) + ((sigma * sigma) / 2) * tYears) / (sigma * Math.sqrt(tYears));
  const cdf = normCdf(d1);
  return optionType === 'CALL' ? cdf : cdf - 1; // put delta is negative
}

/**
 * Black-76 option premium. Same conventions as bsDelta: ivPct is the IV percentage,
 * tYears years to expiry, zero rate and zero dividend. Used by the local margin engine
 * to reprice a leg under each SPAN scenario shock.
 */
export function bsPrice(
  optionType: OptionType,
  spot: number,
  strike: number,
  ivPct: number,
  tYears: number,
): number {
  const intrinsic = optionType === 'CALL' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (!(spot > 0) || !(strike > 0) || !(ivPct > 0) || !(tYears > 0)) return intrinsic;

  const sigma = ivPct / 100;
  const sqrtT = sigma * Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * tYears) / sqrtT;
  const d2 = d1 - sqrtT;
  const price =
    optionType === 'CALL'
      ? spot * normCdf(d1) - strike * normCdf(d2)
      : strike * normCdf(-d2) - spot * normCdf(-d1);
  // Guard against tiny negative values from the erf approximation near the boundaries.
  return Math.max(price, intrinsic, 0);
}

/**
 * Implied volatility (as a percentage) from an observed premium, by bisection.
 * Returns null when the premium is outside what the model can produce — deep-OTM
 * quotes near zero are the usual cause, and the caller should fall back to a
 * quoted IV rather than trusting a boundary value.
 */
export function impliedVolPct(
  optionType: OptionType,
  spot: number,
  strike: number,
  premium: number,
  tYears: number,
): number | null {
  if (!(spot > 0) || !(strike > 0) || !(premium > 0) || !(tYears > 0)) return null;
  const intrinsic = optionType === 'CALL' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (premium <= intrinsic) return null; // no time value left to imply vol from

  let lo = 0.5,
    hi = 300; // IV percentage bounds
  if (bsPrice(optionType, spot, strike, hi, tYears) < premium) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(optionType, spot, strike, mid, tYears) < premium) lo = mid;
    else hi = mid;
  }
  const iv = (lo + hi) / 2;
  return iv > 0.6 && iv < 299 ? iv : null;
}

/**
 * Calendar years to expiry (expiry assumed 15:30 IST) — the convention an annualised
 * IV is actually quoted against, so that `σ√T` reproduces the option's own time value.
 *
 * Deliberately separate from `yearsToExpiry` below, whose trading-time arithmetic
 * understates a multi-day horizon by roughly 3.8x and is discontinuous at the one-day
 * boundary. The backtest's delta thresholds are calibrated against that behaviour, so
 * it is left alone; anything that needs a true T (option repricing, margin) uses this.
 */
export function calendarYearsToExpiry(date: string, hhmm: string, expiry: string): number {
  const ms = Date.parse(`${expiry}T15:30:00+05:30`) - Date.parse(`${date}T${hhmm}:00+05:30`);
  if (!Number.isFinite(ms)) return 1 / 365;
  return Math.max(ms / 86400000 / 365, 1 / (365 * 24 * 60));
}

/** Trading years between an IST trade datetime and expiry (expiry assumed 15:30 IST). */
export function yearsToExpiry(date: string, hhmm: string, expiry: string): number {
  const now = Date.parse(`${date}T${hhmm}:00+05:30`);
  const exp = Date.parse(`${expiry}T15:30:00+05:30`);
  const totalMs = exp - now;
  if (totalMs <= 0) return 1 / (365 * 24 * 60);

  const days = Math.floor(totalMs / 86400000);
  if (days === 0) {
    // Intraday: map remaining minutes to trading day ratio
    const minsLeft = Math.max(1, totalMs / 60000);
    return minsLeft / 375 / 252; // 375 trading mins/day, 252 trading days/yr
  }

  // Multi-day: trading day weighting
  const yrs = (days * (375 / 1440) + ((totalMs % 86400000) / 86400000) * (375 / 1440)) / 252;
  return yrs > 0 ? yrs : 1 / (365 * 24 * 60);
}
