/**
 * Greeks of the signal's reference strangle, rebuilt from the Analysis day cache.
 *
 * The cache keeps option closes and spot on a one-minute grid, nothing else, so every number here is
 * reconstructed the way the Nubra BT and Tracker charts reconstruct theirs (`localGreekSeries`): at
 * each minute the forward comes from put-call parity at the strike nearest spot that has both a CE
 * and a PE close — spot itself only when no such pair exists — IV is inverted from the close under
 * Black-76, and the greeks are evaluated at that IV. A print whose IV will not invert (sub-intrinsic,
 * stale) yields null, never an invented vol.
 *
 * Units are the ones `blackScholes` returns, which are the broker's own: per ONE option unit (not per
 * lot), delta as a fraction, vega per 1 vol point, theta per calendar day (the instantaneous rate,
 * not the broker's one-day repricing, so it reads higher than Nubra's near expiry). IV is
 * reported in vol points (14.5 = 14.5%), as the Tracker overlay shows it.
 */
import {
  RISK_FREE,
  blackScholes,
  forwardFromParity,
  impliedVolatility,
} from '../../src/lib/GexService.ts';
import { SESSION_BARS, SESSION_OPEN_MIN, type DaySeries, type Grid } from './daySeries.ts';
import type { OptionSide as OptionKind } from './optionNames.ts';

export interface LegGreeks {
  /** Vol points, 14.5 = 14.5%. */
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export type GreekKey = keyof LegGreeks;
export const GREEK_KEYS: readonly GreekKey[] = ['iv', 'delta', 'gamma', 'theta', 'vega'];

export interface MomentGreeks {
  CE: LegGreeks | null;
  PE: LegGreeks | null;
}

/** The reference strangle's greeks at the signal's two minutes. */
export interface SignalGreeks {
  t1: MomentGreeks;
  t2: MomentGreeks;
}

export interface DayGreekSeries {
  CE: Record<GreekKey, Grid>;
  PE: Record<GreekKey, Grid>;
  /** The forward each minute was priced off (spot where no parity pair existed). */
  forward: Grid;
}

const IST_OFFSET_MS = 19_800_000;

/**
 * Years from a session minute to the 15:30 IST expiry settlement, floored at one hour so expiry day
 * stays priceable. The same convention as the overlay's and Nubra BT's `yearsToExpiry`.
 */
export function yearsToExpiry(date: string, expiry: string, index: number): number {
  const nowMs =
    Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS + (SESSION_OPEN_MIN + index) * 60_000;
  const expiryMs = Date.parse(`${expiry}T00:00:00Z`) - IST_OFFSET_MS + (15 * 60 + 30) * 60_000;
  const days = Math.max(0, (expiryMs - nowMs) / 86_400_000);
  return Math.max(days / 365, 1 / (365 * 24));
}

/** Parity forward at one minute, or spot when no strike has both a CE and a PE close. */
export function forwardAt(day: DaySeries, index: number): number | null {
  const spot = day.spot[index];
  if (spot == null || !(spot > 0)) return null;
  const T = yearsToExpiry(day.date, day.expiry, index);
  let bestGap = Infinity;
  let best: { K: number; ce: number; pe: number } | null = null;
  for (const key of Object.keys(day.ce)) {
    const pe = day.pe[key]?.[index];
    const ce = day.ce[key][index];
    if (ce == null || pe == null || !(ce > 0) || !(pe > 0)) continue;
    const K = Number(key);
    const gap = Math.abs(K - spot);
    if (gap < bestGap) {
      bestGap = gap;
      best = { K, ce, pe };
    }
  }
  return best ? forwardFromParity(best.K, best.ce, best.pe, RISK_FREE, T) : spot;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

function legGreeks(
  day: DaySeries,
  kind: OptionKind,
  strike: number,
  index: number,
  forward: number | null,
): LegGreeks | null {
  const close = (kind === 'CE' ? day.ce : day.pe)[String(strike)]?.[index];
  if (close == null || !(close > 0) || forward == null) return null;
  const T = yearsToExpiry(day.date, day.expiry, index);
  const iv = impliedVolatility(close, forward, strike, T, RISK_FREE, kind);
  if (!Number.isFinite(iv) || iv <= 0) return null;
  const g = blackScholes(forward, strike, T, RISK_FREE, iv, kind);
  return {
    iv: r6(iv * 100),
    delta: r6(g.delta),
    gamma: r6(g.gamma),
    theta: r6(g.theta),
    vega: r6(g.vega),
  };
}

/** One leg's greeks at one minute; null when the minute has no close or the IV will not invert. */
export function legGreeksAt(
  day: DaySeries,
  kind: OptionKind,
  strike: number,
  index: number,
): LegGreeks | null {
  return legGreeks(day, kind, strike, index, forwardAt(day, index));
}

/** Both reference legs at the signal's two minutes. */
export function signalGreeks(
  day: DaySeries,
  legs: { ceStrike: number; peStrike: number },
  t1Index: number,
  t2Index: number,
): SignalGreeks {
  const moment = (index: number): MomentGreeks => {
    const forward = forwardAt(day, index);
    return {
      CE: legGreeks(day, 'CE', legs.ceStrike, index, forward),
      PE: legGreeks(day, 'PE', legs.peStrike, index, forward),
    };
  };
  return { t1: moment(t1Index), t2: moment(t2Index) };
}

/** The whole session's greeks for the two reference strikes, null wherever a minute cannot be priced. */
export function dayGreekSeries(
  day: DaySeries,
  legs: { ceStrike: number; peStrike: number },
): DayGreekSeries {
  const blank = (): Record<GreekKey, Grid> => ({
    iv: new Array<number | null>(SESSION_BARS).fill(null),
    delta: new Array<number | null>(SESSION_BARS).fill(null),
    gamma: new Array<number | null>(SESSION_BARS).fill(null),
    theta: new Array<number | null>(SESSION_BARS).fill(null),
    vega: new Array<number | null>(SESSION_BARS).fill(null),
  });
  const out: DayGreekSeries = {
    CE: blank(),
    PE: blank(),
    forward: new Array<number | null>(SESSION_BARS).fill(null),
  };
  for (let i = 0; i < SESSION_BARS; i++) {
    const forward = forwardAt(day, i);
    out.forward[i] = forward == null ? null : r6(forward);
    for (const [kind, strike] of [
      ['CE', legs.ceStrike],
      ['PE', legs.peStrike],
    ] as const) {
      const g = legGreeks(day, kind, strike, i, forward);
      if (!g) continue;
      for (const key of GREEK_KEYS) out[kind][key][i] = g[key];
    }
  }
  return out;
}
