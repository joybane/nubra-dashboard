import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesOptions,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import { useGreekOverlay } from './hooks/useGreekOverlay';
import { GreekButton } from './components/GreekControls';
import { fetchRange, nubraType } from './CandleChart';
import type { Instrument, OhlcBar, OhlcvData, WsMessage } from './types';
import { getSymbol } from './types';
import { snapToCandle, fmtPrice } from './lib/utils';

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

const TRACK_IV   = '1m';
const HIST_DAYS  = 7;            // last 7 days of 1-minute history
const CHUNK_DAYS = 5;            // load-more chunk when scrolling further back

interface Props {
  instrument: Instrument | null;
  theme: 'dark' | 'light';
}

export default function Tracker({ instrument, theme }: Props) {
  // Track the passed instrument if it's an index, otherwise default to NIFTY.
  const tracked = instrument && nubraType(instrument) === 'INDEX' ? instrument : NIFTY;

  const containerRef   = useRef<HTMLDivElement>(null);
  const chartRef       = useRef<IChartApi | null>(null);
  const lineRef        = useRef<ISeriesApi<'Line'> | null>(null);
  const allBarsRef     = useRef<OhlcBar[]>([]);
  const currentInstRef = useRef<Instrument | null>(null);
  const earliestRef    = useRef<Date | null>(null);
  const dayOpenRef     = useRef<number | null>(null);
  const isLoadingRef   = useRef(false);

  const [loading, setLoading] = useState<string | null>('Loading…');
  const [priceDisplay, setPriceDisplay] = useState<{ price: number; diff: number; pct: string; up: boolean } | null>(null);

  const { subscribe, subscribeChart, unsubscribeChart } = useWs();

  const vega  = useGreekOverlay({ greek: 'vega',  chartRef, currentInstRef, allBarsRef, inline: true });
  const theta = useGreekOverlay({ greek: 'theta', chartRef, currentInstRef, allBarsRef, inline: true });

  const sym = getSymbol(tracked);

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

    return () => {
      containerRef.current?.removeEventListener('dblclick', onDblClick);
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      lineRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      const tsStr = (b.bucket_timestamp && b.bucket_timestamp !== '0') ? b.bucket_timestamp : b.timestamp;
      if (!tsStr || tsStr === '0' || !/^\d+$/.test(tsStr)) return;
      const utcSec  = Number(BigInt(tsStr) / 1_000_000_000n);
      const barTime = snapToCandle(utcSec, TRACK_IV);
      const close   = Number(b.close) / 100;
      if (!close || typeof barTime !== 'number') return;
      const bar: OhlcBar = { time: barTime, open: Number(b.open) / 100 || close, high: Number(b.high) / 100 || close, low: Number(b.low) / 100 || close, close };
      lineRef.current?.update({ time: barTime, value: close } as Parameters<NonNullable<typeof lineRef.current>['update']>[0]);

      // Keep allBarsRef (the grid the greek overlay snaps to) in sync with the live tail.
      const bars = allBarsRef.current;
      const last = bars[bars.length - 1];
      if (last && typeof last.time === 'number' && last.time === barTime) bars[bars.length - 1] = bar;
      else if (!last || (typeof last.time === 'number' && barTime > last.time)) bars.push(bar);

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

      allBarsRef.current  = bars;
      earliestRef.current = start;
      dayOpenRef.current  = bars[0].open;
      lineRef.current.setData(toLine(bars));

      const len = bars.length;
      chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 120), to: len + 5 });
      setLoading(null);
      updatePrice(bars[bars.length - 1].close, dayOpenRef.current);

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

        <span className="text-[10px] text-[var(--text-muted)] ml-1">line · 1m + live tick</span>

        <div className="ml-auto flex items-center gap-2">
          <GreekButton api={vega}  label="Vega" />
          <GreekButton api={theta} label="Theta" />
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] pointer-events-none">
            {loading}
          </div>
        )}
      </div>
    </div>
  );
}
