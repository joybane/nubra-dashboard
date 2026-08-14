import { describe, expect, it } from 'vitest';
import { emptyHistoryMessage, formatChartDay } from './emptyHistory';

describe('emptyHistoryMessage', () => {
  it('keeps the original wording when no probe ran', () => {
    // Non-options, and probe failures, must not gain a claim nothing verified.
    expect(emptyHistoryMessage({ interval: '1m', windowDays: 3 })).toBe(
      'No historical data available.',
    );
  });

  it('says the contract never traded when the wide probe also found nothing', () => {
    const msg = emptyHistoryMessage({
      interval: '1m',
      windowDays: 3,
      probeDays: 365,
      lastTradedDay: null,
    });
    expect(msg).toContain('has not traded in the last 365 days');
  });

  it('points at 1d and names the last trading day when the probe found one', () => {
    const msg = emptyHistoryMessage({
      interval: '1m',
      windowDays: 3,
      probeDays: 365,
      lastTradedDay: { year: 2026, month: 8, day: 5 },
    });
    expect(msg).toBe(
      'No 1m candles in the last 3 days. Last traded 5 Aug 26 — switch to 1d to see it.',
    );
  });
});

describe('formatChartDay', () => {
  it('renders the chart-time day object as a short IST date', () => {
    expect(formatChartDay({ year: 2026, month: 12, day: 31 })).toBe('31 Dec 26');
  });
});
