/**
 * Which option-chain feeds the *server* must keep alive, regardless of what any
 * browser pane happens to be showing.
 *
 * `position_ltp` — the only live P&L source the Positions tab has — and every
 * SL/target/trailing rule are derived from `option_chain` ticks in
 * `routeTickToSim`. So an open position's feed going silent is not cosmetic:
 * P&L freezes *and* stop-losses stop being evaluated.
 *
 * That is exactly what happened. Browser option-chain subscriptions are
 * reference counted client-side (see `src/lib/ocSubRegistry.ts`), and when the
 * last pane showing NIFTY/20260728 closed, the server relayed a
 * `batch_unsubscribe` upstream — killing the feed for two open positions on
 * that expiry. `simOcSubs` still listed the key, so `/paper/debug` reported it
 * as subscribed while nothing arrived for 7½ minutes.
 *
 * This module holds the two decisions that prevent it, kept pure so they are
 * testable without a socket or a clock: which feeds are load bearing, and which
 * of those have gone quiet and need re-arming.
 */

/** A feed is considered dead once no tick has arrived for this long. */
export const FEED_STALE_MS = 45_000;

/**
 * `ref_id → "ASSET:EXPIRY"`, learned from the ticks themselves rather than
 * parsed out of instrument names — `NIFTY26JUL23850PE` does not contain the
 * weekly expiry (20260728) it actually trades on, so name parsing cannot work.
 */
export type FeedIndex = Map<number, string>;

export function feedKey(asset: string, expiry: string): string {
  return `${asset.toUpperCase()}:${expiry}`;
}

/** The feeds serving at least one currently-open position. */
export function requiredFeedKeys(index: FeedIndex, openRefIds: Iterable<number>): Set<string> {
  const required = new Set<string>();
  for (const refId of openRefIds) {
    const key = index.get(refId);
    if (key) required.add(key);
  }
  return required;
}

/**
 * Required feeds with no tick inside `staleMs`. A required feed we have *never*
 * seen a tick for counts as stale too — that is the cold case where the
 * subscription was dropped before it ever delivered anything.
 */
export function staleRequiredFeeds(
  required: Set<string>,
  lastTick: Map<string, number>,
  now: number,
  staleMs: number = FEED_STALE_MS,
): string[] {
  const stale: string[] = [];
  for (const key of required) {
    const last = lastTick.get(key);
    if (last === undefined || now - last >= staleMs) stale.push(key);
  }
  return stale.sort();
}

/**
 * `simOcSubs` is the *persisted* record of feeds the server needs, and it only
 * ever grew: every chain a browser opened was written to it permanently, and
 * `subscribeForSim` occasionally wrote a whole instrument name where an asset
 * belonged (`NIFTY28JUL2623,700CE:20260728`). Left alone it re-subscribes dozens
 * of dead and malformed feeds on every upstream reconnect.
 */
export function isValidFeedKey(key: string): boolean {
  const parts = key.split(':');
  if (parts.length !== 2) return false;
  const [asset, expiry] = parts;
  return /^[A-Z][A-Z0-9&-]*$/.test(asset) && /^\d{8}$/.test(expiry);
}

export interface PruneOpts {
  /** Assets with an open position or a live order — the only ones worth holding. */
  liveAssets: Set<string>;
  /** Today in IST as YYYYMMDD. Expiry day itself is the busiest, so it is kept. */
  todayIst: string;
  /** Feeds known to serve an open position. Kept unconditionally. */
  pinned: Set<string>;
}

export function pruneOcSubKeys(
  keys: Iterable<string>,
  { liveAssets, todayIst, pinned }: PruneOpts,
): { keep: string[]; drop: Array<{ key: string; reason: string }> } {
  const keep: string[] = [];
  const drop: Array<{ key: string; reason: string }> = [];
  for (const key of keys) {
    if (pinned.has(key))            { keep.push(key); continue; }
    if (!isValidFeedKey(key))       { drop.push({ key, reason: 'malformed' }); continue; }
    const [asset, expiry] = key.split(':');
    if (expiry < todayIst)          { drop.push({ key, reason: 'expired' }); continue; }
    if (!liveAssets.has(asset))     { drop.push({ key, reason: 'no open position or order' }); continue; }
    keep.push(key);
  }
  return { keep, drop };
}

/** Today in IST as YYYYMMDD, the form expiries are keyed by. */
export function istToday(nowMs: number): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * NSE equity-derivatives session, Mon–Fri 09:15–15:30 IST. Outside it a silent
 * feed is expected, so the watchdog must not re-subscribe (or log) all night.
 */
export function isMarketHours(nowMs: number): boolean {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}
