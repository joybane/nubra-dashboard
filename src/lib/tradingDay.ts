/**
 * The date the Nubra BT pane opens on: the most recent weekday strictly before today, in **UTC**.
 *
 * Must stay identical to `previousTradingDay` in server/tradingDay.ts. The server pre-downloads
 * that date's instrument master in the background, and a mismatch means the user pays the cold
 * 40-45s download the warm exists to avoid — silently, since nothing would error. The tsconfigs for
 * src/ and server/ are disjoint, so the rule is duplicated rather than imported; server/tradingDay.ts
 * is the canonical copy and NubraBacktest.helpers.test.ts asserts the two agree on every day of a
 * year.
 *
 * UTC matters: the server's day rolls over with `cacheDay()`, which is UTC (05:30 IST). The previous
 * implementation mixed local-time arithmetic with a UTC serialization, which on an early-morning
 * Monday in IST resolved to Thursday rather than Friday.
 */
export function defaultBacktestDate(now: Date = new Date()): string {
  const d = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}
