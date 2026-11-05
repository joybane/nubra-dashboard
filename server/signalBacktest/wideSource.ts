/**
 * Wider option data for Nubra-period days: everything Nubra serves per option minute (open/high/
 * low/close, bid/ask, volume, OI, greeks, IV) for strikes ±WIDE_STEPS around the day's range, stored
 * under `.signal-cache/<UND>/wide/<date>.json.gz`. The Analysis "Update data" sync runs this as its
 * last step, so one download gets everything; it can also be started on its own.
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
 * whole dashboard. "Update data" runs this after its own Nubra phase, never alongside it.
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

/**
 * Everything `charts/timeseries` serves per option minute besides open/high/low/close (field list in
 * docs/vendor/nubra-rest-api-v3-cheatsheet.md). Bid/ask come in paise like the prices; volume and OI
 * are counts; greeks and IV are as Nubra sends them (IV in decimals, off the forward). Nubra has
 * greeks and IV only from about mid-2026, so older days simply come back without them.
 */
export const WIDE_EXTRA_FIELDS = [
  'l1bid',
  'l1ask',
  'tick_volume',
  'cumulative_volume',
  'cumulative_oi',
  'delta',
  'gamma',
  'theta',
  'vega',
  'iv_bid',
  'iv_ask',
  'iv_mid',
] as const;
export type WideExtraField = (typeof WIDE_EXTRA_FIELDS)[number];
export const OHLC_FIELDS = ['open', 'high', 'low', 'close'] as const;
export const ALL_WIDE_FIELDS: readonly string[] = [...OHLC_FIELDS, ...WIDE_EXTRA_FIELDS];
const PAISE_FIELDS = new Set<string>(['open', 'high', 'low', 'close', 'l1bid', 'l1ask']);
const BATCH = 10;
const ATTEMPTS = 3;

export interface WideDay {
  /** 1 = prices only (older downloads); 2 = with `fields` and `more`. */
  v: 1 | 2;
  underlying: string;
  date: string;
  expiry: string;
  monthly: boolean;
  ce: Record<string, OhlcSeries>;
  pe: Record<string, OhlcSeries>;
  /** The fields asked for — all of them, or open/high/low/close when Nubra refused the rest. */
  fields?: string[];
  /** Strike → the extra fields that came back with data (rupees for bid/ask, raw otherwise). */
  more?: {
    ce: Record<string, Partial<Record<WideExtraField, Grid>>>;
    pe: Record<string, Partial<Record<WideExtraField, Grid>>>;
  };
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

function requestBody(
  underlying: string,
  date: string,
  symbols: string[],
  fields: readonly string[],
): object {
  return {
    query: symbols.map((s) => ({
      exchange: MASTER_EXCHANGE[underlying] ?? 'NSE',
      type: 'OPT',
      values: [s],
      fields: [...fields],
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

/**
 * Points → grid for one IST date. Prices and bid/ask are paise → rupees and must be positive; other
 * fields keep any finite value (zero volume, negative theta or put delta are real readings).
 */
function toGrid(points: Point[] | undefined, date: string, paise = true): Grid {
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
    if (i < 0 || !Number.isFinite(p.v)) continue;
    if (paise) {
      if (p.v > 0) g[i] = p.v / 100;
    } else g[i] = p.v;
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
 * Which fields to ask for: all of them, unless Nubra refuses that request for a contract that is
 * certainly listed (the day's at-the-money call) while still answering open/high/low/close — then
 * prices only, so one rejected field name cannot fail every day. Null when even prices fail (an
 * outage: the run carries on with all fields and counts the failures).
 */
export async function pickWideFields(
  deps: WideDeps,
  day: DaySeries,
): Promise<readonly string[] | null> {
  const step = STRIKE_STEP[day.underlying] ?? 50;
  const first = day.spot.find((v) => v != null);
  if (first == null) return ALL_WIDE_FIELDS;
  const atm = Math.round(first / step) * step;
  const sym = nseOptionSymbol(day.underlying, day.expiry, atm, 'CE', day.monthly);
  try {
    await request(deps, requestBody(day.underlying, day.date, [sym], ALL_WIDE_FIELDS));
    return ALL_WIDE_FIELDS;
  } catch (e) {
    try {
      await request(deps, requestBody(day.underlying, day.date, [sym], OHLC_FIELDS));
      deps.log?.(
        `[signal wide] Nubra refused the extra fields (${(e as Error).message}); prices only`,
      );
      return OHLC_FIELDS;
    } catch {
      return null;
    }
  }
}

/**
 * Fetch one day's wide ladder. Returns null only when every request failed — an outage, which must
 * not be stored as "no data".
 */
export async function fetchWideDay(
  deps: WideDeps,
  day: DaySeries,
  fields: readonly string[] = ALL_WIDE_FIELDS,
): Promise<WideDay | null> {
  const step = STRIKE_STEP[day.underlying] ?? 50;
  const strikes = wideStrikes(day.spot, step);
  const extras = WIDE_EXTRA_FIELDS.filter((f) => fields.includes(f));
  const out: WideDay = {
    v: 2,
    underlying: day.underlying,
    date: day.date,
    expiry: day.expiry,
    monthly: day.monthly,
    ce: {},
    pe: {},
    fields: [...fields],
    more: { ce: {}, pe: {} },
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
    if (!hasData(series.c)) return;
    (leg.side === 'CE' ? out.ce : out.pe)[String(leg.k)] = series;
    const more: Partial<Record<WideExtraField, Grid>> = {};
    for (const f of extras) {
      const g = toGrid(data?.[f], day.date, PAISE_FIELDS.has(f));
      if (hasData(g)) more[f] = g;
    }
    if (Object.keys(more).length)
      (leg.side === 'CE' ? out.more!.ce : out.more!.pe)[String(leg.k)] = more;
  };

  let succeeded = 0;
  for (let i = 0; i < legs.length; i += BATCH) {
    const batch = legs.slice(i, i + BATCH).map((l) => l.sym);
    try {
      const res = collect(
        await request(deps, requestBody(day.underlying, day.date, batch, fields)),
      );
      succeeded++;
      for (const s of batch) store(s, res.get(s));
    } catch {
      // One unlisted strike fails its whole batch: retry the batch one name at a time.
      for (const s of batch) {
        try {
          const res = collect(
            await request(deps, requestBody(day.underlying, day.date, [s], fields)),
          );
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
  /** 'all' fields, or 'prices' when Nubra refused the extras; null until the first day is asked. */
  fields: 'all' | 'prices' | null;
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
    fields: null,
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
    let fields: readonly string[] | null = null;
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
          const wd: WideDeps = { post, pace, log: deps.log };
          if (!fields) {
            fields = await pickWideFields(wd, day);
            if (fields) state.fields = fields.length > OHLC_FIELDS.length ? 'all' : 'prices';
          }
          const wide = await fetchWideDay(wd, day, fields ?? ALL_WIDE_FIELDS);
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
        fields: null,
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
