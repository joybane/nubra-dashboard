import { test, expect } from 'vitest';
import { msToChartTime, scaleSuffix } from './greekRenderer.ts';
import { IST_OFFSET } from './utils.ts';

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
