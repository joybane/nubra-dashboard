/**
 * Cache for the reconstructed greek history — the pivoted `Map<ts, ChainSnapshot>` a day's worth
 * of option timeseries turns into, not the HTTP bodies it was built from.
 *
 * `sharedRequest` already de-duplicates the fetches, and it is not enough for two reasons:
 *
 *  1. Its TTL is 15 s and its value is the raw payload. Every consumer still runs the whole pivot
 *     over it — and Vega, Theta and IV are three independent hook instances doing exactly that,
 *     over the same bytes, into three private maps.
 *  2. Both live in component state. A hook's `snapshotsRef` dies with its component, so leaving the
 *     Chart pane and coming back meant re-fetching ~10-20 batched history calls and re-pivoting
 *     them from scratch — the pause the user sees on every re-enable.
 *
 * A module lives as long as the tab, so parking the finished map here survives unmount. This is
 * ordinary heap memory: nothing is written to localStorage, IndexedDB or the server, and a page
 * reload starts empty.
 *
 * The stored map and the snapshots inside it are READ-ONLY and shared by reference. That is safe
 * because nothing mutates a `ChainSnapshot` in place — `storeSnapshot` and `mergeLegSide` build
 * replacements — and callers copy the entries they intend to own into their own map.
 */

import type { ChainSnapshot } from './greekAggregator';

/** Everything a reconstruction's output depends on. */
export interface GreekHistoryKey {
  exchange: string;
  asset: string;
  expiries: string[];
  /** The reconstructed day, 'YYYY-MM-DD'. */
  day: string;
  /** Trailing window in days — hosts reviewing one session pass 1, the Chart/Tracker 7. */
  windowDays: number;
  /**
   * Whether IV was solved per point.
   *
   * The IV overlay inverts an implied vol for every leg it keeps; Vega and Theta never read that
   * field and do not pay for it. The two therefore produce genuinely different snapshots and
   * cannot share an entry — except one way round, see `getGreekHistory`.
   */
  withIv: boolean;
}

export interface GreekHistoryValue {
  snapshots: Map<number, ChainSnapshot>;
  /** Legs the reconstruction could not price — reported by the caller's status pill. */
  dropped: number;
}

interface Entry extends GreekHistoryValue {
  at: number;
  withIv: boolean;
}

/**
 * Small on purpose. An entry holds every priced leg of every minute of a session — a few MB after
 * the delta-band prune — and the access pattern is a handful of days at most: today, whatever the
 * picker was last pointed at, and the two `withIv` variants of each.
 */
const MAX_ENTRIES = 4;

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Promise<GreekHistoryValue>>();

function keyOf(k: GreekHistoryKey): string {
  return [
    k.exchange.toUpperCase(),
    k.asset.toUpperCase(),
    [...k.expiries].sort().join(','),
    k.day,
    k.windowDays,
    k.withIv ? 'iv' : 'g',
  ].join('|');
}

/**
 * How long an entry stays usable.
 *
 * A past session is finished — its 1-minute history cannot change, so the only reason to expire it
 * is memory, which `MAX_ENTRIES` already handles. Today's is still being written: the window keeps
 * growing a bar a minute, so it is re-read often enough to pick those up.
 */
function ttlFor(day: string, todayKey: string): number {
  return day === todayKey ? 60_000 : 30 * 60_000;
}

/** Age past which a cached hit for TODAY is worth refreshing behind the caller's back. */
export const STALE_TODAY_MS = 20_000;

function touch(key: string, entry: Entry) {
  // Re-inserting moves the key to the end of the Map's insertion order, which is what makes the
  // eviction below least-recently-USED rather than least-recently-written.
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * A usable entry, or null.
 *
 * `age` lets a caller paint immediately off a hit and still decide the tail is worth refreshing —
 * see `STALE_TODAY_MS`.
 *
 * A Vega/Theta lookup falls back to the IV variant of the same day: solving IV only ADDS a field
 * to legs that are otherwise identical, so the richer map answers the poorer question exactly. The
 * reverse is not true and is never attempted.
 */
export function getGreekHistory(
  k: GreekHistoryKey,
  todayKey: string,
): (GreekHistoryValue & { age: number }) | null {
  const now = Date.now();
  const ttl = ttlFor(k.day, todayKey);

  const tryKey = (key: string): (GreekHistoryValue & { age: number }) | null => {
    const hit = entries.get(key);
    if (!hit) return null;
    const age = now - hit.at;
    if (age >= ttl) {
      entries.delete(key);
      return null;
    }
    touch(key, hit);
    return { snapshots: hit.snapshots, dropped: hit.dropped, age };
  };

  return tryKey(keyOf(k)) ?? (k.withIv ? null : tryKey(keyOf({ ...k, withIv: true })));
}

/**
 * Build once, however many callers ask.
 *
 * The in-flight map is what stops the second and third measure launching their own copy of a
 * reconstruction the first is already running — the same coalescing `sharedJson` does, one level
 * up, where the expensive part is the pivot rather than the transfer.
 *
 * A rejected build is not cached: a transient failure must not block every retry behind it.
 */
export function buildGreekHistory(
  k: GreekHistoryKey,
  run: () => Promise<GreekHistoryValue>,
): Promise<GreekHistoryValue> {
  const key = keyOf(k);
  const running = inFlight.get(key);
  if (running) return running;

  const promise = run()
    .then((value) => {
      touch(key, { ...value, at: Date.now(), withIv: k.withIv });
      return value;
    })
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

/** Drop a single day's entries, or everything. Used by tests and teardown. */
export function invalidateGreekHistory(k?: GreekHistoryKey): void {
  if (!k) {
    entries.clear();
    inFlight.clear();
    return;
  }
  const key = keyOf(k);
  entries.delete(key);
  inFlight.delete(key);
}

/** Number of cached entries — test/diagnostic use only. */
export function greekHistoryEntryCount(): number {
  return entries.size;
}
