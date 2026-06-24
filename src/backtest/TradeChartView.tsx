import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, LineSeries, CandlestickSeries, CrosshairMode,
  type IChartApi, type ISeriesApi, type Time,
} from 'lightweight-charts';
import type { DayTrade, IntradayPoint, Underlying } from './types';
import { blackScholes, impliedVolatility } from '../lib/GexService';
import { IST_OFFSET } from '../lib/utils';

// TradingView-style multi-pane view for a single backtested day, mirroring the
// live Positions P&L tracker (StrategyAnalysisView): underlying candles + each
// leg's premium, a P&L pane (driven by the authoritative backtest series), and a
// Greeks-over-time pane. Candles come from /api/historical (these are past dates
// so real OHLC exists); the historical Greeks feed is empty for these dates, so
// Greeks are computed per-minute via Black-Scholes (same fallback the live view
// uses), implied vol back-solved from each leg's traded premium.

const LEG_COLORS = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const GREEK_COLORS: Record<string, string> = { delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' };
// month → zanskar symbol code (10/11/12 → O/N/D), reverse of the parser in StrategyAnalysisView
const MCODE: Record<number, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: 'O', 11: 'N', 12: 'D' };
const RISK_FREE = 0.07;
const YEAR_SECS = 365 * 86400;

interface Bar { time: number; open: number; high: number; low: number; close: number }
interface LegMeta { legId: string; label: string; color: string; symbol: string; strike: number; opt: 'CE' | 'PE'; expirySec: number; sign: number; }
interface Frame { spot: number; legPrice: Record<string, number>; total: number; legPnl: Record<string, number>; greeks: { delta: number; gamma: number; theta: number; vega: number }; }

// date "YYYY-MM-DD" + hhmm → IST-wall-clock-as-UTC seconds (matches utils.toChartTime intraday output)
function toUnix(date: string, hhmm: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Math.floor(Date.UTC(y, (mo || 1) - 1, d, h, mi) / 1000);
}

function zanskar(ul: string, expiry: string, strike: number, opt: 'CE' | 'PE'): string {
  const [y, m, d] = expiry.split('-').map(Number);
  return `${ul}${String(y).slice(2)}${MCODE[m] ?? m}${String(d).padStart(2, '0')}${strike}${opt}`;
}

function fmtInr(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
}

function chartOpts() {
  return {
    layout: { background: { color: '#0d0f11' }, textColor: '#c9d1d9', fontSize: 11, fontFamily: "'Inter', 'Segoe UI', sans-serif" },
    grid: { vertLines: { color: '#1a1d21' }, horzLines: { color: '#1a1d21' } },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#4b5563', width: 1 as const, style: 0 as const, labelBackgroundColor: '#22262b' },
      horzLine: { color: '#4b5563', width: 1 as const, style: 0 as const, labelBackgroundColor: '#2962ff' },
    },
    rightPriceScale: { borderColor: '#2a2d32', minimumWidth: 64 },
    timeScale: { borderColor: '#2a2d32', timeVisible: true, secondsVisible: false },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true },
  };
}

async function fetchHist(values: string[], type: 'INDEX' | 'OPT', date: string): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  if (values.length === 0) return out;
  const [y, mo, d] = date.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, mo - 1, d, 3, 45, 0)).toISOString();
  const endDate = new Date(Date.UTC(y, mo - 1, d, 10, 0, 0)).toISOString();
  try {
    const res = await fetch('/api/historical', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: [{ exchange: 'NSE', type, values, fields: ['open', 'high', 'low', 'close'], startDate, endDate, interval: '1m', intraDay: false, realTime: false }] }),
    });
    if (!res.ok) return out;
    const json = await res.json() as { result?: Array<{ values: Array<Record<string, { open?: Array<{ ts: number; v: number }>; high?: Array<{ v: number }>; low?: Array<{ v: number }>; close?: Array<{ v: number }> }>> }> };
    for (const group of json.result || []) {
      for (const symMap of group.values || []) {
        for (const [sym, ch] of Object.entries(symMap)) {
          const o = ch.open || [], h = ch.high || [], l = ch.low || [], c = ch.close || [];
          const n = Math.min(o.length, h.length, l.length, c.length);
          const bars: Bar[] = [];
          for (let i = 0; i < n; i++) {
            const t = Math.floor(Number(o[i].ts) / 1e9) + IST_OFFSET;
            bars.push({ time: t, open: o[i].v / 100, high: h[i].v / 100, low: l[i].v / 100, close: c[i].v / 100 });
          }
          if (bars.length) out.set(sym, bars);
        }
      }
    }
  } catch { /* network/parse → empty */ }
  return out;
}

export default function TradeChartView({ trade, series, underlying }: { trade: DayTrade; series: IntradayPoint[]; underlying: Underlying }) {
  const priceRef = useRef<HTMLDivElement>(null);
  const pnlRef = useRef<HTMLDivElement>(null);
  const greeksRef = useRef<HTMLDivElement>(null);

  // distinct legs (first episode per legId)
  const legs: LegMeta[] = useMemo(() => {
    const out: LegMeta[] = [];
    const seen = new Set<string>();
    trade.legs.forEach((l) => {
      if (seen.has(l.legId)) return;
      seen.add(l.legId);
      const opt: 'CE' | 'PE' = l.optionType === 'CALL' ? 'CE' : 'PE';
      out.push({
        legId: l.legId,
        label: `${l.side === 'SELL' ? '-' : '+'}${opt} ${l.strike}`,
        color: LEG_COLORS[out.length % LEG_COLORS.length],
        symbol: zanskar(underlying, l.expiry, l.strike, opt),
        strike: l.strike, opt, expirySec: toUnix(l.expiry, '15:30'),
        sign: l.side === 'SELL' ? -1 : 1,
      });
    });
    return out;
  }, [trade, underlying]);

  const [bars, setBars] = useState<{ under: Bar[]; legBars: Map<string, Bar[]> } | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'nodata'>('loading');
  const [hover, setHover] = useState<{ time: string; f: Frame } | null>(null);

  // ── fetch candles ──
  useEffect(() => {
    let alive = true;
    setStatus('loading'); setBars(null);
    (async () => {
      const [underMap, legMap] = await Promise.all([
        fetchHist([underlying], 'INDEX', trade.date),
        fetchHist(legs.map((l) => l.symbol), 'OPT', trade.date),
      ]);
      if (!alive) return;
      const under = underMap.get(underlying) || [];
      setBars({ under, legBars: legMap });
      setStatus(under.length ? 'ready' : 'nodata');
    })();
    return () => { alive = false; };
  }, [trade.date, underlying, legs]);

  // ── build the per-minute frame index (used for crosshair legend) ──
  const frames = useMemo(() => {
    const m = new Map<number, Frame>();
    const ensure = (t: number) => { let f = m.get(t); if (!f) { f = { spot: NaN, legPrice: {}, total: NaN, legPnl: {}, greeks: { delta: 0, gamma: 0, theta: 0, vega: 0 } }; m.set(t, f); } return f; };
    if (bars) for (const b of bars.under) ensure(b.time).spot = b.close;
    for (const p of series) {
      const t = toUnix(trade.date, p.hhmm);
      const f = ensure(t);
      f.total = p.total;
      for (const lp of p.legs) f.legPnl[lp.legId] = lp.pnl;
    }
    // leg price + greeks from option candles
    if (bars) for (const lm of legs) {
      const lb = bars.legBars.get(lm.symbol);
      if (!lb) continue;
      for (const b of lb) {
        const f = ensure(b.time);
        f.legPrice[lm.legId] = b.close;
        const spot = f.spot;
        if (Number.isFinite(spot) && spot > 0 && b.close > 0) {
          const T = Math.max((lm.expirySec - b.time) / YEAR_SECS, 1e-6);
          let iv = impliedVolatility(b.close, spot, lm.strike, T, RISK_FREE, lm.opt);
          if (!Number.isFinite(iv) || iv <= 0) iv = 0.2;
          const g = blackScholes(spot, lm.strike, T, RISK_FREE, iv, lm.opt);
          f.greeks.delta += lm.sign * g.delta;
          f.greeks.gamma += lm.sign * g.gamma;
          f.greeks.theta += lm.sign * g.theta;
          f.greeks.vega += lm.sign * g.vega;
        }
      }
    }
    return m;
  }, [bars, series, legs, trade.date]);

  // ── build charts ──
  useEffect(() => {
    if (!priceRef.current || !pnlRef.current || !greeksRef.current || !bars || bars.under.length === 0) return;

    const pc = createChart(priceRef.current, chartOpts());
    const nc = createChart(pnlRef.current, chartOpts());
    const gc = createChart(greeksRef.current, chartOpts());

    // price pane — candles (right) + each leg premium on its own overlay scale
    const candle = pc.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444', title: underlying,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    candle.setData(bars.under.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));

    // The P&L / Greeks series only span entry→exit (~09:35–15:15) while the candle
    // pane spans the full session (09:15–15:30). Pad the shorter series with
    // whitespace points at the candle endpoints so EVERY pane shares the exact same
    // time domain — then fitContent on each pane shows all data, aligned, and the
    // P&L lines can never be pushed outside a forced visible range (the old bug:
    // value labels showed at the right edge but the lines were off-screen).
    const tFirst = bars.under[0].time as Time;
    const tLast  = bars.under[bars.under.length - 1].time as Time;
    const pad = <T extends { time: Time }>(data: T[]): (T | { time: Time })[] => {
      const out: (T | { time: Time })[] = [];
      if (!data.length || (data[0].time as number) > (tFirst as number)) out.push({ time: tFirst });
      out.push(...data);
      if (!data.length || (data[data.length - 1].time as number) < (tLast as number)) out.push({ time: tLast });
      return out;
    };

    for (const lm of legs) {
      const lb = bars.legBars.get(lm.symbol);
      if (!lb) continue;
      const s = pc.addSeries(LineSeries, {
        color: lm.color, lineWidth: 1, priceScaleId: `lp-${lm.legId}`,
        title: lm.label, lastValueVisible: true, priceLineVisible: false,
        priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
      });
      s.setData(lb.map((b) => ({ time: b.time as Time, value: b.close })));
    }

    // P&L pane — per-leg + total (authoritative backtest series)
    for (const lm of legs) {
      const s = nc.addSeries(LineSeries, { color: lm.color, lineWidth: 1, title: lm.label, lastValueVisible: true, priceLineVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
      const legData = series.map((p) => { const lp = p.legs.find((x) => x.legId === lm.legId); return { time: toUnix(trade.date, p.hhmm) as Time, value: lp ? lp.pnl : NaN }; }).filter((d) => Number.isFinite(d.value as number));
      s.setData(pad(legData));
    }
    const totalS = nc.addSeries(LineSeries, { color: '#ffffff', lineWidth: 3, title: 'Total P&L', lastValueVisible: true, priceLineVisible: true, priceFormat: { type: 'price', precision: 0, minMove: 1 } });
    const totalData = series.map((p) => ({ time: toUnix(trade.date, p.hhmm) as Time, value: p.total }));
    totalS.setData(pad(totalData));
    totalS.createPriceLine({ price: 0, color: '#2a2d42', lineWidth: 1, lineStyle: 0, axisLabelVisible: false, title: '' });

    // Greeks pane — net delta/gamma/theta/vega, each on its own overlay scale
    const greekArr: Array<[number, number, number, number, number]> = []; // [time, d, g, t, v]
    for (const [t, f] of frames) if (Number.isFinite(f.spot)) greekArr.push([t, f.greeks.delta, f.greeks.gamma, f.greeks.theta, f.greeks.vega]);
    greekArr.sort((a, b) => a[0] - b[0]);
    (['delta', 'gamma', 'theta', 'vega'] as const).forEach((gk, idx) => {
      const s = gc.addSeries(LineSeries, { color: GREEK_COLORS[gk], lineWidth: 1, priceScaleId: `gk-${gk}`, title: gk, lastValueVisible: true, priceLineVisible: false });
      s.setData(pad(greekArr.map((r) => ({ time: r[0] as Time, value: r[idx + 1] }))));
    });

    // size the charts to their containers up-front (don't wait for the first ResizeObserver tick)
    if (priceRef.current) pc.resize(priceRef.current.clientWidth, priceRef.current.clientHeight);
    if (pnlRef.current) nc.resize(pnlRef.current.clientWidth, pnlRef.current.clientHeight);
    if (greeksRef.current) gc.resize(greeksRef.current.clientWidth, greeksRef.current.clientHeight);

    // Align every pane to the SAME absolute time window, then keep them in sync by
    // TIME — NOT logical index. The panes have different point counts (price has
    // 9:15–15:30 candles, the P&L series only spans entry→exit ~9:35–15:15), so an
    // index-based sync pushes the shorter P&L series out of the viewport, leaving
    // just the right-edge value labels with no lines. Time is shared across all
    // panes, so a time-range sync shows each pane all of its own data and stays
    // aligned.
    const charts = [pc, nc, gc];
    let syncing = false;
    requestAnimationFrame(() => {
      syncing = true; // suppress the cross-pane sync so it can't re-impose a range mid-set
      // Every pane shares the same padded [tFirst,tLast] domain, so fitContent
      // yields an identical, fully-populated range on each — no line can land
      // outside the viewport.
      for (const c of charts) { try { c.timeScale().fitContent(); } catch { /* noop */ } }
      syncing = false;
    });

    // cross-pane sync on the shared TIME axis
    const unsubs: Array<() => void> = [];
    for (const src of charts) {
      const h = (range: any) => {
        if (syncing || !range) return;
        syncing = true;
        for (const dst of charts) if (dst !== src) {
          try { dst.timeScale().setVisibleRange(range); } catch { /* noop */ }
        }
        syncing = false;
      };
      src.timeScale().subscribeVisibleTimeRangeChange(h);
      unsubs.push(() => { try { src.timeScale().unsubscribeVisibleTimeRangeChange(h); } catch { /* noop */ } });
    }

    // shared crosshair → legend
    const onMove = (param: any) => {
      if (param.time == null) { setHover(null); return; }
      const t = param.time as number;
      const f = frames.get(t);
      if (!f) { setHover(null); return; }
      const d = new Date(t * 1000);
      const hh = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      setHover({ time: hh, f });
    };
    for (const c of charts) c.subscribeCrosshairMove(onMove);

    const ro = new ResizeObserver(() => {
      if (priceRef.current) pc.resize(priceRef.current.clientWidth, priceRef.current.clientHeight);
      if (pnlRef.current) nc.resize(pnlRef.current.clientWidth, pnlRef.current.clientHeight);
      if (greeksRef.current) gc.resize(greeksRef.current.clientWidth, greeksRef.current.clientHeight);
    });
    [priceRef, pnlRef, greeksRef].forEach((r) => r.current && ro.observe(r.current));

    return () => { ro.disconnect(); unsubs.forEach((u) => u()); pc.remove(); nc.remove(); gc.remove(); };
  }, [bars, series, legs, frames, trade.date, underlying]);

  if (status === 'loading') return <div className="flex items-center justify-center h-[300px] text-[11px] text-[var(--text-muted)]">Loading chart data…</div>;
  if (status === 'nodata') return <div className="flex items-center justify-center h-[300px] text-[11px] text-[var(--red)]">No historical candle data available for {trade.date}.</div>;

  const hf = hover?.f;
  return (
    <div className="flex flex-col gap-2">
      {/* underlying candles + leg premiums */}
      <div>
        <div className="flex items-center gap-3 text-[10px] mb-1 flex-wrap">
          <span className="text-[var(--text-muted)] uppercase tracking-wide">{underlying} &amp; leg price</span>
          <span className="text-[#9ca3af]">Spot {hf && Number.isFinite(hf.spot) ? Math.round(hf.spot) : trade.exitSpot}</span>
          {legs.map((l) => <span key={l.legId} style={{ color: l.color }}>{l.label} {hf && hf.legPrice[l.legId] != null ? hf.legPrice[l.legId].toFixed(1) : '—'}</span>)}
          {hover && <span className="text-[var(--text-muted)] ml-auto">{hover.time}</span>}
        </div>
        <div ref={priceRef} className="h-[300px] w-full border border-[var(--border)] rounded bg-[#0d0f11]" />
      </div>

      {/* P&L pane */}
      <div>
        <div className="flex items-center gap-3 text-[10px] mb-1 flex-wrap">
          <span className="text-[var(--text-muted)] uppercase tracking-wide">P&amp;L</span>
          <span className="text-white font-semibold">Total {fmtInr(hf && Number.isFinite(hf.total) ? hf.total : trade.grossPnl)}</span>
          {legs.map((l) => <span key={l.legId} style={{ color: l.color }}>{l.label} {hf && hf.legPnl[l.legId] != null ? fmtInr(hf.legPnl[l.legId]) : '—'}</span>)}
        </div>
        <div ref={pnlRef} className="h-[170px] w-full border border-[var(--border)] rounded bg-[#0d0f11]" />
      </div>

      {/* Greeks pane (Black-Scholes, net) */}
      <div>
        <div className="flex items-center gap-3 text-[10px] mb-1 flex-wrap">
          <span className="text-[var(--text-muted)] uppercase tracking-wide">Net Greeks</span>
          {(['delta', 'gamma', 'theta', 'vega'] as const).map((gk) => (
            <span key={gk} style={{ color: GREEK_COLORS[gk] }} className="capitalize">{gk} {hf ? hf.greeks[gk].toFixed(gk === 'gamma' ? 4 : 2) : '—'}</span>
          ))}
        </div>
        <div ref={greeksRef} className="h-[150px] w-full border border-[var(--border)] rounded bg-[#0d0f11]" />
      </div>
    </div>
  );
}
