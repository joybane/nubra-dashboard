import { useEffect, useMemo, useState, useCallback } from 'react';
import SvgChart from './components/SvgChart';
import LegCard from './backtest/LegCard';
import TradeChartView from './backtest/TradeChartView';
import { newLeg } from './backtest/types';
import type {
  Adjustment, AdjustmentTrigger, BacktestConfig, BacktestMeta, BacktestResponse, Leg, Underlying, UnderlyingMeta,
  Metrics, SweepRequest, SweepResponse, StrategyScore, SizingMode,
  WalkForwardRequest, WalkForwardResponse,
  DayTrade, MonthlyBucket, WeekdayBucket, WeekdayCode, IntradayPoint, DayDetailResponse,
} from './backtest/types';
import {
  computeMetrics as recomputeMetrics, buildEquityCurve as recomputeEquity,
  monthlyBreakdown as recomputeMonthly, weekdayBreakdown as recomputeWeekday,
  withRecumulated, tradeWeekday, tradeDte,
} from './backtest/clientAnalysis';
import type { Instrument } from './types';

type ResultTab = 'trades' | 'monthly' | 'weekday' | 'montecarlo' | 'score' | 'sweep' | 'walkforward';
const WEEKDAYS: WeekdayCode[] = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

interface Props { instrument: Instrument | null }

const inputCls =
  'w-full px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] ' +
  'text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]';
const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';

const DEFAULT_LOT: Record<Underlying, number> = { NIFTY: 65, SENSEX: 20 };
// Default AlgoTest calibration (signed %). −10% is a midpoint of the measured
// short-premium deviation band (≈ −3% no-SL … −20% with SL/re-entry). Editable per run.
const ALGOTEST_ADJ_DEFAULT = -10;

function inr(n: number): string {
  const s = Math.abs(n) >= 100000
    ? `${(n / 100000).toFixed(2)}L`
    : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
  return n < 0 ? `-₹${s.replace('-', '')}` : `₹${s}`;
}

function makeConfig(und: Underlying, meta: UnderlyingMeta | undefined, legs: Leg[]): BacktestConfig {
  return {
    underlying: und,
    from: meta ? clampFrom(meta) : '2021-01-01',
    to: meta?.lastExpiry ?? '2026-06-01',
    entryTime: '09:20', exitTime: '15:15',
    lotSize: DEFAULT_LOT[und], slippagePct: 0.5, brokeragePerLot: 20,
    legs, portfolioRisk: {},
  };
}
function clampFrom(meta: UnderlyingMeta): string {
  // default to ~1y before last expiry, but not before first
  const last = new Date(`${meta.lastExpiry}T00:00:00Z`);
  last.setUTCFullYear(last.getUTCFullYear() - 1);
  const oneYearBack = last.toISOString().slice(0, 10);
  return oneYearBack > meta.firstExpiry ? oneYearBack : meta.firstExpiry;
}

// strategy templates → leg sets
const TEMPLATES: Record<string, () => Leg[]> = {
  'Short Straddle': () => [
    newLeg({ optionType: 'CALL', side: 'SELL', strike: { method: 'ATM', atmOffset: 0 }, stopLoss: { type: 'PREMIUM_PERCENT', value: 30 } }),
    newLeg({ optionType: 'PUT', side: 'SELL', strike: { method: 'ATM', atmOffset: 0 }, stopLoss: { type: 'PREMIUM_PERCENT', value: 30 } }),
  ],
  'Short Strangle': () => [
    newLeg({ optionType: 'CALL', side: 'SELL', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: 200 }, stopLoss: { type: 'PREMIUM_PERCENT', value: 40 } }),
    newLeg({ optionType: 'PUT', side: 'SELL', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: -200 }, stopLoss: { type: 'PREMIUM_PERCENT', value: 40 } }),
  ],
  'Iron Condor': () => [
    newLeg({ optionType: 'CALL', side: 'SELL', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: 200 } }),
    newLeg({ optionType: 'CALL', side: 'BUY', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: 400 } }),
    newLeg({ optionType: 'PUT', side: 'SELL', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: -200 } }),
    newLeg({ optionType: 'PUT', side: 'BUY', strike: { method: 'POINTS_FROM_SPOT', pointsFromSpot: -400 } }),
  ],
};

export default function Backtest({ instrument }: Props) {
  const [meta, setMeta] = useState<BacktestMeta | null>(null);
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');
  const [config, setConfig] = useState<BacktestConfig>(() => makeConfig('NIFTY', undefined, TEMPLATES['Short Straddle']()));
  const [resp, setResp] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ResultTab>('trades');
  const [showFilters, setShowFilters] = useState(false);
  const [showSizing, setShowSizing] = useState(false);
  const [lotMult, setLotMult] = useState('');
  const [panelW, setPanelW] = useState(340);

  // ── drag the config-panel width (item 1) ──
  const onPanelDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelW;
    const onMove = (ev: MouseEvent) => {
      setPanelW(Math.min(640, Math.max(260, startW + (ev.clientX - startX))));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelW]);

  const undMeta = useMemo(
    () => meta?.underlyings.find((u) => u.underlying === underlying),
    [meta, underlying],
  );

  // load meta once; preselect underlying from instrument if it matches
  useEffect(() => {
    let alive = true;
    fetch('/api/backtest/meta').then((r) => r.json()).then((m: BacktestMeta) => {
      if (!alive) return;
      setMeta(m);
      const sym = (instrument?.symbol ?? instrument?.asset ?? instrument?.display_name ?? '').toUpperCase();
      const pre: Underlying = sym && sym.includes('SENSEX') ? 'SENSEX' : 'NIFTY';
      const um = m.underlyings.find((u) => u.underlying === pre) ?? m.underlyings[0];
      if (um) {
        setUnderlying(um.underlying);
        setConfig((c) => makeConfig(um.underlying, um, c.legs));
      }
    }).catch((e) => setError(`Failed to load data coverage: ${e.message}`));
    return () => { alive = false; };
  }, [instrument]);

  function patch(p: Partial<BacktestConfig>) { setConfig((c) => ({ ...c, ...p })); }
  function switchUnderlying(u: Underlying) {
    setUnderlying(u);
    const um = meta?.underlyings.find((m) => m.underlying === u);
    setConfig((c) => ({ ...makeConfig(u, um, c.legs), entryTime: c.entryTime, exitTime: c.exitTime, slippagePct: c.slippagePct, from: c.from, to: c.to }));
  }
  function applyTemplate(name: string) { patch({ legs: TEMPLATES[name]() }); }
  function updateLeg(i: number, leg: Leg) { patch({ legs: config.legs.map((l, j) => (j === i ? leg : l)) }); }
  function removeLeg(i: number) { patch({ legs: config.legs.filter((_, j) => j !== i) }); }
  function addLeg() { patch({ legs: [...config.legs, newLeg()] }); }
  // Scale the lots of EVERY leg by a factor (rounded to whole lots, min 1).
  function multiplyLots(factor: number) {
    patch({ legs: config.legs.map((l) => ({ ...l, lots: Math.max(1, Math.round(l.lots * factor)) })) });
  }

  async function run() {
    setLoading(true); setError(null); setResp(null);
    try {
      const r = await fetch('/api/backtest/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await r.json() as BacktestResponse;
      if (!r.ok || !data.ok) { setError(data.error || `Server error (${r.status})`); return; }
      setResp(data);
      setTab('trades');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const pr = config.portfolioRisk ?? {};
  const ef = config.entryFilters ?? {};
  const activeFilterCount = Object.values(ef).filter((v) => v != null && v !== 0).length;
  const sz = config.sizing ?? { mode: 'FIXED' as SizingMode };
  const setSizing = (patch: Partial<typeof sz>) => setConfig((c) => ({ ...c, sizing: { ...sz, ...patch } }));

  // "Complete square-off": exit ALL open legs the instant any one leg's SL fires.
  // Modelled as an adjustment with ON_ANY_LEG_SL trigger and no replacement legs
  // (the engine closes every open slot on the trigger bar). Detected/toggled here
  // distinct from user-defined re-strike adjustments (which carry replacementLegs).
  const isSquareOffAdj = (a: Adjustment) =>
    a.enabled && a.trigger === 'ON_ANY_LEG_SL' && (a.replacementLegs?.length ?? 0) === 0;
  const squareOffAll = (config.adjustments ?? []).some(isSquareOffAdj);
  const setSquareOffAll = (on: boolean) => setConfig((c) => {
    const rest = (c.adjustments ?? []).filter((a) => !isSquareOffAdj(a));
    return {
      ...c,
      adjustments: on
        ? [...rest, { enabled: true, trigger: 'ON_ANY_LEG_SL', replacementLegs: [], maxAdjustments: 1, delayBars: 0 } as Adjustment]
        : rest,
    };
  });

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Config panel ── */}
      <div style={{ width: panelW }} className="shrink-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="font-bold text-[var(--text-primary)] text-[13px]">Backtest</span>
          {meta && <span className="text-[10px] text-[var(--text-muted)]">{undMeta?.expiryCount} expiries</span>}
        </div>

        {/* underlying */}
        <div className="flex gap-1">
          {(meta?.underlyings ?? [{ underlying: 'NIFTY' }, { underlying: 'SENSEX' }] as UnderlyingMeta[]).map((u) => (
            <button key={u.underlying} onClick={() => switchUnderlying(u.underlying)}
              className={`flex-1 py-1.5 rounded text-[12px] font-semibold ${underlying === u.underlying ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
              {u.underlying}
            </button>
          ))}
        </div>
        {undMeta && (
          <div className="text-[10px] text-[var(--text-muted)] -mt-1">
            Data: {undMeta.firstExpiry} → {undMeta.lastExpiry}
          </div>
        )}

        {/* dates */}
        <div className="grid grid-cols-2 gap-2">
          <label><span className={lblCls}>From</span>
            <input type="date" value={config.from} min={undMeta?.firstExpiry} max={undMeta?.lastExpiry}
              onChange={(e) => patch({ from: e.target.value })} className={inputCls} /></label>
          <label><span className={lblCls}>To</span>
            <input type="date" value={config.to} min={undMeta?.firstExpiry} max={undMeta?.lastExpiry}
              onChange={(e) => patch({ to: e.target.value })} className={inputCls} /></label>
          <label><span className={lblCls}>Entry time</span>
            <input type="time" value={config.entryTime} onChange={(e) => patch({ entryTime: e.target.value })} className={inputCls} /></label>
          <label><span className={lblCls}>Exit time</span>
            <input type="time" value={config.exitTime} onChange={(e) => patch({ exitTime: e.target.value })} className={inputCls} /></label>
          <label><span className={lblCls}>Lot size</span>
            <input type="number" value={config.lotSize} onChange={(e) => patch({ lotSize: Number(e.target.value) })} className={inputCls} /></label>
          <label><span className={lblCls}>Slippage %</span>
            <input type="number" step={0.05} value={config.slippagePct} onChange={(e) => patch({ slippagePct: Number(e.target.value) })} className={inputCls} /></label>
        </div>

        {/* portfolio risk */}
        <div className="grid grid-cols-2 gap-2">
          <label><span className={lblCls}>Max profit ₹ (0=off)</span>
            <input type="number" value={pr.maxProfit ?? 0}
              onChange={(e) => patch({ portfolioRisk: { ...pr, maxProfit: Number(e.target.value) || undefined } })} className={inputCls} /></label>
          <label><span className={lblCls}>Max loss ₹ (0=off)</span>
            <input type="number" value={pr.maxLoss ?? 0}
              onChange={(e) => patch({ portfolioRisk: { ...pr, maxLoss: Number(e.target.value) || undefined } })} className={inputCls} /></label>
        </div>

        {/* complete square-off: exit all legs when any one leg's SL fires */}
        <label className="flex items-start gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={squareOffAll}
            onChange={(e) => setSquareOffAll(e.target.checked)}
            className="mt-0.5 accent-[var(--accent)]" />
          <span className="text-[11px] leading-tight">
            <span className="text-[var(--text-primary)]">Exit all legs on any SL</span>
            <span className="block text-[10px] text-[var(--text-muted)]">
              When one leg hits its stop-loss, square off all remaining legs at the same instant (AlgoTest "Complete" square-off).
            </span>
          </span>
        </label>

        {/* entry filters */}
        <div>
          <button onClick={() => setShowFilters((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1">
            <span>{showFilters ? '▾' : '▸'}</span>
            <span>Entry filters</span>
            {activeFilterCount > 0 && <span className="text-[var(--accent)]">({activeFilterCount})</span>}
          </button>
          {showFilters && (
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {([
                ['dteMin', 'DTE min'], ['dteMax', 'DTE max'],
                ['ivMin', 'IV min'], ['ivMax', 'IV max'],
                ['premiumMin', 'Combined prem min'], ['premiumMax', 'Combined prem max'],
                ['waitTradePct', 'Wait & trade %'],
              ] as [keyof typeof ef, string][]).map(([key, label]) => (
                <label key={key}><span className={lblCls}>{label} (0=off)</span>
                  <input type="number" value={ef[key] ?? 0}
                    onChange={(e) => patch({ entryFilters: { ...ef, [key]: Number(e.target.value) || undefined } })}
                    className={inputCls} /></label>
              ))}
            </div>
          )}
        </div>

        {/* position sizing */}
        <div>
          <button onClick={() => setShowSizing((v) => !v)}
            className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1">
            <span>{showSizing ? '▾' : '▸'}</span>
            <span>Position sizing</span>
            {sz.mode !== 'FIXED' && <span className="text-[var(--accent)]">({sz.mode.split('_')[0].toLowerCase()})</span>}
          </button>
          {showSizing && (
            <div className="mt-1.5 flex flex-col gap-2">
              <label><span className={lblCls}>Mode</span>
                <select value={sz.mode} onChange={(e) => setSizing({ mode: e.target.value as SizingMode })} className={inputCls}>
                  <option value="FIXED">Fixed lots</option>
                  <option value="CAPITAL_PERCENT">Capital % at risk</option>
                  <option value="VOLATILITY_TARGET">Volatility target</option>
                  <option value="MARTINGALE">Martingale</option>
                </select>
              </label>
              {sz.mode === 'CAPITAL_PERCENT' && (
                <div className="grid grid-cols-2 gap-2">
                  <label><span className={lblCls}>Capital ₹</span>
                    <input type="number" value={sz.capital ?? 0} onChange={(e) => setSizing({ capital: Number(e.target.value) || undefined })} className={inputCls} /></label>
                  <label><span className={lblCls}>Risk % / day</span>
                    <input type="number" value={sz.riskPct ?? 0} onChange={(e) => setSizing({ riskPct: Number(e.target.value) || undefined })} className={inputCls} /></label>
                </div>
              )}
              {sz.mode === 'VOLATILITY_TARGET' && (
                <label><span className={lblCls}>Baseline IV (lots = base at this IV)</span>
                  <input type="number" value={sz.baselineIv ?? 0} onChange={(e) => setSizing({ baselineIv: Number(e.target.value) || undefined })} className={inputCls} /></label>
              )}
              {sz.mode === 'MARTINGALE' && (
                <div className="grid grid-cols-2 gap-2">
                  <label><span className={lblCls}>Factor / loss</span>
                    <input type="number" step={0.1} value={sz.factor ?? 2} onChange={(e) => setSizing({ factor: Number(e.target.value) || undefined })} className={inputCls} /></label>
                  <label><span className={lblCls}>Max lots ×</span>
                    <input type="number" value={sz.maxLots ?? 0} onChange={(e) => setSizing({ maxLots: Number(e.target.value) || undefined })} className={inputCls} /></label>
                </div>
              )}
            </div>
          )}
        </div>

        {/* templates */}
        <div>
          <span className={lblCls}>Templates</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {Object.keys(TEMPLATES).map((t) => (
              <button key={t} onClick={() => applyTemplate(t)}
                className="px-2 py-1 rounded text-[10px] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* legs */}
        <div className="flex items-center justify-between">
          <span className={lblCls}>Legs ({config.legs.length})</span>
          <button onClick={addLeg} className="px-2 py-0.5 rounded text-[11px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">+ Add leg</button>
        </div>
        {/* lot multiplier — scales the lots of all legs at once */}
        {config.legs.length > 0 && (
          <div className="flex items-center gap-1.5 -mt-1 flex-wrap">
            <span className="text-[10px] text-[var(--text-muted)]">Multiply lots:</span>
            {[2, 3, 5, 10].map((f) => (
              <button key={f} onClick={() => multiplyLots(f)}
                className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                ×{f}
              </button>
            ))}
            <input type="number" min={0} step="any" value={lotMult} placeholder="custom"
              onChange={(e) => setLotMult(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const f = Number(lotMult); if (f > 0) { multiplyLots(f); setLotMult(''); } } }}
              className="w-14 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-primary)]" />
            <button onClick={() => { const f = Number(lotMult); if (f > 0) { multiplyLots(f); setLotMult(''); } }}
              disabled={!(Number(lotMult) > 0)}
              className="px-1.5 py-0.5 rounded text-[10px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30 disabled:opacity-40">
              Apply ×
            </button>
          </div>
        )}
        <div className="flex flex-col gap-2">
          {config.legs.map((leg, i) => (
            <LegCard key={leg.id} leg={leg} index={i} onChange={(l) => updateLeg(i, l)} onRemove={() => removeLeg(i)} />
          ))}
          {!config.legs.length && <div className="text-[11px] text-[var(--text-muted)] italic">No legs — add one or pick a template.</div>}
        </div>

        {/* ── Adjustments ── */}
        <AdjustmentPanel config={config} patch={patch} />

        <button onClick={run} disabled={loading || !config.legs.length}
          className="w-full py-2.5 rounded-lg bg-[var(--accent)] text-white font-semibold text-[13px] hover:opacity-90 disabled:opacity-50 transition">
          {loading ? 'Running…' : 'Run Backtest'}
        </button>
        {error && <div className="text-[var(--red)] text-[11px] bg-[var(--red)]/10 rounded px-2 py-1.5">{error}</div>}
      </div>

      {/* ── Config/Results drag divider (item 1) ── */}
      <div
        onMouseDown={onPanelDrag}
        title="Drag to resize"
        className="w-1 shrink-0 cursor-col-resize bg-[var(--border)] hover:bg-[var(--accent)] transition-colors"
      />

      {/* ── Results ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!resp && !loading && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[13px]">
            Configure a strategy and run the backtest.
          </div>
        )}
        {loading && (
          <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[13px]">
            Simulating… reading historical bars.
          </div>
        )}
        {resp && <Results resp={resp} tab={tab} setTab={setTab} config={config} />}
      </div>
    </div>
  );
}

// ── Export helpers ─────────────────────────────────────────────────────────────
function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function exportCSV(resp: BacktestResponse) {
  const hdr = 'Date,Entry Spot,Exit Spot,Margin,ROI%,Gross P&L,Costs,Net P&L,Cum P&L,Exit Reason,Legs\n';
  const rows = resp.trades.map((t) => {
    const legs = t.legs.map((l) => `${l.side} ${l.optionType} ${l.strike} @${l.entryPrice}→${l.exitPrice} hi=${l.highAfterEntry} lo=${l.lowAfterEntry} ${l.exitReason}`).join(' | ');
    return `${t.date},${t.entrySpot},${t.exitSpot},${t.margin},${t.roiPct},${t.grossPnl},${t.costs},${t.pnl},${t.cumPnl},${t.exitReason},"${legs}"`;
  }).join('\n');
  downloadFile(`backtest_${resp.config.underlying}_${resp.config.from}_${resp.config.to}.csv`, hdr + rows, 'text/csv');
}
function exportJSON(resp: BacktestResponse) {
  downloadFile(`backtest_${resp.config.underlying}_${resp.config.from}_${resp.config.to}.json`, JSON.stringify(resp, null, 2), 'application/json');
}

// ── Grade badge ───────────────────────────────────────────────────────────────
const gradeColor: Record<string, string> = { A: '#22c55e', B: '#84cc16', C: '#eab308', D: '#f97316', F: '#ef4444' };
function GradeBadge({ score }: { score: StrategyScore }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[22px] font-black rounded-md px-2 py-0.5" style={{ color: gradeColor[score.grade], background: `${gradeColor[score.grade]}18` }}>
        {score.grade}
      </span>
      <span className="text-[11px] text-[var(--text-muted)]">{score.score}/100</span>
    </div>
  );
}

// ── Results dashboard ──────────────────────────────────────────────────────────
function Results({ resp, tab, setTab, config }: { resp: BacktestResponse; tab: ResultTab; setTab: (t: ResultTab) => void; config: BacktestConfig }) {
  const [chartH, setChartH] = useState(200);          // draggable equity-curve height (item 1)
  const [wkFilter, setWkFilter] = useState<Set<WeekdayCode>>(new Set());  // empty = all (item 4)
  const [dteFilter, setDteFilter] = useState<Set<number>>(new Set());     // empty = all (item 4)
  const [detail, setDetail] = useState<DayTrade | null>(null);            // trade detail modal (items 2 & 6)
  // AlgoTest calibration: our option premiums are cash/spot-priced while AlgoTest
  // prices off futures, so on short-premium strategies our P&L systematically
  // overshoots AlgoTest's. This signed % maps Overall → an estimated AlgoTest
  // figure. It is NOT a constant — measured deviations: short ATM strangle (no SL)
  // ≈ −3%, OTM strangle with SL + re-entry ≈ −20%, hedged/long-leg structures can
  // swing the other way. Default targets naked short-premium strategies; tune per run.
  const [algoAdj, setAlgoAdj] = useState(ALGOTEST_ADJ_DEFAULT);

  // available DTE values across all trades (for the filter dropdown)
  const dteOptions = useMemo(() => {
    const s = new Set<number>();
    for (const t of resp.trades) { const d = tradeDte(t); if (d != null) s.add(d); }
    return [...s].sort((a, b) => a - b);
  }, [resp.trades]);

  const isFiltered = wkFilter.size > 0 || dteFilter.size > 0;
  const filtered = useMemo(() => {
    if (!isFiltered) return resp.trades;
    return resp.trades.filter((t) => {
      if (wkFilter.size) { const w = tradeWeekday(t.date); if (!w || !wkFilter.has(w)) return false; }
      if (dteFilter.size) { const d = tradeDte(t); if (d == null || !dteFilter.has(d)) return false; }
      return true;
    });
  }, [resp.trades, wkFilter, dteFilter, isFiltered]);

  // recompute everything from the filtered set, or use the server result verbatim
  const m       = useMemo(() => isFiltered ? recomputeMetrics(filtered) : resp.metrics, [filtered, isFiltered, resp.metrics]);
  const equity  = useMemo(() => isFiltered ? recomputeEquity(filtered) : resp.equityCurve, [filtered, isFiltered, resp.equityCurve]);
  const monthly = useMemo(() => isFiltered ? recomputeMonthly(filtered) : resp.monthly, [filtered, isFiltered, resp.monthly]);
  const weekday = useMemo(() => isFiltered ? recomputeWeekday(filtered) : resp.weekday, [filtered, isFiltered, resp.weekday]);
  const tradeRows = useMemo(() => isFiltered ? withRecumulated(filtered) : resp.trades, [filtered, isFiltered, resp.trades]);

  const onChartDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = chartH;
    const onMove = (ev: MouseEvent) => setChartH(Math.min(560, Math.max(110, startH + (ev.clientY - startY))));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [chartH]);

  const toggleWk = (d: WeekdayCode) => setWkFilter((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const toggleDte = (d: number) => setDteFilter((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });

  const pos = (n: number) => (n >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]');
  const estAlgo = m.totalPnl * (1 + algoAdj / 100);
  const cards: { label: string; val: string; cls?: string; hint?: string; sub?: string }[] = [
    // ── AlgoTest-report parity set ──
    { label: 'Overall profit', val: inr(m.totalPnl), cls: pos(m.totalPnl),
      sub: `≈ AlgoTest ${inr(estAlgo)}` },
    { label: 'Trades', val: `${m.totalTrades}` },
    { label: 'Avg profit / trade', val: inr(m.avgPnl), cls: pos(m.avgPnl) },
    { label: 'Win %', val: `${m.winRate}%` },
    { label: 'Loss %', val: `${Math.round((100 - m.winRate) * 100) / 100}%` },
    { label: 'Avg profit on wins', val: inr(m.avgWin), cls: 'text-[var(--green)]' },
    { label: 'Avg loss on losses', val: inr(m.avgLoss), cls: 'text-[var(--red)]' },
    { label: 'Max profit (trade)', val: inr(m.maxWin), cls: 'text-[var(--green)]' },
    { label: 'Max loss (trade)', val: inr(m.maxLoss), cls: 'text-[var(--red)]' },
    { label: 'Max drawdown', val: inr(-m.maxDrawdown), cls: 'text-[var(--red)]' },
    { label: 'Max DD duration', val: m.maxDdDays ? `${m.maxDdDays}d` : '—',
      hint: m.maxDdFrom ? `${m.maxDdFrom} → ${m.maxDdTo}` : undefined },
    { label: 'Return / MaxDD', val: `${m.recoveryFactor}`, cls: pos(m.recoveryFactor) },
    { label: 'Reward : Risk', val: `${m.payoffRatio}` },
    { label: 'Expectancy ratio', val: `${m.expectancyRatio}`, cls: pos(m.expectancyRatio) },
    { label: 'Max win streak', val: `${m.longestWinStreak}` },
    { label: 'Max losing streak', val: `${m.longestLossStreak}` },
    { label: 'Max trades in DD', val: `${m.maxTradesInDrawdown}` },
    // ── extra Nubra metrics ──
    { label: 'Profit factor', val: `${m.profitFactor}` },
    { label: 'Sharpe', val: `${m.sharpe}`, cls: pos(m.sharpe) },
    { label: 'Sortino', val: `${m.sortino}`, cls: pos(m.sortino) },
    { label: 'SQN', val: `${m.sqn}`, cls: pos(m.sqn) },
    { label: 'Total costs', val: inr(-m.totalCosts), cls: 'text-[var(--red)]' },
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* top bar: score + metric cards + export */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-3">
            {resp.score && <GradeBadge score={resp.score} />}
            <span className="text-[11px] text-[var(--text-muted)]">
              {resp.tradingDaysScanned} days scanned{isFiltered ? ` · ${filtered.length} of ${resp.trades.length} trades shown` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1" title="Maps Overall profit → an estimated AlgoTest figure. Our premiums are cash/spot-priced; AlgoTest prices off futures, so short-premium P&L overshoots. Measured deviation: ≈ −3% (no SL) to −20% (SL + re-entry); hedged structures can differ in sign. Tune to your strategy.">
              <span className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">AlgoTest adj %</span>
              <input type="number" step="1" value={algoAdj}
                onChange={(e) => setAlgoAdj(Number(e.target.value) || 0)}
                className="w-14 px-1.5 py-0.5 rounded text-[10px] bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-primary)] tabular-nums" />
            </label>
            <button onClick={() => exportCSV(resp)} className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">CSV</button>
            <button onClick={() => exportJSON(resp)} className="px-2 py-0.5 rounded text-[10px] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]">JSON</button>
          </div>
        </div>
        <div className="grid grid-cols-6 gap-x-3 gap-y-1">
          {cards.map((c) => (
            <div key={c.label} title={c.hint}>
              <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">{c.label}</div>
              <div className={`text-[13px] font-semibold ${c.cls ?? 'text-[var(--text-primary)]'}`}>{c.val}</div>
              {c.sub && <div className="text-[10px] text-[var(--accent)] tabular-nums leading-tight" title="Estimated AlgoTest result = Overall × (1 + adj%). Calibration is approximate — see the AlgoTest adj field.">{c.sub}</div>}
            </div>
          ))}
        </div>
      </div>

      {resp.warnings.length > 0 && (
        <div className="shrink-0 text-[10px] text-yellow-400/90 bg-yellow-500/5 px-3 py-1 border-b border-[var(--border)]">
          {resp.warnings.join(' · ')}
        </div>
      )}

      {/* filter bar — weekday + days-to-expiry (item 4) */}
      <div className="shrink-0 flex items-center flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-secondary)]/40">
        <span className={lblCls}>Filter by</span>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-[var(--text-muted)] mr-0.5">Weekday</span>
          {WEEKDAYS.map((d) => (
            <button key={d} onClick={() => toggleWk(d)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${wkFilter.has(d) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
              {d}
            </button>
          ))}
        </div>
        {dteOptions.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <span className="text-[10px] text-[var(--text-muted)] mr-0.5">DTE</span>
            {dteOptions.map((d) => (
              <button key={d} onClick={() => toggleDte(d)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold tabular-nums ${dteFilter.has(d) ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
                {d}
              </button>
            ))}
          </div>
        )}
        {isFiltered && (
          <button onClick={() => { setWkFilter(new Set()); setDteFilter(new Set()); }}
            className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20">
            Clear
          </button>
        )}
      </div>

      {/* equity curve — height draggable (item 1) */}
      <div className="shrink-0 border-b border-[var(--border)] p-2" style={{ height: chartH }}>
        <SvgChart
          data={equity}
          xKey="date"
          series={[
            { dataKey: 'cumPnl', color: 'var(--accent)', strokeWidth: 1.5 },
            { dataKey: 'drawdown', color: 'var(--red)', strokeWidth: 1, fill: 'rgba(239,68,68,0.12)' },
          ]}
          refLines={[{ axis: 'y', value: 0, color: '#2a2d42' }]}
          xFormatter={(v) => String(v).slice(2)}
          yFormatter={(v) => inr(v)}
          showLegend
          legendLabels={{ cumPnl: 'Cumulative P&L', drawdown: 'Drawdown' }}
          tooltipFormatter={(d) => `${(d as any).date}\nCum: ${inr(d.cumPnl)}\nDD: ${inr(d.drawdown)}`}
        />
      </div>
      <div onMouseDown={onChartDrag} title="Drag to resize chart"
        className="h-1.5 shrink-0 cursor-row-resize bg-[var(--border)] hover:bg-[var(--accent)] transition-colors" />

      {/* tabs */}
      <div className="shrink-0 flex gap-1 px-3 py-1 border-b border-[var(--border)]">
        {(['trades', 'monthly', 'weekday', 'montecarlo', 'score', 'sweep', 'walkforward'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-2.5 py-0.5 rounded text-[11px] font-medium capitalize ${tab === t ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}>
            {t === 'montecarlo' ? 'Monte Carlo' : t === 'walkforward' ? 'Walk-forward' : t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'trades' && <TradesTable trades={tradeRows} onSelect={setDetail} />}
        {tab === 'monthly' && <MonthlyTable monthly={monthly} />}
        {tab === 'weekday' && <WeekdayTable weekday={weekday} />}
        {tab === 'montecarlo' && <MonteCarloTab resp={resp} />}
        {tab === 'score' && <ScoreTab resp={resp} />}
        {tab === 'sweep' && <SweepTab config={config} />}
        {tab === 'walkforward' && <WalkForwardTab config={config} />}
      </div>

      {detail && <TradeDetailModal trade={detail} config={config} onClose={() => setDetail(null)} />}
    </div>
  );
}

const ADJ_TRIGGERS: { v: AdjustmentTrigger; label: string }[] = [
  { v: 'ON_ANY_LEG_SL',   label: 'Any leg SL hit' },
  { v: 'ON_ANY_LEG_TGT',  label: 'Any leg target hit' },
  { v: 'ON_PORTFOLIO_SL',  label: 'Portfolio SL hit' },
  { v: 'ON_PORTFOLIO_TP',  label: 'Portfolio target hit' },
];

function AdjustmentPanel({ config, patch }: { config: BacktestConfig; patch: (p: Partial<BacktestConfig>) => void }) {
  const adjs = config.adjustments ?? [];
  const [expanded, setExpanded] = useState(false);
  // The "Exit all legs on any SL" toggle (handled by its own checkbox above) is
  // stored as an adjustment too — hide it here so it isn't shown/edited twice.
  const visible = adjs
    .map((a, i) => [a, i] as const)
    .filter(([a]) => !(a.enabled && a.trigger === 'ON_ANY_LEG_SL' && (a.replacementLegs?.length ?? 0) === 0));

  function addAdj() {
    const adj: Adjustment = {
      enabled: true, trigger: 'ON_ANY_LEG_SL',
      replacementLegs: [newLeg({ optionType: 'CALL', side: 'SELL' }), newLeg({ optionType: 'PUT', side: 'SELL' })],
      maxAdjustments: 1, delayBars: 0,
    };
    patch({ adjustments: [...adjs, adj] });
  }
  function updateAdj(i: number, a: Adjustment) {
    const next = [...adjs]; next[i] = a; patch({ adjustments: next });
  }
  function removeAdj(i: number) {
    patch({ adjustments: adjs.filter((_, j) => j !== i) });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setExpanded(v => !v)}
        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center gap-1">
        <span>{expanded ? '▾' : '▸'}</span>
        <span>Adjustments ({visible.length})</span>
        {visible.length > 0 && <span className="text-[var(--accent)]">●</span>}
      </button>
      {expanded && (
        <div className="flex flex-col gap-2 pl-1 border-l-2 border-[var(--accent)]/30">
          {visible.map(([adj, i]) => (
            <AdjustmentCard key={i} adj={adj} index={i}
              onChange={(a) => updateAdj(i, a)} onRemove={() => removeAdj(i)} />
          ))}
          <button onClick={addAdj}
            className="px-2 py-1 rounded text-[10px] bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 self-start">
            + Add adjustment rule
          </button>
        </div>
      )}
    </div>
  );
}

function AdjustmentCard({ adj, index, onChange, onRemove }: {
  adj: Adjustment; index: number; onChange: (a: Adjustment) => void; onRemove: () => void;
}) {
  const set = (patch: Partial<Adjustment>) => onChange({ ...adj, ...patch });
  const rLegs = adj.replacementLegs;

  function addRLeg() {
    set({ replacementLegs: [...rLegs, newLeg()] });
  }
  function updateRLeg(i: number, l: Leg) {
    const next = [...rLegs]; next[i] = l; set({ replacementLegs: next });
  }
  function removeRLeg(i: number) {
    set({ replacementLegs: rLegs.filter((_, j) => j !== i) });
  }

  return (
    <div className={`rounded-lg border p-2 flex flex-col gap-2 ${adj.enabled ? 'border-orange-500/40 bg-orange-500/5' : 'border-[var(--border)] opacity-50'}`}>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-orange-400 font-mono">ADJ{index + 1}</span>
        <select value={adj.trigger} onChange={(e) => set({ trigger: e.target.value as AdjustmentTrigger })}
          className={inputCls + ' flex-1'}>
          {ADJ_TRIGGERS.map(t => <option key={t.v} value={t.v}>{t.label}</option>)}
        </select>
        <button onClick={() => set({ enabled: !adj.enabled })} title="Enable/disable"
          className={`px-1.5 py-0.5 rounded text-[10px] ${adj.enabled ? 'text-orange-400' : 'text-[var(--text-muted)]'}`}>
          {adj.enabled ? '●' : '○'}
        </button>
        <button onClick={onRemove} className="px-1.5 py-0.5 rounded text-[12px] text-[var(--text-muted)] hover:text-[var(--red)]">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <label>
          <span className={lblCls}>Max per day</span>
          <input type="number" min={1} value={adj.maxAdjustments ?? 1}
            onChange={(e) => set({ maxAdjustments: Math.max(1, Number(e.target.value) || 1) })}
            className={inputCls} />
        </label>
        <label>
          <span className={lblCls}>Delay bars</span>
          <input type="number" min={0} value={adj.delayBars ?? 0}
            onChange={(e) => set({ delayBars: Math.max(0, Number(e.target.value) || 0) })}
            className={inputCls} />
        </label>
      </div>
      <div className="flex items-center justify-between">
        <span className={lblCls}>Replacement legs ({rLegs.length})</span>
        <button onClick={addRLeg}
          className="px-2 py-0.5 rounded text-[10px] bg-[var(--accent)]/20 text-[var(--accent)] hover:bg-[var(--accent)]/30">+ Add</button>
      </div>
      <div className="flex flex-col gap-1.5">
        {rLegs.map((leg, i) => (
          <LegCard key={leg.id} leg={leg} index={i}
            onChange={(l) => updateRLeg(i, l)} onRemove={() => removeRLeg(i)} />
        ))}
      </div>
    </div>
  );
}

function reasonColor(r: string): string {
  if (r === 'TARGET' || r === 'PORTFOLIO_TP') return 'var(--green)';
  if (r === 'STOPLOSS' || r === 'PORTFOLIO_SL') return 'var(--red)';
  if (r === 'TRAIL_SL') return 'var(--accent)';
  return 'var(--text-muted)';
}

function TradesTable({ trades, onSelect }: { trades: DayTrade[]; onSelect: (t: DayTrade) => void }) {
  const headers = ['Date', 'Spot in→out', 'Legs (entry→exit)', 'Hi/Lo', 'Margin', 'ROI%', 'Gross', 'Costs', 'Net', 'Cum', 'Exit'];
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-[11px] border-collapse">
      <thead className="sticky top-0 bg-[var(--bg-secondary)]">
        <tr>{headers.map((h) => (
          <th key={h} className="text-left px-2 py-1.5 text-[var(--text-muted)] font-medium border-b border-[var(--border)] whitespace-nowrap">{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {trades.map((t) => (
          <tr key={t.date} onClick={() => onSelect(t)} title="Click for trade detail & intraday P&L"
            className="border-b border-[var(--border)]/40 hover:bg-[var(--bg-hover)] cursor-pointer">
            <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap">{t.date}</td>
            <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">{Math.round(t.entrySpot)}→{Math.round(t.exitSpot)}</td>
            <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">
              {t.legs.map((l, i) => (
                <span key={i}>
                  {i > 0 && ' '}
                  <span className={l.side === 'SELL' ? 'text-[var(--red)]' : 'text-[var(--green)]'}>
                    {l.side === 'SELL' ? '-' : '+'}{l.optionType === 'CALL' ? 'CE' : 'PE'} {l.strike}
                  </span>
                  <span className="text-[var(--text-muted)] opacity-60"> @{l.entryPrice.toFixed(1)}→{l.exitPrice.toFixed(1)}</span>
                </span>
              ))}
            </td>
            <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap text-[10px]">
              {t.legs.map((l, i) => (
                <span key={i}>
                  {i > 0 && ' '}
                  <span className="text-[var(--green)]">↑{l.highAfterEntry?.toFixed(1)}</span>
                  <span className="text-[var(--red)]"> ↓{l.lowAfterEntry?.toFixed(1)}</span>
                </span>
              ))}
            </td>
            <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">{inr(t.margin)}</td>
            <td className={`px-2 py-1 whitespace-nowrap ${t.roiPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{t.roiPct?.toFixed(2)}%</td>
            <td className={`px-2 py-1 ${t.grossPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(t.grossPnl)}</td>
            <td className="px-2 py-1 text-[var(--text-muted)]">{inr(t.costs)}</td>
            <td className={`px-2 py-1 font-semibold ${t.pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(t.pnl)}</td>
            <td className={`px-2 py-1 ${t.cumPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(t.cumPnl)}</td>
            <td className="px-2 py-1" style={{ color: reasonColor(t.exitReason) }}>{t.exitReason}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function MonthlyTable({ monthly }: { monthly: MonthlyBucket[] }) {
  return (
    <table className="w-full text-[11px] border-collapse">
      <thead className="sticky top-0 bg-[var(--bg-secondary)]">
        <tr>{['Month', 'P&L', 'Trades', 'Win rate'].map((h) => (
          <th key={h} className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {monthly.map((b) => (
          <tr key={b.month} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg-hover)]">
            <td className="px-3 py-1 text-[var(--text-secondary)]">{b.month}</td>
            <td className={`px-3 py-1 font-semibold ${b.pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(b.pnl)}</td>
            <td className="px-3 py-1 text-[var(--text-muted)]">{b.trades}</td>
            <td className="px-3 py-1 text-[var(--text-muted)]">{b.winRate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WeekdayTable({ weekday }: { weekday: WeekdayBucket[] }) {
  return (
    <table className="w-full text-[11px] border-collapse">
      <thead className="sticky top-0 bg-[var(--bg-secondary)]">
        <tr>{['Weekday', 'P&L', 'Trades', 'Win rate'].map((h) => (
          <th key={h} className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
        ))}</tr>
      </thead>
      <tbody>
        {weekday.map((b) => (
          <tr key={b.day} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg-hover)]">
            <td className="px-3 py-1 text-[var(--text-secondary)]">{b.day}</td>
            <td className={`px-3 py-1 font-semibold ${b.pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(b.pnl)}</td>
            <td className="px-3 py-1 text-[var(--text-muted)]">{b.trades}</td>
            <td className="px-3 py-1 text-[var(--text-muted)]">{b.winRate}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Trade detail modal (items 2 & 6) ────────────────────────────────────────
// Shows the full per-leg breakdown (margins, entry/exit, spot at each re-entry,
// ROI on margin, itemised charges) plus the day's intraday P&L curve, fetched on
// demand from /api/backtest/day.
function TradeDetailModal({ trade, config, onClose }: { trade: DayTrade; config: BacktestConfig; onClose: () => void }) {
  const [series, setSeries] = useState<IntradayPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'detail' | 'chart'>('detail');
  const dte = tradeDte(trade);
  const wd = tradeWeekday(trade.date);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null); setSeries(null);
    fetch('/api/backtest/day', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config, date: trade.date }),
    })
      .then((r) => r.json() as Promise<DayDetailResponse>)
      .then((d) => { if (!alive) return; if (!d.ok || !d.series) setError(d.error || 'No intraday data.'); else setSeries(d.series); })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [config, trade.date]);

  const chartData = useMemo(() => (series ?? []).map((p) => ({ hhmm: p.hhmm, total: p.total, spot: p.spot })), [series]);
  const ch = trade.charges;
  const peakRoi = trade.maxMargin > 0 ? (trade.pnl / trade.maxMargin) * 100 : 0;

  const summary: { label: string; val: string; cls?: string }[] = [
    { label: 'Entry spot', val: `${trade.entrySpot}` },
    { label: 'Exit spot', val: `${trade.exitSpot}` },
    { label: 'Weekday / DTE', val: `${wd ?? '—'} · ${dte ?? '—'}` },
    { label: 'Initial margin', val: inr(trade.margin) },
    { label: 'Peak / re-entry margin', val: inr(trade.maxMargin) },
    { label: 'Gross P&L', val: inr(trade.grossPnl), cls: trade.grossPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]' },
    { label: 'Net P&L', val: inr(trade.pnl), cls: trade.pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]' },
    { label: 'ROI on margin', val: `${trade.roiPct.toFixed(2)}%`, cls: trade.roiPct >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]' },
    { label: 'ROI on peak margin', val: `${peakRoi.toFixed(2)}%`, cls: peakRoi >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl w-full max-w-[820px] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-secondary)] z-10">
          <div className="flex items-center gap-3">
            <span className="text-[14px] font-semibold text-[var(--text-primary)]">{trade.date}</span>
            <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ color: reasonColor(trade.exitReason), background: `${reasonColor(trade.exitReason)}1a` }}>{trade.exitReason}</span>
            <div className="flex items-center rounded border border-[var(--border)] overflow-hidden text-[11px]">
              {(['detail', 'chart'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-2.5 py-0.5 capitalize ${view === v ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                >{v === 'detail' ? 'Detail' : 'Chart'}</button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl leading-none">&times;</button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          {/* summary grid */}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-4 gap-y-2">
            {summary.map((s) => (
              <div key={s.label}>
                <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">{s.label}</div>
                <div className={`text-[13px] font-semibold tabular-nums ${s.cls ?? 'text-[var(--text-primary)]'}`}>{s.val}</div>
              </div>
            ))}
          </div>

          {/* full multi-pane chart view (underlying + leg price + P&L) */}
          {view === 'chart' && (
            <>
              {loading && <div className="flex items-center justify-center h-[200px] text-[11px] text-[var(--text-muted)]">Loading chart…</div>}
              {error && <div className="flex items-center justify-center h-[200px] text-[11px] text-[var(--red)]">{error}</div>}
              {!loading && !error && series && series.length > 0 && <TradeChartView trade={trade} series={series} underlying={config.underlying} />}
            </>
          )}

          {/* intraday P&L chart */}
          {view === 'detail' && (
          <>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Intraday P&amp;L</div>
            <div className="h-[220px] border border-[var(--border)] rounded bg-[var(--bg-primary)]/40">
              {loading && <div className="flex items-center justify-center h-full text-[11px] text-[var(--text-muted)]">Loading intraday P&amp;L…</div>}
              {error && <div className="flex items-center justify-center h-full text-[11px] text-[var(--red)]">{error}</div>}
              {!loading && !error && chartData.length > 0 && (
                <SvgChart
                  data={chartData}
                  xKey="hhmm"
                  series={[{ dataKey: 'total', color: 'var(--accent)', strokeWidth: 1.8, fill: 'rgba(99,102,241,0.10)' }]}
                  refLines={[{ axis: 'y', value: 0, color: '#2a2d42' }]}
                  yFormatter={(v) => inr(v)}
                  showLegend={false}
                  tooltipFormatter={(d) => `${(d as any).hhmm}\nP&L: ${inr(d.total)}\nSpot: ${Math.round((d as any).spot)}`}
                />
              )}
            </div>
          </div>

          {/* per-leg / per-episode breakdown */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Legs & re-entries</div>
            <div className="overflow-x-auto border border-[var(--border)] rounded">
              <table className="w-full text-[11px] border-collapse">
                <thead className="bg-[var(--bg-secondary)]">
                  <tr>{['Leg', 'Episode', 'Entry', 'Exit', 'Entry spot', 'Hi/Lo', 'P&L', 'Exit'].map((h) => (
                    <th key={h} className="text-left px-2 py-1.5 text-[var(--text-muted)] font-medium border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                  ))}</tr>
                </thead>
                <tbody>
                  {trade.legs.map((l, i) => (
                    <tr key={i} className="border-b border-[var(--border)]/40">
                      <td className="px-2 py-1 whitespace-nowrap">
                        <span className={l.side === 'SELL' ? 'text-[var(--red)]' : 'text-[var(--green)]'}>
                          {l.side === 'SELL' ? '-' : '+'}{l.optionType === 'CALL' ? 'CE' : 'PE'} {l.strike}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">{(l.seq ?? 0) === 0 ? 'Entry' : `Re-entry ${l.seq}`}</td>
                      <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap">{l.entryTime} @{l.entryPrice.toFixed(1)}</td>
                      <td className="px-2 py-1 text-[var(--text-secondary)] whitespace-nowrap">{l.exitTime} @{l.exitPrice.toFixed(1)}</td>
                      <td className="px-2 py-1 text-[var(--text-muted)] tabular-nums">{Math.round(l.entrySpot)}</td>
                      <td className="px-2 py-1 whitespace-nowrap text-[10px]">
                        <span className="text-[var(--green)]">↑{l.highAfterEntry?.toFixed(1)}</span>
                        <span className="text-[var(--red)]"> ↓{l.lowAfterEntry?.toFixed(1)}</span>
                      </td>
                      <td className={`px-2 py-1 font-semibold tabular-nums ${l.pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(l.pnl)}</td>
                      <td className="px-2 py-1" style={{ color: reasonColor(l.exitReason) }}>{l.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* charges breakdown (item 5) */}
          {ch && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Charges breakdown</div>
              <div className="grid grid-cols-4 gap-x-4 gap-y-1.5 text-[11px]">
                {([
                  ['Brokerage', ch.brokerage], ['STT', ch.stt], ['Exchange', ch.exchange],
                  ['SEBI', ch.sebi], ['Stamp duty', ch.stampDuty], ['GST', ch.gst],
                  ['Slippage', ch.slippage],
                ] as [string, number][]).map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">{k}</div>
                    <div className="text-[var(--text-secondary)] tabular-nums">{inr(v)}</div>
                  </div>
                ))}
                <div>
                  <div className="text-[9px] text-[var(--text-muted)] uppercase tracking-wide">Total costs</div>
                  <div className="text-[var(--red)] font-semibold tabular-nums">{inr(ch.total)}</div>
                </div>
              </div>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Monte Carlo tab ───────────────────────────────────────────────────────────
function MonteCarloTab({ resp }: { resp: BacktestResponse }) {
  const mc = resp.monteCarlo;
  if (!mc || !mc.simulations) {
    return <div className="p-4 text-[var(--text-muted)] text-[12px]">Not enough trades for Monte Carlo (need 5+).</div>;
  }

  const chartData = mc.medianCurve.map((med, i) => ({
    idx: i + 1, median: med, p5: mc.p5Curve[i], p95: mc.p95Curve[i],
  }));

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="text-[12px] text-[var(--text-secondary)]">
        {mc.simulations.toLocaleString()} simulations — shuffled daily P&L order
      </div>
      <div className="h-[220px]">
        <SvgChart
          data={chartData}
          xKey="idx"
          series={[
            { dataKey: 'p95', color: 'rgba(34,197,94,0.3)', strokeWidth: 1, fill: 'rgba(34,197,94,0.06)' },
            { dataKey: 'median', color: 'var(--accent)', strokeWidth: 1.5 },
            { dataKey: 'p5', color: 'rgba(239,68,68,0.3)', strokeWidth: 1, fill: 'rgba(239,68,68,0.06)' },
          ]}
          refLines={[{ axis: 'y', value: 0, color: '#2a2d42' }]}
          xFormatter={(v) => `#${v}`}
          yFormatter={(v) => inr(v)}
          showLegend
          legendLabels={{ p95: '95th pct', median: 'Median', p5: '5th pct' }}
        />
      </div>
      <table className="text-[11px] border-collapse">
        <thead>
          <tr>{['Percentile', 'Final equity', 'Max drawdown'].map((h) => (
            <th key={h} className="text-left px-3 py-1 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {mc.percentiles.map((p) => (
            <tr key={p.pct} className="border-b border-[var(--border)]/40">
              <td className="px-3 py-1 text-[var(--text-secondary)]">{p.pct}th</td>
              <td className={`px-3 py-1 font-semibold ${p.finalEquity >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(p.finalEquity)}</td>
              <td className="px-3 py-1 text-[var(--red)]">{inr(-p.maxDrawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Score breakdown tab ───────────────────────────────────────────────────────
function ScoreTab({ resp }: { resp: BacktestResponse }) {
  const s = resp.score;
  if (!s) return <div className="p-4 text-[var(--text-muted)] text-[12px]">No score available.</div>;
  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <GradeBadge score={s} />
        <span className="text-[12px] text-[var(--text-secondary)]">Weighted composite of 7 factors</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {s.breakdown.map((f) => (
          <div key={f.factor} className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--text-secondary)] w-[120px]">{f.factor}</span>
            <div className="flex-1 h-[10px] bg-[var(--bg-card)] rounded overflow-hidden">
              <div className="h-full rounded" style={{ width: `${Math.max(f.score, 1)}%`, background: f.score >= 60 ? '#22c55e' : f.score >= 30 ? '#eab308' : '#ef4444' }} />
            </div>
            <span className="text-[10px] text-[var(--text-muted)] w-[50px] text-right">{f.score.toFixed(0)}/100 ({(f.weight * 100).toFixed(0)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Parameter sweep tab ───────────────────────────────────────────────────────
const SWEEP_PRESETS: { label: string; path: string; from: number; to: number; step: number }[] = [
  { label: 'SL % (leg 0)', path: 'legs.0.stopLoss.value', from: 10, to: 60, step: 5 },
  { label: 'SL % (leg 1)', path: 'legs.1.stopLoss.value', from: 10, to: 60, step: 5 },
  { label: 'Target % (leg 0)', path: 'legs.0.target.value', from: 10, to: 60, step: 5 },
  { label: 'Slippage %', path: 'slippagePct', from: 0, to: 2, step: 0.25 },
  { label: 'Lot size', path: 'lotSize', from: 25, to: 150, step: 25 },
];
const SWEEP_METRICS: (keyof Metrics)[] = ['totalPnl', 'sharpe', 'profitFactor', 'maxDrawdown', 'sqn', 'recoveryFactor', 'winRate', 'calmar'];

function heatColor(v: number, min: number, max: number): string {
  if (max === min) return 'rgba(99,102,241,0.4)';
  const t = (v - min) / (max - min); // 0..1
  // red → yellow → green
  const r = t < 0.5 ? 239 : Math.round(239 - (t - 0.5) * 2 * (239 - 34));
  const g = t < 0.5 ? Math.round(68 + t * 2 * (197 - 68)) : 197;
  const b = t < 0.5 ? Math.round(68 - t * 2 * 34) : Math.round(94 - (t - 0.5) * 2 * 0);
  return `rgb(${r},${g},${b})`;
}

function SweepTab({ config }: { config: BacktestConfig }) {
  const [preset, setPreset] = useState(0);
  const [preset2, setPreset2] = useState(-1); // -1 = none (1D)
  const [metric, setMetric] = useState<keyof Metrics>('totalPnl');
  const [result, setResult] = useState<SweepResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSweep = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    const p = SWEEP_PRESETS[preset];
    const req: SweepRequest = {
      base: config,
      param1: { path: p.path, from: p.from, to: p.to, step: p.step, label: p.label },
      metric,
    };
    if (preset2 >= 0 && preset2 !== preset) {
      const p2 = SWEEP_PRESETS[preset2];
      req.param2 = { path: p2.path, from: p2.from, to: p2.to, step: p2.step, label: p2.label };
    }
    try {
      const r = await fetch('/api/backtest/sweep', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      const data = await r.json() as SweepResponse;
      if (!r.ok || !data.ok) { setError((data as any).error || 'Sweep failed'); return; }
      setResult(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [config, preset, preset2, metric]);

  const is2D = result?.cells.some((c) => c.v2 !== undefined && c.v2 !== null);

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Parameter X</span>
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))} className={inputCls + ' w-[160px]'}>
            {SWEEP_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Parameter Y (heatmap)</span>
          <select value={preset2} onChange={(e) => setPreset2(Number(e.target.value))} className={inputCls + ' w-[160px]'}>
            <option value={-1}>None (1D)</option>
            {SWEEP_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Optimise for</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as keyof Metrics)} className={inputCls + ' w-[130px]'}>
            {SWEEP_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button onClick={runSweep} disabled={loading}
          className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[11px] font-semibold disabled:opacity-50">
          {loading ? 'Running…' : 'Run sweep'}
        </button>
      </div>

      {error && <div className="text-[var(--red)] text-[11px]">{error}</div>}

      {result && (
        <>
          <div className="text-[11px] text-[var(--text-secondary)]">
            Best: <span className="font-semibold text-[var(--accent)]">
              {SWEEP_PRESETS[preset].label} = {result.bestV1}{is2D && result.bestV2 !== undefined ? `, ${SWEEP_PRESETS[preset2].label} = ${result.bestV2}` : ''}
            </span>
            {' → '}{metric} = <span className="font-semibold text-[var(--green)]">{result.bestMetric}</span>
          </div>

          {is2D ? <SweepHeatmap result={result} px={SWEEP_PRESETS[preset].label} py={SWEEP_PRESETS[preset2].label} />
            : (
              <>
                <div className="h-[200px]">
                  <SvgChart
                    data={result.cells.map((c) => ({ x: c.v1, y: c.metric }))}
                    xKey="x"
                    series={[{ dataKey: 'y', color: 'var(--accent)', strokeWidth: 2 }]}
                    xFormatter={(v) => String(v)}
                    yFormatter={(v) => typeof v === 'number' && Math.abs(v) >= 1000 ? inr(v) : String(v)}
                    showLegend={false}
                  />
                </div>
                <table className="text-[11px] border-collapse">
                  <thead>
                    <tr>{['Value', metric, 'Trades'].map((h) => (
                      <th key={h} className="text-left px-3 py-1 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {result.cells.map((c, i) => (
                      <tr key={i} className={`border-b border-[var(--border)]/40 ${c.v1 === result.bestV1 ? 'bg-[var(--accent)]/10' : ''}`}>
                        <td className="px-3 py-1 text-[var(--text-secondary)]">{c.v1}</td>
                        <td className={`px-3 py-1 font-semibold ${c.metric >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {typeof c.metric === 'number' && Math.abs(c.metric) >= 100 ? inr(c.metric) : c.metric}
                        </td>
                        <td className="px-3 py-1 text-[var(--text-muted)]">{c.trades}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
        </>
      )}
    </div>
  );
}

function SweepHeatmap({ result, px, py }: { result: SweepResponse; px: string; py: string }) {
  const xs = [...new Set(result.cells.map((c) => c.v1))].sort((a, b) => a - b);
  const ys = [...new Set(result.cells.map((c) => c.v2!))].sort((a, b) => a - b);
  const lookup = new Map(result.cells.map((c) => [`${c.v1}|${c.v2}`, c.metric]));
  const vals = result.cells.map((c) => c.metric);
  const min = Math.min(...vals), max = Math.max(...vals);
  const fmt = (v: number) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(Math.round(v * 100) / 100);

  return (
    <div className="overflow-auto">
      <div className="text-[10px] text-[var(--text-muted)] mb-1">Rows: {py} · Cols: {px} (best highlighted)</div>
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="px-1.5 py-1 text-[var(--text-muted)] sticky left-0 bg-[var(--bg-secondary)]">{py}\{px}</th>
            {xs.map((x) => <th key={x} className="px-1.5 py-1 text-[var(--text-muted)] font-medium">{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {ys.map((y) => (
            <tr key={y}>
              <td className="px-1.5 py-1 text-[var(--text-secondary)] font-medium sticky left-0 bg-[var(--bg-secondary)]">{y}</td>
              {xs.map((x) => {
                const v = lookup.get(`${x}|${y}`);
                const best = x === result.bestV1 && y === result.bestV2;
                return (
                  <td key={x} className={`px-1.5 py-1 text-center ${best ? 'ring-2 ring-white' : ''}`}
                    style={{ background: v !== undefined ? heatColor(v, min, max) : 'transparent', color: '#0a0a0a' }}>
                    {v !== undefined ? fmt(v) : '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Walk-forward tab ──────────────────────────────────────────────────────────
function WalkForwardTab({ config }: { config: BacktestConfig }) {
  const [preset, setPreset] = useState(0);
  const [metric, setMetric] = useState<keyof Metrics>('totalPnl');
  const [windows, setWindows] = useState(4);
  const [oosPct, setOosPct] = useState(30);
  const [result, setResult] = useState<WalkForwardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setLoading(true); setError(null); setResult(null);
    const p = SWEEP_PRESETS[preset];
    const req: WalkForwardRequest = {
      base: config,
      param: { path: p.path, from: p.from, to: p.to, step: p.step, label: p.label },
      metric, windows, oosPct,
    };
    try {
      const r = await fetch('/api/backtest/walkforward', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      });
      const data = await r.json() as WalkForwardResponse;
      if (!r.ok || !data.ok) { setError((data as any).error || 'Walk-forward failed'); return; }
      setResult(data);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [config, preset, metric, windows, oosPct]);

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="text-[10px] text-[var(--text-muted)]">
        Optimises the parameter on each in-sample window, then measures the chosen value on the
        following out-of-sample window. Stitched OOS performance reveals over-fitting.
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Parameter</span>
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))} className={inputCls + ' w-[150px]'}>
            {SWEEP_PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Optimise for</span>
          <select value={metric} onChange={(e) => setMetric(e.target.value as keyof Metrics)} className={inputCls + ' w-[120px]'}>
            {SWEEP_METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 w-[70px]">
          <span className={lblCls}>Windows</span>
          <input type="number" min={2} max={12} value={windows} onChange={(e) => setWindows(Number(e.target.value))} className={inputCls} />
        </label>
        <label className="flex flex-col gap-0.5 w-[70px]">
          <span className={lblCls}>OOS %</span>
          <input type="number" min={5} max={80} value={oosPct} onChange={(e) => setOosPct(Number(e.target.value))} className={inputCls} />
        </label>
        <button onClick={run} disabled={loading}
          className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[11px] font-semibold disabled:opacity-50">
          {loading ? 'Running…' : 'Run'}
        </button>
      </div>

      {error && <div className="text-[var(--red)] text-[11px]">{error}</div>}

      {result && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div><div className={lblCls}>OOS total P&L</div><div className={`text-[14px] font-semibold ${result.oosTotalPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(result.oosTotalPnl)}</div></div>
            <div><div className={lblCls}>OOS window win %</div><div className="text-[14px] font-semibold text-[var(--text-primary)]">{result.oosWinRate}%</div></div>
            <div><div className={lblCls}>Efficiency (OOS/IS)</div><div className={`text-[14px] font-semibold ${result.efficiency >= 0.5 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{result.efficiency}</div></div>
          </div>
          {result.equityCurve.length > 0 && (
            <div className="h-[180px]">
              <SvgChart
                data={result.equityCurve}
                xKey="date"
                series={[{ dataKey: 'cumPnl', color: 'var(--accent)', strokeWidth: 1.5 }]}
                refLines={[{ axis: 'y', value: 0, color: '#2a2d42' }]}
                xFormatter={(v) => String(v).slice(2)}
                yFormatter={(v) => inr(v)}
                showLegend={false}
              />
            </div>
          )}
          <table className="text-[11px] border-collapse">
            <thead>
              <tr>{['#', 'In-sample', 'Best param', 'IS metric', 'OOS dates', 'OOS P&L', 'OOS trades'].map((h) => (
                <th key={h} className="text-left px-2 py-1 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {result.windows.map((w) => (
                <tr key={w.index} className="border-b border-[var(--border)]/40">
                  <td className="px-2 py-1 text-[var(--text-muted)]">{w.index}</td>
                  <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">{w.isFrom.slice(2)}→{w.isTo.slice(2)}</td>
                  <td className="px-2 py-1 text-[var(--accent)] font-semibold">{w.bestParam}</td>
                  <td className="px-2 py-1 text-[var(--text-secondary)]">{w.isMetric}</td>
                  <td className="px-2 py-1 text-[var(--text-muted)] whitespace-nowrap">{w.oosFrom.slice(2)}→{w.oosTo.slice(2)}</td>
                  <td className={`px-2 py-1 font-semibold ${w.oosPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{inr(w.oosPnl)}</td>
                  <td className="px-2 py-1 text-[var(--text-muted)]">{w.oosTrades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
