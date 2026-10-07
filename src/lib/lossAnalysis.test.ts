import { describe, expect, test } from 'vitest';
import type { SignalBacktestRow, StopPath } from './signalBacktest';
import { afterHit, levelMoves, lossGroup, lossGroups, type TreeNode } from './lossAnalysis';

const FROM = 31; // the series starts the minute after a 09:45 entry

/**
 * A day from its loss each minute (₹, one lot; negative = profit) and, optionally, how much worse
 * than the close each minute got. The stop path is built the way the server builds it: the minutes
 * whose depth went past every earlier one, starting from the previous minute's close.
 */
function day(
  closes: number[],
  worst: number[] = [],
  extra: Partial<{ date: string; dte: number }> = {},
): SignalBacktestRow {
  const steps: StopPath['steps'] = [];
  let deepest = 0;
  let prev = 0;
  closes.forEach((c, i) => {
    const depth = Math.max(c + (worst[i] ?? 0), prev);
    if (depth > deepest) {
      deepest = depth;
      steps.push([FROM + i, depth, prev]);
    }
    prev = c;
  });
  return {
    date: extra.date ?? '2026-05-04',
    dte: extra.dte ?? 1,
    trade: {
      pnl: -closes[closes.length - 1],
      stop: { trade: { premium: 10000, steps }, legs: [] },
      series: { from: FROM, close: closes, worst: closes.map((_, i) => worst[i] ?? 0) },
    },
  } as unknown as SignalBacktestRow;
}

describe('the exit table', () => {
  // Worst points 100, 200 … 1,000; closes 50, −100 (profit), …
  const rows = Array.from({ length: 10 }, (_, i) => {
    const worst = (i + 1) * 100;
    const close = i % 2 ? -100 : worst / 2;
    return day([worst, close]);
  });

  test('levels are the worst points that share of days reached, plus the average', () => {
    const g = lossGroup('all', 'All days', rows, 1);
    expect(g.medianMaxLoss).toBe(550);
    expect(g.meanMaxLoss).toBe(550);
    const levels = g.exits.map((e) => [e.kind, e.level]);
    // 90 % reached 200, 75 % 300, 50 % 600, 25 % 800, 10 % 1,000; 5 % repeats 1,000; mean 550.
    expect(levels).toEqual([
      ['hold', null],
      ['share', 200],
      ['share', 300],
      ['mean', 550],
      ['share', 600],
      ['share', 800],
      ['share', 1000],
    ]);
  });

  test('hold: red days, money lost, average, median and worst', () => {
    const hold = lossGroup('all', 'All days', rows, 1).exits[0];
    // Red days are the even ones, closing at half their worst: 50, 150, 250, 350, 450.
    expect(hold).toMatchObject({
      redDays: 5,
      redPct: 50,
      lost: 1250,
      avg: 250,
      median: 250,
      worst: 450,
    });
  });

  test('an exit turns every day that reached it into a loss at the level', () => {
    const at600 = lossGroup('all', 'All days', rows, 1).exits.find((e) => e.level === 600)!;
    // Days with worst ≥ 600 (5 of them) lose 600; the red days below it keep their close (50, 150, 250).
    expect(at600).toMatchObject({ redDays: 8, lost: 5 * 600 + 450, worst: 600, median: 600 });
  });

  test('₹ are per lot', () => {
    const two = rows.map((r) => {
      const t = r.trade;
      return {
        ...r,
        trade: {
          ...t,
          pnl: t.pnl * 2,
          stop: {
            ...t.stop!,
            trade: {
              ...t.stop!.trade,
              steps: t.stop!.trade.steps.map(([m, d, s]) => [m, d * 2, s * 2]),
            },
          },
        },
      } as unknown as SignalBacktestRow;
    });
    expect(lossGroup('all', 'All', two, 2).exits[0].lost).toBe(1250);
  });

  test('groups: all days, then each distance from expiry', () => {
    const mixed = [day([100, 50], [], { dte: 0 }), day([300, 100], [], { dte: 2 })];
    const groups = lossGroups(mixed, 1, (d) => (d === 0 ? 'Exp' : `Exp−${d}`));
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ['All days', 2],
      ['Exp', 1],
      ['Exp−2', 1],
    ]);
  });
});

describe('moves after the hit, in levels', () => {
  const pts = (vs: number[]) => vs.map((v, i) => ({ v, m: FROM + i }));
  // 0, then the table's levels: 420, 1,030 (hit), 1,600, 2,100, 2,600.
  const LEVELS = [0, 420, 1030, 1600, 2100, 2600];
  const HIT = 2;

  test('further to a level, back to the hit level, a new low, recovered to zero', () => {
    const moves = levelMoves(
      pts([1030, 1300, 1700, 1500, 1030, 1400, 2200, 1500, 900, 0]),
      LEVELS,
      HIT,
    );
    expect(moves.map((m) => [m.kind, m.level, m.ext])).toEqual([
      ['further', 1600, 1700],
      ['back', 1030, 1030],
      ['newLow', 2100, 2200],
      ['zero', 0, 0],
    ]);
  });

  test('wiggles inside a band are not moves; a move must reach the next level', () => {
    // 1,030 → 1,500 → 1,100 → 1,550: never reaches 1,600 or 420.
    expect(levelMoves(pts([1030, 1500, 1100, 1550, 1200]), LEVELS, HIT)).toEqual([]);
  });

  test('a turn needs the loss to come back a whole level from the furthest one reached', () => {
    // Reached 1,600; back to 1,200 is not yet back at 1,030, so the fall to 2,150 is the same move.
    const moves = levelMoves(pts([1030, 1650, 1200, 2150, 2000]), LEVELS, HIT);
    expect(moves.map((m) => [m.kind, m.level, m.ext])).toEqual([['further', 2100, 2150]]);
  });

  test('back past the hit level, then a fall that does not pass the low', () => {
    const moves = levelMoves(pts([1030, 2150, 400, 1700, 1650]), LEVELS, HIT);
    expect(moves.map((m) => [m.kind, m.level])).toEqual([
      ['further', 2100],
      ['back', 420],
      ['fellBack', 1600],
    ]);
  });

  test('after zero, a fall back into loss', () => {
    const moves = levelMoves(pts([1030, 400, 0, 500, 1100]), LEVELS, HIT);
    expect(moves.map((m) => [m.kind, m.level])).toEqual([
      ['zero', 0],
      ['reloss', 1030],
    ]);
  });

  test('a jump past several levels in one go lands on the furthest', () => {
    const moves = levelMoves(pts([1030, 2700]), LEVELS, HIT);
    expect(moves.map((m) => [m.kind, m.level])).toEqual([['further', 2600]]);
  });
});

describe('afterHit', () => {
  const find = (node: TreeNode, kind: string, level?: number) =>
    node.children.find((c) => c.kind === kind && (level == null || c.level === level))!;
  const LEVELS = [420, 1030, 1600, 2100];

  test('a tree of what the days that hit the level did next, in levels, with medians, means and counts', () => {
    const rows = [
      day([500, 1030, 1700, 1000, 2200, 0], [], { date: 'a' }),
      day([1030, 1800, 1020, 2300, 2300], [], { date: 'b' }),
      day([1030, 1200, 1200], [], { date: 'c' }),
      day([400, 600, 800], [], { date: 'never hit' }),
    ];
    const t = afterHit(rows, 1030, 1, LEVELS)!;
    expect(t.days).toBe(3);
    expect(t.levels).toEqual([0, 420, 1030, 1600, 2100]);
    expect(t.root.dates).toEqual(['a', 'b', 'c']);
    const further = find(t.root, 'further', 1600);
    expect(further).toMatchObject({ days: 2, dates: ['a', 'b'] });
    expect(further.ext).toEqual({ median: 1750, mean: 1750 });
    const back = find(further, 'back', 1030);
    expect(back.days).toBe(2);
    const newLow = find(back, 'newLow', 2100);
    expect(newLow.days).toBe(2);
    expect(newLow.ext).toEqual({ median: 2250, mean: 2250 });
    // a recovered to zero; b held to the close at its low.
    expect(find(newLow, 'zero').dates).toEqual(['a']);
    expect(find(newLow, 'close')).toMatchObject({
      dates: ['b'],
      close: { median: 2300, mean: 2300 },
    });
    // c never reached another level: held to the close.
    expect(find(t.root, 'close')).toMatchObject({
      dates: ['c'],
      close: { median: 1200, mean: 1200 },
    });
  });

  test('the rest of the day, whatever the moves', () => {
    const rows = [
      day([1030, 1600, 0, 300], [], { date: 'a' }),
      day([1030, 1200, 1100], [], { date: 'b' }),
    ];
    const t = afterHit(rows, 1030, 1, LEVELS)!;
    expect(t.summary).toEqual({
      deepest: { median: 1400, mean: 1400 },
      backToZero: 1,
      close: { median: 700, mean: 700 },
    });
  });

  test('no day reached the level, or the level is not one of the levels', () => {
    expect(afterHit([day([100, 200])], 1030, 1, LEVELS)).toBeNull();
    expect(afterHit([day([1030, 1200])], 999, 1, LEVELS)).toBeNull();
  });
});
