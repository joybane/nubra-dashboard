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

import { useCallback, useEffect, useRef, useState } from 'react';
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
  createGreekTooltip,
  fmtCompact,
  fmtCrosshairTime,
  greekRows,
  logicalAtTime,
  seriesValueAt,
  PANEL_TOOLTIP_STYLE,
  type GreekRow,
  type GreekTooltipView,
} from '../lib/greekTooltip';
import { removeChart } from '../lib/chartLifecycle';
import type { ScaleBand } from '../lib/greekRenderer';
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
  // Same chrome as PANEL_TOOLTIP_STYLE and the ChartTooltips `*Body` cards — a pin and a hover
  // reading sit side by side in this pane, so they must be the same object in two states.
  return (
    <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]">
      <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">
        {fmtCrosshairTime(time)}
      </div>
      {rows.length === 0 ? (
        // Distinct from "no data": the pin can sit on a bar the overlays are simply switched
        // off for, and saying so beats an empty box that reads as a broken card.
        <div className="text-[10px] text-[var(--text-muted)]">No overlay at this bar</div>
      ) : (
        rows.map((r) => (
          <div
            key={r.label}
            className="flex items-center justify-between gap-4 text-[11px] py-0.5 whitespace-nowrap"
          >
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: r.color }}
              />
              {r.label}
            </span>
            <span className="text-[var(--text-primary)] font-medium tabular-nums">
              {(r.format ?? fmtCompact)(r.value)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Stacking several measures in one pane ──────────────────────────────────────
//
// Vega sits near +70 and Theta near −75. Plot both against one price scale and each holds the axis
// open for the other: neither can ever expand, both get pressed against the pane's edges, and
// zooming does not help because every window is still spanned by both. So each enabled measure
// gets a disjoint slice of the pane and auto-scales inside it — its own scale, its own range.
//
// The measures are sliced in tray order, which is also the order the buttons read left to right.
type Measure = 'vega' | 'theta' | 'iv';
const MEASURE_ORDER: Measure[] = ['vega', 'theta', 'iv'];

/** The renderer's own inline margins. A lone measure keeps them, so one-measure panes are unchanged. */
const FULL_BAND: ScaleBand = { top: 0.1, bottom: 0.08 };
/** Empty height kept above and below each slice once the pane is shared, so bands read as separate. */
const BAND_GUTTER = 0.05;

interface Layout {
  /**
   * The measure whose totals get the visible LEFT axis — the first one enabled. Only one series
   * can own an axis, and because that scale carries the owner's band too, its ticks and grid lines
   * are drawn only inside the owner's slice, describing the band they sit beside. Every other
   * measure keeps its last-value tags (right column, correct values), exactly as the Δ lines do.
   *
   * Never null: with nothing enabled it falls back to the first measure, so the pane is already
   * holding the axis open for the switch the user is about to make.
   */
  axis: Measure;
  bands: Record<Measure, ScaleBand>;
}

function layoutFor(enabled: Measure[]): Layout {
  const bands: Record<Measure, ScaleBand> = { vega: FULL_BAND, theta: FULL_BAND, iv: FULL_BAND };
  const n = enabled.length;
  enabled.forEach((m, i) => {
    if (n > 1) bands[m] = { top: i / n + BAND_GUTTER, bottom: (n - 1 - i) / n + BAND_GUTTER };
  });
  // Seeded with the first measure rather than null so the common path — open the pane, switch Vega
  // on — builds its panes on the left axis outright instead of rebuilding onto it a render later.
  return { axis: enabled[0] ?? MEASURE_ORDER[0], bands };
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
   * The host's own chart metrics, so this pane's plot area starts and ends where its siblings'
   * do — price-scale gutter widths in px, and the axis font size.
   *
   * A host stacks this pane under its price and P&L panes and syncs all of them to one logical
   * range, but a logical range only lines up on screen if the plot areas do, and a plot area
   * starts where its left price scale ends. `fontSize` is here for the same reason and not as
   * styling: a price scale is as wide as its widest label or its `minimumWidth`, whichever wins,
   * so a pane rendering its ticks a point larger than its neighbours can outgrow the gutter they
   * agreed on and drift out of step again.
   *
   * The defaults match the hosts that build their panes at 75/75 and 12px (Nubra BT, the
   * backtest trade view); StrategyAnalysisView is 60/75 at 11px and says so.
   */
  axisMetrics?: { leftWidth: number; rightWidth: number; fontSize: number };
  /**
   * Handed the pane's chart on mount and null on unmount, so the host can enroll it in its own
   * scroll/crosshair sync and the pane scrolls in lockstep with price and P&L.
   *
   * The underlying reference series comes with it because `setCrosshairPosition` needs a series
   * to place the crosshair against — a host pushing a synced crosshair onto this pane has no
   * other way to name one, and reaching into `chart.panes()[0].getSeries()[0]` would silently
   * depend on the overlays never being added ahead of it.
   *
   * `syncCrosshair` is the readout half of that: `setCrosshairPosition` suppresses the crosshair
   * event (see `createGreekTooltip`), so a host that syncs a crosshair here must also name the
   * instant, or the pane draws the lines with no card beside them. Pass null to hide it.
   */
  onChartReady?: (
    chart: IChartApi | null,
    baseSeries: ISeriesApi<'Line'> | null,
    syncCrosshair: ((time: number | null) => void) | null,
  ) => void;
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
  axisMetrics = { leftWidth: 75, rightWidth: 75, fontSize: 12 },
  onChartReady,
  pins,
  onTogglePin,
  onRemovePin,
}: GreekIndicatorPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null);
  // The card the HOST drives, for instants the cursor is in another pane for. Distinct from the
  // hover binding below, which owns the same element while the cursor is in this pane.
  const syncTooltipRef = useRef<GreekTooltipView | null>(null);

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

  /** Shown while the cursor is elsewhere; a no-op until the chart exists. */
  const showSyncedCrosshair = useCallback((time: number | null) => {
    syncTooltipRef.current?.showAt(time);
  }, []);

  // `axisScaleId: 'left'` is what keeps a measure's totals off the right scale. This pane belongs
  // to the overlays, so the owning measure's totals get the real left axis and the underlying
  // reference line keeps the right one to itself — the same division the host's price pane makes
  // between its legs and its candles. On an invisible overlay scale (the Tracker's arrangement)
  // lightweight-charts hangs every greek's axis tag off the right scale instead, stacking readings
  // in the hundreds against an axis ticked in thousands of rupees, describing neither.
  //
  // The layout is state rather than something derived here because `on` belongs to the hooks, and
  // a hook cannot be fed a value that its own return decides — so the enabled set reaches the next
  // render through the effect below. One extra render per toggle, and none per tick.
  const [layout, setLayout] = useState<Layout>(() => layoutFor([]));
  const overlayDeps = {
    chartRef,
    currentInstRef,
    allBarsRef,
    inline: true,
    histDays,
    initialDay,
  };
  const bandFor = (m: Measure) => ({
    axisScaleId: layout.axis === m ? 'left' : undefined,
    bandTop: layout.bands[m].top,
    bandBottom: layout.bands[m].bottom,
  });
  const vega = useGreekOverlay({ greek: 'vega', ...overlayDeps, ...bandFor('vega') });
  const theta = useGreekOverlay({ greek: 'theta', ...overlayDeps, ...bandFor('theta') });
  const iv = useGreekOverlay({ greek: 'iv', ...overlayDeps, ...bandFor('iv') });

  // Re-slice whenever the enabled set changes. Nothing here touches a series: bands are scale
  // margins, so this is a live option change on scales that already exist.
  useEffect(() => {
    const isOn: Record<Measure, boolean> = { vega: vega.on, theta: theta.on, iv: iv.on };
    const enabled = MEASURE_ORDER.filter((m) => isOn[m]);
    setLayout(layoutFor(enabled));
    // With every measure off nobody owns the left scale, so put it back on the margins the chart
    // opened with rather than leaving the last owner's slice on an empty axis.
    if (!enabled.length)
      chartRef.current?.priceScale('left').applyOptions({ scaleMargins: FULL_BAND });
  }, [vega.on, theta.on, iv.on]);

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
        fontSize: axisMetrics.fontSize,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      // Both gutters, at the host's widths — see `axisMetrics`. The left one carries the
      // overlays' totals; it stays visible even with every overlay switched off, exactly as the
      // host's P&L pane keeps an empty left gutter, because the alignment is what it is for.
      leftPriceScale: {
        visible: true,
        borderColor: isDark ? '#2a2d32' : '#e0e3eb',
        minimumWidth: axisMetrics.leftWidth,
      },
      rightPriceScale: {
        visible: true,
        borderColor: isDark ? '#2a2d32' : '#e0e3eb',
        minimumWidth: axisMetrics.rightWidth,
      },
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

    // A faint underlying reference line, on the RIGHT scale — the side the host's price pane
    // charts its underlying on, so the two axes read the same numbers. Stated rather than left
    // to the default because `setCrosshairPosition` prices a synced crosshair off the pane's
    // default scale, and that has to be the scale this line actually lives on.
    const line = chart.addSeries(LineSeries, {
      color: '#2962ff',
      lineWidth: 1,
      priceScaleId: 'right',
      priceLineVisible: false,
      lastValueVisible: true,
      // barsToSessionLine paints each session's last point SESSION_BREAK_COLOR to stop the line
      // running into the next session; without this the hover dot would vanish on that bar, since
      // its colour otherwise follows the point's.
      crosshairMarkerBackgroundColor: '#2962ff',
    } as Partial<LineSeriesOptions>);
    line.priceScale().applyOptions({ autoScale: true, scaleMargins: { top: 0.08, bottom: 0.1 } });
    // The overlays' own axis. Seeded with the margins `createGreekPane` applies to an inline
    // overlay's scale, so switching the first overlay on does not shift the band the gutter
    // already implied — and so an empty left axis still reads against the same grid.
    chart
      .priceScale('left')
      .applyOptions({ autoScale: true, scaleMargins: { top: 0.1, bottom: 0.08 } });
    lineRef.current = line;

    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      chart.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(containerRef.current);

    const tooltipOpts =
      tooltipRef.current && containerRef.current
        ? {
            chart,
            container: containerRef.current,
            tooltip: tooltipRef.current,
            baseSeries: () => lineRef.current,
            baseLabel: () => symRef.current,
            formatBase: (v: number) => '₹' + fmtPrice(v),
            // This pane sits in a stack, so its card wears the same chrome as its siblings' and
            // swings to the same side of the crosshair they do.
            style: PANEL_TOOLTIP_STYLE,
            flipAtMidpoint: true,
          }
        : null;
    const unbindCrosshair = tooltipOpts ? bindGreekCrosshair(tooltipOpts) : () => {};
    syncTooltipRef.current = tooltipOpts ? createGreekTooltip(tooltipOpts) : null;

    onChartReady?.(chart, line, showSyncedCrosshair);
    setChartTick((t) => t + 1);

    return () => {
      observer.disconnect();
      unbindCrosshair();
      syncTooltipRef.current = null;
      onChartReady?.(null, null, null);
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

  // ── Double-click: hand the price axes back to autoscale ────────────────────
  // Dragging a price axis scales it by hand, and lightweight-charts switches that scale's
  // `autoScale` off for good when you do — from then on the lines drift out of the pane on every
  // zoom and nothing brings them back. The Tracker has had this escape hatch since it hit the same
  // wall; this pane needs it more, since it shows two visible axes.
  //
  // Price scales only. The Tracker also resets its time range here, but this chart is enrolled in
  // the host's scroll sync, so touching the time scale would drag price and P&L along with it.
  // Margins are left alone deliberately: an axis drag changes the range, never the band.
  useEffect(() => {
    const el = containerRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;
    const onDblClick = () => {
      for (const id of ['left', 'right']) {
        try {
          chart.priceScale(id).applyOptions({ autoScale: true });
        } catch {
          /* scale not on this chart */
        }
      }
    };
    el.addEventListener('dblclick', onDblClick);
    return () => el.removeEventListener('dblclick', onDblClick);
  }, [chartTick]);

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
          className="absolute z-30 hidden pointer-events-none bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]"
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
