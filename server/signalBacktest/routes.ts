/**
 * HTTP surface of the Signal Backtest tab.
 *
 *   POST /api/signal-backtest/run          first mismatch case per day → one option trade → exit
 *   GET  /api/signal-backtest/day          one day's spot, reference-leg closes and greeks, for the chart
 *   GET  /api/signal-backtest/wide/status  wide Nubra ladder coverage and download progress
 *   POST /api/signal-backtest/wide/sync    download the wide ladder for Nubra days missing it
 *
 * Read-only over the Analysis tab's `.analysis-cache` (never syncs, never writes). Option
 * open/high/low come from this tab's own `.signal-cache` (wide Nubra ladder) or, failing that, the
 * local parquet tree. The signal rules are the Analysis ones, validated by the Analysis
 * `parseFinderParams`; nothing in server/analysis is changed or re-registered here.
 */
import type { FastifyInstance } from 'fastify';
import path from 'path';
import type { FinderParams } from '../analysis/caseFinder.ts';
import {
  createDayStore,
  isEmptyDay,
  minuteIndex,
  type DaySource,
  type DayStore,
  type Grid,
  type StoredDay,
} from '../analysis/daySeries.ts';
import type { PostTimeseries } from '../analysis/nubraSource.ts';
import { parseFinderParams } from '../analysis/routes.ts';
import { readValidationReport } from '../analysis/validation.ts';
import {
  dayGreekSeries,
  signalGreeks,
  type DayGreekSeries,
  type SignalGreeks,
} from '../analysis/greeks.ts';
import { daysToExpiry } from './expiry.ts';
import { createParquetOhlcLoaderFor, type OhlcLoader } from './ohlc.ts';
import { createPremiumSetsBuilder, type PremiumSetsResponse } from './premiumSets.ts';
import { firstSignal, type FirstSignal } from './signalFinder.ts';
import {
  createWideStore,
  createWideSync,
  wideOhlcSource,
  type WideStore,
  type WideSync,
} from './wideSource.ts';
import {
  DEFAULT_TRADE_PARAMS,
  legCloses,
  premiumUniverse,
  simulateSignalTrade,
  type OhlcSource,
  type OptionKind,
  type PremiumRange,
  type PremiumUniverse,
  type SignalTrade,
  type TradeParams,
} from './trade.ts';

const UNDERLYINGS = ['NIFTY', 'SENSEX'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export interface SignalBacktestDeps {
  fastify: FastifyInstance;
  /** Repo root; the analysis cache hangs off it. */
  rootDir: string;
  /** Broker chart-history call, while a session exists; only the wide download uses it. */
  getPost?: () => PostTimeseries | null;
  /** Injected by tests. */
  store?: DayStore;
  loadOhlc?: OhlcLoader;
  wideStore?: WideStore;
  wideSync?: WideSync;
}

export interface SignalBacktestRow {
  date: string;
  source: DaySource;
  expiry: string;
  /**
   * Trading days from this date to its expiry: 0 on the expiry day, 1 the day before ("expiry-1"),
   * and so on. Null when the expiry is not after the date.
   */
  dte: number | null;
  /** Where the trade's open/high/low came from, if anywhere. */
  ohlcSource: 'nubra-wide' | 'parquet' | null;
  /** The signal, with the reference strangle's greeks at t1 and t2 (null where a leg cannot be priced). */
  signal: Omit<FirstSignal, 't2Index'> & { greeks: SignalGreeks };
  trade: SignalTrade;
}

/** One day of the signal's reference strangle: spot, the two closes and their greeks, per minute. */
export interface SignalDayResponse {
  ok: true;
  underlying: string;
  date: string;
  source: DaySource;
  expiry: string;
  ceStrike: number;
  peStrike: number;
  spot: Grid;
  ce: Grid;
  pe: Grid;
  greeks: DayGreekSeries;
  /** The legs asked for (the ones the trade sold): their closes every minute, null if not stored. */
  legs: Array<{ kind: OptionKind; strike: number; close: Grid | null }>;
}

interface Extreme {
  date: string;
  value: number;
}

export interface SignalBacktestSummary {
  daysScanned: number;
  daysWithSignal: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  best: Extreme | null;
  worst: Extreme | null;
  avgMaxProfit: number;
  avgMaxLoss: number;
  biggestMaxProfit: Extreme | null;
  biggestMaxLoss: Extreme | null;
  nubraDays: number;
  localDays: number;
  ohlcTrades: number;
  closeTrades: number;
  skipped: Record<string, number>;
  ms: number;
}

export interface SignalBacktestResponse {
  ok: true;
  underlying: string;
  signalParams: FinderParams;
  tradeParams: TradeParams;
  from: string | null;
  to: string | null;
  includeLocalOnly: boolean;
  useHighLow: boolean;
  rows: SignalBacktestRow[];
  skipped: Array<{ date: string; source: DaySource; reason: string }>;
  summary: SignalBacktestSummary;
  /**
   * Where the sellable option prices bunch at the entry minute, per distance from expiry, for the premium range
   * picker. Built from the same days, entry minutes and strikes as the trades above.
   */
  premiumSets: PremiumSetsResponse;
}

/**
 * A map keyed by trading days to expiry ("0" = the expiry day), as sent for the per-distance
 * overrides. A missing or null entry means "no override"; anything else must pass `parseValue`,
 * which returns the clean value or a message.
 */
function parseDteMap<T>(
  raw: unknown,
  parseValue: (v: unknown) => T | string,
): Record<string, T> | string {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'overrides by days to expiry must be an object keyed by 0, 1, 2… (a missing key = none)';
  }
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d{1,2}$/.test(k)) return `days to expiry must be a small whole number, got "${k}"`;
    if (v == null) continue;
    const clean = parseValue(v);
    if (typeof clean === 'string') return clean;
    out[String(Number(k))] = clean;
  }
  return out;
}

/** Merge a client's partial trade params over the defaults, rejecting anything out of range. */
export function parseTradeParams(raw: unknown): TradeParams | string {
  const given = (raw ?? {}) as Record<string, unknown>;
  const p = { ...DEFAULT_TRADE_PARAMS };
  for (const key of Object.keys(DEFAULT_TRADE_PARAMS) as Array<keyof TradeParams>) {
    if (given[key] !== undefined) (p as Record<string, unknown>)[key] = given[key];
  }
  if (p.legs !== 'CE' && p.legs !== 'PE' && p.legs !== 'BOTH') return 'legs must be CE, PE or BOTH';
  if (p.side !== 'BUY' && p.side !== 'SELL') return 'side must be BUY or SELL';
  if (p.strikeMode !== 'OTM' && p.strikeMode !== 'PREMIUM') {
    return 'strikeMode must be OTM or PREMIUM';
  }
  if (!HHMM.test(String(p.exitTime)) || minuteIndex(p.exitTime) < 0) {
    return 'exitTime must be HH:MM between 09:15 and 15:29';
  }
  for (const leg of ['ce', 'pe'] as const) {
    const lo = Number(p[`${leg}PremiumMin`]);
    const hi = Number(p[`${leg}PremiumMax`]);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 100000 || lo > hi) {
      return `${leg.toUpperCase()} premium range must be 0 ≤ min ≤ max`;
    }
    p[`${leg}PremiumMin`] = lo;
    p[`${leg}PremiumMax`] = hi;
  }
  const ints: Array<[keyof TradeParams, number, number]> = [
    ['otmSteps', 0, 10],
    ['delayMinutes', 0, 120],
    ['lots', 1, 100],
  ];
  for (const [key, min, max] of ints) {
    const v = Number(p[key]);
    if (!Number.isInteger(v) || v < min || v > max) {
      return `${key} must be a whole number between ${min} and ${max}`;
    }
    (p as unknown as Record<string, number>)[key] = v;
  }
  if (typeof p.premiumTiersOnly !== 'boolean') return 'premiumTiersOnly must be true or false';
  for (const key of ['cePremiumByDte', 'pePremiumByDte'] as const) {
    const clean = parseDteMap(p[key], (v) => {
      const lo = Array.isArray(v) ? Number(v[0]) : NaN;
      const hi = Array.isArray(v) ? Number(v[1]) : NaN;
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 100000 || lo > hi) {
        return `each ${key} entry must be [min, max] with 0 ≤ min ≤ max`;
      }
      return [lo, hi] as PremiumRange;
    });
    if (typeof clean === 'string') return clean.replace('{key}', key);
    p[key] = clean;
  }
  const steps = parseDteMap(p.otmStepsByDte, (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10) {
      return 'each otmStepsByDte entry must be a whole number between 0 and 10';
    }
    return n;
  });
  if (typeof steps === 'string') return steps;
  p.otmStepsByDte = steps;
  return p;
}

/** Which source answers for each date: Nubra wherever it has data, the parquet-built days elsewhere. */
async function sourcePlan(
  store: DayStore,
  underlying: string,
  includeLocalOnly: boolean,
): Promise<Array<{ date: string; source: DaySource }>> {
  const [nubra, local] = await Promise.all([
    store.listDetailed(underlying, 'nubra'),
    store.listDetailed(underlying, 'local'),
  ]);
  const plan = new Map<string, DaySource>();
  if (includeLocalOnly) for (const d of local) if (!d.empty) plan.set(d.date, 'local');
  for (const d of nubra) if (!d.empty) plan.set(d.date, 'nubra');
  return [...plan]
    .map(([date, source]) => ({ date, source }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const OHLC_SOURCES = ['nubra-wide', 'parquet'] as const;

/** "CE:23350,PE:23150" → the legs of a trade, or a message saying what is wrong with it. */
function parseLegs(raw: string | undefined): Array<{ kind: OptionKind; strike: number }> | string {
  if (!raw) return [];
  const legs: Array<{ kind: OptionKind; strike: number }> = [];
  for (const part of raw.split(',')) {
    const m = /^(CE|PE):(\d{1,7})$/.exec(part);
    if (!m || legs.some((l) => l.kind === m[1])) {
      return 'legs must look like CE:23350,PE:23150 (at most one of each)';
    }
    legs.push({ kind: m[1] as OptionKind, strike: Number(m[2]) });
  }
  return legs;
}

export function summarize(
  rows: SignalBacktestRow[],
  daysScanned: number,
  skipped: Record<string, number>,
  ms: number,
): SignalBacktestSummary {
  const pnls = rows.map((r) => r.trade.pnl);
  const total = pnls.reduce((s, v) => s + v, 0);
  const pick = (
    value: (r: SignalBacktestRow) => number,
    better: (a: number, b: number) => boolean,
  ) =>
    rows.reduce<Extreme | null>(
      (m, r) => (m == null || better(value(r), m.value) ? { date: r.date, value: value(r) } : m),
      null,
    );
  const wins = pnls.filter((v) => v > 0).length;
  const n = rows.length;
  return {
    daysScanned,
    // A day whose signal fired but whose trade could not be placed still had a signal.
    daysWithSignal: n + countTradeSkips(skipped),
    trades: n,
    wins,
    losses: pnls.filter((v) => v < 0).length,
    winRate: n ? r2((wins / n) * 100) : 0,
    totalPnl: r2(total),
    avgPnl: n ? r2(total / n) : 0,
    best: pick(
      (r) => r.trade.pnl,
      (a, b) => a > b,
    ),
    worst: pick(
      (r) => r.trade.pnl,
      (a, b) => a < b,
    ),
    avgMaxProfit: n ? r2(rows.reduce((s, r) => s + r.trade.maxProfit, 0) / n) : 0,
    avgMaxLoss: n ? r2(rows.reduce((s, r) => s + r.trade.maxLoss, 0) / n) : 0,
    biggestMaxProfit: pick(
      (r) => r.trade.maxProfit,
      (a, b) => a > b,
    ),
    biggestMaxLoss: pick(
      (r) => r.trade.maxLoss,
      (a, b) => a < b,
    ),
    nubraDays: rows.filter((r) => r.source === 'nubra').length,
    localDays: rows.filter((r) => r.source === 'local').length,
    ohlcTrades: rows.filter((r) => r.trade.basis === 'ohlc').length,
    closeTrades: rows.filter((r) => r.trade.basis !== 'ohlc').length,
    skipped,
    ms,
  };
}

/** Skips that happened after a signal was found (the trade itself could not be placed). */
const TRADE_SKIP_PREFIX = 'trade: ';
function countTradeSkips(skipped: Record<string, number>): number {
  let n = 0;
  for (const [reason, count] of Object.entries(skipped)) {
    if (reason.startsWith(TRADE_SKIP_PREFIX)) n += count;
  }
  return n;
}

export function registerSignalBacktestRoutes(deps: SignalBacktestDeps): void {
  const { fastify, rootDir } = deps;
  const rawStore = deps.store ?? createDayStore(path.join(rootDir, '.analysis-cache'));
  const loadOhlc = deps.loadOhlc ?? createParquetOhlcLoaderFor(path.join(rootDir, '.signal-cache'));
  const wideStore = deps.wideStore ?? createWideStore(path.join(rootDir, '.signal-cache'));
  const getPost = deps.getPost ?? (() => null);
  const wideSync =
    deps.wideSync ??
    createWideSync({
      analysisStore: rawStore,
      wideStore,
      getPost,
      log: (msg) => console.log(msg),
    });

  /**
   * The open/high/low source a day's trade uses: the wide Nubra ladder first (same source as the
   * day's closes, small files); the parquet tree otherwise, when allowed. Neither is required:
   * closes price the trade.
   */
  const resolveOhlc = async (
    underlying: string,
    date: string,
    source: DaySource,
    expiry: string,
    parquet: boolean,
  ): Promise<{ ohlc: OhlcSource | null; ohlcSource: SignalBacktestRow['ohlcSource'] }> => {
    const wide = source === 'nubra' ? await wideStore.read(underlying, date) : null;
    if (wide && wide.expiry === expiry) {
      return { ohlc: wideOhlcSource(wide), ohlcSource: 'nubra-wide' };
    }
    if (parquet) {
      try {
        const ohlc = await loadOhlc(underlying, date, expiry);
        if (ohlc) return { ohlc, ohlcSource: 'parquet' };
      } catch {
        /* the parquet tree is optional */
      }
    }
    return { ohlc: null, ohlcSource: null };
  };

  // Parsed days are pure functions of their files; keep them across runs like the Analysis routes
  // do, so changing a trade setting does not re-read and re-gunzip every day. Read-only: the
  // cache files are only ever written by the Analysis sync, which this module never calls.
  const dayCache = new Map<string, StoredDay | null>();
  const DAY_CACHE_MAX = 6000;
  const readDay = async (underlying: string, source: DaySource, date: string) => {
    const k = `${underlying}|${source}|${date}`;
    if (dayCache.has(k)) return dayCache.get(k)!;
    const day = await rawStore.read(underlying, source, date);
    // An unreadable or missing file is not cached: a later sync may fill it.
    if (day) {
      dayCache.set(k, day);
      if (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value!);
    }
    return day;
  };

  fastify.post<{
    Body: {
      underlying?: string;
      signalParams?: Partial<FinderParams>;
      tradeParams?: Partial<TradeParams>;
      from?: string;
      to?: string;
      includeLocalOnly?: boolean;
      /** Read option open/high/low from the parquet tree (default true). Off = closes only, fast. */
      useHighLow?: boolean;
    };
  }>('/api/signal-backtest/run', async (req, reply) => {
    const body = req.body ?? {};
    const underlying = String(body.underlying ?? 'NIFTY').toUpperCase();
    if (!(UNDERLYINGS as readonly string[]).includes(underlying)) {
      reply.code(400);
      return { ok: false, error: `unsupported underlying ${body.underlying}` };
    }
    const signalParams = parseFinderParams(body.signalParams);
    if (typeof signalParams === 'string') {
      reply.code(400);
      return { ok: false, error: signalParams };
    }
    const tradeParams = parseTradeParams(body.tradeParams);
    if (typeof tradeParams === 'string') {
      reply.code(400);
      return { ok: false, error: tradeParams };
    }
    const from = body.from && ISO.test(body.from) ? body.from : null;
    const to = body.to && ISO.test(body.to) ? body.to : null;
    // Same rule the Analysis tab follows: local-only days count while the data check passes.
    const includeLocalOnly =
      typeof body.includeLocalOnly === 'boolean'
        ? body.includeLocalOnly
        : ((await readValidationReport(rawStore, underlying))?.verdict.ok ?? false);
    // Parquet reads dominate a long run (~4–5 min for the full NIFTY history, even warm: the data
    // layer's caches hold ~200 days). Closes alone take seconds, for quick exploration.
    const useHighLow = body.useHighLow !== false;

    const started = Date.now();
    const everyDay = await sourcePlan(rawStore, underlying, includeLocalOnly);
    // Days to expiry count along every day the data holds, not just the ones in the From / To range.
    const calendar = everyDay.map((d) => d.date);
    const plan = everyDay.filter((d) => (!from || d.date >= from) && (!to || d.date <= to));

    const rows: SignalBacktestRow[] = [];
    const skippedDays: SignalBacktestResponse['skipped'] = [];
    const skipped: Record<string, number> = {};
    const skip = (date: string, source: DaySource, reason: string, bucket: string) => {
      skippedDays.push({ date, source, reason });
      skipped[bucket] = (skipped[bucket] ?? 0) + 1;
    };

    const premium = createPremiumSetsBuilder();
    const CHUNK = 16;
    for (let i = 0; i < plan.length; i += CHUNK) {
      const chunk = plan.slice(i, i + CHUNK);
      type DayOutcome =
        | { kind: 'row'; row: SignalBacktestRow; universe: PremiumUniverse | null }
        | {
            kind: 'skip';
            date: string;
            source: DaySource;
            reason: string;
            signalled: boolean;
            universe: PremiumUniverse | null;
            /** Trading days to expiry, for the premium sets of a day whose trade could not be placed. */
            dte: number | null;
          };
      const results = await Promise.all(
        chunk.map(async ({ date, source }): Promise<DayOutcome> => {
          const day = await readDay(underlying, source, date);
          if (!day || isEmptyDay(day)) {
            return {
              kind: 'skip',
              date,
              source,
              reason: 'unreadable day',
              signalled: false,
              universe: null,
              dte: null,
            };
          }
          const sig = firstSignal(day, signalParams);
          if (!sig.ok) {
            return {
              kind: 'skip',
              date,
              source,
              reason: sig.reason,
              signalled: false,
              universe: null,
              dte: null,
            };
          }
          const dte = daysToExpiry(date, day.expiry, calendar);
          const { ohlc, ohlcSource } = await resolveOhlc(
            underlying,
            date,
            source,
            day.expiry,
            useHighLow,
          );
          // What a premium rule could sell at this entry minute, whichever way the trade itself is
          // placed: the premium picker needs it even on days the trade could not be made.
          const universe = premiumUniverse(
            day,
            sig.signal.t2Index + tradeParams.delayMinutes,
            ohlc,
          );
          const trade = simulateSignalTrade(day, sig.signal.t2Index, tradeParams, ohlc, dte);
          if (!trade.ok) {
            return {
              kind: 'skip',
              date,
              source,
              reason: trade.reason,
              signalled: true,
              universe,
              dte,
            };
          }
          const { t2Index, ...found } = sig.signal;
          const greeks = signalGreeks(day, found.legs, minuteIndex(found.t1), t2Index);
          return {
            kind: 'row',
            row: {
              date,
              source,
              expiry: day.expiry,
              dte,
              ohlcSource,
              signal: { ...found, greeks },
              trade: trade.trade,
            },
            universe,
          };
        }),
      );
      for (const r of results) {
        if (r.universe) premium.add(r.kind === 'row' ? r.row.dte : r.dte, r.universe);
        if (r.kind === 'row') {
          rows.push(r.row);
          continue;
        }
        // Group reasons without their strike/time numbers so the summary stays short.
        const generic = r.reason.replace(/\d{4,6}/g, 'K').replace(/\d{2}:\d{2}/g, 'HH:MM');
        skip(r.date, r.source, r.reason, r.signalled ? `${TRADE_SKIP_PREFIX}${generic}` : generic);
      }
      // A multi-year run is CPU- and disk-bound; let price feeds and other requests interleave.
      await new Promise((resolve) => setImmediate(resolve));
    }

    const response: SignalBacktestResponse = {
      ok: true,
      underlying,
      signalParams,
      tradeParams,
      from,
      to,
      includeLocalOnly,
      useHighLow,
      rows,
      skipped: skippedDays,
      summary: summarize(rows, plan.length, skipped, Date.now() - started),
      premiumSets: premium.build(),
    };
    return response;
  });

  // The chart under a row: the day's spot, the two reference closes and their greeks every minute,
  // and the closes of the legs the trade sold (`legs`, with `ohlc` naming the row's price source
  // so strikes beyond the ladder are found). Read-only over the same cache the run reads; the row
  // supplies source and strikes, so nothing here re-derives the signal.
  fastify.get<{
    Querystring: {
      underlying?: string;
      date?: string;
      source?: string;
      ceStrike?: string;
      peStrike?: string;
      legs?: string;
      ohlc?: string;
    };
  }>('/api/signal-backtest/day', async (req, reply) => {
    const q = req.query;
    const underlying = String(q.underlying ?? 'NIFTY').toUpperCase();
    if (!(UNDERLYINGS as readonly string[]).includes(underlying)) {
      reply.code(400);
      return { ok: false, error: `unsupported underlying ${q.underlying}` };
    }
    const date = String(q.date ?? '');
    if (!ISO.test(date)) {
      reply.code(400);
      return { ok: false, error: 'date must be YYYY-MM-DD' };
    }
    if (q.source !== 'nubra' && q.source !== 'local') {
      reply.code(400);
      return { ok: false, error: 'source must be nubra or local' };
    }
    const ceStrike = Number(q.ceStrike);
    const peStrike = Number(q.peStrike);
    if (
      !Number.isInteger(ceStrike) ||
      !Number.isInteger(peStrike) ||
      ceStrike <= 0 ||
      peStrike <= 0
    ) {
      reply.code(400);
      return { ok: false, error: 'ceStrike and peStrike must be strike prices' };
    }
    const tradeLegs = parseLegs(q.legs);
    if (typeof tradeLegs === 'string') {
      reply.code(400);
      return { ok: false, error: tradeLegs };
    }
    const wanted = q.ohlc as (typeof OHLC_SOURCES)[number] | undefined;
    if (wanted !== undefined && !OHLC_SOURCES.includes(wanted)) {
      reply.code(400);
      return { ok: false, error: 'ohlc must be nubra-wide or parquet' };
    }
    const day = await readDay(underlying, q.source, date);
    if (!day || isEmptyDay(day)) {
      reply.code(404);
      return { ok: false, error: `no ${q.source} data for ${date}` };
    }
    const ce = day.ce[String(ceStrike)];
    const pe = day.pe[String(peStrike)];
    if (!ce || !pe) {
      reply.code(404);
      return { ok: false, error: `${date} holds no ${ceStrike} CE / ${peStrike} PE` };
    }
    // Strikes beyond the day's ladder (a premium rule can sell them) live in the row's price source.
    const { ohlc } =
      wanted && tradeLegs.length
        ? await resolveOhlc(underlying, date, q.source, day.expiry, wanted === 'parquet')
        : { ohlc: null };
    const response: SignalDayResponse = {
      ok: true,
      underlying,
      date,
      source: q.source,
      expiry: day.expiry,
      ceStrike,
      peStrike,
      spot: day.spot,
      ce,
      pe,
      greeks: dayGreekSeries(day, { ceStrike, peStrike }),
      legs: tradeLegs.map((l) => ({ ...l, close: legCloses(day, l.kind, l.strike, ohlc) })),
    };
    return response;
  });

  fastify.get<{ Querystring: { underlying?: string } }>(
    '/api/signal-backtest/wide/status',
    async (req, reply) => {
      const underlying = String(req.query.underlying ?? 'NIFTY').toUpperCase();
      if (!(UNDERLYINGS as readonly string[]).includes(underlying)) {
        reply.code(400);
        return { ok: false, error: `unsupported underlying ${req.query.underlying}` };
      }
      const [nubra, have] = await Promise.all([
        rawStore.listDetailed(underlying, 'nubra'),
        wideStore.list(underlying),
      ]);
      const haveSet = new Set(have);
      const nubraDays = nubra.filter((d) => !d.empty);
      return {
        ok: true,
        underlying,
        nubraDays: nubraDays.length,
        wideDays: nubraDays.filter((d) => haveSet.has(d.date)).length,
        brokerSession: getPost() != null,
        sync: wideSync.getState(),
      };
    },
  );

  fastify.post<{ Body: { underlying?: string } }>(
    '/api/signal-backtest/wide/sync',
    async (req, reply) => {
      const underlying = String(req.body?.underlying ?? 'NIFTY').toUpperCase();
      if (!(UNDERLYINGS as readonly string[]).includes(underlying)) {
        reply.code(400);
        return { ok: false, error: `unsupported underlying ${req.body?.underlying}` };
      }
      if (!getPost()) {
        reply.code(409);
        return {
          ok: false,
          error: 'log in to the broker first — the download reads Nubra history',
        };
      }
      const started = wideSync.start(underlying);
      return { ok: true, started, sync: wideSync.getState() };
    },
  );
}
