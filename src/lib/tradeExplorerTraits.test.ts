import { describe, expect, test } from 'vitest';
import type { DayRow } from './tradeExplorer';
import {
  conditions,
  groupTraits,
  lossGroups,
  prepare,
  traceBack,
  worstCriteria,
} from './tradeExplorerTraits';

const day = (date: string, values: Record<string, number | string | null>) =>
  ({ raw: { date }, values: { date, ...values } }) as unknown as DayRow;
const date = (i: number) => `2026-01-01#${String(i).padStart(4, '0')}`;
const fmt = (v: number) => String(Math.round(v));

describe('lossGroups', () => {
  test('200 days: all-above, two bands, rare, below', () => {
    const rows = Array.from({ length: 200 }, (_, i) => day(date(i), { maxLoss: i + 1 }));
    const p = prepare(rows, 'maxLoss');
    const g = lossGroups(p, 100, fmt);
    expect(g.map((x) => x.id)).toEqual(['allAbove', 'high1', 'high2', 'rare', 'below']);
    expect(g[0].idx.length).toBe(100);
    expect(g[3].idx.length).toBe(10);
    expect(g[4].idx.length).toBe(100);
  });

  test('50 days: only all-above and below', () => {
    const rows = Array.from({ length: 50 }, (_, i) => day(date(i), { maxLoss: i + 1 }));
    const p = prepare(rows, 'maxLoss');
    expect(lossGroups(p, 25, fmt).map((x) => x.id)).toEqual(['allAbove', 'below']);
  });
});

/** 40 days: the first 10 are the group (loss 1000+), the other 30 lose little. */
const forty = (touched: (i: number) => string) =>
  Array.from({ length: 40 }, (_, i) =>
    day(date(i), {
      maxLoss: i < 10 ? 1000 + i : 100 + i,
      touched: touched(i),
      dte: touched(i) === 'Yes' ? 1 : 0,
    }),
  );

describe('groupTraits', () => {
  const p = prepare(
    forty((i) => (i < 9 || i === 20 ? 'Yes' : 'No')),
    'maxLoss',
  );
  const group = lossGroups(p, 500, fmt)[0];

  test('a flag on 9 of 10 here and 1 of 30 elsewhere comes first and is unique', () => {
    expect(group.idx.length).toBe(10);
    const [t] = groupTraits(p, group, conditions(p, ['touched']));
    expect(t.cond.label).toBe('Touched: Yes');
    expect(t.kind).toBe('unique');
    expect(t.inGroup).toBe(9);
    expect(t.elsewhere).toBe(1);
  });

  test('a second column that copies the first is folded into "same"', () => {
    const traits = groupTraits(p, group, conditions(p, ['touched', 'dte']));
    expect(traits).toHaveLength(1);
    expect(traits[0].cond.key).toBe('touched');
    expect(traits[0].same).toEqual(['Day']);
  });
});

describe('traceBack', () => {
  test('null when no entry condition moves the rate by 0.25; lean-but-strong at 80% vs 45%', () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      day(date(i), {
        maxLoss: i,
        touched: i % 2 ? 'Yes' : 'No',
        dte: Math.floor(i / 2) % 2,
      }),
    );
    const p = prepare(rows, 'maxLoss');
    const day1 = conditions(p, ['touched']).find((c) => c.label === 'Touched: Yes')!;
    expect(traceBack(p, day1, conditions(p, ['dte']))).toBeNull();

    // 20 group days (loss 1000+) and 20 others; the flag is on 16 of 20 here and 9 of 20 elsewhere.
    const rows2 = Array.from({ length: 40 }, (_, i) => {
      const inGroup = i < 20;
      const on = inGroup ? i < 16 : i < 29;
      return day(date(i), { maxLoss: inGroup ? 1000 + i : i, touched: on ? 'Yes' : 'No' });
    });
    const p2 = prepare(rows2, 'maxLoss');
    const g = lossGroups(p2, 500, fmt)[0];
    const [t] = groupTraits(p2, g, conditions(p2, ['touched']));
    expect(t.kind).toBe('lean');
    expect(t.strong).toBe(true);
  });
});

describe('worstCriteria', () => {
  test('null under 60 rows; ranks a planted condition first on 120 rows', () => {
    const small = prepare(
      Array.from({ length: 50 }, (_, i) => day(date(i), { maxLoss: i, dte: i % 4 })),
      'maxLoss',
    );
    expect(worstCriteria(small, 25, conditions(small, ['dte']))).toBeNull();

    const rows = Array.from({ length: 120 }, (_, i) =>
      day(date(i), {
        maxLoss: i % 4 === 0 ? 1000 + i : i,
        dte: i % 4,
        ivRatio: (i * 7) % 11,
      }),
    );
    const p = prepare(rows, 'maxLoss');
    const line = p.y.slice().sort((a, b) => a - b)[60];
    const w = worstCriteria(p, line, conditions(p, ['dte', 'ivRatio']))!;
    expect(w.lines[0].cond.label).toBe('Day: Exp');
  });
});
