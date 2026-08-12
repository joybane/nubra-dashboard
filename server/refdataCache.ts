/**
 * Day-scoped cache of the Nubra instrument master, one entry per exchange.
 *
 * Three properties matter here, and the previous plain-value cache had none of them:
 *
 * 1. Single-flight. The payload is a ~100k-record, multi-megabyte download. Two InstrumentSearch
 *    components mount on page load and each ask for NSE, BSE and MCX, so a cold cache used to
 *    kick off six simultaneous copies of the same download. Caching the PROMISE means a second
 *    caller arriving mid-flight joins the first request instead of starting another.
 *
 * 2. Rejections are evicted, not memoized. Caching a transient failure would block every
 *    subsequent attempt behind it for the rest of the day. (server/backtest/dataLayer.ts and
 *    ivHistory.ts both have this bug — do not copy them. src/lib/sharedRequest.ts is the model.)
 *
 * 3. Empty results are evicted too. The shape detection below falls through to [] for anything
 *    unexpected, and an empty array cached for the day means search silently returns nothing
 *    until the process restarts.
 */

type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface RefdataCacheDeps {
  nubraGet: NubraGet;
  /** Injectable clock, for testing the day rollover. */
  now?: () => number;
}

export interface RefdataCache {
  getRefdata(exchange: string): Promise<Record<string, unknown>[]>;
  /** Synchronous cache read; null when this exchange has not been downloaded yet today. */
  peekRefdata(exchange: string): Record<string, unknown>[] | null;
}

/** Unchanged from the original inline implementation — the upstream shape varies by deployment. */
function extractRefdata(raw: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(raw.refdata)
    ? (raw.refdata as Record<string, unknown>[])
    : Array.isArray(raw.data)
      ? (raw.data as Record<string, unknown>[])
      : Array.isArray(raw)
        ? (raw as unknown as Record<string, unknown>[])
        : [];
}

export function createRefdataCache({ nubraGet, now = Date.now }: RefdataCacheDeps): RefdataCache {
  const inFlight = new Map<string, Promise<Record<string, unknown>[]>>();
  const settled = new Map<string, Record<string, unknown>[]>();
  let cacheDay = '';

  // The same date string is both the cache key and the upstream URL segment, so it must stay UTC
  // to match what the API expects.
  function currentDay(): string {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (cacheDay !== today) {
      inFlight.clear();
      settled.clear();
      cacheDay = today;
    }
    return today;
  }

  function peekRefdata(exchange: string): Record<string, unknown>[] | null {
    currentDay();
    return settled.get(exchange) ?? null;
  }

  function getRefdata(exchange: string): Promise<Record<string, unknown>[]> {
    const today = currentDay();

    const hit = inFlight.get(exchange);
    if (hit) return hit;

    const startedAt = now();
    const pending = (async () => {
      const raw = await nubraGet(`/refdata/refdata/${today}`, { exchange });
      const arr = extractRefdata(raw);
      console.log(`[Refdata] ${exchange}: ${arr.length} instruments in ${now() - startedAt}ms`);
      return arr;
    })();

    inFlight.set(exchange, pending);
    pending.then(
      (arr) => {
        // Only act if we are still the current entry — a later call may have replaced us.
        if (inFlight.get(exchange) !== pending) return;
        if (arr.length === 0) inFlight.delete(exchange);
        else settled.set(exchange, arr);
      },
      () => {
        if (inFlight.get(exchange) === pending) inFlight.delete(exchange);
      },
    );

    return pending;
  }

  return { getRefdata, peekRefdata };
}
