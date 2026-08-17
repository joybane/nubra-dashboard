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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineSeries,
  type AutoscaleInfoProvider,
  type IChartApi,
  type ISeriesApi,
  type LineSeriesOptions,
  type MouseEventParams,
} from 'lightweight-charts';
import type { Instrument, OhlcBar } from '../types';
import { getSymbol } from '../types';
import { useGreekOverlay } from '../hooks/useGreekOverlay';
import { GreekButton } from './GreekControls';
import {
  bindGreekCrosshair,
  createGreekTooltip,
  diffGreekRows,
  fmtCompact,
  fmtCrosshairTime,
  greekRows,
  logicalAtTime,
  seriesValueAt,
  PANEL_TOOLTIP_STYLE,
  type CrosshairTime,
  type GreekRow,
  type GreekTooltipView,
} from '../lib/greekTooltip';
import { pickAxisTarget, type AxisCandidate } from '../lib/axisFollow';
import type { VScale } from '../lib/greekRenderer';
import { isChartLive, removeChart } from '../lib/chartLifecycle';
import { barsToSessionLine, fmtPrice, isMarketSessionChartTime } from '../lib/utils';
import PinnedCrosshairLayer from './PinnedCrosshairLayer';
import PinCompareStrip, { type CompareRow } from './PinCompareStrip';
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
// Vega sits near +40 and Theta near −300, so they cannot share a price scale: each would hold the
// axis open across the other's range and both would be squashed into a fraction of the height with
// a dead gap between them. They do not share one — every measure already gets its OWN overlay
// scale (see `scaleKey` in greekRenderer), and every one of those scales spans the FULL pane and
// auto-scales to the visible window.
//
// That is the whole arrangement, and it is why there are no bands here any more. An earlier version
// sliced the pane into disjoint horizontal bands, one per measure. It did separate them, but it
// also pinned Vega to the top third and Theta to the bottom third for good, and it meant each
// measure could only ever use a third of the height. Full-height auto-scaling separates them just
// as well — because the scales are separate, not because the space is — while letting every line
// use the whole pane and re-fit as you zoom.
//
// The cost, stated plainly: vertical position is no longer comparable ACROSS measures. A Theta line
// above a Vega line means nothing. That is what the two features below are for — the axis follows
// the cursor so any line can be read against real ticks, and the stretch reaches every scale at
// once so any line can be inspected closely.
//
// ─── Reading the lines: an axis that follows the cursor ─────────────────────────
//
// A pane can show at most two price axes — lightweight-charts builds a PriceAxisWidget for 'left'
// and 'right' and nothing else — and one of those is the underlying's. So with five greek scales in
// here, any fixed assignment leaves most lines with nothing but a floating last-value tag.
//
// Instead the LEFT axis follows the cursor: hover a line and the axis shows that line's range and
// number format. It cannot be done by moving series onto the axis, because `priceScaleId` is fixed
// at series creation and following the cursor that way would destroy and rebuild four series per
// hover. So an invisible ANCHOR series sits alone on the left scale, and its `autoscaleInfoProvider`
// returns whichever line's range is wanted. Nothing moves between scales; one option changes.
//
// The ticks land in the right place because every overlay scale in this pane carries identical
// `scaleMargins`, so two scales holding the same range paint their gridlines at the same y.
/**
 * The scale the anchor occupies, and therefore the axis that follows the cursor.
 *
 * 'left' rather than 'right' because the underlying keeps the right one: its price is what the
 * sibling price pane ticks, so the two axes agree, and `setCrosshairPosition` prices a host-synced
 * crosshair off the scale that series actually lives on.
 */
const AXIS_ANCHOR_SCALE = 'left';

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
  // Which of those two is allowed to write the card right now. A ref, not state: it is read inside
  // crosshair callbacks on every tick and must never cause a render.
  const pointerInsideRef = useRef(false);

  // ── The left axis and the line it currently describes ──────────────────────
  // `anchorRef` plots nothing. It exists only to occupy the 'left' scale so that scale can be
  // given the range of whichever line the cursor is nearest; see the header note.
  const anchorRef = useRef<ISeriesApi<'Line'> | null>(null);
  const axisTargetRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Mirrored into state purely to caption the axis in the header — an axis gutter is a canvas and
  // cannot label itself, so without this nothing on screen says whose numbers those ticks are.
  const [axisLabel, setAxisLabel] = useState<{ label: string; color: string } | null>(null);
  // Following the cursor is unusable on its own: move toward the gutter to read a tick and the
  // axis has already changed to whatever you passed over. Locking freezes it on one line.
  const axisLockedRef = useRef(false);
  const [axisLocked, setAxisLocked] = useState(false);
  // Shown beside the reset control while the pane is stretched, so a non-1 scale always says so.
  const [vZoomLabel, setVZoomLabel] = useState(1);

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

  // No measure owns an axis. Every greek and IV line sits on its own private overlay scale, and the
  // left axis is driven by the anchor instead — so nothing here passes `axisScaleId`, and toggling
  // a measure no longer rebuilds another measure's series to hand the axis over.
  //
  // `vScale` is a getter over a ref rather than a value, so a stretch drag mutates one object and
  // repaints, without re-rendering this component or re-running the hooks.
  const vScaleRef = useRef<VScale>({ zoom: 1, pan: 0 });
  const readVScale = useCallback(() => vScaleRef.current, []);
  // Memoised so the three hooks below are handed the same argument object across renders — this
  // view re-renders on every price tick, and every ref in here is stable by construction.
  const overlayDeps = useMemo(
    () => ({
      chartRef,
      currentInstRef,
      allBarsRef,
      inline: true as const,
      vScale: readVScale,
      histDays,
      initialDay,
    }),
    [readVScale, histDays, initialDay],
  );
  const vega = useGreekOverlay({ greek: 'vega', ...overlayDeps });
  const theta = useGreekOverlay({ greek: 'theta', ...overlayDeps });
  const iv = useGreekOverlay({ greek: 'iv', ...overlayDeps });

  // The hooks hand back a fresh object every render, so the callbacks below read them through refs
  // — the same reason `togglePinRef` exists. Without this, `resetAllScales` would change identity
  // on every tick and rebind the dblclick listener with it.
  const vegaRef = useRef(vega);
  const thetaRef = useRef(theta);
  const ivRef = useRef(iv);
  vegaRef.current = vega;
  thetaRef.current = theta;
  ivRef.current = iv;

  /**
   * The range the left axis should hold: whatever scale the target line is on.
   *
   * Read live rather than cached, so the axis cannot describe a range the target has since left.
   * `getVisibleRange` is the scale's own range excluding `scaleMargins`, and every overlay scale in
   * this pane carries the same margins as 'left' — so handing the anchor that range puts the ticks
   * exactly where the target line's values are.
   *
   * A stable identity (`useCallback([])`) because re-applying this same function object is how a
   * repaint is forced.
   */
  const anchorProvider = useCallback<AutoscaleInfoProvider>(() => {
    const target = axisTargetRef.current;
    if (!target) return null; // nothing hovered yet — the axis stays blank rather than inventing one
    let r: { from: number; to: number } | null = null;
    try {
      r = target.priceScale().getVisibleRange();
    } catch {
      r = null; // series removed between the hover and this recalculation
    }
    if (!r || !Number.isFinite(r.from) || !Number.isFinite(r.to) || r.from === r.to) return null;
    return {
      priceRange: { minValue: Math.min(r.from, r.to), maxValue: Math.max(r.from, r.to) },
    };
  }, []);

  /**
   * Repaint after `vScaleRef` or the axis target moves.
   *
   * Poking one series would in fact be enough for the entire pane — `applyOptions` raises a Light
   * invalidation and the pane widget then recalculates its left, right and every overlay scale —
   * but each hook only reaches its own panes, so each is asked in turn. Three pokes, not eight.
   */
  const applyVScale = useCallback(() => {
    vegaRef.current?.applyVScale();
    thetaRef.current?.applyVScale();
    ivRef.current?.applyVScale();
    // Asked last, and separately: the anchor belongs to no hook, and with every measure switched
    // off it is the only series in the pane carrying a provider at all.
    anchorRef.current?.applyOptions({ autoscaleInfoProvider: anchorProvider });
  }, [anchorProvider]);

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
    // The overlays' own axis. Its margins MUST match the ones `createGreekPane` applies to an
    // inline overlay's scale: the anchor lends this axis another scale's range, and two scales only
    // paint their gridlines at the same y when their margins agree. This is what makes the ticks
    // land on the target line's values rather than near them.
    chart
      .priceScale('left')
      .applyOptions({ autoScale: true, scaleMargins: { top: 0.1, bottom: 0.08 } });
    lineRef.current = line;

    // The axis anchor. Transparent and tagless — it is never read, only measured. It carries the
    // underlying's own data (set alongside it below) because a series with no points in the visible
    // range contributes nothing to a scale's recalculation, and then its provider is never asked.
    const anchor = chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      priceScaleId: AXIS_ANCHOR_SCALE,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: anchorProvider,
      // Replaced with the target's own format the moment one is chosen — see `setAxisTarget`.
      priceFormat: {
        type: 'custom' as const,
        minMove: 0.01,
        formatter: (v: number) => v.toFixed(2),
      },
    } as Partial<LineSeriesOptions>);
    anchorRef.current = anchor;

    const observer = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      chart.resize(el.clientWidth, el.clientHeight);
    });
    observer.observe(containerRef.current);

    // Which of the two tooltip drivers below may write the card — see `isPointerInside` in
    // greekTooltip. Pointer events rather than mouse ones so a touch drag counts as being in the
    // pane, and `pointercancel` because a drag stolen by the browser fires no `pointerleave`.
    //
    // `pointermove` as well as `pointerenter`, in the CAPTURE phase: enter alone never fires for a
    // cursor that was already over the pane when it mounted, and a bubble-phase listener on this
    // container runs AFTER the chart canvas' own handler — so the first move would be judged
    // against a flag that had not been set yet.
    const paneEl = containerRef.current;
    const onPointerIn = () => {
      pointerInsideRef.current = true;
    };
    const onPointerOut = () => {
      pointerInsideRef.current = false;
    };
    paneEl.addEventListener('pointerenter', onPointerIn, true);
    paneEl.addEventListener('pointermove', onPointerIn, true);
    paneEl.addEventListener('pointerleave', onPointerOut, true);
    paneEl.addEventListener('pointercancel', onPointerOut, true);

    const tooltipOpts =
      tooltipRef.current && containerRef.current
        ? {
            chart,
            container: containerRef.current,
            tooltip: tooltipRef.current,
            baseSeries: () => lineRef.current,
            baseLabel: () => symRef.current,
            formatBase: (v: number) => '₹' + fmtPrice(v),
            // The anchor is not a reading; left in it would show up as a nameless row.
            excludeSeries: () => [anchorRef.current],
            // This pane sits in a stack, so its card wears the same chrome as its siblings' and
            // swings to the same side of the crosshair they do.
            style: PANEL_TOOLTIP_STYLE,
            flipAtMidpoint: true,
            isPointerInside: () => pointerInsideRef.current,
          }
        : null;
    const unbindCrosshair = tooltipOpts ? bindGreekCrosshair(tooltipOpts) : () => {};
    syncTooltipRef.current = tooltipOpts ? createGreekTooltip(tooltipOpts) : null;

    onChartReady?.(chart, line, showSyncedCrosshair);
    setChartTick((t) => t + 1);

    return () => {
      observer.disconnect();
      paneEl.removeEventListener('pointerenter', onPointerIn, true);
      paneEl.removeEventListener('pointermove', onPointerIn, true);
      paneEl.removeEventListener('pointerleave', onPointerOut, true);
      paneEl.removeEventListener('pointercancel', onPointerOut, true);
      pointerInsideRef.current = false;
      unbindCrosshair();
      syncTooltipRef.current = null;
      onChartReady?.(null, null, null);
      removeChart(chart);
      chartRef.current = null;
      lineRef.current = null;
      anchorRef.current = null;
      axisTargetRef.current = null;
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
  // Ends and length of the grid this effect last rebuilt from. The hosts hand over a fresh array
  // on every price tick with only the trailing bar's VALUES changed — see the fast path below.
  const gridSigRef = useRef('');
  useEffect(() => {
    const line = lineRef.current;
    if (!line) return;
    const n = bars.length;
    const last = n ? bars[n - 1] : null;
    const sig = n ? `${n}:${bars[0].time}:${last!.time}:${exchange}` : `0::${exchange}`;

    /**
     * Nothing but the trailing bar's values moved: `update` it and stop.
     *
     * This is the common case by a wide margin — the hosts replace the array identity on every
     * underlying tick so this effect notices the in-place mutation — and it used to cost a
     * `barsToSessionLine` pass over every loaded bar, two full-array `setData`s, and three greek
     * redraws, several times a second.
     *
     * Identical output, not an approximation: `markSessionBreaks` only recolours a point when a
     * LATER point opens a new day, so the final point never carries SESSION_BREAK_COLOR and a
     * plain `{time, value}` is exactly what the rebuild would have produced for it. The greeks are
     * left alone deliberately — the bar grid they snap onto has not moved a column, and they
     * redraw off their own chain ticks.
     */
    if (sig === gridSigRef.current && last && isMarketSessionChartTime(last.time, exchange)) {
      const pt = { time: last.time, value: last.close } as Parameters<typeof line.update>[0];
      line.update(pt);
      anchorRef.current?.update(pt);
      return;
    }
    gridSigRef.current = sig;

    const sessionLine = barsToSessionLine(bars, exchange) as Parameters<typeof line.setData>[0];
    line.setData(sessionLine);
    // The anchor gets the same points — not to draw them (it is transparent) but so it has data in
    // the visible range. A source with none contributes nothing to a scale's recalculation, and its
    // `autoscaleInfoProvider` is then never consulted, which would leave the left axis blank.
    anchorRef.current?.setData(sessionLine);
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

  // ── What this pane reads at one instant ────────────────────────────────────
  // The underlying, then every overlay line currently drawn. Shared by the pinned card and the Δ
  // strip below so the two cannot end up describing different lines: both are built from the
  // pane's own series, because the host's snapshot builder knows its price / P&L / Greeks shapes
  // and nothing about which aggregate overlays happen to be switched on here.
  const rowsAt = useCallback((time: number): GreekRow[] => {
    const chart = chartRef.current;
    if (!chart) return [];
    const logical = logicalAtTime(chart, time);
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
    return [...rows, ...greekRows(chart, [base, anchorRef.current], null, logical)];
  }, []);

  // ── The left axis follows the cursor ───────────────────────────────────────
  // Point at a line and the axis takes that line's range and its own number format. The format is
  // copied off the target rather than inferred from its label — greeks compact to K/M/B and IV is
  // plain vol points, and deriving that from display text is exactly the coupling `scaleSuffix`
  // warns about in greekRenderer.
  const setAxisTarget = useCallback(
    (target: ISeriesApi<'Line'> | null) => {
      if (axisTargetRef.current === target) return;
      axisTargetRef.current = target;
      const anchor = anchorRef.current;
      if (target && anchor) {
        const o = target.options() as { title?: string; color?: string; priceFormat?: unknown };
        anchor.applyOptions({
          priceFormat: o.priceFormat,
        } as Partial<LineSeriesOptions>);
        setAxisLabel({ label: o.title || '', color: o.color || '#888' });
      } else if (!target) {
        setAxisLabel(null);
      }
      applyVScale();
    },
    [applyVScale],
  );

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    // Coalesced to one hit test per frame. The pass below enumerates every series in the pane and
    // asks each for a coordinate — a forced layout per line, nine of them with all three measures
    // on — and the tooltip runs its own enumeration off the same event. A pointer emits far more
    // moves than there are frames to draw them in, and only the last one of a frame can be seen.
    let raf = 0;
    let pending: MouseEventParams | null = null;

    const run = () => {
      raf = 0;
      const param = pending;
      pending = null;
      if (!param || axisLockedRef.current || !isChartLive(chart)) return;
      const logical =
        param.logical ??
        (param.time != null ? logicalAtTime(chart, param.time as CrosshairTime) : null);
      // The same enumeration and carry-forward the tooltip uses, so the axis can never follow a
      // line the tooltip is not reporting. `series` comes back on the row for exactly this.
      const rows = greekRows(
        chart,
        [lineRef.current, anchorRef.current],
        (s) => (param.seriesData.get(s) as { value?: number } | undefined)?.value,
        logical,
      );
      const candidates: AxisCandidate<ISeriesApi<'Line'>>[] = [];
      for (const r of rows) {
        if (!r.series) continue;
        const y = r.series.priceToCoordinate(r.value);
        if (y == null) continue;
        candidates.push({ key: r.series, y });
      }
      setAxisTarget(pickAxisTarget(candidates, param.point?.y ?? null, axisTargetRef.current));
    };

    const onMove = (param: MouseEventParams) => {
      if (axisLockedRef.current) return;
      pending = param;
      if (!raf) raf = requestAnimationFrame(run);
    };

    chart.subscribeCrosshairMove(onMove);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      pending = null;
      try {
        chart.unsubscribeCrosshairMove(onMove);
      } catch {
        /* chart already disposed */
      }
    };
  }, [chartTick, setAxisTarget]);

  // A measure switched off — or switched between mine/industry, or totals/Δ — destroys and rebuilds
  // its series, so an axis pointed at one would be describing a line that has left the chart, under
  // a caption still naming it. The hit test self-heals on the next hover (a target missing from the
  // candidate list has no claim to stickiness, so anything in range takes the axis immediately);
  // this is for the caption, which would otherwise sit there lying until the cursor came back.
  //
  // Unlocking too: a lock is a promise to keep showing ONE line, and that promise cannot be kept
  // once the line is gone.
  useEffect(() => {
    const target = axisTargetRef.current;
    if (!target) return;
    const chart = chartRef.current;
    let live = false;
    try {
      live =
        (chart?.panes()[0]?.getSeries() ?? []).includes(target) &&
        (target.options() as { visible?: boolean }).visible !== false;
    } catch {
      live = false; // series or chart already disposed
    }
    if (live) return;
    axisLockedRef.current = false;
    setAxisLocked(false);
    setAxisTarget(null);
  }, [
    vega.on,
    theta.on,
    iv.on,
    vega.method,
    theta.method,
    vega.seriesMode,
    theta.seriesMode,
    vega.showCalls,
    theta.showCalls,
    vega.showPuts,
    theta.showPuts,
    iv.ivMeasure,
    setAxisTarget,
  ]);

  // ── The Δ strip: what moved between the two pinned instants ────────────────
  // The sibling price and P&L panes each carry one; this pane could not, because the Δ has to be
  // taken over the lines it is actually drawing. Only exact pairs — a single pin is a reading,
  // not a comparison, which is the rule the other panes follow too.
  const pinCompare = (() => {
    if (!pins || pins.length !== 2) return null;
    const [a, b] = pins;
    const rows: CompareRow[] = diffGreekRows(rowsAt(a.time), rowsAt(b.time)).map((d) => ({
      ...d,
      // The underlying is a price; every other row is an aggregate greek, which can reach ~1e9.
      kind: d.label === symRef.current ? ('price' as const) : ('compact' as const),
    }));
    return rows.length ? { dtSeconds: b.time - a.time, rows } : null;
  })();

  // ── Stretching the lines: a drag on either gutter ──────────────────────────
  // The library's own price-axis drag can only ever reach 'left' and 'right' — a PriceAxisWidget
  // exists for those two gutters and nothing else — so with eight greek lines on private overlay
  // scales, the built-in gesture moves one measure's totals and leaves the other seven untouched.
  // That is the bug this replaces.
  //
  // The gesture is claimed in the CAPTURE phase, the same trick `bindPinTrigger` uses, so
  // lightweight-charts' own handler never sees the mousedown and cannot also scale 'left' on top of
  // what we do. `handleScale` is therefore left exactly as it was: the time axis, wheel and pinch
  // are untouched, and so is the double-click reset.
  //
  // What moves is a FACTOR over each scale's own auto-fit, never a fixed range. Every scale stays
  // on autoscale, so each keeps re-fitting the visible window as the time axis zooms, with the
  // stretch multiplied on top — and no line can be stranded off-pane the way a frozen range strands
  // one. `IPriceScaleApi.setVisibleRange` would have been the shorter road and is exactly that trap.
  useEffect(() => {
    const el = containerRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;

    let start: { y: number; zoom: number; pan: number; shift: boolean } | null = null;
    let frame: number | null = null;

    const inGutter = (ev: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      let leftW = 0;
      try {
        leftW = chart.priceScale('left').width() ?? 0;
      } catch {
        leftW = 0;
      }
      return x <= leftW || x >= rect.width - axisMetrics.rightWidth;
    };

    const schedule = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        applyVScale();
      });
    };

    const onMouseDown = (ev: MouseEvent) => {
      if (ev.button !== 0 || !inGutter(ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const { zoom, pan } = vScaleRef.current;
      start = { y: ev.clientY, zoom, pan, shift: ev.shiftKey };
      el.style.cursor = 'ns-resize';
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (ev: MouseEvent) => {
      if (!start) return;
      const dy = ev.clientY - start.y;
      if (start.shift) {
        // Pan in units of the auto half-range. Half the pane's height is one half-range, so a drag
        // moves every line by the pixels the cursor moved, whatever each line's magnitude.
        const half = Math.max(1, el.clientHeight / 2);
        vScaleRef.current = { zoom: start.zoom, pan: start.pan + dy / half };
      } else {
        // Dragging UP stretches, matching the native axis gesture. Exponential so the feel is the
        // same at 1× and at 10× — a linear factor crawls when zoomed in and lurches when zoomed out.
        vScaleRef.current = { zoom: start.zoom * Math.exp(-dy / 180), pan: start.pan };
        setVZoomLabel(vScaleRef.current.zoom);
      }
      schedule();
    };

    const onMouseUp = () => {
      start = null;
      el.style.cursor = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    el.addEventListener('mousedown', onMouseDown, true);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      el.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [chartTick, applyVScale, axisMetrics.rightWidth]);

  // ── Reset: back to 1×, unlocked, everything auto-scaling ───────────────────
  // Three things can leave this pane in a state the user cannot get out of by hovering: a stretch
  // factor, a locked axis, and a scale some earlier drag latched off autoscale. One control clears
  // all three, because from the outside they are one complaint — "it will not go back".
  //
  // Price scales only. The Tracker also resets its time range here, but this chart is enrolled in
  // the host's scroll sync, so touching the time scale would drag price and P&L along with it.
  // Margins are left alone deliberately: a drag changes the range, never the layout.
  const resetAllScales = useCallback(() => {
    vScaleRef.current = { zoom: 1, pan: 0 };
    setVZoomLabel(1);
    axisLockedRef.current = false;
    setAxisLocked(false);
    const chart = chartRef.current;
    if (chart)
      for (const id of ['left', 'right']) {
        try {
          chart.priceScale(id).applyOptions({ autoScale: true });
        } catch {
          /* scale not on this chart */
        }
      }
    vegaRef.current?.resetScales();
    thetaRef.current?.resetScales();
    ivRef.current?.resetScales();
    applyVScale();
  }, [applyVScale]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !chartRef.current) return;
    el.addEventListener('dblclick', resetAllScales);
    return () => el.removeEventListener('dblclick', resetAllScales);
  }, [chartTick, resetAllScales]);

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
        {/*
          Which line the left axis is describing. The gutter is a canvas and cannot caption itself,
          so without this the ticks are numbers with no owner — and with nine lines in the pane that
          is most of the readability problem. Doubles as the lock, because an axis that follows the
          cursor is unusable for reading a line's shape: you move toward the ticks and it has
          already changed to whatever you passed over.
        */}
        {axisLabel && (
          <button
            type="button"
            onClick={() => {
              const next = !axisLockedRef.current;
              axisLockedRef.current = next;
              setAxisLocked(next);
            }}
            title={
              axisLocked
                ? 'Left axis is locked to this line — click to follow the cursor again'
                : 'Left axis follows the cursor — click to lock it to this line'
            }
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] leading-none max-w-[190px] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)] ${
              axisLocked ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
            }`}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: axisLabel.color }}
            />
            <span className="truncate">{axisLabel.label}</span>
            <span className="shrink-0 opacity-70">{axisLocked ? '🔒' : '🔓'}</span>
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {/* Silent at 1×: a readout that is always on screen stops being a signal. */}
          {Math.abs(vZoomLabel - 1) > 0.01 && (
            <span className="text-[10px] tabular-nums text-[var(--text-muted)]">
              {vZoomLabel.toFixed(1)}×
            </span>
          )}
          {/* Double-clicking the plot does the same thing, but nothing on screen says so. */}
          <button
            type="button"
            onClick={resetAllScales}
            title="Reset the vertical scale and unlock the axis. Drag either price gutter to stretch every line, shift-drag to pan. Double-clicking the pane does the same as this button."
            aria-label="Reset vertical scales"
            className="px-1.5 py-0.5 rounded text-[11px] leading-none text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
          >
            ⟲
          </button>
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
              // Same rows the hover tooltip shows, read at the pinned instant instead of the
              // cursor — including the underlying, so a frozen card and a live one agree.
              if (!chartRef.current) return null;
              return <GreekPinCard time={pin.time} rows={rowsAt(pin.time)} />;
            }}
            compare={
              pinCompare && (
                <PinCompareStrip
                  dtSeconds={pinCompare.dtSeconds}
                  rows={pinCompare.rows}
                  colors={[pins[0].color, pins[1].color]}
                />
              )
            }
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
