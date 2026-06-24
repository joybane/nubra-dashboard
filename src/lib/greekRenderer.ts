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

import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { IST_OFFSET } from './utils.ts';
import type { SeriesPoint } from './greekAggregator.ts';

export type SeriesMode = 'totals' | 'diff' | 'both';

const CE_COLOR = '#22c55e';
const PE_COLOR = '#ef4444';
const DIFF_SCALE = 'greekDiff';

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

const defaultMapper: TimeMapper = (ms) => msToChartTime(ms) as number;

type LinePoint = { time: UTCTimestamp; value: number };

/** De-duplicate by mapped time (keep last) and ensure ascending order for setData(). */
function toLine(points: ReadonlyArray<SeriesPoint>, pick: (p: SeriesPoint) => number, mapTime: TimeMapper): LinePoint[] {
  const byTime = new Map<number, number>();
  for (const p of points) {
    const t = mapTime(p.ts);
    if (t == null || !Number.isFinite(t)) continue;
    byTime.set(t, pick(p));
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export interface GreekPane {
  /** Push the latest computed series + visibility settings into the pane. */
  setData(points: ReadonlyArray<SeriesPoint>, mode: SeriesMode, showCalls: boolean, showPuts: boolean, mapTime?: TimeMapper): void;
  setHeight(px: number): void;
  destroy(): void;
}

export interface GreekPaneOpts {
  /** Render into an existing pane on overlay scales (Tracker) instead of a new sub-pane (Chart). */
  inline?:    boolean;
  /** Target pane index when inline (default 0 — the price pane). */
  paneIndex?: number;
  /** Sub-pane height when not inline. */
  height?:    number;
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
export function createGreekPane(chart: IChartApi, label: string, opts: GreekPaneOpts = {}): GreekPane {
  const inline = !!opts.inline;
  const pane = inline ? null : chart.addPane();
  if (pane) pane.setHeight(opts.height ?? 120);
  const paneIndex = inline ? (opts.paneIndex ?? 0) : pane!.paneIndex();

  // Unique overlay-scale ids per label so multiple inline overlays (e.g. Vega + Theta,
  // mine + industry) never share a scale or collide with the price scale.
  const safe = label.replace(/[^\w]/g, '');
  const totScale  = inline ? `gt-${safe}` : undefined;       // undefined → pane's own right scale
  const diffScale = inline ? `gd-${safe}` : DIFF_SCALE;

  const mk = (color: string, dashed: boolean, scaleId: string | undefined, title: string): ISeriesApi<'Line'> =>
    chart.addSeries(LineSeries, {
      color,
      lineWidth: dashed ? 1 : 2,
      lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: scaleId !== diffScale,   // axis tag only for the totals scale
      crosshairMarkerVisible: true,
      title: `${label} ${title}`,
      ...(scaleId ? { priceScaleId: scaleId } : {}),
    }, paneIndex);

  const ceTotal = mk(CE_COLOR, false, totScale, 'CE');
  const peTotal = mk(PE_COLOR, false, totScale, 'PE');
  const ceDiff  = mk(CE_COLOR, true,  diffScale, 'CE Δ');
  const peDiff  = mk(PE_COLOR, true,  diffScale, 'PE Δ');

  if (inline) {
    // Keep both the greek totals and difference lines in the lower band of the price
    // pane so they sit under/alongside the NIFTY line instead of overrunning it.
    ceTotal.priceScale().applyOptions({ scaleMargins: { top: 0.6, bottom: 0.02 } });
    ceDiff.priceScale().applyOptions({ scaleMargins:  { top: 0.6, bottom: 0.02 } });
  } else {
    // Separate sub-pane: give the overlay diff scale its own margins vs the totals.
    ceDiff.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
  }

  const all = [ceTotal, peTotal, ceDiff, peDiff];

  return {
    setData(points, mode, showCalls, showPuts, mapTime = defaultMapper) {
      const showTotals = mode === 'totals' || mode === 'both';
      const showDiff   = mode === 'diff'   || mode === 'both';

      const apply = (s: ISeriesApi<'Line'>, visible: boolean, line: LinePoint[]) => {
        s.applyOptions({ visible });
        s.setData(visible ? line : []);
      };

      apply(ceTotal, showTotals && showCalls, toLine(points, p => p.ceTotal, mapTime));
      apply(peTotal, showTotals && showPuts,  toLine(points, p => p.peTotal, mapTime));
      apply(ceDiff,  showDiff   && showCalls, toLine(points, p => p.ceDiff, mapTime));
      apply(peDiff,  showDiff   && showPuts,  toLine(points, p => p.peDiff, mapTime));
    },
    setHeight(px) { pane?.setHeight(px); },
    destroy() {
      for (const s of all) { try { chart.removeSeries(s); } catch { /* already gone */ } }
      if (pane) { try { chart.removePane(pane.paneIndex()); } catch { /* pane auto-removed */ } }
    },
  };
}
