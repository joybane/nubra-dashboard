// ─── Aggregate Vega / Theta / IV as a self-contained chart pane ──────────────────
//
// The Tracker draws these overlays on the chart it already owns. Nubra BT and the position
// views do not have a chart to spare — their price and P&L panes are theirs — so the overlays
// need a pane of their own. That is all this component is: the Tracker's chart block, minus the
// data loading, taking its bars from whichever host mounts it.
//
// Everything below the surface is shared, not copied: the same `useGreekOverlay` hook, the same
// `GreekButton` tray, the same `greekAggregator` maths and `greekRenderer` panes. A change to a
// Greek formula or a control lands here and in the Chart and Tracker views at once.

import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesOptions,
} from 'lightweight-charts';
import type { Instrument, OhlcBar } from '../types';
import { getSymbol } from '../types';
import { useGreekOverlay } from '../hooks/useGreekOverlay';
import { GreekButton } from './GreekControls';
import {
  bindGreekCrosshair,
  fmtCompact,
  fmtCrosshairTime,
  greekRows,
  logicalAtTime,
  seriesValueAt,
  type GreekRow,
} from '../lib/greekTooltip';
import { removeChart } from '../lib/chartLifecycle';
import { barsToSessionLine, fmtPrice } from '../lib/utils';
import PinnedCrosshairLayer from './PinnedCrosshairLayer';
import { bindPinTrigger, type ChartPin } from '../lib/chartPins';

/**
 * A pinned instant's frozen reading, mirroring the hover tooltip's rows.
 *
 * Built from the pane's own series rather than the host's snapshot builder — that builder knows
 * the price / P&L / Greeks shapes and nothing about the aggregate overlay, which is exactly why
 * the card has to come from here.
 */
function GreekPinCard({ time, rows }: { time: number; rows: GreekRow[] }) {
  return (
    <div
      className="rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 shadow-2xl"
      style={{ minWidth: 120 }}
    >
      <div className="text-[10px] text-[var(--text-muted)] mb-1">{fmtCrosshairTime(time)}</div>
      {rows.length === 0 ? (
        // Distinct from "no data": the pin can sit on a bar the overlays are simply switched
        // off for, and saying so beats an empty box that reads as a broken card.
        <div className="text-[10px] text-[var(--text-muted)]">No overlay at this bar</div>
      ) : (
        rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center gap-1.5 leading-6 whitespace-nowrap text-[11px]"
          >
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: r.color }} />
            <span className="text-[var(--text-secondary)]">{r.label}</span>
            <span className="ml-auto pl-3.5 font-semibold text-[var(--text-primary)]">
              {(r.format ?? fmtCompact)(r.value)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

export interface GreekIndicatorPaneProps {
  /** The underlying the basket is built around. Null keeps the pane inert. */
  instrument: Instrument | null;
  /** The host's underlying bars — the time grid greek points are snapped onto. */
  bars: OhlcBar[];
  theme: 'dark' | 'light';
  /** Trailing reconstruction window. Hosts reviewing a single trade pass 1. */
  histDays?: number;
  /** Trading day to open on ('YYYY-MM-DD') — e.g. the session the trade ran in. */
  initialDay?: string;
  /**
   * Handed the pane's chart on mount and null on unmount, so the host can enroll it in its own
   * scroll/crosshair sync and the pane scrolls in lockstep with price and P&L.
   *
   * The underlying reference series comes with it because `setCrosshairPosition` needs a series
   * to place the crosshair against — a host pushing a synced crosshair onto this pane has no
   * other way to name one, and reaching into `chart.panes()[0].getSeries()[0]` would silently
   * depend on the overlays never being added ahead of it.
   */
  onChartReady?: (chart: IChartApi | null, baseSeries: ISeriesApi<'Line'> | null) => void;
  /**
   * The host's pins. Supplying these makes the pane a full participant: it draws each pinned
   * line with its own frozen card, and middle-click / Alt+click here pins across every pane.
   * Omit them (a host with no pin machinery) and the pane simply has no pins.
   */
  pins?: ChartPin[];
  onTogglePin?: (time: number | null) => void;
  onRemovePin?: (id: number) => void;
}

export default function GreekIndicatorPane({
  instrument,
  bars,
  theme,
  histDays,
  initialDay,
  onChartReady,
  pins,
  onTogglePin,
  onRemovePin,
}: GreekIndicatorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);

  // The hook reads both of these through refs, so they must be written before any effect that
  // can trigger a draw — hence the assignment during render rather than in an effect.
  const currentInstRef = useRef<Instrument | null>(null);
  const allBarsRef = useRef<OhlcBar[]>([]);
  currentInstRef.current = instrument;
  allBarsRef.current = bars;

  const symRef = useRef('');
  symRef.current = instrument ? getSymbol(instrument) : '';
  const exchange = instrument?.exchange || 'NSE';

  // The chart is built in an effect, so it does not exist on the first render. Bumping this once
  // it does is what lets the pin layer — which needs the chart handle during render — pick it up.
  const [chartTick, setChartTick] = useState(0);
  // Held in a ref so a host re-rendering with a new callback identity does not force a rebind of
  // the capture-phase mousedown listener.
  const togglePinRef = useRef(onTogglePin);
  togglePinRef.current = onTogglePin;

  const overlayDeps = { chartRef, currentInstRef, allBarsRef, inline: true, histDays, initialDay };
  const vega = useGreekOverlay({ greek: 'vega', ...overlayDeps });
  const theta = useGreekOverlay({ greek: 'theta', ...overlayDeps });
  const iv = useGreekOverlay({ greek: 'iv', ...overlayDeps });

  // ── Chart init ─────────────────────────────────────────────────────────────
  // Created ONCE and never rebuilt. The host views recreate their own charts on theme and
  // visibility changes; doing that here would leave the overlay hooks holding pane handles
  // bound to a disposed chart, which throws from inside lightweight-charts a frame later.
  // Theme is applied by `applyOptions` below instead, exactly as the Tracker does.
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === 'dark';

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor: isDark ? '#c9d1d9' : '#131722',
        fontSize: 12,
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
        secondsVisible: false,
        minBarSpacing: 0.05,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    });
    chartRef.current = chart;

    // A faint underlying reference line. The overlays sit on their own price scales above it —
    // it exists to give the pane a time grid and the crosshair something to read against.
    const line = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
    } as Partial<LineSeriesOptions>);
    line.priceScale().applyOptions({ autoScale: true, scaleMargins: { top: 0.08, bottom: 0.1 } });
    lineRef.current = line;

    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      chart.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(containerRef.current);

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

    onChartReady?.(chart, line);
    setChartTick((t) => t + 1);

    return () => {
      observer.disconnect();
      unbindCrosshair();
      onChartReady?.(null, null);
      removeChart(chart);
      chartRef.current = null;
      lineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync (options only — never a rebuild; see above) ──────────────────
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

  // ── Underlying line + greek re-snap whenever the host's bars change ─────────
  // The overlays snap their points onto this grid (buildTimeMapper), so a bars change without a
  // refresh would leave greek points mapped against a grid that no longer exists.
  const hasFittedRef = useRef(false);
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    line.setData(barsToSessionLine(bars, exchange) as Parameters<typeof line.setData>[0]);
    // fitContent ONCE, on the first bars that arrive. A live position replaces this array on
    // every tick, so fitting each time would yank the view back on every tick — and, because the
    // host enrolls this chart in its scroll sync, drag the price and P&L panes along with it.
    if (bars.length && !hasFittedRef.current) {
      hasFittedRef.current = true;
      chartRef.current?.timeScale().fitContent();
    }
    vega.refresh();
    theta.refresh();
    iv.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, exchange]);

  // ── Pin trigger ────────────────────────────────────────────────────────────
  // Middle-click (or Alt+click) pins the bar under the cursor across every pane in the host.
  // The time comes from the click coordinate rather than a tracked crosshair, which is the same
  // fallback the hosts use — the time scale snaps it to a bar, and every pane shares one bar
  // grid, so a pin dropped here lands on the same instant the price and P&L panes will show.
  useEffect(() => {
    const el = containerRef.current;
    const chart = chartRef.current;
    if (!el || !chart || !onTogglePin) return;
    return bindPinTrigger(
      el,
      (ev) => {
        try {
          const rect = el.getBoundingClientRect();
          const leftScale = chart.priceScale('left').width() ?? 0;
          const t = chart.timeScale().coordinateToTime(ev.clientX - rect.left - leftScale);
          return typeof t === 'number' ? t : null;
        } catch {
          return null;
        }
      },
      (t) => togglePinRef.current?.(t),
    );
  }, [chartTick, onTogglePin]);

  // ── Instrument switch: tear the basket down before it can be rebuilt ────────
  // Mirrors the Tracker's load path. Without this the panes keep the previous underlying's
  // legs and WS subscriptions, and the line silently mixes two baskets.
  const lastSymRef = useRef<string | null>(null);
  useEffect(() => {
    const sym = instrument ? `${getSymbol(instrument)}:${exchange}` : '';
    if (lastSymRef.current === null) {
      lastSymRef.current = sym;
      return; // first mount — nothing to tear down
    }
    if (lastSymRef.current === sym) return;
    lastSymRef.current = sym;
    vega.clearForInstrumentChange();
    theta.clearForInstrumentChange();
    iv.clearForInstrumentChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, exchange]);

  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)]">
          INDICATORS
        </span>
        {symRef.current && (
          <span className="text-[10px] text-[var(--text-secondary)]">{symRef.current}</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <GreekButton api={vega} label="Vega" />
          <GreekButton api={theta} label="Theta" />
          <GreekButton api={iv} label="IV" />
        </div>
      </div>

      <div className="flex-1 relative min-h-0">
        <div ref={containerRef} className="absolute inset-0" />
        <div
          ref={tooltipRef}
          className="absolute z-30 hidden pointer-events-none rounded-md border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 shadow-2xl"
          style={{ minWidth: 120 }}
        />
        {pins && (
          <PinnedCrosshairLayer
            pins={pins}
            chart={chartRef.current}
            epoch={chartTick}
            onRemove={(id) => onRemovePin?.(id)}
            renderCard={(pin) => {
              const chart = chartRef.current;
              if (!chart) return null;
              // Same rows the hover tooltip shows, read at the pinned instant instead of the
              // cursor — including the underlying, so a frozen card and a live one agree.
              const logical = logicalAtTime(chart, pin.time);
              const base = lineRef.current;
              const spot = seriesValueAt(base, logical);
              const rows: GreekRow[] =
                spot == null
                  ? []
                  : [
                      {
                        color: '#2962ff',
                        label: symRef.current,
                        value: spot,
                        format: (v: number) => '₹' + fmtPrice(v),
                      },
                    ];
              return (
                <GreekPinCard
                  time={pin.time}
                  rows={[...rows, ...greekRows(chart, base, null, logical)]}
                />
              );
            }}
          />
        )}
        {!instrument && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--text-muted)] pointer-events-none">
            No underlying resolved for this strategy.
          </div>
        )}
        {instrument && !bars.length && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[var(--text-muted)] pointer-events-none">
            Waiting for underlying bars…
          </div>
        )}
      </div>
    </div>
  );
}
