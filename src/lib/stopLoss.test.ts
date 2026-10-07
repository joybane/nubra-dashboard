import { describe, expect, test } from 'vitest';
import type { SignalBacktestRow, StopPath } from './signalBacktest';
import {
  applyStop,
  bestStop,
  dataLevels,
  dipIn,
  dipSummary,
  dipsByOutcome,
  hasStopPaths,
  reachedBy,
  stopHit,
  stopStats,
} from './stopLoss';

const path = (premium: number, steps: StopPath['steps']): StopPath => ({ premium, steps });

/**
 * A two-leg trade: each leg's final P&L and stop path, and the combined path. Only the fields the
 * stop-loss code reads are real.
 */
function rowOf(
  legs: Array<{ pnl: number; path: StopPath }>,
  trade: StopPath,
  dte: number | null = 1,
): SignalBacktestRow {
  return {
    date: '2026-05-04',
    dte,
    trade: {
      pnl: legs.reduce((s, l) => s + l.pnl, 0),
      legs: legs.map((l) => ({ pnl: l.pnl })),
      stop: { trade, legs: legs.map((l) => l.path) },
    },
  } as unknown as SignalBacktestRow;
}

// Premium ₹1,000 on the trade (₹500 a leg).
// Winner: dipped ₹100 then ₹250, closed +₹400.
const winner = rowOf(
  [
    { pnl: 300, path: path(500, [[40, 120, 0]]) },
    { pnl: 100, path: path(500, [[50, 200, 60]]) },
  ],
  path(1000, [
    [40, 100, 0],
    [50, 250, 80],
  ]),
);
// Loser: dipped ₹300, then jumped from ₹350 to ₹700 at the open of minute 90; closed −₹600.
const loser = rowOf(
  [
    { pnl: -800, path: path(500, [[90, 900, 500]]) },
    { pnl: 200, path: path(500, []) },
  ],
  path(1000, [
    [60, 300, 0],
    [90, 700, 350],
  ]),
);

describe('stopHit', () => {
  test('fires on the first step deep enough, and fills at the stop', () => {
    expect(stopHit(winner.trade.stop!.trade, 200)).toEqual({ slot: 50, loss: 200 });
  });
  test('a minute that began past the stop fills where it began', () => {
    expect(stopHit(loser.trade.stop!.trade, 320)).toEqual({ slot: 90, loss: 350 });
  });
  test('never reached, or no stop', () => {
    expect(stopHit(winner.trade.stop!.trade, 251)).toBeNull();
    expect(stopHit(winner.trade.stop!.trade, 0)).toBeNull();
  });
});

describe('applyStop', () => {
  test('whole trade: a stopped trade loses the fill, an unstopped one keeps its P&L', () => {
    const rule = { scope: 'trade', unit: 'pct', value: 20 } as const; // ₹200 of ₹1,000
    expect(applyStop(winner.trade, rule, 1)).toEqual({ pnl: -200, stopped: 1, slot: 50 });
    expect(applyStop(loser.trade, { ...rule, value: 80 }, 1)).toEqual({
      pnl: -600,
      stopped: 0,
      slot: null,
    });
  });
  test('per leg: only the stopped leg is squared off', () => {
    // 30 % of a ₹500 leg = ₹150: the loser's PE never dips, its CE jumps from 500 to 900.
    const r = applyStop(loser.trade, { scope: 'leg', unit: 'pct', value: 30 }, 1);
    expect(r).toEqual({ pnl: -500 + 200, stopped: 1, slot: 90 });
  });
  test('₹ stops are per lot', () => {
    const r = applyStop(winner.trade, { scope: 'trade', unit: 'rs', value: 100 }, 2);
    expect(r.slot).toBe(50); // ₹200 for 2 lots; the ₹100 dip at 40 is not deep enough
  });
});

describe('stopStats', () => {
  test('hit rates, winners stopped, losers stopped and the P&L difference', () => {
    const s = stopStats([winner, loser], { scope: 'trade', unit: 'pct', value: 20 }, 1);
    expect(s).toMatchObject({
      trades: 2,
      hitPct: 100,
      legsHitPct: null,
      winnersStoppedPct: 100,
      losersStoppedPct: 100,
      pnl: -400, // −200 − 200
      basePnl: -200, // +400 − 600
      delta: -200,
      avgStopLoss: -200,
    });
  });
  test('per leg counts days with any leg stopped, and legs', () => {
    const s = stopStats([winner, loser], { scope: 'leg', unit: 'pct', value: 30 }, 1);
    // ₹150 a leg: winner's PE (₹200) and loser's CE (₹900) are stopped.
    expect(s).toMatchObject({ hitPct: 100, legsHitPct: 50, winnersStoppedPct: (1 / 3) * 100 });
    expect(s.losersStoppedPct).toBe(100);
    expect(s.pnl).toBe(300 - 150 + (-500 + 200));
  });
});

describe('levels from the data', () => {
  test('reachedBy: a stop no larger than it fires on at least that share', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(reachedBy(v, 0.9)).toBe(2);
    expect(reachedBy(v, 0.5)).toBe(6);
    expect(v.filter((x) => x >= reachedBy(v, 0.9)).length).toBeGreaterThanOrEqual(9);
    expect(reachedBy([], 0.5)).toBe(0);
  });
  test('dataLevels are the dips themselves, without repeats', () => {
    const levels = dataLevels([winner, loser], 'trade', 'pct', 1);
    expect(levels.map((l) => l.stats.level)).toEqual([25, 70]);
    expect(levels[0].stats.hitPct).toBe(100);
  });
  test('dips in % of premium or ₹ per lot', () => {
    expect(dipIn(loser.trade.stop!.trade, 'pct', 1)).toBe(70);
    expect(dipIn(loser.trade.stop!.trade, 'rs', 2)).toBe(350);
    expect(dipIn(path(500, []), 'pct', 1)).toBe(0);
  });
  test('dip summaries split by how the trade closed', () => {
    const { winners, losers } = dipsByOutcome([winner, loser], 'leg', 'pct', 1);
    expect(winners).toEqual([24, 40, 0]);
    expect(losers).toEqual([180]);
    expect(dipSummary(winners)).toMatchObject({ n: 3, median: 24, max: 40 });
    expect(dipSummary(winners)!.neverRedPct).toBeCloseTo(33.33, 1);
    expect(dipSummary([])).toBeNull();
  });
  test('rows from an older server have no paths', () => {
    expect(hasStopPaths([winner])).toBe(true);
    const old = { ...winner, trade: { ...winner.trade, stop: undefined } };
    expect(hasStopPaths([old])).toBe(false);
  });
});

describe('bestStop', () => {
  test('searches the dips that happened and returns the stop that added the most', () => {
    // Only dips that happened are tried: 25 % (stops both: −650 + 350) and 70 % (the loser fills
    // at ₹700 instead of closing at −₹600). Neither helps; the least bad comes back, below zero.
    const best = bestStop([winner, loser], 'trade', 'pct', 1);
    expect(best).toMatchObject({ level: 70, delta: -100 });
  });
  test('nothing to search', () => {
    expect(bestStop([], 'trade', 'pct', 1)).toBeNull();
  });
});
