import { describe, expect, test } from 'vitest';
import { createPremiumSetsBuilder, groupPrices, summariseSets } from './premiumSets.ts';

/** Deterministic noise, so a failing grouping can be reproduced. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` prices within ±`spread` (a fraction) of `centre`. */
function around(centre: number, n: number, spread: number, rand: () => number): number[] {
  return Array.from({ length: n }, () => centre * (1 + (rand() * 2 - 1) * spread));
}

const q = (sorted: number[], f: number) => sorted[Math.floor((sorted.length - 1) * f)];

describe('groupPrices', () => {
  test('finds as many sets as the prices bunch into, in ascending order', () => {
    const rand = rng(1);
    const prices = [
      ...around(10, 40, 0.1, rand),
      ...around(35, 40, 0.1, rand),
      ...around(90, 40, 0.1, rand),
    ];
    const groups = groupPrices(prices);
    expect(groups).toHaveLength(3);
    const medians = groups.map((g) => g[Math.floor(g.length / 2)]);
    expect(medians[0]).toBeGreaterThan(9);
    expect(medians[0]).toBeLessThan(11.5);
    expect(medians[1]).toBeGreaterThan(31);
    expect(medians[1]).toBeLessThan(39);
    expect(medians[2]).toBeGreaterThan(80);
    expect(medians[2]).toBeLessThan(100);
    // Every price lands in exactly one set.
    expect(groups.flat()).toHaveLength(prices.length);
  });

  test('is not limited to four: five separated bunches give five sets', () => {
    const rand = rng(2);
    const prices = [4, 9, 19, 38, 80].flatMap((c) => around(c, 30, 0.08, rand));
    expect(groupPrices(prices)).toHaveLength(5);
  });

  test('prices spread evenly with no gap are still cut into narrow ratio bands', () => {
    const rand = rng(3);
    // Log-uniform between ₹5 and ₹60: no valley anywhere, a 12x spread.
    const prices = Array.from({ length: 300 }, () => 5 * Math.pow(12, rand()));
    const groups = groupPrices(prices);
    // 12x in bands of 1.5x is six or seven sets.
    expect(groups.length).toBeGreaterThanOrEqual(6);
    for (const g of groups) {
      const sorted = [...g].sort((a, b) => a - b);
      expect(q(sorted, 0.9) / q(sorted, 0.1)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  test('a long tail of dearer prices is cut into sets of its own, not left on the end of a wide one', () => {
    const rand = rng(6);
    // Mostly ₹20-40, then a thin spread out to ₹200: the top set must not read like ₹30 - ₹180.
    const prices = [
      ...Array.from({ length: 200 }, () => 20 * Math.pow(2, rand())),
      ...Array.from({ length: 120 }, () => 40 * Math.pow(5, rand())),
    ];
    for (const g of groupPrices(prices)) {
      const sorted = [...g].sort((a, b) => a - b);
      expect(q(sorted, 0.9) / q(sorted, 0.1)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  test('a sliver too thin to be a tier is left out, not merged into a wide set', () => {
    const rand = rng(7);
    // 300 prices evenly spread in log between ₹5 and ₹40, plus 8 cheap ones at ₹1.0 - 1.3.
    const body = Array.from({ length: 300 }, () => 5 * Math.pow(8, rand()));
    const cheap = Array.from({ length: 8 }, () => 1 + rand() * 0.3);
    const groups = groupPrices([...body, ...cheap]);
    const kept = groups.flat();
    expect(Math.min(...kept)).toBeGreaterThan(1.3);
    expect(kept.length).toBeLessThan(body.length + cheap.length);
    for (const g of groups) {
      const sorted = [...g].sort((a, b) => a - b);
      expect(q(sorted, 0.9) / q(sorted, 0.1)).toBeLessThanOrEqual(1.5 + 1e-9);
    }
  });

  test('a handful of stray prices is folded into the set beside it, not given its own', () => {
    const rand = rng(4);
    const prices = [...around(20, 60, 0.08, rand), 200, 205, 210];
    expect(groupPrices(prices)).toHaveLength(1);
  });

  test('too few prices to find tiers come back as the one group they are', () => {
    expect(groupPrices([5, 6, 7, 30])).toEqual([[5, 6, 7, 30]]);
    expect(groupPrices([])).toEqual([]);
  });

  test('ignores prices that are not positive numbers', () => {
    expect(groupPrices([0, -3, Number.NaN, Infinity])).toEqual([]);
  });
});

describe('summariseSets', () => {
  /** 25 days: 20 offer a ~₹10 and a ~₹40 strike, 5 offer only a ~₹40 one. */
  function days() {
    const rand = rng(5);
    const both = Array.from({ length: 20 }, () => [
      ...around(10, 1, 0.08, rand),
      ...around(40, 1, 0.08, rand),
    ]);
    const highOnly = Array.from({ length: 5 }, () => around(40, 1, 0.08, rand));
    return [...both, ...highOnly];
  }

  test('reports a typical range on tidy steps, the median, and the number of prices', () => {
    const sets = summariseSets(days());
    expect(sets).toHaveLength(2);
    for (const s of sets) {
      expect((s.low * 2) % 1).toBe(0);
      expect((s.high * 2) % 1).toBe(0);
      expect(s.low).toBeLessThan(s.high);
      expect(s.median).toBeGreaterThanOrEqual(s.low);
      expect(s.median).toBeLessThanOrEqual(s.high);
    }
    expect(sets[0].low).toBeLessThan(sets[1].low);
    expect(sets[0].points).toBe(20);
    expect(sets[1].points).toBe(25);
  });

  test('the rounding step grows with the price: a tenth under ₹5, a half under ₹50, a rupee above', () => {
    const around = (centre: number) =>
      Array.from({ length: 12 }, (_, i) => [centre * (1 + (i - 6) * 0.01)]);
    const [cheap] = summariseSets(around(2.2));
    expect(Math.round(cheap.low * 10)).toBeCloseTo(cheap.low * 10, 6);
    expect(Math.round(cheap.high * 10)).toBeCloseTo(cheap.high * 10, 6);
    const [mid] = summariseSets(around(30));
    expect((mid.low * 2) % 1).toBe(0);
    expect((mid.high * 2) % 1).toBe(0);
    const [dear] = summariseSets(around(120));
    expect(dear.low % 1).toBe(0);
    expect(dear.high % 1).toBe(0);
    // Rounding only ever widens the typical range.
    for (const set of [cheap, mid, dear]) expect(set.low).toBeLessThan(set.median);
  });

  test('coverage is the share of days with at least one strike inside the set’s own range', () => {
    const all = days();
    const sets = summariseSets(all);
    for (const set of sets) {
      const inside = all.filter((d) => d.some((p) => p >= set.low && p <= set.high)).length;
      expect(set.coverage).toBe(Math.round((inside / all.length) * 100));
    }
    // 20 of the 25 days have a ~₹10 strike at all, so the lower set cannot cover more than that.
    expect(sets[0].coverage).toBeLessThanOrEqual(80);
    expect(sets[0].coverage).toBeGreaterThan(60);
    expect(sets[1].coverage).toBeGreaterThan(sets[0].coverage);
  });

  test('days with no prices at all are not counted against coverage', () => {
    const all = days();
    const plain = summariseSets(all);
    const withEmpty = summariseSets([...all, [], []]);
    expect(withEmpty.map((s) => s.coverage)).toEqual(plain.map((s) => s.coverage));
  });
});

describe('createPremiumSetsBuilder', () => {
  const day = (ce: number[], pe: number[]) => ({ CE: ce, PE: pe });

  test('files each day under its distance from expiry and keeps the sides apart', () => {
    const b = createPremiumSetsBuilder();
    b.add(1, day([10, 11, 12], [30]));
    b.add(1, day([10, 11, 12], [30]));
    b.add(0, day([50], [60]));
    const { expiryDays } = b.build();
    expect(expiryDays.map((d) => d.dte)).toEqual([0, 1]); // nearest to expiry first
    const dayBefore = expiryDays[1];
    expect(dayBefore.days).toBe(2);
    expect(expiryDays[0].days).toBe(1);
    expect(dayBefore.CE[0].median).toBeCloseTo(11, 0);
    expect(dayBefore.PE[0].median).toBe(30);
  });

  test('a distance nobody reached is simply not listed', () => {
    const b = createPremiumSetsBuilder();
    b.add(3, day([10], [10]));
    expect(b.build().expiryDays.map((d) => d.dte)).toEqual([3]);
  });

  test('a day whose distance is unknown is left out', () => {
    const b = createPremiumSetsBuilder();
    b.add(null, day([10], [10]));
    expect(b.build().expiryDays).toEqual([]);
  });
});
