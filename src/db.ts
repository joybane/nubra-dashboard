// IndexedDB caching for Nubra refdata
// Keyed by exchange + date so it auto-invalidates daily

const DB_NAME    = 'nubra_dashboard';
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
    req.onerror   = (e) => reject((e.target as IDBOpenDBRequest).error);
  });
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx   = db.transaction(STORE_NAME, 'readonly');
        const req  = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = (e) => resolve((e.target as IDBRequest).result as T);
        req.onerror   = (e) => reject((e.target as IDBRequest).error);
      }),
  );
}

function dbSet(key: string, value: unknown): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx   = db.transaction(STORE_NAME, 'readwrite');
        const req  = tx.objectStore(STORE_NAME).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror   = (e) => reject((e.target as IDBRequest).error);
      }),
  );
}

// ─── Refdata cache ────────────────────────────────────────────────────────────
function refdataKey(exchange: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `refdata_${exchange}_${today}`;
}

export async function getCachedRefdata(exchange: string): Promise<unknown[] | null> {
  try {
    const key    = refdataKey(exchange);
    const cached = await dbGet<{ items: unknown[] }>(key);
    if (cached?.items) return cached.items;
    return null;
  } catch { return null; }
}

export async function setCachedRefdata(exchange: string, items: unknown[]): Promise<void> {
  try {
    const key = refdataKey(exchange);
    await dbSet(key, { items, ts: Date.now() });
  } catch { /* non-critical */ }
}

// ─── Fetch refdata with cache ─────────────────────────────────────────────────
export async function fetchRefdata(exchange: string): Promise<unknown[]> {
  const cached = await getCachedRefdata(exchange);
  if (cached) return cached;

  const res  = await fetch(`/api/refdata?exchange=${exchange}`);
  const data = await res.json() as Record<string, unknown>;
  const arr  = Array.isArray(data.refdata) ? data.refdata :
               Array.isArray(data.data)    ? data.data    :
               Array.isArray(data)         ? data         : [];

  await setCachedRefdata(exchange, arr);
  return arr;
}
