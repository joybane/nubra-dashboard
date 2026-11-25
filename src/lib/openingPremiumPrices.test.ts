import { describe, expect, it } from 'vitest';
import { matchOpeningPremiumPrices, type ArchivedOpeningPrices } from './openingPremiumPrices';
import {
  OPENING_SESSION_MINUTES,
  type OpeningDaySummary,
  type OpeningGrid,
} from './openingStrangle';

const replay = {
  date: '2026-02-03',
  expiry: '2026-02-03',
  source: 'nubra',
  entry: 2,
  ceStrike: 25000,
  peStrike: 24800,
  ceEntry: 152.2,
  peEntry: 225.4,
} satisfies Pick<
  OpeningDaySummary,
  'date' | 'expiry' | 'source' | 'entry' | 'ceStrike' | 'peStrike' | 'ceEntry' | 'peEntry'
>;

function archivedPrices(): ArchivedOpeningPrices {
  const ce: OpeningGrid = Array(OPENING_SESSION_MINUTES).fill(null);
  const pe: OpeningGrid = Array(OPENING_SESSION_MINUTES).fill(null);
  ce[2] = replay.ceEntry;
  pe[2] = replay.peEntry;
  ce[3] = 0;
  pe[4] = 20;
  return {
    ok: true,
    underlying: 'NIFTY',
    date: replay.date,
    source: replay.source,
    expiry: replay.expiry,
    legs: { entryTime: '09:17', ceStrike: replay.ceStrike, peStrike: replay.peStrike },
    ce,
    pe,
  };
}

describe('Opening OTM 2 premium plots', () => {
  it('keeps zero quotes and independent leg gaps in the matched archive', () => {
    const archive = archivedPrices();
    const prices = matchOpeningPremiumPrices(archive, 'NIFTY', replay);
    expect(prices?.call.slice(2, 5)).toEqual([152.2, 0, null]);
    expect(prices?.put.slice(2, 5)).toEqual([225.4, null, 20]);
  });

  it('rejects stale dates, other sources, and different replay contracts or entry times', () => {
    const archive = archivedPrices();
    const mismatches: Partial<ArchivedOpeningPrices>[] = [
      { date: '2026-02-04' },
      { underlying: 'SENSEX' },
      { source: 'local' },
      { expiry: '2026-02-10' },
      { legs: { ...archive.legs, ceStrike: 25050 } },
      { legs: { ...archive.legs, peStrike: 24850 } },
      { legs: { ...archive.legs, entryTime: '09:15' } },
    ];
    for (const mismatch of mismatches) {
      expect(
        matchOpeningPremiumPrices({ ...archive, ...mismatch }, 'NIFTY', replay),
      ).toBeUndefined();
    }
  });

  it('rejects incomplete response grids and inconsistent entry prices', () => {
    const archive = archivedPrices();
    expect(matchOpeningPremiumPrices({ ...archive, pe: [] }, 'NIFTY', replay)).toBeUndefined();
    archive.ce[replay.entry] = 160;
    expect(matchOpeningPremiumPrices(archive, 'NIFTY', replay)).toBeUndefined();
  });
});
