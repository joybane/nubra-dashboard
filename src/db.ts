// IndexedDB caching for Nubra refdata
// Keyed by exchange + date so it auto-invalidates daily

import { sharedJson } from './lib/sharedRequest';

/** In-memory coalescing window; the IndexedDB entry below is what actually caches for the day. */
const REFDATA_SHARE_TTL_MS = 5 * 60_000;

const DB_NAME = 'nubra_dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'cache';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = (e) => resolve((e.target as IDBRequest).result as T);
        req.onerror = (e) => reject((e.target as IDBRequest).error);
      }),
  );
}

function dbSet(key: string, value: unknown): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject((e.target as IDBRequest).error);
      }),
  );
}

// ─── Refdata cache ────────────────────────────────────────────────────────────
function refdataKey(exchange: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `refdata_${exchange}_${today}`;
}

/**
 * An empty entry counts as a MISS, not a hit.
 *
 * A failed /api/refdata call used to be written here as `[]`, and because an empty array is
 * truthy it read back as a valid cache hit — so one transient server error silently emptied
 * search for the rest of the day, and no amount of restarting the server fixed it. Treating
 * empty as absent also un-poisons browsers that already have such an entry stored.
 */
export async function getCachedRefdata(exchange: string): Promise<unknown[] | null> {
  try {
    const key = refdataKey(exchange);
    const cached = await dbGet<{ items: unknown[] }>(key);
    if (Array.isArray(cached?.items) && cached.items.length > 0) return cached.items;
    return null;
  } catch {
    return null;
  }
}

export async function setCachedRefdata(exchange: string, items: unknown[]): Promise<void> {
  // Never persist an empty instrument list — see getCachedRefdata.
  if (!Array.isArray(items) || items.length === 0) return;
  try {
    const key = refdataKey(exchange);
    await dbSet(key, { items, ts: Date.now() });
  } catch {
    /* non-critical */
  }
}

// ─── Fetch refdata with cache ─────────────────────────────────────────────────
export async function fetchRefdata(exchange: string): Promise<unknown[]> {
  // Two InstrumentSearch instances mount at once and each asks for all three exchanges;
  // sharedJson collapses the duplicates into one request per exchange.
  return sharedJson(`refdata:${exchange}`, REFDATA_SHARE_TTL_MS, async () => {
    const cached = await getCachedRefdata(exchange);
    if (cached) return cached;

    const res = await fetch(`/api/refdata?exchange=${exchange}`);
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // Surface the failure instead of laundering it into an empty list. The caller
    // (InstrumentSearch) already catches this and falls back to server-side search.
    if (!res.ok) {
      throw new Error(String(data.error || `refdata ${exchange}: HTTP ${res.status}`));
    }
    const arr = Array.isArray(data.refdata)
      ? data.refdata
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];

    await setCachedRefdata(exchange, arr);
    return arr;
  });
}
