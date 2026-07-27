/**
 * Reference counting for option-chain WebSocket subscriptions.
 *
 * One upstream feed per asset/expiry/exchange is shared by many consumers (the
 * Option Chain tab, the chain embedded in the Basket builder, the basket legs,
 * the OI profile, the greek overlays, the watchlist, strategy analysis). Without
 * counting, the first consumer to unmount sends `unsubscribe_oc` and kills the
 * feed for everyone still on screen — which is how the chain ended up showing
 * prices frozen at page-load values.
 */

export function ocKey(asset: string, expiry: string, exchange: string): string {
  return `${asset.toUpperCase()}|${expiry}|${exchange.toUpperCase()}`;
}

export interface OcSubRegistry {
  /** Returns true on the 0 → 1 transition, i.e. the caller should subscribe upstream. */
  acquire(key: string): boolean;
  /** Returns true on the 1 → 0 transition, i.e. the caller should unsubscribe upstream. */
  release(key: string): boolean;
  /** Every key still wanted by at least one consumer — replayed after a reconnect. */
  active(): string[];
  /** Current holder count for a key (0 when nobody wants it). */
  count(key: string): number;
}

export function createOcSubRegistry(): OcSubRegistry {
  const counts = new Map<string, number>();

  return {
    acquire(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next === 1;
    },

    release(key) {
      const current = counts.get(key) ?? 0;
      // An unbalanced cleanup must never send a stray unsubscribe, and must never
      // drive the count negative — that would make a later acquire miss its 0 → 1.
      if (current <= 0) return false;
      if (current === 1) {
        counts.delete(key);
        return true;
      }
      counts.set(key, current - 1);
      return false;
    },

    active() {
      return [...counts.keys()];
    },

    count(key) {
      return counts.get(key) ?? 0;
    },
  };
}
