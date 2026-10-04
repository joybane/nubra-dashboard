import { describe, expect, test } from 'vitest';
import type { Bar } from './backtest/dataLayer.ts';
import {
  istDatesBetween,
  localBarAt,
  localContractName,
  localGreekSeries,
  nsToIstMin,
  parseLocalContractName,
  parseSourcePref,
  resolveSource,
  secToNs,
  spotFromBars,
  toLocalBars,
  type LocalDay,
} from './nubraBacktestLocal.ts';

/** Epoch seconds of an IST wall-clock minute on `date`. */
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`) / 1000;

const bar = (date: string, hhmm: string, close: number, extra: Partial<Bar> = {}): Bar => ({
  ts: ist(date, hhmm),
  date,
  hhmm,
  open: close,
  high: close,
  low: close,
  close,
  iv: 14,
  volume: 10,
  strike: 22000,
  oi: 500,
  spot: 22010,
  ...extra,
});

describe('bar conversion', () => {
  test('ns timestamps round-trip to the IST minute', () => {
    const ns = secToNs(ist('2024-01-04', '09:20'));
    expect(nsToIstMin(ns)).toBe(9 * 60 + 20);
  });

  test('option bars: IV to a decimal, volume made cumulative', () => {
    const out = toLocalBars([
      bar('2024-01-04', '09:15', 100, { iv: 14.5, volume: 10 }),
      bar('2024-01-04', '09:16', 101, { iv: 0, volume: 5 }),
    ]);
    expect(out.map((b) => b.iv)).toEqual([0.145, 0]);
    expect(out.map((b) => b.vol)).toEqual([10, 15]);
    expect(out[1].close).toBe(101);
  });

  test('spot candles run close-to-close and collapse duplicate minutes', () => {
    const spot = spotFromBars([
      bar('2024-01-04', '09:15', 1, { spot: 22000 }),
      bar('2024-01-04', '09:15', 2, { spot: 22000 }), // another strike, same minute
      bar('2024-01-04', '09:16', 3, { spot: 22030 }),
      bar('2024-01-04', '09:17', 4, { spot: 22010 }),
    ]);
    expect(spot.map((b) => [b.open, b.high, b.low, b.close])).toEqual([
      [22000, 22000, 22000, 22000],
      [22000, 22030, 22000, 22030],
      [22030, 22030, 22010, 22010],
    ]);
  });
});

describe('localBarAt', () => {
  const bars = toLocalBars([bar('2024-01-04', '09:20', 100), bar('2024-01-04', '11:00', 90)]);

  test('takes the nearest bar within the gap', () => {
    expect(localBarAt(bars, '09:21')?.close).toBe(100);
  });

  test('refuses a bar from a different part of the day', () => {
    // A strike outside the ATM±10 wing: nearest bar is 40 minutes away, which must not price a leg.
    expect(localBarAt(bars, '10:00')).toBeNull();
    expect(localBarAt([], '09:20')).toBeNull();
  });
});

describe('contract names', () => {
  test('round-trip', () => {
    const name = localContractName('NIFTY', '2024-01-04', 21500, 'PE');
    expect(name).toBe('LOCAL|NIFTY|2024-01-04|21500|PE');
    expect(parseLocalContractName(name)).toEqual({
      und: 'NIFTY',
      expiry: '2024-01-04',
      strike: 21500,
      side: 'PE',
    });
  });

  test('broker names and malformed ones are not local', () => {
    expect(parseLocalContractName('NIFTY24JAN21500PE')).toBeNull();
    expect(parseLocalContractName('LOCAL|BANKNIFTY|2024-01-04|45000|CE')).toBeNull();
    expect(parseLocalContractName('LOCAL|NIFTY|20240104|21500|CE')).toBeNull();
  });
});

describe('source selection', () => {
  test('anything but nubra/local is auto', () => {
    expect(parseSourcePref('local')).toBe('local');
    expect(parseSourcePref('nubra')).toBe('nubra');
    expect(parseSourcePref(undefined)).toBe('auto');
    expect(parseSourcePref('LOCAL')).toBe('auto');
  });

  test('explicit choices are honoured for underlyings the tree holds', async () => {
    expect(await resolveSource('NIFTY', '2020-01-01', 'nubra')).toBe('nubra');
    expect(await resolveSource('NIFTY', '2026-09-01', 'local')).toBe('local');
  });

  test('underlyings without local data always use the broker', async () => {
    expect(await resolveSource('BANKNIFTY', '2023-01-05', 'local')).toBe('nubra');
    expect(await resolveSource('CRUDEOIL', '2023-01-05', 'auto')).toBe('nubra');
  });

  test('auto keeps dates inside broker history on the broker', async () => {
    // On/after the first broker instrument master no parquet lookup is even needed.
    expect(await resolveSource('NIFTY', '2025-07-21', 'auto')).toBe('nubra');
    expect(await resolveSource('SENSEX', '2025-07-21', 'auto')).toBe('nubra');
  });

  test('auto does not trust bar history that has no instrument master behind it', async () => {
    // NIFTY has broker bars from 2025-03-24 but no master until 2025-07-21, and Nubra BT needs the
    // master. With no Analysis cache and no parquet tree for this underlying in a bare checkout, a
    // date in that gap must at least not be claimed for the broker by the bar-history date alone.
    const { nubraFromFor } = await import('./nubraBacktestLocal.ts');
    expect(await nubraFromFor('NIFTY')).toBe('2025-07-21');
    expect(await nubraFromFor('SENSEX')).toBe('2025-07-21');
  });
});

test('istDatesBetween lists IST weekdays only', () => {
  // Fri 15:30 IST → Mon 15:30 IST: Saturday and Sunday drop out.
  expect(
    istDatesBetween(Date.parse('2024-06-07T10:00:00Z'), Date.parse('2024-06-10T10:00:00Z')),
  ).toEqual(['2024-06-07', '2024-06-10']);
});

test('reconstructed greeks use the parity forward and have the usual signs', () => {
  const date = '2024-01-01';
  const mk = (hhmm: string, close: number) =>
    toLocalBars([bar(date, hhmm, close, { spot: 22000 })]);
  const day: LocalDay = {
    underlying: 'NIFTY',
    date,
    expiry: '2024-01-04',
    flag: 'WEEK',
    strikes: [21900, 22000, 22100],
    // A pair at 22000 with CE > PE implies a forward above 22000; spot is 22000.
    ce: new Map([
      [22000, mk('10:00', 130)],
      [22100, mk('10:00', 85)],
    ]),
    pe: new Map([
      [22000, mk('10:00', 110)],
      [21900, mk('10:00', 70)],
    ]),
    spot: spotFromBars([bar(date, '10:00', 0, { spot: 22000 })]),
  };
  const g = localGreekSeries(day);
  const ce = g.get('22000|CE')![0];
  const pe = g.get('22000|PE')![0];
  const otmCe = g.get('22100|CE')![0];
  expect(ce.delta).toBeGreaterThan(0.5); // forward ≈ 22020 > K
  expect(pe.delta).toBeLessThan(0);
  expect(ce.delta - pe.delta).toBeCloseTo(1, 2); // Black-76: Δc − Δp = e^{-rT}
  expect(ce.iv).toBeCloseTo(pe.iv, 3); // parity forward makes the pair agree
  expect(otmCe.delta).toBeLessThan(ce.delta);
  expect(ce.vega).toBeGreaterThan(0);
  expect(ce.theta).toBeLessThan(0);
});
