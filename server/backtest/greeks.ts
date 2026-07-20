// ─────────────────────────────────────────────────────────────────────────────
// Black-Scholes greeks — used for DELTA-based strike selection and SL/target.
// Risk-free rate is assumed ~0 (intraday Indian index options); dividend 0.
// IV in the parquet is a percentage (e.g. 12.5 = 12.5%); time in years.
// ─────────────────────────────────────────────────────────────────────────────
import type { OptionType } from './types.ts';

// standard normal CDF via erf approximation (Abramowitz & Stegun 7.1.26)
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Black-Scholes / Black-76 option delta. ivPct is the IV percentage; tYears years to expiry. */
export function bsDelta(
  optionType: OptionType, spot: number, strike: number, ivPct: number, tYears: number, isFutures = true,
): number {
  if (!(spot > 0) || !(strike > 0) || !(ivPct > 0) || !(tYears > 0)) {
    // degenerate: fall back to moneyness sign
    if (optionType === 'CALL') return spot >= strike ? 1 : 0;
    return spot <= strike ? -1 : 0;
  }
  const sigma = ivPct / 100;
  // Black-76 drift for Futures/Forward pricing (standard for NSE index options)
  const d1 = (Math.log(spot / strike) + (sigma * sigma / 2) * tYears) / (sigma * Math.sqrt(tYears));
  const cdf = normCdf(d1);
  return optionType === 'CALL' ? cdf : cdf - 1; // put delta is negative
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
    return (minsLeft / 375) / 252; // 375 trading mins/day, 252 trading days/yr
  }

  // Multi-day: trading day weighting
  const yrs = (days * (375 / 1440) + ((totalMs % 86400000) / 86400000) * (375 / 1440)) / 252;
  return yrs > 0 ? yrs : 1 / (365 * 24 * 60);
}
