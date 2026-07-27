import { test, expect, vi, afterEach } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { removeChart, isChartLive, chartFrame } from './chartLifecycle.ts';

/** Minimal stand-in — these helpers only ever call `remove()`. */
function fakeChart(): IChartApi & { removeCalls: number } {
  const chart = {
    removeCalls: 0,
    remove() { chart.removeCalls++; },
  };
  return chart as unknown as IChartApi & { removeCalls: number };
}

/** Drive requestAnimationFrame by hand so a "frame" is an explicit step. */
function stubRaf() {
  const pending = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    pending.set(next, cb);
    return next++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { pending.delete(id); });
  return () => {
    const due = [...pending.values()];
    pending.clear();
    for (const cb of due) cb(0);
  };
}

afterEach(() => vi.unstubAllGlobals());

// ─── §1  Liveness bookkeeping ────────────────────────────────────────────────────
test('a chart is live until removeChart, and removal is idempotent', () => {
  const chart = fakeChart();
  expect(isChartLive(chart)).toBe(true);

  removeChart(chart);
  expect(isChartLive(chart)).toBe(false);
  expect(chart.removeCalls).toBe(1);

  removeChart(chart);                 // e.g. an effect cleanup racing an unmount
  expect(chart.removeCalls).toBe(1);
});

test('null and undefined are never live and never throw', () => {
  expect(isChartLive(null)).toBe(false);
  expect(isChartLive(undefined)).toBe(false);
  expect(() => removeChart(null)).not.toThrow();
});

test('removeChart swallows a throwing remove but still marks the chart dead', () => {
  const chart = { remove() { throw new Error('already disposed'); } } as unknown as IChartApi;
  expect(() => removeChart(chart)).not.toThrow();
  expect(isChartLive(chart)).toBe(false);
});

// ─── §2  Deferred work ───────────────────────────────────────────────────────────
test('chartFrame runs the callback on the next frame while the chart is alive', () => {
  const flush = stubRaf();
  const chart = fakeChart();
  const fn = vi.fn();

  chartFrame(chart, fn);
  expect(fn).not.toHaveBeenCalled();   // deferred, not immediate
  flush();
  expect(fn).toHaveBeenCalledWith(chart);
});

// The reported crash: an rAF scheduled by one effect, the chart torn down by
// another before the frame lands. Painting it throws deep inside the library.
test('chartFrame skips the callback when the chart died before the frame', () => {
  const flush = stubRaf();
  const chart = fakeChart();
  const fn = vi.fn();

  chartFrame(chart, fn);
  removeChart(chart);
  flush();
  expect(fn).not.toHaveBeenCalled();
});

test('the returned canceller stops the callback from ever running', () => {
  const flush = stubRaf();
  const chart = fakeChart();
  const fn = vi.fn();

  chartFrame(chart, fn)();
  flush();
  expect(fn).not.toHaveBeenCalled();
});

test('one chart dying does not cancel a frame queued for another', () => {
  const flush = stubRaf();
  const dead = fakeChart();
  const live = fakeChart();
  const deadFn = vi.fn();
  const liveFn = vi.fn();

  chartFrame(dead, deadFn);
  chartFrame(live, liveFn);
  removeChart(dead);
  flush();

  expect(deadFn).not.toHaveBeenCalled();
  expect(liveFn).toHaveBeenCalledWith(live);
});
