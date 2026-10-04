import { describe, expect, test } from 'vitest';
import { RISK_FREE, blackScholes, impliedVolatility } from '../../src/lib/GexService.ts';
import { SESSION_BARS, emptyGrid, type DaySeries } from './daySeries.ts';
import { dayGreekSeries, forwardAt, legGreeksAt, signalGreeks, yearsToExpiry } from './greeks.ts';

const DATE = '2026-01-05';
const EXPIRY = '2026-01-08';
const SPOT = 23250;
/** NIFTY's forward sits BELOW spot; priced off spot the CE/PE vols would split apart. */
const FORWARD = SPOT - 20;
const SIGMA = 0.14;

/** A flat day whose every option close is the exact Black-76 price at FORWARD and SIGMA. */
function modelDay(strikes: { ce: number[]; pe: number[] }): DaySeries {
  const spot = emptyGrid();
  const ce: Record<string, (number | null)[]> = {};
  const pe: Record<string, (number | null)[]> = {};
  for (const k of strikes.ce) ce[String(k)] = emptyGrid();
  for (const k of strikes.pe) pe[String(k)] = emptyGrid();
  for (let i = 0; i < SESSION_BARS; i++) {
    spot[i] = SPOT;
    const T = yearsToExpiry(DATE, EXPIRY, i);
    for (const k of strikes.ce)
      ce[String(k)][i] = blackScholes(FORWARD, k, T, RISK_FREE, SIGMA, 'CE').price;
    for (const k of strikes.pe)
      pe[String(k)][i] = blackScholes(FORWARD, k, T, RISK_FREE, SIGMA, 'PE').price;
  }
  return {
    v: 1,
    underlying: 'NIFTY',
    date: DATE,
    source: 'nubra',
    expiry: EXPIRY,
    monthly: false,
    spot,
    ce,
    pe,
  };
}

const LADDER = [23100, 23150, 23200, 23250, 23300, 23350, 23400];

describe('yearsToExpiry', () => {
  test('counts calendar time to the 15:30 settlement', () => {
    // 09:15 on the 5th to 15:30 on the 8th: 3 days and 6h15m.
    expect(yearsToExpiry(DATE, EXPIRY, 0) * 365).toBeCloseTo(3 + 6.25 / 24, 6);
  });

  test('is floored at one hour on expiry day', () => {
    expect(yearsToExpiry(EXPIRY, EXPIRY, SESSION_BARS - 1)).toBeCloseTo(1 / (365 * 24), 12);
  });
});

describe('forwardAt', () => {
  test('is the put-call-parity forward, not spot', () => {
    const day = modelDay({ ce: LADDER, pe: LADDER });
    expect(forwardAt(day, 30)).toBeCloseTo(FORWARD, 3);
  });

  test('falls back to spot when no strike has both a CE and a PE', () => {
    const day = modelDay({ ce: [23350], pe: [23150] });
    expect(forwardAt(day, 30)).toBe(SPOT);
  });

  test('is null when the minute has no spot', () => {
    const day = modelDay({ ce: LADDER, pe: LADDER });
    day.spot[30] = null;
    expect(forwardAt(day, 30)).toBeNull();
  });
});

describe('legGreeksAt', () => {
  const day = modelDay({ ce: LADDER, pe: LADDER });

  test('recovers the vol and greeks the prices were built from', () => {
    const g = legGreeksAt(day, 'CE', 23350, 30)!;
    const T = yearsToExpiry(DATE, EXPIRY, 30);
    const truth = blackScholes(FORWARD, 23350, T, RISK_FREE, SIGMA, 'CE');
    expect(g.iv).toBeCloseTo(SIGMA * 100, 1);
    expect(g.delta).toBeCloseTo(truth.delta, 3);
    expect(g.gamma).toBeCloseTo(truth.gamma, 5);
    expect(g.vega).toBeCloseTo(truth.vega, 2);
    expect(g.theta).toBeCloseTo(truth.theta, 2);
  });

  // The pin for the forward. A round trip through the same model passes whichever forward is used
  // as long as it is used consistently, so the test builds prices off a forward that is NOT spot:
  // inverting them against spot moves the vols of the two sides in opposite directions.
  test('CE and PE of the same vol agree, and spot as the forward would not', () => {
    const ce = legGreeksAt(day, 'CE', 23350, 30)!;
    const pe = legGreeksAt(day, 'PE', 23150, 30)!;
    expect(ce.iv).toBeCloseTo(SIGMA * 100, 1);
    expect(pe.iv).toBeCloseTo(SIGMA * 100, 1);

    const T = yearsToExpiry(DATE, EXPIRY, 30);
    const ceClose = day.ce['23350'][30]!;
    const viaSpot = impliedVolatility(ceClose, SPOT, 23350, T, RISK_FREE, 'CE') * 100;
    expect(Math.abs(viaSpot - SIGMA * 100)).toBeGreaterThan(0.3);
  });

  test('puts have negative delta and calls positive, both with positive gamma and vega', () => {
    const ce = legGreeksAt(day, 'CE', 23300, 30)!;
    const pe = legGreeksAt(day, 'PE', 23200, 30)!;
    expect(ce.delta).toBeGreaterThan(0);
    expect(pe.delta).toBeLessThan(0);
    expect(ce.gamma).toBeGreaterThan(0);
    expect(pe.vega).toBeGreaterThan(0);
  });

  test('is null for a minute with no close, or a strike the day does not hold', () => {
    const gappy = modelDay({ ce: LADDER, pe: LADDER });
    gappy.ce['23350'][30] = null;
    expect(legGreeksAt(gappy, 'CE', 23350, 30)).toBeNull();
    expect(legGreeksAt(gappy, 'CE', 99999, 30)).toBeNull();
  });

  test('is null, not an invented vol, when the close is below intrinsic', () => {
    const bad = modelDay({ ce: LADDER, pe: LADDER });
    bad.ce['23100'][30] = 1; // a 23100 call is worth far more than ₹1 with spot at 23250
    expect(legGreeksAt(bad, 'CE', 23100, 30)).toBeNull();
  });
});

describe('signalGreeks', () => {
  test('prices both legs at both signal minutes', () => {
    const day = modelDay({ ce: LADDER, pe: LADDER });
    const g = signalGreeks(day, { ceStrike: 23350, peStrike: 23150 }, 0, 30);
    expect(g.t1.CE).toEqual(legGreeksAt(day, 'CE', 23350, 0));
    expect(g.t2.PE).toEqual(legGreeksAt(day, 'PE', 23150, 30));
    // Same spot, less time: theta is the day's decay and it grows as expiry nears; vega shrinks.
    expect(g.t2.CE!.vega).toBeLessThan(g.t1.CE!.vega);
  });

  test('a leg that cannot be priced is null while the other still is', () => {
    const day = modelDay({ ce: LADDER, pe: LADDER });
    day.pe['23150'][30] = null;
    const g = signalGreeks(day, { ceStrike: 23350, peStrike: 23150 }, 0, 30);
    expect(g.t2.PE).toBeNull();
    expect(g.t2.CE).not.toBeNull();
  });
});

describe('dayGreekSeries', () => {
  test('spans the whole session and leaves gaps where a minute cannot be priced', () => {
    const day = modelDay({ ce: LADDER, pe: LADDER });
    day.ce['23350'][100] = null;
    const s = dayGreekSeries(day, { ceStrike: 23350, peStrike: 23150 });
    expect(s.CE.delta).toHaveLength(SESSION_BARS);
    expect(s.CE.delta[100]).toBeNull();
    expect(s.CE.delta[101]).not.toBeNull();
    expect(s.PE.delta[100]).not.toBeNull();
    expect(s.forward[30]).toBeCloseTo(FORWARD, 3);
  });
});
