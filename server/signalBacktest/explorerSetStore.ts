/**
 * Every Trade Explorer trade set, built once per saved run and kept on disk.
 *
 * Switching the Trade set used to re-simulate every strike set on every day (about 45 s for
 * NIFTY) and the answer was never kept. One day's simulation already prices every set, so a single
 * pass over the days now writes all of them, gzipped, to
 * `.signal-cache/<UND>/explorer-sets/<run mtime>-v<N>/<key>.json.gz`. A set switch then sends the
 * file as it is. The pass starts in the background when the explorer first opens and runs again
 * only when the saved run changes ("Update data").
 */
import { createReadStream, createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { isEmptyDay, type DaySeries } from '../analysis/daySeries.ts';
import {
  classifyExplorerSets,
  explorerDaySets,
  explorerSetOptions,
  parseSetKey,
} from './explorerSets.ts';
import type { OhlcSource } from './trade.ts';
import type { SignalBacktestRow } from './routes.ts';

const gzip = promisify(zlib.gzip);
/** Bump when the shape or rules of a built list change, so old files are rebuilt. */
const STORE_VERSION = 1;

type Row = SignalBacktestRow & { groups?: Record<string, unknown> };
export type SavedRun = Record<string, unknown> & {
  rows: Row[];
  tradeParams?: { strikeMode?: string; otmSteps?: number };
};

interface Deps {
  rootDir: string;
  readSavedRun: (underlying: string) => Promise<{ run: SavedRun; mtime: number }>;
  readDay: (underlying: string, source: Row['source'], date: string) => Promise<unknown>;
  resolveOhlc: (
    underlying: string,
    date: string,
    source: Row['source'],
    expiry: string,
    parquet: boolean,
  ) => Promise<{ ohlc: OhlcSource | null; ohlcSource: SignalBacktestRow['ohlcSource'] }>;
  log?: (msg: string) => void;
}

export const savedRunLabel = (run: SavedRun) =>
  `Saved run · ${
    run.tradeParams?.strikeMode === 'OTM' ? `OTM ${run.tradeParams.otmSteps}` : 'premium selection'
  }`;

/** The option list as the client gets it, with the saved run's own label. */
export const setOptionsFor = (underlying: string, run: SavedRun) => {
  const options = explorerSetOptions(underlying);
  options[0] = { ...options[0], label: savedRunLabel(run) };
  return options;
};

/** One day's row in a non-saved set: the saved signal, that set's trade, every set's summary. */
export function setRow(
  base: Row,
  result: ReturnType<typeof explorerDaySets>,
  key: string,
  ohlcSource: SignalBacktestRow['ohlcSource'],
) {
  const pick = result.trades[key];
  if (!pick) return null;
  return {
    date: base.date,
    source: base.source,
    expiry: base.expiry,
    dte: base.dte,
    groups: {
      path: base.groups?.path ?? null,
      dir: base.groups?.dir ?? null,
      moveFifth: base.groups?.moveFifth ?? null,
    },
    signal: base.signal,
    ohlcSource,
    trade: pick.trade,
    setLabel: pick.label,
    worstSet: result.worst?.label,
    worstLoss: result.worst?.maxLoss,
    comparisons: result.comparisons,
  };
}

export function createExplorerSetStore(deps: Deps) {
  const builds = new Map<string, Promise<string>>();
  const dirFor = (underlying: string, mtime: number) =>
    path.join(
      deps.rootDir,
      '.signal-cache',
      underlying,
      'explorer-sets',
      `${Math.round(mtime)}-v${STORE_VERSION}`,
    );
  const fileName = (key: string) => `${key.replace('@', '_dte')}.json.gz`;

  async function writeList(dir: string, key: string, body: unknown) {
    const tmp = path.join(dir, `${fileName(key)}.tmp`);
    await writeFile(tmp, await gzip(JSON.stringify(body), { level: 6 }));
    await rename(tmp, path.join(dir, fileName(key)));
  }

  async function build(underlying: string, run: SavedRun, mtime: number): Promise<string> {
    const dir = dirFor(underlying, mtime);
    if (existsSync(path.join(dir, 'done'))) return dir;
    const t0 = Date.now();
    const work = `${dir}.work`;
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const options = setOptionsFor(underlying, run);
    // The saved run itself goes first, so the explorer's own first load is served from disk too.
    await writeList(work, 'saved', {
      ...run,
      ok: true,
      underlying,
      skipped: [],
      setOptions: options,
      setLabel: options[0].label,
    });
    // Lists simulated per day: every set except the saved run and the per-expiry band cuts.
    const keys = options.map((o) => o.key).filter((k) => k !== 'saved' && !k.includes('@'));
    const streams = new Map<string, WriteStream>(
      keys.map((k) => [k, createWriteStream(path.join(work, `${k}.ndjson`))]),
    );
    const skipped = new Map<string, Array<{ date: string; reason: string }>>(
      keys.map((k) => [k, []]),
    );
    for (const base of run.rows) {
      const day = (await deps.readDay(underlying, base.source, base.date)) as DaySeries | null;
      if (!day || isEmptyDay(day)) {
        for (const k of keys)
          skipped.get(k)!.push({ date: base.date, reason: 'No stored day prices' });
        continue;
      }
      const { ohlc, ohlcSource } = await deps.resolveOhlc(
        underlying,
        base.date,
        base.source,
        base.expiry,
        true,
      );
      const result = explorerDaySets(base, day, ohlc, underlying, 'saved');
      for (const k of keys) {
        const row = setRow(base, result, k, ohlcSource);
        if (row) {
          const s = streams.get(k)!;
          if (!s.write(JSON.stringify(row) + '\n'))
            await new Promise<void>((resolve) => s.once('drain', () => resolve()));
        } else
          skipped.get(k)!.push({
            date: base.date,
            reason: 'No eligible pair with stored prices for this set',
          });
      }
      // Stay out of the way of live requests: one day per turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(
      [...streams.values()].map((s) => new Promise<void>((resolve) => s.end(() => resolve()))),
    );
    for (const k of keys) {
      const file = path.join(work, `${k}.ndjson`);
      const rows: Row[] = [];
      for await (const line of createInterface({ input: createReadStream(file) }))
        if (line) rows.push(JSON.parse(line));
      await rm(file);
      // Groups use the whole list (a day's "previous day" is the day before, whatever its
      // expiry distance), then the per-expiry band cuts are taken from it.
      classifyExplorerSets(rows, underlying);
      const label = (key: string) => options.find((o) => o.key === key)!.label;
      await writeList(work, k, {
        ok: true,
        underlying,
        rows,
        skipped: skipped.get(k),
        setOptions: options,
        setLabel: label(k),
      });
      for (const o of options) {
        const { set, dte } = parseSetKey(o.key);
        if (set !== k || dte == null) continue;
        await writeList(work, o.key, {
          ok: true,
          underlying,
          rows: rows.filter((r) => r.dte === dte),
          skipped: skipped.get(k),
          setOptions: options,
          setLabel: label(o.key),
        });
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await writeFile(path.join(work, 'done'), new Date().toISOString());
    await rm(dir, { recursive: true, force: true });
    await rename(work, dir);
    // Older versions of the run are no longer needed.
    const parent = path.dirname(dir);
    for (const name of await readdir(parent))
      if (path.join(parent, name) !== dir)
        await rm(path.join(parent, name), { recursive: true, force: true });
    deps.log?.(
      `Trade Explorer: ${underlying} trade sets built in ${Math.round((Date.now() - t0) / 1000)} s`,
    );
    return dir;
  }

  /** The folder holding every list for the current saved run, building it if needed. */
  async function ensure(underlying: string): Promise<string> {
    const { run, mtime } = await deps.readSavedRun(underlying);
    const key = `${underlying}|${mtime}`;
    let pending = builds.get(key);
    if (!pending) {
      pending = build(underlying, run, mtime);
      builds.set(key, pending);
      pending.catch((e) => {
        builds.delete(key);
        deps.log?.(`Trade Explorer: building ${underlying} trade sets failed: ${String(e)}`);
      });
    }
    return pending;
  }

  /** The gzipped list for one trade set (the whole day-by-day response body). */
  async function list(underlying: string, key: string): Promise<Buffer> {
    const dir = await ensure(underlying);
    return readFile(path.join(dir, fileName(key)));
  }

  /** The gzipped list if it is already on disk; never waits for a build. */
  async function ready(underlying: string, key: string): Promise<Buffer | null> {
    const { mtime } = await deps.readSavedRun(underlying);
    const file = path.join(dirFor(underlying, mtime), fileName(key));
    return existsSync(file) ? readFile(file) : null;
  }

  return { ensure, list, ready };
}
