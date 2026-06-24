// Client-side mirror of server/backtest/analysis.ts — lets the Results panel
// recompute metrics, equity curve and the monthly/weekday tables from a filtered
// subset of trades (weekday / days-to-expiry filters) without a server round-trip.
import type {
  DayTrade, EquityPoint, Metrics, MonthlyBucket, WeekdayBucket, WeekdayCode,
} from './types';

const WD: WeekdayCode[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const TRADING_DAYS_YEAR = 252;

function round2(n: number): number { return Math.round(n * 100) / 100; }
function safeDiv(a: number, b: number): number { return b === 0 ? 0 : a / b; }

/** Weekday code (MON–FRI) for a yyyy-mm-dd trade date. */
export function tradeWeekday(date: string): WeekdayCode | null {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6 ? null : WD[dow - 1];
}

/** Calendar days-to-expiry for a trade, from the first leg's expiry. */
export function tradeDte(t: DayTrade): number | null {
  const exp = t.legs[0]?.expiry;
  if (!exp) return null;
  const a = Date.parse(`${t.date}T00:00:00Z`);
  const b = Date.parse(`${expIso(exp)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Expiry may arrive as "2025-05-08" or "20250508"; normalise to ISO.
function expIso(exp: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) return exp;
  if (/^\d{8}$/.test(exp)) return `${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}`;
  return exp;
}

/** Recompute cumPnl + drawdown for a (possibly filtered) ordered trade list. */
export function buildEquityCurve(trades: DayTrade[]): EquityPoint[] {
  let cum = 0, peak = 0;
  return trades.map((t) => {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    return { date: t.date, cumPnl: round2(cum), drawdown: round2(cum - peak) };
  });
}

/** Trades with cumPnl re-derived in order (filtering breaks the original running total). */
export function withRecumulated(trades: DayTrade[]): DayTrade[] {
  let cum = 0;
  return trades.map((t) => { cum += t.pnl; return { ...t, cumPnl: round2(cum) }; });
}

export function computeMetrics(trades: DayTrade[]): Metrics {
  const empty: Metrics = {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0,
    avgWin: 0, avgLoss: 0, maxWin: 0, maxLoss: 0, profitFactor: 0, expectancy: 0,
    maxDrawdown: 0, maxDrawdownPct: 0, sharpe: 0, sortino: 0, calmar: 0,
    longestWinStreak: 0, longestLossStreak: 0, totalCosts: 0,
    recoveryFactor: 0, sqn: 0, payoffRatio: 0, cagrPct: 0, tail: 0,
    expectancyRatio: 0, maxDdDays: 0, maxDdFrom: '', maxDdTo: '', maxTradesInDrawdown: 0,
  };
  if (!trades.length) return empty;

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const totalCosts = trades.reduce((a, t) => a + t.costs, 0);

  // drawdown over the recumulated curve (+ duration & deepest-stretch indices)
  let cum = 0, peak = 0, peakIdx = -1, maxDd = 0, maxDdPct = 0, ddPeakIdx = -1, ddTroughIdx = -1;
  let runMin = Infinity, maxTradesInDd = 0; // peak→trough trade span of any drawdown
  for (let i = 0; i < pnls.length; i++) {
    cum += pnls[i];
    if (cum >= peak) { peak = cum; peakIdx = i; runMin = cum; }
    else if (cum < runMin) { runMin = cum; if (i - peakIdx > maxTradesInDd) maxTradesInDd = i - peakIdx; }
    const dd = peak - cum;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; ddPeakIdx = peakIdx; ddTroughIdx = i; }
  }
  const maxDdFrom = ddPeakIdx >= 0 ? trades[Math.min(ddPeakIdx + 1, trades.length - 1)].date : '';
  const maxDdTo   = ddTroughIdx >= 0 ? trades[ddTroughIdx].date : '';
  const maxDdDays = maxDdFrom && maxDdTo
    ? Math.round((Date.parse(`${maxDdTo}T00:00:00Z`) - Date.parse(`${maxDdFrom}T00:00:00Z`)) / 86400000) + 1
    : 0;

  let lw = 0, ll = 0, curW = 0, curL = 0;
  for (const p of pnls) {
    if (p > 0) { curW++; curL = 0; lw = Math.max(lw, curW); }
    else if (p < 0) { curL++; curW = 0; ll = Math.max(ll, curL); }
    else { curW = 0; curL = 0; }
  }

  const mean = totalPnl / pnls.length;
  const variance = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const downside = Math.sqrt(safeDiv(pnls.filter((p) => p < 0).reduce((a, p) => a + p * p, 0), pnls.length));
  const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(TRADING_DAYS_YEAR);
  const sortino = downside === 0 ? 0 : (mean / downside) * Math.sqrt(TRADING_DAYS_YEAR);
  const annualPnl = mean * TRADING_DAYS_YEAR;
  const calmar = maxDd === 0 ? 0 : annualPnl / maxDd;
  const recoveryFactor = maxDd === 0 ? 0 : totalPnl / maxDd;
  const sqn = std === 0 ? 0 : (Math.sqrt(pnls.length) * mean) / std;
  const avgLossAbs = grossLoss === 0 ? 0 : grossLoss / losses.length;
  const payoffRatio = avgLossAbs === 0 ? (grossProfit > 0 ? 999 : 0) : safeDiv(grossProfit, wins.length) / avgLossAbs;
  const expectancyRatio = avgLossAbs === 0 ? 0 : mean / avgLossAbs;
  const cagrPct = maxDd === 0 ? 0 : (annualPnl / maxDd) * 100;
  const sorted = [...pnls].sort((a, b) => a - b);
  const pctile = (p: number) => { const i = Math.floor(p * sorted.length); return sorted[Math.min(i, sorted.length - 1)]; };
  const p5 = pctile(0.05), p95 = pctile(0.95);
  const tail = p5 === 0 ? 0 : Math.abs(p95 / p5);

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round2(safeDiv(wins.length, trades.length) * 100),
    totalPnl: round2(totalPnl),
    avgPnl: round2(mean),
    avgWin: round2(safeDiv(grossProfit, wins.length)),
    avgLoss: round2(safeDiv(-grossLoss, losses.length)),
    maxWin: round2(Math.max(...pnls)),
    maxLoss: round2(Math.min(...pnls)),
    profitFactor: round2(grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss),
    expectancy: round2(mean),
    maxDrawdown: round2(maxDd),
    maxDrawdownPct: round2(maxDdPct),
    sharpe: round2(sharpe),
    sortino: round2(sortino),
    calmar: round2(calmar),
    longestWinStreak: lw,
    longestLossStreak: ll,
    totalCosts: round2(totalCosts),
    recoveryFactor: round2(recoveryFactor),
    sqn: round2(sqn),
    payoffRatio: round2(payoffRatio),
    cagrPct: round2(cagrPct),
    tail: round2(tail),
    expectancyRatio: round2(expectancyRatio),
    maxDdDays,
    maxDdFrom,
    maxDdTo,
    maxTradesInDrawdown: maxTradesInDd,
  };
}

export function monthlyBreakdown(trades: DayTrade[]): MonthlyBucket[] {
  const map = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const m = t.date.slice(0, 7);
    const b = map.get(m) ?? { pnl: 0, trades: 0, wins: 0 };
    b.pnl += t.pnl; b.trades++; if (t.pnl > 0) b.wins++;
    map.set(m, b);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, b]) => ({
    month, pnl: round2(b.pnl), trades: b.trades, wins: b.wins,
    winRate: round2(safeDiv(b.wins, b.trades) * 100),
  }));
}

export function weekdayBreakdown(trades: DayTrade[]): WeekdayBucket[] {
  const map = new Map<WeekdayCode, { pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const code = tradeWeekday(t.date);
    if (!code) continue;
    const b = map.get(code) ?? { pnl: 0, trades: 0, wins: 0 };
    b.pnl += t.pnl; b.trades++; if (t.pnl > 0) b.wins++;
    map.set(code, b);
  }
  return WD.filter((d) => map.has(d)).map((d) => {
    const b = map.get(d)!;
    return { day: d, pnl: round2(b.pnl), trades: b.trades, winRate: round2(safeDiv(b.wins, b.trades) * 100) };
  });
}
