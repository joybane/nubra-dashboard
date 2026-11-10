import { describe, expect, test } from 'vitest';
import { emptyGrid, type DaySeries, type Grid } from '../analysis/daySeries.ts';
import { legGreeksAt } from '../analysis/greeks.ts';
import { CHAIN_STEPS, buildChain } from './chain.ts';
import type { OhlcSeries, OhlcSource } from './trade.ts';
import type { WideDay } from './wideSource.ts';

const INDEX = 60;
const at = (v: number): Grid => {
  const g = emptyGrid();
  g[INDEX] = v;
  return g;
};

const day = {
  underlying: 'NIFTY',
  date: '2026-01-01',
  expiry: '2026-01-06',
  spot: at(23010),
  ce: { '23000': at(120), '23100': at(70) },
  pe: { '23000': at(100), '22900': at(60) },
} as unknown as DaySeries;

const series = (c: number): OhlcSeries => ({ o: at(c), h: at(c), l: at(c), c: at(c) });
const wider: OhlcSource = {
  series: (kind, strike) => (kind === 'CE' && strike === 23200 ? series(40) : null),
  strikes: () => [23200],
};

describe('buildChain', () => {
  test('centres on the strike nearest spot, highest first', () => {
    const c = buildChain(day, INDEX, null, null)!;
    expect(c.atm).toBe(23000);
    expect(c.rows.map((r) => r.strike)).toEqual([23100, 23000, 22900]);
  });

  test('the signal legs read exactly what the signal reports', () => {
    const c = buildChain(day, INDEX, null, null)!;
    const row = c.rows.find((r) => r.strike === 23100)!;
    expect(row.ce!.iv).toBeCloseTo(legGreeksAt(day, 'CE', 23100, INDEX)!.iv, 2);
  });

  test('takes strikes beyond the ladder from the wider source, but the day cache first', () => {
    const c = buildChain(day, INDEX, wider, null)!;
    expect(c.rows[0]).toMatchObject({ strike: 23200, ce: { close: 40 }, pe: null });
    const clash: OhlcSource = { series: () => series(1), strikes: () => [] };
    const d = buildChain(day, INDEX, clash, null)!;
    expect(d.rows.find((r) => r.strike === 23100)!.ce!.close).toBe(70);
  });

  test('stays within the chain width', () => {
    const everywhere: OhlcSource = { series: () => series(5), strikes: () => [] };
    const c = buildChain(day, INDEX, everywhere, null)!;
    expect(c.rows).toHaveLength(2 * CHAIN_STEPS + 1);
  });

  test('carries volume, OI and bid/ask only where a wide download has them', () => {
    const wide = {
      more: {
        ce: {
          '23000': {
            cumulative_oi: at(500),
            cumulative_volume: at(900),
            l1bid: at(119),
            l1ask: at(121),
          },
        },
        pe: {},
      },
    } as unknown as WideDay;
    const row = buildChain(day, INDEX, null, wide)!.rows.find((r) => r.strike === 23000)!;
    expect(row.ce).toMatchObject({ oi: 500, volume: 900, bid: 119, ask: 121 });
    expect(row.pe).toMatchObject({ oi: null, volume: null });
  });

  test('a minute with no spot has no chain', () => {
    expect(buildChain(day, INDEX + 1, null, null)).toBeNull();
  });
  test('fills missing sides and minute gaps locally while preserving both saved price sources', () => {
    const missingMinute = series(99);
    missingMinute.c[INDEX] = null;
    const broker: OhlcSource = {
      series: (kind, strike) =>
        kind === 'CE' && strike === 23200
          ? series(40)
          : kind === 'PE' && strike === 23100
            ? missingMinute
            : null,
      strikes: () => [],
    };
    const local: OhlcSource = { series: () => series(25), strikes: () => [] };
    const chain = buildChain(day, INDEX, broker, null, local)!;
    expect(chain.rows.find((r) => r.strike === 23100)).toMatchObject({
      ce: { close: 70 },
      pe: { close: 25, localFallback: true },
    });
    expect(chain.rows.find((r) => r.strike === 23200)).toMatchObject({
      ce: { close: 40 },
      pe: { close: 25, localFallback: true },
    });
    expect(chain.rows.find((r) => r.strike === 23200)!.ce!.localFallback).toBeUndefined();
    expect(day.ce['23100'][INDEX]).toBe(70);
    expect(missingMinute.c[INDEX]).toBeNull();
  });

  test('does not carry local prices from another minute or invent volume and OI', () => {
    const otherMinute = series(25);
    otherMinute.c[INDEX] = null;
    otherMinute.c[INDEX - 1] = 25;
    const local: OhlcSource = {
      series: (kind, strike) =>
        kind === 'PE' && strike === 23100
          ? otherMinute
          : kind === 'CE' && strike === 23200
            ? series(40)
            : null,
      strikes: () => [],
    };
    const chain = buildChain(day, INDEX, null, null, local)!;
    expect(chain.rows.find((r) => r.strike === 23100)!.pe).toBeNull();
    expect(chain.rows.find((r) => r.strike === 23200)!.ce).toMatchObject({
      close: 40,
      localFallback: true,
      oi: null,
      volume: null,
      bid: null,
      ask: null,
    });
  });

  test('supplements SENSEX using its 100-point strike spacing', () => {
    const sensex = { ...day, underlying: 'SENSEX', spot: at(80010), ce: {}, pe: {} };
    const local: OhlcSource = { series: () => series(100), strikes: () => [] };
    const chain = buildChain(sensex, INDEX, null, null, local)!;
    expect(chain.step).toBe(100);
    expect(chain.rows).toHaveLength(21);
    expect(chain.rows.every((r) => r.ce?.localFallback && r.pe?.localFallback)).toBe(true);
  });
});
