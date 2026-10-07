import { chartTheme } from './lib/chartTheme';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesOptions,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import { TICK_WINDOW_MAX_MS, useGreekOverlay } from './hooks/useGreekOverlay';
import ChartNavigator from './components/ChartNavigator';
import { GreekButton } from './components/GreekControls';
import { bindGreekCrosshair } from './lib/greekTooltip';
import { fetchRange, nubraType } from './CandleChart';
import { isChartLive, removeChart } from './lib/chartLifecycle';
import { chartDayKey, dayBaseline, type DayBaseline } from './lib/dayChange';
import type { Instrument, OhlcBar, OhlcvData, Theme, WsMessage } from './types';
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
// Settle time before a zoom/pan asks the greek overlays for 1s history. Each window is a few MB
// per measure, so a drag must not fire one per frame.
const TICK_WINDOW_DEBOUNCE_MS = 400;
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
  theme: Theme;
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
  // Fixed per load: '1s' when today's session loaded at 1s (stitched onto older 1m days), else
  // '1m'. It never switches with the view — see the note in load().
  const activeResRef = useRef<Resolution>('1m');
  const currentInstRef = useRef<Instrument | null>(null);
  const earliestRef = useRef<Date | null>(null);
  // What the header's day change is measured from — see lib/dayChange.
  const dayBaselineRef = useRef<DayBaseline | null>(null);
  const isLoadingRef = useRef(false);
  const symRef = useRef('');
  // showLatest() was called while the chart had no width; redo it on first size.
  const latestPendingRef = useRef(false);

  const [loading, setLoading] = useState<string | null>('Loading…');
  // The live (last) bar is off screen — shows the jump-to-now button.
  const [awayFromLive, setAwayFromLive] = useState(false);
  // The chart as state (not only a ref) so the navigator re-binds once it exists: a child's
  // effects run before this component's, when `chartRef` is still empty.
  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [navVersion, setNavVersion] = useState(0);
  const tickTimerRef = useRef<number | null>(null);
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
    tickWindows: true,
  });
  const theta = useGreekOverlay({
    greek: 'theta',
    chartRef,
    currentInstRef,
    allBarsRef,
    inline: true,
    tickWindows: true,
  });
  const iv = useGreekOverlay({ greek: 'iv', chartRef, currentInstRef, allBarsRef, inline: true });
  // The chart's range subscription is bound once at mount; it reads the overlays through this.
  const tickGreeksRef = useRef([vega, theta]);
  tickGreeksRef.current = [vega, theta];

  const sym = getSymbol(tracked);
  symRef.current = sym;

  // ── Chart init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme !== 'light';

    const chart = createChart(containerRef.current, {
      ...chartTheme(theme),
      rightPriceScale: { borderColor: isDark ? '#2b3340' : '#dce2ec', minimumWidth: 72 },
      timeScale: {
        borderColor: isDark ? '#2b3340' : '#dce2ec',
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
      if (latestPendingRef.current && el.clientWidth > 0) showLatest();
    });
    observer.observe(containerRef.current);

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (range) setAwayFromLive(range.to < allBarsRef.current.length - 1);
      if (!range || isLoadingRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMore();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange(() => scheduleTickWindow());

    const container = containerRef.current;
    const onDblClick = () => showLatest();
    container.addEventListener('dblclick', onDblClick);

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

    setChartApi(chart);

    return () => {
      setChartApi(null);
      if (tickTimerRef.current != null) clearTimeout(tickTimerRef.current);
      container.removeEventListener('dblclick', onDblClick);
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
    chartRef.current.applyOptions(chartTheme(theme));
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

  function refreshGreekGrid() {
    vega.refresh();
    theta.refresh();
    iv.refresh();
  }

  /**
   * Once the view settles on today's 1s bars zoomed in to TICK_WINDOW_MAX_MS or less, ask Vega and
   * Theta for per-second history of that span — their stored history is 1m, so without this the
   * greek lines are straight segments between minutes under a tick-by-tick price line.
   */
  function scheduleTickWindow() {
    if (tickTimerRef.current != null) clearTimeout(tickTimerRef.current);
    tickTimerRef.current = window.setTimeout(() => {
      tickTimerRef.current = null;
      if (activeResRef.current !== '1s' || !isChartLive(chartRef.current)) return;
      let range: { from: unknown; to: unknown } | null = null;
      try {
        range = chartRef.current?.timeScale().getVisibleRange() ?? null;
      } catch {
        return;
      }
      if (!range) return;
      // Only today's section is 1s; a view that also shows yesterday's close at its left edge
      // would otherwise measure ~18 h (overnight included) and never get per-second greeks.
      const bars = allBarsRef.current;
      const midnight =
        Date.parse(
          `${new Date(Number(bars[bars.length - 1]?.time) * 1000).toISOString().slice(0, 10)}T00:00:00Z`,
        ) / 1000; // IST baked in
      let lo = 0,
        hi = bars.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(bars[mid].time) < midnight) lo = mid + 1;
        else hi = mid;
      }
      if (lo >= bars.length) return;
      const fromMs = (Math.max(Number(range.from), Number(bars[lo].time)) - IST_OFFSET) * 1000;
      const toMs = (Number(range.to) - IST_OFFSET) * 1000;
      if (!(toMs > fromMs) || toMs - fromMs > TICK_WINDOW_MAX_MS) return;
      for (const g of tickGreeksRef.current)
        if (g.enabledRef.current) g.loadTickWindow(fromMs, toMs);
    }, TICK_WINDOW_DEBOUNCE_MS);
  }

  // Turning a measure on while already zoomed in moves no range, so nothing else would ask.
  useEffect(() => {
    if (vega.on || theta.on) scheduleTickWindow();
  }, [vega.on, theta.on]);

  /**
   * Jump to the live end, like TradingView's "scroll to realtime": the last ~90 min of today's 1s
   * session (or the last 120 × 1m when today has no 1s data), price axis re-fitted.
   *
   * The window never reaches back past today's open. Early in the session the 1s section is
   * shorter than TICK_VIEW_BARS and the bars before it are earlier days' 1m — a plain tail would
   * open on a week-wide view whose centre (which the navigator strip follows) is some past day.
   */
  function showLatest() {
    const chart = chartRef.current;
    if (!isChartLive(chart) || !lineRef.current) return;
    // A zero-width chart (the pane not laid out yet, or mounted in a hidden tab) drops the range
    // below, and the view then shows wherever the library's own fit lands. Redo it on first size.
    if (!containerRef.current?.clientWidth) {
      latestPendingRef.current = true;
      return;
    }
    latestPendingRef.current = false;
    const bars = allBarsRef.current;
    const len = bars.length;
    if (!len) return;
    let from = Math.max(0, len - (activeResRef.current === '1s' ? TICK_VIEW_BARS : 120));
    if (activeResRef.current === '1s') {
      const lastDay = new Date(Number(bars[len - 1].time) * 1000).toISOString().slice(0, 10);
      let dayStart = len - 1;
      while (
        dayStart > from &&
        new Date(Number(bars[dayStart - 1].time) * 1000).toISOString().slice(0, 10) === lastDay
      )
        dayStart--;
      from = dayStart;
    }
    try {
      chart!.timeScale().setVisibleLogicalRange({ from, to: len + 5 });
      lineRef.current.priceScale().applyOptions({ autoScale: true });
    } catch {
      /* chart removed */
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
      if (!dayBaselineRef.current || chartDayKey(minuteTime) !== dayBaselineRef.current.day)
        dayBaselineRef.current = dayBaseline(minuteBarsRef.current);
      updatePrice(close, dayBaselineRef.current?.price ?? null);
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
    earliestRef.current = null;
    dayBaselineRef.current = null;
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

      // The chart shows this one stitched set for the whole visit — today at 1s, older days
      // at 1m — and never swaps datasets as the view moves. It used to drop to the 1m set
      // whenever the view touched a past day: that re-laid the chart out (today shrinks 60×
      // in bars), so a scroll near the day boundary jumped and rescaled mid-gesture, and the
      // swap's autoScale reset mid-drag crashed the library's price-scale pan.
      minuteBarsRef.current = bars;
      secondBarsRef.current = secondTail ? combined : [];
      activeResRef.current = secondTail ? '1s' : '1m';
      allBarsRef.current = secondTail ? secondBarsRef.current : minuteBarsRef.current;
      earliestRef.current = start;
      dayBaselineRef.current = dayBaseline(minuteBarsRef.current);
      lineRef.current.setData(toLine(allBarsRef.current));

      // Opens on the live end. Its autoScale re-fit also matters on a script switch (e.g.
      // NIFTY→BANKNIFTY): the price axis must not stay frozen at the previous range.
      showLatest();
      setLoading(null);
      setNavVersion((v) => v + 1);
      updatePrice(
        allBarsRef.current[allBarsRef.current.length - 1].close,
        dayBaselineRef.current?.price ?? null,
      );

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
        setNavVersion((v) => v + 1);
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
          line · 1s today, 1m history · live tick
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
        {awayFromLive && !loading && (
          <button
            type="button"
            onClick={showLatest}
            title="Go to now (double-click the chart does the same)"
            className="absolute z-20 bottom-9 right-[84px] w-7 h-7 flex items-center justify-center rounded-md border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-secondary)] shadow-lg hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M3 3l4 4-4 4M8 3l4 4-4 4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] pointer-events-none">
            {loading}
          </div>
        )}
      </div>
      <ChartNavigator chart={chartApi} bars={() => minuteBarsRef.current} version={navVersion} />
    </div>
  );
}
