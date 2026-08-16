// ─── Sub-pane line renderer for aggregate Vega / Theta time series ───────────────
//
// Each "method pane" is a genuine lightweight-charts pane below the price pane,
// with its own time-aligned x-axis. It plots up to four lines:
//
//   • CE / PE absolute totals   (Spec §2)  — solid, on the visible right scale
//   • CE / PE difference-from-open (Spec §3) — dashed, on an overlay scale so it
//     auto-scales independently of the (much larger) totals
//
// Totals and differences live on different magnitudes, so co-plotting them on one
// axis would flatten the diff; the overlay scale keeps both readable.

import {
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  IST_OFFSET,
  chartTimeDayKey,
  isMarketSessionChartTime,
  markSessionBreaks,
} from './utils.ts';
import type { IvPoint, SeriesPoint } from './greekAggregator.ts';

export type SeriesMode = 'totals' | 'diff' | 'both';

const CE_COLOR = '#22c55e';
const PE_COLOR = '#ef4444';
const DIFF_SCALE = 'greekDiff';

/** Inline overlay greeks can reach ~1e9 (industry = greek×OI×lot); keep axis tags short. */
function compactAxis(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(2);
}

/** Convert a snapshot epoch-ms timestamp to lightweight-charts intraday time. */
export function msToChartTime(ms: number): UTCTimestamp {
  return (Math.floor(ms / 1000) + IST_OFFSET) as UTCTimestamp;
}

/**
 * Maps a snapshot epoch-ms timestamp to a chart-time (seconds). Returning null
 * drops the point (e.g. it falls outside the loaded candle range). Callers snap
 * to the candle grid so greek points coincide with candles instead of creating
 * their own off-grid columns.
 */
export type TimeMapper = (ms: number) => number | null;

/**
 * Overlay price-scale id suffix. Inline overlays each need their OWN scale — if two collide
 * they share an axis and one silently rescales the other flat, with no error anywhere.
 *
 * Callers should pass an explicit `scaleKey` built from stable identifiers (greek + method, or
 * 'iv' + measure) rather than relying on the display label: this sanitiser strips non-word
 * characters, so two labels differing only by a `Δ` or `·` would collapse to the same id.
 * Deriving ids from labels couples scale identity to display text, which is the actual hazard.
 */
export function scaleSuffix(label: string): string {
  return label.replace(/[^\w]/g, '');
}

const defaultMapper: TimeMapper = (ms) => msToChartTime(ms) as number;

type LinePoint =
  | { time: UTCTimestamp; value: number; color?: string }
  | { time: UTCTimestamp; value?: undefined; color?: string };

/**
 * De-duplicate by mapped time (keep last), filter closed-market points, and break overnight lines.
 *
 * The break is the per-point colour `markSessionBreaks` writes onto each session's last point. The
 * valueless point pushed at the boundary keeps the two sessions off one another's column, but it
 * does NOT break the line on its own — see `SESSION_BREAK_COLOR`.
 */
function toLine<T extends { ts: number }>(
  points: ReadonlyArray<T>,
  pick: (p: T) => number,
  mapTime: TimeMapper,
  exchange?: string,
): LinePoint[] {
  const byTime = new Map<number, number>();
  for (const p of points) {
    const t = mapTime(p.ts);
    if (t == null || !Number.isFinite(t) || !isMarketSessionChartTime(t, exchange)) continue;
    byTime.set(t, pick(p));
  }

  const out: LinePoint[] = [];
  let lastDay: string | null = null;
  let lastTime: number | null = null;
  for (const [time, value] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    const day = chartTimeDayKey(time);
    if (lastDay && day && day !== lastDay && lastTime != null)
      out.push({ time: (lastTime + 1) as UTCTimestamp });
    out.push({ time: time as UTCTimestamp, value });
    lastDay = day;
    lastTime = time;
  }
  return markSessionBreaks(out);
}

export interface GreekPane {
  /** Push the latest computed series + visibility settings into the pane. */
  setData(
    points: ReadonlyArray<SeriesPoint>,
    mode: SeriesMode,
    showCalls: boolean,
    showPuts: boolean,
    mapTime?: TimeMapper,
  ): void;
  setHeight(px: number): void;
  setBand(m: ScaleBand): void;
  destroy(): void;
}

/**
 * A horizontal slice of the host pane, as lightweight-charts `scaleMargins` — the fraction of the
 * pane's height left empty above and below this measure's lines.
 *
 * A host stacking several measures in ONE pane hands each of them a disjoint band, so they stop
 * sharing a price range: Vega near +70 and Theta near −75 on one scale each hold the axis open for
 * the other, and neither can ever expand. Bands are per-scale, so this is the whole mechanism —
 * there is no clipping and no data transform, each measure simply auto-scales inside its own slice.
 */
export interface ScaleBand {
  top: number;
  bottom: number;
}

export interface GreekPaneOpts {
  /** Render into an existing pane on overlay scales (Tracker) instead of a new sub-pane (Chart). */
  inline?: boolean;
  /** Target pane index when inline (default 0 — the price pane). */
  paneIndex?: number;
  /** Sub-pane height when not inline. */
  height?: number;
  /** CE / PE line colors — distinct per greek so Vega vs Theta are tellable apart. */
  ceColor?: string;
  peColor?: string;
  /**
   * Stable identity for this pane's overlay price scales, independent of the display label
   * (e.g. 'vega-mine', 'iv-atm'). Falls back to sanitising `label`, which is unsafe if two
   * labels differ only by characters the sanitiser strips.
   */
  scaleKey?: string;
  /**
   * Visible axis ('left' / 'right') to plot the totals against when inline, instead of the
   * private overlay scale.
   *
   * An overlay scale auto-scales on its own but is never drawn, and lightweight-charts hangs
   * every overlay series' axis label off whichever visible scale is the pane's default. On the
   * Tracker that is the right price scale — the *candles'* scale — so an inline greek's tag ends
   * up beside prices it has nothing to do with. That is tolerable when the greeks are guests on
   * someone else's price pane, and wrong on a pane the overlays own: there the totals deserve a
   * real axis whose ticks describe them, which is what passing 'left' gives them.
   *
   * The Δ lines stay on their private overlay scale either way — they are a different magnitude
   * from the totals by construction (see the header note), and co-plotting them would flatten
   * them to a straight line.
   */
  axisScaleId?: string;
  /**
   * Which exchange's session to keep points inside. Defaults to NSE (09:15–15:30);
   * MCX runs to 23:30, and filtering a commodity against NSE hours throws away two
   * thirds of its session.
   *
   * A resolver rather than a value because panes outlive the instrument — they are
   * created once and reused across symbol switches, so a captured string would go
   * stale the moment the user moves from NIFTY to crude.
   */
  exchange?: () => string | undefined;
}

/**
 * Create greek line series bound to `chart` for one (greek, method) combination.
 * `label` prefixes the series titles, e.g. "Vega·mine".
 *
 * Default mode adds a dedicated sub-pane below the price pane. In `inline` mode the
 * series are added to an existing pane (the NIFTY price pane) on independent overlay
 * price scales, so the greeks share the same vertical space as the candles/line
 * rather than living in a separate pane below.
 */
export function createGreekPane(
  chart: IChartApi,
  label: string,
  opts: GreekPaneOpts = {},
): GreekPane {
  const inline = !!opts.inline;
  const pane = inline ? null : chart.addPane();
  if (pane) pane.setHeight(opts.height ?? 120);
  const paneIndex = inline ? (opts.paneIndex ?? 0) : pane!.paneIndex();

  // Unique overlay-scale ids so multiple inline overlays (e.g. Vega + Theta, mine + industry)
  // never share a scale or collide with the price scale.
  const safe = opts.scaleKey ?? scaleSuffix(label);
  // undefined → pane's own right scale; `axisScaleId` → a visible axis the host has set aside.
  const totScale = inline ? (opts.axisScaleId ?? `gt-${safe}`) : undefined;
  const diffScale = inline ? `gd-${safe}` : DIFF_SCALE;

  const mk = (
    color: string,
    dashed: boolean,
    scaleId: string | undefined,
    title: string,
  ): ISeriesApi<'Line'> =>
    chart.addSeries(
      LineSeries,
      {
        color,
        lineWidth: dashed ? 1 : 2,
        lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: scaleId !== diffScale, // axis tag only for the totals scale
        crosshairMarkerVisible: true,
        // Stated rather than defaulted: the marker's colour otherwise falls back to the hovered
        // POINT's colour, and each session's last point carries SESSION_BREAK_COLOR.
        crosshairMarkerBackgroundColor: color,
        title: `${label} ${title}`,
        // Inline greeks share the price pane, so format their (often huge) values
        // compactly instead of dumping raw 10-digit numbers onto the axis tag.
        ...(inline
          ? { priceFormat: { type: 'custom' as const, minMove: 0.01, formatter: compactAxis } }
          : {}),
        ...(scaleId ? { priceScaleId: scaleId } : {}),
      },
      paneIndex,
    );

  const CE = opts.ceColor ?? CE_COLOR;
  const PE = opts.peColor ?? PE_COLOR;
  const ceTotal = mk(CE, false, totScale, 'CE');
  const peTotal = mk(PE, false, totScale, 'PE');
  const ceDiff = mk(CE, true, diffScale, 'CE Δ');
  const peDiff = mk(PE, true, diffScale, 'PE Δ');

  if (inline) {
    // Greeks share the price pane and span most of its height (overlapping the NIFTY
    // line is fine — distinct colors + the crosshair tooltip keep them readable).
    ceTotal.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
    ceDiff.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });
  } else {
    // Separate sub-pane: give the overlay diff scale its own margins vs the totals.
    ceDiff.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
  }

  const all = [ceTotal, peTotal, ceDiff, peDiff];

  return {
    setData(points, mode, showCalls, showPuts, mapTime = defaultMapper) {
      const showTotals = mode === 'totals' || mode === 'both';
      const showDiff = mode === 'diff' || mode === 'both';

      const apply = (s: ISeriesApi<'Line'>, visible: boolean, line: LinePoint[]) => {
        s.applyOptions({ visible });
        s.setData(visible ? line : []);
      };

      apply(
        ceTotal,
        showTotals && showCalls,
        toLine(points, (p) => p.ceTotal, mapTime, opts.exchange?.()),
      );
      apply(
        peTotal,
        showTotals && showPuts,
        toLine(points, (p) => p.peTotal, mapTime, opts.exchange?.()),
      );
      apply(
        ceDiff,
        showDiff && showCalls,
        toLine(points, (p) => p.ceDiff, mapTime, opts.exchange?.()),
      );
      apply(
        peDiff,
        showDiff && showPuts,
        toLine(points, (p) => p.peDiff, mapTime, opts.exchange?.()),
      );
    },
    setHeight(px) {
      pane?.setHeight(px);
    },
    setBand(m) {
      // Both scales, so a measure's Δ lines follow its totals into the band instead of wandering
      // across a slice they have nothing to do with. They stay SEPARATE scales — totals and diffs
      // are different magnitudes by construction (see the header note) — just co-located.
      ceTotal.priceScale().applyOptions({ scaleMargins: m });
      ceDiff.priceScale().applyOptions({ scaleMargins: m });
    },
    destroy() {
      for (const s of all) {
        try {
          chart.removeSeries(s);
        } catch {
          /* already gone */
        }
      }
      if (pane) {
        try {
          chart.removePane(pane.paneIndex());
        } catch {
          /* pane auto-removed */
        }
      }
    },
  };
}

// ─── Single-line pane for constant-delta IV measures ─────────────────────────────
//
// IV is one scalar per snapshot (not a CE/PE pair with totals and diffs), so it gets a
// one-line pane rather than being forced through GreekPane's four-series shape.

export interface IvPane {
  setData(points: ReadonlyArray<IvPoint>, mapTime?: TimeMapper): void;
  setHeight(px: number): void;
  setBand(m: ScaleBand): void;
  destroy(): void;
}

/** IV measures are vol points, so 2dp with no compaction — they never reach 1e3. */
function ivAxis(v: number): string {
  return v.toFixed(2);
}

export function createIvPane(chart: IChartApi, label: string, opts: GreekPaneOpts = {}): IvPane {
  const inline = !!opts.inline;
  const pane = inline ? null : chart.addPane();
  if (pane) pane.setHeight(opts.height ?? 120);
  const paneIndex = inline ? (opts.paneIndex ?? 0) : pane!.paneIndex();

  const scaleId = inline
    ? (opts.axisScaleId ?? `iv-${opts.scaleKey ?? scaleSuffix(label)}`)
    : undefined;

  const ivColor = opts.ceColor ?? '#38bdf8';
  const line = chart.addSeries(
    LineSeries,
    {
      color: ivColor,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      // See the Greek pane above: the marker would otherwise disappear on each session's
      // last point, which is the one carrying SESSION_BREAK_COLOR.
      crosshairMarkerBackgroundColor: ivColor,
      title: label,
      priceFormat: { type: 'custom' as const, minMove: 0.01, formatter: ivAxis },
      ...(scaleId ? { priceScaleId: scaleId } : {}),
    },
    paneIndex,
  );

  if (inline) line.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0.08 } });

  return {
    setData(points, mapTime = defaultMapper) {
      line.setData(toLine(points, (p) => p.value, mapTime, opts.exchange?.()));
    },
    setHeight(px) {
      pane?.setHeight(px);
    },
    setBand(m) {
      line.priceScale().applyOptions({ scaleMargins: m });
    },
    destroy() {
      try {
        chart.removeSeries(line);
      } catch {
        /* already gone */
      }
      if (pane) {
        try {
          chart.removePane(pane.paneIndex());
        } catch {
          /* pane auto-removed */
        }
      }
    },
  };
}
