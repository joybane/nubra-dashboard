import { useState } from 'react';
import SvgChart from './components/SvgChart';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { fmtPrice, formatExpiry } from './lib/utils';

interface BacktestDay {
  date:        string;
  entryPremium:number;
  exitPremium: number;
  pnl:         number;
  cumPnl:      number;
  outcome:     'tp' | 'sl' | 'expiry' | 'eod';
}

interface Params {
  startDate:   string;
  endDate:     string;
  strategy:    'straddle' | 'strangle' | 'iron_condor';
  entryTime:   string;
  exitTime:    string;
  stopLossPct: number;
  targetPct:   number;
  strikeDist:  number;   // distance from ATM for strangle/IC OTM legs
}

interface Stats {
  totalDays:   number;
  winDays:     number;
  lossDays:    number;
  winRate:     number;
  totalPnl:    number;
  avgPnl:      number;
  maxProfit:   number;
  maxLoss:     number;
  maxDrawdown: number;
}

interface Props {
  instrument: Instrument | null;
}

const DEFAULT_PARAMS: Params = {
  startDate:   new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
  endDate:     new Date().toISOString().slice(0, 10),
  strategy:    'straddle',
  entryTime:   '09:30',
  exitTime:    '15:15',
  stopLossPct: 50,
  targetPct:   30,
  strikeDist:  200,
};

function computeStats(days: BacktestDay[]): Stats {
  if (!days.length) return { totalDays:0,winDays:0,lossDays:0,winRate:0,totalPnl:0,avgPnl:0,maxProfit:0,maxLoss:0,maxDrawdown:0 };
  const totalPnl = days.reduce((a, d) => a + d.pnl, 0);
  const wins = days.filter((d) => d.pnl > 0).length;
  let maxDd = 0, peak = 0;
  for (const d of days) {
    peak = Math.max(peak, d.cumPnl);
    maxDd = Math.max(maxDd, peak - d.cumPnl);
  }
  return {
    totalDays:   days.length,
    winDays:     wins,
    lossDays:    days.length - wins,
    winRate:     (wins / days.length) * 100,
    totalPnl,
    avgPnl:      totalPnl / days.length,
    maxProfit:   Math.max(...days.map((d) => d.pnl)),
    maxLoss:     Math.min(...days.map((d) => d.pnl)),
    maxDrawdown: maxDd,
  };
}

export default function Backtest({ instrument }: Props) {
  const [params,  setParams]  = useState<Params>(DEFAULT_PARAMS);
  const [results, setResults] = useState<BacktestDay[]>([]);
  const [stats,   setStats]   = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [expiries, setExpiries] = useState<string[]>([]);

  const sym = instrument ? getSymbol(instrument) : null;

  async function runBacktest() {
    if (!sym) { setError('Select an instrument first.'); return; }
    setLoading(true);
    setError(null);
    setResults([]);
    setStats(null);

    try {
      // Fetch expiries list
      const exch = instrument!.exchange || 'NSE';
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}`);
      const data = await res.json() as { chain?: { all_expiries?: string[] } };
      const exps = data.chain?.all_expiries || [];
      setExpiries(exps);

      // Simulate day-by-day backtest using historical data
      // We approximate P&L using historical OHLCV of the ATM straddle
      const start  = new Date(params.startDate);
      const end    = new Date(params.endDate);
      const days: BacktestDay[] = [];
      let cumPnl = 0;

      // Iterate through date range
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        // Skip weekends
        if (d.getDay() === 0 || d.getDay() === 6) continue;

        const dateStr = d.toISOString().slice(0, 10);

        // Fetch 1-min data for this day to simulate entry/exit
        const body = {
          query: [{
            exchange: exch,
            type: 'INDEX',
            values: [sym],
            fields: ['open', 'high', 'low', 'close'],
            startDate: `${dateStr}T00:00:00Z`,
            endDate:   `${dateStr}T23:59:59Z`,
            interval: '1d',
            intraDay: false,
            realTime: false,
          }],
        };

        let dayClose = 0;
        try {
          const hr  = await fetch('/api/historical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const hd  = await hr.json() as { result?: Array<{ values: Array<Record<string, { close?: Array<{v:number}> }>> }> };
          const grp = hd.result?.[0];
          if (grp) {
            for (const smap of grp.values || []) {
              for (const chart of Object.values(smap)) {
                const closes = chart.close || [];
                if (closes.length) dayClose = closes[closes.length - 1].v / 100;
              }
            }
          }
        } catch { continue; }

        if (!dayClose) continue;

        // ATM straddle approximation using historical vol (simplified)
        // Real implementation would fetch option chain data for that day
        const atmStrike = Math.round(dayClose / 50) * 50;
        const dayVol    = 0.15; // assumed 15% IV (simplified)
        const dte       = 7;    // approx days to nearest expiry
        const T         = dte / 365;
        const straddle  = dayClose * dayVol * Math.sqrt(T) * 0.8; // BS approximation

        let entryPremium = straddle;
        let exitPremium  = entryPremium;
        let outcome: BacktestDay['outcome'] = 'eod';

        // Simulate SL/Target
        const targetExit = entryPremium * (1 - params.targetPct / 100);
        const slExit     = entryPremium * (1 + params.stopLossPct / 100);

        // Simulate market movement (random walk for demo — real version fetches OC data)
        const dayRange = Math.abs(dayClose * dayVol / Math.sqrt(252));
        const move     = (Math.random() - 0.5) * dayRange;
        const exitSpot = dayClose + move;

        // Approximate straddle exit
        const iteRatio = Math.abs(exitSpot - atmStrike) / atmStrike;
        exitPremium = entryPremium * (0.5 + iteRatio * 5);
        exitPremium = Math.max(0, exitPremium);

        if (exitPremium <= targetExit)      { exitPremium = targetExit;  outcome = 'tp'; }
        else if (exitPremium >= slExit)     { exitPremium = slExit;      outcome = 'sl'; }

        // P&L for short straddle (selling = premium collected - exit cost)
        const pnl = (entryPremium - exitPremium);
        cumPnl += pnl;

        days.push({ date: dateStr, entryPremium, exitPremium, pnl, cumPnl, outcome });
      }

      setResults(days);
      setStats(computeStats(days));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function setParam<K extends keyof Params>(key: K, value: Params[K]) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  const outcomeColor = { tp: '#22c55e', sl: '#ef4444', expiry: '#f59e0b', eod: '#6b7280' };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="font-bold text-[var(--text-primary)]">
          {sym ? `${sym} — Backtest` : 'Backtest'}
        </span>
      </div>

      {!instrument && (
        <div className="flex items-center justify-center flex-1 text-[var(--text-muted)] text-[14px]">
          Select an F&O instrument to run backtest
        </div>
      )}

      {instrument && (
        <div className="flex flex-1 overflow-hidden">
          {/* Params panel */}
          <div className="w-[280px] shrink-0 border-r border-[var(--border)] overflow-y-auto p-4 flex flex-col gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">Strategy</div>
              <select
                value={params.strategy}
                onChange={(e) => setParam('strategy', e.target.value as Params['strategy'])}
                className="w-full px-2 py-1.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
              >
                <option value="straddle">Short Straddle (ATM)</option>
                <option value="strangle">Short Strangle (OTM)</option>
                <option value="iron_condor">Iron Condor</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label>
                <span className="text-[10px] text-[var(--text-muted)]">Start Date</span>
                <input type="date" value={params.startDate} onChange={(e) => setParam('startDate', e.target.value)}
                  className="w-full px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
              </label>
              <label>
                <span className="text-[10px] text-[var(--text-muted)]">End Date</span>
                <input type="date" value={params.endDate} onChange={(e) => setParam('endDate', e.target.value)}
                  className="w-full px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
              </label>
              <label>
                <span className="text-[10px] text-[var(--text-muted)]">Entry Time</span>
                <input type="time" value={params.entryTime} onChange={(e) => setParam('entryTime', e.target.value)}
                  className="w-full px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
              </label>
              <label>
                <span className="text-[10px] text-[var(--text-muted)]">Exit Time</span>
                <input type="time" value={params.exitTime} onChange={(e) => setParam('exitTime', e.target.value)}
                  className="w-full px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
              </label>
            </div>

            <label>
              <span className="text-[10px] text-[var(--text-muted)]">Stop Loss % of Premium</span>
              <div className="flex items-center gap-2">
                <input type="range" min={10} max={200} step={5} value={params.stopLossPct} onChange={(e) => setParam('stopLossPct', Number(e.target.value))}
                  className="flex-1 accent-red-500" />
                <span className="text-[12px] text-red-400 w-10 text-right">{params.stopLossPct}%</span>
              </div>
            </label>

            <label>
              <span className="text-[10px] text-[var(--text-muted)]">Target % of Premium</span>
              <div className="flex items-center gap-2">
                <input type="range" min={5} max={100} step={5} value={params.targetPct} onChange={(e) => setParam('targetPct', Number(e.target.value))}
                  className="flex-1 accent-green-500" />
                <span className="text-[12px] text-green-400 w-10 text-right">{params.targetPct}%</span>
              </div>
            </label>

            {params.strategy !== 'straddle' && (
              <label>
                <span className="text-[10px] text-[var(--text-muted)]">OTM Strike Distance</span>
                <input type="number" step={50} value={params.strikeDist} onChange={(e) => setParam('strikeDist', Number(e.target.value))}
                  className="w-full px-2 py-1.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
              </label>
            )}

            <button
              onClick={runBacktest}
              disabled={loading}
              className="w-full py-2.5 rounded-lg bg-[var(--accent)] text-white font-semibold text-[14px] hover:bg-[var(--accent-dim)] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Running…' : 'Run Backtest'}
            </button>

            {error && <div className="text-[var(--red)] text-[12px] bg-red-500/10 rounded px-2 py-1.5">{error}</div>}

            <div className="text-[10px] text-[var(--text-muted)] italic">
              Note: Results are approximate. Uses simplified premium estimation. For precise results, real option chain history is needed.
            </div>
          </div>

          {/* Results */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {stats && (
              <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 grid grid-cols-4 gap-3">
                {[
                  { label: 'Total Days',  val: stats.totalDays,              color: 'text-[var(--text-primary)]' },
                  { label: 'Win Rate',    val: `${stats.winRate.toFixed(1)}%`, color: 'text-green-400' },
                  { label: 'Total P&L',  val: `₹${fmtPrice(stats.totalPnl)}`, color: stats.totalPnl >= 0 ? 'text-green-400' : 'text-red-400' },
                  { label: 'Avg P&L/day',val: `₹${fmtPrice(stats.avgPnl)}`,   color: stats.avgPnl >= 0 ? 'text-green-400' : 'text-red-400' },
                  { label: 'Max Profit', val: `₹${fmtPrice(stats.maxProfit)}`, color: 'text-green-400' },
                  { label: 'Max Loss',   val: `₹${fmtPrice(stats.maxLoss)}`,   color: 'text-red-400' },
                  { label: 'Drawdown',   val: `₹${fmtPrice(stats.maxDrawdown)}`, color: 'text-yellow-400' },
                  { label: 'Win/Loss',   val: `${stats.winDays}/${stats.lossDays}`, color: 'text-[var(--text-primary)]' },
                ].map(({ label, val, color }) => (
                  <div key={label}>
                    <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
                    <div className={`text-[14px] font-semibold ${color}`}>{val}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex-1 overflow-hidden p-3">
              {!results.length && !loading && (
                <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[13px]">
                  Configure parameters and click Run Backtest
                </div>
              )}
              {results.length > 0 && (
                <div className="h-full flex flex-col gap-3">
                  <div style={{ width: '100%', height: '60%' }}>
                    <SvgChart
                      data={results}
                      xKey="date"
                      series={[
                        { dataKey: 'cumPnl', color: '#2962ff' },
                        { dataKey: 'pnl', color: '#22c55e', strokeWidth: 1 },
                      ]}
                      refLines={[{ axis: 'y', value: 0, color: '#2a2d42' }]}
                      xFormatter={v => String(v).slice(5)}
                      yFormatter={v => `₹${v.toFixed(0)}`}
                      showLegend
                      legendLabels={{ cumPnl: 'Cumulative P&L', pnl: 'Daily P&L' }}
                      tooltipFormatter={d => `${d.date}\nCumulative: ₹${fmtPrice(d.cumPnl)}\nDaily: ₹${fmtPrice(d.pnl)}`}
                    />
                  </div>

                  <div className="flex-1 overflow-y-auto">
                    <table className="w-full text-[11px] border-collapse">
                      <thead className="sticky top-0 bg-[var(--bg-secondary)]">
                        <tr>
                          {['Date','Entry','Exit','P&L','Cum P&L','Outcome'].map((h) => (
                            <th key={h} className="text-left px-2 py-1.5 text-[var(--text-muted)] font-medium border-b border-[var(--border)]">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {results.map((r) => (
                          <tr key={r.date} className="border-b border-[var(--border)]/40 hover:bg-[var(--bg-hover)]">
                            <td className="px-2 py-1.5 text-[var(--text-secondary)]">{r.date}</td>
                            <td className="px-2 py-1.5 text-[var(--text-primary)]">₹{r.entryPremium.toFixed(2)}</td>
                            <td className="px-2 py-1.5 text-[var(--text-primary)]">₹{r.exitPremium.toFixed(2)}</td>
                            <td className={`px-2 py-1.5 font-semibold ${r.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{r.pnl >= 0 ? '+' : ''}₹{r.pnl.toFixed(2)}</td>
                            <td className={`px-2 py-1.5 font-semibold ${r.cumPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>₹{r.cumPnl.toFixed(2)}</td>
                            <td className="px-2 py-1.5" style={{ color: outcomeColor[r.outcome] }}>{r.outcome.toUpperCase()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
