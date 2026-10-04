/**
 * Wider option data for Nubra-period days: open/high/low/close for strikes ±WIDE_STEPS around the
 * day's range, stored under `.signal-cache/<UND>/wide/<date>.json.gz`.
 *
 * The Analysis cache keeps closes only, and only the ladder its finder needs (ATM ± 3 across the
 * day). That caps the Signal Backtest at OTM 3 and at premiums near the money on Nubra-only days,
 * and leaves those days without highs/lows. This fills both gaps without touching the Analysis
 * cache: it reads a day's expiry, name form and spot from the Analysis file (never writes it), and
 * keeps its own files.
 *
 * Request shape, 10-queries-per-request limit, paise prices and the "a 404 symbol fails the whole
 * batch" behaviour are the ones measured in server/analysis/nubraSource.ts. The pacer is slower
 * than the Analysis sync's (1.5 s vs 1.4 s) — the broker's 60 requests/minute is shared with the
 * whole dashboard, so running this and an Analysis "Update data" together is best avoided.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { gunzip, gzip } from 'zlib';
import { promisify } from 'util';
import {
  STRIKE_STEP,
  emptyGrid,
  isEmptyDay,
  minuteIndex,
  type DaySeries,
  type DayStore,
  type Grid,
} from '../analysis/daySeries.ts';
import { MASTER_EXCHANGE } from '../analysis/expiryCalendar.ts';
import { createPacer, type PostTimeseries } from '../analysis/nubraSource.ts';
import { nseOptionSymbol } from '../analysis/optionNames.ts';
import type { OhlcSeries, OhlcSource, OptionKind } from './trade.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Strikes kept beyond the day's ATM range on the out-of-the-money side. */
export const WIDE_STEPS = 10;
/** And on the in-the-money side — enough for ATM and a little past it. */
const ITM_STEPS = 3;
const BATCH = 10;
const ATTEMPTS = 3;

export interface WideDay {
  v: 1;
  underlying: string;
  date: string;
  expiry: string;
  monthly: boolean;
  ce: Record<string, OhlcSeries>;
  pe: Record<string, OhlcSeries>;
}

// ── store ─────────────────────────────────────────────────────────────────────

export interface WideStore {
  read(underlying: string, date: string): Promise<WideDay | null>;
  write(day: WideDay): Promise<void>;
  list(underlying: string): Promise<string[]>;
}

export function createWideStore(rootDir: string): WideStore {
  const dir = (u: string) => path.join(rootDir, u, 'wide');
  const file = (u: string, date: string) => path.join(dir(u), `${date}.json.gz`);
  return {
    async read(underlying, date) {
      try {
        const buf = await fs.readFile(file(underlying, date));
        return JSON.parse((await gunzipAsync(buf)).toString('utf8')) as WideDay;
      } catch {
        return null;
      }
    },
    async write(day) {
      const f = file(day.underlying, day.date);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, await gzipAsync(JSON.stringify(day)));
      await fs.rename(tmp, f);
    },
    async list(underlying) {
      try {
        return (await fs.readdir(dir(underlying)))
          .filter((n) => n.endsWith('.json.gz'))
          .map((n) => n.slice(0, -'.json.gz'.length))
          .sort();
      } catch {
        return [];
      }
    },
  };
}

/** A stored wide day as the trade simulator's OHLC source. */
export function wideOhlcSource(day: WideDay): OhlcSource {
  return {
    series: (kind: OptionKind, strike: number) =>
      (kind === 'CE' ? day.ce : day.pe)[String(strike)] ?? null,
    strikes: (kind: OptionKind) => Object.keys(kind === 'CE' ? day.ce : day.pe).map(Number),
  };
}

// ── fetch ─────────────────────────────────────────────────────────────────────

/** CE and PE strikes to fetch: the day's ATM range, WIDE_STEPS out of the money beyond it. */
export function wideStrikes(spot: Grid, step: number): { ce: number[]; pe: number[] } | null {
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
    ce: range(atmLo - ITM_STEPS * step, atmHi + WIDE_STEPS * step),
    pe: range(atmLo - WIDE_STEPS * step, atmHi + ITM_STEPS * step),
  };
}

interface Point {
  ts?: string | number;
  v: number;
}

function requestBody(underlying: string, date: string, symbols: string[]): object {
  return {
    query: symbols.map((s) => ({
      exchange: MASTER_EXCHANGE[underlying] ?? 'NSE',
      type: 'OPT',
      values: [s],
      fields: ['open', 'high', 'low', 'close'],
      startDate: `${date}T00:00:00.000Z`,
      endDate: `${date}T23:59:59.000Z`,
      interval: '1m',
      intraDay: false,
      realTime: false,
    })),
  };
}

function collect(res: Record<string, unknown>): Map<string, Record<string, Point[]>> {
  const out = new Map<string, Record<string, Point[]>>();
  const groups = (res as { result?: Array<{ values?: Array<Record<string, unknown>> }> }).result;
  for (const group of groups ?? []) {
    for (const symbolMap of group.values ?? []) {
      for (const [sym, data] of Object.entries(symbolMap)) {
        out.set(sym, (data ?? {}) as Record<string, Point[]>);
      }
    }
  }
  return out;
}

/** Paise points → rupee grid for one IST date. */
function toGrid(points: Point[] | undefined, date: string): Grid {
  const g = emptyGrid();
  for (const p of points ?? []) {
    if (p.ts == null) continue;
    let ms: number;
    try {
      ms = Number(BigInt(String(p.ts)) / 1000000n);
    } catch {
      continue;
    }
    const iso = new Date(ms + 19800000).toISOString();
    if (iso.slice(0, 10) !== date) continue;
    const i = minuteIndex(iso.slice(11, 16));
    if (i >= 0 && Number.isFinite(p.v) && p.v > 0) g[i] = p.v / 100;
  }
  return g;
}

const hasData = (g: Grid) => g.some((v) => v != null);

export interface WideDeps {
  post: PostTimeseries;
  pace: () => Promise<void>;
  log?: (msg: string) => void;
}

async function request(deps: WideDeps, b: object): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await deps.pace();
    try {
      return await deps.post(b);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message || '';
      if (/status 404/.test(msg)) throw e; // an unlisted name: asking again cannot help
      const backoff = /429|rate|too many/i.test(msg) ? 30_000 : 2_000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Fetch one day's wide ladder. Returns null only when every request failed — an outage, which must
 * not be stored as "no data".
 */
export async function fetchWideDay(deps: WideDeps, day: DaySeries): Promise<WideDay | null> {
  const step = STRIKE_STEP[day.underlying] ?? 50;
  const strikes = wideStrikes(day.spot, step);
  const out: WideDay = {
    v: 1,
    underlying: day.underlying,
    date: day.date,
    expiry: day.expiry,
    monthly: day.monthly,
    ce: {},
    pe: {},
  };
  if (!strikes) return out;
  const legs = [
    ...strikes.ce.map((k) => ({ k, side: 'CE' as const })),
    ...strikes.pe.map((k) => ({ k, side: 'PE' as const })),
  ].map((l) => ({
    ...l,
    sym: nseOptionSymbol(day.underlying, day.expiry, l.k, l.side, day.monthly),
  }));

  const store = (sym: string, data: Record<string, Point[]> | undefined) => {
    const leg = legs.find((l) => l.sym === sym)!;
    const series: OhlcSeries = {
      o: toGrid(data?.open, day.date),
      h: toGrid(data?.high, day.date),
      l: toGrid(data?.low, day.date),
      c: toGrid(data?.close, day.date),
    };
    if (hasData(series.c)) (leg.side === 'CE' ? out.ce : out.pe)[String(leg.k)] = series;
  };

  let succeeded = 0;
  for (let i = 0; i < legs.length; i += BATCH) {
    const batch = legs.slice(i, i + BATCH).map((l) => l.sym);
    try {
      const res = collect(await request(deps, requestBody(day.underlying, day.date, batch)));
      succeeded++;
      for (const s of batch) store(s, res.get(s));
    } catch {
      // One unlisted strike fails its whole batch: retry the batch one name at a time.
      for (const s of batch) {
        try {
          const res = collect(await request(deps, requestBody(day.underlying, day.date, [s])));
          succeeded++;
          store(s, res.get(s));
        } catch (e) {
          deps.log?.(`[signal wide] ${day.date} ${s}: ${(e as Error).message}`);
        }
      }
    }
  }
  return succeeded ? out : null;
}

// ── background download ───────────────────────────────────────────────────────

export interface WideSyncState {
  running: boolean;
  underlying: string | null;
  done: number;
  total: number;
  failed: number;
  lastError: string | null;
}

export interface WideSync {
  getState(): WideSyncState;
  /** False when a download is already running. */
  start(underlying: string): boolean;
  whenIdle(): Promise<void>;
}

export function createWideSync(deps: {
  analysisStore: DayStore;
  wideStore: WideStore;
  getPost: () => PostTimeseries | null;
  log?: (msg: string) => void;
  minIntervalMs?: number;
}): WideSync {
  const state: WideSyncState = {
    running: false,
    underlying: null,
    done: 0,
    total: 0,
    failed: 0,
    lastError: null,
  };
  const pace = createPacer(deps.minIntervalMs ?? 1500);
  let idle: Promise<void> = Promise.resolve();

  async function run(underlying: string): Promise<void> {
    const [nubra, have] = await Promise.all([
      deps.analysisStore.listDetailed(underlying, 'nubra'),
      deps.wideStore.list(underlying),
    ]);
    const haveSet = new Set(have);
    // Newest first: recent days are the ones without parquet highs/lows at all.
    const todo = nubra
      .filter((d) => !d.empty && !haveSet.has(d.date))
      .map((d) => d.date)
      .reverse();
    state.total = todo.length;
    for (const date of todo) {
      const post = deps.getPost();
      if (!post) {
        state.lastError = 'broker session ended — log in and start again';
        return;
      }
      try {
        const day = await deps.analysisStore.read(underlying, 'nubra', date);
        if (!day || isEmptyDay(day)) {
          state.failed++;
        } else {
          const wide = await fetchWideDay({ post, pace, log: deps.log }, day);
          if (wide) await deps.wideStore.write(wide);
          else {
            state.failed++;
            state.lastError = `every request failed for ${date}`;
          }
        }
      } catch (e) {
        state.failed++;
        state.lastError = `${date}: ${(e as Error).message}`;
      }
      state.done++;
    }
  }

  return {
    getState: () => ({ ...state }),
    start(underlying) {
      if (state.running) return false;
      Object.assign(state, {
        running: true,
        underlying,
        done: 0,
        total: 0,
        failed: 0,
        lastError: null,
      });
      idle = run(underlying)
        .catch((e) => {
          state.lastError = (e as Error).message;
        })
        .finally(() => {
          state.running = false;
          deps.log?.(
            `[signal wide] ${underlying}: ${state.done}/${state.total} days, ${state.failed} failed`,
          );
        });
      return true;
    },
    whenIdle: () => idle,
  };
}
