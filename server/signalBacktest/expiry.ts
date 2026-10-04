/**
 * How many trading days a date is from its expiry: 0 on the expiry day itself, 1 on the trading day
 * before it ("expiry-1"), 2 the one before that, and so on.
 *
 * Counted in trading days, not calendar days: with a Tuesday expiry, Monday is 1 and the Friday
 * before it is 2. The exchange calendar is not modelled (see server/tradingDay.ts), so the calendar
 * is the list of days the data holds — a holiday is simply a day with no data. Past the last day the
 * data holds there is nothing to look up, so plain weekdays stand in.
 */

const DAY_MS = 86_400_000;

const stamp = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Weekdays strictly between two dates. */
function weekdaysBetween(after: string, before: string): number {
  let n = 0;
  for (let t = stamp(after) + DAY_MS; t < stamp(before); t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

/** First index in a sorted list whose date is greater than `date`. */
function firstAfter(sorted: readonly string[], date: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `calendar` is every date the data holds, ascending. Null when the expiry is before the date (a
 * stale expiry), so a wrong label is never shown.
 */
export function daysToExpiry(
  date: string,
  expiry: string,
  calendar: readonly string[],
): number | null {
  if (!(stamp(date) <= stamp(expiry))) return null;
  if (date === expiry) return 0;
  const from = firstAfter(calendar, date);
  const to = firstAfter(calendar, expiry);
  // Listed days strictly between, leaving out the expiry day itself if the data holds it.
  let between = to - from - (calendar[to - 1] === expiry ? 1 : 0);
  const last = calendar.at(-1);
  if (last == null || last < expiry) {
    between += weekdaysBetween(last != null && last > date ? last : date, expiry);
  }
  return between + 1;
}
