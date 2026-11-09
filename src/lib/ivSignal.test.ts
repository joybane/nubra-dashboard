import { describe, expect, test } from 'vitest';
import { IV_CUTS, ivLevelOf, ivSignalByDate } from './ivSignal';
import type { SignalBacktestRow } from './signalBacktest';

const row = (date: string, dte: number | null, ce: number | null, pe = ce) =>
  ({
    date,
    dte,
    signal: {
      greeks: {
        t1: { CE: null, PE: null },
        t2: {
          CE: ce == null ? null : { iv: ce, delta: 0, gamma: 0, theta: 0, vega: 0 },
          PE: pe == null ? null : { iv: pe, delta: 0, gamma: 0, theta: 0, vega: 0 },
        },
      },
    },
  }) as unknown as SignalBacktestRow;

describe('ivLevelOf', () => {
  const cuts = IV_CUTS.NIFTY[0];
  test('a ratio on a cut-off stays in the lower level, as on the phone', () => {
    expect(ivLevelOf(cuts[0], cuts)).toBe(0);
    expect(ivLevelOf(cuts[3], cuts)).toBe(3);
  });
  test('above the last cut-off is the top level', () => {
    expect(ivLevelOf(cuts[3] + 0.001, cuts)).toBe(4);
  });
});

describe('ivSignalByDate', () => {
  test('needs four earlier readings on the same days to expiry', () => {
    const rows = ['01', '02', '03', '04'].map((d) => row(`2026-01-${d}`, 0, 10));
    const out = ivSignalByDate(rows, 'NIFTY');
    expect(out.get('2026-01-04')?.usual).toBeNull();
    const five = ivSignalByDate([...rows, row('2026-01-05', 0, 20)], 'NIFTY');
    expect(five.get('2026-01-05')).toMatchObject({ ivNow: 20, usual: 10, ratio: 2, level: 4 });
  });

  test('history is kept apart per days to expiry and only looks backwards', () => {
    const rows = [
      ...['01', '02', '03', '04'].map((d) => row(`2026-01-${d}`, 1, 10)),
      row('2026-01-05', 2, 40),
      row('2026-01-06', 1, 10),
      row('2026-01-07', 1, 90),
    ];
    const out = ivSignalByDate(rows.reverse(), 'NIFTY');
    expect(out.get('2026-01-05')?.usual).toBeNull();
    expect(out.get('2026-01-06')?.usual).toBe(10);
  });

  test('uses only the last 20 readings', () => {
    const old = Array.from({ length: 30 }, (_, i) =>
      row(`2026-0${i < 15 ? 1 : 2}-${String((i % 15) + 1).padStart(2, '0')}`, 3, i < 10 ? 100 : 10),
    );
    const out = ivSignalByDate([...old, row('2026-03-01', 3, 10)], 'NIFTY');
    expect(out.get('2026-03-01')?.usual).toBe(10);
  });

  test('a missing leg or days beyond the cut-offs gives no level', () => {
    const out = ivSignalByDate([row('2026-01-01', 0, 10, null), row('2026-01-02', 5, 10)], 'NIFTY');
    expect(out.get('2026-01-01')?.ivNow).toBeNull();
    expect(out.get('2026-01-02')).toMatchObject({ ivNow: 10, level: null });
  });
});
