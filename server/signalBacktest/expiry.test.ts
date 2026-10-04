import { describe, expect, test } from 'vitest';
import { daysToExpiry } from './expiry.ts';

// Tuesday expiry 2026-01-13; Mon 2026-01-12, Fri 2026-01-09, Thu 2026-01-08 are trading days.
const week = [
  '2026-01-05',
  '2026-01-06',
  '2026-01-07',
  '2026-01-08',
  '2026-01-09',
  '2026-01-12',
  '2026-01-13',
];

describe('daysToExpiry', () => {
  test('0 on the expiry day, then counts back in trading days', () => {
    expect(daysToExpiry('2026-01-13', '2026-01-13', week)).toBe(0);
    expect(daysToExpiry('2026-01-12', '2026-01-13', week)).toBe(1);
    // The weekend is not a trading day, so Friday is 2 days before, not 4.
    expect(daysToExpiry('2026-01-09', '2026-01-13', week)).toBe(2);
    expect(daysToExpiry('2026-01-08', '2026-01-13', week)).toBe(3);
  });

  test('a holiday (a day the data does not hold) is not counted', () => {
    const noWednesday = week.filter((d) => d !== '2026-01-07');
    expect(daysToExpiry('2026-01-06', '2026-01-13', week)).toBe(5);
    expect(daysToExpiry('2026-01-06', '2026-01-13', noWednesday)).toBe(4);
  });

  test('still counts the expiry day when the data does not hold it', () => {
    const upToMonday = week.slice(0, -1);
    // Tue 13th is missing from the list but lies beyond its last day, so weekdays stand in.
    expect(daysToExpiry('2026-01-12', '2026-01-13', upToMonday)).toBe(1);
    expect(daysToExpiry('2026-01-09', '2026-01-13', upToMonday)).toBe(2);
    // Missing from the middle of the list: the days around it still count.
    const noExpiry = week.filter((d) => d !== '2026-01-13').concat('2026-01-14');
    expect(daysToExpiry('2026-01-12', '2026-01-13', noExpiry)).toBe(1);
  });

  test('beyond the last stored day, weekdays stand in for the calendar', () => {
    expect(daysToExpiry('2026-01-12', '2026-01-15', ['2026-01-12'])).toBe(3);
    // Fri to the Tuesday after: Mon and Tue.
    expect(daysToExpiry('2026-01-09', '2026-01-13', ['2026-01-09'])).toBe(2);
  });

  test('an expiry before the date is unknown, never a negative count', () => {
    expect(daysToExpiry('2026-01-13', '2026-01-08', week)).toBeNull();
  });
});
