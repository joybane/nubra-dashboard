/**
 * Cache for historical intraday bars, keyed per symbol per date.
 *
 * A past date's 1m candles cannot change, yet the backtest pane re-downloaded all 58 symbols of a
 * chain on every remount, every expiry switch and every ENTRY-time click — seven upstream POSTs
 * per interaction, each one a chance for the broker socket to drop. This is the same shape as
 * backtestRefdataStore.ts (single-flight, memory tier, gzip on disk, past dates only) applied to
 * the other half of the pane's traffic.
 *
 * Two rules here deliberately differ from the refdata store; both are commented at the point they
 * apply, because copying that file verbatim would produce a bug in each case:
 *
 * 1. **Empty payloads ARE cached**, keyed on whether the fetch *succeeded* rather than on whether
 *    it returned anything. An illiquid wing strike that never traded legitimately has no bars, and
 *    refusing to cache that means the wings re-download forever.
 * 2. **Today is a hard bypass**, memory included. The refdata store can delegate today to the
 *    shared day cache; there is no equivalent for bars, and today's grow every minute.
 *
 * What is stored is the *raw* upstream per-symbol payload (field name → `{ts, v}[]`), never parsed
 * bars: nbParseBars has been rewritten once already, and caching its output would mean a future
 * parser fix silently failed to apply to any date already on disk.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gzipSync, gunzip } from 'zlib';
import { promisify } from 'util';
import { isPastDate } from './tradingDay.ts';

const gunzipAsync = promisify(gunzip);

/** The upstream chart payload for one symbol: field name → series. */
export type BarPayload = Record<string, unknown>;

export interface BacktestBarStoreDeps {
  /** Absolute directory for the on-disk copies. Omit to keep everything in memory. */
  cacheDir?: string;
  /** The day the shared refdata cache currently holds, as YYYY-MM-DD. Defines "today". */
  sharedDay?: () => string;
  /** Injectable clock, for testing. */
  now?: () => number;
  /** Gzipped payloads held in memory at once. ~10 KB each, so this is a soft memory ceiling. */
  maxResident?: number;
  /** Date directories kept on disk before the least recently used are dropped. */
  maxDates?: number;
}

export interface BacktestBarStore {
  /** True when `date` is old enough that its bars can never change again. */
  isCacheable(date: string): boolean;
  /** Cached payloads for whichever of `symbols` are present. Absent symbols are simply missing. */
  get(
    exchange: string,
    date: string,
    interval: string,
    symbols: string[],
  ): Promise<Map<string, BarPayload>>;
  /** Record a batch that fetched successfully. Never rejects; disk errors are logged and dropped. */
  put(
    exchange: string,
    date: string,
    interval: string,
    payloads: Map<string, BarPayload>,
  ): Promise<void>;
}

/**
 * Both halves of the key become path segments, so anything that is not a plain exchange code, ISO
 * date, interval or broker symbol stays out of the cache directory entirely. Such a request still
 * works — it just goes upstream every time.
 */
const SAFE_DIR = /^[A-Z]{2,6}_\d{4}-\d{2}-\d{2}$/;
const SAFE_SYMBOL = /^[A-Za-z0-9_.-]{1,120}$/;
const SAFE_INTERVAL = /^[0-9a-z]{1,8}$/;

/** Bumped when the stored shape changes, which invalidates every file in one character. */
const SCHEMA = 'v1';

export function createBacktestBarStore({
  cacheDir,
  sharedDay,
  now = Date.now,
  maxResident = 2_000,
  maxDates = 20,
}: BacktestBarStoreDeps = {}): BacktestBarStore {
  /**
   * Insertion-ordered, so the first key is the least recently used. Holds the **gzipped** buffer
   * rather than the parsed object: 2 000 symbol-days is ~24 MB this way against several hundred MB
   * as live JS objects, and a gunzip of ~10 KB costs ~0.2 ms — invisible next to the response it
   * saves. It also makes the memory tier and the disk tier the same bytes.
   */
  const resident = new Map<string, Buffer>();

  function today(): string {
    return sharedDay?.() ?? new Date(now()).toISOString().slice(0, 10);
  }

  function isCacheable(date: string): boolean {
    return isPastDate(date, today());
  }

  function dirName(exchange: string, date: string): string {
    return `${exchange}_${date}`;
  }

  function residentKey(exchange: string, date: string, interval: string, symbol: string): string {
    return `${exchange}_${date}/${symbol}_${interval}`;
  }

  function fileFor(
    exchange: string,
    date: string,
    interval: string,
    symbol: string,
  ): string | null {
    if (!cacheDir) return null;
    const dir = dirName(exchange, date);
    if (!SAFE_DIR.test(dir) || !SAFE_SYMBOL.test(symbol) || !SAFE_INTERVAL.test(interval)) {
      return null;
    }
    return path.join(cacheDir, dir, `${symbol}_${interval}_${SCHEMA}.json.gz`);
  }

  function remember(key: string, buf: Buffer): void {
    resident.delete(key);
    resident.set(key, buf);
    while (resident.size > maxResident) {
      const oldest = resident.keys().next().value as string;
      resident.delete(oldest);
    }
  }

  async function decode(buf: Buffer): Promise<BarPayload | null> {
    try {
      const parsed = JSON.parse((await gunzipAsync(buf)).toString('utf8')) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as BarPayload) : null;
    } catch {
      return null;
    }
  }

  async function get(
    exchange: string,
    date: string,
    interval: string,
    symbols: string[],
  ): Promise<Map<string, BarPayload>> {
    const hits = new Map<string, BarPayload>();
    if (!isCacheable(date)) return hits;

    await Promise.all(
      symbols.map(async (symbol) => {
        const key = residentKey(exchange, date, interval, symbol);

        const inMemory = resident.get(key);
        if (inMemory) {
          const payload = await decode(inMemory);
          if (payload) {
            remember(key, inMemory);
            hits.set(symbol, payload);
            return;
          }
          resident.delete(key);
        }

        const file = fileFor(exchange, date, interval, symbol);
        if (!file) return;
        let buf: Buffer;
        try {
          buf = await fs.readFile(file);
        } catch (err) {
          // A missing file is the ordinary miss.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[backtest bars] unreadable cache file ${key}:`, err);
            await fs.unlink(file).catch(() => {});
          }
          return;
        }
        const payload = await decode(buf);
        if (!payload) {
          // Truncated or from an older shape — drop it so the next miss re-downloads.
          await fs.unlink(file).catch(() => {});
          return;
        }
        remember(key, buf);
        hits.set(symbol, payload);
      }),
    );

    return hits;
  }

  async function prune(): Promise<void> {
    if (!cacheDir) return;
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && SAFE_DIR.test(e.name));
      if (dirs.length <= maxDates) return;
      const stated = await Promise.all(
        dirs.map(async (entry) => ({
          name: entry.name,
          mtime: await fs
            .stat(path.join(cacheDir, entry.name))
            .then((s) => s.mtimeMs)
            .catch(() => 0),
        })),
      );
      // Evict whole dates rather than individual symbols: a user moves between dates, so a
      // half-populated date is the worst of both worlds. It also keeps prune() off the O(files)
      // stat sweep that a flat directory of 10k entries would require.
      stated.sort((a, b) => b.mtime - a.mtime);
      for (const entry of stated.slice(maxDates)) {
        await fs
          .rm(path.join(cacheDir, entry.name), { recursive: true, force: true })
          .catch(() => {});
      }
    } catch {
      /* the directory may not exist yet */
    }
  }

  async function put(
    exchange: string,
    date: string,
    interval: string,
    payloads: Map<string, BarPayload>,
  ): Promise<void> {
    if (!isCacheable(date) || payloads.size === 0) return;

    // Validate before building the path, not after: `dirName` interpolates caller-supplied values,
    // and an unchecked `..` would escape the cache directory even though nothing is written there.
    const dirSegment = dirName(exchange, date);
    const dir = cacheDir && SAFE_DIR.test(dirSegment) ? path.join(cacheDir, dirSegment) : null;
    let madeDir = false;

    // The memory tier is filled synchronously, before this function's first await. Callers fire
    // this without awaiting it (the response should not wait on gzip), so anything after an await
    // would not be there for the very next request — which is exactly the repeat load the cache
    // exists for. gzipSync on a ~10 KB payload is ~0.1 ms, and the buffer is needed for disk anyway.
    const encoded = new Map<string, Buffer>();
    for (const [symbol, payload] of payloads) {
      const key = residentKey(exchange, date, interval, symbol);
      try {
        const buf = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
        remember(key, buf);
        encoded.set(symbol, buf);
      } catch (err) {
        console.warn(`[backtest bars] could not encode ${key}:`, err);
      }
    }

    for (const [symbol, buf] of encoded) {
      const key = residentKey(exchange, date, interval, symbol);
      const file = fileFor(exchange, date, interval, symbol);
      if (!file || !dir) continue;
      try {
        if (!madeDir) {
          await fs.mkdir(dir, { recursive: true });
          madeDir = true;
        }
        // Same-directory temp file plus rename, so a process killed mid-write can never leave a
        // truncated file that a later run would read as a valid cache hit.
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          await fs.writeFile(tmp, buf);
          await fs.rename(tmp, file);
        } catch (err) {
          await fs.unlink(tmp).catch(() => {});
          throw err;
        }
      } catch (err) {
        console.warn(`[backtest bars] could not persist ${key}:`, err);
      }
    }

    if (dir && madeDir) {
      // Refresh the date directory's mtime so pruning treats it as recently used, not merely
      // recently written.
      await fs.utimes(dir, new Date(), new Date()).catch(() => {});
      await prune();
    }
  }

  return { isCacheable, get, put };
}
