import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainSnapshot } from './greekAggregator';
import {
  buildGreekHistory,
  getGreekHistory,
  greekHistoryEntryCount,
  invalidateGreekHistory,
  STALE_TODAY_MS,
  type GreekHistoryKey,
} from './greekHistoryCache';

const TODAY = '2026-08-17';
const PAST = '2026-08-11';

const key = (over: Partial<GreekHistoryKey> = {}): GreekHistoryKey => ({
  exchange: 'NSE',
  asset: 'NIFTY',
  expiries: ['20260818'],
  day: PAST,
  windowDays: 7,
  withIv: false,
  ...over,
});

const snaps = (ts: number): Map<number, ChainSnapshot> => new Map([[ts, { ts, ce: [], pe: [] }]]);

const value = (ts = 1, dropped = 0) => ({ snapshots: snaps(ts), dropped });

afterEach(() => {
  invalidateGreekHistory();
  vi.useRealTimers();
});

describe('greekHistoryCache', () => {
  it('serves a built reconstruction back without rebuilding it', async () => {
    const build = vi.fn(async () => value(1));
    await buildGreekHistory(key(), build);

    const hit = getGreekHistory(key(), TODAY);
    expect(hit?.snapshots.has(1)).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('misses on a different day, expiry set, window or exchange', async () => {
    await buildGreekHistory(key(), async () => value(1));

    expect(getGreekHistory(key({ day: '2026-08-10' }), TODAY)).toBeNull();
    expect(getGreekHistory(key({ expiries: ['20260825'] }), TODAY)).toBeNull();
    expect(getGreekHistory(key({ windowDays: 1 }), TODAY)).toBeNull();
    expect(getGreekHistory(key({ exchange: 'MCX' }), TODAY)).toBeNull();
  });

  it('is insensitive to the order the expiries are listed in', async () => {
    await buildGreekHistory(key({ expiries: ['20260818', '20260825'] }), async () => value(1));
    expect(getGreekHistory(key({ expiries: ['20260825', '20260818'] }), TODAY)).not.toBeNull();
  });

  it('coalesces concurrent builds of the same key into one', async () => {
    // Vega and Theta enabling within a moment of each other: the second must join the first's
    // reconstruction, not launch a second set of history calls.
    const build = vi.fn(
      () => new Promise<ReturnType<typeof value>>((res) => setTimeout(() => res(value(1)), 5)),
    );
    const [a, b] = await Promise.all([
      buildGreekHistory(key(), build),
      buildGreekHistory(key(), build),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(a.snapshots).toBe(b.snapshots); // the same map, by reference
  });

  it('lets Vega/Theta reuse the IV variant but never the other way round', async () => {
    // Solving IV only ADDS a field to otherwise identical legs, so the richer map answers the
    // poorer question exactly. The reverse would hand the IV overlay legs with no iv on them.
    await buildGreekHistory(key({ withIv: true }), async () => value(1));

    expect(getGreekHistory(key({ withIv: false }), TODAY)).not.toBeNull();

    invalidateGreekHistory();
    await buildGreekHistory(key({ withIv: false }), async () => value(1));
    expect(getGreekHistory(key({ withIv: true }), TODAY)).toBeNull();
  });

  it('does not cache a failed reconstruction', async () => {
    await expect(
      buildGreekHistory(key(), async () => {
        throw new Error('history fetch failed');
      }),
    ).rejects.toThrow();

    expect(getGreekHistory(key(), TODAY)).toBeNull();
    // …and the next attempt is free to run rather than being stuck behind the failure.
    const build = vi.fn(async () => value(1));
    await buildGreekHistory(key(), build);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it("expires today's entry after a minute and a past day's after half an hour", async () => {
    vi.useFakeTimers();
    await buildGreekHistory(key({ day: TODAY }), async () => value(1));
    await buildGreekHistory(key({ day: PAST }), async () => value(2));

    vi.advanceTimersByTime(61_000);
    expect(getGreekHistory(key({ day: TODAY }), TODAY)).toBeNull();
    expect(getGreekHistory(key({ day: PAST }), TODAY)).not.toBeNull();

    vi.advanceTimersByTime(30 * 60_000);
    expect(getGreekHistory(key({ day: PAST }), TODAY)).toBeNull();
  });

  it("reports a today hit's age so the caller can top up its tail", async () => {
    vi.useFakeTimers();
    await buildGreekHistory(key({ day: TODAY }), async () => value(1));

    expect(getGreekHistory(key({ day: TODAY }), TODAY)!.age).toBeLessThan(STALE_TODAY_MS);
    vi.advanceTimersByTime(STALE_TODAY_MS + 1);
    expect(getGreekHistory(key({ day: TODAY }), TODAY)!.age).toBeGreaterThan(STALE_TODAY_MS);
  });

  it('evicts least-recently-used past the bound rather than growing without limit', async () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07'];
    for (const day of days) await buildGreekHistory(key({ day }), async () => value(1));

    expect(greekHistoryEntryCount()).toBe(4);
    expect(getGreekHistory(key({ day: days[0] }), TODAY)).toBeNull();
    expect(getGreekHistory(key({ day: days[4] }), TODAY)).not.toBeNull();
  });

  it('a read counts as a use, so the entry being read is not the one evicted', async () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
    for (const day of days) await buildGreekHistory(key({ day }), async () => value(1));

    getGreekHistory(key({ day: days[0] }), TODAY); // oldest by write, newest by use
    await buildGreekHistory(key({ day: '2026-08-07' }), async () => value(1));

    expect(getGreekHistory(key({ day: days[0] }), TODAY)).not.toBeNull();
    expect(getGreekHistory(key({ day: days[1] }), TODAY)).toBeNull();
  });
});
