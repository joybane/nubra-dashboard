import { describe, expect, it } from 'vitest';
import {
  barAt,
  formatHms,
  istSecondOfDay,
  minuteVwap,
  parseHms,
  parseSecondBars,
  pickEntryPrice,
  validateEntryTime,
  type SecBar,
} from './intradayBars.ts';

const DATE = '2026-09-15';
/** 10:00:00 IST on Tuesday 15 Sep 2026. */
const NOW = Date.parse('2026-09-15T04:30:00Z');
const T = (hms: string) => parseHms(hms)!;
const ns = (sec: number, date = DATE) =>
  String(BigInt(Date.parse(`${date}T00:00:00Z`) - 19_800_000 + sec * 1000) * 1_000_000n);
const bar = (sec: number, close: number, extra: Partial<SecBar> = {}): SecBar => ({
  sec,
  open: close,
  high: close,
  low: close,
  close,
  cumVol: null,
  ...extra,
});

describe('parseSecondBars', () => {
  it('aligns fields by timestamp, converts paise, and keeps only the requested date', () => {
    const at = T('09:25:30');
    const res = {
      result: [
        {
          values: [
            {
              SYM: {
                close: [
                  { ts: ns(at), v: 8450 },
                  { ts: ns(at + 1), v: 8500 },
                  { ts: ns(at, '2026-09-14'), v: 1 },
                ],
                open: [{ ts: ns(at), v: 8400 }],
                high: [{ ts: ns(at), v: 8460 }],
                low: [{ ts: ns(at), v: 8390 }],
                cumulative_volume: [{ ts: ns(at), v: 1000 }],
              },
            },
          ],
        },
      ],
    };
    expect(parseSecondBars(res, 'SYM', DATE)).toEqual([
      { sec: at, open: 84, high: 84.6, low: 83.9, close: 84.5, cumVol: 1000 },
      { sec: at + 1, open: 85, high: 85, low: 85, close: 85, cumVol: null },
    ]);
  });
});

describe('barAt', () => {
  const bars = [bar(100, 1), bar(105, 2)];
  it('takes the exact second when it traded', () => {
    expect(barAt(bars, 105)).toEqual({ bar: bars[1], exact: true });
  });
  it('falls back to the last earlier trade, never a later one', () => {
    expect(barAt(bars, 103)).toEqual({ bar: bars[0], exact: false });
    expect(barAt(bars, 200)).toEqual({ bar: bars[1], exact: false });
  });
  it('is null before the first trade of the day', () => {
    expect(barAt(bars, 99)).toBeNull();
  });
});

describe('VWAP and price sources', () => {
  // Minute 09:25; the entry is 09:25:30.
  const bars = [
    bar(T('09:24:50'), 80, { cumVol: 1000 }),
    bar(T('09:25:05'), 84, { cumVol: 1100 }),
    bar(T('09:25:25'), 86, { cumVol: 1400, high: 87 }),
    bar(T('09:25:35'), 90, { cumVol: 1500 }),
  ];

  it('weights each second of the minute, up to the entry second, by its volume step', () => {
    // (100 × 84 + 300 × 86) / 400
    expect(minuteVwap(bars, T('09:25:30'))).toBe(85.5);
  });

  it('reads OHLC off the trade at or before the entry second', () => {
    expect(pickEntryPrice(bars, T('09:25:30'), 'high')).toMatchObject({
      ok: true,
      price: 87,
      exact: false,
    });
  });

  it('falls back to Close, and says so, when no volume can be measured', () => {
    const quiet = [bar(T('09:25:10'), 50), bar(T('09:25:20'), 52)];
    expect(pickEntryPrice(quiet, T('09:25:30'), 'vwap')).toMatchObject({
      ok: true,
      price: 52,
      vwapFallback: true,
    });
  });
});

describe('validateEntryTime', () => {
  it('accepts a second earlier today inside the session', () => {
    const c = validateEntryTime('NSE', '09:25:30', NOW);
    expect(c).toMatchObject({ ok: true, date: DATE, sec: T('09:25:30') });
    if (c.ok) expect(istSecondOfDay(c.timeNs / 1_000_000)).toBe(T('09:25:30'));
  });

  it('rejects now, the future, pre-open and malformed times', () => {
    expect(validateEntryTime('NSE', '10:00:00', NOW)).toMatchObject({ ok: false });
    expect(validateEntryTime('NSE', '11:00:00', NOW)).toMatchObject({ ok: false });
    expect(validateEntryTime('NSE', '09:14:59', NOW)).toMatchObject({ ok: false });
    expect(validateEntryTime('NSE', '9:25', NOW)).toMatchObject({ ok: false });
  });

  it('uses the MCX session for MCX and refuses a weekend', () => {
    expect(validateEntryTime('MCX', '09:05:00', NOW)).toMatchObject({ ok: true });
    const sunday = Date.parse('2026-09-13T04:30:00Z');
    expect(validateEntryTime('NSE', '09:25:30', sunday)).toMatchObject({ ok: false });
  });

  it('formats seconds back to HH:MM:SS', () => {
    expect(formatHms(T('09:05:07'))).toBe('09:05:07');
  });
});
