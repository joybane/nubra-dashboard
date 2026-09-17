import { describe, expect, test } from 'vitest';
import { DEFAULT_FINDER_PARAMS, findCases, pickLegs, type FinderParams } from './caseFinder.ts';
import { SESSION_BARS, emptyGrid, minuteIndex, type DaySeries } from './daySeries.ts';

/** A day whose spot and leg closes are produced by functions of the minute index. */
function makeDay(
  spotAt: (i: number) => number | null,
  ceAt: (i: number) => number | null,
  peAt: (i: number) => number | null,
  ceStrike = 23350,
  peStrike = 23150,
): DaySeries {
  const spot = emptyGrid();
  const ce = emptyGrid();
  const pe = emptyGrid();
  for (let i = 0; i < SESSION_BARS; i++) {
    spot[i] = spotAt(i);
    ce[i] = ceAt(i);
    pe[i] = peAt(i);
  }
  return {
    v: 1,
    underlying: 'NIFTY',
    date: '2026-01-05',
    source: 'nubra',
    expiry: '2026-01-06',
    monthly: false,
    spot,
    ce: { [String(ceStrike)]: ce, [String(ceStrike + 50)]: emptyGrid() },
    pe: { [String(peStrike)]: pe, [String(peStrike - 50)]: emptyGrid() },
  };
}

const params = (over: Partial<FinderParams> = {}): FinderParams => ({
  ...DEFAULT_FINDER_PARAMS,
  ...over,
});

describe('pickLegs', () => {
  test('strikes are ATM ± 2 steps from spot at the entry minute', () => {
    const day = makeDay(
      () => 23255,
      () => 60,
      () => 55,
    );
    const legs = pickLegs(day, params());
    expect(legs).toMatchObject({ ceStrike: 23350, peStrike: 23150, entryTime: '09:15' });
  });

  test('a missing entry price moves the entry forward, within the slack', () => {
    const day = makeDay(
      () => 23255,
      (i) => (i < 3 ? null : 60),
      () => 55,
    );
    expect(pickLegs(day, params())).toMatchObject({ entryTime: '09:18', ceEntry: 60 });
  });
});

describe('findCases', () => {
  test('measures the P&L change between two minutes at the same close, SELL sign', () => {
    // Spot oscillates with period 60 minutes, so every minute has a same-price twin 60 min later.
    // CE decays one rupee a minute, PE is flat: selling, the CE leg gains ₹65 per minute.
    const day = makeDay(
      (i) => 23250 + 20 * Math.sin((2 * Math.PI * i) / 60),
      (i) => 200 - i * 0.1,
      () => 50,
    );
    const scan = findCases(day, params({ maxCasesPerDay: 1 }));
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const [c] = scan.cases;
    const minutes = minuteIndex(c.t2) - minuteIndex(c.t1);
    expect(minutes).toBeGreaterThanOrEqual(30);
    expect(Math.abs(c.spot2 - c.spot1)).toBeLessThanOrEqual(1);
    expect(c.peDelta).toBe(0);
    expect(c.ceDelta).toBeCloseTo(minutes * 0.1 * 65, 1);
    expect(c.totalDelta).toBeCloseTo(c.ceDelta + c.peDelta, 2);
  });

  test('BUY flips the sign', () => {
    const day = makeDay(
      () => 23250,
      (i) => 200 - i * 0.1,
      () => 50,
    );
    const sell = findCases(day, params({ maxCasesPerDay: 1 }));
    const buy = findCases(day, params({ maxCasesPerDay: 1, side: 'BUY' }));
    if (!sell.ok || !buy.ok) throw new Error('scan failed');
    expect(buy.cases[0].totalDelta).toBeCloseTo(-sell.cases[0].totalDelta, 2);
  });

  test('pairs whose closes are further apart than the tolerance are never cases', () => {
    const day = makeDay(
      (i) => 23250 + i * 10,
      (i) => 200 - i,
      () => 50,
    );
    const scan = findCases(day, params());
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases).toHaveLength(0);
  });

  test('the default keeps closes within a point; same ATM strike is not enough', () => {
    // 23240 and 23270 share the 23250 strike but are thirty points apart: not the same level.
    const day = makeDay(
      (i) => (i % 2 ? 23240 : 23270.5),
      (i) => 200 - i * 0.1,
      () => 50,
    );
    const tight = findCases(day, params({ maxCasesPerDay: 50, spacingMinutes: 0 }));
    const loose = findCases(
      day,
      params({ maxCasesPerDay: 50, spacingMinutes: 0, closeTolerance: 40 }),
    );
    if (!tight.ok || !loose.ok) throw new Error('scan failed');
    expect(tight.cases.length).toBeGreaterThan(0);
    expect(tight.cases.every((c) => Math.abs(c.spot2 - c.spot1) <= 1)).toBe(true);
    expect(loose.cases.some((c) => Math.abs(c.spot2 - c.spot1) > 1)).toBe(true);
  });

  test('no two kept cases have both start and end within `spacingMinutes`, up to the per-day cap', () => {
    const day = makeDay(
      () => 23250,
      (i) => 300 - i * 0.5 + Math.sin(i),
      (i) => 80 + Math.cos(i / 3),
    );
    const scan = findCases(
      day,
      params({ maxCasesPerDay: 10, minGapMinutes: 20, spacingMinutes: 25 }),
    );
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases.length).toBeGreaterThan(1);
    expect(scan.cases.length).toBeLessThanOrEqual(10);
    const spans = scan.cases.map((c) => [minuteIndex(c.t1), minuteIndex(c.t2)]);
    for (let a = 0; a < spans.length; a++) {
      for (let b = a + 1; b < spans.length; b++) {
        const near =
          Math.abs(spans[a][0] - spans[b][0]) < 25 && Math.abs(spans[a][1] - spans[b][1]) < 25;
        expect(near).toBe(false);
      }
    }
    // Strongest first: by default, the widest gap between the legs.
    const scores = scan.cases.map((c) => Math.abs(c.ceDelta - c.peDelta));
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  test('free slots take a pair that shares only its start with a stronger case', () => {
    // CE decays ₹2 a minute until 10:15, then stays flat; PE is flat. Every pair from 09:15 to 10:15
    // or later is equally strong, so the start-or-end rule lists 09:15→10:15 and 09:45→10:45 and
    // blocks every other 09:15 start. The free slot takes 09:15→10:45: same start, but its end is
    // 30 minutes from the first case's end.
    const day = makeDay(
      () => 23250,
      (i) => 400 - 2 * Math.min(i, 60),
      () => 50,
    );
    const scan = findCases(day, params({ maxCasesPerDay: 3, spacingMinutes: 30 }));
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases.map((c) => `${c.t1}→${c.t2}`)).toEqual([
      '09:15→10:15',
      '09:15→10:45',
      '09:45→10:45',
    ]);
  });

  test('legs that move together are not a mismatch, however big the total', () => {
    // Both legs decay alike (CE a rupee a minute, PE 0.9): a large total, a small gap between legs.
    const together = makeDay(
      () => 23250,
      (i) => 400 - i,
      (i) => 400 - i * 0.9,
    );
    const scan = findCases(together, params({ maxCasesPerDay: 50, spacingMinutes: 0 }));
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases).toHaveLength(0);

    const off = findCases(
      together,
      params({ maxCasesPerDay: 50, spacingMinutes: 0, legMismatchPct: 0 }),
    );
    if (!off.ok) throw new Error(off.reason);
    expect(off.cases.length).toBeGreaterThan(0);
  });

  test('opposite legs, or one leg at least twice the other, pass the 50% default', () => {
    // CE gains ₹65 a minute for the seller; PE loses (opposite) before 10:15 and gains a third as
    // much after it (same direction, but the legs are far apart).
    const day = makeDay(
      () => 23250,
      (i) => 400 - i,
      (i) => (i < 60 ? 100 + i * 0.5 : 130 - (i - 60) / 3),
    );
    const scan = findCases(day, params({ maxCasesPerDay: 50, spacingMinutes: 0 }));
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases.length).toBeGreaterThan(0);
    for (const c of scan.cases) {
      const gap = Math.abs(c.ceDelta - c.peDelta);
      expect(gap).toBeGreaterThanOrEqual(0.5 * Math.max(Math.abs(c.ceDelta), Math.abs(c.peDelta)));
    }
    const oppositeOnly = findCases(
      day,
      params({ maxCasesPerDay: 50, spacingMinutes: 0, legMismatchPct: 100 }),
    );
    if (!oppositeOnly.ok) throw new Error(oppositeOnly.reason);
    expect(oppositeOnly.cases.every((c) => c.ceDelta * c.peDelta <= 0)).toBe(true);
  });

  test('minutes missing any of spot, CE or PE are skipped, not carried forward', () => {
    const day = makeDay(
      () => 23250,
      (i) => (i === 40 ? null : 200 - i * 0.1),
      () => 50,
    );
    const scan = findCases(day, params({ maxCasesPerDay: 50, minGapMinutes: 30 }));
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.cases.every((c) => c.t1 !== '09:55' && c.t2 !== '09:55')).toBe(true);
  });

  test('pairs start no earlier than the entry and end no later than the exit', () => {
    const day = makeDay(
      () => 23250,
      (i) => 200 - i * 0.1,
      () => 50,
    );
    const scan = findCases(
      day,
      params({ entryTime: '10:00', exitTime: '14:00', maxCasesPerDay: 50 }),
    );
    if (!scan.ok) throw new Error(scan.reason);
    for (const c of scan.cases) {
      expect(c.t1 >= '10:00').toBe(true);
      expect(c.t2 <= '14:00').toBe(true);
    }
  });
});
