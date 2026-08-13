/**
 * Per-date instrument master for the historical backtest routes.
 *
 * This is deliberately separate from refdataCache.ts. That cache is keyed by *today* and rolls
 * over at midnight, because every other consumer only ever wants the live instrument master. The
 * backtest asks for an arbitrary past date, so it needs its own keying — but it had grown its own
 * plain `Map` with none of the properties refdataCache.ts exists to provide, which is exactly what
 * that file's header warns against.
 *
 * The numbers that shape this, measured against the live broker: one exchange's master is ~34 MB
 * of JSON, and a cold `/refdata/refdata/<date>` takes 40–45 s. The budget for that endpoint is
 * 45 s (upstreamError.ts), so a cold date sits right on the edge of failing outright. A warm one
 * answers in ~700 ms. Everything here is about paying that 40 s as rarely as possible:
 *
 * 1. **Single-flight.** The pane's chain effect can fire more than once for a single user action.
 *    The previous cache recorded only *settled* values, so every concurrent miss started its own
 *    40 s download of the same 34 MB.
 * 2. **Today is delegated to the shared day cache.** It is the same endpoint with the same
 *    parameters, and the server already warms it at boot — so the pane's default view (today)
 *    should cost nothing rather than downloading a second copy and holding it twice in memory.
 * 3. **Past dates persist to disk, gzipped.** A past date's instrument master is immutable, so
 *    the 40 s is paid once ever instead of once per server restart. Today's is never written:
 *    instruments can be listed intraday, and the shared cache already owns that freshness rule.
 *
 * Failures return `[]` rather than throwing, which is the contract the routes were already built
 * around — they turn an empty array into "Could not fetch option refdata for <date>."
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;

export interface BacktestRefdataStoreDeps {
  nubraGet: NubraGet;
  /** The app-wide day cache. When supplied, requests for `sharedDay()` are served from it. */
  getSharedRefdata?: (exchange: string) => Promise<Record<string, unknown>[]>;
  /** The day `getSharedRefdata` currently holds, as YYYY-MM-DD. */
  sharedDay?: () => string;
  /** Absolute directory for the on-disk copies. Omit to keep everything in memory. */
  cacheDir?: string;
  /** Injectable clock, for testing. */
  now?: () => number;
  /** Dates held in memory at once. Each is ~34 MB, so this is a memory ceiling, not a tuning knob. */
  maxResident?: number;
  /** Files kept on disk before the least recently used are dropped. */
  maxFiles?: number;
}

export interface BacktestRefdataStore {
  getRefdataForDate(exchange: string, date: string): Promise<Record<string, unknown>[]>;
}

/**
 * `date` reaches here straight from a query string and becomes part of a filename, so anything
 * that is not exactly an exchange code and an ISO date stays out of the cache directory entirely.
 * Such a request still works — it just goes upstream every time.
 */
const SAFE_KEY = /^[A-Z]{2,6}_\d{4}-\d{2}-\d{2}$/;

export function createBacktestRefdataStore({
  nubraGet,
  getSharedRefdata,
  sharedDay,
  cacheDir,
  now = Date.now,
  maxResident = 6,
  maxFiles = 60,
}: BacktestRefdataStoreDeps): BacktestRefdataStore {
  /** Insertion-ordered, so the first key is the least recently used. */
  const resident = new Map<string, Record<string, unknown>[]>();
  const inFlight = new Map<string, Promise<Record<string, unknown>[]>>();

  function remember(key: string, arr: Record<string, unknown>[]): void {
    resident.delete(key);
    resident.set(key, arr);
    while (resident.size > maxResident) {
      const oldest = resident.keys().next().value as string;
      resident.delete(oldest);
    }
  }

  function fileFor(key: string): string | null {
    if (!cacheDir || !SAFE_KEY.test(key)) return null;
    return path.join(cacheDir, `${key}.json.gz`);
  }

  async function readDisk(key: string): Promise<Record<string, unknown>[] | null> {
    const file = fileFor(key);
    if (!file) return null;
    try {
      const arr = JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8')) as
        Record<string, unknown>[] | unknown;
      if (!Array.isArray(arr) || arr.length === 0) return null;
      // Refresh mtime so pruning treats this as recently used rather than merely recently written.
      await fs.utimes(file, new Date(), new Date()).catch(() => {});
      return arr as Record<string, unknown>[];
    } catch (err) {
      // A missing file is the ordinary miss. Anything else means it is unreadable or truncated —
      // drop it, so the next miss re-downloads instead of failing on it forever.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[backtest refdata] discarding unreadable cache file ${key}:`, err);
        await fs.unlink(file).catch(() => {});
      }
      return null;
    }
  }

  async function prune(): Promise<void> {
    if (!cacheDir) return;
    const names = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.json.gz'));
    if (names.length <= maxFiles) return;
    const stated = await Promise.all(
      names.map(async (name) => ({
        name,
        mtime: await fs
          .stat(path.join(cacheDir, name))
          .then((s) => s.mtimeMs)
          .catch(() => 0),
      })),
    );
    stated.sort((a, b) => b.mtime - a.mtime);
    for (const entry of stated.slice(maxFiles)) {
      await fs.unlink(path.join(cacheDir, entry.name)).catch(() => {});
    }
  }

  async function writeDisk(key: string, arr: Record<string, unknown>[]): Promise<void> {
    const file = fileFor(key);
    if (!file) return;
    // Same-directory temp file plus rename, so a process killed mid-write can never leave a
    // truncated file that a later run would read as a valid cache hit.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(cacheDir!, { recursive: true });
      await fs.writeFile(tmp, await gzipAsync(Buffer.from(JSON.stringify(arr), 'utf8')));
      await fs.rename(tmp, file);
      await prune();
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      console.warn(`[backtest refdata] could not persist ${key}:`, err);
    }
  }

  /** Past dates only. Instruments can be listed intraday, so today's snapshot is not durable. */
  function isImmutable(date: string): boolean {
    const today = sharedDay?.() ?? new Date(now()).toISOString().slice(0, 10);
    return date < today; // YYYY-MM-DD compares correctly as a string
  }

  async function load(exchange: string, date: string, key: string) {
    const cached = await readDisk(key);
    if (cached) {
      remember(key, cached);
      return cached;
    }
    try {
      const startedAt = now();
      const raw = await nubraGet(`/refdata/refdata/${date}`, { exchange });
      const arr = Array.isArray(raw.refdata) ? (raw.refdata as Record<string, unknown>[]) : [];
      // An empty result is not cached: it is either a non-trading date or a shape we failed to
      // recognise, and memoising it would pin that answer for the life of the process.
      if (arr.length === 0) return [];
      console.log(
        `[backtest refdata] ${exchange} ${date}: ${arr.length} instruments in ${now() - startedAt}ms`,
      );
      remember(key, arr);
      // Not awaited — the caller has what it needs, and the response should not wait on gzip.
      if (isImmutable(date)) void writeDisk(key, arr);
      return arr;
    } catch (e) {
      console.error(`Failed to fetch refdata for date ${date}:`, e);
      return [];
    }
  }

  function getRefdataForDate(exchange: string, date: string): Promise<Record<string, unknown>[]> {
    // Today's master is the one the rest of the app already keeps warm, from the same endpoint
    // with the same parameters. Downloading a second 34 MB copy just to key it by date would
    // double both the wait and the memory for this pane's default view.
    if (getSharedRefdata && sharedDay?.() === date) {
      return getSharedRefdata(exchange).catch((e: unknown) => {
        console.error(`Failed to fetch refdata for date ${date}:`, e);
        return [];
      });
    }

    const key = `${exchange}_${date}`;
    const hit = resident.get(key);
    if (hit) {
      remember(key, hit);
      return Promise.resolve(hit);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    const started = load(exchange, date, key);
    inFlight.set(key, started);
    void started.finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    });
    return started;
  }

  return { getRefdataForDate };
}
