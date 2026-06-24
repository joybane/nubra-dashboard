// ─────────────────────────────────────────────────────────────────────────────
// Analysis layer — turns the day-by-day trade ledger into performance metrics,
// an equity curve with drawdown, and monthly / weekday breakdowns.
// Pure functions over DayTrade[]; no data access.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  DayTrade, EquityPoint, Metrics, MonthlyBucket, WeekdayBucket, WeekdayCode,
  MonteCarloResult, MonteCarloPercentile, StrategyScore, StrategyGrade,
} from './types.ts';

const WD: WeekdayCode[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const TRADING_DAYS_YEAR = 252;

function round2(n: number): number { return Math.round(n * 100) / 100; }
function safeDiv(a: number, b: number): number { return b === 0 ? 0 : a / b; }

export function buildEquityCurve(trades: DayTrade[]): EquityPoint[] {
  let peak = 0;
  return trades.map((t) => {
    peak = Math.max(peak, t.cumPnl);
    return { date: t.date, cumPnl: round2(t.cumPnl), drawdown: round2(t.cumPnl - peak) };
  });
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

  // drawdown (₹, %, duration, and the deepest stretch's peak/trough indices)
  let peak = 0, peakIdx = -1, maxDd = 0, maxDdPct = 0, ddPeakIdx = -1, ddTroughIdx = -1;
  let runMin = Infinity, maxTradesInDd = 0; // peak→trough trade span of any drawdown
  for (let i = 0; i < trades.length; i++) {
    const cum = trades[i].cumPnl;
    if (cum >= peak) { peak = cum; peakIdx = i; runMin = cum; }
    else if (cum < runMin) { runMin = cum; if (i - peakIdx > maxTradesInDd) maxTradesInDd = i - peakIdx; }
    const dd = peak - cum;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; ddPeakIdx = peakIdx; ddTroughIdx = i; }
  }
  // deepest-drawdown window: from the first day in the red (peak+1) to the trough
  const maxDdFrom = ddPeakIdx >= 0 ? trades[Math.min(ddPeakIdx + 1, trades.length - 1)].date : '';
  const maxDdTo   = ddTroughIdx >= 0 ? trades[ddTroughIdx].date : '';
  const maxDdDays = maxDdFrom && maxDdTo
    ? Math.round((Date.parse(`${maxDdTo}T00:00:00Z`) - Date.parse(`${maxDdFrom}T00:00:00Z`)) / 86400000) + 1
    : 0;

  // streaks
  let lw = 0, ll = 0, curW = 0, curL = 0;
  for (const p of pnls) {
    if (p > 0) { curW++; curL = 0; lw = Math.max(lw, curW); }
    else if (p < 0) { curL++; curW = 0; ll = Math.max(ll, curL); }
    else { curW = 0; curL = 0; }
  }

  // risk-adjusted (daily P&L based)
  const mean = totalPnl / pnls.length;
  const variance = pnls.reduce((a, p) => a + (p - mean) ** 2, 0) / pnls.length;
  const std = Math.sqrt(variance);
  const downside = Math.sqrt(
    safeDiv(pnls.filter((p) => p < 0).reduce((a, p) => a + p * p, 0), pnls.length),
  );
  const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(TRADING_DAYS_YEAR);
  const sortino = downside === 0 ? 0 : (mean / downside) * Math.sqrt(TRADING_DAYS_YEAR);
  const annualPnl = mean * TRADING_DAYS_YEAR;
  const calmar = maxDd === 0 ? 0 : annualPnl / maxDd;

  // Phase 3 extended
  const recoveryFactor = maxDd === 0 ? 0 : totalPnl / maxDd;
  const sqn = std === 0 ? 0 : (Math.sqrt(pnls.length) * mean) / std;
  const avgLossAbs = grossLoss === 0 ? 0 : grossLoss / losses.length;
  const payoffRatio = avgLossAbs === 0 ? (grossProfit > 0 ? 999 : 0) : safeDiv(grossProfit, wins.length) / avgLossAbs;
  const expectancyRatio = avgLossAbs === 0 ? 0 : mean / avgLossAbs;
  const cagrPct = maxDd === 0 ? 0 : (annualPnl / maxDd) * 100;

  // tail ratio: 95th percentile / |5th percentile| of daily P&L
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
    const dow = new Date(`${t.date}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const code = WD[dow - 1];
    const b = map.get(code) ?? { pnl: 0, trades: 0, wins: 0 };
    b.pnl += t.pnl; b.trades++; if (t.pnl > 0) b.wins++;
    map.set(code, b);
  }
  return WD.filter((d) => map.has(d)).map((d) => {
    const b = map.get(d)!;
    return { day: d, pnl: round2(b.pnl), trades: b.trades, winRate: round2(safeDiv(b.wins, b.trades) * 100) };
  });
}

// ── Monte Carlo simulation ──────────────────────────────────────────────────
function shuffle(arr: number[]): number[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function simEquity(pnls: number[]): { finalEq: number; maxDd: number; curve: number[] } {
  const curve: number[] = [];
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    curve.push(cum);
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  return { finalEq: cum, maxDd, curve };
}

export function runMonteCarlo(trades: DayTrade[], simCount = 1000): MonteCarloResult {
  const pnls = trades.map((t) => t.pnl);
  if (pnls.length < 5) {
    return { simulations: 0, percentiles: [], medianCurve: [], p5Curve: [], p95Curve: [] };
  }

  const finals: number[] = [];
  const dds: number[] = [];
  const allCurves: number[][] = [];
  for (let s = 0; s < simCount; s++) {
    const { finalEq, maxDd, curve } = simEquity(shuffle(pnls));
    finals.push(finalEq);
    dds.push(maxDd);
    allCurves.push(curve);
  }

  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);

  const pctile = (arr: number[], p: number) => {
    const i = Math.floor(p * arr.length);
    return arr[Math.min(i, arr.length - 1)];
  };
  const pcts = [0.05, 0.25, 0.5, 0.75, 0.95];
  const percentiles: MonteCarloPercentile[] = pcts.map((p) => ({
    pct: Math.round(p * 100),
    finalEquity: round2(pctile(finals, p)),
    maxDrawdown: round2(pctile(dds, p)),
  }));

  const n = pnls.length;
  const medianCurve: number[] = [];
  const p5Curve: number[] = [];
  const p95Curve: number[] = [];
  for (let i = 0; i < n; i++) {
    const col = allCurves.map((c) => c[i]).sort((a, b) => a - b);
    medianCurve.push(round2(pctile(col, 0.5)));
    p5Curve.push(round2(pctile(col, 0.05)));
    p95Curve.push(round2(pctile(col, 0.95)));
  }

  return { simulations: simCount, percentiles, medianCurve, p5Curve, p95Curve };
}

// ── Strategy scoring (A–F) ──────────────────────────────────────────────────
function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

export function gradeStrategy(m: Metrics): StrategyScore {
  const factors: { factor: string; score: number; weight: number }[] = [
    { factor: 'Profit Factor',   score: clamp01((m.profitFactor - 0.8) / 1.7) * 100,  weight: 0.20 },
    { factor: 'Win Rate',        score: clamp01((m.winRate - 30) / 40) * 100,          weight: 0.10 },
    { factor: 'Sharpe',          score: clamp01((m.sharpe + 0.5) / 3.5) * 100,         weight: 0.20 },
    { factor: 'Recovery Factor', score: clamp01(m.recoveryFactor / 5) * 100,           weight: 0.15 },
    { factor: 'SQN',             score: clamp01((m.sqn + 0.5) / 4.5) * 100,            weight: 0.15 },
    { factor: 'Payoff Ratio',    score: clamp01((m.payoffRatio - 0.5) / 2.5) * 100,    weight: 0.10 },
    { factor: 'Tail Ratio',      score: clamp01((m.tail - 0.3) / 1.7) * 100,           weight: 0.10 },
  ];
  const score = round2(factors.reduce((s, f) => s + f.score * f.weight, 0));
  let grade: StrategyGrade;
  if (score >= 80) grade = 'A';
  else if (score >= 60) grade = 'B';
  else if (score >= 40) grade = 'C';
  else if (score >= 20) grade = 'D';
  else grade = 'F';
  return { grade, score, breakdown: factors.map((f) => ({ ...f, score: round2(f.score) })) };
}
