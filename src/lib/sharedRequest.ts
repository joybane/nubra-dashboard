/**
 * Coalesces identical in-flight requests and serves a short-lived result cache.
 *
 * Several independent consumers ask the server for exactly the same thing at nearly the same
 * moment — most sharply the greek overlays, where Vega, Theta and IV are separate hook
 * instances that each fetch the option chain, poll it every 4 s, and pull the same historical
 * window. WebSocket subscriptions are already de-duplicated by refcount (see ocSubRegistry);
 * the REST paths were not, so N overlays meant N identical requests.
 *
 * Keyed on the caller-supplied key, NOT on the response, so it stays agnostic about payloads.
 * The cached value is the PROMISE, which is what makes coalescing work: a second caller
 * arriving mid-flight joins the first request rather than starting another.
 *
 * Rejections are evicted immediately — caching a transient failure for the whole TTL would
 * block every retry behind it.
 *
 * Consumers must treat resolved values as READ-ONLY; they are shared by reference.
 */

interface Entry {
  at: number;
  promise: Promise<unknown>;
}

const entries = new Map<string, Entry>();

export function sharedJson<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;

  const promise = run();
  const entry: Entry = { at: Date.now(), promise };
  entries.set(key, entry);

  promise.catch(() => {
    // Only evict if we are still the current entry — a later call may have replaced us.
    if (entries.get(key) === entry) entries.delete(key);
  });

  return promise;
}

/** Drop a single key, or everything when called with no argument. Used by tests and teardown. */
export function invalidateShared(key?: string): void {
  if (key == null) entries.clear();
  else entries.delete(key);
}

/** Number of live entries — test/diagnostic use only. */
export function sharedEntryCount(): number {
  return entries.size;
}
