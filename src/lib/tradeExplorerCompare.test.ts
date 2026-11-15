import { describe, expect, test } from 'vitest';
import type { DayRow } from './tradeExplorer';
import {
  applyCriteria,
  crossTrait,
  crossWorst,
  ladder,
  setLine,
  slimSet,
} from './tradeExplorerCompare';
import { conditions, lossGroups, prepare, type Trait, type WorstLine } from './tradeExplorerTraits';

const day = (date: string, values: Record<string, number | string | null>) =>
  ({ raw: { date }, values: { date, ...values } }) as unknown as DayRow;
const date = (i: number) => `2026-01-01#${String(i).padStart(4, '0')}`;

describe('setLine', () => {
  test('counts only dates present, and measures worseShare against the set own usual', () => {
    const slim = slimSet(
      [10, 20, 30, 40].map((p, i) => day(`d${i}`, { maxLoss: p * 10, maxLossPct: p })),
    );
    const line = setLine(new Set(['d1', 'd2', 'zzz']), slim);
    expect(line.days).toBe(2);
    expect(line.medianLoss).toBe(250);
    expect(line.usualPct).toBe(25);
    expect(line.worseShare).toBe(0.5);
  });
});

/** 100 days; dte 0 on `k` of them, and those lose far more. */
const planted = (k: number) =>
  prepare(
    Array.from({ length: 100 }, (_, i) =>
      day(date(i), { maxLoss: i < k ? 1000 + i : i, dte: i < k ? 0 : 1 + (i % 3) }),
    ),
    'maxLoss',
  );

describe('crossWorst / crossTrait', () => {
  const asLine = (p: ReturnType<typeof planted>): WorstLine => ({
    cond: conditions(p, ['dte']).find((c) => c.spec.kind === 'eq' && c.spec.value === 0)!,
    days: 0,
    share: 0.9,
    lift: 0.4,
    median: 0,
    same: [],
    years: '',
    examples: [],
    worseWith: [],
  });
  const line = (p: ReturnType<typeof planted>) => p.y.slice().sort((a, b) => a - b)[50];

  test('Too few days under 15; Also holds for a planted condition', () => {
    const few = planted(10);
    expect(crossWorst(few, line(few), asLine(few), 0.5).word).toBe('Too few days');
    const many = planted(30);
    const r = crossWorst(many, line(many), asLine(many), 0.5);
    expect(r.days).toBe(30);
    expect(r.word).toBe('Also holds');
  });

  test('crossTrait is null for a missing group id', () => {
    const p = planted(30);
    const groups = lossGroups(p, line(p), String);
    const trait = { cond: asLine(p).cond, diff: 0.4 } as unknown as Trait;
    expect(crossTrait(p, groups, 'nope', trait)).toBeNull();
    expect(crossTrait(p, groups, 'allAbove', trait)?.word).toBe('Also holds');
  });
});

describe('applyCriteria', () => {
  test('no rows when the similar-days date is not in the list', () => {
    const rows = Array.from({ length: 10 }, (_, i) => day(date(i), { ivRatio: i, maxLoss: i }));
    const c = { name: 'x', filters: {}, similar: { date: 'missing', keys: ['ivRatio'], keep: 5 } };
    expect(applyCriteria(rows, c)).toEqual([]);
  });
});

describe('ladder', () => {
  test('band counts add up to days', () => {
    const rows = Array.from({ length: 10 }, (_, i) => day(date(i), { maxLoss: i + 1 }));
    const col = ladder(rows, 'maxLoss', 5, [3, 6, 9]);
    expect(col.bands).toEqual([3, 3, 3, 1]);
    expect(col.bands.reduce((a, b) => a + b, 0)).toBe(col.days);
    expect(col.aboveLine).toBe(0.5);
  });
});
