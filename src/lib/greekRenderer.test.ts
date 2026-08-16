import { test, expect } from 'vitest';
import type { IChartApi } from 'lightweight-charts';
import { createGreekPane, createIvPane, msToChartTime, scaleSuffix } from './greekRenderer.ts';
import { IST_OFFSET } from './utils.ts';

/** Full-height margins — the arrangement every inline overlay is created with. */
const FULL_HEIGHT = { top: 0.1, bottom: 0.08 };

/**
 * A chart stub that records what each price scale was configured with.
 *
 * `priceScale()` hands back a fresh facade per call, exactly as lightweight-charts does, but every
 * facade for the same id writes into one recorded scale — which is the property under test: CE and
 * PE are separate series that must land on the SAME scale, and totals and Δ on different ones.
 */
function fakeChart() {
  const scales = new Map<string, { opts: Record<string, unknown>; calls: number }>();
  const seriesByScale: string[] = [];
  const scaleFor = (id: string) => {
    let s = scales.get(id);
    if (!s) scales.set(id, (s = { opts: {}, calls: 0 }));
    return s;
  };
  const chart = {
    addPane: () => ({ setHeight() {}, paneIndex: () => 1 }),
    addSeries: (_type: unknown, opts: { priceScaleId?: string }) => {
      const id = opts.priceScaleId ?? 'right';
      seriesByScale.push(id);
      return {
        priceScale: () => ({
          applyOptions: (o: Record<string, unknown>) => {
            const s = scaleFor(id);
            Object.assign(s.opts, o);
            s.calls++;
          },
        }),
        applyOptions() {},
        setData() {},
      };
    },
    removeSeries() {},
    removePane() {},
  };
  return { chart: chart as unknown as IChartApi, scales, seriesByScale };
}

/**
 * The regression guard for the layout this pane settled on.
 *
 * An earlier version sliced the host pane into disjoint horizontal bands, one per measure, to stop
 * Vega (~+40) and Theta (~−300) crushing each other. Separate scales already do that, and the bands
 * cost more than they bought: each measure was pinned to a fixed third of the pane forever and
 * could never use the rest of it. If margins ever stop being identical across measures, that is
 * banding creeping back in — and the symptom is Vega stuck at the top and Theta stuck at the
 * bottom, which is precisely what this test exists to catch.
 */
test('inline overlays all span the full pane height — no measure gets a slice of its own', () => {
  const { chart, scales } = fakeChart();
  createGreekPane(chart, 'Vega·mine', {
    inline: true,
    scaleKey: 'vega-mine',
    axisScaleId: 'left', // the first enabled measure owns the visible axis
  });
  createGreekPane(chart, 'Theta·mine', { inline: true, scaleKey: 'theta-mine' });

  for (const id of ['left', 'gd-vega-mine', 'gt-theta-mine', 'gd-theta-mine'])
    expect(scales.get(id)?.opts.scaleMargins, `${id} margins`).toEqual(FULL_HEIGHT);
});

/**
 * `autoScale` is what re-fits a scale to the VISIBLE window on every zoom, which is the whole
 * mechanism that lets several measures share one pane without fixed bands. It happens to be the
 * library default, so stating it is easy to "tidy away" — this fails if anyone does.
 */
test('inline overlays are created auto-scaling', () => {
  const { chart, scales } = fakeChart();
  createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });
  createIvPane(chart, 'IV·ATM IV', { inline: true, scaleKey: 'atm' });

  for (const id of ['gt-vega-mine', 'gd-vega-mine', 'iv-atm'])
    expect(scales.get(id)?.opts.autoScale, `${id} autoScale`).toBe(true);
});

/**
 * Dragging a price axis latches `autoScale: false` for good, and the frozen scale then walks its
 * lines off the pane on the next zoom. The visible axes can be recovered through
 * `chart.priceScale('left'|'right')`, but these overlay ids are built inside this module from
 * `scaleKey` — a host cannot name them, so without `resetScales` those lines are unrecoverable.
 */
test('resetScales re-enables autoscale on every scale a pane owns', () => {
  const { chart, scales } = fakeChart();
  const greek = createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });
  const iv = createIvPane(chart, 'IV·ATM IV', { inline: true, scaleKey: 'atm' });

  // Stand in for the user dragging each axis by hand.
  for (const s of scales.values()) s.opts.autoScale = false;

  greek.resetScales();
  iv.resetScales();

  for (const id of ['gt-vega-mine', 'gd-vega-mine', 'iv-atm'])
    expect(scales.get(id)?.opts.autoScale, `${id} recovered`).toBe(true);
});

/**
 * CE and PE are commensurable (both Vega, or both Theta) and belong on one scale so their relative
 * size stays readable; totals and Δ are orders of magnitude apart and must not. Two `resetScales`
 * calls therefore cover all four lines — this pins that assumption down.
 */
test('CE and PE share a scale; totals and Δ do not', () => {
  const { chart, seriesByScale } = fakeChart();
  createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });

  // Creation order in `createGreekPane`: ceTotal, peTotal, ceDiff, peDiff.
  expect(seriesByScale).toEqual(['gt-vega-mine', 'gt-vega-mine', 'gd-vega-mine', 'gd-vega-mine']);
});

// The scaleKeys useGreekOverlay actually passes: `${greek}-${method}` for the Greek panes and
// the bare IvMeasure for the IV pane. Display labels are deliberately NOT used for identity.
const GREEK_KEYS = ['vega-mine', 'vega-industry', 'theta-mine', 'theta-industry'];
const IV_KEYS = ['atm', 'rr25', 'fly25'];

/**
 * Every inline overlay needs its own price scale. If two ids collide the series share an axis
 * and one silently rescales the other — a Vega line squashed flat by Theta's magnitude, with no
 * error anywhere.
 */
test('overlay scale ids: every combination the app can create is distinct', () => {
  const ids: string[] = [];
  for (const key of GREEK_KEYS) {
    ids.push(`gt-${key}`); // totals scale
    ids.push(`gd-${key}`); // difference scale
  }
  for (const key of IV_KEYS) ids.push(`iv-${key}`);

  expect(new Set(ids).size).toBe(ids.length);
  // Must not collide with lightweight-charts' built-in scales either.
  for (const id of ids) expect(['right', 'left', '']).not.toContain(id);
});

/**
 * Why identity is decoupled from the display label: the sanitiser strips non-word characters, so
 * labels differing only by a `Δ` or `·` fuse into one id. Display text is free to change without
 * silently re-pointing a series at another series' scale.
 */
test('scaleSuffix: label-derived ids are lossy, which is why scaleKey exists', () => {
  expect(scaleSuffix('Vega·mine')).toBe('Vegamine');
  expect(scaleSuffix('IV·25Δ RR')).toBe(scaleSuffix('IV·25 RR')); // collision if used for identity
  expect(scaleSuffix('IV·ATM IV')).toBe('IVATMIV');
});

test('msToChartTime: bakes the IST offset into the chart timestamp', () => {
  const ms = Date.UTC(2026, 6, 30, 3, 50); // 09:20 IST
  expect(msToChartTime(ms)).toBe(Math.floor(ms / 1000) + IST_OFFSET);
  // Reading UTC parts off the result yields the IST wall clock.
  const d = new Date((msToChartTime(ms) as number) * 1000);
  expect(d.getUTCHours()).toBe(9);
  expect(d.getUTCMinutes()).toBe(20);
});
