/**
 * The IV signal, the same reading the phone app's IV SIGNAL card shows for the day's first case.
 *
 * IV now = average of the CE and PE IV of the 09:15 ATM ± 2 legs at the signal minute (t2).
 * Usual = median of IV now on the last 20 earlier days with the same trading days to expiry, needing
 * at least 4. Ratio = IV now ÷ usual, placed in five levels by cut-offs per index and days to expiry.
 *
 * The cut-offs are the phone's, from E:\whatsup\src\assets\ivbase.txt (baseline as of 2026-10-19), so
 * a level here means what a level on the phone means. They only cover 0 to 4 days to expiry.
 */
import type { SignalBacktestRow, SignalUnderlying } from './signalBacktest';

export const IV_LEVELS = ['Very low', 'Low', 'Normal', 'High', 'Very high'] as const;

const IV_WINDOW = 20;
const IV_MIN_HISTORY = 4;

export const IV_CUTS: Record<SignalUnderlying, ReadonlyArray<readonly number[]>> = {
  NIFTY: [
    [0.814, 0.921, 1.049, 1.276],
    [0.815, 0.904, 1.039, 1.19],
    [0.801, 0.908, 1.03, 1.242],
    [0.785, 0.905, 1.03, 1.227],
    [0.773, 0.9, 1.048, 1.254],
  ],
  SENSEX: [
    [0.766, 0.96, 1.121, 1.329],
    [0.817, 0.929, 1.041, 1.224],
    [0.831, 0.93, 1.063, 1.25],
    [0.823, 0.932, 1.074, 1.22],
    [0.802, 0.947, 1.066, 1.238],
  ],
};

export interface IvReading {
  ivNow: number | null;
  usual: number | null;
  ratio: number | null;
  /** Index into IV_LEVELS. */
  level: number | null;
}

export function ivLevelOf(ratio: number, cuts: readonly number[]): number {
  const i = cuts.findIndex((c) => ratio <= c);
  return i < 0 ? cuts.length : i;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** Each row's reading, by date. Rows may come in any order; history only ever looks backwards. */
export function ivSignalByDate(
  rows: SignalBacktestRow[],
  underlying: SignalUnderlying,
): Map<string, IvReading> {
  const out = new Map<string, IvReading>();
  const history = new Map<number, number[]>();
  for (const r of [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const t2 = r.signal.greeks?.t2;
    const ce = t2?.CE?.iv;
    const pe = t2?.PE?.iv;
    const ivNow = ce != null && pe != null && ce > 0 && pe > 0 ? (ce + pe) / 2 : null;
    const cuts = r.dte != null ? IV_CUTS[underlying][r.dte] : undefined;
    if (!cuts || r.dte == null) {
      out.set(r.date, { ivNow, usual: null, ratio: null, level: null });
      continue;
    }
    const seen = history.get(r.dte) ?? [];
    const window = seen.slice(-IV_WINDOW);
    const usual = window.length >= IV_MIN_HISTORY ? median(window) : null;
    const ratio = ivNow != null && usual != null ? ivNow / usual : null;
    out.set(r.date, {
      ivNow,
      usual,
      ratio,
      level: ratio == null ? null : ivLevelOf(ratio, cuts),
    });
    if (ivNow != null) history.set(r.dte, [...seen, ivNow]);
  }
  return out;
}
