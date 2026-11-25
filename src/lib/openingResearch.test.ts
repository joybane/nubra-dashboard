import { describe, expect, test } from 'vitest';
import { analyzeOpeningEntryRules } from './openingResearch';
import {
  OPENING_ENTRY_FEATURES,
  type OpeningDaySummary,
  type OpeningResearchRow,
} from './openingStrangle';

function sample(index: number, credit: number | null, close: number | null) {
  const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
  const day: OpeningDaySummary = {
    date,
    source: 'nubra',
    expiry: date,
    dte: 0,
    dteGroup: '0',
    monthly: false,
    entry: 0,
    entrySpot: 22_000,
    ceStrike: 22_100,
    peStrike: 21_900,
    ceEntry: 1,
    peEntry: 1,
    quantity: 65,
    entryCredit: 130,
    entryIv: null,
    spotMove: null,
    ivChange: null,
    touch: null,
    close,
    best: { minute: 2, pnl: 1_000 },
    worst: { minute: 4, pnl: -500 },
    drawdown: 1_500,
    marked: 375,
    possible: 375,
    lastMarked: 374,
  };
  const features = Object.fromEntries(
    OPENING_ENTRY_FEATURES.map((feature) => [feature, null]),
  ) as OpeningResearchRow['features'];
  const row: OpeningResearchRow = { date, pnl: [], features: { ...features, entryCredit: credit } };
  return { day, row };
}

function study(samples: ReturnType<typeof sample>[], cost?: number) {
  return analyzeOpeningEntryRules(
    samples.map(({ day }) => day),
    samples.map(({ row }) => row),
    cost,
  );
}

describe('opening entry research', () => {
  test('keeps exact-close sessions in the baseline and subtracts a round-trip cost once', () => {
    const samples = Array.from({ length: 10 }, (_, index) =>
      sample(index, index === 9 ? null : index, 100),
    );
    samples.push(sample(10, 300, null));
    const report = study([...samples, samples[0]].reverse(), 25);
    expect(report.discovery.from).toBe('2025-01-01');
    expect(report.discovery.to).toBe('2025-01-07');
    expect(report.holdout.from).toBe('2025-01-08');
    expect(report.holdout.to).toBe('2025-01-10');
    expect(report.holdout.baseline).toEqual({
      eligible: 3,
      n: 3,
      takeRate: 100,
      winRate: 100,
      meanNet: 75,
      totalNet: 225,
      netPerEligible: 75,
      p10Net: 75,
      medianDrawdown: 1_500,
    });
    const high = report.candidates.find(({ key }) => key === 'entryCredit-high');
    expect(high).toMatchObject({
      missingDiscovery: 0,
      missingHoldout: 1,
      validated: false,
      holdout: { n: 2, eligible: 3, totalNet: 150, netPerEligible: 50 },
      holdoutDates: ['2025-01-08', '2025-01-09'],
    });
  });

  test('learns thresholds and sorting from discovery even when later data change', () => {
    const samples = Array.from({ length: 150 }, (_, index) => {
      const credit = (index % 3) + 1;
      return sample(index, credit, credit === 3 ? 300 : -100);
    });
    const report = study(samples, 10);
    const high = report.candidates[0];
    expect(high).toMatchObject({
      key: 'entryCredit-high',
      discovery: { n: 35 },
      holdout: { n: 15, meanNet: 290 },
      validated: true,
    });
    const adverse = study(
      samples.map((row, index) => (index < 105 ? row : sample(index, 1000, -1000))),
      10,
    );
    expect(
      adverse.candidates.map(({ key, condition, discovery }) => ({ key, condition, discovery })),
    ).toEqual(
      report.candidates.map(({ key, condition, discovery }) => ({ key, condition, discovery })),
    );
    expect(adverse.candidates[0].validated).toBe(false);
  });

  test('keeps ties together and reports periods with no exact closes', () => {
    const tied = study(Array.from({ length: 48 }, (_, index) => sample(index, 1, 0)));
    expect(tied.candidates.map(({ key }) => key)).toEqual(['entryCredit-low']);
    expect(tied.candidates[0].holdout).toMatchObject({ n: 15, winRate: 0 });
    const empty = study([sample(0, 3, null)]);
    expect(empty.candidates).toEqual([]);
    expect(empty.discovery).toMatchObject({
      from: null,
      to: null,
      baseline: { n: 0, meanNet: null },
    });
  });
});
