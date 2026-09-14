/**
 * One trading day of the analysis dataset: spot and a ladder of option closes on a fixed
 * one-minute grid, from exactly one source.
 *
 * The grid is the NSE cash session, 09:15 → 15:29, 375 slots, index 0 = 09:15. A slot with no bar
 * is `null`, never carried forward — a missing minute must stay visibly missing, or a P&L
 * difference between two instants could be manufactured out of a stale price.
 *
 * Both sources store the same shape so the case finder never knows which one it is reading. Which
 * strikes are kept is decided by `strikeCoverage`: enough of a ladder that ATM±2 can be resolved at
 * any entry minute of the day, so changing the entry time never needs a re-download.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_BARS = 375;

/**
 * Listed strike spacing near the money. Stated rather than inferred from a stored ladder: a ladder
 * with a hole in it (an untraded strike, a thin day) would otherwise read as a wider step and move
 * ATM — and with it both legs — for that day.
 */
export const STRIKE_STEP: Record<string, number> = { NIFTY: 50, SENSEX: 100 };

export type DaySource = 'nubra' | 'local';
export type Grid = (number | null)[];

export interface DaySeries {
  v: 1;
  underlying: string;
  date: string;
  source: DaySource;
  /** Nearest expiry on or after `date`, YYYY-MM-DD. */
  expiry: string;
  monthly: boolean;
  /** Underlying close per minute, rupees. */
  spot: Grid;
  /** Underlying open/high/low per minute — Nubra only; the parquet tree carries spot closes alone. */
  spotOhlc?: { o: Grid; h: Grid; l: Grid };
  /** Strike (as a string key) → option close per minute, rupees. */
  ce: Record<string, Grid>;
  pe: Record<string, Grid>;
}

/**
 * A date that was looked up successfully and has nothing: a holiday, a date before the source's
 * history starts, or (Nubra) index bars with no option bars. Stored so it is not asked again.
 * Transient failures are never written as one of these.
 */
export interface EmptyDay {
  v: 1;
  underlying: string;
  date: string;
  source: DaySource;
  empty: true;
  reason: string;
}

export type StoredDay = DaySeries | EmptyDay;

export function isEmptyDay(day: StoredDay): day is EmptyDay {
  return (day as EmptyDay).empty === true;
}

export function emptyGrid(): Grid {
  return new Array<number | null>(SESSION_BARS).fill(null);
}

/** Grid index for an IST 'HH:MM', or -1 outside the session. */
export function minuteIndex(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  const i = h * 60 + m - SESSION_OPEN_MIN;
  return i >= 0 && i < SESSION_BARS ? i : -1;
}

export function hhmmAt(index: number): string {
  const t = SESSION_OPEN_MIN + index;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The strikes a day must keep so that OTM±`offset` resolves at any minute.
 *
 * ATM is spot rounded to the strike step, so over the day it ranges between the rounded low and
 * the rounded high. One extra strike either side absorbs rounding at the edges and a step that is
 * wider than assumed. A 300-point day at step 50 keeps 9 strikes per side.
 */
export function strikeCoverage(
  spot: Grid,
  step: number,
  offset = 2,
): { ce: number[]; pe: number[] } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of spot) {
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return null;
  const atmLo = Math.round(lo / step) * step;
  const atmHi = Math.round(hi / step) * step;
  const range = (from: number, to: number) => {
    const out: number[] = [];
    for (let k = from; k <= to; k += step) out.push(k);
    return out;
  };
  return {
    ce: range(atmLo + (offset - 1) * step, atmHi + (offset + 1) * step),
    pe: range(atmLo - (offset + 1) * step, atmHi - (offset - 1) * step),
  };
}

// ── disk store ─────────────────────────────────────────────────────────────────

export interface DayListing {
  date: string;
  empty: boolean;
}

export interface DayStore {
  read(underlying: string, source: DaySource, date: string): Promise<StoredDay | null>;
  write(day: StoredDay): Promise<void>;
  /** Every date on disk for one source — data and empty alike — ascending. */
  list(underlying: string, source: DaySource): Promise<string[]>;
  /** Same, with whether each is an empty marker, known from the file name without reading it. */
  listDetailed(underlying: string, source: DaySource): Promise<DayListing[]>;
  /** Directory for per-underlying side files (calendar, validation report). */
  dir(underlying: string): string;
}

const DATA_EXT = '.json.gz';
const EMPTY_EXT = '.empty.json.gz';

/**
 * Empty markers get their own extension so coverage can be counted from a directory listing. The
 * status panel polls every couple of seconds while a sync runs, and telling a holiday from a data
 * day by opening ~1,800 gzip files each time would be absurd.
 */
export function createDayStore(rootDir: string): DayStore {
  const dirFor = (underlying: string, source: DaySource) => path.join(rootDir, underlying, source);
  const fileFor = (underlying: string, source: DaySource, date: string, empty: boolean) =>
    path.join(dirFor(underlying, source), `${date}${empty ? EMPTY_EXT : DATA_EXT}`);

  async function readFile(file: string): Promise<StoredDay | null> {
    try {
      return JSON.parse((await gunzipAsync(await fs.readFile(file))).toString('utf8')) as StoredDay;
    } catch {
      return null;
    }
  }

  async function listDetailed(underlying: string, source: DaySource): Promise<DayListing[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(dirFor(underlying, source));
    } catch {
      return [];
    }
    const byDate = new Map<string, boolean>();
    for (const n of names) {
      if (n.endsWith(EMPTY_EXT)) {
        const date = n.slice(0, -EMPTY_EXT.length);
        if (!byDate.has(date)) byDate.set(date, true);
      } else if (n.endsWith(DATA_EXT)) {
        byDate.set(n.slice(0, -DATA_EXT.length), false);
      }
    }
    return [...byDate]
      .map(([date, empty]) => ({ date, empty }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  return {
    async read(underlying, source, date) {
      return (
        (await readFile(fileFor(underlying, source, date, false))) ??
        (await readFile(fileFor(underlying, source, date, true)))
      );
    },
    async write(day) {
      const empty = isEmptyDay(day);
      const file = fileFor(day.underlying, day.source, day.date, empty);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write-then-rename, so a reader (or a crash) never sees half a file.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, await gzipAsync(JSON.stringify(day)));
      await fs.rename(tmp, file);
      // A date is one or the other, never both.
      await fs.rm(fileFor(day.underlying, day.source, day.date, !empty), { force: true });
    },
    async list(underlying, source) {
      return (await listDetailed(underlying, source)).map((d) => d.date);
    },
    listDetailed,
    dir(underlying) {
      return path.join(rootDir, underlying);
    },
  };
}
