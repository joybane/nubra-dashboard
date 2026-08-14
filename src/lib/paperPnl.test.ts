import { describe, expect, test } from 'vitest';
import type { PaperPosition } from '../types';
import { isOnLocalDay, summarizeTodayPositions } from './paperPnl';

function ns(date: Date): number {
  return date.getTime() * 1_000_000;
}

function position(overrides: Partial<PaperPosition> = {}): PaperPosition {
  return {
    ref_id: 1,
    order_side: 'ORDER_SIDE_BUY',
    qty: 1,
    avg_price: 10_000,
    last_traded_price: 10_000,
    pnl: 0,
    ...overrides,
  };
}

describe('summarizeTodayPositions', () => {
  const day = new Date(2026, 7, 14, 12, 0, 0);

  test('includes only current-day open positions and preserves gain/loss calculations', () => {
    const today = ns(new Date(2026, 7, 14, 9, 30, 0));
    const priorDay = ns(new Date(2026, 7, 13, 15, 29, 59));
    const summary = summarizeTodayPositions(
      [
        position({ ref_id: 1, entry_time: today, qty: 2, last_traded_price: 10_100 }),
        position({
          ref_id: 2,
          entry_time: today,
          order_side: 'ORDER_SIDE_SELL',
          qty: 3,
          last_traded_price: 10_100,
        }),
        position({ ref_id: 3, entry_time: priorDay, qty: 100, last_traded_price: 20_000 }),
      ],
      [],
      day,
    );

    expect(summary.open.map((item) => item.ref_id)).toEqual([1, 2]);
    expect(summary.totalPnlPaise).toBe(-100);
  });

  test('adds positions closed or entered today and excludes older closed positions', () => {
    const today = ns(new Date(2026, 7, 14, 10, 0, 0));
    const priorDay = ns(new Date(2026, 7, 13, 10, 0, 0));
    const nextDay = ns(new Date(2026, 7, 15, 10, 0, 0));
    const summary = summarizeTodayPositions(
      [],
      [
        position({ ref_id: 1, entry_time: priorDay, exit_time: today, realised_pnl: 250 }),
        position({ ref_id: 2, entry_time: today, exit_time: nextDay, realised_pnl: -100 }),
        position({ ref_id: 3, entry_time: priorDay, exit_time: priorDay, realised_pnl: 5_000 }),
      ],
      day,
    );

    expect(summary.closed.map((item) => item.ref_id)).toEqual([1, 2]);
    expect(summary.totalPnlPaise).toBe(150);
  });

  test('handles empty inputs and preserves missing-timestamp compatibility', () => {
    expect(summarizeTodayPositions([], [], day)).toEqual({
      open: [],
      closed: [],
      totalPnlPaise: 0,
    });

    const undated = position({ ref_id: 1, last_traded_price: 10_050 });
    expect(summarizeTodayPositions([undated], [], day)).toEqual({
      open: [undated],
      closed: [],
      totalPnlPaise: 50,
    });
  });

  test('uses local calendar-day boundaries', () => {
    expect(isOnLocalDay(ns(new Date(2026, 7, 14, 0, 0, 0)), day)).toBe(true);
    expect(isOnLocalDay(ns(new Date(2026, 7, 14, 23, 59, 59)), day)).toBe(true);
    expect(isOnLocalDay(ns(new Date(2026, 7, 13, 23, 59, 59)), day)).toBe(false);
    expect(isOnLocalDay(ns(new Date(2026, 7, 15, 0, 0, 0)), day)).toBe(false);
  });
});
