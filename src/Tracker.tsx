import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesOptions,
  type MouseEventParams,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import { useGreekOverlay } from './hooks/useGreekOverlay';
import { GreekButton } from './components/GreekControls';
import { fetchRange, nubraType } from './CandleChart';
import type { Instrument, OhlcBar, OhlcvData, WsMessage } from './types';
import { getSymbol } from './types';
import { IST_OFFSET, fmtPrice, sortKey } from './lib/utils';

// The Tracker always charts an index line (NIFTY by default) at 1-minute resolution,
// stitched with live per-tick updates, and overlays aggregate Vega / Theta *inline*
// on the same pane (no separate sub-pane below).
const NIFTY: Instrument = {
  display_name:    'NIFTY',
  asset:           'NIFTY',
  nubra_name:      'NIFTY',
  derivative_type: 'INDEX',
  exchange:        'NSE',
};

const TRACK_IV   = '1m';         // older days + the live WS subscription interval
const TICK_IV    = '1s';         // today's session loads at 1s, stitched onto the 1m history
const HIST_DAYS  = 7;            // last 7 days of 1-minute history
const CHUNK_DAYS = 5;            // load-more chunk when scrolling further back
const TICK_VIEW_BARS = 5_400;    // initial visible window when today is 1s (~90 min)

/** True if an IST-baked chart-time (seconds) falls on the same IST calendar day as `nowMs`. */
function isSameISTDay(chartTimeSec: unknown, nowMs: number): boolean {
  if (typeof chartTimeSec !== 'number') return false;
  const barDay = new Date(chartTimeSec * 1000).toISOString().slice(0, 10);          // IST baked in
  const nowDay = new Date(nowMs + IST_OFFSET * 1000).toISOString().slice(0, 10);
  return barDay === nowDay;
}

/**
 * Today's session at 1-second resolution. Sub-minute history is current-day-only and only
 * via `intraDay:true` (which ignores the date range), supporting 1s/10s. INDEX values return
 * `close` ONLY — requesting OHLC 500s with "db error" — so fetch close-only and synthesize a
 * flat o/h/l/c (the line uses close; the greek overlay only needs bar times). Works for stocks
 * too. Returns [] on holiday / pre-open / unsupported instrument → caller keeps the 1m history.
 */
async function fetchTodayTick(instrument: Instrument): Promise<OhlcBar[]> {
  const now  = Date.now();
  const body = {
    query: [{
      exchange: instrument.exchange || 'NSE',
      type:     nubraType(instrument),
      values:   [getSymbol(instrument)],
      fields:   ['close'],
      startDate: new Date(now - 86_400_000).toISOString(),   // ignored by intraDay, sent for shape
      endDate:   new Date(now).toISOString(),
      interval: TICK_IV, intraDay: true, realTime: false,
    }],
  };
  const res  = await fetch('/api/historical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json() as { result?: Array<{ values: Array<Record<string, { close?: Array<{ ts?: string; v: number }> }>> }>; error?: string };
  if (data.error) throw new Error(data.error);

  const bars: OhlcBar[] = [];
  for (const group of data.result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        for (const pt of chart.close || []) {
          if (pt.ts == null) continue;
          const t = Number(BigInt(pt.ts) / 1_000_000_000n) + IST_OFFSET;   // IST-baked seconds
          const c = pt.v / 100;
          bars.push({ time: t, open: c, high: c, low: c, close: c });
        }
      }
    }
  }
  bars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return bars;
}

// ── Crosshair-tooltip helpers (module-level: pure, no per-render churn) ─────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Chart time is IST-baked seconds, so read UTC parts to get the IST wall clock. */
function fmtCrosshairTime(t: number): string {
  const d = new Date(t * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

/** Greek totals can be ~1e9 (industry); render them compactly in the tooltip. */
function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

function tipRow(color: string, label: string, val: string): string {
  return `<div style="display:flex;align-items:center;gap:6px;line-height:1.6;white-space:nowrap">`
    + `<span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>`
    + `<span style="color:var(--text-secondary);font-size:11px">${label}</span>`
    + `<span style="margin-left:auto;padding-left:14px;color:var(--text-primary);font-weight:600;font-size:11px">${val}</span>`
    + `</div>`;
}

interface Props {
  instrument: Instrument | null;
  theme: 'dark' | 'light';
}

export default function Tracker({ instrument, theme }: Props) {
  // Track the passed instrument if it's an index, otherwise default to NIFTY.
  const tracked = instrument && nubraType(instrument) === 'INDEX' ? instrument : NIFTY;

  const containerRef   = useRef<HTMLDivElement>(null);
  const tooltipRef     = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const lineRef        = useRef<ISeriesApi<'Line'> | null>(null);
  const allBarsRef     = useRef<OhlcBar[]>([]);
  const currentInstRef = useRef<Instrument | null>(null);
  const earliestRef    = useRef<Date | null>(null);
  const dayOpenRef     = useRef<number | null>(null);
  const isLoadingRef   = useRef(false);
  const symRef         = useRef('');

  const [loading, setLoading] = useState<string | null>('Loading…');
  const [priceDisplay, setPriceDisplay] = useState<{ price: number; diff: number; pct: string; up: boolean } | null>(null);

  const { subscribe, subscribeChart, unsubscribeChart } = useWs();

  const vega  = useGreekOverlay({ greek: 'vega',  chartRef, currentInstRef, allBarsRef, inline: true });
  const theta = useGreekOverlay({ greek: 'theta', chartRef, currentInstRef, allBarsRef, inline: true });

  const sym = getSymbol(tracked);
  symRef.current = sym;

  // ── Chart init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === 'dark';

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor:  isDark ? '#c9d1d9' : '#131722',
        fontSize:   13,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
      timeScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', timeVisible: true, secondsVisible: false, shiftVisibleRangeOnNewBar: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale:  { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    const line = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    } as Partial<LineSeriesOptions>);
    lineRef.current = line;

    const observer = new ResizeObserver(() => {
      chart.resize(containerRef.current!.clientWidth, containerRef.current!.clientHeight);
    });
    observer.observe(containerRef.current);

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (!range || isLoadingRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMore();
    });

    const onDblClick = () => {
      const len = allBarsRef.current.length;
      if (len) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 120), to: len + 5 });
      line.priceScale().applyOptions({ autoScale: true });
    };
    containerRef.current.addEventListener('dblclick', onDblClick);

    // ── Crosshair tooltip: NIFTY price + every visible greek series at the cursor ─
    const onCrosshair = (param: MouseEventParams) => {
      const tip = tooltipRef.current;
      const cont = containerRef.current;
      if (!tip || !cont) return;
      const pt = param.point;
      if (param.time == null || !pt || pt.x < 0 || pt.y < 0 || pt.x > cont.clientWidth || pt.y > cont.clientHeight) {
        tip.style.display = 'none';
        return;
      }
      const rows: string[] = [];
      const ln = lineRef.current;
      if (ln) {
        const d = param.seriesData.get(ln) as { value?: number } | undefined;
        if (d && typeof d.value === 'number') rows.push(tipRow('#2962ff', symRef.current, '₹' + fmtPrice(d.value)));
      }
      param.seriesData.forEach((data, series) => {
        if (series === ln) return;
        const v = (data as { value?: number }).value;
        if (v == null || !Number.isFinite(v)) return;
        const o = series.options() as { color?: string; title?: string };
        rows.push(tipRow(o.color || '#888', o.title || '', fmtCompact(v)));
      });
      if (!rows.length) { tip.style.display = 'none'; return; }
      tip.innerHTML = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${fmtCrosshairTime(param.time as number)}</div>` + rows.join('');
      tip.style.display = 'block';

      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = pt.x + 16, y = pt.y + 16;
      if (x + tw > cont.clientWidth) x = pt.x - tw - 16;
      if (y + th > cont.clientHeight) y = cont.clientHeight - th - 8;
      tip.style.left = `${Math.max(4, x)}px`;
      tip.style.top  = `${Math.max(4, y)}px`;
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      containerRef.current?.removeEventListener('dblclick', onDblClick);
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Price-line scale ────────────────────────────────────────────────────────
  // The greek overlays live on their own scales and span the full height (over the
  // NIFTY line). Keep the line on its full-height band and force autoScale whenever
  // greeks toggle so switching scripts can't leave the price axis frozen/clipped.
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    line.priceScale().applyOptions({
      autoScale: true,
      scaleMargins: { top: 0.08, bottom: 0.1 },
    });
  }, [vega.on, theta.on]);

  // ── Theme sync ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const isDark = theme === 'dark';
    chartRef.current.applyOptions({
      layout: { background: { color: isDark ? '#0d0f11' : '#ffffff' }, textColor: isDark ? '#c9d1d9' : '#131722' },
      grid: { vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' }, horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' } },
    });
  }, [theme]);

  function updatePrice(close: number, open: number | null) {
    const base = open ?? close;
    const diff = close - base;
    setPriceDisplay({ price: close, diff, pct: base ? ((diff / base) * 100).toFixed(2) : '0.00', up: diff >= 0 });
  }

  function toLine(bars: OhlcBar[]) {
    return bars.map((b) => ({ time: b.time, value: b.close })) as Parameters<NonNullable<typeof lineRef.current>['setData']>[0];
  }

  // ── Live ticks → update the current 1-minute point (tick-by-tick line) ───────
  useEffect(() => {
    const unsub = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !lineRef.current) return;
      const data = msg.data as OhlcvData;
      const want = sym.toUpperCase();
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const bname = (b.indexname || '').toUpperCase();
        if (bname === want || want.startsWith(bname) || bname.startsWith(want)) { applyBucket(b as Record<string, string>); break; }
      }
    });
    return unsub;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, sym]);

  function applyBucket(b: Record<string, string>) {
    try {
      // Tick-by-tick: plot at the real per-tick `timestamp` (proto field 4) at 1-second
      // resolution — the finest lightweight-charts intraday time supports — instead of
      // snapping to the 1-minute `bucket_timestamp` (field 12). Snapping to the minute is
      // what collapsed every live update into the current minute's point ("when I scroll I
      // see minute-wise"). The greek overlay snaps to allBarsRef, so it inherits the same
      // per-second live tail. Loaded history stays 1m (no sub-minute greek history exists).
      const tickStr = (b.timestamp && b.timestamp !== '0') ? b.timestamp : b.bucket_timestamp;
      if (!tickStr || tickStr === '0' || !/^\d+$/.test(tickStr)) return;
      const utcSec  = Number(BigInt(tickStr) / 1_000_000_000n);
      const close   = Number(b.close) / 100;
      if (!close) return;

      const bars = allBarsRef.current;
      const last = bars[bars.length - 1];
      const lastTime = last && typeof last.time === 'number' ? last.time : 0;
      // 1-second chart time; never decrease — lightweight-charts update() requires
      // non-decreasing time, so out-of-order/same-second ticks overwrite the last point.
      let barTime = utcSec + IST_OFFSET;
      if (barTime < lastTime) barTime = lastTime;

      const bar: OhlcBar = { time: barTime, open: Number(b.open) / 100 || close, high: Number(b.high) / 100 || close, low: Number(b.low) / 100 || close, close };
      lineRef.current?.update({ time: barTime, value: close } as Parameters<NonNullable<typeof lineRef.current>['update']>[0]);

      // Keep allBarsRef (the grid the greek overlay snaps to) in sync with the live tail.
      if (lastTime === barTime) bars[bars.length - 1] = bar;
      else bars.push(bar);

      updatePrice(close, dayOpenRef.current);
    } catch { /* ignore malformed tick */ }
  }

  // ── Load (history + subscribe) ───────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!lineRef.current || !chartRef.current) return;

    if (currentInstRef.current) {
      const oldSym   = getSymbol(currentInstRef.current);
      const wasIndex = nubraType(currentInstRef.current) === 'INDEX';
      unsubscribeChart(wasIndex ? { indexes: [oldSym] } : { instruments: [oldSym] }, TRACK_IV, currentInstRef.current.exchange || 'NSE');
    }
    vega.clearForInstrumentChange();
    theta.clearForInstrumentChange();

    currentInstRef.current = tracked;
    allBarsRef.current = [];
    earliestRef.current = null;
    dayOpenRef.current = null;
    setPriceDisplay(null);
    setLoading('Loading historical data…');

    try {
      const end   = new Date();
      const start = new Date(end.getTime() - HIST_DAYS * 86400000);
      const { bars } = await fetchRange(tracked, TRACK_IV, start, end);
      if (!bars.length) { setLoading('No historical data available.'); return; }

      // Upgrade today's session to 1-second resolution (tick-by-tick, matching the live
      // tail) stitched onto the 1m older days. Sub-minute history is current-day-only —
      // see fetchTodayTick. On holiday / pre-open / unsupported it returns [] → keep 1m.
      let combined = bars;
      let secondTail = false;
      try {
        const dayBars = await fetchTodayTick(tracked);
        if (dayBars.length && isSameISTDay(dayBars[0].time, Date.now())) {
          const dayStart = dayBars[0].time as number;
          const older = bars.filter((b) => typeof b.time === 'number' && b.time < dayStart);
          combined = [...older, ...dayBars];   // replace today's 1m section with 1s bars
          secondTail = true;
        }
      } catch { /* sub-minute unavailable → keep the 1m history */ }

      allBarsRef.current  = combined;
      earliestRef.current = start;
      dayOpenRef.current  = combined[0].open;
      lineRef.current.setData(toLine(combined));

      const len = combined.length;
      const tail = secondTail ? TICK_VIEW_BARS : 120;   // ~90 min at 1s, else last 120 × 1m
      chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - tail), to: len + 5 });
      // Force a rescale: switching scripts (e.g. NIFTY→BANKNIFTY) must not leave the
      // price axis frozen at the previous instrument's range, which clips the new line.
      lineRef.current.priceScale().applyOptions({ autoScale: true });
      setLoading(null);
      updatePrice(combined[combined.length - 1].close, dayOpenRef.current);

      const isIndex = nubraType(tracked) === 'INDEX';
      subscribeChart(isIndex ? { indexes: [sym] } : { instruments: [sym] }, TRACK_IV, tracked.exchange || 'NSE');
    } catch (err: unknown) {
      setLoading(`Error: ${(err as Error).message}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym]);

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sym]);

  async function loadMore() {
    if (isLoadingRef.current || !earliestRef.current) return;
    isLoadingRef.current = true;
    try {
      const end   = new Date(earliestRef.current.getTime() - 60000);
      const start = new Date(end.getTime() - CHUNK_DAYS * 86400000);
      const { bars } = await fetchRange(tracked, TRACK_IV, start, end);
      if (bars.length) {
        bars.push(...allBarsRef.current);
        allBarsRef.current  = bars;
        earliestRef.current = start;
        lineRef.current?.setData(toLine(allBarsRef.current));
      }
    } catch { /* ignore */ }
    isLoadingRef.current = false;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="text-base font-bold text-[var(--text-primary)]">{sym}</span>
        {priceDisplay && (
          <>
            <span className={`text-[17px] font-bold ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              ₹{fmtPrice(priceDisplay.price)}
            </span>
            <span className={`text-[13px] font-medium ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {priceDisplay.up ? '+' : ''}{priceDisplay.diff.toFixed(2)} ({priceDisplay.up ? '+' : ''}{priceDisplay.pct}%)
            </span>
          </>
        )}

        <span className="text-[10px] text-[var(--text-muted)] ml-1">line · today 1s · older 1m · live tick</span>

        <div className="ml-auto flex items-center gap-2">
          <GreekButton api={vega}  label="Vega" />
          <GreekButton api={theta} label="Theta" />
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        <div
          ref={tooltipRef}
          className="absolute z-30 hidden pointer-events-none rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 shadow-2xl"
          style={{ minWidth: 120 }}
        />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] pointer-events-none">
            {loading}
          </div>
        )}
      </div>
    </div>
  );
}
