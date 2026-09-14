import { describe, expect, test } from 'vitest';
import { isMonthlyExpiry, nseOptionSymbol } from './optionNames.ts';

describe('nseOptionSymbol', () => {
  // Every expected value below returned bars from charts/timeseries when this was written.
  test('weekly form: yy, one-character month code, zero-padded day', () => {
    expect(nseOptionSymbol('NIFTY', '2025-06-12', 25250, 'CE', false)).toBe('NIFTY2561225250CE');
    expect(nseOptionSymbol('NIFTY', '2025-12-16', 26100, 'CE', false)).toBe('NIFTY25D1626100CE');
    expect(nseOptionSymbol('NIFTY', '2026-10-06', 18800, 'CE', false)).toBe('NIFTY26O0618800CE');
    expect(nseOptionSymbol('NIFTY', '2026-06-02', 23850, 'PE', false)).toBe('NIFTY2660223850PE');
  });

  test('monthly form: three-letter month, no day', () => {
    expect(nseOptionSymbol('NIFTY', '2025-04-24', 24300, 'CE', true)).toBe('NIFTY25APR24300CE');
    expect(nseOptionSymbol('NIFTY', '2026-09-29', 29150, 'CE', true)).toBe('NIFTY26SEP29150CE');
  });
});

describe('isMonthlyExpiry', () => {
  const calendar = ['2025-04-03', '2025-04-09', '2025-04-17', '2025-04-24', '2025-04-30'];

  test('only the last expiry of a month is monthly', () => {
    expect(isMonthlyExpiry('2025-04-30', calendar)).toBe(true);
    expect(isMonthlyExpiry('2025-04-24', calendar)).toBe(false);
    expect(isMonthlyExpiry('2025-04-03', calendar)).toBe(false);
  });

  test('a later expiry in the next month does not count', () => {
    expect(isMonthlyExpiry('2025-04-24', ['2025-04-24', '2025-05-01'])).toBe(true);
  });
});
