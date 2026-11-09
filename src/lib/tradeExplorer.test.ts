import { describe, expect, test } from 'vitest';
import {
  COLUMN_BY_KEY,
  aggregate,
  allGroupIds,
  applyFilters,
  bucketRows,
  buildItems,
  categoryValues,
  formatCell,
  lossSummary,
  parseBound,
  sortRows,
  type Column,
  type DayRow,
  type GroupPlan,
} from './tradeExplorer';

const col = (k: string) => COLUMN_BY_KEY.get(k) as Column;
const day = (date: string, values: Record<string, number | string | null>) =>
  ({ raw: { date }, values: { date, ...values } }) as unknown as DayRow;

const rows = [
  day('2026-01-01', { maxLoss: 100, dte: 0, ivLevel: 'High', t2: 600, red: 'No', gapPct: 60 }),
  day('2026-01-02', {
    maxLoss: 400,
    dte: 1,
    ivLevel: 'Very high',
    t2: 630,
    red: 'Yes',
    gapPct: 80,
  }),
  day('2026-01-03', { maxLoss: 200, dte: 0, ivLevel: null, t2: 615, red: 'Yes', gapPct: null }),
  day('2026-01-04', {
    maxLoss: 300,
    dte: 0,
    ivLevel: 'Very high',
    t2: 645,
    red: 'No',
    gapPct: 120,
  }),
];
const plan = (patch: Partial<GroupPlan>): GroupPlan => ({
  first: null,
  second: null,
  bands: 2,
  sortGroups: false,
  how: 'median',
  ...patch,
});
const dates = (list: DayRow[]) => list.map((r) => r.raw.date.slice(-2));

describe('filters', () => {
  test('number ranges include both ends and drop blanks', () => {
    expect(dates(applyFilters(rows, { gapPct: { min: '80', max: '120' } }))).toEqual(['02', '04']);
  });
  test('typed rupees with commas and clock times are understood', () => {
    expect(parseBound(col('maxLoss'), '₹1,500')).toBe(1500);
    expect(parseBound(col('t2'), '10:15')).toBe(615);
    expect(dates(applyFilters(rows, { t2: { min: '10:15', max: '10:30' } }))).toEqual(['02', '03']);
  });
  test('an unreadable bound is ignored rather than hiding everything', () => {
    expect(applyFilters(rows, { maxLoss: { min: 'abc' } })).toHaveLength(4);
  });
  test('categories can keep the blank value, and none means no rows', () => {
    expect(dates(applyFilters(rows, { ivLevel: { values: [null] } }))).toEqual(['03']);
    expect(applyFilters(rows, { ivLevel: { values: [] } })).toHaveLength(0);
  });
  test('filters combine', () => {
    const f = { dte: { values: [0] }, ivLevel: { values: ['Very high'] } };
    expect(dates(applyFilters(rows, f))).toEqual(['04']);
  });
});

describe('sorting', () => {
  test('both directions, with blanks always last', () => {
    expect(dates(sortRows(rows, { key: 'gapPct', dir: -1 }))).toEqual(['04', '02', '01', '03']);
    expect(dates(sortRows(rows, { key: 'gapPct', dir: 1 }))).toEqual(['01', '02', '04', '03']);
  });
  test('categories follow their natural order, not the alphabet', () => {
    expect(dates(sortRows(rows, { key: 'ivLevel', dir: 1 })).slice(0, 2)).toEqual(['01', '04']);
  });
});

describe('grouping', () => {
  test('category groups come in natural order with blanks last', () => {
    expect(categoryValues(col('ivLevel'), rows)).toEqual(['High', 'Very high', null]);
    expect(bucketRows(rows, col('ivLevel'), 5).map((b) => b.label)).toEqual([
      'High',
      'Very high',
      'No reading',
    ]);
  });
  test('number bands hold every row exactly once', () => {
    const b = bucketRows(rows, col('maxLoss'), 2);
    expect(b.map((x) => x.rows.length)).toEqual([2, 2]);
  });
  test('blanks get their own band', () => {
    const b = bucketRows(rows, col('gapPct'), 3);
    expect(b.at(-1)?.label).toBe('No reading');
    expect(b.reduce((n, x) => n + x.rows.length, 0)).toBe(4);
  });
  test('groups start closed and open to their days, sorted', () => {
    const p = plan({ first: 'dte' });
    const closed = buildItems(rows, { key: 'maxLoss', dir: -1 }, p, new Set());
    expect(closed.map((i) => i.kind)).toEqual(['group', 'group']);
    const opened = buildItems(rows, { key: 'maxLoss', dir: -1 }, p, new Set(['0']));
    expect(opened.map((i) => (i.kind === 'day' ? i.row.raw.date.slice(-2) : 'g'))).toEqual([
      'g',
      '04',
      '03',
      '01',
      'g',
    ]);
  });
  test('two levels nest under their parent', () => {
    const p = plan({ first: 'dte', second: 'ivLevel' });
    const items = buildItems(rows, { key: 'maxLoss', dir: -1 }, p, new Set(['0']));
    expect(items.map((i) => (i.kind === 'group' ? `${i.depth}:${i.label}` : 'd'))).toEqual([
      '0:Exp',
      '1:High',
      '1:Very high',
      '1:No reading',
      '0:Exp−1',
    ]);
    expect(allGroupIds(rows, p)).toContain('0/Very high');
  });
  test('groups can follow the sorted column', () => {
    const p = plan({ first: 'dte', sortGroups: true });
    const items = buildItems(rows, { key: 'maxLoss', dir: -1 }, p, new Set());
    expect(items.map((i) => (i.kind === 'group' ? i.label : ''))).toEqual(['Exp−1', 'Exp']);
  });
});

describe('figures', () => {
  test('median, average, highest and lowest skip blanks', () => {
    expect(aggregate(rows, 'gapPct', 'median')).toBe(80);
    expect(aggregate(rows, 'gapPct', 'mean')).toBeCloseTo(86.67, 2);
    expect(aggregate(rows, 'gapPct', 'max')).toBe(120);
    expect(aggregate(rows, 'gapPct', 'min')).toBe(60);
  });
  test('the loss summary', () => {
    expect(lossSummary(rows)).toMatchObject({ days: 4, median: 250, worst: 400, closedRed: 0.5 });
    expect(lossSummary([])).toMatchObject({ days: 0, median: null, closedRed: null });
  });
  test('cells format with units and signs', () => {
    expect(formatCell(col('pnl'), -1234.4)).toBe('−₹1,234');
    expect(formatCell(col('pnl'), 50)).toBe('+₹50');
    expect(formatCell(col('t2'), 645)).toBe('10:45');
    expect(formatCell(col('dte'), 0)).toBe('Exp');
    expect(formatCell(col('ivNow'), null)).toBe('–');
  });
});
