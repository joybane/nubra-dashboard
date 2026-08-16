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
import { bindGreekCrosshair } from './lib/greekTooltip';
import { fetchRange, nubraType } from './CandleChart';
import { isChartLive, removeChart } from './lib/chartLifecycle';
import type { Instrument, OhlcBar, OhlcvData, WsMessage } from './types';
import { getSymbol } from './types';
import {
  IST_OFFSET,
  barsToSessionLine,
  fmtPrice,
  isMarketSessionChartTime,
  sortKey,
} from './lib/utils';

// The Tracker always charts an index line (NIFTY by default) at 1-minute resolution,
// stitched with live per-tick updates, and overlays aggregate Vega / Theta *inline*
// on the same pane (no separate sub-pane below).
const NIFTY: Instrument = {
  display_name: 'NIFTY',
  asset: 'NIFTY',
  nubra_name: 'NIFTY',
  derivative_type: 'INDEX',
  exchange: 'NSE',
};

const TRACK_IV = '1m'; // older days + the live WS subscription interval
const TICK_IV = '1s'; // today's session loads at 1s, stitched onto the 1m history
const HIST_DAYS = 7; // last 7 days of 1-minute history
const CHUNK_DAYS = 5; // load-more chunk when scrolling further back
const TICK_VIEW_BARS = 5_400; // initial visible window when today is 1s (~90 min)
const DETAIL_WINDOW_SEC = 2 * 60 * 60;
type Resolution = '1m' | '1s';

function normalizeChartName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^(NSE|BSE)_/, '')
    .replace(/\s+/g, '');
}

/** True if an IST-baked chart-time (seconds) falls on the same IST calendar day as `nowMs`. */
function isSameISTDay(chartTimeSec: unknown, nowMs: number): boolean {
  if (typeof chartTimeSec !== 'number') return false;
  const barDay = new Date(chartTimeSec * 1000).toISOString().slice(0, 10); // IST baked in
  const nowDay = new Date(nowMs + IST_OFFSET * 1000).toISOString().slice(0, 10);
  return barDay === nowDay;
}

/**
 * Today's session at 1-second resolution.
 *
 * Sub-minute data is `1s` or `10s` only — `5s` is accepted but returns nothing, and
 * `15s`/`30s` 500. It is retained for a rolling **7×24 hours**, not the three months
 * the vendor docs claim for "intervals below a day" (measured 2026-08-03: at 21:07
 * IST, 27 Jul 20:00 IST returned 500 and 27 Jul 22:00 IST returned data). Requesting
 * a window that straddles that edge fails the *whole* query with a 500 rather than
 * clipping, so callers must clamp — see `clampSubMinuteStart`.
 *
 * `intraDay:true` is used here because this function only ever wants today, but it is
 * not a requirement: `intraDay:false` with an explicit range works anywhere inside the
 * 7-day window.
 *
 * INDEX values return `close` ONLY — requesting OHLC 500s with "db error" — so fetch
 * close-only and synthesize a flat o/h/l/c (the line uses close; the greek overlay only
 * needs bar times). Works for stocks and MCX futures too. Note 1s bars are tick-driven,
 * not filled: NIFTY yields ~1 per second, a crude future far fewer. Returns [] on
 * holiday / pre-open / unsupported instrument → caller keeps the 1m history.
 */
async function fetchTodayTick(instrument: Instrument): Promise<OhlcBar[]> {
  const now = Date.now();
  const body = {
    query: [
      {
        exchange: instrument.exchange || 'NSE',
        type: nubraType(instrument),
        values: [getSymbol(instrument)],
        fields: ['close'],
        startDate: new Date(now - 86_400_000).toISOString(), // ignored by intraDay, sent for shape
        endDate: new Date(now).toISOString(),
        interval: TICK_IV,
        intraDay: true,
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
      values: Array<Record<string, { close?: Array<{ ts?: string; v: number }> }>>;
    }>;
    error?: string;
  };
  if (data.error) throw new Error(data.error);

  const bars: OhlcBar[] = [];
  for (const group of data.result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        for (const pt of chart.close || []) {
          if (pt.ts == null) continue;
          const t = Number(BigInt(pt.ts) / 1_000_000_000n) + IST_OFFSET; // IST-baked seconds
          const c = pt.v / 100;
          bars.push({ time: t, open: c, high: c, low: c, close: c });
        }
      }
    }
  }
  bars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return bars.filter((b) => isMarketSessionChartTime(b.time, instrument.exchange));
}

/**
 * Can this instrument stand in as the thing being tracked? Indices always could.
 * MCX publishes no spot for a commodity — every option chain settles into a
 * specific future, and `chain.cp` is that future's price — so an MCX future is
 * the underlying and belongs here too.
 */
function isTrackableUnderlying(inst: Instrument): boolean {
  const type = nubraType(inst);
  if (type === 'INDEX') return true;
  return type === 'FUT' && (inst.exchange || '').toUpperCase() === 'MCX';
}

interface Props {
  instrument: Instrument | null;
  theme: 'dark' | 'light';
}

export default function Tracker({ instrument, theme }: Props) {
  // Track the passed instrument if it is an underlying, otherwise default to NIFTY.
  // Commodities have no spot index — the front-month future *is* the underlying,
  // so an MCX future is trackable in exactly the way an index is.
  const tracked = instrument && isTrackableUnderlying(instrument) ? instrument : NIFTY;
  const trackedExchange = tracked.exchange || 'NSE';

  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const allBarsRef = useRef<OhlcBar[]>([]);
  const minuteBarsRef = useRef<OhlcBar[]>([]);
  const secondBarsRef = useRef<OhlcBar[]>([]);
  const activeResRef = useRef<Resolution>('1m');
  const switchingRef = useRef(false);
  const currentInstRef = useRef<Instrument | null>(null);
  const earliestRef = useRef<Date | null>(null);
  const dayOpenRef = useRef<number | null>(null);
  const isLoadingRef = useRef(false);
  const symRef = useRef('');

  const [loading, setLoading] = useState<string | null>('Loading…');
  const [priceDisplay, setPriceDisplay] = useState<{
    price: number;
    diff: number;
    pct: string;
    up: boolean;
  } | null>(null);

  const { subscribe, subscribeChart, unsubscribeChart } = useWs();

  const vega = useGreekOverlay({
    greek: 'vega',
    chartRef,
    currentInstRef,
    allBarsRef,
    inline: true,
  });
  const theta = useGreekOverlay({
    greek: 'theta',
    chartRef,
    currentInstRef,
    allBarsRef,
    inline: true,
  });
  const iv = useGreekOverlay({ greek: 'iv', chartRef, currentInstRef, allBarsRef, inline: true });

  const sym = getSymbol(tracked);
  symRef.current = sym;

  // ── Chart init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === 'dark';

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor: isDark ? '#c9d1d9' : '#131722',
        fontSize: 13,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
      timeScale: {
        borderColor: isDark ? '#2a2d32' : '#e0e3eb',
        timeVisible: true,
        secondsVisible: true,
        shiftVisibleRangeOnNewBar: true,
        minBarSpacing: 0.05,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    const line = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      // barsToSessionLine paints each session's last point SESSION_BREAK_COLOR to stop the line
      // running into the next session; without this the hover dot would vanish on that bar, since
      // its colour otherwise follows the point's.
      crosshairMarkerBackgroundColor: '#2962ff',
    } as Partial<LineSeriesOptions>);
    lineRef.current = line;

    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      chart.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(containerRef.current);

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (!range || isLoadingRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMore();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      handleResolutionRange(range);
    });

    const onDblClick = () => {
      const len = allBarsRef.current.length;
      if (len)
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 120), to: len + 5 });
      line.priceScale().applyOptions({ autoScale: true });
    };
    containerRef.current.addEventListener('dblclick', onDblClick);

    // ── Crosshair tooltip: NIFTY price + every visible greek series at the cursor ─
    const unbindCrosshair =
      tooltipRef.current && containerRef.current
        ? bindGreekCrosshair({
            chart,
            container: containerRef.current,
            tooltip: tooltipRef.current,
            baseSeries: () => lineRef.current,
            baseLabel: () => symRef.current,
            formatBase: (v) => '₹' + fmtPrice(v),
          })
        : () => {};

    return () => {
      containerRef.current?.removeEventListener('dblclick', onDblClick);
      observer.disconnect();
      unbindCrosshair();
      removeChart(chart);
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
  }, [vega.on, theta.on, iv.on]);

  // ── Theme sync ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const isDark = theme === 'dark';
    chartRef.current.applyOptions({
      layout: {
        background: { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor: isDark ? '#c9d1d9' : '#131722',
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
    });
  }, [theme]);

  function updatePrice(close: number, open: number | null) {
    const base = open ?? close;
    const diff = close - base;
    setPriceDisplay({
      price: close,
      diff,
      pct: base ? ((diff / base) * 100).toFixed(2) : '0.00',
      up: diff >= 0,
    });
  }

  function marketBars(bars: OhlcBar[]) {
    return bars.filter((b) => isMarketSessionChartTime(b.time, trackedExchange));
  }

  function toLine(bars: OhlcBar[]) {
    return barsToSessionLine(bars, trackedExchange) as Parameters<
      NonNullable<typeof lineRef.current>['setData']
    >[0];
  }

  function rangeTouchesToday(from: number, to: number): boolean {
    const today = new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);
    const fromDay = new Date(from * 1000).toISOString().slice(0, 10);
    const toDay = new Date(to * 1000).toISOString().slice(0, 10);
    return fromDay <= today && today <= toDay;
  }

  function refreshGreekGrid() {
    vega.refresh();
    theta.refresh();
    iv.refresh();
  }

  function setActiveResolution(res: Resolution, visibleRange?: { from: unknown; to: unknown }) {
    const bars =
      res === '1s' && secondBarsRef.current.length ? secondBarsRef.current : minuteBarsRef.current;
    if (!bars.length || activeResRef.current === res) return;
    switchingRef.current = true;
    activeResRef.current = res;
    allBarsRef.current = bars;
    lineRef.current?.setData(toLine(bars));
    refreshGreekGrid();
    if (visibleRange && chartRef.current) {
      requestAnimationFrame(() => {
        try {
          chartRef.current?.timeScale().setVisibleRange(visibleRange as any);
        } catch {
          /* ignore */
        }
        switchingRef.current = false;
      });
    } else {
      switchingRef.current = false;
    }
  }

  function handleResolutionRange(range: { from: unknown; to: unknown } | null) {
    if (!range || switchingRef.current || !minuteBarsRef.current.length) return;
    const from = Number(range.from);
    const to = Number(range.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return;
    const span = to - from;
    if (activeResRef.current === '1s' && span > DETAIL_WINDOW_SEC) {
      setActiveResolution('1m', range);
    } else if (
      activeResRef.current === '1m' &&
      span <= DETAIL_WINDOW_SEC &&
      secondBarsRef.current.length &&
      rangeTouchesToday(from, to)
    ) {
      setActiveResolution('1s', range);
    }
  }

  function upsertLastBar(bars: OhlcBar[], bar: OhlcBar): OhlcBar {
    const last = bars[bars.length - 1];
    const lastTime = last && typeof last.time === 'number' ? last.time : 0;
    let next = bar;
    if (typeof bar.time === 'number' && bar.time < lastTime) next = { ...bar, time: lastTime };
    if (lastTime === next.time) bars[bars.length - 1] = next;
    else bars.push(next);
    return next;
  }

  // ── Live ticks → update the current 1-minute point (tick-by-tick line) ───────
  useEffect(() => {
    const unsub = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !lineRef.current) return;
      const data = msg.data as OhlcvData;
      const want = normalizeChartName(sym);
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const bname = normalizeChartName(b.indexname || '');
        if (bname === want) {
          applyBucket(b as Record<string, string>);
          break;
        }
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
      const tickStr = b.timestamp && b.timestamp !== '0' ? b.timestamp : b.bucket_timestamp;
      if (!tickStr || tickStr === '0' || !/^\d+$/.test(tickStr)) return;
      const utcSec = Number(BigInt(tickStr) / 1_000_000_000n);
      const close = Number(b.close) / 100;
      if (!close) return;

      const tickTime = utcSec + IST_OFFSET;
      if (!isMarketSessionChartTime(tickTime, trackedExchange)) return;
      const minuteTime = Math.floor(tickTime / 60) * 60;
      const open = Number(b.open) / 100 || close;
      const high = Number(b.high) / 100 || close;
      const low = Number(b.low) / 100 || close;
      const minuteBar = upsertLastBar(minuteBarsRef.current, {
        time: minuteTime,
        open,
        high,
        low,
        close,
      });
      const secondBar = upsertLastBar(secondBarsRef.current, {
        time: tickTime,
        open,
        high,
        low,
        close,
      });
      const activeBar = activeResRef.current === '1s' ? secondBar : minuteBar;
      allBarsRef.current =
        activeResRef.current === '1s' ? secondBarsRef.current : minuteBarsRef.current;
      lineRef.current?.update({ time: activeBar.time, value: activeBar.close } as Parameters<
        NonNullable<typeof lineRef.current>['update']
      >[0]);
      updatePrice(close, dayOpenRef.current);
      // 1-second chart time; never decrease — lightweight-charts update() requires
      // non-decreasing time, so out-of-order/same-second ticks overwrite the last point.
      // Keep allBarsRef (the grid the greek overlay snaps to) in sync with the live tail.
    } catch {
      /* ignore malformed tick */
    }
  }

  // ── Load (history + subscribe) ───────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!lineRef.current || !chartRef.current) return;

    if (currentInstRef.current) {
      const oldSym = getSymbol(currentInstRef.current);
      unsubscribeChart({ indexes: [oldSym] }, TRACK_IV, currentInstRef.current.exchange || 'NSE');
    }
    vega.clearForInstrumentChange();
    theta.clearForInstrumentChange();
    iv.clearForInstrumentChange();

    currentInstRef.current = tracked;
    allBarsRef.current = [];
    minuteBarsRef.current = [];
    secondBarsRef.current = [];
    activeResRef.current = '1m';
    switchingRef.current = false;
    earliestRef.current = null;
    dayOpenRef.current = null;
    setPriceDisplay(null);
    setLoading('Loading historical data…');

    try {
      const end = new Date();
      const start = new Date(end.getTime() - HIST_DAYS * 86400000);
      const fetched = await fetchRange(tracked, TRACK_IV, start, end);
      const bars = marketBars(fetched.bars);
      if (!bars.length) {
        setLoading('No historical data available.');
        return;
      }

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
          combined = [...older, ...dayBars]; // replace today's 1m section with 1s bars
          secondTail = true;
        }
      } catch {
        /* sub-minute unavailable → keep the 1m history */
      }

      // Two awaits happened above; the pane may have closed in the meantime. Writing
      // to a removed chart throws a frame later from inside lightweight-charts.
      if (!isChartLive(chartRef.current) || !lineRef.current) return;

      minuteBarsRef.current = bars;
      secondBarsRef.current = secondTail ? combined : [];
      activeResRef.current = secondTail ? '1s' : '1m';
      allBarsRef.current = secondTail ? secondBarsRef.current : minuteBarsRef.current;
      earliestRef.current = start;
      dayOpenRef.current = allBarsRef.current[0].open;
      lineRef.current.setData(toLine(allBarsRef.current));

      const len = allBarsRef.current.length;
      const tail = secondTail ? TICK_VIEW_BARS : 120; // ~90 min at 1s, else last 120 × 1m
      chartRef.current
        .timeScale()
        .setVisibleLogicalRange({ from: Math.max(0, len - tail), to: len + 5 });
      // Force a rescale: switching scripts (e.g. NIFTY→BANKNIFTY) must not leave the
      // price axis frozen at the previous instrument's range, which clips the new line.
      lineRef.current.priceScale().applyOptions({ autoScale: true });
      setLoading(null);
      updatePrice(allBarsRef.current[allBarsRef.current.length - 1].close, dayOpenRef.current);

      subscribeChart({ indexes: [sym] }, TRACK_IV, tracked.exchange || 'NSE');
    } catch (err: unknown) {
      setLoading(`Error: ${(err as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym]);

  useEffect(() => {
    load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [sym]);

  async function loadMore() {
    if (isLoadingRef.current || !earliestRef.current) return;
    isLoadingRef.current = true;
    try {
      const end = new Date(earliestRef.current.getTime() - 60000);
      const start = new Date(end.getTime() - CHUNK_DAYS * 86400000);
      const fetched = await fetchRange(tracked, TRACK_IV, start, end);
      const bars = marketBars(fetched.bars);
      if (bars.length) {
        minuteBarsRef.current = [...bars, ...minuteBarsRef.current];
        if (secondBarsRef.current.length)
          secondBarsRef.current = [...bars, ...secondBarsRef.current];
        allBarsRef.current =
          activeResRef.current === '1s' && secondBarsRef.current.length
            ? secondBarsRef.current
            : minuteBarsRef.current;
        earliestRef.current = start;
        lineRef.current?.setData(toLine(allBarsRef.current));
        refreshGreekGrid();
      }
    } catch {
      /* ignore */
    }
    isLoadingRef.current = false;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
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

        <span className="text-[10px] text-[var(--text-muted)] ml-1">
          line · auto 1m/1s · live tick
        </span>

        <div className="ml-auto flex items-center gap-2">
          <GreekButton api={vega} label="Vega" />
          <GreekButton api={theta} label="Theta" />
          <GreekButton api={iv} label="IV" />
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
