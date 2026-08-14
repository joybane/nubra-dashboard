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
 *
 * **The 40 s is not a compression problem, so do not go looking there.** Node's `fetch` already
 * sends `accept-encoding: gzip, deflate` without being asked and decodes the response itself
 * (verified against a local server), and `/refdata/refdata/<date>` takes no filter parameter — the
 * whole master is the only thing on offer. The wait is upstream and there is nothing on this side
 * left to shave off it; the only lever is asking for it less often, which is what everything below
 * is for.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { isPastDate } from './tradingDay.ts';
import { runImmediately, type RefdataPriority, type RefdataSchedule } from './refdataQueue.ts';

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
  /** Dates held in memory at once. See `distil` for why this is no longer a tight memory ceiling. */
  maxResident?: number;
  /** Files kept on disk before the least recently used are dropped. */
  maxFiles?: number;
  /** Serialises downloads against the live cache's. Defaults to running them straight away. */
  schedule?: RefdataSchedule;
}

/**
 * The only fields anything downstream reads out of an instrument record.
 *
 * The first eight are every property the backtest routes actually touch (verified by scanning each
 * access in nubraBacktestRoutes.ts); `ref_id` and `lot_size` are the two identifiers an order needs,
 * kept so placing a trade from a backtest never has to re-download a date.
 *
 * Measured on a real NSE master (80 389 records): 33.9 MB of JSON becomes 17.3 MB, the stored file
 * 1.86 MB becomes 1.06 MB, and one resident date costs ~10 MB of heap. So this is roughly a halving,
 * not the order of magnitude the field count suggests — the fields that survive are the long string
 * ones. It is still what lets the caps below hold a couple of weeks of browsing instead of six days.
 */
export const KEPT_FIELDS = [
  'asset',
  'derivative_type',
  'expiry',
  'strike_price',
  'option_type',
  'stock_name',
  'zanskar_name',
  'symbol',
  'ref_id',
  'lot_size',
] as const;

/**
 * Project a master down to KEPT_FIELDS.
 *
 * Absent fields are left absent rather than set to `undefined`, so a distilled record serialises to
 * the same JSON it would have had if the upstream had only ever sent these keys.
 *
 * Applied on the way in AND on the way out of disk, which is what makes the change backward
 * compatible: a file written before this existed is a full-record array, and projecting it on read
 * yields exactly what a freshly distilled one would. No cached date has to be re-downloaded.
 */
function distil(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const field of KEPT_FIELDS) {
      if (row[field] !== undefined) out[field] = row[field];
    }
    return out;
  });
}

/** A master that was downloaded for `snapshotDate`, being offered as an answer for another date. */
export interface RefdataSnapshot {
  rows: Record<string, unknown>[];
  /** The date this master was actually downloaded for. Equal to the requested date on an exact hit. */
  snapshotDate: string;
}

export interface BacktestRefdataStore {
  getRefdataForDate(exchange: string, date: string): Promise<Record<string, unknown>[]>;
  /**
   * The newest already-cached master for a date at or before `date`, without ever downloading.
   *
   * Exists because the 40 s download is per *date*, and a user browsing a week of dates was paying
   * it once per date for masters that answer each other almost entirely. Measured across the real
   * cached files (7 NSE dates, 03-08 to 13-08): contract names never disagree, and a master from an
   * earlier date is a strict subset of a later one — it can only ever be missing rows, never carry
   * a wrong one.
   *
   * That subset direction is what makes this safe rather than merely convenient. Every row in a
   * master for `snapshotDate` was listed on `snapshotDate`; any of those rows whose expiry is still
   * >= the requested date had therefore not expired yet, so it was listed on the requested date too.
   * Nothing that post-dates the request can leak in. What CAN be missing is a contract listed
   * between the two dates, which is why the caller — not this method — decides whether the answer
   * it derived is trustworthy. See `nbResolveRefdata` in nubraBacktestRoutes.ts.
   *
   * Returns null rather than fetching, so a caller that cannot verify the answer falls through to
   * the ordinary exact path.
   */
  peekRefdataNear(
    exchange: string,
    date: string,
    maxAgeDays: number,
  ): Promise<RefdataSnapshot | null>;
  /**
   * Download a past date to disk ahead of anyone asking for it, without holding it in memory.
   *
   * The Nubra BT pane defaults to the previous trading day, which by definition was never
   * persisted while it was still today — so the first open of each day used to pay the full cold
   * 40-45s download inside the request. Warming to disk turns that into a ~1-2s gunzip on first
   * use while keeping the resident LRU free for the dates a user is actually browsing.
   *
   * Resolves when the copy is on disk (or immediately if it already was). Never rejects.
   */
  prefetchForDate(exchange: string, date: string): Promise<void>;
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
  // Sized from measured figures (see KEPT_FIELDS): a distilled date is ~10 MB resident and ~1 MB on
  // disk. Sixteen resident is therefore about what six undistilled ones used to cost, and 300 files
  // is ~100 dates across all three exchanges for roughly 200-300 MB — the point being that a date
  // you have already opened once never costs the 40 s again, however long ago you opened it.
  maxResident = 16,
  maxFiles = 300,
  schedule = runImmediately,
}: BacktestRefdataStoreDeps): BacktestRefdataStore {
  /** Insertion-ordered, so the first key is the least recently used. */
  const resident = new Map<string, Record<string, unknown>[]>();
  const inFlight = new Map<string, Promise<Record<string, unknown>[]>>();
  /** Disk writes still in progress, so a prefetch can resolve only once the file exists. */
  const pendingWrites = new Map<string, Promise<void>>();

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
      const raw = JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8')) as
        Record<string, unknown>[] | unknown;
      if (!Array.isArray(raw) || raw.length === 0) return null;
      // Files written before distillation existed are full records; projecting on read makes them
      // indistinguishable from new ones, so nothing already cached has to be fetched again.
      const arr = distil(raw as Record<string, unknown>[]);
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

  /** Fire a disk write and keep a handle on it, so prefetchForDate can wait for the file. */
  function scheduleWrite(key: string, arr: Record<string, unknown>[]): void {
    const pending = writeDisk(key, arr).finally(() => {
      if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
    });
    pendingWrites.set(key, pending);
  }

  /** Past dates only. Instruments can be listed intraday, so today's snapshot is not durable. */
  function isImmutable(date: string): boolean {
    return isPastDate(date, sharedDay?.() ?? new Date(now()).toISOString().slice(0, 10));
  }

  /**
   * Fetch a date, from disk if it is there and upstream otherwise.
   *
   * Deliberately does NOT populate the resident LRU — that is the caller's decision, because
   * prefetchForDate wants the disk copy without the memory cost. Callers that do want it resident
   * call `remember` on the result.
   */
  async function load(exchange: string, date: string, key: string, priority: RefdataPriority) {
    const cached = await readDisk(key);
    if (cached) {
      return cached;
    }
    try {
      const startedAt = now();
      const raw = await schedule(priority, () =>
        nubraGet(`/refdata/refdata/${date}`, { exchange }),
      );
      const arr = Array.isArray(raw.refdata)
        ? distil(raw.refdata as Record<string, unknown>[])
        : [];
      // An empty result is not cached: it is either a non-trading date or a shape we failed to
      // recognise, and memoising it would pin that answer for the life of the process.
      if (arr.length === 0) return [];
      console.log(
        `[backtest refdata] ${exchange} ${date}: ${arr.length} instruments in ${now() - startedAt}ms`,
      );
      // Not awaited — the caller has what it needs, and the response should not wait on gzip.
      // Tracked, though, so prefetchForDate can await the file actually landing.
      if (isImmutable(date)) scheduleWrite(key, arr);
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
    // A request that joins a prefetch's in-flight download still wants the result resident, so
    // `remember` lives here rather than in `load`.
    return singleFlight(exchange, date, key, 'user').then((arr) => {
      if (arr.length) remember(key, arr);
      return arr;
    });
  }

  /** One download per key, however many callers ask for it concurrently. */
  function singleFlight(
    exchange: string,
    date: string,
    key: string,
    priority: RefdataPriority,
  ): Promise<Record<string, unknown>[]> {
    const pending = inFlight.get(key);
    if (pending) return pending;

    const started = load(exchange, date, key, priority);
    inFlight.set(key, started);
    void started.finally(() => {
      if (inFlight.get(key) === started) inFlight.delete(key);
    });
    return started;
  }

  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  /** Every date we already hold for an exchange, from memory and from disk. Never downloads. */
  async function cachedDates(exchange: string): Promise<string[]> {
    const prefix = `${exchange}_`;
    const found = new Set<string>();
    for (const key of resident.keys()) {
      if (key.startsWith(prefix)) found.add(key.slice(prefix.length));
    }
    if (cacheDir) {
      const names = await fs.readdir(cacheDir).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.json.gz')) continue;
        found.add(name.slice(prefix.length, name.length - '.json.gz'.length));
      }
    }
    return [...found].filter((d) => DATE_ONLY.test(d));
  }

  function shiftDays(date: string, days: number): string {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  }

  async function peekRefdataNear(
    exchange: string,
    date: string,
    maxAgeDays: number,
  ): Promise<RefdataSnapshot | null> {
    if (!DATE_ONLY.test(date)) return null;
    // Today is already free through the shared day cache, and it is the one master that is still
    // being added to — so it is never a stand-in for anything, including itself.
    if (sharedDay?.() === date) return null;

    const earliest = shiftDays(date, -maxAgeDays);
    const candidates = (await cachedDates(exchange))
      .filter((d) => d <= date && d >= earliest)
      // Newest first: the closest snapshot is the one missing the fewest later listings.
      .sort((a, b) => b.localeCompare(a));

    for (const candidate of candidates) {
      const key = `${exchange}_${candidate}`;
      const hit = resident.get(key);
      if (hit) {
        remember(key, hit);
        return { rows: hit, snapshotDate: candidate };
      }
      const fromDisk = await readDisk(key);
      if (fromDisk?.length) {
        remember(key, fromDisk);
        return { rows: fromDisk, snapshotDate: candidate };
      }
    }
    return null;
  }

  async function prefetchForDate(exchange: string, date: string): Promise<void> {
    // Today is the shared day cache's job, and it is never durable anyway.
    if (sharedDay?.() === date) return;
    const key = `${exchange}_${date}`;
    if (resident.has(key)) return;

    const file = fileFor(key);
    // An existing file is the whole point of the prefetch, so stop at the cheap stat rather than
    // gunzipping and parsing 34 MB only to throw the result away.
    if (
      file &&
      (await fs
        .access(file)
        .then(() => true)
        .catch(() => false))
    )
      return;

    await singleFlight(exchange, date, key, 'warm');
    await pendingWrites.get(key);
  }

  return { getRefdataForDate, peekRefdataNear, prefetchForDate };
}
