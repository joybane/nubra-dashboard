import { describe, expect, it } from 'vitest';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { escapeHtml, fmtCrosshairTime, greekRows, greekRowsAllPanes } from './greekTooltip';

// Enough of a chart to exercise pane walking. The real API is far larger, but these functions
// only ever ask a chart for its panes and each pane for its series.
function fakeSeries(opts: { color?: string; title?: string; visible?: boolean }, value?: number) {
  return {
    options: () => opts,
    dataByIndex: () => (value == null ? null : { value }),
  } as unknown as ISeriesApi<'Line'>;
}

function fakeChart(panes: ISeriesApi<'Line'>[][]) {
  return {
    panes: () => panes.map((series) => ({ getSeries: () => series })),
  } as unknown as IChartApi;
}

describe('fmtCrosshairTime', () => {
  it('renders an intraday timestamp as IST wall clock', () => {
    // Chart time is IST-baked seconds, so 13:05 IST is stored as 13:05 UTC.
    const t = Date.UTC(2026, 7, 14, 13, 5) / 1000;
    expect(fmtCrosshairTime(t)).toBe('14 Aug 13:05');
  });

  it('renders a business day without inventing a time of day', () => {
    // 1d / 1w / 1mt bars carry {year,month,day}; treating one as a number produced "NaN NaN".
    expect(fmtCrosshairTime({ year: 2026, month: 8, day: 14 })).toBe('14 Aug 2026');
  });
});

describe('greekRowsAllPanes', () => {
  it('gathers rows from every sub-pane, skipping the price pane', () => {
    const chart = fakeChart([
      [fakeSeries({ color: '#fff', title: 'price' }, 24000)], // pane 0 — candles, not a greek
      [fakeSeries({ color: '#22c55e', title: 'Vega·mine CE' }, 69.7)],
      [fakeSeries({ color: '#a78bfa', title: 'Theta·mine CE' }, -77.62)],
    ]);

    expect(greekRowsAllPanes(chart, null, null, 5)).toEqual([
      { color: '#22c55e', label: 'Vega·mine CE', value: 69.7 },
      { color: '#a78bfa', label: 'Theta·mine CE', value: -77.62 },
    ]);
  });

  it('honours a series that is switched off, and drops one with no reading', () => {
    const chart = fakeChart([
      [],
      [
        fakeSeries({ color: '#22c55e', title: 'shown' }, 1),
        fakeSeries({ color: '#ef4444', title: 'hidden', visible: false }, 2),
        fakeSeries({ color: '#eab308', title: 'no data' }, undefined),
      ],
    ]);

    expect(greekRowsAllPanes(chart, null, null, 5).map((r) => r.label)).toEqual(['shown']);
  });

  it('is empty when only the price pane exists', () => {
    expect(greekRowsAllPanes(fakeChart([[fakeSeries({}, 1)]]), null, null, 5)).toEqual([]);
  });

  it('survives a disposed chart rather than throwing into the crosshair handler', () => {
    const dead = {
      panes: () => {
        throw new Error('Object is disposed');
      },
    } as unknown as IChartApi;

    expect(greekRowsAllPanes(dead, null, null, 5)).toEqual([]);
  });

  it('reads the inline case identically — the Tracker path is unchanged', () => {
    const chart = fakeChart([[fakeSeries({ color: '#22c55e', title: 'Vega·mine CE' }, 42)]]);
    expect(greekRows(chart, null, null, 5, 0)).toEqual([
      { color: '#22c55e', label: 'Vega·mine CE', value: 42 },
    ]);
  });
});

describe('escapeHtml', () => {
  it('neutralises markup in text bound for innerHTML', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeHtml('A & B "C"')).toBe('A &amp; B &quot;C&quot;');
  });

  it('leaves ordinary instrument and series names untouched', () => {
    expect(escapeHtml('NIFTY 24000 CE')).toBe('NIFTY 24000 CE');
    expect(escapeHtml('Vega·mine CE Δ')).toBe('Vega·mine CE Δ');
  });
});
