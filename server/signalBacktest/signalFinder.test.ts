import { describe, expect, test } from 'vitest';
import { DEFAULT_FINDER_PARAMS, findCases, type FinderParams } from '../analysis/caseFinder.ts';
import { SESSION_BARS, emptyGrid, minuteIndex, type DaySeries } from '../analysis/daySeries.ts';
import { firstSignal } from './signalFinder.ts';

/** A day whose spot and reference-leg closes are produced by functions of the minute index. */
function makeDay(
  spotAt: (i: number) => number | null,
  ceAt: (i: number) => number | null,
  peAt: (i: number) => number | null,
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
    ce: { '23350': ce },
    pe: { '23150': pe },
  };
}

const params = (over: Partial<FinderParams> = {}): FinderParams => ({
  ...DEFAULT_FINDER_PARAMS,
  ...over,
});

/** Blank every minute after `index`, as if the day had only got that far. */
function truncate(day: DaySeries, index: number): DaySeries {
  const cut = (g: (number | null)[]) => g.map((v, i) => (i > index ? null : v));
  return {
    ...day,
    spot: cut(day.spot),
    ce: Object.fromEntries(Object.entries(day.ce).map(([k, g]) => [k, cut(g)])),
    pe: Object.fromEntries(Object.entries(day.pe).map(([k, g]) => [k, cut(g)])),
  };
}

// Flat spot, CE decaying ₹0.10 a minute, PE flat: selling, every pair ≥ 30 min apart is a CE-only
// gain — a mismatch — so the first case is observable exactly 30 minutes after entry.
const decayingCe = () =>
  makeDay(
    () => 23250,
    (i) => 200 - i * 0.1,
    () => 50,
  );

describe('firstSignal', () => {
  test('fires at the first minute any qualifying pair exists', () => {
    const r = firstSignal(decayingCe(), params());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signal).toMatchObject({ t1: '09:15', t2: '09:45', t2Index: 30 });
    // (200 − 197) × 65, SELL sign: the CE leg gained ₹195, the PE leg nothing.
    expect(r.signal.ceDelta).toBe(195);
    expect(r.signal.peDelta).toBe(0);
    expect(r.signal.gap).toBe(195);
  });

  test('min |Δ| delays the signal until a pair is big enough', () => {
    // ₹6.50 per minute of gap: ≥ ₹300 needs 47 minutes → first t2 is 09:15 + 47.
    const r = firstSignal(decayingCe(), params({ minAbsPnl: 300 }));
    expect(r.ok && r.signal.t2).toBe('10:02');
  });

  test('uses no data after t2', () => {
    const day = makeDay(
      (i) => 23250 + 20 * Math.sin((2 * Math.PI * i) / 47),
      (i) => 150 + 30 * Math.sin((2 * Math.PI * i) / 83),
      (i) => 120 - i * 0.2,
    );
    const full = firstSignal(day, params());
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    const cut = firstSignal(truncate(day, full.signal.t2Index), params());
    expect(cut).toEqual(full);
  });

  test('agrees with the Analysis finder on what counts as a case', () => {
    const day = makeDay(
      (i) => 23250 + 20 * Math.sin((2 * Math.PI * i) / 60),
      (i) => 200 - i * 0.1,
      (i) => 80 + 10 * Math.cos((2 * Math.PI * i) / 90),
    );
    const p = params();
    const sig = firstSignal(day, p);
    const scan = findCases(day, p);
    expect(scan.ok).toBe(true);
    if (!scan.ok || !sig.ok) throw new Error('expected both to find something');
    expect(scan.candidates).toBeGreaterThan(0);
    // No case the Analysis tab lists can end before the first live-observable one.
    for (const c of scan.cases) {
      expect(minuteIndex(c.t2)).toBeGreaterThanOrEqual(sig.signal.t2Index);
    }
  });

  test('never signals when the finder has no candidate', () => {
    // Both legs decay alike: their P&L changes agree, so the 50% mismatch rule rejects every pair.
    const day = makeDay(
      () => 23250,
      (i) => 200 - i * 0.1,
      (i) => 200 - i * 0.1,
    );
    const scan = findCases(day, params());
    expect(scan.ok && scan.candidates).toBe(0);
    expect(firstSignal(day, params())).toEqual({ ok: false, reason: 'no signal' });
  });

  test('a missing minute is skipped, not filled forward', () => {
    const day = decayingCe();
    day.spot[30] = null;
    const r = firstSignal(day, params());
    expect(r.ok && r.signal.t2).toBe('09:46');
  });

  test('reports why the reference legs could not be picked', () => {
    const day = decayingCe();
    day.ce = {};
    const r = firstSignal(day, params());
    expect(r.ok).toBe(false);
  });
});
