/**
 * One definition of "which day" for everything that keys data by trading date.
 *
 * Everything here works in **UTC**, because refdataCache.ts's `cacheDay()` does — the same date
 * string is both a cache key and an upstream URL segment. A helper that disagreed with it about
 * which side of the rollover we are on would warm one date while the pane asked for another, which
 * is precisely the bug this module was added to remove. Note the practical consequence: the day
 * rolls over at 05:30 IST, not midnight.
 *
 * Holidays are deliberately not modelled. Getting them right needs an exchange calendar that would
 * have to be kept current; getting them wrong costs a cache miss, not a wrong answer. A warm that
 * lands on a holiday simply misses and the caller pays the cold path once, exactly as it does today.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The most recent weekday strictly *before* `today`.
 *
 * This is the Nubra BT pane's default date, so it is also what the server pre-downloads the
 * instrument master for. `src/NubraBacktest.tsx` computes the same rule for its date input; the two
 * must agree or the prefetch warms a date nobody asks for. Returns `''` for a malformed input
 * rather than throwing — callers treat that as "nothing to warm".
 */
export function previousTradingDay(today: string): string {
  if (!ISO_DATE.test(today)) return '';
  const d = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * True when `date` is strictly before `today`, and therefore can never change again.
 *
 * This is the gate for every durable cache of historical market data: a past date's instrument
 * master and its 1m bars are immutable, while today's grow as the session runs. Both YYYY-MM-DD, so
 * a lexicographic compare is a date compare.
 */
export function isPastDate(date: string, today: string): boolean {
  return ISO_DATE.test(date) && ISO_DATE.test(today) && date < today;
}
