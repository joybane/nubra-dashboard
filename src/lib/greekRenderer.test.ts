import { test, expect, describe } from 'vitest';
import type { AutoscaleInfo, IChartApi } from 'lightweight-charts';
import {
  createGreekPane,
  createIvPane,
  makeVScaleProvider,
  msToChartTime,
  scaleSuffix,
  type VScale,
} from './greekRenderer.ts';
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
  const seriesOpts: Record<string, unknown>[] = [];
  /** Every `setData` push, in order, tagged with the series' title — see the laziness tests. */
  const setDataCalls: Array<{ title: string; points: number }> = [];
  const scaleFor = (id: string) => {
    let s = scales.get(id);
    if (!s) scales.set(id, (s = { opts: {}, calls: 0 }));
    return s;
  };
  const chart = {
    addPane: () => ({ setHeight() {}, paneIndex: () => 1 }),
    addSeries: (_type: unknown, opts: { priceScaleId?: string; title?: string }) => {
      const id = opts.priceScaleId ?? 'right';
      seriesByScale.push(id);
      seriesOpts.push(opts as Record<string, unknown>);
      return {
        priceScale: () => ({
          applyOptions: (o: Record<string, unknown>) => {
            const s = scaleFor(id);
            Object.assign(s.opts, o);
            s.calls++;
          },
        }),
        applyOptions() {},
        setData(points: unknown[]) {
          setDataCalls.push({ title: opts.title ?? '', points: points.length });
        },
      };
    },
    removeSeries() {},
    removePane() {},
  };
  return { chart: chart as unknown as IChartApi, scales, seriesByScale, seriesOpts, setDataCalls };
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

/**
 * `setData` used to build all four lines and then discard the ones nobody could see. `toLine` maps,
 * sorts and re-colours every point in the series, so on the default 'diff' that was double the
 * per-draw work — three times over, once per measure — for lines that were never drawn.
 *
 * Counted through the payloads rather than by spying on `toLine`, which is module-private: a
 * skipped line shows up as an empty push, a built one as a populated push.
 */
describe('setData only builds the lines it is going to draw', () => {
  // 09:20 and 09:21 IST — inside the NSE session, or the session filter drops both points.
  const points = [
    { ts: Date.UTC(2026, 6, 30, 3, 50), ceTotal: 10, peTotal: 20, ceDiff: 1, peDiff: 2 },
    { ts: Date.UTC(2026, 6, 30, 3, 51), ceTotal: 11, peTotal: 21, ceDiff: 2, peDiff: 3 },
  ];

  test("'diff' leaves the totals empty and populates the Δ lines", () => {
    const { chart, setDataCalls } = fakeChart();
    const pane = createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });
    setDataCalls.length = 0;

    pane.setData(points, 'diff', true, true);

    expect(setDataCalls).toEqual([
      { title: 'Vega·mine CE', points: 0 },
      { title: 'Vega·mine PE', points: 0 },
      { title: 'Vega·mine CE Δ', points: 2 },
      { title: 'Vega·mine PE Δ', points: 2 },
    ]);
  });

  test('an unticked side is not built either', () => {
    const { chart, setDataCalls } = fakeChart();
    const pane = createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });
    setDataCalls.length = 0;

    pane.setData(points, 'both', true, false); // CE only
    const built = setDataCalls.filter((c) => c.points > 0).map((c) => c.title);
    expect(built).toEqual(['Vega·mine CE', 'Vega·mine CE Δ']);
  });

  test('a line that was already hidden is not handed another empty array', () => {
    const { chart, setDataCalls } = fakeChart();
    const pane = createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });

    pane.setData(points, 'diff', true, true); // first pass: all four written
    setDataCalls.length = 0;
    pane.setData(points, 'diff', true, true); // second: the totals are already empty and hidden

    expect(setDataCalls.map((c) => c.title)).toEqual(['Vega·mine CE Δ', 'Vega·mine PE Δ']);
  });

  test('a line coming back into view is rebuilt, not left empty', () => {
    const { chart, setDataCalls } = fakeChart();
    const pane = createGreekPane(chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });

    pane.setData(points, 'diff', true, true);
    setDataCalls.length = 0;
    pane.setData(points, 'both', true, true); // user switches SERIES back to Both

    expect(setDataCalls).toEqual([
      { title: 'Vega·mine CE', points: 2 },
      { title: 'Vega·mine PE', points: 2 },
      { title: 'Vega·mine CE Δ', points: 2 },
      { title: 'Vega·mine PE Δ', points: 2 },
    ]);
  });
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

// ─── Vertical zoom / pan ─────────────────────────────────────────────────────────

describe('makeVScaleProvider', () => {
  /** The library's own autoscale result: 20 wide, centred on 50. */
  const auto = (): AutoscaleInfo => ({ priceRange: { minValue: 40, maxValue: 60 } });
  const run = (v: VScale, original: () => AutoscaleInfo | null = auto) =>
    makeVScaleProvider(() => v)(original);

  test('1× with no pan is the identity — a host that never stretches pays nothing', () => {
    expect(run({ zoom: 1, pan: 0 })).toEqual({ priceRange: { minValue: 40, maxValue: 60 } });
  });

  test('zoom narrows the range about its midpoint, which is what stretches the line', () => {
    // Span 20 → 20/3, midpoint still 50. A narrower range over the same pixels = a taller line.
    expect(run({ zoom: 3, pan: 0 })).toEqual({
      priceRange: { minValue: 50 - 10 / 3, maxValue: 50 + 10 / 3 },
    });
    // Below 1 it compresses, the other half of the same gesture.
    expect(run({ zoom: 0.5, pan: 0 })).toEqual({ priceRange: { minValue: 30, maxValue: 70 } });
  });

  test('pan shifts by fractions of the auto HALF-range, leaving the span alone', () => {
    // half = 10, so pan 0.5 moves the window 5 — and because every scale in the pane maps its own
    // half-range onto the same pixels, that is the same pixel shift for a line at 60 and one at -300.
    expect(run({ zoom: 1, pan: 0.5 })).toEqual({ priceRange: { minValue: 35, maxValue: 55 } });
    expect(run({ zoom: 1, pan: -0.5 })).toEqual({ priceRange: { minValue: 45, maxValue: 65 } });
  });

  test('pan is applied before the span, so zooming does not move where you were looking', () => {
    // centre 50 - 0.5*10 = 45, then half 10/2 = 5 either side.
    expect(run({ zoom: 2, pan: 0.5 })).toEqual({ priceRange: { minValue: 40, maxValue: 50 } });
  });

  test('zoom is clamped — a runaway drag cannot collapse the range to nothing', () => {
    const tiny = run({ zoom: 1e6, pan: 0 }) as AutoscaleInfo;
    const span = tiny.priceRange!.maxValue - tiny.priceRange!.minValue;
    expect(span).toBeCloseTo(20 / 50, 10); // V_ZOOM_MAX
    const huge = run({ zoom: 1e-6, pan: 0 }) as AutoscaleInfo;
    expect(huge.priceRange!.maxValue - huge.priceRange!.minValue).toBeCloseTo(20 / 0.2, 10);
  });

  test('anything it cannot meaningfully scale is passed through untouched', () => {
    expect(run({ zoom: 3, pan: 1 }, () => null)).toBeNull();
    const noRange = { priceRange: null };
    expect(run({ zoom: 3, pan: 1 }, () => noRange)).toBe(noRange);
    // A flat line has no span: dividing zero by the zoom is still zero, and inventing a span around
    // it would draw an axis out of nothing.
    const flat = { priceRange: { minValue: 7, maxValue: 7 } };
    expect(run({ zoom: 3, pan: 1 }, () => flat)).toBe(flat);
    const bad = { priceRange: { minValue: NaN, maxValue: 60 } };
    expect(run({ zoom: 3, pan: 1 }, () => bad)).toBe(bad);
  });

  test('a non-finite factor is treated as no factor rather than destroying the range', () => {
    expect(run({ zoom: NaN, pan: NaN })).toEqual({ priceRange: { minValue: 40, maxValue: 60 } });
  });

  test('margins survive — they are the library’s padding for price lines and markers', () => {
    const withMargins = (): AutoscaleInfo => ({
      priceRange: { minValue: 40, maxValue: 60 },
      margins: { above: 12, below: 4 },
    });
    expect((run({ zoom: 2, pan: 0 }, withMargins) as AutoscaleInfo).margins).toEqual({
      above: 12,
      below: 4,
    });
  });

  test('reads the factor at call time, so one drag moves lines built long before it', () => {
    const live: VScale = { zoom: 1, pan: 0 };
    const provider = makeVScaleProvider(() => live);
    expect(provider(auto)).toEqual({ priceRange: { minValue: 40, maxValue: 60 } });
    live.zoom = 2;
    expect(provider(auto)).toEqual({ priceRange: { minValue: 45, maxValue: 55 } });
  });
});

test('no vScale means no autoscaleInfoProvider at all — the Tracker and Chart stay on the library path', () => {
  const bare = fakeChart();
  createGreekPane(bare.chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine' });
  createIvPane(bare.chart, 'IV·ATM', { inline: true, scaleKey: 'atm' });
  expect(bare.seriesOpts).toHaveLength(5); // CE/PE totals, CE/PE Δ, IV
  expect(bare.seriesOpts.every((o) => o.autoscaleInfoProvider === undefined)).toBe(true);

  // With one, every series in the pane gets it — a stretch that reached only some of the lines is
  // the bug this whole mechanism exists to fix.
  const wired = fakeChart();
  const vScale = () => ({ zoom: 1, pan: 0 });
  createGreekPane(wired.chart, 'Vega·mine', { inline: true, scaleKey: 'vega-mine', vScale });
  createIvPane(wired.chart, 'IV·ATM', { inline: true, scaleKey: 'atm', vScale });
  expect(wired.seriesOpts).toHaveLength(5);
  expect(wired.seriesOpts.every((o) => typeof o.autoscaleInfoProvider === 'function')).toBe(true);
});
