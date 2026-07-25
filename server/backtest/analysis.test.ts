import { test, expect } from 'vitest';
import { buildEquityCurve, computeMetrics } from './analysis.ts';
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
