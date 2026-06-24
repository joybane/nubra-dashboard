// ─────────────────────────────────────────────────────────────────────────────
// Walk-forward optimisation — guards against curve-fitting by optimising a single
// parameter on each in-sample (IS) window, then measuring realised performance on
// the immediately-following out-of-sample (OOS) window. The OOS slices are
// stitched into one continuous equity curve; "efficiency" compares realised OOS
// P&L against the IS-implied P&L (a value near/above 1 means the optimisation
// generalised; well below 1 means it over-fit).
// ─────────────────────────────────────────────────────────────────────────────
import type {
  BacktestConfig, WalkForwardRequest, WalkForwardResponse, WalkForwardWindow,
} from './types.ts';
import { enumerateTradingDays, runDays } from './engine.ts';
import { computeMetrics } from './analysis.ts';
import { rangeValues, setByPath } from './sweep.ts';

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export async function runWalkForward(req: WalkForwardRequest): Promise<WalkForwardResponse> {
  const { base, param, metric, windows } = req;
  const oosFrac = Math.min(Math.max(req.oosPct, 5), 80) / 100;

  const span = daysBetween(base.from, base.to);
  if (span < windows * 7) {
    return { ok: false, windows: [], oosTotalPnl: 0, oosWinRate: 0, efficiency: 0, equityCurve: [], error: 'Date range too short for the requested number of windows.' };
  }
  const winLen = Math.floor(span / windows);
  const values = rangeValues(param);

  const results: WalkForwardWindow[] = [];
  const equityCurve: { date: string; cumPnl: number }[] = [];
  let cum = 0;
  let isImpliedTotal = 0;

  for (let w = 0; w < windows; w++) {
    const winFrom = addDays(base.from, w * winLen);
    const winTo   = w === windows - 1 ? base.to : addDays(base.from, (w + 1) * winLen - 1);
    const isLen   = Math.floor(daysBetween(winFrom, winTo) * (1 - oosFrac));
    const isFrom  = winFrom;
    const isTo    = addDays(winFrom, Math.max(isLen, 1));
    const oosFrom = addDays(isTo, 1);
    const oosTo   = winTo;
    if (oosFrom > oosTo) continue;

    // optimise param on in-sample
    let bestParam = values[0], bestMetric = -Infinity, bestDailyMean = 0;
    for (const v of values) {
      const cfg: BacktestConfig = JSON.parse(JSON.stringify(base));
      cfg.from = isFrom; cfg.to = isTo;
      setByPath(cfg, param.path, v);
      const { trades } = await runDays(cfg, enumerateTradingDays(isFrom, isTo, cfg.tradingDays));
      const m = computeMetrics(trades);
      const val = m[metric] as number;
      if (val > bestMetric) { bestMetric = val; bestParam = v; bestDailyMean = trades.length ? m.totalPnl / trades.length : 0; }
    }

    // apply best param out-of-sample
    const oosCfg: BacktestConfig = JSON.parse(JSON.stringify(base));
    oosCfg.from = oosFrom; oosCfg.to = oosTo;
    setByPath(oosCfg, param.path, bestParam);
    const oosDates = enumerateTradingDays(oosFrom, oosTo, oosCfg.tradingDays);
    const { trades: oosTrades } = await runDays(oosCfg, oosDates);
    const oosM = computeMetrics(oosTrades);

    for (const t of oosTrades) { cum += t.pnl; equityCurve.push({ date: t.date, cumPnl: Math.round(cum * 100) / 100 }); }
    isImpliedTotal += bestDailyMean * oosTrades.length; // IS daily edge × OOS day count

    results.push({
      index: w + 1, isFrom, isTo, oosFrom, oosTo,
      bestParam, isMetric: Math.round(bestMetric * 100) / 100,
      oosPnl: Math.round(oosM.totalPnl * 100) / 100, oosTrades: oosTrades.length,
    });
  }

  const oosTotalPnl = Math.round(cum * 100) / 100;
  const positiveWins = results.filter((r) => r.oosPnl > 0).length;
  const oosWinRate = results.length ? Math.round((positiveWins / results.length) * 10000) / 100 : 0;
  const efficiency = isImpliedTotal !== 0 ? Math.round((oosTotalPnl / isImpliedTotal) * 1000) / 1000 : 0;

  return { ok: true, windows: results, oosTotalPnl, oosWinRate, efficiency, equityCurve };
}
