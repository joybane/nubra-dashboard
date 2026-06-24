// ─────────────────────────────────────────────────────────────────────────────
// Backtest orchestrator — public entry points used by the Fastify routes.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  BacktestConfig, BacktestMeta, BacktestResponse, DayDetailResponse, ExpiryFlag, Underlying, UnderlyingMeta,
  SweepRequest, WalkForwardRequest,
} from './types.ts';
import { listExpiries } from './dataLayer.ts';
import { enumerateTradingDays, runDays, runSingleDay } from './engine.ts';
import { buildEquityCurve, computeMetrics, monthlyBreakdown, weekdayBreakdown, runMonteCarlo, gradeStrategy } from './analysis.ts';
import { runSweep, pathIsValid } from './sweep.ts';
import { runWalkForward } from './walkforward.ts';

const UNDERLYINGS: Underlying[] = ['NIFTY', 'SENSEX'];
const FLAGS: ExpiryFlag[] = ['WEEK', 'MONTH'];

export async function getMeta(): Promise<BacktestMeta> {
  const underlyings: UnderlyingMeta[] = [];
  for (const und of UNDERLYINGS) {
    const present: ExpiryFlag[] = [];
    const all: string[] = [];
    for (const flag of FLAGS) {
      const exps = await listExpiries(und, flag);
      if (exps.length) { present.push(flag); all.push(...exps); }
    }
    if (!all.length) continue;
    all.sort();
    underlyings.push({
      underlying: und,
      flags: present,
      expiryCount: new Set(all).size,
      firstExpiry: all[0],
      lastExpiry: all[all.length - 1],
    });
  }
  return { underlyings };
}

export function validateConfig(cfg: BacktestConfig): string | null {
  if (!cfg) return 'Missing config.';
  if (!UNDERLYINGS.includes(cfg.underlying)) return `Unknown underlying: ${cfg.underlying}`;
  if (!cfg.from || !cfg.to) return 'from/to dates required.';
  if (cfg.from > cfg.to) return 'from date must be ≤ to date.';
  if (!/^\d{2}:\d{2}$/.test(cfg.entryTime)) return 'entryTime must be HH:MM.';
  if (!/^\d{2}:\d{2}$/.test(cfg.exitTime)) return 'exitTime must be HH:MM.';
  if (cfg.entryTime >= cfg.exitTime) return 'entryTime must be before exitTime.';
  if (!Number.isFinite(cfg.lotSize) || cfg.lotSize <= 0) return 'lotSize must be > 0.';
  if (!Array.isArray(cfg.legs) || !cfg.legs.length) return 'At least one leg required.';
  if (!cfg.legs.some((l) => l.enabled)) return 'At least one enabled leg required.';
  for (const l of cfg.legs) {
    if (!['CALL', 'PUT'].includes(l.optionType)) return `Leg ${l.id}: bad optionType.`;
    if (!['BUY', 'SELL'].includes(l.side)) return `Leg ${l.id}: bad side.`;
    if (!Number.isFinite(l.lots) || l.lots <= 0) return `Leg ${l.id}: lots must be > 0.`;
    if (l.reentry && l.reentry.mode !== 'NONE') {
      if (!Number.isFinite(l.reentry.max ?? 0) || (l.reentry.max ?? 0) < 0) return `Leg ${l.id}: re-entry max must be ≥ 0.`;
    }
    if (l.trail && l.trail.type !== 'NONE') {
      if (!Number.isFinite(l.trail.trigger ?? 0) || (l.trail.trigger ?? 0) < 0) return `Leg ${l.id}: trail trigger must be ≥ 0.`;
      if ((l.trail.type === 'TRAIL' || l.trail.type === 'LOCK_AND_TRAIL') && (!(l.trail.step! > 0))) return `Leg ${l.id}: trail step must be > 0.`;
    }
  }
  const f = cfg.entryFilters;
  if (f) {
    if (f.dteMin != null && f.dteMax != null && f.dteMin > f.dteMax) return 'entryFilters: dteMin must be ≤ dteMax.';
    if (f.ivMin != null && f.ivMax != null && f.ivMin > f.ivMax) return 'entryFilters: ivMin must be ≤ ivMax.';
    if (f.premiumMin != null && f.premiumMax != null && f.premiumMin > f.premiumMax) return 'entryFilters: premiumMin must be ≤ premiumMax.';
    if (f.waitTradePct != null && f.waitTradePct < 0) return 'entryFilters: waitTradePct must be ≥ 0.';
  }
  return null;
}

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResponse> {
  const dates = enumerateTradingDays(cfg.from, cfg.to, cfg.tradingDays);
  const { trades, warnings, scanned } = await runDays(cfg, dates);
  const metrics = computeMetrics(trades);
  return {
    ok: true,
    trades,
    metrics,
    equityCurve: buildEquityCurve(trades),
    monthly: monthlyBreakdown(trades),
    weekday: weekdayBreakdown(trades),
    warnings,
    tradingDaysScanned: scanned,
    config: cfg,
    monteCarlo: runMonteCarlo(trades),
    score: gradeStrategy(metrics),
  };
}

// Single-day detail — re-simulates one date and returns its intraday P&L curve.
export async function runDayDetail(cfg: BacktestConfig, date: string): Promise<DayDetailResponse> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must be yyyy-mm-dd.' };
  const res = await runSingleDay(cfg, date);
  if (!res) return { ok: false, error: 'No trade for that date (holiday / no data / entry filter not met).' };
  return { ok: true, trade: res.trade, series: res.series };
}

export function validateSweep(req: SweepRequest): string | null {
  const cfgErr = validateConfig(req.base);
  if (cfgErr) return cfgErr;
  if (!req.param1 || !req.param1.path) return 'param1.path required.';
  if (!pathIsValid(req.base, req.param1.path)) return `param1.path "${req.param1.path}" does not resolve to a settable field (check the leg index and that its SL/target value exists).`;
  if (!Number.isFinite(req.param1.from) || !Number.isFinite(req.param1.to)) return 'param1 from/to required.';
  if (!Number.isFinite(req.param1.step) || req.param1.step <= 0) return 'param1.step must be > 0.';
  const steps1 = Math.abs(req.param1.to - req.param1.from) / req.param1.step + 1;
  if (req.param2) {
    if (!req.param2.path) return 'param2.path required.';
    if (!pathIsValid(req.base, req.param2.path)) return `param2.path "${req.param2.path}" does not resolve to a settable field (check the leg index and that its SL/target value exists).`;
    if (!Number.isFinite(req.param2.from) || !Number.isFinite(req.param2.to)) return 'param2 from/to required.';
    if (!Number.isFinite(req.param2.step) || req.param2.step <= 0) return 'param2.step must be > 0.';
    const steps2 = Math.abs(req.param2.to - req.param2.from) / req.param2.step + 1;
    if (steps1 * steps2 > 500) return `Sweep grid too large (${Math.round(steps1)}×${Math.round(steps2)}=${Math.round(steps1 * steps2)}). Max 500 cells.`;
  } else {
    if (steps1 > 100) return `Sweep has ${Math.round(steps1)} steps. Max 100 for 1D.`;
  }
  return null;
}

export { runSweep, runWalkForward };

export function validateWalkForward(req: WalkForwardRequest): string | null {
  const cfgErr = validateConfig(req.base);
  if (cfgErr) return cfgErr;
  if (!req.param || !req.param.path) return 'param.path required.';
  if (!pathIsValid(req.base, req.param.path)) return `param.path "${req.param.path}" does not resolve to a settable field (check the leg index and that its SL/target value exists).`;
  if (!Number.isFinite(req.param.step) || req.param.step <= 0) return 'param.step must be > 0.';
  if (!Number.isFinite(req.windows) || req.windows < 2 || req.windows > 12) return 'windows must be between 2 and 12.';
  if (!Number.isFinite(req.oosPct) || req.oosPct < 5 || req.oosPct > 80) return 'oosPct must be between 5 and 80.';
  const steps = Math.abs(req.param.to - req.param.from) / req.param.step + 1;
  if (steps * req.windows > 400) return `Walk-forward too large (${Math.round(steps)} steps × ${req.windows} windows). Reduce range or windows.`;
  return null;
}
