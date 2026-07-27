import type { IChartApi } from 'lightweight-charts';

// Using a removed lightweight-charts chart does not fail where you call it.
// `chart.remove()` disposes each pane's canvas binding, but the chart model still
// holds the widget's bound invalidate handler — so any later mutation
// (`setData`, `update`, `fitContent`, `setVisibleLogicalRange`, `resize`, …)
// quietly schedules a repaint via `requestAnimationFrame`. The *next frame* then
// paints the disposed canvases and throws `Object is disposed` from inside
// lightweight-charts, with no application frame anywhere on the stack and no
// try/catch at the call site able to catch it.
//
// That makes every deferred or awaited chart access a hazard: a `.then()` that
// outlives an unmount, or an rAF scheduled one frame before an effect re-runs.
// This module makes "is this chart still usable?" answerable so those paths can
// check instead of guessing.
const disposedCharts = new WeakSet<IChartApi>();

/**
 * Remove a chart and record that it is gone. Use everywhere instead of calling
 * `chart.remove()` directly, otherwise `isChartLive` cannot tell the difference.
 * Safe to call twice.
 */
export function removeChart(chart: IChartApi | null | undefined): void {
  if (!chart || disposedCharts.has(chart)) return;
  disposedCharts.add(chart);
  try {
    chart.remove();
  } catch { /* already torn down by lightweight-charts itself */ }
}

/** True while `chart` exists and has not been through `removeChart`. */
export function isChartLive(chart: IChartApi | null | undefined): chart is IChartApi {
  return !!chart && !disposedCharts.has(chart);
}

/**
 * Run `fn` on the next animation frame, but only if the chart is still alive by
 * the time the frame arrives. Returns a canceller for the effect cleanup.
 *
 * Both halves matter: the canceller covers the chart's own effect re-running,
 * and the liveness check covers a *different* effect tearing the chart down in
 * between — which no canceller in this effect could reach.
 */
export function chartFrame(chart: IChartApi, fn: (chart: IChartApi) => void): () => void {
  const id = requestAnimationFrame(() => {
    if (isChartLive(chart)) fn(chart);
  });
  return () => cancelAnimationFrame(id);
}
