import { describe, expect, test } from 'vitest';
import type { OpeningDaySummary } from './openingStrangle';
import { compareOpeningIv, sortOpeningDays, summarizeOpeningReport } from './openingStrangleReport';

function session(date: string, values: Partial<OpeningDaySummary> = {}): OpeningDaySummary {
  return {
    date,
    source: 'nubra',
    expiry: date,
    monthly: false,
    dte: 0,
    dteGroup: '0',
    entry: 0,
    entrySpot: 22000,
    ceStrike: 22100,
    peStrike: 21900,
    ceEntry: 30,
    peEntry: 20,
    quantity: 20,
    entryCredit: 1000,
    entryIv: 14,
    spotMove: 1,
    ivChange: 1,
    touch: 'Neither',
    close: 50,
    best: { minute: 300, pnl: 50 },
    worst: { minute: 25, pnl: -100 },
    drawdown: 200,
    marked: 375,
    possible: 375,
    lastMarked: 374,
    ...values,
  };
}

describe('opening strangle report statistics', () => {
  test('uses observed threshold reaches and an exact close denominator, with strict recovery', () => {
    const rows = [
      session('2026-01-01', { worst: { minute: 0, pnl: -1000 }, close: -1000 }),
      session('2026-01-02', { worst: { minute: 0, pnl: -1100 }, close: 10 }),
      session('2026-01-03', { worst: { minute: 0, pnl: -1300 }, close: null }),
      session('2026-01-04', { worst: { minute: 0, pnl: -1400 }, close: -999 }),
      session('2026-01-05', { worst: { minute: 0, pnl: -900 }, close: 200 }),
      session('2026-01-06', { worst: { minute: 0, pnl: -900 }, close: 200, entryCredit: 0 }),
    ];
    const { thresholds, missingCredit } = summarizeOpeningReport(rows, 'rupees');
    expect(missingCredit).toBe(1);
    expect(thresholds[2]).toMatchObject({
      percent: 100,
      reached: 4,
      closeN: 3,
      recovered: 2,
      positive: 1,
    });
    expect(thresholds[2].recoveredPct).toBeCloseTo((100 * 2) / 3);
    expect(thresholds[2].positivePct).toBeCloseTo(100 / 3);
  });

  test('groups annual outcomes, bins zero and boundaries, and omits no-loss days from timing', () => {
    const rows = [
      session('2025-01-01', { worst: { minute: 0, pnl: 0 }, drawdown: 0, close: 0 }),
      session('2026-01-01', { worst: { minute: 45, pnl: -250 }, drawdown: 500, close: 100 }),
      session('2026-01-02', { worst: { minute: 374, pnl: -500 }, drawdown: 600, close: null }),
      session('2026-01-03', {
        worst: { minute: 46, pnl: -175 },
        drawdown: 600,
        close: 300,
        entryCredit: 0,
      }),
    ];
    const report = summarizeOpeningReport(rows, 'creditPct');
    expect(report).toMatchObject({
      exactCloses: 3,
      closeN: 2,
      pathN: 3,
      lossN: 3,
      medianWorst: -25,
      medianDrawdown: 50,
    });
    expect(
      report.years.map(({ year, sessions, exactCloses, closeN }) => [
        year,
        sessions,
        exactCloses,
        closeN,
      ]),
    ).toEqual([
      ['2026', 3, 2, 1],
      ['2025', 1, 1, 1],
    ]);
    expect(report.lossHours[0].count).toBe(0);
    expect(report.lossHours[1].count).toBe(2);
    expect(report.lossHours[6].count).toBe(1);
    expect(report.bands.map(({ worst }) => worst)).toEqual([1, 0, 1, 1, 0, 0]);
    expect(report.worstDays.map(({ date }) => date)).toEqual(['2026-01-02', '2026-01-01']);
  });

  test('sorts prices in the selected unit with missing closes last and stable date ties', () => {
    const rows = [
      session('2026-01-01', { close: 100 }),
      session('2026-01-02', { close: 100 }),
      session('2026-01-03', { close: null }),
      session('2026-01-04', { close: 200, entryCredit: 4000 }),
    ];
    const dates = (result: OpeningDaySummary[]) => result.map(({ date }) => date.slice(-2));
    expect(dates(sortOpeningDays(rows, 'close', 'asc', 'creditPct'))).toEqual([
      '04',
      '02',
      '01',
      '03',
    ]);
    expect(dates(sortOpeningDays(rows, 'close', 'desc', 'rupees'))).toEqual([
      '04',
      '02',
      '01',
      '03',
    ]);
  });

  test('compares IV direction among sessions with similar spot moves in the selected expiry group', () => {
    const rows = [
      session('2026-01-01', { spotMove: 1, ivChange: -1, close: 100 }),
      session('2026-01-02', { spotMove: 1, ivChange: 1, close: -200 }),
      session('2026-01-03', { spotMove: 2, ivChange: 0 }),
      session('2026-01-04', { spotMove: 3, ivChange: null }),
      session('2026-01-05', { spotMove: null, ivChange: -1 }),
      session('2026-01-06', { spotMove: 4, ivChange: 1, close: null }),
      session('2026-01-07', { spotMove: 1, ivChange: 1, dte: 1, dteGroup: '1' }),
    ];
    const result = compareOpeningIv(rows, '0', 'rupees');
    expect(result).toMatchObject({ dte: '0', missing: 2, unchanged: 1 });
    expect(result.strata[0]).toMatchObject({
      fell: { closeN: 1, medianClose: 100 },
      rose: { closeN: 1, medianClose: -200 },
    });
    expect(result.strata[2].rose).toMatchObject({ sessions: 1, closeN: 0, medianClose: null });
  });
});
