import { describe, expect, test } from 'vitest';
import { isPastDate, previousTradingDay } from './tradingDay.ts';

describe('previousTradingDay', () => {
  test('steps back one day within a week', () => {
    // 2026-08-14 is a Friday.
    expect(previousTradingDay('2026-08-14')).toBe('2026-08-13');
    expect(previousTradingDay('2026-08-13')).toBe('2026-08-12');
  });

  test('skips the weekend from every side of it', () => {
    expect(previousTradingDay('2026-08-17')).toBe('2026-08-14'); // Mon → Fri
    expect(previousTradingDay('2026-08-16')).toBe('2026-08-14'); // Sun → Fri
    expect(previousTradingDay('2026-08-15')).toBe('2026-08-14'); // Sat → Fri
  });

  test('crosses month and year boundaries', () => {
    expect(previousTradingDay('2026-09-01')).toBe('2026-08-31');
    expect(previousTradingDay('2027-01-01')).toBe('2026-12-31');
    // 2027-03-01 is a Monday, so it must reach back past the weekend into February.
    expect(previousTradingDay('2027-03-01')).toBe('2027-02-26');
  });

  test('handles a leap day', () => {
    expect(previousTradingDay('2028-03-01')).toBe('2028-02-29');
  });

  test('always returns a weekday', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 400; i++) {
      const day = new Date(previousTradingDay(d.toISOString().slice(0, 10)) + 'T00:00:00.000Z');
      expect(day.getUTCDay()).not.toBe(0);
      expect(day.getUTCDay()).not.toBe(6);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  });

  test('returns empty for a malformed date rather than throwing', () => {
    // Callers treat '' as "nothing to warm"; a crash here would take down server boot.
    expect(previousTradingDay('')).toBe('');
    expect(previousTradingDay('14-08-2026')).toBe('');
    expect(previousTradingDay('not-a-date')).toBe('');
  });
});

describe('isPastDate', () => {
  test('is true only strictly before today', () => {
    expect(isPastDate('2026-08-13', '2026-08-14')).toBe(true);
    expect(isPastDate('2026-08-14', '2026-08-14')).toBe(false);
    expect(isPastDate('2026-08-15', '2026-08-14')).toBe(false);
  });

  test('compares across month and year boundaries', () => {
    expect(isPastDate('2026-12-31', '2027-01-01')).toBe(true);
    expect(isPastDate('2026-09-01', '2026-08-31')).toBe(false);
  });

  test('is false for malformed input, so nothing unparseable is ever cached as immutable', () => {
    expect(isPastDate('', '2026-08-14')).toBe(false);
    expect(isPastDate('2026-08-13', '')).toBe(false);
    expect(isPastDate('13-08-2026', '2026-08-14')).toBe(false);
  });
});
