import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type HistogramSeriesOptions,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import { useWatchlist } from './hooks/useWatchlistContext';
import { useOIProfile } from './hooks/useOIProfile';
import type { Instrument, OhlcBar, OhlcvData, VolBar, WsMessage } from './types';
import { getSymbol } from './types';
import {
  toChartTime, snapToCandle, sortKey, historyDays, chunkDays,
  intervalToSeconds, isIntradayInterval, IST_OFFSET, fmtVol, fmtPrice, formatExpiry, fmtOI,
} from './lib/utils';

const INTERVALS = ['1m','2m','3m','5m','10m','15m','30m','1h','1d','1w','1mt'] as const;
type Interval = typeof INTERVALS[number];

const MARKET_OPEN = 9 * 60 + 15;  // 9:15 in minutes
const MARKET_CLOSE = 15 * 60 + 30; // 15:30 in minutes
const TOTAL_MINUTES = MARKET_CLOSE - MARKET_OPEN; // 375

function minToLabel(min: number): string {
  const t = min + MARKET_OPEN;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function timeStrToMin(t: string): number {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m - MARKET_OPEN;
}

function nowMin(): number {
  const n = new Date();
  return Math.min(TOTAL_MINUTES, Math.max(0, n.getHours() * 60 + n.getMinutes() - MARKET_OPEN));
}

function OiTimeSlider({ fromTime, toTime, onChange, onReset, isChangeMode }: {
  fromTime: string;
  toTime: string;
  onChange: (fromMin: number, toMin: number, sliderMax: number) => void;
  onReset: () => void;
  isChangeMode: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'from' | 'to' | null>(null);
  const fromRef = useRef(0);
  const toRef = useRef(0);
  const max = nowMin();
  const fromVal = isChangeMode ? timeStrToMin(fromTime) : 0;
  const toVal = isChangeMode ? Math.min(timeStrToMin(toTime), max) : max;
  fromRef.current = fromVal;
  toRef.current = toVal;

  const posToMin = useCallback((clientX: number) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(pct * max);
  }, [max]);

  const onMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const min = posToMin(e.clientX);
    if (draggingRef.current === 'from') {
      const clamped = Math.min(min, toRef.current - 1);
      fromRef.current = clamped;
      onChange(clamped, toRef.current, max);
    } else {
      const clamped = Math.max(min, fromRef.current + 1);
      toRef.current = clamped;
      onChange(fromRef.current, clamped, max);
    }
  }, [posToMin, onChange]);

  const onUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const onDown = useCallback((handle: 'from' | 'to') => (e: React.PointerEvent) => {
    draggingRef.current = handle;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const leftPct = max > 0 ? (fromVal / max) * 100 : 0;
  const rightPct = max > 0 ? (toVal / max) * 100 : 100;

  return (
    <div className="absolute top-2 right-[80px] z-10 pointer-events-auto">
      <div className="bg-[var(--bg-secondary)]/90 backdrop-blur-sm border border-[var(--border)] rounded-lg px-3 py-1.5 min-w-[280px]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-[var(--text-muted)]">
            {isChangeMode ? `${minToLabel(fromVal)} → ${minToLabel(toVal)}` : 'OI Time Range'}
          </span>
          {isChangeMode && (
            <button onClick={onReset} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] ml-2" title="Reset">R</button>
          )}
        </div>
        <div ref={trackRef} className="relative h-[14px] cursor-pointer select-none touch-none">
          {/* Track background */}
          <div className="absolute top-[5px] left-0 right-0 h-[4px] rounded-full bg-[var(--border)]" />
          {/* Active range */}
          <div
            className="absolute top-[5px] h-[4px] rounded-full bg-[var(--accent)]"
            style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
          />
          {/* From handle */}
          <div
            className="absolute top-0 w-[14px] h-[14px] rounded-full bg-[var(--accent)] border-2 border-white shadow cursor-grab active:cursor-grabbing"
            style={{ left: `calc(${leftPct}% - 7px)` }}
            onPointerDown={onDown('from')}
            onPointerMove={onMove}
            onPointerUp={onUp}
          />
          {/* To handle */}
          <div
            className="absolute top-0 w-[14px] h-[14px] rounded-full bg-[var(--accent)] border-2 border-white shadow cursor-grab active:cursor-grabbing"
            style={{ left: `calc(${rightPct}% - 7px)` }}
            onPointerDown={onDown('to')}
            onPointerMove={onMove}
            onPointerUp={onUp}
          />
        </div>
        <div className="flex justify-between text-[9px] text-[var(--text-muted)] mt-0.5">
          <span>9:15</span>
          <span>{minToLabel(max)}</span>
        </div>
      </div>
    </div>
  );
}

interface Props {
  instrument: Instrument | null;
  theme: 'dark' | 'light';
}

export default function CandleChart({ instrument, theme }: Props) {
  const { openTicket } = usePaperTrading();
  const { addItem: addToWatchlist } = useWatchlist();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null);

  const allBarsRef      = useRef<OhlcBar[]>([]);
  const allVolBarsRef   = useRef<VolBar[]>([]);
  const earliestRef     = useRef<Date | null>(null);
  const lastBarRef      = useRef<OhlcBar | null>(null);
  const dayOpenRef      = useRef<number | null>(null);
  const currentInstRef  = useRef<Instrument | null>(null);
  const isLoadingRef    = useRef(false);
  const countdownRef    = useRef<number | null>(null);

  const [interval,   setInterval]   = useState<Interval>('5m');
  const [loading,    setLoading]    = useState<string | null>('Select a symbol to begin');
  const [showVol,    setShowVol]    = useState(false);
  const [ohlc, setOhlc] = useState<{ o:number;h:number;l:number;c:number;vol?:number;chg?:number } | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [countdownY, setCountdownY] = useState(0);
  const [priceDisplay, setPriceDisplay] = useState<{ price:number; diff:number; pct:string; up:boolean } | null>(null);
  const [loadMore, setLoadMore] = useState(false);

  const { subscribe, subscribeChart, unsubscribeChart } = useWs();
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const oi = useOIProfile({ containerRef, canvasRef, candleRef, currentInstRef, allBarsRef });

  // ── Chart initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === 'dark';

    const chart = createChart(containerRef.current, {
      layout: {
        background:  { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor:   isDark ? '#c9d1d9' : '#131722',
        fontSize:    13,
        fontFamily:  "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: isDark ? '#22262b' : '#e8ecf5' },
        horzLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: '#2962ff' },
      },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
      timeScale: {
        borderColor:  isDark ? '#2a2d32' : '#e0e3eb',
        timeVisible:  true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: true,
      handleScale:  true,
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceLineVisible: true, lastValueVisible: true,
    } as Partial<CandlestickSeriesOptions>);
    candleRef.current = candle;

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
      visible: false,
    } as Partial<HistogramSeriesOptions>);
    volRef.current = vol;
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      updateCountdownPosition();
      oi.requestDraw();
      const bar  = param.seriesData?.get(candle) as OhlcBar | undefined;
      const vBar = param.seriesData?.get(vol) as { value: number } | undefined;
      if (bar) {
        setOhlc({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, vol: vBar?.value });
      } else if (lastBarRef.current) {
        setOhlc({ o: lastBarRef.current.open, h: lastBarRef.current.high, l: lastBarRef.current.low, c: lastBarRef.current.close });
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      oi.requestDraw();
      if (!range || isLoadingRef.current || !currentInstRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMoreHistory();
    });

    const observer = new ResizeObserver(() => {
      chart.resize(containerRef.current!.clientWidth, containerRef.current!.clientHeight);
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const isDark = theme === 'dark';
    chartRef.current.applyOptions({
      layout: { background: { color: isDark ? '#0d0f11' : '#ffffff' }, textColor: isDark ? '#c9d1d9' : '#131722' },
      grid: { vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' }, horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' } },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
      timeScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
    });
  }, [theme]);

  // ── Volume toggle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!volRef.current || !candleRef.current) return;
    volRef.current.applyOptions({ visible: showVol });
    if (showVol) {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
    } else {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
    }
  }, [showVol]);

  // ── WebSocket ticks ───────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !currentInstRef.current) return;
      const data = msg.data as OhlcvData;
      const sym = getSymbol(currentInstRef.current).toUpperCase();
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const bname = (b.indexname || '').toUpperCase();
        if (bname === sym || sym.startsWith(bname) || bname.startsWith(sym)) {
          applyBucket(b as Record<string,string>);
          break;
        }
      }
    });
    return unsub;
  }, [subscribe]);

  function applyBucket(b: Record<string,string>) {
    try {
      const tsStr = (b.bucket_timestamp && b.bucket_timestamp !== '0') ? b.bucket_timestamp : b.timestamp;
      if (!tsStr || tsStr === '0') return;
      const utcSec  = Number(BigInt(tsStr) / 1_000_000_000n);
      const barTime = snapToCandle(utcSec, intervalRef.current);
      const candle  = { time: barTime, open: Number(b.open)/100, high: Number(b.high)/100, low: Number(b.low)/100, close: Number(b.close)/100 };
      if (!candle.open || !candle.close) return;
      candleRef.current?.update(candle as Parameters<typeof candleRef.current.update>[0]);
      lastBarRef.current = candle;
      updatePriceDisplay(candle.close, dayOpenRef.current || candle.open);
      setOhlc({ o: candle.open, h: candle.high, l: candle.low, c: candle.close, vol: Number(b.cumulative_volume) || undefined });
      updateCountdownPosition();
    } catch { /* ignore */ }
  }

  // ── Load instrument ───────────────────────────────────────────────────────
  const loadInstrument = useCallback(async (inst: Instrument, iv: Interval) => {
    if (!candleRef.current || !volRef.current || !chartRef.current) return;

    if (currentInstRef.current) {
      const oldSym   = getSymbol(currentInstRef.current);
      const wasIndex = nubraType(currentInstRef.current) === 'INDEX';
      unsubscribeChart(wasIndex ? { indexes: [oldSym] } : { instruments: [oldSym] }, iv, currentInstRef.current.exchange || 'NSE');
    }
    oi.clearForInstrumentChange();

    currentInstRef.current  = inst;
    allBarsRef.current      = [];
    allVolBarsRef.current   = [];
    earliestRef.current     = null;
    lastBarRef.current      = null;
    dayOpenRef.current      = null;
    stopCountdown();
    setLoading('Loading historical data…');
    setPriceDisplay(null);
    setOhlc(null);

    try {
      const end   = new Date();
      const start = new Date(end.getTime() - historyDays(iv) * 86400000);
      const { bars, volBars } = await fetchRange(inst, iv, start, end);
      if (!bars.length) { setLoading('No historical data available.'); return; }

      allBarsRef.current    = bars;
      allVolBarsRef.current = volBars;
      earliestRef.current   = start;
      lastBarRef.current    = bars[bars.length - 1];
      dayOpenRef.current    = bars[0].open;

      candleRef.current.setData(bars as Parameters<typeof candleRef.current.setData>[0]);
      volRef.current.setData(volBars as Parameters<typeof volRef.current.setData>[0]);

      const len = bars.length;
      chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 200), to: len + 5 });
      setLoading(null);
      startCountdown();
      updatePriceDisplay(lastBarRef.current.close, dayOpenRef.current);
      setOhlc({ o: lastBarRef.current.open, h: lastBarRef.current.high, l: lastBarRef.current.low, c: lastBarRef.current.close });

      const chartSym = getSymbol(inst);
      const isIndex  = nubraType(inst) === 'INDEX';
      subscribeChart(isIndex ? { indexes: [chartSym] } : { instruments: [chartSym] }, iv, inst.exchange || 'NSE');
    } catch (err: unknown) {
      setLoading(`Error: ${(err as Error).message}`);
    }
  }, [unsubscribeChart, subscribeChart]);

  useEffect(() => {
    if (!instrument) return;
    loadInstrument(instrument, interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  useEffect(() => {
    if (!instrument) return;
    loadInstrument(instrument, interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  async function loadMoreHistory() {
    if (isLoadingRef.current || !earliestRef.current || !currentInstRef.current) return;
    isLoadingRef.current = true;
    setLoadMore(true);
    try {
      const end   = new Date(earliestRef.current.getTime() - 60000);
      const start = new Date(end.getTime() - chunkDays(intervalRef.current) * 86400000);
      const { bars, volBars } = await fetchRange(currentInstRef.current, intervalRef.current, start, end);
      if (bars.length) {
        allBarsRef.current    = [...bars, ...allBarsRef.current];
        allVolBarsRef.current = [...volBars, ...allVolBarsRef.current];
        earliestRef.current   = start;
        dayOpenRef.current    = allBarsRef.current[0].open;
        candleRef.current?.setData(allBarsRef.current as Parameters<typeof candleRef.current.setData>[0]);
        volRef.current?.setData(allVolBarsRef.current as Parameters<typeof volRef.current.setData>[0]);
      }
    } catch { /* ignore */ }
    isLoadingRef.current = false;
    setLoadMore(false);
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  function startCountdown() {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = window.setInterval(tickCountdown, 1000);
    tickCountdown();
  }
  function stopCountdown() {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setCountdown(null);
  }
  function tickCountdown() {
    if (!intervalRef.current || !currentInstRef.current) { stopCountdown(); return; }
    const nowUtc = Math.floor(Date.now() / 1000);
    const istSec = (nowUtc + IST_OFFSET) % 86400;
    if (istSec < 9 * 3600 + 15 * 60 || istSec > 15 * 3600 + 30 * 60) {
      setCountdown(null);
      return;
    }
    const intSec    = intervalToSeconds(intervalRef.current);
    const elapsed   = (nowUtc + IST_OFFSET) % intSec;
    const remaining = intSec - elapsed;
    const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
    const ss = (remaining % 60).toString().padStart(2, '0');
    setCountdown(`${mm}:${ss}`);
    updateCountdownPosition();
  }
  function updateCountdownPosition() {
    if (!lastBarRef.current || !candleRef.current) return;
    const y = candleRef.current.priceToCoordinate(lastBarRef.current.close);
    if (y != null) setCountdownY(Math.round(y) + 13);
  }

  function updatePriceDisplay(price: number, open: number) {
    const diff = price - (open || price);
    const pct  = open ? ((diff / open) * 100).toFixed(2) : '0.00';
    const up   = diff >= 0;
    setPriceDisplay({ price, diff, pct, up });
  }

  function resetZoom() {
    if (!chartRef.current || !allBarsRef.current.length) return;
    const len = allBarsRef.current.length;
    chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 200), to: len + 5 });
    candleRef.current?.priceScale().applyOptions({ autoScale: true });
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const sym = instrument ? getSymbol(instrument) : '—';

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

        {/* Buy / Sell / Watchlist */}
        {instrument && (
          <div className="flex items-center gap-1 ml-1">
            <button
              onClick={() => openTicket({ instrument, side: 'BUY', ltp: priceDisplay?.price })}
              className="px-2.5 py-1 rounded text-[11px] font-bold text-white bg-[var(--green)] hover:brightness-110 transition-all"
            >
              BUY
            </button>
            <button
              onClick={() => openTicket({ instrument, side: 'SELL', ltp: priceDisplay?.price })}
              className="px-2.5 py-1 rounded text-[11px] font-bold text-white bg-[var(--red)] hover:brightness-110 transition-all"
            >
              SELL
            </button>
            <button
              onClick={() => addToWatchlist({
                displayName: sym,
                underlying: instrument.asset || sym,
                exchange: instrument.exchange || 'NSE',
                ref_id: instrument.ref_id,
                nubraName: getSymbol(instrument),
                optionType: (instrument.option_type as 'CE' | 'PE' | undefined),
                strike: instrument.strike_price ? instrument.strike_price / 100 : undefined,
                expiry: instrument.expiry ? String(instrument.expiry) : undefined,
                ltpAtAdd: priceDisplay?.price ?? 0,
              })}
              className="px-1.5 py-1 rounded text-[11px] font-semibold text-amber-400 bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/30 transition-all"
              title="Add to watchlist"
            >
              ★
            </button>
          </div>
        )}

        {/* Volume toggle */}
        <div className="relative ml-1">
          <button
            onClick={() => setShowVol((v) => !v)}
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-all ${
              showVol ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Vol
          </button>
        </div>

        {/* OI Profile — left=toggle, right=settings caret */}
        <div className="relative flex items-stretch">
          <button
            onClick={oi.toggleOI}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-l text-xs font-medium border border-r-0 transition-all ${
              oi.oiOn ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${oi.oiOn ? 'bg-white/30 border-white/60' : 'border-current opacity-60'}`}>
              {oi.oiOn && <span className="text-[8px] font-bold leading-none">✓</span>}
            </span>
            OI Profile
          </button>
          <button
            onClick={oi.openSettings}
            className={`px-1.5 py-1 rounded-r text-xs font-medium border border-l-0 transition-all ${
              oi.oiOn ? 'bg-[var(--accent)] border-[var(--accent)] text-white hover:opacity-80' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            ▾
          </button>

          {oi.showOiPopup && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[290px] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">OI Profile Settings</span>
                <button onClick={() => oi.setShowOiPopup(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none">×</button>
              </div>

              <div className="px-4 py-3 flex flex-col gap-4">
                {oi.oiExpiries.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">EXPIRES INCLUDED</div>
                    <div className="flex flex-col gap-1.5">
                      {oi.oiExpiries.map((exp) => (
                        <label key={exp} className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={oi.selExpiries.includes(exp)}
                            onChange={(e) => oi.setSelExpiries((prev) => e.target.checked ? [...prev, exp] : prev.filter((x) => x !== exp))}
                            className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                          />
                          <span className="text-[12px] text-[var(--text-primary)]">{formatExpiry(exp)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">VISUAL SETTINGS</div>
                  <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                    <input type="checkbox" checked={oi.showCalls} onChange={(e) => oi.setShowCalls(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">CALLS</span>
                    <span className="w-4 h-4 rounded-sm shrink-0" style={{ backgroundColor: '#22c55e' }} />
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={oi.showPuts} onChange={(e) => oi.setShowPuts(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">PUTS</span>
                    <span className="w-4 h-4 rounded-sm shrink-0" style={{ backgroundColor: '#ef4444' }} />
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border)]">
                <button onClick={() => oi.setShowOiPopup(false)} className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
                <button
                  onClick={oi.applyExpiries}
                  className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-dim)] transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Reset zoom */}
        <button
          onClick={resetZoom}
          className="px-2 py-1 rounded text-[11px] font-medium bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all ml-1"
          title="Reset zoom to latest candles"
        >
          ⊞
        </button>

        {/* Interval buttons */}
        <div className="flex gap-0.5 ml-auto">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={`px-2 py-1 rounded text-[12px] font-medium transition-all ${
                interval === iv
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      {/* Chart container */}
      <div
        ref={containerRef}
        className="relative flex-1 bg-[var(--bg-primary)]"
        onMouseDown={oi.handleMouseDown}
        onMouseMove={oi.handleMouseMove}
        onMouseLeave={oi.handleMouseLeave}
        onWheel={() => oi.requestDraw()}
        onDoubleClick={resetZoom}
      >
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[5]" />

        {/* OI time range slider */}
        {oi.oiOn && (
          <OiTimeSlider
            fromTime={oi.oiFromTime}
            toTime={oi.oiToTime}
            onChange={oi.handleSliderChange}
            onReset={oi.resetTimeRange}
            isChangeMode={oi.oiMode === 'oi_change'}
          />
        )}

        {/* OHLC overlay */}
        {ohlc && (
          <div className="absolute top-2 left-3 z-10 pointer-events-none">
            <div className="flex items-center gap-1 text-[12px]">
              <span className="text-[var(--text-muted)] text-[11px]">O</span><span className="text-[var(--text-primary)] font-medium">{ohlc.o.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">H</span><span className="text-[var(--green)] font-medium">{ohlc.h.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">L</span><span className="text-[var(--red)] font-medium">{ohlc.l.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">C</span><span className="text-[var(--text-primary)] font-medium">{ohlc.c.toFixed(2)}</span>
              {ohlc.vol && <><span className="text-[var(--text-muted)] text-[11px] ml-1">Vol</span><span className="text-[var(--text-primary)] font-medium">{fmtVol(ohlc.vol)}</span></>}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] text-[14px] z-10">
            {loading}
          </div>
        )}

        {/* Load-more indicator */}
        {loadMore && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 bg-[rgba(30,33,38,0.8)] text-[var(--text-secondary)] text-[11px] px-2.5 py-1 rounded z-10 pointer-events-none">
            Loading…
          </div>
        )}

        {/* OI bar hover tooltip */}
        {oi.oiHover && oi.oiOn && (
          <div
            className="absolute z-20 pointer-events-none"
            style={{
              left: Math.max(4, oi.oiHover.x - 210),
              top: Math.max(4, Math.min(oi.oiHover.y - 58, (containerRef.current?.clientHeight ?? 400) - 120)),
            }}
          >
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl px-4 py-3 min-w-[178px]">
              <div className="text-[14px] font-semibold text-[var(--text-primary)] mb-2 pb-1.5 border-b border-[var(--border)]">
                Strike {oi.oiHover.strike.toLocaleString('en-IN')}
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px] mb-1">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#22c55e] shrink-0" />
                  <span className="text-[var(--text-muted)]">{oi.oiMode === 'oi_change' ? 'Call Δ' : 'Call OI'}</span>
                </div>
                <span className={`font-medium tabular-nums ${oi.oiMode === 'oi_change' ? (oi.oiHover.ceOi >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]') : 'text-[var(--text-primary)]'}`}>
                  {oi.oiMode === 'oi_change' ? `${oi.oiHover.ceOi >= 0 ? '+' : ''}${fmtOI(Math.abs(oi.oiHover.ceOi))}` : fmtOI(oi.oiHover.ceOi)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#ef4444] shrink-0" />
                  <span className="text-[var(--text-muted)]">{oi.oiMode === 'oi_change' ? 'Put Δ' : 'Put OI'}</span>
                </div>
                <span className={`font-medium tabular-nums ${oi.oiMode === 'oi_change' ? (oi.oiHover.peOi >= 0 ? 'text-[#ef4444]' : 'text-[#22c55e]') : 'text-[var(--text-primary)]'}`}>
                  {oi.oiMode === 'oi_change' ? `${oi.oiHover.peOi >= 0 ? '+' : ''}${fmtOI(Math.abs(oi.oiHover.peOi))}` : fmtOI(oi.oiHover.peOi)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Candle countdown */}
        {countdown && (
          <div
            className="absolute right-0 w-[72px] text-center text-white text-[11px] font-semibold py-0.5 z-20 pointer-events-none font-mono"
            style={{
              top: countdownY,
              backgroundColor: priceDisplay ? (priceDisplay.up ? '#22c55e' : '#ef4444') : '#2962ff',
            }}
          >
            {countdown}
          </div>
        )}
      </div>
    </div>
  );
}

// ── API fetch ─────────────────────────────────────────────────────────────────
function nubraType(item: Instrument): string {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type      || '').toUpperCase();
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

async function fetchRange(
  instrument: Instrument,
  interval: string,
  startDate: Date,
  endDate: Date,
): Promise<{ bars: OhlcBar[]; volBars: VolBar[] }> {
  const type   = nubraType(instrument);
  const symbol = getSymbol(instrument);
  const exch   = instrument.exchange || 'NSE';

  const body = {
    query: [{
      exchange: exch, type,
      values:   [symbol],
      fields:   ['open', 'high', 'low', 'close', 'cumulative_volume'],
      startDate: startDate.toISOString(),
      endDate:   endDate.toISOString(),
      interval, intraDay: false, realTime: false,
    }],
  };

  const res  = await fetch('/api/historical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json() as { result?: Array<{ values: Array<Record<string, { open?: Array<{ts?:string;v:number}>; high?: Array<{v:number}>; low?: Array<{v:number}>; close?: Array<{v:number}>; cumulative_volume?: Array<{v:number}> }>> }>; error?: string };
  if (data.error) throw new Error(data.error);

  const bars: OhlcBar[] = [], volBars: VolBar[] = [];

  for (const group of data.result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        const opens  = chart.open              || [];
        const highs  = chart.high              || [];
        const lows   = chart.low               || [];
        const closes = chart.close             || [];
        const vols   = chart.cumulative_volume || [];
        const len = Math.min(opens.length, highs.length, lows.length, closes.length);

        for (let i = 0; i < len; i++) {
          const tsNs = opens[i].ts;
          if (tsNs == null) continue;
          const t = toChartTime(BigInt(tsNs), interval);
          const o = opens[i].v / 100, h = highs[i].v / 100, l = lows[i].v / 100, c = closes[i].v / 100;
          bars.push({ time: t, open: o, high: h, low: l, close: c });
          if (vols[i]?.v) {
            volBars.push({ time: t, value: vols[i].v, color: c >= o ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' });
          }
        }
      }
    }
  }

  bars.sort((a, b)    => sortKey(a.time) - sortKey(b.time));
  volBars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return { bars, volBars };
}
