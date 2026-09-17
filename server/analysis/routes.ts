/**
 * HTTP surface of the Analysis tab.
 *
 *   GET  /api/analysis/status       coverage per source, sync progress, validation verdict
 *   POST /api/analysis/sync         start filling the cache (Nubra part needs a broker session)
 *   POST /api/analysis/scan         run the profit-mismatch finder over a date range
 *   GET  /api/analysis/day          one day's spot + the two legs, for the case chart
 *   GET  /api/analysis/validation   the full local-vs-Nubra overlap report
 *
 * Reads never call the broker; everything is served from `.analysis-cache`. Like the parquet
 * backtest routes, they are not behind `requireAuth` — they expose nothing of the account.
 */
import type { FastifyInstance } from 'fastify';
import path from 'path';
import {
  DEFAULT_FINDER_PARAMS,
  findCases,
  pickLegs,
  type AnalysisCase,
  type DayLegs,
  type FinderParams,
} from './caseFinder.ts';
import {
  SESSION_BARS,
  createDayStore,
  hhmmAt,
  isEmptyDay,
  minuteIndex,
  type DaySource,
  type DayStore,
  type Grid,
} from './daySeries.ts';
import type { PostTimeseries } from './nubraSource.ts';
import { createAnalysisSync, type AnalysisSync } from './sync.ts';
import { readValidationReport } from './validation.ts';

const UNDERLYINGS = ['NIFTY'] as const;
type AnalysisUnderlying = (typeof UNDERLYINGS)[number];

export interface AnalysisRouteDeps {
  fastify: FastifyInstance;
  /** Repo root; the cache and the instrument-master directories hang off it. */
  rootDir: string;
  getPost: () => PostTimeseries | null;
  /** Injected by tests. */
  store?: DayStore;
  sync?: AnalysisSync;
}

export interface ScanDay {
  date: string;
  source: DaySource;
  expiry: string;
  legs: DayLegs;
  cases: AnalysisCase[];
}

export interface ScanResponse {
  ok: true;
  underlying: string;
  params: FinderParams;
  from: string | null;
  to: string | null;
  includeLocalOnly: boolean;
  days: ScanDay[];
  summary: {
    daysScanned: number;
    daysWithCases: number;
    cases: number;
    nubraDays: number;
    localDays: number;
    skipped: Record<string, number>;
    ms: number;
  };
}

function normalizeUnderlying(raw: unknown): AnalysisUnderlying | null {
  const u = String(raw ?? 'NIFTY').toUpperCase();
  return (UNDERLYINGS as readonly string[]).includes(u) ? (u as AnalysisUnderlying) : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Merge a client's partial params over the defaults, rejecting anything out of range. */
export function parseFinderParams(raw: unknown): FinderParams | string {
  // Known keys only: a browser holding settings from an older build still sends `spotTolerance` or
  // `strikeTolerance`, and a stale ±5 must not override the tighter default.
  const given = (raw ?? {}) as Record<string, unknown>;
  const p = { ...DEFAULT_FINDER_PARAMS };
  for (const key of Object.keys(DEFAULT_FINDER_PARAMS) as Array<keyof FinderParams>) {
    if (given[key] !== undefined) (p as Record<string, unknown>)[key] = given[key];
  }
  for (const key of ['entryTime', 'exitTime'] as const) {
    if (!HHMM.test(String(p[key])) || minuteIndex(p[key]) < 0) {
      return `${key} must be HH:MM between 09:15 and 15:29`;
    }
  }
  if (p.exitTime <= p.entryTime) return 'exitTime must be after entryTime';
  const numeric: Array<[keyof FinderParams, number, number]> = [
    ['closeTolerance', 0, 500],
    ['minGapMinutes', 1, SESSION_BARS],
    ['maxCasesPerDay', 1, 50],
    ['spacingMinutes', 0, SESSION_BARS],
    ['minAbsPnl', 0, 1e9],
    ['qty', 1, 1e6],
    ['strikeOffset', -20, 20],
    ['legMismatchPct', 0, 200],
  ];
  for (const [key, min, max] of numeric) {
    const v = Number(p[key]);
    if (!Number.isFinite(v) || v < min || v > max)
      return `${key} must be between ${min} and ${max}`;
    (p as unknown as Record<string, number>)[key] = v;
  }
  if (p.side !== 'SELL' && p.side !== 'BUY') return 'side must be SELL or BUY';
  if (p.rankBy !== 'total' && p.rankBy !== 'legGap') return 'rankBy must be total or legGap';
  return p;
}

/** Which source answers for each date: Nubra wherever it has data, the parquet tree elsewhere. */
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

function coverage(listing: Array<{ date: string; empty: boolean }>) {
  const data = listing.filter((d) => !d.empty);
  return {
    days: data.length,
    empty: listing.length - data.length,
    from: data[0]?.date ?? null,
    to: data[data.length - 1]?.date ?? null,
  };
}

export function registerAnalysisRoutes(deps: AnalysisRouteDeps): void {
  const { fastify, rootDir, getPost } = deps;
  const store = deps.store ?? createDayStore(path.join(rootDir, '.analysis-cache'));
  const sync =
    deps.sync ??
    createAnalysisSync({
      store,
      masterDirs: [path.join(rootDir, '.refdata-cache'), path.join(rootDir, '.refdata-live')],
      getPost,
      log: (msg) => console.log(msg),
    });

  // A scan over five years reads ~1,400 files; the same scan asked twice should not.
  const scanCache = new Map<string, ScanResponse>();
  const SCAN_CACHE_MAX = 6;

  fastify.get<{ Querystring: { underlying?: string } }>(
    '/api/analysis/status',
    async (req, reply) => {
      const underlying = normalizeUnderlying(req.query.underlying);
      if (!underlying) {
        reply.code(400);
        return { ok: false, error: `unsupported underlying ${req.query.underlying}` };
      }
      const [nubra, local, report] = await Promise.all([
        store.listDetailed(underlying, 'nubra'),
        store.listDetailed(underlying, 'local'),
        readValidationReport(store, underlying),
      ]);
      const nubraDates = new Set(nubra.filter((d) => !d.empty).map((d) => d.date));
      const localOnly = local.filter((d) => !d.empty && !nubraDates.has(d.date));
      return {
        ok: true,
        underlying,
        coverage: {
          nubra: coverage(nubra),
          local: coverage(local),
          localOnly: coverage(localOnly),
        },
        sync: sync.getState(),
        brokerSession: getPost() != null,
        validation: report
          ? {
              generatedAt: report.generatedAt,
              days: report.days,
              from: report.from,
              to: report.to,
              summary: report.summary,
              verdict: report.verdict,
            }
          : null,
      };
    },
  );

  fastify.post<{ Body: { underlying?: string } }>('/api/analysis/sync', async (req, reply) => {
    const underlying = normalizeUnderlying(req.body?.underlying);
    if (!underlying) {
      reply.code(400);
      return { ok: false, error: `unsupported underlying ${req.body?.underlying}` };
    }
    const started = sync.start(underlying);
    return { ok: true, started, sync: sync.getState() };
  });

  fastify.get<{ Querystring: { underlying?: string } }>(
    '/api/analysis/validation',
    async (req, reply) => {
      const underlying = normalizeUnderlying(req.query.underlying);
      const report = underlying ? await readValidationReport(store, underlying) : null;
      if (!report) {
        reply.code(404);
        return { ok: false, error: 'no validation report yet — run a sync first' };
      }
      return { ok: true, report };
    },
  );

  fastify.post<{
    Body: {
      underlying?: string;
      params?: Partial<FinderParams>;
      from?: string;
      to?: string;
      includeLocalOnly?: boolean;
    };
  }>('/api/analysis/scan', async (req, reply) => {
    const body = req.body ?? {};
    const underlying = normalizeUnderlying(body.underlying);
    if (!underlying) {
      reply.code(400);
      return { ok: false, error: `unsupported underlying ${body.underlying}` };
    }
    const params = parseFinderParams(body.params);
    if (typeof params === 'string') {
      reply.code(400);
      return { ok: false, error: params };
    }
    const from = body.from && ISO.test(body.from) ? body.from : null;
    const to = body.to && ISO.test(body.to) ? body.to : null;
    const includeLocalOnly = body.includeLocalOnly !== false;

    const started = Date.now();
    const plan = (await sourcePlan(store, underlying, includeLocalOnly)).filter(
      (d) => (!from || d.date >= from) && (!to || d.date <= to),
    );

    // The plan's shape is part of the key, so a sync that adds days invalidates it naturally.
    const key = JSON.stringify([
      underlying,
      params,
      from,
      to,
      includeLocalOnly,
      plan.length,
      plan.at(-1),
    ]);
    const hit = scanCache.get(key);
    if (hit) return hit;

    const days: ScanDay[] = [];
    const skipped: Record<string, number> = {};
    let nubraDays = 0;
    let localDays = 0;
    const CHUNK = 16;
    for (let i = 0; i < plan.length; i += CHUNK) {
      const chunk = plan.slice(i, i + CHUNK);
      const loaded = await Promise.all(chunk.map((d) => store.read(underlying, d.source, d.date)));
      loaded.forEach((day, n) => {
        const { date, source } = chunk[n];
        if (!day || isEmptyDay(day)) {
          skipped['unreadable'] = (skipped['unreadable'] ?? 0) + 1;
          return;
        }
        const scan = findCases(day, params);
        if (!scan.ok) {
          const reason = scan.reason.replace(/\d{4,5}/g, 'K');
          skipped[reason] = (skipped[reason] ?? 0) + 1;
          return;
        }
        if (source === 'nubra') nubraDays++;
        else localDays++;
        days.push({ date, source, expiry: day.expiry, legs: scan.legs, cases: scan.cases });
      });
    }

    const response: ScanResponse = {
      ok: true,
      underlying,
      params,
      from,
      to,
      includeLocalOnly,
      days,
      summary: {
        daysScanned: plan.length,
        daysWithCases: days.filter((d) => d.cases.length).length,
        cases: days.reduce((s, d) => s + d.cases.length, 0),
        nubraDays,
        localDays,
        skipped,
        ms: Date.now() - started,
      },
    };
    scanCache.set(key, response);
    if (scanCache.size > SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value!);
    return response;
  });

  fastify.get<{
    Querystring: {
      underlying?: string;
      date?: string;
      source?: string;
      entryTime?: string;
      strikeOffset?: string;
    };
  }>('/api/analysis/day', async (req, reply) => {
    const q = req.query;
    const underlying = normalizeUnderlying(q.underlying);
    if (!underlying || !q.date || !ISO.test(q.date)) {
      reply.code(400);
      return { ok: false, error: 'underlying and date (YYYY-MM-DD) are required' };
    }
    const params = parseFinderParams({
      entryTime: q.entryTime ?? DEFAULT_FINDER_PARAMS.entryTime,
      strikeOffset: q.strikeOffset ?? DEFAULT_FINDER_PARAMS.strikeOffset,
    });
    if (typeof params === 'string') {
      reply.code(400);
      return { ok: false, error: params };
    }
    const sources: DaySource[] =
      q.source === 'local' ? ['local'] : q.source === 'nubra' ? ['nubra'] : ['nubra', 'local'];
    for (const source of sources) {
      const day = await store.read(underlying, source, q.date);
      if (!day || isEmptyDay(day)) continue;
      const legs = pickLegs(day, params);
      if (typeof legs === 'string') {
        reply.code(422);
        return { ok: false, error: legs };
      }
      const ce: Grid = day.ce[String(legs.ceStrike)];
      const pe: Grid = day.pe[String(legs.peStrike)];
      return {
        ok: true,
        underlying,
        date: day.date,
        source,
        expiry: day.expiry,
        monthly: day.monthly,
        legs,
        minutes: Array.from({ length: SESSION_BARS }, (_, i) => hhmmAt(i)),
        spot: day.spot,
        spotOhlc: day.spotOhlc ?? null,
        ce,
        pe,
      };
    }
    reply.code(404);
    return { ok: false, error: `no data for ${underlying} on ${q.date}` };
  });
}
