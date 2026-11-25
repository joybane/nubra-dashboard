import { describe, expect, it } from 'vitest';
import { riskFlags, strikeDistance, type DayRow } from './tradeExplorer';
import { setLine, slimSet } from './tradeExplorerCompare';
import { riskLadder, ruleYears } from './tradeExplorerRisk';

const day = (date: string, values: DayRow['values']): DayRow => ({
  raw: { date } as DayRow['raw'],
  values,
});

describe('risk signs and rule tester', () => {
  it('measures strike distance in implied moves and requires IV', () => {
    expect(strikeDistance(22100, 21900, 22000, 16, 2)).toBeCloseTo(0.27, 2);
    expect(strikeDistance(22100, 21900, 22000, null, 2)).toBeNull();
  });

  it('includes readings at the cut-offs and treats missing readings as absent', () => {
    const cuts = { iv: 1.24, dist: 0.24, gap: 546, prev: 2027 };
    const values = { ivRatio: 1.24, strikeDist: 0.24, gap: 600, prevMaxLoss: 2027 };
    expect(riskFlags(day('2025-01-01', values), cuts)).toEqual([true, true, true, true]);
    expect(riskFlags(day('2025-01-02', { ...values, ivRatio: null }), cuts)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it('combines only counts three and four in the last ladder row', () => {
    const rows = [
      day('2025-01-01', { warnCount: 0, maxLoss: 25 }),
      day('2025-01-02', { warnCount: 3, maxLoss: 10 }),
      day('2025-01-03', { warnCount: 4, maxLoss: 40 }),
      day('2025-01-04', { warnCount: 4, maxLoss: null }),
    ];
    const ladder = riskLadder(rows, 'maxLoss', 10);
    expect(ladder).toHaveLength(6);
    expect(ladder[5].days).toBe(ladder[3].days + ladder[4].days);
    expect(ladder[5]).toMatchObject({ label: '3 or more', days: 2, above: 0.5 });
  });

  it('counts flagged days above and below the line by year and overall', () => {
    const rows = [
      day('2025-01-01', { maxLoss: 25 }),
      day('2024-01-01', { maxLoss: 10 }),
      day('2024-01-02', { maxLoss: 50 }),
    ];
    const flagged = new Set(['2024-01-01', '2025-01-01']);
    const years = ruleYears(rows, flagged, 'maxLoss', 10);
    expect(years.map((row) => row.year)).toEqual(['2024', '2025', 'All years']);
    for (const row of years) expect(row.flaggedAbove + row.flaggedBelow).toBe(row.flagged);
    expect(years[2]).toMatchObject({ days: 3, flagged: 2, flaggedAbove: 1, restAbove: 1 });
  });

  it('counts strike touches only on chosen dates with a touch reading', () => {
    const slim = slimSet([
      day('2025-01-01', { maxLoss: 25, touched: 'Yes' }),
      day('2025-01-02', { maxLoss: 10, touched: 'No' }),
      day('2025-01-03', { maxLoss: 30 }),
      day('2025-01-04', { maxLoss: 40, touched: 'Yes' }),
    ]);
    expect(setLine(new Set(['2025-01-01', '2025-01-02', '2025-01-03']), slim).touchedShare).toBe(
      0.5,
    );
    expect(setLine(new Set(['2025-01-03']), slim).touchedShare).toBeNull();
  });
});
