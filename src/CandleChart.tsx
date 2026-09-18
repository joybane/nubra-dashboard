import { chartTheme } from './lib/chartTheme';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type HistogramSeriesOptions,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import { useWatchlist } from './hooks/useWatchlistContext';
import { useOIProfile } from './hooks/useOIProfile';
import { useGreekOverlay } from './hooks/useGreekOverlay';
import { GreekButton } from './components/GreekControls';
import ChartPaneResizer from './components/ChartPaneResizer';
import { bindCandleCrosshair, fmtCrosshairTime } from './lib/greekTooltip';
import UiIcon from './components/UiIcon';
import { isChartLive, removeChart } from './lib/chartLifecycle';
import { emptyHistoryMessage } from './lib/emptyHistory';
import type {
  Instrument,
  OhlcBar,
  OhlcvData,
  OptionChainData,
  OptionLeg,
  Theme,
  VolBar,
  WsMessage,
} from './types';
import { getSymbol } from './types';
import {
  toChartTime,
  snapToCandle,
  sortKey,
  historyDays,
  chunkDays,
  intervalToSeconds,
  isIntradayInterval,
  IST_OFFSET,
  fmtVol,
  fmtPrice,
  formatExpiry,
  fmtOI,
  marketSession,
  clampSubMinuteStart,
} from './lib/utils';

const INTERVALS = ['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h', '1d', '1w', '1mt'] as const;
/**
 * Wider lookbacks (days) tried in turn when an intraday load returns no bars. 7 covers a weekend
 * past the short windows; 14 covers a long exchange holiday on top of one.
 */
const EMPTY_RETRY_DAYS = [7, 14];
/**
 * Consecutive days of empty history before scrolling back concludes the data has run out. Longer
 * than any exchange closure, so a weekend or holiday never ends the scroll-back — which is what a
 * single empty page-in used to do.
 */
const EMPTY_GAP_LIMIT_DAYS = 45;
/** Request size when "Go to" fills the gap back to a date. The broker returns 90 days of 1m in ~0.3 s. */
const GOTO_INTRADAY_PIECE_DAYS = 60;
const GOTO_DAILY_PIECE_DAYS = 1825;
type Interval = (typeof INTERVALS)[number];

// The OI slider spans one trading session. Its length is exchange-specific: NSE is
// 375 minutes, MCX 870 (09:00–23:30), so these are derived per render rather than
// frozen as module constants.
function minToLabel(min: number, openMin: number): string {
  const t = min + openMin;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function timeStrToMin(t: string, openMin: number): number {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m - openMin;
}

function nowMin(openMin: number, closeMin: number): number {
  const n = new Date();
  const total = closeMin - openMin;
  return Math.min(total, Math.max(0, n.getHours() * 60 + n.getMinutes() - openMin));
}

function OiTimeSlider({
  fromTime,
  toTime,
  onChange,
  onReset,
  isChangeMode,
  exchange,
}: {
  fromTime: string;
  toTime: string;
  onChange: (fromMin: number, toMin: number, sliderMax: number) => void;
  onReset: () => void;
  isChangeMode: boolean;
  exchange?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'from' | 'to' | null>(null);
  const fromRef = useRef(0);
  const toRef = useRef(0);
  const { openMin, closeMin } = marketSession(exchange);
  const max = nowMin(openMin, closeMin);
  const fromVal = isChangeMode ? timeStrToMin(fromTime, openMin) : 0;
  const toVal = isChangeMode ? Math.min(timeStrToMin(toTime, openMin), max) : max;
  fromRef.current = fromVal;
  toRef.current = toVal;

  const posToMin = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return 0;
      const rect = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return Math.round(pct * max);
    },
    [max],
  );

  const onMove = useCallback(
    (e: React.PointerEvent) => {
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
    },
    [posToMin, onChange],
  );

  const onUp = useCallback((e: React.PointerEvent) => {
    draggingRef.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  const onDown = useCallback(
    (handle: 'from' | 'to') => (e: React.PointerEvent) => {
      draggingRef.current = handle;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const leftPct = max > 0 ? (fromVal / max) * 100 : 0;
  const rightPct = max > 0 ? (toVal / max) * 100 : 100;

  return (
    <div className="absolute top-2 right-[80px] z-10 pointer-events-auto">
      <div className="bg-[var(--bg-secondary)]/90 backdrop-blur-sm border border-[var(--border)] rounded-lg px-3 py-1.5 min-w-[280px]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-[var(--text-muted)]">
            {isChangeMode
              ? `${minToLabel(fromVal, openMin)} → ${minToLabel(toVal, openMin)}`
              : 'OI Time Range'}
          </span>
          {isChangeMode && (
            <button
              onClick={onReset}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] ml-2"
              title="Reset"
            >
              R
            </button>
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
          <span>{minToLabel(max, openMin)}</span>
        </div>
      </div>
    </div>
  );
}

function normalizeChartName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^(NSE|BSE)_/, '')
    .replace(/\s+/g, '');
}

interface Props {
  instrument: Instrument | null;
  theme: Theme;
}

export default function CandleChart({ instrument, theme }: Props) {
  const { openTicket } = usePaperTrading();
  const { addItem: addToWatchlist } = useWatchlist();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  // Read by the crosshair tooltip, which is bound once and outlives every symbol switch.
  const symRef = useRef('');

  const allBarsRef = useRef<OhlcBar[]>([]);
  const allVolBarsRef = useRef<VolBar[]>([]);
  const earliestRef = useRef<Date | null>(null);
  const lastBarRef = useRef<OhlcBar | null>(null);
  const dayOpenRef = useRef<number | null>(null);
  const currentInstRef = useRef<Instrument | null>(null);
  const isLoadingRef = useRef(false);
  const countdownRef = useRef<number | null>(null);

  // Match context for the currently loaded OPTION instrument, used to pick this
  // contract's leg out of 'option_chain' broadcasts (see applyOptionTick below —
  // the index_bucket/ohlcv feed never delivers ticks for individual options).
  const optAssetRef = useRef<string | null>(null);
  const optExpiryRef = useRef<string | null>(null);
  const optRefIdRef = useRef<number | null>(null);
  const optStrikeRef = useRef<number | null>(null);
  const optTypeRef = useRef<'CE' | 'PE' | null>(null);

  // The option-chain WS subscription backing the above — independent of, and
  // ref-counted alongside, any subscription OptionChain/Watchlist/useOIProfile
  // already hold for the same asset/expiry (see lib/ocSubRegistry.ts).
  const optTickAssetRef = useRef<string | null>(null);
  const optTickExpiryRef = useRef<string | null>(null);
  const optTickExchRef = useRef<string>('NSE');

  const [interval, setInterval] = useState<Interval>('5m');
  const [loading, setLoading] = useState<string | null>('Select a symbol to begin');
  const [showVol, setShowVol] = useState(false);
  const [ohlc, setOhlc] = useState<{
    o: number;
    h: number;
    l: number;
    c: number;
    vol?: number;
    chg?: number;
  } | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [countdownY, setCountdownY] = useState(0);
  const [priceDisplay, setPriceDisplay] = useState<{
    price: number;
    diff: number;
    pct: string;
    up: boolean;
  } | null>(null);
  const [loadMore, setLoadMore] = useState(false);
  const [goToOpen, setGoToOpen] = useState(false);
  const goToBtnRef = useRef<HTMLButtonElement>(null);

  const { wsReady, subscribe, subscribeChart, unsubscribeChart, subscribeOC, unsubscribeOC } = useWs();
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  function subscribeOptTickWs(asset: string, expiry: string, exchange: string) {
    if (optTickAssetRef.current === asset && optTickExpiryRef.current === expiry) return;
    unsubscribeOptTickWs();
    optTickAssetRef.current = asset;
    optTickExpiryRef.current = expiry;
    optTickExchRef.current = exchange;
    subscribeOC(asset, expiry, exchange);
  }

  function unsubscribeOptTickWs() {
    if (optTickAssetRef.current && optTickExpiryRef.current) {
      unsubscribeOC(optTickAssetRef.current, optTickExpiryRef.current, optTickExchRef.current);
    }
    optTickAssetRef.current = null;
    optTickExpiryRef.current = null;
  }

  const oi = useOIProfile({ containerRef, canvasRef, candleRef, currentInstRef, allBarsRef });
  const vega = useGreekOverlay({ greek: 'vega', chartRef, currentInstRef, allBarsRef });
  const theta = useGreekOverlay({ greek: 'theta', chartRef, currentInstRef, allBarsRef });
  // IV rides the same sub-pane path as its siblings here (the Tracker renders all three inline).
  // Named `ivOverlay`, not `iv`: the load callback already binds `iv` to the chart INTERVAL, and
  // a shadowed name there would silently hide the overlay from the teardown it must take part in.
  const ivOverlay = useGreekOverlay({ greek: 'iv', chartRef, currentInstRef, allBarsRef });

  // ── Chart initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme !== 'light';

    const chart = createChart(containerRef.current, {
      ...chartTheme(theme),
      rightPriceScale: { borderColor: isDark ? '#2b3340' : '#dce2ec', minimumWidth: 72 },
      timeScale: {
        borderColor: isDark ? '#2b3340' : '#dce2ec',
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      kineticScroll: { mouse: false, touch: false },
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
      priceLineVisible: true,
      lastValueVisible: true,
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
      const bar = param.seriesData?.get(candle) as OhlcBar | undefined;
      const vBar = param.seriesData?.get(vol) as { value: number } | undefined;
      if (bar) {
        setOhlc({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, vol: vBar?.value });
      } else if (lastBarRef.current) {
        setOhlc({
          o: lastBarRef.current.open,
          h: lastBarRef.current.high,
          l: lastBarRef.current.low,
          c: lastBarRef.current.close,
        });
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      oi.requestDraw();
      if (!range) return;
      if (hasReachedEarliestRef.current && range.from < -5) {
        try {
          const span = range.to - range.from;
          chart.timeScale().setVisibleLogicalRange({ from: -5, to: -5 + span });
        } catch {}
        return;
      }
      if (isLoadingRef.current || !currentInstRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMoreHistory();
    });

    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      chart.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(containerRef.current);

    const onDblClick = () => {
      const len = allBarsRef.current.length;
      if (len)
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 60), to: len + 5 });
      candle.priceScale().applyOptions({ autoScale: true });
    };
    containerRef.current.addEventListener('dblclick', onDblClick);

    // ── Crosshair tooltip: hovered candle + volume + every visible greek sub-pane line ──
    // The top-left legend answers "what is this candle"; the card answers it at the cursor and,
    // unlike the legend, carries the Vega/Theta/IV overlays — which otherwise only ever show a
    // last value on their own price axis, never a reading at the bar being looked at.
    const unbindTooltip =
      tooltipRef.current && containerRef.current
        ? bindCandleCrosshair({
            chart,
            container: containerRef.current,
            tooltip: tooltipRef.current,
            candleSeries: () => candleRef.current,
            volumeSeries: () => volRef.current,
            symbol: () => symRef.current,
            formatPrice: (v) => fmtPrice(v),
            formatVolume: (v) => fmtVol(v),
          })
        : () => {};

    return () => {
      containerRef.current?.removeEventListener('dblclick', onDblClick);
      observer.disconnect();
      unbindTooltip();
      stopCountdown(); // otherwise the 1s countdown interval keeps ticking after unmount
      removeChart(chart);
      // Clear the refs too: an in-flight history fetch resolving after this point
      // would otherwise call setData on a removed chart, which throws one frame
      // later from inside lightweight-charts (see lib/chartLifecycle).
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Keyboard navigation ───────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.tabIndex = 0;
    el.setAttribute('aria-label', 'Price chart. Arrow keys pan, plus and minus zoom, Home resets the view.');
    const onKey = (e: KeyboardEvent) => {
      const ts = chartRef.current?.timeScale();
      if (!ts) return;
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const span = range.to - range.from;
      const step = Math.max(1, Math.round(span * 0.1));
      if (e.key === 'ArrowLeft') {
        ts.setVisibleLogicalRange({ from: range.from - step, to: range.to - step });
        e.preventDefault();
      }
      if (e.key === 'ArrowRight') {
        ts.setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
        e.preventDefault();
      }
      if (e.key === '+' || e.key === '=') {
        ts.setVisibleLogicalRange({ from: range.from + step, to: range.to - step });
        e.preventDefault();
      }
      if (e.key === '-') {
        ts.setVisibleLogicalRange({ from: range.from - step, to: range.to + step });
        e.preventDefault();
      }
      if (e.key === 'Home' || e.key === 'End') {
        resetZoom();
        e.preventDefault();
      }
      // TradingView's "Go to" shortcut.
      if (e.altKey && (e.key === 'g' || e.key === 'G')) {
        setGoToOpen(true);
        e.preventDefault();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  // ── Theme sync ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.applyOptions(chartTheme(theme));
  }, [theme]);

  // ── Volume toggle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!volRef.current || !candleRef.current) return;
    volRef.current.applyOptions({ visible: showVol });
    if (showVol) {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.25 } });
    } else {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
    }
  }, [showVol]);

  // ── WebSocket ticks ───────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !currentInstRef.current) return;
      const data = msg.data as OhlcvData;
      const sym = normalizeChartName(getSymbol(currentInstRef.current));
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const bname = normalizeChartName(b.indexname || '');
        if (bname === sym) {
          applyBucket(b as Record<string, string>);
          break;
        }
      }
    });
    return unsub;
  }, [subscribe]);

  // option_chain is the only channel that carries a live per-second LTP for
  // options (index_bucket/ohlcv never delivers ticks for individual option
  // contracts — confirmed empirically) — build synthetic candles from it.
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      if (!currentInstRef.current || nubraType(currentInstRef.current) !== 'OPT') return;
      const data = msg.data as OptionChainData;
      if ((data.asset || '').toUpperCase() !== optAssetRef.current) return;
      if (String(data.expiry ?? '') !== optExpiryRef.current) return;

      const legs = (optTypeRef.current === 'PE' ? data.pe : data.ce) || [];
      const refId = optRefIdRef.current;
      const strike = optStrikeRef.current;
      let match: (OptionLeg & Record<string, unknown>) | undefined;
      for (const l of legs) {
        const leg = l as OptionLeg & Record<string, unknown>;
        if (refId != null) {
          if (Number(leg.refId ?? leg.ref_id) === refId) {
            match = leg;
            break;
          }
          continue;
        }
        if (strike != null) {
          const sp = Number(leg.sp);
          if ((sp > 10000 ? sp / 100 : sp) === strike) {
            match = leg;
            break;
          }
        }
      }
      if (!match) return;
      const ltp = Number(match.ltp);
      if (!(ltp > 0)) return;
      applyOptionTick(ltp / 100, Number(match.volume) || undefined, match.ts as string | undefined);
    });
    return unsub;
  }, [subscribe]);

  // Release the option-chain subscription on unmount — otherwise a pane showing
  // an option leaks a live feed after the host chart is gone.
  useEffect(
    () => () => {
      unsubscribeOptTickWs();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function upsertBar(arr: OhlcBar[], bar: OhlcBar): void {
    const last = arr[arr.length - 1];
    if (last && sortKey(last.time) === sortKey(bar.time)) {
      last.open = bar.open;
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
    } else if (!last || sortKey(bar.time) > sortKey(last.time)) {
      arr.push(bar);
    }
  }

  function commitCandle(candle: OhlcBar, vol?: number) {
    candleRef.current?.update(candle as Parameters<typeof candleRef.current.update>[0]);
    lastBarRef.current = candle;
    upsertBar(allBarsRef.current, candle);
    updatePriceDisplay(candle.close, dayOpenRef.current || candle.open);
    setOhlc({ o: candle.open, h: candle.high, l: candle.low, c: candle.close, vol });
    updateCountdownPosition();
  }

  function applyBucket(b: Record<string, string>) {
    try {
      const isBucket = b.bucket_timestamp && b.bucket_timestamp !== '0';
      const tsStr = isBucket ? b.bucket_timestamp : b.timestamp;
      if (!tsStr || tsStr === '0' || !/^\d+$/.test(tsStr)) return;
      const utcSec = Number(BigInt(tsStr) / 1_000_000_000n);
      const barTime = snapToCandle(utcSec, intervalRef.current);
      
      const cVal = Number(b.close) / 100;
      if (isNaN(cVal) || cVal <= 0) return;
      const vol = Number(b.cumulative_volume) || undefined;

      if (isBucket) {
        const oVal = Number(b.open) / 100;
        const hVal = Number(b.high) / 100;
        const lVal = Number(b.low) / 100;
        if (isNaN(oVal) || isNaN(hVal) || isNaN(lVal) || oVal <= 0) return;
        const candle = {
          time: barTime,
          open: oVal,
          high: Math.max(hVal, oVal, cVal),
          low: Math.min(lVal, oVal, hVal, cVal),
          close: cVal,
        };
        commitCandle(candle, vol);
      } else {
        const last = lastBarRef.current;
        const candle =
          last && sortKey(last.time) === sortKey(barTime)
            ? {
                time: barTime,
                open: last.open,
                high: Math.max(last.high, cVal),
                low: Math.min(last.low, cVal),
                close: cVal,
              }
            : { time: barTime, open: cVal, high: cVal, low: cVal, close: cVal };
        commitCandle(candle, vol);
      }
    } catch (e) {
      console.warn('[Chart] applyBucket error:', e);
    }
  }

  // Builds a candle from a single LTP point (option_chain has no O/H/L, only a
  // running last price) — first tick in a new interval bucket seeds O=H=L=C,
  // later ticks in the same bucket only widen H/L and move C, like a live print.
  function applyOptionTick(ltpRupees: number, vol: number | undefined, tsNs?: string) {
    try {
      if (!(ltpRupees > 0)) return;
      const utcSec =
        tsNs && /^\d+$/.test(tsNs)
          ? Number(BigInt(tsNs) / 1_000_000_000n)
          : Math.floor(Date.now() / 1000);
      const barTime = snapToCandle(utcSec, intervalRef.current);
      const last = lastBarRef.current;
      const candle =
        last && sortKey(last.time) === sortKey(barTime)
          ? {
              time: barTime,
              open: last.open,
              high: Math.max(last.high, ltpRupees),
              low: Math.min(last.low, ltpRupees),
              close: ltpRupees,
            }
          : { time: barTime, open: ltpRupees, high: ltpRupees, low: ltpRupees, close: ltpRupees };
      commitCandle(candle, vol);
    } catch (e) {
      console.warn('[Chart] applyOptionTick error:', e);
    }
  }

  const hasReachedEarliestRef = useRef(false);
  const lastLoadTimeRef = useRef(0);
  const loadTicketRef = useRef(0);

  function sanitizeCandles(bars: OhlcBar[]): OhlcBar[] {
    if (!bars || !bars.length) return [];
    return bars.filter(
      (b) =>
        b &&
        b.time != null &&
        typeof b.open === 'number' &&
        !isNaN(b.open) &&
        b.open > 0 &&
        typeof b.high === 'number' &&
        !isNaN(b.high) &&
        b.high > 0 &&
        typeof b.low === 'number' &&
        !isNaN(b.low) &&
        b.low > 0 &&
        typeof b.close === 'number' &&
        !isNaN(b.close) &&
        b.close > 0,
    );
  }

  function dedupeAndSortBars<T extends { time: any }>(bars: T[]): T[] {
    if (!bars || bars.length === 0) return [];
    const seen = new Map<number, T>();
    for (const b of bars) {
      if (!b || b.time == null) continue;
      const k = sortKey(b.time);
      seen.set(k, b);
    }
    return Array.from(seen.values()).sort((a, b) => sortKey(a.time) - sortKey(b.time));
  }

  // ── Load instrument ───────────────────────────────────────────────────────
  const loadInstrument = useCallback(
    async (inst: Instrument, iv: Interval) => {
      if (!candleRef.current || !volRef.current || !chartRef.current) return;

      // Every load takes a ticket. Switching symbol (or interval) while a fetch is in
      // flight leaves that fetch running; without this it resumes afterwards and writes
      // the *previous* instrument's bars over the new ones. loadMoreHistory checks the
      // same ticket, so a background page-in can't merge old bars into a new symbol
      // either — which leaves the series holding rows the renderer cannot resolve.
      const ticket = ++loadTicketRef.current;

      // A timeframe switch reloads the same instrument. The greek overlays reconstruct their own
      // 1m history independent of the candle interval and re-snap onto whatever bar grid is loaded,
      // so they stay on and are repainted below once the new bars land.
      const prev = currentInstRef.current;
      const sameInstrument =
        !!prev &&
        getSymbol(prev) === getSymbol(inst) &&
        (prev.exchange || 'NSE') === (inst.exchange || 'NSE');

      if (currentInstRef.current) {
        const oldSym = getSymbol(currentInstRef.current);
        unsubscribeChart({ indexes: [oldSym] }, iv, currentInstRef.current.exchange || 'NSE');
        if (nubraType(currentInstRef.current) === 'OPT') unsubscribeOptTickWs();
      }
      oi.clearForInstrumentChange();
      if (!sameInstrument) {
        vega.clearForInstrumentChange();
        theta.clearForInstrumentChange();
        ivOverlay.clearForInstrumentChange();
      }

      currentInstRef.current = inst;
      if (nubraType(inst) === 'OPT') {
        optAssetRef.current = (inst.asset || '').toUpperCase();
        optExpiryRef.current = String(inst.expiry ?? '');
        optRefIdRef.current = inst.ref_id ?? null;
        optStrikeRef.current = inst.strike_price ? inst.strike_price / 100 : null;
        optTypeRef.current = (inst.option_type as 'CE' | 'PE' | undefined) || null;
      } else {
        optAssetRef.current = null;
        optExpiryRef.current = null;
        optRefIdRef.current = null;
        optStrikeRef.current = null;
        optTypeRef.current = null;
      }
      allBarsRef.current = [];
      allVolBarsRef.current = [];
      earliestRef.current = null;
      lastBarRef.current = null;
      dayOpenRef.current = null;
      hasReachedEarliestRef.current = false;
      lastLoadTimeRef.current = 0;
      stopCountdown();
      setLoading('Loading historical data…');
      setPriceDisplay(null);
      setOhlc(null);
      // Drop the outgoing instrument's bars now rather than at the end of the fetch.
      // Otherwise a live tick for the incoming symbol (currentInstRef already points at
      // it) lands as an `update` against the outgoing symbol's series, and a failed load
      // leaves the previous symbol's candles on screen under the new symbol's name.
      candleRef.current.setData([]);
      volRef.current.setData([]);

      try {
        const end = new Date();
        let start = new Date(end.getTime() - historyDays(iv) * 86400000);
        let { bars, volBars } = await fetchRange(inst, iv, start, end);
        // A fixed trailing window can miss the last session entirely: 1m looks back 3 days, so on
        // a Monday after ~15:30, or after a holiday, it lands on nothing but the weekend and the
        // chart reads "No historical data". Widen until the last session is inside the window.
        for (const days of EMPTY_RETRY_DAYS) {
          if (bars.length || !isIntradayInterval(iv) || days <= historyDays(iv)) continue;
          if (!isChartLive(chartRef.current) || ticket !== loadTicketRef.current) return;
          start = new Date(end.getTime() - days * 86400000);
          ({ bars, volBars } = await fetchRange(inst, iv, start, end));
        }
        // The pane can be closed (or the whole workspace swapped out for the strategy
        // view) while this is in flight — re-check rather than write to a dead chart.
        if (!isChartLive(chartRef.current) || !candleRef.current || !volRef.current) return;
        if (ticket !== loadTicketRef.current) return; // superseded by a newer load
        const sanitized = sanitizeCandles(bars);
        const cleanBars = dedupeAndSortBars(sanitized);
        const cleanVolBars = dedupeAndSortBars(volBars);
        if (!cleanBars.length) {
          // Say something immediately, then refine. The probe below is a second round trip, and an
          // empty pane with no message at all while it runs would be worse than a vague one.
          setLoading('No historical data available.');
          if (nubraType(inst) === 'OPT') {
            const searchedDays = Math.round((end.getTime() - start.getTime()) / 86400000);
            const detail = await describeEmptyOptionHistory(inst, iv, searchedDays);
            // A newer load may have started during the probe; it owns the message now.
            if (ticket === loadTicketRef.current) setLoading(detail);
          }
          return;
        }

        allBarsRef.current = cleanBars;
        allVolBarsRef.current = cleanVolBars;
        earliestRef.current = start;
        lastBarRef.current = cleanBars[cleanBars.length - 1];
        dayOpenRef.current = cleanBars[0].open;

        candleRef.current.setData(
          cleanBars.map((b) => ({
            time: b.time,
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
          })) as Parameters<typeof candleRef.current.setData>[0],
        );
        volRef.current.setData(
          cleanVolBars.map((v) => ({ time: v.time, value: v.value, color: v.color })) as Parameters<
            typeof volRef.current.setData
          >[0],
        );
        // The price scale is the same object across symbol switches (the series is
        // never recreated). If the user had dragged the right axis on the previous
        // symbol, autoScale stays off and the new symbol's candles render against
        // the old price range — force it back on for every freshly loaded symbol.
        candleRef.current.priceScale().applyOptions({ autoScale: true });

        const len = cleanBars.length;
        chartRef.current
          .timeScale()
          .setVisibleLogicalRange({ from: Math.max(0, len - 60), to: len + 5 });
        setLoading(null);
        // No-ops unless an overlay survived a timeframe switch; the new bar grid changes each
        // overlay's draw signature, so this re-snaps their lines onto it.
        vega.refresh();
        theta.refresh();
        ivOverlay.refresh();
        startCountdown();
        updatePriceDisplay(lastBarRef.current.close, dayOpenRef.current);
        setOhlc({
          o: lastBarRef.current.open,
          h: lastBarRef.current.high,
          l: lastBarRef.current.low,
          c: lastBarRef.current.close,
        });

        const chartSym = getSymbol(inst);
        subscribeChart({ indexes: [chartSym] }, iv, inst.exchange || 'NSE');
        if (nubraType(inst) === 'OPT') {
          subscribeOptTickWs(
            inst.asset || chartSym,
            String(inst.expiry ?? ''),
            inst.exchange || 'NSE',
          );
        }
      } catch (err: unknown) {
        setLoading(`Error: ${(err as Error).message}`);
      }
    },
    [unsubscribeChart, subscribeChart],
  );

  useEffect(() => {
    if (!instrument) return;
    loadInstrument(instrument, interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, interval]);

  /** Prepend older bars to the loaded series and repaint. Shared by scroll-back and "Go to". */
  function mergeOlderBars(bars: OhlcBar[], volBars: VolBar[]) {
    const mergedBars = dedupeAndSortBars([...sanitizeCandles(bars), ...allBarsRef.current]);
    const mergedVolBars = dedupeAndSortBars([...volBars, ...allVolBarsRef.current]);
    allBarsRef.current = mergedBars;
    allVolBarsRef.current = mergedVolBars;
    if (mergedBars.length > 0) dayOpenRef.current = mergedBars[0].open;
    // Guarded because callers resume after an await — the pane may be gone by now.
    if (!isChartLive(chartRef.current)) return;
    candleRef.current?.setData(
      mergedBars.map((b) => ({
        time: b.time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })) as Parameters<typeof candleRef.current.setData>[0],
    );
    volRef.current?.setData(
      mergedVolBars.map((v) => ({
        time: v.time,
        value: v.value,
        color: v.color,
      })) as Parameters<typeof volRef.current.setData>[0],
    );
    // The bar grid grew to the left; greek points that fell before it can now be placed.
    vega.refresh();
    theta.refresh();
    ivOverlay.refresh();
  }

  /**
   * Jump to a date (and, on intraday charts, a time) in IST — TradingView's "Go to".
   *
   * Everything between the target and what is already loaded is fetched, so the series stays
   * contiguous back to the present and scrolling either way keeps working. Resolves to a note for
   * the popover when the data does not reach that far, or '' when the jump landed.
   */
  async function goToDate(dateStr: string, timeStr: string): Promise<string> {
    const inst = currentInstRef.current;
    if (!inst || !isChartLive(chartRef.current) || !earliestRef.current) {
      return 'Load a symbol first.';
    }
    const iv = intervalRef.current;
    const intraday = isIntradayInterval(iv);
    const hhmm = intraday && /^\d{2}:\d{2}$/.test(timeStr) ? timeStr : '00:00';
    // Chart times carry IST baked in, so the IST wall clock read as UTC is already a chart time.
    const wallMs = Date.parse(`${dateStr}T${hhmm}:00Z`);
    if (!Number.isFinite(wallMs)) return 'Enter a valid date.';
    const targetKey = intraday ? wallMs / 1000 : Number(dateStr.replace(/-/g, ''));
    const targetUtcMs = wallMs - IST_OFFSET * 1000;

    // Never interleave with a scroll-triggered page-in: both write earliestRef and the series.
    const ticket = loadTicketRef.current;
    while (isLoadingRef.current) {
      await new Promise((r) => setTimeout(r, 50));
      if (ticket !== loadTicketRef.current) return '';
    }
    isLoadingRef.current = true;
    setLoadMore(true);
    try {
      // One chunk of context to the left of the target, so it does not sit on the edge of the data.
      const want = targetUtcMs - chunkDays(iv) * 86400000;
      const pieceMs = (intraday ? GOTO_INTRADAY_PIECE_DAYS : GOTO_DAILY_PIECE_DAYS) * 86400000;
      const bars: OhlcBar[] = [];
      const volBars: VolBar[] = [];
      let end = earliestRef.current.getTime() - 60000;
      while (end > want) {
        const start = Math.max(want, end - pieceMs);
        const piece = await fetchRange(inst, iv, new Date(start), new Date(end));
        if (ticket !== loadTicketRef.current) return '';
        earliestRef.current = new Date(start);
        bars.push(...piece.bars);
        volBars.push(...piece.volBars);
        // A whole empty piece is longer than any closure: the data has run out before the target.
        if (!piece.bars.length && end - start >= EMPTY_GAP_LIMIT_DAYS * 86400000) {
          hasReachedEarliestRef.current = true;
          break;
        }
        end = start - 60000;
      }
      if (bars.length) mergeOlderBars(bars, volBars);

      const chart = chartRef.current;
      const all = allBarsRef.current;
      if (!isChartLive(chart) || !all.length) return 'No candles loaded for this symbol.';
      let idx = all.findIndex((b) => sortKey(b.time) >= targetKey);
      if (idx < 0) idx = all.length - 1;
      const range = chart.timeScale().getVisibleLogicalRange();
      const span = Math.max(30, range ? range.to - range.from : 120);
      chart.timeScale().setVisibleLogicalRange({ from: idx - span / 2, to: idx + span / 2 });
      candleRef.current?.priceScale().applyOptions({ autoScale: true });
      containerRef.current?.focus();
      return sortKey(all[0].time) > targetKey
        ? `${iv} data only goes back to ${fmtCrosshairTime(all[0].time)} — showing the earliest candles.`
        : '';
    } catch (e) {
      return `Could not load history: ${(e as Error).message}`;
    } finally {
      isLoadingRef.current = false;
      setLoadMore(false);
    }
  }

  async function loadMoreHistory() {
    const now = Date.now();
    if (
      isLoadingRef.current ||
      hasReachedEarliestRef.current ||
      !earliestRef.current ||
      !currentInstRef.current
    )
      return;
    if (now - lastLoadTimeRef.current < 500) return;
    isLoadingRef.current = true;
    lastLoadTimeRef.current = now;
    const ticket = loadTicketRef.current;
    setLoadMore(true);
    try {
      const inst = currentInstRef.current;
      const iv = intervalRef.current;
      const step = chunkDays(iv);
      // An empty page is usually a weekend or a holiday, not the start of history, so keep stepping
      // back; only a gap longer than any market closure means the data has actually run out.
      const maxGapDays = Math.max(EMPTY_GAP_LIMIT_DAYS, step * 2);
      let end = new Date(earliestRef.current.getTime() - 60000);
      for (let gapDays = 0; ; gapDays += step) {
        if (gapDays >= maxGapDays) {
          hasReachedEarliestRef.current = true;
          break;
        }
        const start = new Date(end.getTime() - step * 86400000);
        const { bars, volBars } = await fetchRange(inst, iv, start, end);
        // A symbol/interval switch during this fetch invalidates the page-in entirely:
        // allBarsRef now belongs to a different instrument, so merging into it would
        // splice two symbols' bars together.
        if (ticket !== loadTicketRef.current) return;
        earliestRef.current = start;
        if (bars.length > 0) {
          mergeOlderBars(bars, volBars);
          break;
        }
        end = new Date(start.getTime() - 60000);
      }
    } catch (e) {
      console.warn('[Chart] loadMoreHistory failed:', e);
    } finally {
      // In a finally so the superseded-ticket return above cannot leave the
      // page-in latch stuck on, which would block all further history loading.
      isLoadingRef.current = false;
      setLoadMore(false);
    }
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  function startCountdown() {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = window.setInterval(tickCountdown, 1000);
    tickCountdown();
  }
  function stopCountdown() {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  }
  function tickCountdown() {
    if (!intervalRef.current || !currentInstRef.current) {
      stopCountdown();
      return;
    }
    const nowUtc = Math.floor(Date.now() / 1000);
    const istSec = (nowUtc + IST_OFFSET) % 86400;
    // The bar countdown only means anything inside the instrument's own session,
    // and MCX runs to 23:30 rather than 15:30.
    const { openMin, closeMin } = marketSession(currentInstRef.current.exchange);
    if (istSec < openMin * 60 || istSec > closeMin * 60) {
      setCountdown(null);
      return;
    }
    const intSec = intervalToSeconds(intervalRef.current);
    const elapsed = (nowUtc + IST_OFFSET) % intSec;
    const remaining = intSec - elapsed;
    const mm = Math.floor(remaining / 60)
      .toString()
      .padStart(2, '0');
    const ss = (remaining % 60).toString().padStart(2, '0');
    setCountdown(`${mm}:${ss}`);
    updateCountdownPosition();
  }
  function updateCountdownPosition() {
    if (!lastBarRef.current || !candleRef.current) return;
    try {
      const y = candleRef.current.priceToCoordinate(lastBarRef.current.close);
      if (y != null && !isNaN(y)) setCountdownY(Math.round(y) + 13);
    } catch {}
  }

  function updatePriceDisplay(price: number, open: number) {
    const diff = price - (open || price);
    const pct = open ? ((diff / open) * 100).toFixed(2) : '0.00';
    const up = diff >= 0;
    setPriceDisplay({ price, diff, pct, up });
  }

  function resetZoom() {
    if (!chartRef.current || !allBarsRef.current.length) return;
    const len = allBarsRef.current.length;
    chartRef.current
      .timeScale()
      .setVisibleLogicalRange({ from: Math.max(0, len - 60), to: len + 5 });
    candleRef.current?.priceScale().applyOptions({ autoScale: true });
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const sym = instrument ? getSymbol(instrument) : '—';
  symRef.current = sym;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="chart-toolbar">
      <div className="chart-quote-row">
        <span className="text-base font-bold text-[var(--text-primary)]">{sym}</span>
        {priceDisplay && (
          <>
            <span
              className={`text-[17px] font-bold ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
            >
              ₹{fmtPrice(priceDisplay.price)}
            </span>
            <span
              className={`text-[13px] font-medium ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
            >
              {priceDisplay.up ? '+' : ''}
              {priceDisplay.diff.toFixed(2)} ({priceDisplay.up ? '+' : ''}
              {priceDisplay.pct}%)
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
              onClick={() =>
                addToWatchlist({
                  displayName: sym,
                  underlying: instrument.asset || sym,
                  exchange: instrument.exchange || 'NSE',
                  ref_id: instrument.ref_id,
                  nubraName: getSymbol(instrument),
                  optionType: instrument.option_type as 'CE' | 'PE' | undefined,
                  strike: instrument.strike_price ? instrument.strike_price / 100 : undefined,
                  expiry: instrument.expiry ? String(instrument.expiry) : undefined,
                  ltpAtAdd: priceDisplay?.price ?? 0,
                })
              }
              className="px-1.5 py-1 rounded text-[11px] font-semibold text-amber-400 bg-amber-500/15 hover:bg-amber-500/30 border border-amber-500/30 transition-all"
              title="Add to watchlist"
            >
              ★
            </button>
          </div>
        )}

        <div className="chart-inline-tools" aria-label="Chart indicators">
        {/* Volume toggle */}
        <div className="relative ml-1">
          <button
            onClick={() => setShowVol((v) => !v)}
            aria-pressed={showVol}
            title="Show traded volume below the price chart"
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-all ${
              showVol
                ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Volume
          </button>
        </div>

        {/* OI Profile — left=toggle, right=settings caret */}
        <div className="relative flex items-stretch">
          <button
            onClick={oi.toggleOI}
            aria-pressed={oi.oiOn}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-l text-xs font-medium border border-r-0 transition-all ${
              oi.oiOn
                ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span
              className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${oi.oiOn ? 'bg-white/30 border-white/60' : 'border-current opacity-60'}`}
            >
              {oi.oiOn && <span className="text-[8px] font-bold leading-none">✓</span>}
            </span>
            OI Profile
          </button>
          <button
            onClick={oi.openSettings}
            aria-label="Open interest profile settings"
            className={`px-1.5 py-1 rounded-r text-xs font-medium border border-l-0 transition-all ${
              oi.oiOn
                ? 'bg-[var(--accent)] border-[var(--accent)] text-white hover:opacity-80'
                : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            ▾
          </button>

          {oi.showOiPopup && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[290px] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                  OI Profile Settings
                </span>
                <button
                  onClick={() => oi.setShowOiPopup(false)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none"
                >
                  ×
                </button>
              </div>

              <div className="px-4 py-3 flex flex-col gap-4">
                {oi.oiExpiries.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">
                      EXPIRES INCLUDED
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {oi.oiExpiries.map((exp) => (
                        <label
                          key={exp}
                          className="flex items-center gap-2 cursor-pointer select-none"
                        >
                          <input
                            type="checkbox"
                            checked={oi.selExpiries.includes(exp)}
                            onChange={(e) =>
                              oi.setSelExpiries((prev) =>
                                e.target.checked ? [...prev, exp] : prev.filter((x) => x !== exp),
                              )
                            }
                            className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                          />
                          <span className="text-[12px] text-[var(--text-primary)]">
                            {formatExpiry(exp)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">
                    VISUAL SETTINGS
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                    <input
                      type="checkbox"
                      checked={oi.showCalls}
                      onChange={(e) => oi.setShowCalls(e.target.checked)}
                      className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                    />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">CALLS</span>
                    <span
                      className="w-4 h-4 rounded-sm shrink-0"
                      style={{ backgroundColor: '#22c55e' }}
                    />
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={oi.showPuts}
                      onChange={(e) => oi.setShowPuts(e.target.checked)}
                      className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                    />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">PUTS</span>
                    <span
                      className="w-4 h-4 rounded-sm shrink-0"
                      style={{ backgroundColor: '#ef4444' }}
                    />
                  </label>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border)]">
                <button
                  onClick={() => oi.setShowOiPopup(false)}
                  className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                >
                  Cancel
                </button>
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

        {/* Aggregate Vega / Theta / IV overlays */}
        <GreekButton api={vega} label="Vega" />
        <GreekButton api={theta} label="Theta" />
        <GreekButton api={ivOverlay} label="IV" />

        {/* Reset zoom */}
        <button
          onClick={resetZoom}
          className="px-2 py-1 rounded text-[11px] font-medium bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all ml-1"
          title="Reset zoom to latest candles"
          aria-label="Reset chart to latest candles"
        >
          <UiIcon name="reset" size={14} />
        </button>
        </div>

        <span className="chart-market-label text-[11px] text-[var(--text-muted)]">{instrument?.exchange || 'NSE'} <span className="mx-1">·</span> {interval} candles</span>
      </div>
      <div className="chart-tools-row chart-navigation-row">
        <button className="shell-button" title="Fit all loaded candles" onClick={() => { chartRef.current?.timeScale().fitContent(); candleRef.current?.priceScale().applyOptions({ autoScale: true }); }}>Fit</button>
        <button
          ref={goToBtnRef}
          className="shell-button"
          title="Go to a date (Alt+G)"
          aria-expanded={goToOpen}
          onClick={() => setGoToOpen((v) => !v)}
        >
          Go to
        </button>
        {goToOpen && goToBtnRef.current && (
          <GoToDatePopover
            anchor={goToBtnRef.current}
            intraday={isIntradayInterval(interval)}
            defaultTime={minToHHMM(marketSession(instrument?.exchange).openMin)}
            onGo={goToDate}
            onClose={() => setGoToOpen(false)}
          />
        )}

        {/* Interval buttons */}
        <div className="chart-timeframes" role="group" aria-label="Chart timeframe">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              aria-pressed={interval === iv}
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
      </div>

      {/* Chart container */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 bg-[var(--bg-primary)]"
        onMouseDown={oi.handleMouseDown}
        onMouseMove={oi.handleMouseMove}
        onMouseLeave={oi.handleMouseLeave}
        onWheel={() => oi.requestDraw()}
        onDoubleClick={resetZoom}
      >
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[5]" />

        {/* Widened drag handles over the price/Greek pane boundaries — see ChartPaneResizer */}
        <ChartPaneResizer
          chartRef={chartRef}
          containerRef={containerRef}
          refreshKey={`${vega.on}:${vega.method}:${theta.on}:${theta.method}:${ivOverlay.on}`}
        />

        {/* Crosshair tooltip — positioned imperatively by bindCandleCrosshair */}
        <div
          ref={tooltipRef}
          className="absolute z-30 hidden pointer-events-none rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 shadow-2xl"
          style={{ minWidth: 150 }}
        />

        {/* OI time range slider */}
        {oi.oiOn && (
          <OiTimeSlider
            fromTime={oi.oiFromTime}
            toTime={oi.oiToTime}
            onChange={oi.handleSliderChange}
            onReset={oi.resetTimeRange}
            isChangeMode={oi.oiMode === 'oi_change'}
            exchange={instrument?.exchange}
          />
        )}

        {/* OHLC overlay */}
        {ohlc && (
          <div className="chart-legend">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]">
              <span className="text-[var(--text-muted)] text-[11px]">O</span>
              <span className="text-[var(--text-primary)] font-medium">{ohlc.o.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">H</span>
              <span className="text-[var(--green)] font-medium">{ohlc.h.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">L</span>
              <span className="text-[var(--red)] font-medium">{ohlc.l.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">C</span>
              <span className="text-[var(--text-primary)] font-medium">{ohlc.c.toFixed(2)}</span>
              {ohlc.vol && (
                <>
                  <span className="text-[var(--text-muted)] text-[11px] ml-1">Vol</span>
                  <span className="text-[var(--text-primary)] font-medium">{fmtVol(ohlc.vol)}</span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] text-[14px] z-10">
            <div className="chart-empty" role="status">
              {loading.startsWith('Loading') ? <div className="spinner" /> : <UiIcon name="trade" size={28} />}
              <p>{loading}</p>
              {loading.startsWith('Error') && instrument && <button className="shell-button border border-[var(--border)]" onClick={() => loadInstrument(instrument, interval)}>Retry loading chart</button>}
              {!instrument && <span className="text-[12px] text-[var(--text-muted)]">Press / to find an instrument.</span>}
            </div>
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
              top: Math.max(
                4,
                Math.min(oi.oiHover.y - 58, (containerRef.current?.clientHeight ?? 400) - 120),
              ),
            }}
          >
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl px-4 py-3 min-w-[178px]">
              <div className="text-[14px] font-semibold text-[var(--text-primary)] mb-2 pb-1.5 border-b border-[var(--border)]">
                Strike {oi.oiHover.strike.toLocaleString('en-IN')}
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px] mb-1">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#22c55e] shrink-0" />
                  <span className="text-[var(--text-muted)]">
                    {oi.oiMode === 'oi_change' ? 'Call Δ' : 'Call OI'}
                  </span>
                </div>
                <span
                  className={`font-medium tabular-nums ${oi.oiMode === 'oi_change' ? (oi.oiHover.ceOi >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]') : 'text-[var(--text-primary)]'}`}
                >
                  {oi.oiMode === 'oi_change'
                    ? `${oi.oiHover.ceOi >= 0 ? '+' : ''}${fmtOI(Math.abs(oi.oiHover.ceOi))}`
                    : fmtOI(oi.oiHover.ceOi)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#ef4444] shrink-0" />
                  <span className="text-[var(--text-muted)]">
                    {oi.oiMode === 'oi_change' ? 'Put Δ' : 'Put OI'}
                  </span>
                </div>
                <span
                  className={`font-medium tabular-nums ${oi.oiMode === 'oi_change' ? (oi.oiHover.peOi >= 0 ? 'text-[#ef4444]' : 'text-[#22c55e]') : 'text-[var(--text-primary)]'}`}
                >
                  {oi.oiMode === 'oi_change'
                    ? `${oi.oiHover.peOi >= 0 ? '+' : ''}${fmtOI(Math.abs(oi.oiHover.peOi))}`
                    : fmtOI(oi.oiHover.peOi)}
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
      <div className="chart-status">
        <span>{!wsReady ? 'Reconnecting · prices may be out of date' : lastBarRef.current ? `Latest candle: ${fmtCrosshairTime(lastBarRef.current.time)}${isIntradayInterval(interval) ? ' IST' : ''}` : 'Waiting for chart data'}</span>
        <span className="chart-shortcuts">Scroll to zoom · Drag to pan · Double-click to reset</span>
      </div>
    </div>
  );
}

// ── Go to date ────────────────────────────────────────────────────────────────
function minToHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** Today's IST calendar day — the date picker's default and its max. */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);
}

/**
 * TradingView-style "Go to" tray: a date and, on intraday charts, a time, both IST.
 *
 * Portalled to document.body and placed from the anchor's rect: the chart panes sit inside several
 * `overflow-hidden` ancestors (see GreekControls), which would clip an in-flow dropdown.
 */
function GoToDatePopover({
  anchor,
  intraday,
  defaultTime,
  onGo,
  onClose,
}: {
  anchor: HTMLElement;
  intraday: boolean;
  defaultTime: string;
  onGo: (date: string, time: string) => Promise<string>;
  onClose: () => void;
}) {
  const [date, setDate] = useState(istToday);
  const [time, setTime] = useState(defaultTime);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    // Fixed-position and measured once, so close rather than drift away from the button.
    const onMove = () => onCloseRef.current();
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onMove);
    };
  }, [anchor]);

  const rect = anchor.getBoundingClientRect();
  const width = 272;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!date || busy) return;
    setBusy(true);
    setNote('');
    const result = await onGo(date, time);
    setBusy(false);
    if (result) setNote(result);
    else onCloseRef.current();
  }

  const field =
    'w-full px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]';

  return createPortal(
    <form
      ref={ref}
      onSubmit={submit}
      role="dialog"
      aria-label="Go to date"
      className="fixed bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl p-3 flex flex-col gap-2.5"
      style={{ left, top: rect.bottom + 6, width, zIndex: 150 }}
    >
      <div className="text-[13px] font-semibold text-[var(--text-primary)]">Go to</div>
      <div className="flex gap-2">
        <label className="flex-1 flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
          DATE
          <input
            type="date"
            autoFocus
            required
            value={date}
            max={istToday()}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </label>
        {intraday && (
          <label className="w-[92px] flex flex-col gap-1 text-[10px] text-[var(--text-muted)]">
            TIME (IST)
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className={field}
            />
          </label>
        )}
      </div>
      {note && <div className="text-[11px] text-amber-500 leading-relaxed">{note}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => onCloseRef.current()}
          className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !date}
          className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-dim)] disabled:opacity-50"
        >
          {busy ? 'Loading…' : 'Go to'}
        </button>
      </div>
    </form>,
    document.body,
  );
}

// ── API fetch ─────────────────────────────────────────────────────────────────
export function nubraType(item: Instrument): string {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type || '').toUpperCase();
  if (dt === 'FUT' || at === 'FUT') return 'FUT';
  if (dt === 'OPT' || at === 'OPT') return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

/** How far back the daily probe looks before concluding a contract has simply never traded. */
const EMPTY_PROBE_DAYS = 365;

/**
 * Explain an option chart that came back with no candles.
 *
 * One daily request over a year separates "this strike is too far out of the money to have traded
 * this week" from "this contract has never traded at all" — the first is fixed by switching to 1d,
 * the second by picking a different strike, and the old shared message pointed at neither.
 *
 * Only for options: an index or an equity returning nothing means something is actually wrong, and
 * a probe would just delay saying so. Failures fall back to the original wording rather than
 * asserting anything the probe did not establish.
 */
async function describeEmptyOptionHistory(
  instrument: Instrument,
  interval: string,
  /** Lookback the load actually searched — wider than `historyDays` once an empty load retried. */
  windowDays: number = historyDays(interval),
): Promise<string> {
  // Nothing to learn from probing at the same resolution the request already used.
  if (!isIntradayInterval(interval)) return 'No historical data available.';
  try {
    const end = new Date();
    const start = new Date(end.getTime() - EMPTY_PROBE_DAYS * 86400000);
    const { bars } = await fetchRange(instrument, '1d', start, end);
    const last = bars[bars.length - 1]?.time;
    return emptyHistoryMessage({
      interval,
      windowDays,
      probeDays: EMPTY_PROBE_DAYS,
      lastTradedDay: typeof last === 'object' ? last : null,
    });
  } catch {
    return emptyHistoryMessage({ interval, windowDays });
  }
}

export async function fetchRange(
  instrument: Instrument,
  interval: string,
  startDate: Date,
  endDate: Date,
): Promise<{ bars: OhlcBar[]; volBars: VolBar[] }> {
  const type = nubraType(instrument);
  const symbol = getSymbol(instrument);
  const exch = instrument.exchange || 'NSE';
  // 1s/10s are retained for a rolling 7 days, and a request that reaches past that
  // edge 500s the whole query instead of returning the part that is in range.
  const start = clampSubMinuteStart(startDate, interval);

  const body = {
    query: [
      {
        exchange: exch,
        type,
        values: [symbol],
        fields: ['open', 'high', 'low', 'close', 'cumulative_volume'],
        startDate: start.toISOString(),
        endDate: endDate.toISOString(),
        interval,
        intraDay: false,
        realTime: false,
      },
    ],
  };

  const res = await fetch('/api/historical', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    result?: Array<{
      values: Array<
        Record<
          string,
          {
            open?: Array<{ ts?: string; v: number }>;
            high?: Array<{ v: number }>;
            low?: Array<{ v: number }>;
            close?: Array<{ v: number }>;
            cumulative_volume?: Array<{ v: number }>;
          }
        >
      >;
    }>;
    error?: string;
  };
  if (data.error) throw new Error(data.error);

  const bars: OhlcBar[] = [],
    volBars: VolBar[] = [];

  for (const group of data.result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        const opens = chart.open || [];
        const highs = chart.high || [];
        const lows = chart.low || [];
        const closes = chart.close || [];
        const vols = chart.cumulative_volume || [];
        const len = Math.min(opens.length, highs.length, lows.length, closes.length);

        for (let i = 0; i < len; i++) {
          const tsNs = opens[i]?.ts;
          if (tsNs == null) continue;
          const oVal = opens[i]?.v;
          const hVal = highs[i]?.v;
          const lVal = lows[i]?.v;
          const cVal = closes[i]?.v;
          if (oVal == null || hVal == null || lVal == null || cVal == null) continue;
          const o = Number(oVal) / 100,
            h = Number(hVal) / 100,
            l = Number(lVal) / 100,
            c = Number(cVal) / 100;
          if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || o <= 0 || c <= 0) continue;
          const t = toChartTime(BigInt(tsNs), interval);
          const validH = Math.max(h, o, l, c);
          const validL = Math.min(l, o, h, c);
          bars.push({ time: t, open: o, high: validH, low: validL, close: c });
          if (vols[i]?.v) {
            volBars.push({
              time: t,
              value: Number(vols[i].v),
              color: c >= o ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
            });
          }
        }
      }
    }
  }

  bars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  volBars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return { bars, volBars };
}
