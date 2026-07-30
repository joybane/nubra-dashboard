import { describe, it, expect } from 'vitest';
import {
  FEED_STALE_MS,
  feedKey,
  requiredFeedKeys,
  staleRequiredFeeds,
  isMarketHours,
  isValidFeedKey,
  pruneOcSubKeys,
  istToday,
} from './ocFeedGuard';

const NIFTY_JUL28 = 'NIFTY:20260728';
const NIFTY_AUG04 = 'NIFTY:20260804';

describe('feedKey', () => {
  it('normalises the asset so browser and tick casing agree', () => {
    expect(feedKey('nifty', '20260728')).toBe(NIFTY_JUL28);
    expect(feedKey('NIFTY', '20260728')).toBe(NIFTY_JUL28);
  });
});

describe('requiredFeedKeys', () => {
  it('returns the feeds serving open positions', () => {
    const index = new Map([
      [1445996, NIFTY_JUL28],
      [1446003, NIFTY_JUL28],
      [999, NIFTY_AUG04],
    ]);
    expect(requiredFeedKeys(index, [1445996, 1446003])).toEqual(new Set([NIFTY_JUL28]));
  });

  it('drops feeds whose only positions have closed', () => {
    const index = new Map([
      [1445996, NIFTY_JUL28],
      [999, NIFTY_AUG04],
    ]);
    expect(requiredFeedKeys(index, [999])).toEqual(new Set([NIFTY_AUG04]));
  });

  it('is empty before any tick has been seen, so nothing is pinned on a cold start', () => {
    expect(requiredFeedKeys(new Map(), [1445996])).toEqual(new Set());
  });

  it('ignores open positions whose feed is not yet known', () => {
    const index = new Map([[1445996, NIFTY_JUL28]]);
    expect(requiredFeedKeys(index, [1445996, 4242])).toEqual(new Set([NIFTY_JUL28]));
  });
});

describe('staleRequiredFeeds', () => {
  const now = 1_800_000_000_000;

  it('leaves a live feed alone', () => {
    const last = new Map([[NIFTY_JUL28, now - 1_000]]);
    expect(staleRequiredFeeds(new Set([NIFTY_JUL28]), last, now)).toEqual([]);
  });

  it('flags the real failure: subscribed on paper, silent for 448s', () => {
    const last = new Map([
      [NIFTY_JUL28, now - 448_000],
      [NIFTY_AUG04, now - 500],
    ]);
    const required = new Set([NIFTY_JUL28, NIFTY_AUG04]);
    expect(staleRequiredFeeds(required, last, now)).toEqual([NIFTY_JUL28]);
  });

  it('treats a never-seen feed as stale', () => {
    expect(staleRequiredFeeds(new Set([NIFTY_JUL28]), new Map(), now)).toEqual([NIFTY_JUL28]);
  });

  it('uses an inclusive threshold', () => {
    const at = new Map([[NIFTY_JUL28, now - FEED_STALE_MS]]);
    const just = new Map([[NIFTY_JUL28, now - FEED_STALE_MS + 1]]);
    expect(staleRequiredFeeds(new Set([NIFTY_JUL28]), at, now)).toEqual([NIFTY_JUL28]);
    expect(staleRequiredFeeds(new Set([NIFTY_JUL28]), just, now)).toEqual([]);
  });

  it('never reports a stale feed that no open position needs', () => {
    const last = new Map([[NIFTY_AUG04, now - 999_000]]);
    expect(staleRequiredFeeds(new Set(), last, now)).toEqual([]);
  });
});

describe('isValidFeedKey', () => {
  it('accepts real asset:expiry keys', () => {
    expect(isValidFeedKey(NIFTY_JUL28)).toBe(true);
    expect(isValidFeedKey('M&MFIN:20260728')).toBe(true);
    expect(isValidFeedKey('NIFTY50:20260728')).toBe(true);
  });

  it('rejects the malformed keys found in the live DB', () => {
    expect(isValidFeedKey('NIFTY28JUL2623,700CE:20260728')).toBe(false); // comma
    expect(isValidFeedKey('NIFTY:2026072')).toBe(false); // 7-digit expiry
    expect(isValidFeedKey('NIFTY')).toBe(false); // no expiry
    expect(isValidFeedKey('NIFTY:20260728:NSE')).toBe(false); // extra segment
    expect(isValidFeedKey('nifty:20260728')).toBe(false); // not normalised
  });
});

describe('pruneOcSubKeys', () => {
  const base = { liveAssets: new Set(['NIFTY']), todayIst: '20260727', pinned: new Set<string>() };

  it('keeps a live asset with a future expiry', () => {
    const { keep, drop } = pruneOcSubKeys([NIFTY_JUL28, NIFTY_AUG04], base);
    expect(keep).toEqual([NIFTY_JUL28, NIFTY_AUG04]);
    expect(drop).toEqual([]);
  });

  it('keeps expiry day itself — the busiest session of the contract', () => {
    const { keep } = pruneOcSubKeys(['NIFTY:20260727'], base);
    expect(keep).toEqual(['NIFTY:20260727']);
  });

  it('drops expired, malformed, and unheld-asset keys with a reason each', () => {
    const { keep, drop } = pruneOcSubKeys(
      [NIFTY_JUL28, 'NIFTY:20260623', 'NIFTY28JUL2623,700CE:20260728', 'SENSEX:20260930'],
      base,
    );
    expect(keep).toEqual([NIFTY_JUL28]);
    expect(drop).toEqual([
      { key: 'NIFTY:20260623', reason: 'expired' },
      { key: 'NIFTY28JUL2623,700CE:20260728', reason: 'malformed' },
      { key: 'SENSEX:20260930', reason: 'no open position or order' },
    ]);
  });

  it('never drops a pinned feed, even an expired or malformed one', () => {
    const pinned = new Set(['NIFTY:20260623']);
    const { keep, drop } = pruneOcSubKeys(['NIFTY:20260623'], { ...base, pinned });
    expect(keep).toEqual(['NIFTY:20260623']);
    expect(drop).toEqual([]);
  });

  it('prunes everything once the last position and order are gone', () => {
    const empty = { ...base, liveAssets: new Set<string>() };
    const { keep, drop } = pruneOcSubKeys([NIFTY_JUL28, NIFTY_AUG04], empty);
    expect(keep).toEqual([]);
    expect(drop).toHaveLength(2);
  });
});

describe('istToday', () => {
  it('uses the IST calendar date, not UTC', () => {
    // 19:30 UTC on the 26th is already 01:00 IST on the 27th.
    expect(istToday(Date.parse('2026-07-26T19:30:00Z'))).toBe('20260727');
    expect(istToday(Date.parse('2026-07-26T18:29:00Z'))).toBe('20260726');
  });
});

describe('isMarketHours', () => {
  // 2026-07-27 is a Monday; 2026-07-25 a Saturday.
  const ist = (d: string, hhmm: string) => Date.parse(`${d}T${hhmm}:00+05:30`);

  it('is open through the session', () => {
    expect(isMarketHours(ist('2026-07-27', '09:15'))).toBe(true);
    expect(isMarketHours(ist('2026-07-27', '12:00'))).toBe(true);
    expect(isMarketHours(ist('2026-07-27', '15:30'))).toBe(true);
  });

  it('is closed outside it', () => {
    expect(isMarketHours(ist('2026-07-27', '09:14'))).toBe(false);
    expect(isMarketHours(ist('2026-07-27', '15:31'))).toBe(false);
    expect(isMarketHours(ist('2026-07-27', '03:00'))).toBe(false);
  });

  it('is closed at the weekend', () => {
    expect(isMarketHours(ist('2026-07-25', '12:00'))).toBe(false);
    expect(isMarketHours(ist('2026-07-26', '12:00'))).toBe(false);
  });
});
