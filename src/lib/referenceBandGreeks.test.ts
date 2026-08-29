import { describe, expect, test } from 'vitest';
import type { ChainSnapshot } from './greekAggregator.ts';
import {
  BAND_DELTA_MAX,
  BAND_DELTA_MIN,
  ReferenceBandMachine,
  inferBandStrikeStep,
  isBandMember,
  normalizeBandDelta,
  referenceBandPointToSeries,
  referenceBandUniverse,
  type BandContractMeta,
} from './referenceBandGreeks.ts';

const T0 = Date.UTC(2026, 7, 28, 3, 45);
const snap = (
  minute: number,
  ce: ChainSnapshot['ce'],
  pe: ChainSnapshot['pe'] = [],
  extra: Partial<ChainSnapshot> = {},
): ChainSnapshot => ({ ts: T0 + minute * 60_000, ce, pe, ...extra });

describe('reference delta membership', () => {
  test('uses inclusive 0.05 and 0.60 bounds and normalizes percent delta', () => {
    for (const value of [0.05, 0.6, -0.05, -0.6, 5, 60, -5, -60])
      expect(isBandMember(value), String(value)).toBe(true);
    for (const value of [0.0499, 0.6001, -0.0499, -0.6001, 4.99, 60.01])
      expect(isBandMember(value), String(value)).toBe(false);
    expect(normalizeBandDelta(42)).toBe(0.42);
    expect(normalizeBandDelta(undefined)).toBeUndefined();
    expect(BAND_DELTA_MIN).toBe(0.05);
    expect(BAND_DELTA_MAX).toBe(0.6);
  });
});

describe('ReferenceBandMachine', () => {
  test('sets zero contribution on entry and tracks movement from each leg entry', () => {
    const machine = new ReferenceBandMachine();
    const first = machine.ingest(
      snap(0, [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }]),
    )!;
    expect(first.callVegaChange).toBe(0);
    expect(first.callThetaChange).toBe(0);
    expect(first.callVegaTotal).toBe(10);
    expect(first.callCount).toBe(1);

    const next = machine.ingest(snap(1, [{ key: 'c', sp: 100, delta: 0.4, vega: 13, theta: -7 }]))!;
    expect(next.callVegaChange).toBe(3);
    expect(next.callThetaChange).toBe(-2);
  });

  test('deletes both baselines on exit and establishes fresh baselines on re-entry', () => {
    const machine = new ReferenceBandMachine();
    machine.ingest(snap(0, [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }]));
    machine.ingest(snap(1, [{ key: 'c', sp: 100, delta: 0.8, vega: 12, theta: -7 }]));
    const reentry = machine.ingest(
      snap(2, [{ key: 'c', sp: 100, delta: 0.3, vega: 20, theta: -10 }]),
    )!;
    expect(reentry.callVegaChange).toBe(0);
    expect(reentry.callThetaChange).toBe(0);
    const next = machine.ingest(
      snap(3, [{ key: 'c', sp: 100, delta: 0.3, vega: 21, theta: -12 }]),
    )!;
    expect(next.callVegaChange).toBe(1);
    expect(next.callThetaChange).toBe(-2);
  });

  test('shares membership while preserving independent missing Greek baselines', () => {
    const machine = new ReferenceBandMachine();
    const first = machine.ingest(snap(0, [{ key: 'c', sp: 100, delta: 0.4, vega: 10 }]))!;
    expect(first.callCount).toBe(1);
    expect(first.callVegaChange).toBe(0);
    expect(first.callThetaChange).toBeNaN();
    const laterTheta = machine.ingest(
      snap(1, [{ key: 'c', sp: 100, delta: 0.4, vega: 11, theta: -8 }]),
    )!;
    expect(laterTheta.callVegaChange).toBe(1);
    expect(laterTheta.callThetaChange).toBe(0);
  });

  test('keeps CE and PE separate', () => {
    const machine = new ReferenceBandMachine();
    machine.ingest(
      snap(
        0,
        [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }],
        [{ key: 'p', sp: 100, delta: -0.4, vega: 20, theta: -9 }],
      ),
    );
    const point = machine.ingest(
      snap(
        1,
        [{ key: 'c', sp: 100, delta: 0.4, vega: 12, theta: -6 }],
        [{ key: 'p', sp: 100, delta: -0.4, vega: 17, theta: -11 }],
      ),
    )!;
    expect(referenceBandPointToSeries(point, 'vega')).toMatchObject({
      ceDiff: 2,
      peDiff: -3,
      ceTotal: 12,
      peTotal: 17,
    });
  });

  test('rejects a historical bar without a positive two-sided ATM candidate before aggregation', () => {
    const machine = new ReferenceBandMachine();
    const rejected = machine.ingest(
      snap(
        0,
        [{ key: 'c', sp: 100, bid: 0, ask: 5, delta: 0.4, vega: 10, theta: -5 }],
        [{ key: 'p', sp: 100, bid: 0, ask: 5, delta: -0.4, vega: 9, theta: -4 }],
        { spot: 100, requireBook: true },
      ),
    );
    expect(rejected).toBeNull();

    const accepted = machine.ingest(
      snap(
        1,
        [{ key: 'c', sp: 100, bid: 4, ask: 5, delta: 0.4, vega: 12, theta: -6 }],
        [{ key: 'p', sp: 100, bid: 3, ask: 4, delta: -0.4, vega: 11, theta: -5 }],
        { spot: 100, requireBook: true },
      ),
    )!;
    expect(accepted.callVegaChange).toBe(0);
    expect(accepted.putVegaChange).toBe(0);
  });

  test('selects the cheapest candidate and seeds the next roll from its synthetic forward', () => {
    const machine = new ReferenceBandMachine();
    const legs = (side: 'CE' | 'PE') =>
      [90, 100, 110].map((sp) => ({
        key: `${side}:${sp}`,
        sp,
        bid: sp === 110 ? 1 : 5,
        ask: sp === 110 ? 2 : 6,
        delta: side === 'CE' ? 0.4 : -0.4,
        vega: 10,
        theta: -5,
      }));
    const first = machine.ingest(
      snap(0, legs('CE'), legs('PE'), { spot: 100, requireBook: true }),
    )!;
    expect(first.atmStrike).toBe(110);
    expect(first.forward).toBe(110);

    const second = machine.ingest(
      snap(1, legs('CE'), legs('PE'), { spot: 90, requireBook: true }),
    )!;
    expect(second.atmStrike).toBe(110);
    expect(second.rolled).toBe(false);
  });

  test('resets entry baselines on a new IST session', () => {
    const machine = new ReferenceBandMachine();
    machine.ingest(snap(0, [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }]));
    const moved = machine.ingest(
      snap(1, [{ key: 'c', sp: 100, delta: 0.4, vega: 12, theta: -7 }]),
    )!;
    expect(moved.callVegaChange).toBe(2);
    const nextDay = machine.ingest({
      ts: T0 + 86_400_000,
      ce: [{ key: 'c', sp: 100, delta: 0.4, vega: 30, theta: -20 }],
      pe: [],
    })!;
    expect(nextDay.callVegaChange).toBe(0);
    expect(nextDay.callThetaChange).toBe(0);
  });

  test('uninterrupted replay equals history followed by buffered live replay', () => {
    const inputs = [
      snap(0, [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }]),
      snap(1, [{ key: 'c', sp: 100, delta: 0.7, vega: 11, theta: -6 }]),
      snap(2, [{ key: 'c', sp: 100, delta: 0.3, vega: 20, theta: -10 }]),
      snap(3, [{ key: 'c', sp: 100, delta: 0.3, vega: 22, theta: -11 }]),
    ];
    const uninterrupted = new ReferenceBandMachine();
    const expected = inputs.map((input) => uninterrupted.ingest(input));
    const replayed = new ReferenceBandMachine();
    const actual = [...inputs.slice(0, 2), ...inputs.slice(2)].map((input) =>
      replayed.ingest(input),
    );
    expect(actual).toEqual(expected);
  });

  test('processes exit and re-entry within one display second', () => {
    const machine = new ReferenceBandMachine();
    machine.ingest({
      ts: T0,
      ce: [{ key: 'c', sp: 100, delta: 0.4, vega: 10, theta: -5 }],
      pe: [],
    });
    machine.ingest({
      ts: T0 + 100,
      ce: [{ key: 'c', sp: 100, delta: 0.8, vega: 12, theta: -6 }],
      pe: [],
    });
    machine.ingest({
      ts: T0 + 200,
      ce: [{ key: 'c', sp: 100, delta: 0.3, vega: 20, theta: -10 }],
      pe: [],
    });
    const next = machine.ingest({
      ts: T0 + 1_100,
      ce: [{ key: 'c', sp: 100, delta: 0.3, vega: 21, theta: -11 }],
      pe: [],
    })!;
    expect(next.callVegaChange).toBe(1);
    expect(next.callThetaChange).toBe(-1);
  });
});

test('reference fetch universe uses two ITM and 24 OTM strikes around ATM travel', () => {
  const strikes = Array.from({ length: 81 }, (_, index) => 600 + index * 10);
  const contracts: BandContractMeta[] = strikes.flatMap((strike) => [
    { name: `C${strike}`, strike, side: 'CE', expiry: '2026-09-03' },
    { name: `P${strike}`, strike, side: 'PE', expiry: '2026-09-03' },
  ]);
  expect(inferBandStrikeStep(strikes)).toBe(10);
  const names = referenceBandUniverse(contracts, [1001, 1099]);
  // ATM travel is 1000..1100; fetch anchors widen to 980..1120.
  expect(names.has('C960')).toBe(true); // CE two ITM below lower fetch anchor
  expect(names.has('C950')).toBe(false);
  expect(names.has('C1360')).toBe(true); // CE 24 OTM above upper fetch anchor
  expect(names.has('C1370')).toBe(false);
  expect(names.has('P740')).toBe(true); // PE 24 OTM below lower fetch anchor
  expect(names.has('P730')).toBe(false);
  expect(names.has('P1140')).toBe(true); // PE two ITM above upper fetch anchor
  expect(names.has('P1150')).toBe(false);
});
