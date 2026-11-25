/**
 * One signal day, in two views:
 *
 *  - Trade: the underlying, the prices of the legs the trade sold (with the entry price drawn across),
 *    and the P&L through the day — each leg and the total. The total's last point is the table's P&L.
 *  - Greeks: spot and the reference strangle's premiums on top, then a pane per chosen greek with the
 *    reference CE and PE side by side. The dots at t1 and t2 are the numbers the table row shows.
 *
 * Reads GET /api/signal-backtest/day, which serves the same cache the run reads, so the chart and the
 * table cannot disagree.
 */
import { cachedJson, cachedValue, dayUrl } from '../lib/explorerCache';
import { useEffect, useRef, useState } from 'react';
import {
  BaselineSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { removeChart } from '../lib/chartLifecycle';
import { chartTheme } from '../lib/chartTheme';
import {
  GREEKS,
  dteBadge,
  dteLabel,
  inr,
  legEntryPrice,
  num,
  slotOf,
  tradePnlSeries,
  type GreekKey,
  type Grid,
  type SignalBacktestRow,
  type SignalDayResponse,
  type SignalUnderlying,
} from '../lib/signalBacktest';
import type { Theme } from '../types';

const CE_COLOR = '#22c55e';
const PE_COLOR = '#ef4444';
const SPOT_COLOR = '#60a5fa';
const MARK_COLOR = '#f59e0b';
const TOTAL_UP = '#22c55e';
const TOTAL_DOWN = '#ef4444';

const GREEKS_KEY = 'nubra-signal-backtest-chart-greeks';
const VIEW_KEY = 'nubra-signal-backtest-chart-view';
const DEFAULT_GREEKS: GreekKey[] = ['delta', 'theta', 'vega'];
const CHART_CONTROL =
  'h-7 rounded px-2 font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] aria-pressed:bg-[var(--bg-card)] aria-pressed:font-semibold aria-pressed:text-[var(--accent)] aria-pressed:shadow-sm';

type View = 'trade' | 'greeks';

function loadGreeks(): GreekKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(GREEKS_KEY) ?? 'null') as unknown;
    if (Array.isArray(raw)) {
      const known = GREEKS.map((g) => g.key);
      const kept = known.filter((k) => raw.includes(k));
      if (kept.length) return kept;
    }
  } catch {
    /* private mode or corrupt value — use the default */
  }
  return DEFAULT_GREEKS;
}

function saveGreeks(keys: GreekKey[]): void {
  try {
    localStorage.setItem(GREEKS_KEY, JSON.stringify(keys));
  } catch {
    /* settings just won't persist */
  }
}

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'greeks' ? 'greeks' : 'trade';
  } catch {
    return 'trade';
  }
}

function saveView(view: View): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* the view just won't be remembered */
  }
}

/** Wall-clock IST drawn as UTC, the convention every chart in the app uses, so the axis reads IST. */
function sessionStart(date: string): number {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 9, 15) / 1000;
}

const clockOf = (t: Time) => new Date((t as number) * 1000).toISOString().slice(11, 16);

/** A chart in `box` with the axes both views share. */
function baseChart(box: HTMLElement, theme: Theme, embedded: boolean): IChartApi {
  const appearance = chartTheme(theme);
  const report = box.closest('.te-report-detail');
  const style = report ? getComputedStyle(box) : null;
  const reportLayout = style
    ? {
        ...appearance.layout,
        background: { type: ColorType.Solid, color: style.getPropertyValue('--bg-card').trim() },
        textColor: style.getPropertyValue('--text-muted').trim(),
        fontFamily: 'Report Mono, Consolas, monospace',
      }
    : appearance.layout;
  const scale = { visible: true, borderVisible: false, scaleMargins: { top: 0.24, bottom: 0.12 } };
  return createChart(box, {
    ...appearance,
    width: box.clientWidth,
    height: box.clientHeight,
    layout: reportLayout,
    leftPriceScale: scale,
    rightPriceScale: scale,
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      minBarSpacing: 0.15,
      rightOffsetPixels: 18,
    },
    ...(embedded && {
      handleScroll: { mouseWheel: false },
      handleScale: { mouseWheel: false },
    }),
  });
}

/** Keep minute slots on the shared time scale even when the spot feed has gaps. */
function spotTimeline(grid: Grid, timeOf: (i: number) => UTCTimestamp) {
  return Array.from(grid, (value, i) =>
    value == null ? { time: timeOf(i) } : { time: timeOf(i), value },
  );
}

/** Resize and fit together, so two observers cannot overwrite each other's time scale. */
function frameSessionOnResize(chart: IChartApi, box: HTMLElement) {
  chart.timeScale().fitContent();
  let width = box.clientWidth;
  let height = box.clientHeight;
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const nextWidth = box.clientWidth;
      const nextHeight = box.clientHeight;
      if (!nextWidth || !nextHeight || (width === nextWidth && height === nextHeight)) return;
      chart.resize(nextWidth, nextHeight);
      if (width !== nextWidth) chart.timeScale().fitContent();
      width = nextWidth;
      height = nextHeight;
    });
  });
  observer.observe(box);
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  };
}

/** Pane widgets are created by the chart on its first drawing frame. */
function labelPanes(chart: IChartApi, labels: string[]) {
  const frame = requestAnimationFrame(() => {
    chart.panes().forEach((pane, index) => {
      const row = pane.getHTMLElement();
      if (!(row instanceof HTMLTableRowElement) || !labels[index]) return;
      const label = document.createElement('span');
      label.className =
        'signal-day-pane-label pointer-events-none absolute left-2 top-[5px] z-[3] whitespace-nowrap rounded bg-[var(--bg-card)] px-1 py-px font-sans text-[11px] font-semibold leading-normal text-[var(--text-primary)]';
      label.textContent = labels[index];
      row.cells[1]?.append(label);
    });
  });
  return () => cancelAnimationFrame(frame);
}

function SeriesKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[var(--text-primary)]">
      <span aria-hidden className="h-0.5 w-3 rounded" style={{ background: color }} />
      {label}
    </span>
  );
}

const tradeExtremes = (trade: SignalBacktestRow['trade']) => [
  { time: trade.maxProfitTime, label: 'Best', value: trade.maxProfit, color: TOTAL_UP },
  { time: trade.maxLossTime, label: 'Worst', value: trade.maxLoss, color: TOTAL_DOWN },
];

type HoverValue = {
  series: ISeriesApi<'Line' | 'Baseline'>;
  color: string;
  format: (value: number) => string;
};

type HoverRow = {
  label: string;
  values: HoverValue[];
  bold?: boolean;
};

type HoverGroup = { label: string; rows: HoverRow[]; legs?: boolean };

/** Set up one set of value nodes per chart and paint at most once per animation frame. */
function watchHover(
  chart: IChartApi,
  box: HTMLElement,
  tip: HTMLElement | null,
  groups: HoverGroup[],
  trade?: SignalBacktestRow['trade'],
) {
  if (!tip) return () => {};
  const panel = tip;
  type Paint = (event: MouseEventParams<Time>, clock: string) => void;
  let paint: Paint | undefined;
  let previousTime: Time | undefined;
  let anchorRight: boolean | undefined;
  let latest: MouseEventParams<Time> | undefined;
  let frame = 0;

  function buildTip(): Paint {
    const title = document.createElement('div');
    title.className = 'border-b border-[var(--border)] pb-1 font-mono font-semibold tabular-nums';
    const timestamp = document.createTextNode('');
    title.append(timestamp);
    panel.append(title);
    const updates: Paint[] = [];

    for (const group of groups) {
      const section = document.createElement('section');
      section.className = 'border-b border-[var(--border)] py-1 last:border-0 last:pb-0';
      const header = document.createElement('div');
      header.className = 'flex items-center gap-2 font-semibold text-[var(--text-muted)]';
      const heading = document.createElement('span');
      heading.className = 'mr-auto';
      heading.textContent = group.label;
      header.append(heading);
      if (group.legs) {
        for (const text of ['CE', 'PE']) {
          const cell = document.createElement('span');
          cell.className = 'w-[4.25rem] text-right';
          cell.textContent = text;
          header.append(cell);
        }
      }
      section.append(header);

      for (const row of group.rows) {
        const line = document.createElement('div');
        line.className = 'flex items-center gap-2' + (row.bold ? ' font-semibold' : '');
        const label = document.createElement('span');
        label.className = 'mr-auto flex items-center gap-1.5 whitespace-nowrap';
        label.append(row.label);
        const swatch = group.legs ? null : document.createElement('span');
        if (swatch) {
          swatch.className = 'h-1.5 w-1.5 shrink-0 rounded-sm';
          swatch.setAttribute('aria-hidden', 'true');
          label.prepend(swatch);
        }
        line.append(label);

        for (const reading of row.values) {
          const cell = document.createElement('span');
          cell.className = 'text-right font-mono tabular-nums' + (group.legs ? ' w-[4.25rem]' : '');
          const node = document.createTextNode('—');
          cell.append(node);
          line.append(cell);
          if (swatch && reading.color !== 'sign') swatch.style.backgroundColor = reading.color;
          let lastColor: string | undefined;
          updates.push((event) => {
            const value = (event.seriesData.get(reading.series) as LineData<Time> | undefined)
              ?.value;
            const text = value == null ? '—' : reading.format(value);
            if (node.data !== text) node.data = text;
            if (swatch && reading.color === 'sign') {
              const color = (value ?? 0) >= 0 ? TOTAL_UP : TOTAL_DOWN;
              if (lastColor !== color) swatch.style.backgroundColor = color;
              lastColor = color;
            }
          });
        }
        section.append(line);
      }
      if (trade && group.label === 'P&L') {
        for (const extreme of tradeExtremes(trade)) {
          const line = document.createElement('div');
          line.className = 'flex justify-between gap-2';
          line.style.display = 'none';
          const label = document.createElement('span');
          label.textContent = extreme.label;
          const value = document.createElement('span');
          value.className = 'font-mono tabular-nums';
          value.textContent = inr(extreme.value);
          line.append(label, value);
          section.append(line);
          updates.push((_event, clock) => {
            const display = clock === extreme.time ? '' : 'none';
            if (line.style.display !== display) line.style.display = display;
          });
        }
      }
      panel.append(section);
    }

    return (event, clock) => {
      timestamp.data = clock;
      for (const update of updates) update(event, clock);
    };
  }

  function leave() {
    cancelAnimationFrame(frame);
    frame = 0;
    latest = undefined;
    panel.hidden = true;
  }

  function move(event: MouseEventParams<Time>) {
    if (event.time == null || !event.point) {
      leave();
      return;
    }
    latest = event;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = latest;
      latest = undefined;
      if (next?.time == null || !next.point) return;
      if (previousTime !== next.time) {
        paint ??= buildTip();
        paint(next, clockOf(next.time));
        previousTime = next.time;
      }
      // Anchor opposite the cursor using the chart model's width, with no layout reads.
      const right = next.point.x < chart.timeScale().width() / 2;
      if (anchorRight !== right) {
        panel.style.left = right ? 'auto' : '8px';
        panel.style.right = right ? '8px' : 'auto';
        anchorRight = right;
      }
      panel.hidden = false;
    });
  }

  chart.subscribeCrosshairMove(move);
  box.addEventListener('pointerleave', leave);
  return () => {
    chart.unsubscribeCrosshairMove(move);
    box.removeEventListener('pointerleave', leave);
    leave();
    panel.replaceChildren();
  };
}

function addTradePnlPane(
  chart: IChartApi,
  trade: SignalBacktestRow['trade'],
  closes: Array<Grid | null>,
  timeOf: (i: number) => UTCTimestamp,
  paneIndex: number,
): HoverRow[] {
  const readable: HoverRow[] = [];
  const colorOf = (kind: 'CE' | 'PE') => (kind === 'CE' ? CE_COLOR : PE_COLOR);
  const line = (grid: Grid) =>
    grid.flatMap((v, i) => (v == null ? [] : [{ time: timeOf(i), value: v }]));
  // Pane 1: P&L. Each leg thin, the total bold and shaded either side of zero. With one leg the
  // total is that leg, so it is drawn once.
  const pnl = tradePnlSeries(trade, closes);
  const pnlFormat = {
    type: 'custom',
    minMove: 1,
    formatter: (value: number) => `${value < 0 ? '−' : ''}₹${num(Math.abs(value), 0)}`,
  } as const;
  if (trade.legs.length > 1) {
    trade.legs.forEach((leg, n) => {
      const s = chart.addSeries(
        LineSeries,
        {
          color: colorOf(leg.kind),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: pnlFormat,
        },
        paneIndex,
      );
      s.setData(line(pnl.legs[n]));
      readable.push({
        label: `${leg.kind} P&L`,
        values: [{ series: s, color: colorOf(leg.kind), format: inr }],
      });
    });
  }
  const total = chart.addSeries(
    BaselineSeries,
    {
      baseValue: { type: 'price', price: 0 },
      topLineColor: TOTAL_UP,
      topFillColor1: 'rgba(34,197,94,0.28)',
      topFillColor2: 'rgba(34,197,94,0.03)',
      bottomLineColor: TOTAL_DOWN,
      bottomFillColor1: 'rgba(239,68,68,0.03)',
      bottomFillColor2: 'rgba(239,68,68,0.28)',
      lineWidth: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: pnlFormat,
    },
    paneIndex,
  );
  total.setData(line(pnl.total));
  total.createPriceLine({
    price: 0,
    color: MARK_COLOR,
    lineWidth: 1,
    lineStyle: LineStyle.Dotted,
    axisLabelVisible: false,
    title: '',
  });
  // The markers sit on the close line. The hover readout gives the high/low-based extremes.
  createSeriesMarkers(
    total,
    tradeExtremes(trade)
      .filter(({ time }) => pnl.total[slotOf(time)] != null)
      .sort((a, b) => slotOf(a.time) - slotOf(b.time))
      .map(({ time, label, color }) => ({
        time: timeOf(slotOf(time)),
        position: label === 'Best' ? 'aboveBar' : 'belowBar',
        shape: label === 'Best' ? 'arrowDown' : 'arrowUp',
        size: 0.8,
        color,
        text: label,
      })),
  );
  readable.push({
    label: trade.legs.length > 1 ? 'Total P&L' : 'P&L',
    values: [{ series: total, color: 'sign', format: inr }],
    bold: true,
  });

  return readable;
}

interface Props {
  /** The detail pane already supplies date navigation and close controls. */
  embedded?: boolean;
  /** Reuse the Trade Explorer's day cache (its data only changes on "Update data"). */
  cached?: boolean;
  theme: Theme;
  underlying: SignalUnderlying;
  row: SignalBacktestRow;
  onClose: () => void;
  /** Move to the previous (-1) or next (1) day in the table. */
  onStep?: (delta: -1 | 1) => void;
  canStep?: { prev: boolean; next: boolean };
  /** Prices for minutes the stored data does not hold, for a leg whose prices ran out. */
  fillLegs?: Array<{ kind: 'CE' | 'PE'; strike: number; close: Grid }>;
}

export default function SignalDayChart({
  theme,
  underlying,
  row,
  onClose,
  onStep,
  canStep,
  fillLegs,
  embedded = false,
  cached = false,
}: Props) {
  const [data, setData] = useState<SignalDayResponse | null>(() =>
    cached ? (cachedValue<SignalDayResponse>(dayUrl(underlying, row)) ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [shown, setShown] = useState<GreekKey[]>(loadGreeks);
  const [canDraw, setCanDraw] = useState(!embedded);
  const boxRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  // Load the data immediately, then mount the canvases as the chart approaches the scrollport.
  useEffect(() => {
    const box = boxRef.current;
    if (!embedded || !box || canDraw) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        setCanDraw(true);
      },
      { root: box.closest('.te-report-scroll'), rootMargin: '160px 0px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [embedded, canDraw]);

  const { ceStrike, peStrike } = row.signal.legs;
  // The legs the trade sold, so the server can send their prices; the row's price source tells it
  // where a strike beyond the day's ladder lives.
  const tradeLegs = row.trade.legs.map((l) => `${l.kind}:${l.strike}`).join(',');

  useEffect(() => {
    if (cached) {
      const url = dayUrl(underlying, row);
      const hit = cachedValue<SignalDayResponse>(url);
      setData(hit ?? null);
      setError(null);
      if (hit) return;
      let live = true;
      cachedJson<SignalDayResponse | { ok: false; error?: string }>(url)
        .then((body) => {
          if (!body.ok) throw new Error(('error' in body && body.error) || 'No day data');
          if (live) setData(body);
        })
        .catch((e: unknown) => {
          if (live) setError(e instanceof Error ? e.message : String(e));
        });
      return () => {
        live = false;
      };
    }
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    const qs = new URLSearchParams({
      underlying,
      date: row.date,
      source: row.source,
      ceStrike: String(ceStrike),
      peStrike: String(peStrike),
      legs: tradeLegs,
    });
    if (row.ohlcSource) qs.set('ohlc', row.ohlcSource);
    fetch(`/api/signal-backtest/day?${qs}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json()) as SignalDayResponse | { ok: false; error?: string };
        if (!res.ok || !body.ok) {
          throw new Error(('error' in body && body.error) || `HTTP ${res.status}`);
        }
        setData(body);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => ctrl.abort();
    // `row` itself is read only through the keys listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, row.date, row.source, row.ohlcSource, ceStrike, peStrike, tradeLegs, cached]);

  // ── Trade view ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (view !== 'trade' || !canDraw || !box || !data?.legs) return;
    const trade = row.trade;
    const start = sessionStart(data.date);
    const timeOf = (i: number) => (start + i * 60) as UTCTimestamp;
    const line = (grid: Grid) =>
      grid.flatMap((v, i) => (v == null ? [] : [{ time: timeOf(i), value: v }]));
    const colorOf = (kind: 'CE' | 'PE') => (kind === 'CE' ? CE_COLOR : PE_COLOR);
    const selling = trade.side === 'SELL';

    const chart = baseChart(box, theme, embedded);

    // Pane 0: the underlying on the right axis, the prices of the legs sold on the left — one pane,
    // so a move in the underlying and the premium it caused are read against the same time.
    const spot = chart.addSeries(
      LineSeries,
      {
        color: SPOT_COLOR,
        lineWidth: 2,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: { type: 'price', minMove: 1, precision: 0 },
      },
      0,
    );
    spot.setData(spotTimeline(data.spot, timeOf));
    const entryIdx = slotOf(trade.entryTime);
    const exitIdx = slotOf(trade.exitTime);
    const spotMarks: SeriesMarker<Time>[] = (
      [
        [slotOf(row.signal.t1), 't1', 'aboveBar'],
        [slotOf(row.signal.t2), 't2', 'aboveBar'],
        // t2 and the entry are usually a minute apart: the entry goes under the line.
        [entryIdx, 'entry', 'belowBar'],
        [exitIdx, 'exit', 'aboveBar'],
      ] as const
    )
      .filter(([i]) => data.spot[i] != null)
      .sort(([a], [b]) => a - b)
      .map(([i, text, position]) => ({
        time: timeOf(i),
        position,
        shape: position === 'belowBar' ? 'arrowUp' : 'arrowDown',
        color: MARK_COLOR,
        size: 0.8,
        text,
      }));
    createSeriesMarkers(spot, spotMarks);

    // The prices of the legs the trade sold, the entry price drawn across each.
    const closes = trade.legs.map((leg) => {
      const got =
        data.legs!.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close ?? null;
      const fill = fillLegs?.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close;
      return got && fill ? got.map((v, i) => v ?? fill[i]) : got;
    });
    const prices: HoverRow[] = [
      { label: 'Spot', values: [{ series: spot, color: SPOT_COLOR, format: num }] },
    ];
    trade.legs.forEach((leg, n) => {
      const close = closes[n];
      if (!close) return;
      const color = colorOf(leg.kind);
      const s = chart.addSeries(
        LineSeries,
        {
          color,
          lineWidth: 2,
          priceScaleId: 'left',
          priceLineVisible: false,
          lastValueVisible: false,
        },
        0,
      );
      s.setData(line(close));
      s.createPriceLine({
        price: legEntryPrice(leg),
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      const legExit = slotOf(leg.exitTime);
      // Both legs trade in the same minutes: the call's labels go above its line, the put's below.
      createSeriesMarkers(
        s,
        (
          [
            [
              entryIdx,
              selling ? 'sell' : 'buy',
              `${selling ? 'sold' : 'bought'} ${num(legEntryPrice(leg))}`,
            ],
            [legExit, selling ? 'buy' : 'sell', ''],
          ] as const
        )
          .filter(([i]) => close[i] != null)
          .map(([i, act, text]) => ({
            time: timeOf(i),
            position: leg.kind === 'CE' ? 'aboveBar' : 'belowBar',
            shape: act === 'sell' ? 'arrowDown' : 'arrowUp',
            color,
            size: 0.8,
            text,
          })),
      );
      prices.push({
        label: `${leg.strike} ${leg.kind}`,
        values: [{ series: s, color, format: num }],
      });
    });

    const pnl = addTradePnlPane(chart, trade, closes, timeOf, 1);

    const panes = chart.panes();
    panes[0]?.setStretchFactor(2);
    panes[1]?.setStretchFactor(1.2);

    const stopHover = watchHover(
      chart,
      box,
      tipRef.current,
      [
        { label: 'Prices', rows: prices },
        { label: 'P&L', rows: pnl },
      ],
      trade,
    );
    const stopFraming = frameSessionOnResize(chart, box);
    const stopLabeling = labelPanes(chart, ['Spot & traded premiums', 'Trade P&L']);

    return () => {
      stopFraming();
      stopLabeling();
      stopHover();
      removeChart(chart);
    };
  }, [view, canDraw, data, theme, row.trade, row.signal.t1, row.signal.t2, fillLegs, embedded]);

  // ── Greeks view ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (view !== 'greeks' || !canDraw || !box || !data) return;
    const start = sessionStart(data.date);
    const timeOf = (i: number) => (start + i * 60) as UTCTimestamp;
    const line = (grid: Grid) =>
      grid.flatMap((v, i) => (v == null ? [] : [{ time: timeOf(i), value: v }]));

    const chart = baseChart(box, theme, embedded);

    const t1 = slotOf(row.signal.t1);
    const t2 = slotOf(row.signal.t2);
    const entry = slotOf(row.trade.entryTime);

    // Pane 0: spot on the right axis, the two reference premiums on the left.
    const spot = chart.addSeries(LineSeries, {
      color: SPOT_COLOR,
      lineWidth: 2,
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: 'price', minMove: 1, precision: 0 },
    });
    spot.setData(spotTimeline(data.spot, timeOf));
    const cePrice = chart.addSeries(LineSeries, {
      color: CE_COLOR,
      lineWidth: 2,
      priceScaleId: 'left',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    cePrice.setData(line(data.ce));
    const pePrice = chart.addSeries(LineSeries, {
      color: PE_COLOR,
      lineWidth: 2,
      priceScaleId: 'left',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    pePrice.setData(line(data.pe));

    const spotMarks: SeriesMarker<Time>[] = (
      [
        [t1, 't1'],
        [t2, 't2'],
        [entry, 'entry'],
      ] as const
    )
      .filter(([i]) => data.spot[i] != null)
      .sort(([a], [b]) => a - b)
      // t2 and the entry are usually one minute apart, so their labels would sit on top of each
      // other; the entry goes under the line, the two signal minutes above it.
      .map(([i, text]) => ({
        time: timeOf(i),
        position: text === 'entry' ? 'belowBar' : 'aboveBar',
        shape: text === 'entry' ? 'arrowUp' : 'arrowDown',
        color: MARK_COLOR,
        size: 0.8,
        text,
      }));
    createSeriesMarkers(spot, spotMarks);

    // One pane per chosen greek; CE and PE share it. Dots at t1 and t2 are the table's numbers.
    const fixed = (value: number) => value.toFixed(2);
    const prices: HoverRow[] = [
      { label: 'Spot', values: [{ series: spot, color: SPOT_COLOR, format: fixed }] },
      { label: 'CE', values: [{ series: cePrice, color: CE_COLOR, format: fixed }] },
      { label: 'PE', values: [{ series: pePrice, color: PE_COLOR, format: fixed }] },
    ];
    const closes = row.trade.legs.map((leg) => {
      const got =
        data.legs?.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close ?? null;
      const fill = fillLegs?.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close;
      return got && fill ? got.map((value, i) => value ?? fill[i]) : got;
    });
    const pnlReadings =
      embedded && data.legs ? addTradePnlPane(chart, row.trade, closes, timeOf, 1) : [];
    const greekPaneOffset = pnlReadings.length ? 2 : 1;
    const greekRows: HoverRow[] = [];
    shown.forEach((key, n) => {
      const meta = GREEKS.find((g) => g.key === key)!;
      const pane = n + greekPaneOffset;
      const make = (side: 'CE' | 'PE') => {
        const color = side === 'CE' ? CE_COLOR : PE_COLOR;
        const s = chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth: 2,
            priceScaleId: 'right',
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: { type: 'price', precision: meta.digits, minMove: 10 ** -meta.digits },
          },
          pane,
        );
        const grid = data.greeks[side][key];
        s.setData(line(grid));
        const dots: SeriesMarker<Time>[] = [t1, t2]
          .filter((i) => grid[i] != null)
          .map((i) => ({
            time: timeOf(i),
            position: 'inBar',
            shape: 'circle',
            color,
            size: 0.8,
          }));
        createSeriesMarkers(s, dots);
        return s;
      };
      const format = (value: number) => value.toFixed(meta.digits);
      greekRows.push({
        label: meta.label,
        values: [
          { series: make('CE'), color: CE_COLOR, format },
          { series: make('PE'), color: PE_COLOR, format },
        ],
      });
    });

    const panes = chart.panes();
    panes[0]?.setStretchFactor(1.6);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    if (pnlReadings.length) panes[1]?.setStretchFactor(1.3);

    const groups: HoverGroup[] = [{ label: 'Prices', rows: prices }];
    if (pnlReadings.length) groups.push({ label: 'P&L', rows: pnlReadings });
    if (greekRows.length) groups.push({ label: 'Greeks', rows: greekRows, legs: true });
    const stopHover = watchHover(chart, box, tipRef.current, groups, row.trade);
    const stopFraming = frameSessionOnResize(chart, box);
    const stopLabeling = labelPanes(chart, [
      'Spot & reference premiums',
      ...(pnlReadings.length ? ['Trade P&L'] : []),
      ...greekRows.map((row) => row.label),
    ]);

    return () => {
      stopFraming();
      stopLabeling();
      stopHover();
      removeChart(chart);
    };
  }, [
    view,
    canDraw,
    data,
    theme,
    shown,
    row.signal.t1,
    row.signal.t2,
    row.trade,
    fillLegs,
    embedded,
  ]);

  // Functional update, so two toggles before a re-render cannot overwrite each other.
  const toggle = (key: GreekKey) =>
    setShown((prev) =>
      GREEKS.map((g) => g.key).filter((k) => (k === key ? !prev.includes(k) : prev.includes(k))),
    );
  useEffect(() => saveGreeks(shown), [shown]);
  useEffect(() => saveView(view), [view]);

  const badge = dteBadge(row.dte);
  // Legs whose prices the day's data does not hold: their lines and the P&L stay blank.
  const noPrices = data?.legs
    ? row.trade.legs.filter(
        (leg) => !data.legs!.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close,
      )
    : [];
  const olderServer = view === 'trade' && data != null && !data.legs;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--border)] bg-[var(--bg-primary)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--border)] px-2 py-2 text-[11px]">
        {onStep && !embedded && (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              disabled={!canStep?.prev}
              onClick={() => onStep(-1)}
              aria-label="Previous day"
              title="Previous day in the table"
              className="h-5 w-5 rounded border border-[var(--border)] text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              ‹
            </button>
            <button
              type="button"
              disabled={!canStep?.next}
              onClick={() => onStep(1)}
              aria-label="Next day"
              title="Next day in the table"
              className="h-5 w-5 rounded border border-[var(--border)] text-[var(--text-muted)] enabled:hover:text-[var(--text-primary)] disabled:opacity-30"
            >
              ›
            </button>
          </span>
        )}
        {!embedded && <span className="font-semibold">{row.date}</span>}
        {badge && !embedded && (
          <span
            className="rounded px-1 text-[9px] font-semibold"
            style={{
              color: row.dte === 0 ? MARK_COLOR : '#38bdf8',
              background: row.dte === 0 ? 'rgba(245,158,11,0.15)' : 'rgba(56,189,248,0.15)',
            }}
          >
            {badge}
          </span>
        )}
        <div
          role="group"
          aria-label="Chart view"
          className="flex items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5"
        >
          {(['trade', 'greeks'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={CHART_CONTROL}
            >
              {v === 'trade' ? 'Trade' : 'Greeks'}
            </button>
          ))}
        </div>
        {view === 'greeks' && (
          <div
            role="group"
            aria-label="Visible Greeks"
            className="flex flex-wrap items-center gap-0.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-0.5"
          >
            {GREEKS.map((g) => (
              <button
                key={g.key}
                type="button"
                aria-pressed={shown.includes(g.key)}
                onClick={() => toggle(g.key)}
                className={CHART_CONTROL}
              >
                {g.label}
              </button>
            ))}
          </div>
        )}
        {!embedded && (
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            aria-label="Close chart"
            title="Close chart"
          >
            ✕
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] px-2 py-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[var(--text-muted)]">Left scale</span>
          {view === 'trade' ? (
            row.trade.legs.map((leg) => (
              <span key={leg.kind} className="inline-flex items-center gap-1 whitespace-nowrap">
                <SeriesKey
                  color={leg.kind === 'CE' ? CE_COLOR : PE_COLOR}
                  label={`${leg.strike} ${leg.kind}`}
                />
                <span className="font-mono text-[var(--text-muted)]">
                  {num(legEntryPrice(leg))}
                </span>
              </span>
            ))
          ) : (
            <>
              <SeriesKey color={CE_COLOR} label={`${ceStrike} CE`} />
              <SeriesKey color={PE_COLOR} label={`${peStrike} PE`} />
            </>
          )}
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-[var(--text-muted)]">Right scale</span>
          <SeriesKey color={SPOT_COLOR} label="Spot" />
        </div>
        <span className="text-[var(--text-muted)]">Expiry {row.expiry}</span>
        {view === 'trade' ? (
          <span className="text-[var(--text-muted)]">
            {row.trade.side} {row.trade.qty}
            {row.dte != null && ` · ${dteLabel(row.dte)}`} · P&L{' '}
            <span
              className="font-semibold"
              style={{ color: row.trade.pnl >= 0 ? TOTAL_UP : TOTAL_DOWN }}
            >
              {inr(row.trade.pnl)}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-[var(--border)] px-2 py-1.5 font-mono text-[10px] tabular-nums text-[var(--text-muted)]">
        <span>t1 {row.signal.t1}</span>
        <span>t2 {row.signal.t2}</span>
        <span>Entry {row.trade.entryTime}</span>
        <span>Exit {row.trade.exitTime}</span>
      </div>
      {noPrices.length > 0 && (
        <div className="border-b border-[var(--border)] px-3 py-0.5 text-[10px] text-[#f59e0b]">
          No minute prices stored for {noPrices.map((l) => `${l.strike} ${l.kind}`).join(', ')} —
          its line and the P&L cannot be drawn.
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={boxRef} className="absolute inset-0" />
        <div
          ref={tipRef}
          role="tooltip"
          hidden
          className="pointer-events-none absolute top-2 z-10 w-[13rem] max-w-[calc(100%-1rem)] rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-1.5 font-sans text-[11px] leading-[1.35] text-[var(--text-primary)] shadow-lg"
        />
        {(error || !data || olderServer) && (
          <div
            role={error || olderServer ? 'alert' : 'status'}
            className={`absolute inset-0 flex items-center justify-center text-[12px] ${
              error || olderServer ? 'text-[#ef4444]' : 'text-[var(--text-muted)]'
            }`}
          >
            {error ??
              (olderServer
                ? 'This server predates the trade chart — restart it (Ctrl+C, then npm start).'
                : 'Loading intraday prices and Greeks…')}
          </div>
        )}
      </div>
    </div>
  );
}
