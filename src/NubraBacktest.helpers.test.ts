import { describe, expect, test } from 'vitest';
import { defaultBacktestDate } from './lib/tradingDay';
import { previousTradingDay } from '../server/tradingDay.ts';

/**
 * The pane's default date and the server's background prefetch must resolve to the same day. If
 * they drift, the warm downloads a date nobody asks for and the user pays the cold 40-45s
 * instrument-master download the warm exists to remove — silently, with no test failing.
 */
describe('defaultBacktestDate', () => {
  test('is the most recent weekday before today, in UTC', () => {
    // 2026-08-14T02:46Z is 08:16 IST — the time in the original bug report.
    expect(defaultBacktestDate(new Date('2026-08-14T02:46:00.000Z'))).toBe('2026-08-13');
  });

  test('skips the weekend', () => {
    expect(defaultBacktestDate(new Date('2026-08-17T04:00:00.000Z'))).toBe('2026-08-14'); // Mon
    expect(defaultBacktestDate(new Date('2026-08-16T04:00:00.000Z'))).toBe('2026-08-14'); // Sun
    expect(defaultBacktestDate(new Date('2026-08-15T04:00:00.000Z'))).toBe('2026-08-14'); // Sat
  });

  test('does not slip an extra day in the early-morning IST window', () => {
    // 22:00Z on Sunday is 03:30 IST Monday. The old implementation mixed local-time arithmetic
    // with a UTC serialization and returned Thursday here instead of Friday.
    expect(defaultBacktestDate(new Date('2026-08-16T22:00:00.000Z'))).toBe('2026-08-14');
  });

  test('agrees with the server rule on every day of a year', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 400; i++) {
      const today = d.toISOString().slice(0, 10);
      expect(defaultBacktestDate(d)).toBe(previousTradingDay(today));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  });
});
