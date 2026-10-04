/**
 * Option open/high/low/close from the local parquet tree ("ATM Wise data"), for one date.
 *
 * The analysis cache keeps closes only, and Nubra's option history is fetched as closes only, so
 * the parquet tree is the one place highs and lows exist (up to its last expiry). Its files are
 * ATM-relative buckets (ATM±N) whose absolute strike floats minute by minute, so a day is stitched
 * by regrouping every bucket's bars of that date by their own `strike` value — the same stitch the
 * backtest data layer does (server/backtest/dataLayer.ts), but done here without building a `Bar`
 * object per row: only the six columns a price needs are decoded, and each row goes straight to its
 * minute slot. That is what makes a multi-year run take a fraction of the time (a week of buckets
 * is ~80k rows; building and sorting a full `Bar` for each was most of the cost).
 *
 * Used only when the tree's nearest weekly expiry for the date is the day's own expiry; anything
 * else would price a different contract, and the trade then falls back to closes.
 *
 * Where two bars land on the same strike and minute (a strike surfacing in two adjacent buckets at
 * a boundary cross) the first one in bucket order wins, as in the data layer.
 *
 * Reading the parquet tree is bound by the disk (a week is ~40 files), so a stitched day is kept in
 * a small file of its own (ohlcDayStore.ts) and the tree is read for a date once.
 */
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { availableParallelism } from 'os';
import path from 'path';
import { DATA_ROOT, resolveExpiry } from '../backtest/dataLayer.ts';
import type { ExpiryFlag, Underlying } from '../backtest/types.ts';
import { SESSION_BARS, SESSION_OPEN_MIN, type Grid } from '../analysis/daySeries.ts';
import { createBucketPool } from './bucketPool.ts';
import { decodeBucket, type BucketColumns } from './bucketDecode.ts';
import { BLOCK, createOhlcDayStore, type OhlcDayStore, type StitchedDay } from './ohlcDayStore.ts';
import type { OhlcSeries, OhlcSource, OptionKind } from './trade.ts';

export type { BucketColumns };

export type OhlcLoader = (
  underlying: string,
  date: string,
  expiry: string,
) => Promise<OhlcSource | null>;

/** One ATM-offset folder of an expiry: its call and put bucket files (null where absent). */
export interface BucketPair {
  call: string | null;
  put: string | null;
}

export interface ParquetOhlcDeps {
  /** The nearest weekly (or monthly) expiry on or after a date, as the data layer resolves it. */
  resolve(
    underlying: Underlying,
    date: string,
  ): Promise<{ expiry: string; flag: ExpiryFlag } | null>;
  /** The bucket folders of an expiry, in a stable order (the order decides duplicate minutes). */
  listBuckets(underlying: Underlying, expiry: string, flag: ExpiryFlag): Promise<BucketPair[]>;
  /** Decode one bucket file; null when it is unreadable (it is skipped, like the data layer does). */
  readBucket(file: string): Promise<BucketColumns | null>;
  /** Where stitched days are kept between runs; without one every run reads the tree again. */
  store?: OhlcDayStore;
}

const IST_OFFSET_SEC = 5.5 * 3600;
const DAY_SEC = 86400;

/** Days since the epoch of an ISO date — the same number an IST timestamp of that date yields. */
const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

/** Worker threads for decoding: all but a couple of cores, at most 8. 0 decodes in-process. */
function workerCount(): number {
  const set = Number(process.env.SIGNAL_PARQUET_WORKERS);
  if (process.env.SIGNAL_PARQUET_WORKERS !== undefined && Number.isInteger(set) && set >= 0) {
    return set;
  }
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

/**
 * Decodes the six columns of a parquet file on a worker thread, or in-process if the pool cannot
 * (no workers configured, or one failed). Anything unreadable is logged once and skipped.
 */
function defaultReadBucket(): ParquetOhlcDeps['readBucket'] {
  const warned = new Set<string>();
  const size = workerCount();
  const pool = size > 0 ? createBucketPool({ size }) : null;
  return async (file) => {
    try {
      if (pool) {
        try {
          return await pool.read(file);
        } catch {
          /* decode it here instead: a corrupt file fails the same way and is skipped below */
        }
      }
      return await decodeBucket(file);
    } catch (e) {
      if (!warned.has(file)) {
        warned.add(file);
        console.warn(
          `[signal-backtest] skipping unreadable parquet: ${path.basename(file)} — ${(e as Error).message}`,
        );
      }
      return null;
    }
  };
}

async function defaultListBuckets(
  und: Underlying,
  expiry: string,
  flag: ExpiryFlag,
): Promise<BucketPair[]> {
  const expDir = path.join(DATA_ROOT, und, expiry);
  if (!existsSync(expDir)) return [];
  const out: BucketPair[] = [];
  for (const off of await readdir(expDir, { withFileTypes: true })) {
    if (!off.isDirectory()) continue;
    const flagDir = path.join(expDir, off.name, flag);
    const call = path.join(flagDir, `${und}_${expiry}_${flag}_CALL.parquet`);
    const put = path.join(flagDir, `${und}_${expiry}_${flag}_PUT.parquet`);
    out.push({ call: existsSync(call) ? call : null, put: existsSync(put) ? put : null });
  }
  return out;
}

/** Bucket files kept decoded; a week is ~40 files of ~90 KB, so this is a few weeks' worth. */
const BUCKET_CACHE_MAX = 600;
/** Days kept built, so the run and the chart under a row do not stitch the same day twice. */
const DAY_CACHE_MAX = 64;

/** One strike's bars for the day: its block, and which bar filled each minute. */
interface StrikeBars {
  block: Float64Array;
  /** Timestamp of the bar that filled each minute, to keep the first of two bars with the same one. */
  at: Float64Array;
}

function stitch(files: Array<BucketColumns | null>, target: number): Map<number, StrikeBars> {
  const out = new Map<number, StrikeBars>();
  for (const cols of files) {
    if (!cols) continue;
    const n = cols.ts.length;
    for (let r = 0; r < n; r++) {
      const ts = cols.ts[r];
      const sec = ts + IST_OFFSET_SEC;
      if (Math.floor(sec / DAY_SEC) !== target) continue;
      const strike = cols.strike[r];
      if (!Number.isFinite(strike)) continue;
      let s = out.get(strike);
      if (!s) {
        s = {
          block: new Float64Array(BLOCK).fill(NaN),
          at: new Float64Array(SESSION_BARS).fill(NaN),
        };
        out.set(strike, s);
      }
      const i = Math.floor((sec % DAY_SEC) / 60) - SESSION_OPEN_MIN;
      if (i < 0 || i >= SESSION_BARS) continue;
      // The same strike and minute twice: the first in bucket order stands.
      if (s.at[i] === ts) continue;
      s.at[i] = ts;
      if (Number.isFinite(cols.open[r])) s.block[i] = cols.open[r];
      if (Number.isFinite(cols.high[r])) s.block[SESSION_BARS + i] = cols.high[r];
      if (Number.isFinite(cols.low[r])) s.block[2 * SESSION_BARS + i] = cols.low[r];
      if (Number.isFinite(cols.close[r])) s.block[3 * SESSION_BARS + i] = cols.close[r];
    }
  }
  return out;
}

/** A stitched day as the trade simulator's OHLC source; a strike's grids are made when first asked for. */
function sourceOf(day: StitchedDay): OhlcSource {
  const index: Record<OptionKind, Map<number, number>> = {
    CE: new Map(day.strikes.CE.map((k, i) => [k, i])),
    PE: new Map(day.strikes.PE.map((k, i) => [k, i])),
  };
  const made: Record<OptionKind, Map<number, OhlcSeries>> = { CE: new Map(), PE: new Map() };
  return {
    strikes: (kind) => [...day.strikes[kind]],
    series(kind, strike) {
      const hit = made[kind].get(strike);
      if (hit) return hit;
      const at = index[kind].get(strike);
      if (at === undefined) return null;
      const block = day.blocks[kind][at];
      const row = (k: number): Grid =>
        Array.from({ length: SESSION_BARS }, (_, m) => {
          const v = block[k * SESSION_BARS + m];
          return Number.isNaN(v) ? null : v;
        });
      const series: OhlcSeries = { o: row(0), h: row(1), l: row(2), c: row(3) };
      made[kind].set(strike, series);
      return series;
    },
  };
}

export function createParquetOhlcLoader(deps: ParquetOhlcDeps): OhlcLoader {
  const buckets = new Map<string, Promise<BucketColumns | null>>();
  const days = new Map<string, Promise<OhlcSource | null>>();
  const listings = new Map<string, Promise<BucketPair[]>>();

  const bucket = (file: string) => {
    let p = buckets.get(file);
    if (!p) {
      p = deps.readBucket(file);
      buckets.set(file, p);
      if (buckets.size > BUCKET_CACHE_MAX) buckets.delete(buckets.keys().next().value!);
    }
    return p;
  };
  const listing = (und: Underlying, expiry: string, flag: ExpiryFlag) => {
    const key = `${und}|${expiry}|${flag}`;
    let p = listings.get(key);
    if (!p) {
      p = deps.listBuckets(und, expiry, flag);
      listings.set(key, p);
    }
    return p;
  };

  /** Stitch a day from the tree. `complete` is false if any bucket file could not be read. */
  async function build(
    und: Underlying,
    expiry: string,
    flag: ExpiryFlag,
    date: string,
  ): Promise<{ day: StitchedDay; complete: boolean } | null> {
    const pairs = await listing(und, expiry, flag);
    const target = dayNumber(date);
    const calls = await Promise.all(pairs.map((p) => (p.call ? bucket(p.call) : null)));
    const puts = await Promise.all(pairs.map((p) => (p.put ? bucket(p.put) : null)));
    const sides = { CE: stitch(calls, target), PE: stitch(puts, target) };
    if (!sides.CE.size && !sides.PE.size) return null;
    const complete = pairs.every(
      (p, i) => (!p.call || calls[i] !== null) && (!p.put || puts[i] !== null),
    );
    const day: StitchedDay = {
      expiry,
      flag,
      strikes: { CE: [...sides.CE.keys()], PE: [...sides.PE.keys()] },
      blocks: {
        CE: [...sides.CE.values()].map((v) => v.block),
        PE: [...sides.PE.values()].map((v) => v.block),
      },
    };
    return { day, complete };
  }

  async function load(und: Underlying, expiry: string, flag: ExpiryFlag, date: string) {
    const kept = await deps.store?.read(und, date);
    if (kept && kept.expiry === expiry && kept.flag === flag) return sourceOf(kept);
    const built = await build(und, expiry, flag, date);
    if (!built) return null;
    // Not kept when a file was unreadable: mending the file should show up in the next run.
    if (built.complete && deps.store) void deps.store.write(und, date, built.day).catch(() => {});
    return sourceOf(built.day);
  }

  return async (underlying, date, expiry) => {
    if (underlying !== 'NIFTY' && underlying !== 'SENSEX') return null;
    const und = underlying as Underlying;
    const resolved = await deps.resolve(und, date);
    if (!resolved || resolved.expiry !== expiry) return null;
    const key = `${und}|${resolved.expiry}|${resolved.flag}|${date}`;
    let p = days.get(key);
    if (!p) {
      p = load(und, resolved.expiry, resolved.flag, date);
      days.set(key, p);
      if (days.size > DAY_CACHE_MAX) days.delete(days.keys().next().value!);
    }
    return p;
  };
}

/** The loader the server uses: the real tree, worker-thread decoding, days kept under `cacheRoot`. */
export function createParquetOhlcLoaderFor(cacheRoot: string): OhlcLoader {
  return createParquetOhlcLoader({
    resolve: (und, date) => resolveExpiry(und, 'WEEK', date, 0),
    listBuckets: defaultListBuckets,
    readBucket: defaultReadBucket(),
    store: createOhlcDayStore(cacheRoot),
  });
}
