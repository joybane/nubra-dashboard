/**
 * The option chain of one stored day at one minute, for the Trade Explorer's trade detail.
 *
 * Closes come from the day cache first, so the strikes the signal was measured on read exactly the
 * numbers the run reports, and from the wider price source (Nubra wide download or the parquet tree)
 * for strikes the day's ladder does not hold. IV and greeks are rebuilt the way `greeks.ts` rebuilds
 * the signal's: Black-76 off the parity forward, so a chain from 2022 and one from 2026 compare.
 * Volume, OI and bid/ask exist only on days with a Nubra wide download; elsewhere they are null.
 */
import { RISK_FREE, blackScholes, impliedVolatility } from '../../src/lib/GexService.ts';
import { STRIKE_STEP, type DaySeries } from '../analysis/daySeries.ts';
import { forwardAt, yearsToExpiry } from '../analysis/greeks.ts';
import type { OhlcSource, OptionKind } from './trade.ts';
import type { WideDay } from './wideSource.ts';

/** Strikes shown on each side of the at-the-money strike. */
export const CHAIN_STEPS = 10;

export interface ChainSide {
  close: number;
  iv: number | null;
  delta: number | null;
  theta: number | null;
  vega: number | null;
  volume: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
}

export interface ChainRow {
  strike: number;
  ce: ChainSide | null;
  pe: ChainSide | null;
}

export interface ChainResult {
  spot: number;
  forward: number | null;
  atm: number;
  step: number;
  rows: ChainRow[];
}

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

function side(
  day: DaySeries,
  kind: OptionKind,
  strike: number,
  index: number,
  forward: number | null,
  ohlc: OhlcSource | null,
  wide: WideDay | null,
): ChainSide | null {
  const key = String(strike);
  const close =
    (kind === 'CE' ? day.ce : day.pe)[key]?.[index] ?? ohlc?.series(kind, strike)?.c[index] ?? null;
  if (close == null || !(close > 0)) return null;
  const more = wide?.more?.[kind === 'CE' ? 'ce' : 'pe']?.[key];
  const out: ChainSide = {
    close: round(close, 2),
    iv: null,
    delta: null,
    theta: null,
    vega: null,
    volume: more?.cumulative_volume?.[index] ?? null,
    oi: more?.cumulative_oi?.[index] ?? null,
    bid: more?.l1bid?.[index] ?? null,
    ask: more?.l1ask?.[index] ?? null,
  };
  if (forward == null) return out;
  const T = yearsToExpiry(day.date, day.expiry, index);
  const iv = impliedVolatility(close, forward, strike, T, RISK_FREE, kind);
  if (!Number.isFinite(iv) || iv <= 0) return out;
  const g = blackScholes(forward, strike, T, RISK_FREE, iv, kind);
  out.iv = round(iv * 100, 2);
  out.delta = round(g.delta, 3);
  out.theta = round(g.theta, 2);
  out.vega = round(g.vega, 2);
  return out;
}

/** Null when the minute has no spot. Strikes run from the highest down, ATM ± `CHAIN_STEPS`. */
export function buildChain(
  day: DaySeries,
  index: number,
  ohlc: OhlcSource | null,
  wide: WideDay | null,
): ChainResult | null {
  const spot = day.spot[index];
  if (spot == null || !(spot > 0)) return null;
  const step = STRIKE_STEP[day.underlying] ?? 50;
  const atm = Math.round(spot / step) * step;
  const forward = forwardAt(day, index);
  const rows: ChainRow[] = [];
  for (let n = CHAIN_STEPS; n >= -CHAIN_STEPS; n--) {
    const strike = atm + n * step;
    const ce = side(day, 'CE', strike, index, forward, ohlc, wide);
    const pe = side(day, 'PE', strike, index, forward, ohlc, wide);
    if (ce || pe) rows.push({ strike, ce, pe });
  }
  return {
    spot: round(spot, 2),
    forward: forward == null ? null : round(forward, 2),
    atm,
    step,
    rows,
  };
}
