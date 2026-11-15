import { describe, expect, test } from 'vitest';
import { COLUMN_BY_KEY, type DayRow } from './tradeExplorer';
import { bandCompare, bestSplit, rankSplits, splitChances } from './tradeExplorerSplits';

const day = (date: string, values: Record<string, number | string | null>) =>
  ({ raw: { date }, values: { date, ...values } }) as unknown as DayRow;

/** 40 days; the 20 with ivRatio >= 20 lose far more. gapPct alternates, so it separates nothing. */
const forty = Array.from({ length: 40 }, (_, i) =>
  day(`2026-01-${String(i + 1).padStart(2, '0')}`, {
    ivRatio: i,
    ivNow: i,
    gapPct: i % 2,
    dte: 1,
    maxLoss: i < 20 ? 100 + i : 1000 + i,
  }),
);

describe('bestSplit / rankSplits', () => {
  test('a perfectly separating column ranks first, big losses on the worse side', () => {
    const [top] = rankSplits(forty, 'maxLoss', ['gapPct', 'ivRatio']);
    expect(top.key).toBe('ivRatio');
    // Several cuts separate the loss levels equally well; any of them puts the big losses on the worse side.
    const med = (rs: DayRow[]) =>
      rs.map((r) => r.values.maxLoss as number).sort((a, b) => a - b)[rs.length >> 1];
    expect(med(top.worse)).toBeGreaterThanOrEqual(1000);
    expect(med(top.better)).toBeLessThan(200);
    expect(top.worse.every((r) => (r.values.ivRatio as number) >= 8)).toBe(true);
    expect(top.worseLabel).toMatch(/^IV ratio .* or more$/);
    expect(top.betterLabel).toMatch(/^IV ratio below /);
  });

  test('a side smaller than the minimum is never returned', () => {
    const rows = forty.map((r, i) => day(`d${i}`, { ...r.values, dte: i < 3 ? 0 : 1 }));
    expect(bestSplit(rows, 'dte', 'maxLoss')).toBeNull();
  });

  test('an exact copy is folded into same; a weak overlap stays listed', () => {
    const list = rankSplits(forty, 'maxLoss', ['ivRatio', 'ivNow', 'gapPct']);
    expect(list.map((s) => s.key)).toEqual(['ivRatio', 'gapPct']);
    expect(list[0].same).toEqual([(COLUMN_BY_KEY.get('ivNow') as { label: string }).label]);
  });
});

describe('splitChances', () => {
  test('a real separation is clear; a zero-score split is pure chance', () => {
    const keys = ['ivRatio', 'gapPct'];
    const splits = rankSplits(forty, 'maxLoss', keys);
    const flat = { ...(bestSplit(forty, 'gapPct', 'maxLoss') as object) } as (typeof splits)[0];
    flat.score = 0;
    const res = splitChances(forty, 'maxLoss', keys, [splits[0], flat]);
    expect(res.headline).toBeLessThan(0.05);
    expect(res.perSplit[0]).toBeLessThan(0.05);
    expect(res.perSplit[1]).toBe(1);
  });
});

describe('bandCompare', () => {
  test('a separating column is ordered above a constant one', () => {
    const { lines, groups } = bandCompare(forty, 'maxLoss', 3, ['dte', 'ivRatio', 'ivNow']);
    expect(groups.length).toBe(3);
    expect(lines[lines.length - 1].key).toBe('dte');
    expect(Math.abs(lines[0].gap)).toBeGreaterThan(Math.abs(lines[lines.length - 1].gap));
  });
});
