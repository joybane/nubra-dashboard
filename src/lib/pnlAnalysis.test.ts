import { describe, expect, test } from 'vitest';
import type { SignalBacktestRow, StopPath } from './signalBacktest';
import {
  bestPlan,
  boundaries,
  drivers,
  excursions,
  extremeHours,
  hasPnlPaths,
  levelRows,
  pathGroups,
  planStats,
  runPlan,
  slices,
  standouts,
} from './pnlAnalysis';

type Steps = StopPath['steps'];

/** A trade with capital ₹1,000 (one lot): its final P&L, profit path and loss path. */
function rowOf(
  pnl: number,
  target: Steps,
  stop: Steps,
  extra: Partial<{
    date: string;
    dte: number;
    entryTime: string;
    exitSpot: number;
    gap: number;
  }> = {},
): SignalBacktestRow {
  return {
    date: extra.date ?? '2026-05-04',
    dte: extra.dte ?? 1,
    signal: { gap: extra.gap ?? 100 },
    trade: {
      pnl,
      entryTime: extra.entryTime ?? '10:05',
      entrySpot: 25000,
      exitSpot: extra.exitSpot ?? 25000,
      spotHigh: 25100,
      spotLow: 24900,
      target: { premium: 1000, steps: target },
      stop: { trade: { premium: 1000, steps: stop }, legs: [] },
    },
  } as unknown as SignalBacktestRow;
}

// Up to ₹300 at minute 30, dipped ₹100 at 60, closed +₹200.
const winner = rowOf(200, [[30, 300, 0]], [[60, 100, 0]]);
// Up ₹150 at 20, then down: ₹200 at 50, jumped from ₹300 to ₹600 at 70; closed −₹500.
const loser = rowOf(
  -500,
  [[20, 150, 0]],
  [
    [50, 200, 0],
    [70, 600, 300],
  ],
);
// Target and stop crossed in the same minute 40.
const whipsaw = rowOf(-50, [[40, 250, 0]], [[40, 250, 0]]);

describe('runPlan', () => {
  test('target first: fills at the target', () => {
    expect(runPlan(winner, { unit: 'pct', target: 25, sl: 50 }, 1)).toEqual({
      outcome: 'target',
      pnl: 250,
      slot: 30,
    });
  });
  test('stop first, and a jump through the stop fills where the minute began', () => {
    expect(runPlan(loser, { unit: 'pct', target: 20, sl: 25 }, 1)).toEqual({
      outcome: 'sl',
      pnl: -300,
      slot: 70,
    });
  });
  test('the target fires before a later stop', () => {
    expect(runPlan(loser, { unit: 'pct', target: 15, sl: 20 }, 1).outcome).toBe('target');
  });
  test('both in one minute counts as the stop', () => {
    expect(runPlan(whipsaw, { unit: 'pct', target: 20, sl: 20 }, 1)).toEqual({
      outcome: 'both',
      pnl: -200,
      slot: 40,
    });
  });
  test('neither: held to the exit; ₹ sizes are per lot', () => {
    expect(runPlan(winner, { unit: 'rs', target: 200, sl: 0 }, 2)).toEqual({
      outcome: 'none',
      pnl: 200,
      slot: null,
    });
  });
});

describe('planStats', () => {
  test('shares of each outcome and the P&L against holding', () => {
    const s = planStats([winner, loser, whipsaw], { unit: 'pct', target: 20, sl: 20 }, 1);
    expect(s).toMatchObject({ trades: 3, pnl: 200 - 200 - 200, basePnl: -350, delta: 150 });
    expect(s.targetPct).toBeCloseTo(33.33, 1);
    expect(s.slPct).toBeCloseTo(33.33, 1);
    expect(s.bothPct).toBeCloseTo(33.33, 1);
    expect(s.nonePct).toBe(0);
  });
});

describe('levels and boundaries', () => {
  test('peaks and dips in % of capital', () => {
    expect(excursions([winner, loser], 'peak', 'pct', 1)).toEqual([30, 15]);
    expect(excursions([winner, loser], 'dip', 'rs', 1)).toEqual([100, 600]);
  });
  test('boundaries: never hit beyond the furthest any day went', () => {
    const b = boundaries([0, 10, 20, 30, 40, 50, 60, 70, 80, 90])!;
    expect(b).toMatchObject({ by90: 10, by50: 50, by10: 90, max: 90, zeroPct: 10 });
    expect(boundaries([])).toBeNull();
  });
  test('target rows say how often the target helped', () => {
    const rows = levelRows([winner, loser], 'target', 'pct', 1);
    expect(rows.map((r) => r.level)).toEqual([15, 30]);
    // 15 %: both hit it. The winner would have closed at +200 (higher: did not help), the loser at −500 (helped).
    expect(rows[0]).toMatchObject({ helpedPct: 50 });
    expect(rows[0].stats.targetPct).toBe(100);
  });
  test('stop rows have no helped column', () => {
    expect(levelRows([winner, loser], 'sl', 'pct', 1)[0].helpedPct).toBeNull();
  });
  test('bestPlan searches targets and stops together', () => {
    const best = bestPlan([winner, loser], 'pct', 1)!;
    // Target 15 % banks +150 on both days: +300, against −300 holding.
    expect(best.pnl).toBe(300);
    expect(best.plan.target).toBe(15);
  });
});

describe('spread and paths', () => {
  test('ten slices, worst first', () => {
    const rows = Array.from({ length: 20 }, (_, i) => rowOf(i * 100 - 1000, [], []));
    const s = slices(rows, 'rs', 1);
    expect(s).toHaveLength(10);
    expect(s[0]).toMatchObject({ n: 1, trades: 2, lo: -1000, hi: -900, total: -1900 });
    expect(s[9]).toMatchObject({ n: 10, lo: 800, hi: 900 });
  });
  test('four paths by the scare and in-profit thresholds', () => {
    const g = pathGroups([winner, loser, whipsaw], 'pct', 1, 10, 20);
    const by = Object.fromEntries(g.map((x) => [x.kind, x.trades]));
    // winner dipped 10 % (a scare); loser peaked 15 % (< 20: never really in profit); whipsaw peaked 25 %.
    expect(by).toEqual({ 'clean-win': 0, 'scare-win': 1, 'reversal-loss': 1, 'straight-loss': 1 });
  });
  test('the hours the best and worst points fell in', () => {
    // Slot 30 = 09:45, 60 = 10:15.
    expect(extremeHours([winner])).toEqual([
      { hour: '09:00', peakPct: 100, dipPct: 0 },
      { hour: '10:00', peakPct: 0, dipPct: 100 },
    ]);
  });
});

describe('drivers', () => {
  test('big losses and wins counted per bucket, with lift against the share of days', () => {
    const rows = [
      ...Array.from({ length: 18 }, (_, i) =>
        rowOf(100 + i, [], [], { dte: 2, date: '2026-05-05' }),
      ),
      rowOf(-900, [], [], { dte: 0, date: '2026-05-04' }),
      rowOf(-800, [], [], { dte: 0, date: '2026-05-04' }),
    ];
    const { drivers: list, bigLossAt } = drivers(rows, 'rs', 1, (d) =>
      d === 0 ? 'Exp' : `Exp−${d}`,
    );
    expect(bigLossAt).toBe(-800);
    const dte = list.find((d) => d.name === 'Days to expiry')!;
    expect(dte.buckets.map((b) => b.label)).toEqual(['Exp', 'Exp−2']);
    expect(dte.buckets[0]).toMatchObject({ trades: 2, bigLossShare: 100, winPct: 0 });
    expect(dte.buckets[0].lossLift).toBe(10);
    expect(standouts(list, 'loss', 2).map((s) => s.bucket.label)).toContain('Exp');
  });
});

test('rows from an older server have no target paths', () => {
  expect(hasPnlPaths([winner])).toBe(true);
  expect(hasPnlPaths([{ ...winner, trade: { ...winner.trade, target: undefined } }])).toBe(false);
});
