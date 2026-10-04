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
import { useEffect, useRef, useState } from 'react';
import {
  BaselineSeries,
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

type View = 'trade' | 'greeks';

/** Empty slots added after the day's last minute in the trade view, for marker text at the edge. */
const EDGE_ROOM = 14;

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

/** One line of the hover tooltip. */
interface TipRow {
  label: string;
  value: string;
  /** Swatch colour; none for a plain line. */
  color?: string;
  bold?: boolean;
}

/** Fills the tooltip with a title and rows, built as DOM nodes (no HTML from data). */
function paintTip(el: HTMLElement, title: string, rows: TipRow[]): void {
  el.replaceChildren();
  const head = document.createElement('div');
  head.className = 'mb-0.5 font-semibold';
  head.textContent = title;
  el.append(head);
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 'flex items-center justify-between gap-4';
    if (r.bold) line.classList.add('font-semibold');
    const left = document.createElement('span');
    left.className = 'flex items-center gap-1.5';
    if (r.color) {
      const swatch = document.createElement('span');
      swatch.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:2px;background:${r.color}`;
      left.append(swatch);
    }
    left.append(document.createTextNode(r.label));
    const value = document.createElement('span');
    value.className = 'font-mono';
    value.textContent = r.value;
    line.append(left, value);
    el.append(line);
  }
}

/** Puts the tooltip beside the pointer, on whichever side has room, and shows it. */
function placeTip(el: HTMLElement, box: HTMLElement, point: { x: number; y: number }): void {
  const gap = 14;
  el.style.display = 'block';
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // The right axis is about 80px wide; stay clear of it as well as of the edge.
  let x = point.x + gap;
  if (x + w > box.clientWidth - 80) x = Math.max(0, point.x - gap - w);
  const y = Math.max(0, Math.min(point.y + gap, box.clientHeight - h - 4));
  el.style.transform = `translate(${x}px, ${y}px)`;
}

const hideTip = (el: HTMLElement | null) => {
  if (el) el.style.display = 'none';
};

/** A chart in `box` with the axes both views share. */
function baseChart(box: HTMLElement, theme: Theme): IChartApi {
  return createChart(box, {
    autoSize: true,
    ...chartTheme(theme),
    leftPriceScale: { visible: true, borderVisible: false, minimumWidth: 70 },
    rightPriceScale: { visible: true, borderVisible: false, minimumWidth: 75 },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  });
}

interface Props {
  theme: Theme;
  underlying: SignalUnderlying;
  row: SignalBacktestRow;
  onClose: () => void;
  /** Move to the previous (-1) or next (1) day in the table. */
  onStep?: (delta: -1 | 1) => void;
  canStep?: { prev: boolean; next: boolean };
}

export default function SignalDayChart({
  theme,
  underlying,
  row,
  onClose,
  onStep,
  canStep,
}: Props) {
  const [data, setData] = useState<SignalDayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [shown, setShown] = useState<GreekKey[]>(loadGreeks);
  const boxRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const { ceStrike, peStrike } = row.signal.legs;
  // The legs the trade sold, so the server can send their prices; the row's price source tells it
  // where a strike beyond the day's ladder lives.
  const tradeLegs = row.trade.legs.map((l) => `${l.kind}:${l.strike}`).join(',');

  useEffect(() => {
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
  }, [underlying, row.date, row.source, row.ohlcSource, ceStrike, peStrike, tradeLegs]);

  // ── Trade view ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (view !== 'trade' || !box || !data?.legs) return;
    const trade = row.trade;
    const start = sessionStart(data.date);
    const timeOf = (i: number) => (start + i * 60) as UTCTimestamp;
    const line = (grid: Grid) =>
      grid.flatMap((v, i) => (v == null ? [] : [{ time: timeOf(i), value: v }]));
    const colorOf = (kind: 'CE' | 'PE') => (kind === 'CE' ? CE_COLOR : PE_COLOR);
    const selling = trade.side === 'SELL';

    const chart = baseChart(box, theme);
    hideTip(tipRef.current);

    // Pane 0: the underlying on the right axis, the prices of the legs sold on the left — one pane,
    // so a move in the underlying and the premium it caused are read against the same time.
    const spot = chart.addSeries(
      LineSeries,
      {
        color: SPOT_COLOR,
        lineWidth: 2,
        priceScaleId: 'right',
        title: 'Spot',
        priceLineVisible: false,
      },
      0,
    );
    // Empty slots after the last minute widen the time axis, so the exit and the extremes — often in
    // the last minutes — keep their marker text clear of the plot's edge.
    spot.setData([
      ...line(data.spot),
      ...Array.from({ length: EDGE_ROOM }, (_, k) => ({ time: timeOf(data.spot.length + k) })),
    ]);
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
        text,
      }));
    createSeriesMarkers(spot, spotMarks);

    // The prices of the legs the trade sold, the entry price drawn across each.
    const closes = trade.legs.map(
      (leg) =>
        data.legs!.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close ?? null,
    );
    const readable: Array<{
      label: string;
      series: ISeriesApi<'Line' | 'Baseline'>;
      money: boolean;
      /** A colour, or 'sign' for green above zero and red below. */
      color: string;
      bold?: boolean;
    }> = [{ label: 'Spot', series: spot, money: false, color: SPOT_COLOR }];
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
          title: `${leg.strike} ${leg.kind}`,
          priceLineVisible: false,
          lastValueVisible: true,
        },
        0,
      );
      s.setData(line(close));
      s.createPriceLine({
        price: legEntryPrice(leg),
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: selling ? 'sold' : 'bought',
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
            // No text on the exit: its price is already the label on the right axis.
            [legExit, selling ? 'buy' : 'sell', ''],
          ] as const
        )
          .filter(([i]) => close[i] != null)
          .map(([i, act, text]) => ({
            time: timeOf(i),
            position: leg.kind === 'CE' ? 'aboveBar' : 'belowBar',
            shape: act === 'sell' ? 'arrowDown' : 'arrowUp',
            color,
            text,
          })),
      );
      readable.push({ label: `${leg.strike} ${leg.kind}`, series: s, money: false, color });
    });

    // Pane 1: P&L. Each leg thin, the total bold and shaded either side of zero. With one leg the
    // total is that leg, so it is drawn once.
    const pnl = tradePnlSeries(trade, closes);
    const pnlFormat = { type: 'price', precision: 0, minMove: 1 } as const;
    if (trade.legs.length > 1) {
      trade.legs.forEach((leg, n) => {
        const s = chart.addSeries(
          LineSeries,
          {
            color: colorOf(leg.kind),
            lineWidth: 1,
            title: `${leg.kind} P&L`,
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: pnlFormat,
          },
          1,
        );
        s.setData(line(pnl.legs[n]));
        readable.push({
          label: `${leg.kind} P&L`,
          series: s,
          money: true,
          color: colorOf(leg.kind),
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
        lineWidth: 2,
        title: trade.legs.length > 1 ? 'Total P&L' : 'P&L',
        priceLineVisible: false,
        priceFormat: pnlFormat,
      },
      1,
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
    // The extremes are high/low based, so the label carries the amount; the dot sits on the close line.
    createSeriesMarkers(
      total,
      (
        [
          [trade.maxProfitTime, 'aboveBar', TOTAL_UP, trade.maxProfit],
          [trade.maxLossTime, 'belowBar', TOTAL_DOWN, trade.maxLoss],
        ] as const
      )
        .filter(([hhmm]) => pnl.total[slotOf(hhmm)] != null)
        .sort(([a], [b]) => slotOf(a) - slotOf(b))
        .map(([hhmm, position, color, value]) => ({
          time: timeOf(slotOf(hhmm)),
          position,
          shape: position === 'aboveBar' ? 'arrowDown' : 'arrowUp',
          color,
          text: `${position === 'aboveBar' ? 'max profit' : 'max loss'} ${inr(value)}`,
        })),
    );
    readable.push({
      label: trade.legs.length > 1 ? 'Total P&L' : 'P&L',
      series: total,
      money: true,
      color: 'sign',
      bold: true,
    });

    const panes = chart.panes();
    panes[0]?.setStretchFactor(2);
    panes[1]?.setStretchFactor(1.2);

    const idle = `t1 ${row.signal.t1} · t2 ${row.signal.t2} · entry ${trade.entryTime} · exit ${trade.exitTime} — hover for values`;
    if (readoutRef.current) readoutRef.current.textContent = idle;
    const onMove = (param: MouseEventParams<Time>) => {
      const el = readoutRef.current;
      if (!el) return;
      if (!param.time) {
        el.textContent = idle;
        hideTip(tipRef.current);
        return;
      }
      const values = readable.map((r) => {
        const v = (param.seriesData.get(r.series) as LineData<Time> | undefined)?.value;
        return { r, v, text: v == null ? '—' : r.money ? inr(v) : num(v) };
      });
      el.textContent = `${clockOf(param.time)}  ·  ${values.map((x) => `${x.r.label} ${x.text}`).join('  ·  ')}`;
      if (tipRef.current && param.point) {
        paintTip(
          tipRef.current,
          clockOf(param.time),
          values.map(({ r, v, text }) => ({
            label: r.label,
            value: text,
            bold: r.bold,
            color: r.color === 'sign' ? ((v ?? 0) >= 0 ? TOTAL_UP : TOTAL_DOWN) : r.color,
          })),
        );
        placeTip(tipRef.current, box, param.point);
      }
    };
    chart.subscribeCrosshairMove(onMove);
    // The whole day and the empty slots after it. (fitContent would end on the last real minute and
    // leave the padding to push the day off to the right.)
    chart.timeScale().setVisibleLogicalRange({ from: -1, to: data.spot.length - 1 + EDGE_ROOM });

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      removeChart(chart);
    };
  }, [view, data, theme, row.trade, row.signal.t1, row.signal.t2]);

  // ── Greeks view ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const box = boxRef.current;
    if (view !== 'greeks' || !box || !data) return;
    const start = sessionStart(data.date);
    const timeOf = (i: number) => (start + i * 60) as UTCTimestamp;
    const line = (grid: Grid) =>
      grid.flatMap((v, i) => (v == null ? [] : [{ time: timeOf(i), value: v }]));

    const chart = baseChart(box, theme);
    hideTip(tipRef.current);

    const t1 = slotOf(row.signal.t1);
    const t2 = slotOf(row.signal.t2);
    const entry = slotOf(row.trade.entryTime);

    // Pane 0: spot on the right axis, the two reference premiums on the left.
    const spot = chart.addSeries(LineSeries, {
      color: SPOT_COLOR,
      lineWidth: 1,
      priceScaleId: 'right',
      title: 'Spot',
      priceLineVisible: false,
    });
    spot.setData(line(data.spot));
    const cePrice = chart.addSeries(LineSeries, {
      color: CE_COLOR,
      lineWidth: 2,
      priceScaleId: 'left',
      title: 'CE',
      priceLineVisible: false,
    });
    cePrice.setData(line(data.ce));
    const pePrice = chart.addSeries(LineSeries, {
      color: PE_COLOR,
      lineWidth: 2,
      priceScaleId: 'left',
      title: 'PE',
      priceLineVisible: false,
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
        text,
      }));
    createSeriesMarkers(spot, spotMarks);

    // One pane per chosen greek; CE and PE share it. Dots at t1 and t2 are the table's numbers.
    const readable: Array<{ label: string; series: ISeriesApi<'Line'>; digits: number }> = [
      { label: 'Spot', series: spot, digits: 2 },
      { label: 'CE', series: cePrice, digits: 2 },
      { label: 'PE', series: pePrice, digits: 2 },
    ];
    const greekRows: Array<{
      label: string;
      ce: ISeriesApi<'Line'>;
      pe: ISeriesApi<'Line'>;
      digits: number;
    }> = [];
    shown.forEach((key, n) => {
      const meta = GREEKS.find((g) => g.key === key)!;
      const pane = n + 1;
      const make = (side: 'CE' | 'PE') => {
        const color = side === 'CE' ? CE_COLOR : PE_COLOR;
        const s = chart.addSeries(
          LineSeries,
          {
            color,
            lineWidth: 1,
            priceScaleId: 'right',
            title: `${meta.label} ${side}`,
            priceLineVisible: false,
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
            size: 1.5,
          }));
        createSeriesMarkers(s, dots);
        return s;
      };
      greekRows.push({ label: meta.label, ce: make('CE'), pe: make('PE'), digits: meta.digits });
    });

    const panes = chart.panes();
    panes[0]?.setStretchFactor(1.6);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);

    const idle = `t1 ${row.signal.t1} · t2 ${row.signal.t2} · entry ${row.trade.entryTime} — hover for values`;
    if (readoutRef.current) readoutRef.current.textContent = idle;
    const onMove = (param: MouseEventParams<Time>) => {
      const el = readoutRef.current;
      if (!el) return;
      if (!param.time) {
        el.textContent = idle;
        hideTip(tipRef.current);
        return;
      }
      const val = (s: ISeriesApi<'Line'>) =>
        (param.seriesData.get(s) as LineData<Time> | undefined)?.value;
      const parts = readable.map((r) => `${r.label} ${val(r.series)?.toFixed(r.digits) ?? '—'}`);
      const tip: TipRow[] = [
        { label: 'Spot', value: val(spot)?.toFixed(2) ?? '—', color: SPOT_COLOR },
        { label: 'CE', value: val(cePrice)?.toFixed(2) ?? '—', color: CE_COLOR },
        { label: 'PE', value: val(pePrice)?.toFixed(2) ?? '—', color: PE_COLOR },
      ];
      for (const g of greekRows) {
        const f = (v: number | undefined) => (v == null ? '—' : v.toFixed(g.digits));
        parts.push(`${g.label} CE ${f(val(g.ce))} / PE ${f(val(g.pe))}`);
        tip.push(
          { label: `${g.label} CE`, value: f(val(g.ce)), color: CE_COLOR },
          { label: `${g.label} PE`, value: f(val(g.pe)), color: PE_COLOR },
        );
      }
      el.textContent = `${clockOf(param.time)}  ·  ${parts.join('  ·  ')}`;
      if (tipRef.current && param.point) {
        paintTip(tipRef.current, clockOf(param.time), tip);
        placeTip(tipRef.current, box, param.point);
      }
    };
    chart.subscribeCrosshairMove(onMove);
    chart.timeScale().fitContent();

    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      removeChart(chart);
    };
  }, [view, data, theme, shown, row.signal.t1, row.signal.t2, row.trade.entryTime]);

  // Functional update, so two toggles before a re-render cannot overwrite each other.
  const toggle = (key: GreekKey) =>
    setShown((prev) =>
      GREEKS.map((g) => g.key).filter((k) => (k === key ? !prev.includes(k) : prev.includes(k))),
    );
  useEffect(() => saveGreeks(shown), [shown]);
  useEffect(() => saveView(view), [view]);

  const badge = dteBadge(row.dte);
  // Legs whose prices the day's data does not hold: their lines and the P&L stay blank.
  const noPrices =
    view === 'trade' && data?.legs
      ? row.trade.legs.filter(
          (leg) => !data.legs!.find((l) => l.kind === leg.kind && l.strike === leg.strike)?.close,
        )
      : [];
  const olderServer = view === 'trade' && data != null && !data.legs;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[var(--border)] bg-[var(--bg-primary)]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-3 py-1 text-[11px]">
        {onStep && (
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
        <span className="font-semibold">{row.date}</span>
        {badge && (
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
        <span className="flex items-center gap-1">
          {(['trade', 'greeks'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`h-5 rounded border px-2 text-[11px] ${
                view === v
                  ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                  : 'border-[var(--border)] text-[var(--text-muted)]'
              }`}
            >
              {v === 'trade' ? 'Trade' : 'Greeks'}
            </button>
          ))}
        </span>
        {view === 'trade' ? (
          <span className="text-[var(--text-muted)]">
            {row.trade.side} {row.trade.qty} ·{' '}
            {row.trade.legs.map((leg, n) => (
              <span key={leg.kind}>
                {n > 0 && ' / '}
                <span style={{ color: leg.kind === 'CE' ? CE_COLOR : PE_COLOR }}>
                  {leg.strike} {leg.kind}
                </span>{' '}
                {num(legEntryPrice(leg))}
              </span>
            ))}{' '}
            · expiry {row.expiry}
            {row.dte != null && ` (${dteLabel(row.dte).toLowerCase()})`} · P&L{' '}
            <span
              className="font-semibold"
              style={{ color: row.trade.pnl >= 0 ? TOTAL_UP : TOTAL_DOWN }}
            >
              {inr(row.trade.pnl)}
            </span>
          </span>
        ) : (
          <>
            <span className="text-[var(--text-muted)]">
              reference <span style={{ color: CE_COLOR }}>{ceStrike} CE</span> /{' '}
              <span style={{ color: PE_COLOR }}>{peStrike} PE</span> · expiry {row.expiry}
            </span>
            <span className="ml-2 flex items-center gap-1">
              {GREEKS.map((g) => {
                const on = shown.includes(g.key);
                return (
                  <button
                    key={g.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(g.key)}
                    className={`h-5 rounded border px-1.5 text-[11px] ${
                      on
                        ? 'border-[var(--accent)] text-[var(--accent)]'
                        : 'border-[var(--border)] text-[var(--text-muted)]'
                    }`}
                  >
                    {g.label}
                  </button>
                );
              })}
            </span>
          </>
        )}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          aria-label="Close chart"
          title="Close chart"
        >
          ✕
        </button>
      </div>
      <div
        ref={readoutRef}
        className="min-h-[18px] truncate border-b border-[var(--border)] px-3 py-0.5 font-mono text-[10px] text-[var(--text-muted)]"
      />
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
          className="pointer-events-none absolute left-0 top-0 z-10 hidden min-w-[150px] rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1.5 text-[11px] text-[var(--text-primary)] shadow-lg"
        />
        {(error || !data || olderServer) && (
          <div
            className={`absolute inset-0 flex items-center justify-center text-[12px] ${
              error || olderServer ? 'text-[#ef4444]' : 'text-[var(--text-muted)]'
            }`}
          >
            {error ??
              (olderServer
                ? 'This server predates the trade chart — restart it (Ctrl+C, then npm start).'
                : 'Loading…')}
          </div>
        )}
      </div>
    </div>
  );
}
