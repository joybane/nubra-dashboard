import { test, expect, vi } from 'vitest';
import { buildEquityCurve, computeMetrics, runMonteCarlo } from './analysis.ts';
import type { DayTrade } from './types.ts';

/** Minimal DayTrade factory — computeMetrics/buildEquityCurve read only pnl, cumPnl, costs, date. */
function ledger(pnls: number[], costs = 0): DayTrade[] {
  let cum = 0;
  return pnls.map((pnl, i) => {
    cum += pnl;
    return {
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      pnl,
      cumPnl: cum,
      costs,
    } as unknown as DayTrade;
  });
}

function seededSimulation(pnls: number[]) {
  let seed = 0x561b34cd;
  const random = vi.spyOn(Math, 'random').mockImplementation(() => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  });
  try {
    const result = runMonteCarlo(ledger(pnls), 5);
    expect(random).toHaveBeenCalledTimes(20);
    return result;
  } finally {
    random.mockRestore();
  }
}

test('runMonteCarlo preserves seeded equity curves and drawdown percentiles', () => {
  expect(seededSimulation([10.1, -30.2, 0, 5.74, 24.66])).toEqual({
    simulations: 5,
    percentiles: [5, 25, 50, 75, 95].map((pct) => ({
      pct,
      finalEquity: 10.3,
      maxDrawdown: 30.2,
    })),
    medianCurve: [5.74, -24.46, -20.1, 0.2, 10.3],
    p5Curve: [-30.2, -30.2, -24.46, -14.36, 10.3],
    p95Curve: [10.1, 15.84, 15.84, 40.5, 10.3],
  });
});

test('runMonteCarlo preserves comparator ordering for nonfinite paths', () => {
  const { p5Curve, p95Curve } = seededSimulation([5, -5, NaN, 10, -3]);
  expect(p5Curve).toEqual([10, NaN, NaN, NaN, NaN]);
  expect(p95Curve).toEqual([5, 15, 2, 7, NaN]);
});

test('computeMetrics: empty ledger returns a fully-zeroed metrics object', () => {
  const m = computeMetrics([]);
  expect(m.totalTrades).toBe(0);
  expect(m.totalPnl).toBe(0);
  expect(m.winRate).toBe(0);
  expect(m.profitFactor).toBe(0);
});

test('computeMetrics: win/loss counts, PnL, and profit factor', () => {
  const m = computeMetrics(ledger([100, -50, 200, -30], 10));
  expect(m.totalTrades).toBe(4);
  expect(m.wins).toBe(2);
  expect(m.losses).toBe(2);
  expect(m.winRate).toBe(50);
  expect(m.totalPnl).toBe(220);
  expect(m.avgWin).toBe(150);
  expect(m.avgLoss).toBe(-40);
  expect(m.maxWin).toBe(200);
  expect(m.maxLoss).toBe(-50);
  expect(m.profitFactor).toBe(3.75); // 300 / 80
  expect(m.totalCosts).toBe(40);
});

test('computeMetrics: max drawdown is measured from the running peak', () => {
  // cumPnl path: 100, 50, 250, 220 → deepest dd is 100→50 = 50 (50% of the 100 peak)
  const m = computeMetrics(ledger([100, -50, 200, -30]));
  expect(m.maxDrawdown).toBe(50);
  expect(m.maxDrawdownPct).toBe(50);
});

test('computeMetrics: win/loss streaks', () => {
  const m = computeMetrics(ledger([10, 10, 10, -5, -5]));
  expect(m.longestWinStreak).toBe(3);
  expect(m.longestLossStreak).toBe(2);
});

test('computeMetrics: all-winning ledger caps profit factor at 999 and zero drawdown', () => {
  const m = computeMetrics(ledger([10, 20, 30]));
  expect(m.profitFactor).toBe(999);
  expect(m.maxDrawdown).toBe(0);
  expect(m.winRate).toBe(100);
});

test('buildEquityCurve: drawdown is 0 at each new peak and negative while under water', () => {
  const curve = buildEquityCurve(ledger([100, -50, 200, -30]));
  expect(curve.map((p) => p.drawdown)).toEqual([0, -50, 0, -30]);
  expect(curve.map((p) => p.cumPnl)).toEqual([100, 50, 250, 220]);
});
