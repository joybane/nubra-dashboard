import { describe, expect, it } from 'vitest';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import {
  diffGreekRows,
  escapeHtml,
  fmtCrosshairTime,
  greekRows,
  greekRowsAllPanes,
  placeTooltip,
  type GreekRow,
} from './greekTooltip';

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

describe('diffGreekRows', () => {
  const row = (label: string, value: number): GreekRow => ({ color: '#fff', label, value });

  it('subtracts the earlier reading from the later one', () => {
    const out = diffGreekRows(
      [row('Vega·mine CE', 40), row('Theta·mine CE', -300)],
      [row('Vega·mine CE', 52.5), row('Theta·mine CE', -260)],
    );
    expect(out).toEqual([
      { label: 'Vega·mine CE', value: 12.5 },
      { label: 'Theta·mine CE', value: 40 },
    ]);
  });

  it('pairs by series title, not by position', () => {
    // Vega switched off between the two pins, so the later reading is one line shorter and the
    // lists no longer line up. Pairing positionally here would subtract Vega from Theta.
    const out = diffGreekRows(
      [row('Vega·mine CE', 40), row('Theta·mine CE', -300)],
      [row('Theta·mine CE', -260)],
    );
    expect(out).toEqual([{ label: 'Theta·mine CE', value: 40 }]);
  });

  it('drops a line that only one of the two readings has', () => {
    // Theta switched ON between the pins: there is no earlier value to difference against, and
    // reporting its absolute reading as a Δ would be a lie.
    const out = diffGreekRows([row('Vega·mine CE', 40)], [row('Vega·mine CE', 41), row('T', -260)]);
    expect(out).toEqual([{ label: 'Vega·mine CE', value: 1 }]);
  });

  it('keeps a genuine zero rather than treating it as missing', () => {
    expect(diffGreekRows([row('IV·atm', 0)], [row('IV·atm', 0)])).toEqual([
      { label: 'IV·atm', value: 0 },
    ]);
  });

  it('skips non-finite readings on either side', () => {
    expect(diffGreekRows([row('a', NaN)], [row('a', 1)])).toEqual([]);
    expect(diffGreekRows([row('a', 1)], [row('a', Infinity)])).toEqual([]);
  });
});

describe('placeTooltip', () => {
  // offsetWidth/offsetHeight are 0 under jsdom's non-layout DOM, so the card is faked outright.
  const card = (w: number, h: number) => {
    const style: Record<string, string> = {};
    return { offsetWidth: w, offsetHeight: h, style } as unknown as HTMLElement & {
      style: Record<string, string>;
    };
  };
  const pane = (w: number, h: number) => ({ clientWidth: w, clientHeight: h }) as HTMLElement;

  it('flips at the pane midpoint when asked, matching the sibling panes', () => {
    // The card used to sit to the right of the crosshair until it would have overflowed, while
    // every other pane's card had already swung left — the whole point of the flag.
    const tip = card(220, 120);
    placeTooltip(pane(1900, 240), tip, 1300, 8, 16, true);
    expect(tip.style.left).toBe(`${1300 - 220 - 16}px`);
  });

  it('stays right of the crosshair before the midpoint', () => {
    const tip = card(220, 120);
    placeTooltip(pane(1900, 240), tip, 600, 8, 16, true);
    expect(tip.style.left).toBe(`${600 + 16}px`);
  });

  it('without the flag, only an overflow moves it — the Tracker/Chart behaviour', () => {
    const right = card(220, 120);
    placeTooltip(pane(1900, 240), right, 1300, 8);
    expect(right.style.left).toBe(`${1300 + 16}px`);

    const overflow = card(220, 120);
    placeTooltip(pane(1900, 240), overflow, 1800, 8);
    expect(overflow.style.left).toBe(`${1800 - 220 - 16}px`);
  });

  it('keeps a flipped card inside the pane rather than off its left edge', () => {
    const tip = card(600, 120);
    placeTooltip(pane(700, 240), tip, 400, 8, 16, true);
    expect(tip.style.left).toBe('4px');
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
