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
 *
 * 4. **The day's copy is kept on disk.** Held only in memory, every restart paid three cold
 *    downloads — 40-45 s each — before search, the option chain's symbol enrichment, or anything
 *    else that reads an instrument could answer. During development that is every code change. A
 *    same-day copy on disk turns that into a gunzip, and because instruments are only ever *added*
 *    intraday, serving it while a refresh runs behind it cannot produce a wrong record — at worst a
 *    listing created in the last few hours is briefly missing.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { runImmediately, type RefdataPriority, type RefdataSchedule } from './refdataQueue.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface RefdataCacheDeps {
  nubraGet: NubraGet;
  /** Injectable clock, for testing the day rollover. */
  now?: () => number;
  /** Absolute directory for the day's copies. Omit to keep everything in memory, as tests do. */
  cacheDir?: string;
  /** Serialises the downloads against each other. Defaults to running them straight away. */
  schedule?: RefdataSchedule;
}

export interface RefdataCache {
  /**
   * `priority` decides who gets the download lane first when several are queued. Startup warms pass
   * 'warm' so that a request someone is actually waiting on overtakes them.
   */
  getRefdata(exchange: string, priority?: RefdataPriority): Promise<Record<string, unknown>[]>;
  /** Synchronous cache read; null when this exchange has not been downloaded yet today. */
  peekRefdata(exchange: string): Record<string, unknown>[] | null;
  /**
   * The day these entries belong to, as YYYY-MM-DD. Callers keyed by an arbitrary date (the
   * historical backtest) compare against this to decide whether this cache already holds what
   * they want, rather than re-deriving the rollover rule and drifting from it.
   */
  cacheDay(): string;
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

/** Only an exchange code and an ISO date ever become part of a filename. */
const SAFE_EXCHANGE = /^[A-Z]{2,6}$/;

export function createRefdataCache({
  nubraGet,
  now = Date.now,
  cacheDir,
  schedule = runImmediately,
}: RefdataCacheDeps): RefdataCache {
  const inFlight = new Map<string, Promise<Record<string, unknown>[]>>();
  const settled = new Map<string, Record<string, unknown>[]>();
  /** Exchanges whose disk copy is currently being replaced by a fresh download. */
  const refreshing = new Set<string>();
  let cacheDay = '';

  function fileFor(exchange: string, day: string): string | null {
    if (!cacheDir || !SAFE_EXCHANGE.test(exchange)) return null;
    return path.join(cacheDir, `${exchange}_${day}.json.gz`);
  }

  async function readDisk(
    exchange: string,
    day: string,
  ): Promise<Record<string, unknown>[] | null> {
    const file = fileFor(exchange, day);
    if (!file) return null;
    try {
      const raw = JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8'));
      return Array.isArray(raw) && raw.length ? (raw as Record<string, unknown>[]) : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[Refdata] discarding unreadable cache file for ${exchange}:`, err);
        await fs.unlink(file).catch(() => {});
      }
      return null;
    }
  }

  async function writeDisk(
    exchange: string,
    day: string,
    arr: Record<string, unknown>[],
  ): Promise<void> {
    const file = fileFor(exchange, day);
    if (!file) return;
    // Same-directory temp file plus rename, so a process killed mid-write cannot leave a truncated
    // file that the next boot would read as a valid copy.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(cacheDir!, { recursive: true });
      await fs.writeFile(tmp, await gzipAsync(Buffer.from(JSON.stringify(arr), 'utf8')));
      await fs.rename(tmp, file);
      // One file per exchange: yesterday's copy is worthless the moment today's exists.
      for (const name of await fs.readdir(cacheDir!).catch(() => [] as string[])) {
        if (name.startsWith(`${exchange}_`) && name !== path.basename(file)) {
          await fs.unlink(path.join(cacheDir!, name)).catch(() => {});
        }
      }
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      console.warn(`[Refdata] could not persist ${exchange}:`, err);
    }
  }

  async function download(
    exchange: string,
    day: string,
    priority: RefdataPriority,
  ): Promise<Record<string, unknown>[]> {
    const startedAt = now();
    const raw = await schedule(priority, () => nubraGet(`/refdata/refdata/${day}`, { exchange }));
    const arr = extractRefdata(raw);
    console.log(`[Refdata] ${exchange}: ${arr.length} instruments in ${now() - startedAt}ms`);
    if (arr.length) void writeDisk(exchange, day, arr);
    return arr;
  }

  /**
   * Replace a copy that came off disk with a freshly downloaded one.
   *
   * Runs behind whatever is already being served, so a failure is silent by design — the disk copy
   * stays in place and the next boot tries again. Skipped if the day rolled over while it ran,
   * because the answer then belongs to a day this cache no longer holds.
   */
  function refresh(exchange: string, day: string): void {
    if (refreshing.has(exchange)) return;
    refreshing.add(exchange);
    void download(exchange, day, 'warm')
      .then((arr) => {
        if (!arr.length || cacheDay !== day) return;
        settled.set(exchange, arr);
        inFlight.set(exchange, Promise.resolve(arr));
      })
      .catch((e: unknown) => {
        console.warn(`[Refdata] background refresh failed for ${exchange}:`, e);
      })
      .finally(() => refreshing.delete(exchange));
  }

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

  function getRefdata(
    exchange: string,
    priority: RefdataPriority = 'user',
  ): Promise<Record<string, unknown>[]> {
    const today = currentDay();

    const hit = inFlight.get(exchange);
    if (hit) return hit;

    const pending = (async () => {
      const fromDisk = await readDisk(exchange, today);
      if (fromDisk) {
        console.log(`[Refdata] ${exchange}: ${fromDisk.length} instruments from today's disk copy`);
        // Serve it now and go and get a current one, so an instrument listed since the copy was
        // written appears without anybody having to wait for it.
        refresh(exchange, today);
        return fromDisk;
      }
      return download(exchange, today, priority);
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

  // currentDay also performs the rollover, so exposing it directly keeps the reported day and the
  // cached contents consistent — there is no window where one has rolled over and the other has not.
  return { getRefdata, peekRefdata, cacheDay: currentDay };
}
