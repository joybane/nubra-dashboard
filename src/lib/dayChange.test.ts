import { describe, expect, it } from 'vitest';
import { chartDayKey, dayBaseline } from './dayChange';
import type { OhlcBar } from '../types';

// IST-baked chart seconds for a wall-clock time.
const t = (iso: string) => Date.parse(`${iso}Z`) / 1000;
const bar = (time: OhlcBar['time'], open: number, close: number): OhlcBar => ({
  time,
  open,
  high: Math.max(open, close),
  low: Math.min(open, close),
  close,
});

describe('chartDayKey', () => {
  it('reads intraday seconds and daily dates alike', () => {
    expect(chartDayKey(t('2026-10-07T15:29:00'))).toBe('2026-10-07');
    expect(chartDayKey({ year: 2026, month: 10, day: 7 } as OhlcBar['time'])).toBe('2026-10-07');
  });
});

describe('dayBaseline', () => {
  it("is the previous session's last close, not the oldest bar", () => {
    const bars = [
      bar(t('2026-09-20T09:15:00'), 23346, 23350), // an old page from scroll-back
      bar(t('2026-10-06T15:25:00'), 55100, 55120),
      bar(t('2026-10-06T15:29:00'), 55120, 55128.4),
      bar(t('2026-10-07T09:15:00'), 55200, 55180),
      bar(t('2026-10-07T15:29:00'), 55060, 55055.55),
    ];
    expect(dayBaseline(bars)).toEqual({ day: '2026-10-07', price: 55128.4 });
  });

  it('on daily candles is the previous bar', () => {
    const d = (day: number) => ({ year: 2026, month: 10, day }) as OhlcBar['time'];
    expect(dayBaseline([bar(d(5), 1, 2), bar(d(6), 2, 3), bar(d(7), 3, 4)])?.price).toBe(3);
  });

  it("falls back to the day's open when no earlier session is loaded", () => {
    const bars = [bar(t('2026-10-07T09:15:00'), 100, 101), bar(t('2026-10-07T09:16:00'), 101, 99)];
    expect(dayBaseline(bars)).toEqual({ day: '2026-10-07', price: 100 });
  });

  it('is null with no bars', () => {
    expect(dayBaseline([])).toBeNull();
  });
});
