import { describe, it, expect } from 'vitest';
import {
  IST_OFFSET,
  NSE_MARKET_CLOSE_MIN,
  NSE_MARKET_OPEN_MIN,
  SUB_MINUTE_RETENTION_MS,
  clampSubMinuteStart,
  expiryInstantMs,
  isMarketSessionChartTime,
  isNseMarketSessionChartTime,
  isSubMinuteInterval,
  marketSession,
} from './utils';

/** Chart time is IST-baked seconds, which is what every session filter is fed. */
const chartTime = (iso: string): number => Date.parse(`${iso}+05:30`) / 1000 + IST_OFFSET;

describe('marketSession', () => {
  it('keeps NSE and BSE on the session the old constants hardcoded', () => {
    for (const ex of ['NSE', 'BSE', 'nse']) {
      expect(marketSession(ex)).toEqual({
        openMin: NSE_MARKET_OPEN_MIN,
        closeMin: NSE_MARKET_CLOSE_MIN,
      });
    }
    expect(marketSession(undefined)).toEqual({ openMin: 9 * 60 + 15, closeMin: 15 * 60 + 30 });
  });

  it('runs MCX 09:00–23:30 — 870 one-minute bars a day, as measured', () => {
    const { openMin, closeMin } = marketSession('MCX');
    expect(openMin).toBe(9 * 60);
    expect(closeMin).toBe(23 * 60 + 30);
    expect(closeMin - openMin).toBe(870);
  });

  it('falls back to NSE for an exchange it does not know', () => {
    expect(marketSession('NYMEX')).toEqual(marketSession('NSE'));
  });
});

describe('isMarketSessionChartTime', () => {
  it('is unchanged for NSE — the whole point of the exchange parameter being optional', () => {
    expect(isMarketSessionChartTime(chartTime('2026-08-03T09:15:00'))).toBe(true);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T15:30:00'))).toBe(true);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T09:14:00'))).toBe(false);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T15:31:00'))).toBe(false);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T20:00:00'))).toBe(false);
  });

  it('the deprecated NSE-only wrapper still agrees with the general form', () => {
    for (const t of ['09:14', '09:15', '12:00', '15:30', '15:31', '20:00']) {
      const ct = chartTime(`2026-08-03T${t}:00`);
      expect(isNseMarketSessionChartTime(ct)).toBe(isMarketSessionChartTime(ct, 'NSE'));
    }
  });

  it('keeps the MCX evening session that the NSE filter would have discarded', () => {
    const evening = chartTime('2026-08-03T20:00:00');
    expect(isMarketSessionChartTime(evening, 'NSE')).toBe(false);
    expect(isMarketSessionChartTime(evening, 'MCX')).toBe(true);

    expect(isMarketSessionChartTime(chartTime('2026-08-03T09:00:00'), 'MCX')).toBe(true);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T23:29:00'), 'MCX')).toBe(true);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T23:31:00'), 'MCX')).toBe(false);
    expect(isMarketSessionChartTime(chartTime('2026-08-03T08:59:00'), 'MCX')).toBe(false);
  });

  it('passes through a daily bar (object time), which carries no minute to judge', () => {
    expect(isMarketSessionChartTime({ year: 2026, month: 8, day: 3 }, 'MCX')).toBe(true);
  });
});

describe('expiryInstantMs', () => {
  const at = (iso: string) => Date.parse(`${iso}+05:30`);

  it('settles NSE/BSE at 15:30 IST, matching what yearsToExpiry always used', () => {
    expect(expiryInstantMs('20260811')).toBe(at('2026-08-11T15:30:00'));
    expect(expiryInstantMs('2026-08-11')).toBe(at('2026-08-11T15:30:00'));
    expect(expiryInstantMs('20260811', 'BSE')).toBe(at('2026-08-11T15:30:00'));
    // The literal the old implementation used, spelled the old way.
    expect(expiryInstantMs('20260811', 'NSE')).toBe(Date.parse('2026-08-11T10:00:00Z'));
  });

  it('settles MCX at its own close, ~9 hours later', () => {
    expect(expiryInstantMs('20260817', 'MCX')).toBe(at('2026-08-17T23:30:00'));
    const gapHours = (expiryInstantMs('20260817', 'MCX') - expiryInstantMs('20260817')) / 3_600_000;
    expect(gapHours).toBe(8);
  });

  it('returns NaN rather than a wrong instant for an unparseable expiry', () => {
    expect(Number.isNaN(expiryInstantMs('not-a-date'))).toBe(true);
    expect(Number.isNaN(expiryInstantMs('2026081'))).toBe(true);
    expect(Number.isNaN(expiryInstantMs(''))).toBe(true);
  });
});

describe('clampSubMinuteStart', () => {
  const now = Date.parse('2026-08-03T21:07:00+05:30');
  const insideWindow = new Date(now - 2 * 86_400_000);
  const outsideWindow = new Date(now - 30 * 86_400_000);

  it('knows which intervals are actually sub-minute', () => {
    expect(isSubMinuteInterval('1s')).toBe(true);
    expect(isSubMinuteInterval('10s')).toBe(true);
    // 5s is accepted by the API but returns nothing; 15s/30s 500. Neither is offered.
    expect(isSubMinuteInterval('5s')).toBe(false);
    expect(isSubMinuteInterval('1m')).toBe(false);
    expect(isSubMinuteInterval('1d')).toBe(false);
  });

  it('leaves every non-sub-minute interval completely alone', () => {
    for (const iv of ['1m', '5m', '1h', '1d', '1w']) {
      expect(clampSubMinuteStart(outsideWindow, iv, now)).toBe(outsideWindow);
    }
  });

  it('leaves a start already inside the 7-day window alone', () => {
    expect(clampSubMinuteStart(insideWindow, '1s', now)).toBe(insideWindow);
  });

  it('pulls a start older than 7 days forward, since the API 500s the whole query', () => {
    const clamped = clampSubMinuteStart(outsideWindow, '1s', now);
    expect(clamped.getTime()).toBeGreaterThan(now - SUB_MINUTE_RETENTION_MS);
    expect(clamped.getTime()).toBeLessThan(now);
    expect(clampSubMinuteStart(outsideWindow, '10s', now).getTime()).toBe(clamped.getTime());
  });
});
