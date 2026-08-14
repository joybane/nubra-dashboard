/**
 * Wording for a chart whose history request came back with no candles.
 *
 * "No historical data available." is true but useless for options, which is where this happens most.
 * A strike far out of the money is listed and perfectly valid, yet may not trade for weeks — and the
 * intraday windows are short (`historyDays('1m')` is three days), so an empty result is usually a
 * fact about the contract rather than a failed request. Separating the two takes one wide daily
 * probe, and the answer decides which of these sentences the user sees.
 *
 * Pure so the phrasing can be tested without a chart or a network call; the probe itself lives in
 * CandleChart, next to `fetchRange`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The shape `toChartTime` returns for non-intraday intervals. */
export interface ChartDay {
  year: number;
  month: number;
  day: number;
}

export function formatChartDay(day: ChartDay): string {
  return `${day.day} ${MONTHS[day.month - 1] ?? '?'} ${String(day.year).slice(2)}`;
}

export interface EmptyHistoryArgs {
  /** The interval the user is looking at. */
  interval: string;
  /** How many days back the failed request covered. */
  windowDays: number;
  /**
   * How many days the wide daily probe covered, or undefined when no probe ran — which is the case
   * for anything that is not an option, and when the probe itself failed. Then the message stays
   * the original generic one rather than claiming something we did not check.
   */
  probeDays?: number;
  /** Last day the probe found a candle on, or null when it found none at all. */
  lastTradedDay?: ChartDay | null;
}

export function emptyHistoryMessage({
  interval,
  windowDays,
  probeDays,
  lastTradedDay,
}: EmptyHistoryArgs): string {
  if (probeDays == null) return 'No historical data available.';
  if (!lastTradedDay) {
    return `This contract has not traded in the last ${probeDays} days — there is nothing to chart at any interval.`;
  }
  return `No ${interval} candles in the last ${windowDays} days. Last traded ${formatChartDay(lastTradedDay)} — switch to 1d to see it.`;
}
