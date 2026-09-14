/**
 * NSE index option trading symbols, built from an expiry and a strike.
 *
 * Building the name directly is what lets the analysis read expired contracts' history without the
 * per-date instrument master, which costs 40-45s a date (see backtestRefdataStore.ts). Every form
 * below was confirmed against `charts/timeseries` on 2026-09-13:
 *
 *   weekly   NIFTY2561225250CE   yy=25, month code 6, day 12
 *            NIFTY25D1626100CE   month code D = December
 *            NIFTY26O0618800CE   month code O = October, day zero-padded
 *   monthly  NIFTY25APR24300CE   the month's LAST expiry uses the three-letter month and no day
 *
 * The monthly rule is "last expiry in its calendar month", not whatever flag the local parquet tree
 * files it under: that tree labels 2025-04-24 WEEK, and only `NIFTY25APR…` returns data for it. A
 * wrong name is not an empty answer either — the endpoint 500s, and takes every other symbol in the
 * same request down with it.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKLY_MONTH_CODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

export type OptionSide = 'CE' | 'PE';

/** `expiry` is YYYY-MM-DD. */
export function nseOptionSymbol(
  underlying: string,
  expiry: string,
  strike: number,
  side: OptionSide,
  monthly: boolean,
): string {
  const [year, month, day] = expiry.split('-');
  const yy = year.slice(2);
  const k = Math.round(strike);
  const m = Number(month) - 1;
  return monthly
    ? `${underlying}${yy}${MONTHS[m]}${k}${side}`
    : `${underlying}${yy}${WEEKLY_MONTH_CODES[m]}${day}${k}${side}`;
}

/**
 * True when no later expiry in `calendar` falls in the same calendar month.
 *
 * Only as good as the calendar: an expiry at the edge of an incomplete list reads as monthly. The
 * sources guard against that by retrying the other form when a name comes back empty.
 */
export function isMonthlyExpiry(expiry: string, calendar: readonly string[]): boolean {
  const month = expiry.slice(0, 7);
  return !calendar.some((e) => e > expiry && e.slice(0, 7) === month);
}
