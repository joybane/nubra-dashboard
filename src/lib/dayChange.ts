import type { OhlcBar } from '../types';

/**
 * The baseline a price header's "day change" is measured from: the previous session's last close.
 *
 * Both charts used to measure from the open of the OLDEST loaded bar. That baseline moved every
 * time scroll-back paged in older history (NIFTY read −743 after one page), and it is only as
 * trustworthy as the oldest page. The previous session's close is always among the most recent
 * bars, so neither can touch it.
 */

type BarTime = OhlcBar['time'];

/** The IST calendar day of a chart time: intraday times are IST-baked seconds, daily ones dates. */
export function chartDayKey(t: BarTime): string {
  if (typeof t === 'number') return new Date(t * 1000).toISOString().slice(0, 10);
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
}

export interface DayBaseline {
  /** The session (IST day) the baseline belongs to — the last bar's day. */
  day: string;
  /** Previous session's last close, or that day's first open when no earlier day is loaded. */
  price: number;
}

/** Baseline for the session of the last bar in `bars` (sorted by time); null when empty. */
export function dayBaseline(bars: readonly OhlcBar[]): DayBaseline | null {
  if (!bars.length) return null;
  const day = chartDayKey(bars[bars.length - 1].time);
  let i = bars.length - 1;
  while (i > 0 && chartDayKey(bars[i - 1].time) === day) i--;
  return { day, price: i > 0 ? bars[i - 1].close : bars[i].open };
}
