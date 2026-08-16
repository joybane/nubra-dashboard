import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { IST_OFFSET, SESSION_BREAK_COLOR, barsToSessionLine, markSessionBreaks } from './utils';

/** Chart time is IST-baked seconds — the same units every chart in the app plots against. */
const chartTime = (iso: string): number => Date.parse(`${iso}+05:30`) / 1000 + IST_OFFSET;
const at = (iso: string, value: number) => ({ time: chartTime(iso), value });

describe('markSessionBreaks', () => {
  it('paints the last point of a session, and only that point', () => {
    const out = markSessionBreaks([
      at('2026-08-13T15:28:00', 1),
      at('2026-08-13T15:29:00', 2),
      at('2026-08-14T09:15:00', 3),
      at('2026-08-14T09:16:00', 4),
    ]);

    expect(out.map((p) => p.color)).toEqual([undefined, SESSION_BREAK_COLOR, undefined, undefined]);
  });

  it('leaves a single-session series completely untouched', () => {
    const points = [at('2026-08-14T09:15:00', 1), at('2026-08-14T15:29:00', 2)];
    expect(markSessionBreaks(points)).toEqual(points);
  });

  it('never paints the final point — it is what the axis tag takes its colour from', () => {
    const out = markSessionBreaks([at('2026-08-13T15:29:00', 1), at('2026-08-14T09:15:00', 2)]);
    expect(out[out.length - 1].color).toBeUndefined();
  });

  it('breaks every boundary in a multi-day window', () => {
    const out = markSessionBreaks([
      at('2026-08-12T15:29:00', 1),
      at('2026-08-13T09:15:00', 2),
      at('2026-08-13T15:29:00', 3),
      at('2026-08-14T09:15:00', 4),
    ]);
    expect(out.filter((p) => p.color === SESSION_BREAK_COLOR)).toHaveLength(2);
    expect(out.map((p) => p.color)).toEqual([
      SESSION_BREAK_COLOR,
      undefined,
      SESSION_BREAK_COLOR,
      undefined,
    ]);
  });

  it('steps over whitespace when locating a session edge', () => {
    // The boundary whitespace `barsToSessionLine` inserts is not part of the series as far as
    // lightweight-charts is concerned, so the break has to land on the last VALUED point.
    const out = markSessionBreaks([
      at('2026-08-13T15:29:00', 1),
      { time: chartTime('2026-08-13T15:29:01') },
      at('2026-08-14T09:15:00', 2),
    ]);
    expect(out[0].color).toBe(SESSION_BREAK_COLOR);
    expect(out[1].color).toBeUndefined();
  });

  it('leaves a daily series alone — a 1d bar IS a session, so nothing separates two of them', () => {
    const daily = [
      { time: { year: 2026, month: 8, day: 12 }, value: 1 },
      { time: { year: 2026, month: 8, day: 13 }, value: 2 },
      { time: { year: 2026, month: 8, day: 14 }, value: 3 },
    ];
    expect(markSessionBreaks(daily).every((p) => p.color === undefined)).toBe(true);
  });

  it('does not mutate the array it is given', () => {
    const points = [at('2026-08-13T15:29:00', 1), at('2026-08-14T09:15:00', 2)];
    const snapshot = JSON.parse(JSON.stringify(points));
    markSessionBreaks(points);
    expect(points).toEqual(snapshot);
  });
});

describe('barsToSessionLine', () => {
  const bar = (iso: string, close: number) => ({ time: chartTime(iso), close });

  it('drops out-of-session bars, reserves a boundary column, and breaks the line', () => {
    const out = barsToSessionLine([
      bar('2026-08-13T09:14:00', 100), // pre-open — dropped
      bar('2026-08-13T15:29:00', 101),
      bar('2026-08-13T15:45:00', 102), // post-close — dropped
      bar('2026-08-14T09:15:00', 103),
    ]);

    expect(out.map((p) => p.value)).toEqual([101, undefined, 103]);
    expect(out[0].color).toBe(SESSION_BREAK_COLOR);
    expect(out[2].color).toBeUndefined();
  });

  it('keeps the MCX evening session and still breaks at midnight', () => {
    const out = barsToSessionLine(
      [bar('2026-08-13T22:00:00', 100), bar('2026-08-14T10:00:00', 101)],
      'MCX',
    );
    expect(out.map((p) => p.value)).toEqual([100, undefined, 101]);
    expect(out[0].color).toBe(SESSION_BREAK_COLOR);
  });
});

/**
 * The reason the break is a colour and not the whitespace point that used to sit alone at each
 * boundary: lightweight-charts throws whitespace away when it stores a series' rows, so the
 * renderer never sees the hole and strokes one continuous path across the night.
 *
 * Asserted against the installed library's own source rather than trusted from a comment, so an
 * upgrade that starts honouring whitespace shows up here instead of silently leaving two
 * mechanisms in place.
 */
describe('the lightweight-charts behaviour this works around', () => {
  // Resolved off the package manifest: `dist/*` is not an exported subpath, so it cannot be
  // require.resolve'd directly.
  const require = createRequire(import.meta.url);
  const pkgRoot = path.dirname(require.resolve('lightweight-charts/package.json'));
  const src = readFileSync(
    path.join(pkgRoot, 'dist', 'lightweight-charts.development.mjs'),
    'utf8',
  );

  it('drops whitespace rows from a series, so whitespace alone cannot break a line', () => {
    expect(src).toContain('seriesRows.filter(isSeriesPlotRow)');
    expect(src).toContain('function isSeriesPlotRow(row)');
  });

  it('resolves a line point’s colour from the point, which is what lets us break it', () => {
    expect(src).toContain('_internal_lineColor: currentBar._internal_color ?? lineStyle.color');
  });
});
