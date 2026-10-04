import type { FastifyInstance, FastifyReply } from 'fastify';
import { createBacktestRefdataStore, type BacktestRefdataStore } from './backtestRefdataStore.ts';
import {
  createBacktestBarStore,
  type BacktestBarStore,
  type BarPayload,
} from './backtestBarStore.ts';
import { describeUpstreamError } from './upstreamError.ts';
import {
  TICK_RETENTION_MS,
  decayCaseDto,
  replayDecay,
  tickCoverageStart,
  type SecondCloses,
} from './backtestDecay.ts';
import { formatHms, parseSecondBars } from './intradayBars.ts';
import { istDate, istMinuteToMs, sessionMinutes, type StrategyLegs } from './mismatchTracker.ts';
import {
  isLocalUnderlying,
  istDatesBetween,
  localBarAt,
  localContractName,
  localDay,
  localExpiriesFor,
  localGreeksFor,
  parseLocalContractName,
  parseSourcePref,
  resolveSource,
  type DataSource,
  type LocalBar,
  type LocalDay,
} from './nubraBacktestLocal.ts';

/**
 * The message a route hands the UI. Node reports every network failure as the bare words
 * "fetch failed"; say what actually happened, and that a retry is cheap (batches that did land are
 * cached per symbol, so the next attempt only fetches what is still missing).
 */
function nbErrorMessage(err: unknown): string {
  const f = describeUpstreamError(err);
  if (f.kind === 'transport') {
    return `Could not reach the broker (${f.detail}). Retry — data already loaded is kept.`;
  }
  return f.message;
}

type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;

type NubraPost = (
  endpoint: string,
  body: object,
  extraHeaders?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface NubraBacktestRouteDeps {
  fastify: FastifyInstance;
  nubraGet: NubraGet;
  nubraPost: NubraPost;
  requireAuth: (reply: FastifyReply) => boolean;
  getSessionToken: () => string | null;
  /**
   * Per-date instrument master. Optional: without one, dates are fetched and memoised in-process
   * exactly as before, which is all the route tests need. The server passes a store wired to the
   * shared day cache and to disk — see backtestRefdataStore.ts.
   */
  refdataStore?: BacktestRefdataStore;
  /**
   * Cache for past dates' intraday bars. Optional, and the default has no `cacheDir` — so the route
   * tests exercise the same code path without ever touching the filesystem. The server passes a
   * disk-backed store; see backtestBarStore.ts.
   */
  barStore?: BacktestBarStore;
  /**
   * The Analysis day cache (`.analysis-cache`). Its first Nubra day is where broker history starts,
   * which is what `source=auto` compares a date against. Optional: without it a measured constant
   * per underlying stands in — see nubraBacktestLocal.ts.
   */
  analysisCacheDir?: string;
}

export function registerNubraBacktestRoutes({
  fastify,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken,
  refdataStore,
  barStore,
  analysisCacheDir,
}: NubraBacktestRouteDeps): void {
  // ─── Nubra Backtest — Utilities ───────────────────────────────────────────────

  const nbRefdata = refdataStore ?? createBacktestRefdataStore({ nubraGet });
  const nbBars = barStore ?? createBacktestBarStore();

  function nbGetRefdataForDate(exchange: string, date: string): Promise<Record<string, unknown>[]> {
    return nbRefdata.getRefdataForDate(exchange, date);
  }

  function nbTimeToMin(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  }

  function nbTsToIstMin(tsNs: string): number {
    const ms = Number(BigInt(tsNs) / 1000000n);
    const d = new Date(ms + 19800000); // +5h30m IST
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  function nbTsToIstHHMM(tsNs: string): string {
    const m = nbTsToIstMin(tsNs);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  interface NbBar {
    ts: string;
    open: number;
    high: number;
    low: number;
    close: number;
    iv: number;
    vol: number;
    oi: number;
  }

  function nbParseBars(chart: Record<string, unknown>): NbBar[] {
    const opens = (chart.open || []) as Array<{ ts?: string | number; v: number }>;
    const highs = (chart.high || []) as Array<{ ts?: string | number; v: number }>;
    const lows = (chart.low || []) as Array<{ ts?: string | number; v: number }>;
    const closes = (chart.close || []) as Array<{ ts?: string | number; v: number }>;
    const ivs = (chart.iv_mid || []) as Array<{ ts?: string | number; v: number }>;
    const vols = (chart.cumulative_volume || []) as Array<{ ts?: string | number; v: number }>;
    const ois = (chart.open_interest || chart.oi || []) as Array<{
      ts?: string | number;
      v: number;
    }>;

    const sortByTs = (arr: Array<{ ts?: string | number; v: number }>) => {
      return arr
        .filter((x) => x.ts !== undefined && x.ts !== null)
        .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    };

    const sortedCloses = sortByTs(closes);
    const sortedOpens = sortByTs(opens);
    const sortedHighs = sortByTs(highs);
    const sortedLows = sortByTs(lows);
    const sortedIvs = sortByTs(ivs);
    const sortedVols = sortByTs(vols);
    const sortedOis = sortByTs(ois);

    /**
     * Last-value-at-or-before lookup, as a forward-only cursor.
     *
     * This used to restart at index 0 for every close bar and allocate a fresh String() per
     * element — roughly bars × entries × 7 comparisons per symbol, and the chain route parses 58
     * symbols per request. Because the close bars and each field array are both sorted ascending,
     * the answer's index can only move forward, so a cursor that never rewinds visits each entry
     * once and returns exactly the same value the rescan did.
     *
     * Carries `lastVal` across calls, which is what makes a value hold until the next entry
     * supersedes it; 0 until the first entry at or before the requested timestamp.
     */
    const makeAligner = (targetArr: Array<{ ts?: string | number; v: number }>) => {
      let i = 0;
      let lastVal = 0;
      return (targetStr: string): number => {
        while (i < targetArr.length && String(targetArr[i].ts) <= targetStr) {
          lastVal = targetArr[i].v;
          i++;
        }
        return lastVal;
      };
    };

    const alignOpen = makeAligner(sortedOpens);
    const alignHigh = makeAligner(sortedHighs);
    const alignLow = makeAligner(sortedLows);
    const alignIv = makeAligner(sortedIvs);
    const alignVol = makeAligner(sortedVols);
    const alignOi = makeAligner(sortedOis);

    const bars: NbBar[] = [];
    for (const c of sortedCloses) {
      const ts = String(c.ts!);
      const close = c.v / 100;
      const open = alignOpen(ts) / 100 || close;
      const high = alignHigh(ts) / 100 || Math.max(open, close);
      const low = alignLow(ts) / 100 || Math.min(open, close);
      bars.push({
        ts,
        open,
        high,
        low,
        close,
        iv: alignIv(ts),
        vol: alignVol(ts),
        oi: alignOi(ts),
      });
    }
    return bars;
  }

  function nbFindBar(bars: NbBar[], time: string): NbBar | null {
    if (!bars.length) return null;
    const target = nbTimeToMin(time);
    let best = bars[0],
      bestD = Math.abs(nbTsToIstMin(bars[0].ts) - target);
    for (let i = 1; i < bars.length; i++) {
      const d = Math.abs(nbTsToIstMin(bars[i].ts) - target);
      if (d < bestD) {
        best = bars[i];
        bestD = d;
      }
    }
    return best;
  }

  /**
   * How many timeseries POSTs may be in flight at once for a single fan-out.
   *
   * A 29-strike chain is 58 symbols, which at 10 per request is six requests for one user click.
   * This was briefly held at 4 — two round trips — because a stale keep-alive socket among a burst
   * of six rejected the whole batch. Both halves of that reasoning have since been fixed
   * independently: `upstreamPostRetries('/charts/timeseries')` re-sends a transport failure
   * (upstreamError.ts), and the per-batch caching below means a retried batch no longer discards
   * what its siblings already fetched. Throttling on top of those only made switching expiry take
   * two round trips instead of one, which is exactly what a user feels.
   *
   * Eight rather than unbounded: it covers the six a full chain needs in a single wave, without
   * letting some future wider strike range open an unbounded number of sockets.
   */
  const TS_CONCURRENCY = 8;

  /** Bounded `Promise.all(items.map(fn))`. Results stay in input order. */
  async function mapPool<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < items.length; i = next++) {
        out[i] = await fn(items[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return out;
  }

  /**
   * The field set each `type` is always fetched with, regardless of what a caller asked for.
   *
   * Widening to a per-type superset is what lets one cache entry serve every call site: the chain
   * asks options for five fields and evaluate asks for `close`, so without this the two would never
   * share a hit and "open the chain, then Simulate" would download everything twice. Both widened
   * queries are already issued verbatim elsewhere in this file, so neither is new to the broker.
   */
  const CANONICAL_OPT_FIELDS = ['close', 'iv_mid', 'cumulative_volume', 'open_interest', 'oi'];
  const CANONICAL_SERIES_FIELDS = ['open', 'high', 'low', 'close'];

  function nbCanonicalFields(type: string): string[] {
    return type === 'OPT' ? CANONICAL_OPT_FIELDS : CANONICAL_SERIES_FIELDS;
  }

  /** Pull the per-symbol payloads out of one upstream response. */
  function nbCollectInto(res: Record<string, unknown>, into: Map<string, BarPayload>): void {
    for (const group of (res as any).result || []) {
      for (const symbolMap of group.values || []) {
        for (const [sym, data] of Object.entries(symbolMap as Record<string, unknown>)) {
          into.set(sym, data as BarPayload);
        }
      }
    }
  }

  async function nbFetchTs(
    exchange: string,
    type: string,
    symbols: string[],
    fields: string[],
    date: string,
    interval: string,
    intraDay: boolean,
  ): Promise<Record<string, unknown>> {
    const canonical = nbCanonicalFields(type);
    // A caller asking for something outside the canonical set would be served a cache entry that
    // never contained it, so such a call bypasses the cache entirely rather than answering wrongly.
    const cacheable = nbBars.isCacheable(date) && fields.every((f) => canonical.includes(f));
    const collected = new Map<string, BarPayload>();

    let toFetch = symbols;
    if (cacheable) {
      const hits = await nbBars.get(exchange, date, interval, symbols);
      for (const [sym, payload] of hits) collected.set(sym, payload);
      toFetch = symbols.filter((sym) => !hits.has(sym));
    }

    // Nubra API limits 10 values/queries per request — chunk and merge
    const BATCH = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < toFetch.length; i += BATCH) chunks.push(toFetch.slice(i, i + BATCH));

    const results = await mapPool(chunks, TS_CONCURRENCY, async (batch) => {
      const res = await nubraPost(
        '/charts/timeseries',
        {
          query: batch.map((sym) => ({
            exchange,
            type,
            values: [sym],
            fields: cacheable ? canonical : fields,
            startDate: `${date}T00:00:00.000Z`,
            endDate: `${date}T23:59:59.000Z`,
            interval,
            intraDay,
            realTime: false,
          })),
        },
        { Authorization: `Bearer ${getSessionToken()!}` },
      );

      // Cache per batch, on the batch's own success — not on the whole fan-out's. A sibling POST
      // failing must not throw away the batches that did land, which is what makes the retry after
      // an intermittent "fetch failed" nearly free.
      if (cacheable && Array.isArray((res as any).result)) {
        const fetched = new Map<string, BarPayload>();
        nbCollectInto(res, fetched);
        const toCache = new Map<string, BarPayload>();
        // Every symbol in the batch, including ones the response omitted. An illiquid strike that
        // never traded has no bars, and that absence is a real, cacheable answer — unlike the
        // refdata store, where an empty result means "we failed to recognise the shape".
        for (const sym of batch) toCache.set(sym, fetched.get(sym) ?? {});
        // Not awaited — the response should not wait on the disk write. The store fills its memory
        // tier synchronously, so the very next request still hits. The catch is belt-and-braces:
        // put() swallows its own errors, and an unhandled rejection here would take down the process.
        void nbBars
          .put(exchange, date, interval, toCache)
          .catch((err: unknown) => console.warn('[backtest bars] put failed:', err));
      }
      return res;
    });

    for (const res of results) nbCollectInto(res, collected);

    // Merge everything back into the single response shape every caller already expects.
    const merged: Record<string, unknown> = { result: [{ values: [{}] }] };
    const mergedMap = (merged as any).result[0].values[0] as Record<string, unknown>;
    for (const [sym, data] of collected) mergedMap[sym] = data;
    return merged;
  }

  function nbCollect(res: Record<string, unknown>): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const group of (res as any).result || []) {
      for (const symbolMap of group.values || []) {
        for (const [sym, data] of Object.entries(symbolMap as Record<string, unknown>)) {
          out[sym] = data as Record<string, unknown>;
        }
      }
    }
    return out;
  }

  function nbResolveExchange(underlying: string, requested?: string): string {
    const explicit = String(requested || '').toUpperCase();
    if (explicit === 'NSE' || explicit === 'BSE' || explicit === 'MCX') return explicit;
    return underlying === 'SENSEX' || underlying === 'BANKEX' ? 'BSE' : 'NSE';
  }

  function nbResolveUnderlyingSeries(
    underlying: string,
    exchange: string,
    refdata: Record<string, unknown>[],
    optionExpiry: number,
  ): { symbol: string; type: 'INDEX' | 'STOCK' | 'FUT' } | null {
    if (exchange === 'MCX') {
      const futures = refdata
        .filter((item) => item.asset === underlying && item.derivative_type === 'FUT')
        .map((item) => ({
          expiry: Number(item.expiry || 0),
          symbol: String(item.stock_name || item.zanskar_name || ''),
        }))
        .filter((item) => item.expiry > 0 && item.symbol)
        .sort((a, b) => a.expiry - b.expiry);
      const future = futures.find((item) => item.expiry >= optionExpiry) || futures[0];
      return future ? { symbol: future.symbol, type: 'FUT' } : null;
    }

    const isIndex = [
      'NIFTY',
      'BANKNIFTY',
      'FINNIFTY',
      'MIDCPNIFTY',
      'SENSEX',
      'BANKEX',
      'INDIAVIX',
    ].includes(underlying);
    return { symbol: underlying, type: isIndex ? 'INDEX' : 'STOCK' };
  }

  /**
   * How far before the requested date a cached master may have been taken and still be reused.
   *
   * The bound that matters is the listing horizon. A snapshot knows the weeklies that were on the
   * books when it was taken and no others, so serving a date `gap` days later leaves the expiry
   * list complete only out to `horizon - gap`. Measured on the real cached masters, 2026-08-03
   * listed every NIFTY expiry out to 2026-09-01 — a horizon of about 29 days — and at a nine-day
   * gap the fourth-nearest weekly was already missing from what it could offer.
   *
   * A week keeps roughly three weeks of weeklies complete, which covers the near expiries a
   * backtest actually reaches for, and in practice the gap stays smaller still: every substituted
   * answer sends the date's own master to be fetched behind it, so browsing fills the cache in.
   * `nbTrustSnapshot` and the strike-window guard reject the cases where even this does not hold.
   */
  const REUSE_MAX_AGE_DAYS = 7;

  /**
   * How near the trade date the default expiry must be for a reused snapshot to pick it.
   *
   * Weeklies are seven days apart, so an expiry falling within eight days of the trade date is the
   * nearest one by construction — there is no room for another between them. That makes the default
   * safe to take from an older snapshot. Anything further out means the genuinely nearest expiry may
   * be one this snapshot was taken too early to know about, so we pay for the exact master instead.
   */
  const NEAREST_EXPIRY_TRUST_DAYS = 8;

  function nbDaysBetween(from: string, to: string): number {
    return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  }

  function nbAssetOptions(
    refdata: Record<string, unknown>[],
    underlying: string,
  ): Record<string, unknown>[] {
    return refdata.filter((item) => item.asset === underlying && item.derivative_type === 'OPT');
  }

  /**
   * The asset's expiries as YYYY-MM-DD, ascending, restricted to those still live on `date`.
   *
   * A master downloaded for the date itself cannot contain an already-expired contract, so the
   * filter is a no-op there. It only removes anything when the master came from an earlier date —
   * which is precisely what makes reusing one sound.
   */
  function nbExpiriesFor(assetRef: Record<string, unknown>[], date: string): string[] {
    return Array.from(new Set(assetRef.map((item) => Number(item.expiry))))
      .sort((a, b) => a - b)
      .map((num) => {
        const value = String(num);
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      })
      .filter((iso) => iso >= date);
  }

  /** Whether a master taken on another date can answer for `date` without being checked upstream. */
  function nbTrustSnapshot(
    rows: Record<string, unknown>[],
    date: string,
    underlying: string,
    requestedExpiry?: string,
  ): boolean {
    const expiries = nbExpiriesFor(nbAssetOptions(rows, underlying), date);
    if (!expiries.length) return false;
    // The caller named an expiry, so the snapshot is not being asked to choose one — only to supply
    // that expiry's strikes, which it lists in full unless they were added after it was taken. The
    // strike-window guard in the route is what catches that remaining case.
    if (requestedExpiry) return expiries.includes(requestedExpiry);
    return nbDaysBetween(date, expiries[0]) <= NEAREST_EXPIRY_TRUST_DAYS;
  }

  /**
   * The instrument master to answer a chain request with, avoiding the download where it is provably
   * unnecessary.
   *
   * A cold `/refdata/refdata/<date>` is 40-45s of a ~34 MB dump, and it is charged per date — so
   * browsing a week of dates used to mean paying it a week of times over, for masters that differ
   * from each other by a handful of newly listed contracts. Reusing a nearby cached one is sound in
   * exactly one direction: every row in an older master was listed then, so any of them not yet
   * expired on the requested date was listed on the requested date too. It can be short of rows,
   * never wrong about one. Everything above decides whether "short" could matter here; when it
   * could, this falls through to the exact master and pays the download.
   */
  async function nbResolveRefdata(
    exchange: string,
    date: string,
    underlying: string,
    requestedExpiry?: string,
  ): Promise<{ rows: Record<string, unknown>[]; exact: boolean }> {
    const near = await nbRefdata.peekRefdataNear(exchange, date, REUSE_MAX_AGE_DAYS);
    if (near) {
      if (near.snapshotDate === date) return { rows: near.rows, exact: true };
      if (nbTrustSnapshot(near.rows, date, underlying, requestedExpiry)) {
        console.log(
          `[backtest refdata] ${exchange} ${date}: answered from the ${near.snapshotDate} snapshot`,
        );
        return { rows: near.rows, exact: false };
      }
    }
    return { rows: await nbGetRefdataForDate(exchange, date), exact: true };
  }

  /** Strikes either side of ATM the chain shows. */
  const STRIKE_SPAN = 14;

  /**
   * The ATM ±STRIKE_SPAN window over an expiry's listed strikes.
   *
   * `truncated` reports that the window ran into the end of the list on at least one side, so the
   * chain is narrower than it asked for. That is ordinary for a thinly listed contract, but for a
   * reused snapshot it is also the one symptom of strikes listed after the snapshot was taken —
   * which is why the caller treats it as a reason to go and get the exact master.
   */
  function nbStrikeWindow(
    expiryOptions: Record<string, unknown>[],
    spot: number,
  ): { strikes: number[]; truncated: boolean } {
    const availableStrikes = Array.from(
      new Set(expiryOptions.map((x) => (x.strike_price as number) / 100)),
    ).sort((a, b) => a - b);
    let closestIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < availableStrikes.length; i++) {
      const diff = Math.abs(availableStrikes[i] - spot);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = i;
      }
    }
    const startIdx = Math.max(0, closestIdx - STRIKE_SPAN);
    const endIdx = Math.min(availableStrikes.length - 1, closestIdx + STRIKE_SPAN);
    const strikes: number[] = [];
    for (let i = startIdx; i <= endIdx; i++) strikes.push(availableStrikes[i]);
    return {
      strikes,
      truncated: startIdx !== closestIdx - STRIKE_SPAN || endIdx !== closestIdx + STRIKE_SPAN,
    };
  }

  /** The underlying's price at `time` on `date`, falling back to the daily bar. 0 when unknown. */
  async function nbResolveSpot(
    exchange: string,
    spotType: 'INDEX' | 'STOCK' | 'FUT',
    indexName: string,
    date: string,
    time: string,
  ): Promise<number> {
    const spotRes = await nbFetchTs(exchange, spotType, [indexName], ['close'], date, '1m', false);
    const spotChart = nbCollect(spotRes)[indexName];
    if (spotChart) {
      const bar = nbFindBar(nbParseBars(spotChart), time);
      if (bar?.close) return bar.close;
    }
    // Fallback to the daily bar if 1m is not found (e.g. out of market hours or database lag).
    const dailyRes = await nubraPost(
      '/charts/timeseries',
      {
        query: [
          {
            exchange,
            type: spotType,
            values: [indexName],
            fields: ['close'],
            startDate: `${date}T00:00:00.000Z`,
            endDate: `${date}T23:59:59.000Z`,
            interval: '1d',
            intraDay: false,
            realTime: false,
          },
        ],
      },
      { Authorization: `Bearer ${getSessionToken()!}` },
    );
    const dailyChart = nbCollect(dailyRes)[indexName];
    const closes = (dailyChart?.close || []) as Array<{ ts?: string; v: number }>;
    return closes.length ? closes[0].v / 100 : 0;
  }

  // ─── Debug timeseries endpoint ───
  fastify.get('/api/debug-chart', async (req, reply) => {
    try {
      const exchange = 'NFO';
      const sym = 'NIFTY23JUL2624100CE';
      const fields = ['close', 'iv_mid', 'cumulative_volume', 'open_interest', 'oi'];
      const date = (req.query as any).date || '2026-07-17';
      const res = await nbFetchTs(exchange, 'OPT', [sym], fields, date, '1m', false);
      return res;
    } catch (err: any) {
      return { error: err.message };
    }
  });

  // ─── Local parquet source ─────────────────────────────────────────────────────
  // Dates before broker history (or any date, when forced) are answered from the parquet tree.
  // Every helper returns the same shape as its broker twin, tagged `source: 'local'`, so the view
  // only learns WHICH source answered — never has to read a different payload. No broker login is
  // needed for any of them. See nubraBacktestLocal.ts for what the tree lacks and how it is filled.

  function nbSource(underlying: string, date: string, raw: unknown): Promise<DataSource> {
    return resolveSource(underlying, date, parseSourcePref(raw), analysisCacheDir);
  }

  /** Expiry to use: the requested one when the tree holds it for the date, else the nearest. */
  async function localPickExpiry(
    underlying: string,
    date: string,
    requested?: string,
  ): Promise<{
    expiries: Array<{ expiry: string; flag: 'WEEK' | 'MONTH' }>;
    selected: string | null;
  }> {
    if (!isLocalUnderlying(underlying)) return { expiries: [], selected: null };
    const expiries = await localExpiriesFor(underlying, date);
    const want = requested ? requested.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : '';
    const selected = expiries.find((e) => e.expiry === want)?.expiry ?? expiries[0]?.expiry ?? null;
    return { expiries, selected };
  }

  async function localLoad(underlying: string, date: string, expiry?: string) {
    const { expiries, selected } = await localPickExpiry(underlying, date, expiry);
    if (!selected || !isLocalUnderlying(underlying)) {
      return { expiries, day: null as LocalDay | null, selected };
    }
    return { expiries, day: await localDay(underlying, selected, date), selected };
  }

  async function localChain(underlying: string, date: string, time: string, expiry?: string) {
    const t0 = Date.now();
    const { expiries, day, selected } = await localLoad(underlying, date, expiry);
    const availableExpiries = expiries.map((e) => ({ expiry: e.expiry, flag: e.flag }));
    const flagOf = (exp: string | null) =>
      expiries.find((e) => e.expiry === exp)?.flag ?? ('WEEK' as const);
    const base = {
      underlying,
      date,
      time,
      expiry: selected ?? '',
      expiryFlag: flagOf(selected),
      availableExpiries,
      expiriesPartial: false,
      source: 'local' as DataSource,
    };
    if (!day) {
      return {
        ...base,
        ok: false,
        error: `No local data for ${underlying} on ${date}.`,
        spot: 0,
        chain: [],
      };
    }
    const spotBar = localBarAt(day.spot, time, 5);
    if (!spotBar) {
      return {
        ...base,
        ok: false,
        error: `No local ${underlying} spot near ${time} on ${date}.`,
        spot: 0,
        chain: [],
      };
    }
    const spot = spotBar.close;
    let closest = 0;
    for (let i = 1; i < day.strikes.length; i++) {
      if (Math.abs(day.strikes[i] - spot) < Math.abs(day.strikes[closest] - spot)) closest = i;
    }
    const strikes = day.strikes.slice(
      Math.max(0, closest - STRIKE_SPAN),
      Math.min(day.strikes.length, closest + STRIKE_SPAN + 1),
    );
    // IV is the one inverted off the parity forward — the same number the Greek overlay plots for
    // this day — rather than the vendor's `iv` column, which ivHistory.ts measured as unreliable.
    // The vendor value stays as the fallback for a print that will not invert.
    const greeks = localGreeksFor(day);
    const ivAt = (strike: number, side: 'CE' | 'PE', bar: LocalBar | null) =>
      bar ? (greeks.get(`${strike}|${side}`)?.find((g) => g.ts === bar.ts)?.iv ?? bar.iv) : 0;
    const chain = strikes.map((strike) => {
      // Strict on time: a strike outside the captured wing at `time` shows empty, not an hour-old
      // price borrowed from when spot was near it.
      const ce = localBarAt(day.ce.get(strike), time);
      const pe = localBarAt(day.pe.get(strike), time);
      return {
        strike,
        ceLtp: ce?.close ?? 0,
        ceIv: ivAt(strike, 'CE', ce),
        ceOi: ce?.oi ?? 0,
        ceVol: ce?.vol ?? 0,
        peLtp: pe?.close ?? 0,
        peIv: ivAt(strike, 'PE', pe),
        peOi: pe?.oi ?? 0,
        peVol: pe?.vol ?? 0,
      };
    });
    console.log(
      `NubraBacktest LOCAL chain ${underlying} ${date} ${time} exp=${selected}: ${chain.length} strikes, spot=${spot} in ${Date.now() - t0}ms`,
    );
    return { ...base, ok: true, spot, chain };
  }

  /** Bars per leg, or the first leg the tree cannot price at entry or exit. */
  function localLegBars(
    day: LocalDay,
    legs: NbEvalLeg[],
    entryTime: string,
    exitTime: string,
  ): { bars: LocalBar[][] } | { error: string } {
    const out: LocalBar[][] = [];
    for (const leg of legs) {
      const side = leg.optionType === 'CALL' ? 'CE' : 'PE';
      const bars = (side === 'CE' ? day.ce : day.pe).get(leg.strike) ?? [];
      const missing = [entryTime, exitTime].find((t) => !localBarAt(bars, t));
      if (missing) {
        return {
          error:
            `${leg.strike} ${side} has no local price near ${missing} on ${day.date} — the local ` +
            `files only capture ATM±10 strikes, and this one was outside that range then.`,
        };
      }
      out.push(bars);
    }
    return { bars: out };
  }

  async function localEvaluate(body: NbEvalBody) {
    const t0 = Date.now();
    const { underlying, date, expiry, entryTime, exitTime, legs, lotSize } = body;
    const { day } = await localLoad(underlying, date, expiry);
    if (!day || day.expiry !== expiry.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')) {
      return {
        ok: false,
        source: 'local' as DataSource,
        error: `No local data for ${underlying} expiry ${expiry} on ${date}.`,
      };
    }
    const legBars = localLegBars(day, legs, entryTime, exitTime);
    if ('error' in legBars)
      return { ok: false, source: 'local' as DataSource, error: legBars.error };
    const result = nbEvaluateFromBars({
      legs,
      legBarsList: legBars.bars,
      spotBars: day.spot,
      daySpot: day.spot.length ? day.spot[day.spot.length - 1].close : 0,
      entryTime,
      exitTime,
      lotSize,
    });
    console.log(
      `NubraBacktest LOCAL eval ${underlying} ${date} ${entryTime}→${exitTime}: ${legs.length} legs, P&L=${Math.round(result.grossPnl)} in ${Date.now() - t0}ms`,
    );
    return { ...result, source: 'local' as DataSource };
  }

  async function localDecay(body: NbEvalBody, ceLeg: NbEvalLeg, peLeg: NbEvalLeg) {
    const { underlying, date, expiry, entryTime, exitTime, lotSize } = body;
    const { day } = await localLoad(underlying, date, expiry);
    if (!day) return { ok: false, error: `No local data for ${underlying} on ${date}.` };
    const legBars = localLegBars(day, [ceLeg, peLeg], entryTime, exitTime);
    if ('error' in legBars) return { ok: false, error: legBars.error };
    const exchange = nbResolveExchange(underlying, body.exchange);
    const session = sessionMinutes(exchange);
    const entryMinute = Math.max(session.open, nbTimeToMin(entryTime));
    const exitMinute = Math.min(session.last, nbTimeToMin(exitTime));
    if (exitMinute <= entryMinute) return { ok: false, error: 'Exit must be after entry.' };
    const signed = (leg: NbEvalLeg) => leg.lots * lotSize * (leg.side === 'BUY' ? 1 : -1);
    const minuteCloses = (bars: LocalBar[]) =>
      bars.filter((b) => b.close > 0).map((b) => ({ minute: nbTsToIstMin(b.ts), close: b.close }));
    const result = replayDecay({
      legs: {
        basketGroupId: 'nubra-bt-local',
        asset: underlying,
        exchange: exchange as StrategyLegs['exchange'],
        underlyingType: 'INDEX',
        ce: {
          refId: 0,
          nubraName: localContractName(day.underlying, day.expiry, ceLeg.strike, 'CE'),
          qty: signed(ceLeg),
        },
        pe: {
          refId: 0,
          nubraName: localContractName(day.underlying, day.expiry, peLeg.strike, 'PE'),
          qty: signed(peLeg),
        },
        entryNs: istMinuteToMs(date, entryMinute) * 1_000_000,
      },
      date,
      entryMinute,
      exitMinute,
      closes: {
        spot: minuteCloses(day.spot),
        ce: minuteCloses(legBars.bars[0]),
        pe: minuteCloses(legBars.bars[1]),
      },
      // The tree has no ticks; the walk runs on minute closes throughout.
      ticks: null,
      tickFromSec: null,
    });
    return {
      ok: true,
      source: 'local' as DataSource,
      resolution: result.resolution,
      tickFrom: null,
      tickError: null,
      cases: result.cases.map(decayCaseDto),
    };
  }

  /**
   * The Band's contract list, named `LOCAL|…` so /local-historical can resolve each back to a strike
   * of the tree. No lot size: the tree does not carry one, and the overlay keeps the chain's.
   */
  async function localBandContracts(underlying: string, date: string, expiry?: string) {
    const { expiries, day, selected } = await localLoad(underlying, date, expiry);
    const availableExpiries = expiries.map((e) => e.expiry);
    if (!day || !selected || !isLocalUnderlying(underlying)) {
      return {
        ok: false,
        source: 'local' as DataSource,
        error: `No local data for ${underlying} on ${date}.`,
        underlying,
        date,
        exchange: nbResolveExchange(underlying),
        expiry: '',
        availableExpiries,
        contracts: [],
      };
    }
    const contracts: Array<{ name: string; strike: number; side: 'CE' | 'PE'; expiry: string }> =
      [];
    for (const strike of day.strikes) {
      for (const side of ['CE', 'PE'] as const) {
        if ((side === 'CE' ? day.ce : day.pe).get(strike)?.length) {
          contracts.push({
            name: localContractName(underlying, selected, strike, side),
            strike,
            side,
            expiry: selected,
          });
        }
      }
    }
    return {
      ok: true,
      source: 'local' as DataSource,
      underlying,
      date,
      exchange: nbResolveExchange(underlying),
      expiry: selected,
      availableExpiries,
      contracts,
    };
  }

  interface HistQuery {
    exchange?: string;
    type?: string;
    values?: string[];
    fields?: string[];
    startDate?: string;
    endDate?: string;
    interval?: string;
  }

  /**
   * `/api/historical`'s request and response shape, answered from the tree — what the Greek overlay
   * reads when its host is on a local day. Prices go out in paise as the broker's do; greeks are
   * reconstructed per day (localGreeksFor). Book fields (l1bid/l1ask) are the close: the tree has no
   * book. Only 1m exists locally; any other interval is answered empty, which the overlay already
   * treats as "no data for that window".
   */
  fastify.post<{ Body: { query?: HistQuery[] } }>(
    '/api/nubra-backtest/local-historical',
    async (req) => {
      const queries = Array.isArray(req.body?.query) ? req.body.query : [];
      const result = await Promise.all(
        queries.map(async (q) => {
          const values: Record<string, Record<string, Array<{ ts: number; v: number }>>> = {};
          const startMs = Date.parse(q.startDate ?? '');
          const endMs = Date.parse(q.endDate ?? '');
          if (q.interval !== '1m' || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
            return { values: [values] };
          }
          const fields = new Set(q.fields ?? ['close']);
          const inWindow = (ts: string) => {
            const ms = Number(BigInt(ts) / 1_000_000n);
            return ms >= startMs && ms <= endMs;
          };
          // Only dates whose 09:15–15:30 IST session overlaps the window. The overlay's one-day
          // window opens at the previous close, and loading that whole earlier day to keep none
          // of it would double the cold cost of every request.
          const dates = istDatesBetween(startMs, endMs).filter((d) => {
            const open = Date.parse(`${d}T09:15:00+05:30`);
            const close = Date.parse(`${d}T15:30:00+05:30`);
            return close >= startMs && open <= endMs;
          });

          for (const name of q.values ?? []) {
            const series: Record<string, Array<{ ts: number; v: number }>> = {};
            // A plain number, as the broker sends it: the overlay normalises by magnitude, and a
            // string here would be the one field shape the broker never produces.
            const push = (field: string, ts: string, v: number) => {
              if (!fields.has(field) || !Number.isFinite(v)) return;
              (series[field] ??= []).push({ ts: Number(ts), v });
            };
            const contract = parseLocalContractName(name);
            if (contract) {
              for (const date of dates) {
                if (date > contract.expiry) break;
                const day = await localDay(contract.und, contract.expiry, date);
                if (!day) continue;
                const bars = (contract.side === 'CE' ? day.ce : day.pe).get(contract.strike) ?? [];
                const greeks = new Map(
                  (localGreeksFor(day).get(`${contract.strike}|${contract.side}`) ?? []).map(
                    (g) => [g.ts, g],
                  ),
                );
                for (const b of bars) {
                  if (!inWindow(b.ts)) continue;
                  const paise = Math.round(b.close * 100);
                  push('close', b.ts, paise);
                  push('l1bid', b.ts, paise);
                  push('l1ask', b.ts, paise);
                  push('cumulative_oi', b.ts, b.oi);
                  const g = greeks.get(b.ts);
                  if (g) {
                    push('delta', b.ts, g.delta);
                    push('vega', b.ts, g.vega);
                    push('theta', b.ts, g.theta);
                    push('iv_mid', b.ts, g.iv);
                  }
                }
              }
            } else if (isLocalUnderlying(name)) {
              // The underlying itself: spot from whichever expiry holds each date.
              for (const date of dates) {
                const exp = (await localExpiriesFor(name, date))[0]?.expiry;
                const day = exp ? await localDay(name, exp, date) : null;
                for (const b of day?.spot ?? []) {
                  if (!inWindow(b.ts)) continue;
                  push('close', b.ts, Math.round(b.close * 100));
                  push('open', b.ts, Math.round(b.open * 100));
                  push('high', b.ts, Math.round(b.high * 100));
                  push('low', b.ts, Math.round(b.low * 100));
                }
              }
            }
            if (Object.keys(series).length) values[name] = series;
          }
          return { values: [values] };
        }),
      );
      return { result };
    },
  );

  // ─── Nubra Backtest — Routes ──────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      underlying?: string;
      date?: string;
      expiry?: string;
      exchange?: string;
      source?: string;
    };
  }>('/api/nubra-backtest/band-contracts', async (req, reply) => {
    const { underlying = 'NIFTY', date, expiry } = req.query;
    if (!date) {
      reply.code(400);
      return { ok: false, error: 'date is required.' };
    }
    if ((await nbSource(underlying, date, req.query.source)) === 'local') {
      return localBandContracts(underlying, date, expiry);
    }
    if (!requireAuth(reply)) return;

    try {
      const exchange = nbResolveExchange(underlying, req.query.exchange);
      // The Band can reach 24 OTM strikes, so this route always uses the exact dated master.
      const refdata = await nbGetRefdataForDate(exchange, date);
      const assetOptions = nbAssetOptions(refdata, underlying);
      const expiries = nbExpiriesFor(assetOptions, date);
      if (!expiries.length) {
        return {
          ok: false,
          error: `No options found for ${underlying} on ${date}.`,
          underlying,
          date,
          exchange,
          expiry: '',
          availableExpiries: [],
          contracts: [],
        };
      }

      const selectedExpiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];
      const targetExpiry = Number(selectedExpiry.replace(/-/g, ''));
      const contracts = assetOptions
        .filter((item) => Number(item.expiry) === targetExpiry)
        .map((item) => {
          const side = String(item.option_type || '').toUpperCase();
          const name = String(item.stock_name || item.zanskar_name || item.nubra_name || '');
          const strike = Number(item.strike_price) / 100;
          const refId = Number(item.ref_id);
          const lotSize = Number(item.lot_size);
          return {
            name,
            strike,
            side,
            expiry: selectedExpiry,
            ...(Number.isFinite(refId) ? { refId } : {}),
            ...(Number.isFinite(lotSize) && lotSize > 0 ? { lotSize } : {}),
          };
        })
        .filter(
          (contract) =>
            contract.name &&
            Number.isFinite(contract.strike) &&
            contract.strike > 0 &&
            (contract.side === 'CE' || contract.side === 'PE'),
        )
        .sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));

      return {
        ok: true,
        underlying,
        date,
        exchange,
        expiry: selectedExpiry,
        availableExpiries: expiries,
        contracts,
      };
    } catch (error) {
      console.error('Band contracts error:', error);
      reply.code(500);
      return { ok: false, error: nbErrorMessage(error) };
    }
  });

  fastify.get<{
    Querystring: {
      underlying?: string;
      date?: string;
      time?: string;
      expiry?: string;
      exchange?: string;
      source?: string;
    };
  }>('/api/nubra-backtest/chain', async (req, reply) => {
    const { underlying = 'NIFTY', date, time = '09:20', expiry } = req.query;
    if (!date) {
      reply.code(400);
      return { ok: false, error: 'date is required.' };
    }
    if ((await nbSource(underlying, date, req.query.source)) === 'local') {
      try {
        return await localChain(underlying, date, time, expiry);
      } catch (e) {
        console.error('NubraBacktest local chain error:', e);
        reply.code(500);
        return { ok: false, source: 'local', error: (e as Error).message };
      }
    }
    if (!requireAuth(reply)) return;

    // No falling back to local when this fails. The refdata store turns a failed download into an
    // empty master, so "the broker has no data for this date" and "the connection dropped" look
    // identical from here — a fallback would quietly swap sources on a network hiccup. Which source
    // answers is decided by the date alone (resolveSource); a broker failure shows as an error with
    // Retry, and Local stays one click away.
    return nbBrokerChain(underlying, date, time, expiry, req.query.exchange, reply);
  });

  /** The broker half of `/chain`: everything it did before there was a local source. */
  async function nbBrokerChain(
    underlying: string,
    date: string,
    time: string,
    expiry: string | undefined,
    exchangeParam: string | undefined,
    reply: FastifyReply,
  ) {
    try {
      const t0 = Date.now();
      const exchange = nbResolveExchange(underlying, exchangeParam);
      const expiryFlag = exchange === 'MCX' ? 'MONTH' : 'WEEK';

      // Resolve the option expiry first. MCX has no cash/index ticker named
      // CRUDEOIL; its historical underlying is the futures contract backing the
      // selected option expiry (for example FUT_CRUDEOIL_20260819).
      const resolved = await nbResolveRefdata(exchange, date, underlying, expiry);
      let refdata = resolved.rows;
      let exact = resolved.exact;
      if (!refdata.length) {
        return {
          ok: false,
          error: `Could not fetch option refdata for ${date}.`,
          underlying,
          date,
          time,
          spot: 0,
          expiry: expiry || '',
          expiryFlag,
          availableExpiries: [],
          chain: [],
        };
      }
      let assetRef = nbAssetOptions(refdata, underlying);
      let expiries = nbExpiriesFor(assetRef, date);
      if (!assetRef.length || !expiries.length) {
        return {
          ok: false,
          error: `No options found for ${underlying} on ${date}.`,
          underlying,
          date,
          time,
          spot: 0,
          expiry: expiry || '',
          expiryFlag,
          availableExpiries: [],
          chain: [],
        };
      }
      let selectedExpiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];
      let targetExpiryNum = Number(selectedExpiry.replace(/-/g, ''));
      let expiryOptions = assetRef.filter((item) => Number(item.expiry) === targetExpiryNum);
      const underlyingSeries = nbResolveUnderlyingSeries(
        underlying,
        exchange,
        refdata,
        targetExpiryNum,
      );
      if (!underlyingSeries) {
        return {
          ok: false,
          error: `Could not resolve the ${underlying} futures contract for expiry ${selectedExpiry}.`,
          underlying,
          date,
          time,
          spot: 0,
          expiry: selectedExpiry,
          expiryFlag,
          availableExpiries: expiries.map((value) => ({ expiry: value, flag: expiryFlag })),
          chain: [],
        };
      }
      const indexName = underlyingSeries.symbol;
      const spotType = underlyingSeries.type;

      // 1. Fetch spot on trade date (1m interval to get precise spot at selected entryTime)
      let spot = await nbResolveSpot(exchange, spotType, indexName, date, time);
      if (!spot) {
        return {
          ok: false,
          error: `Could not fetch ${underlying} spot for ${date}. Market may have been closed.`,
          underlying,
          date,
          time,
          spot: 0,
          expiry: expiry || '',
          expiryFlag,
          availableExpiries: [],
          chain: [],
        };
      }

      // 3. Generate ATM ± 14 strikes
      let window = nbStrikeWindow(expiryOptions, spot);
      // A snapshot from an earlier date can only ever be missing strikes that were listed after it
      // was taken, and the only way that can shrink this chain is the ATM window running off the
      // end of what it knows. Rather than quietly hand back a narrower chain than the date really
      // had, pay for the exact master and redo everything that depended on the substitute.
      if (!exact && window.truncated) {
        console.log(
          `[backtest refdata] ${exchange} ${date}: snapshot ran short at ATM ${spot}, fetching exact`,
        );
        refdata = await nbGetRefdataForDate(exchange, date);
        exact = true;
        assetRef = nbAssetOptions(refdata, underlying);
        expiries = nbExpiriesFor(assetRef, date);
        if (expiries.length) {
          const previousExpiry = selectedExpiry;
          selectedExpiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];
          targetExpiryNum = Number(selectedExpiry.replace(/-/g, ''));
          expiryOptions = assetRef.filter((item) => Number(item.expiry) === targetExpiryNum);
          // On MCX the underlying is the futures contract backing the chosen expiry, so a different
          // expiry means the spot above was read off a different series. Indices are unaffected,
          // which is why this re-reads only when the series name actually changes.
          if (selectedExpiry !== previousExpiry) {
            const series = nbResolveUnderlyingSeries(
              underlying,
              exchange,
              refdata,
              targetExpiryNum,
            );
            if (series && series.symbol !== indexName) {
              spot =
                (await nbResolveSpot(exchange, series.type, series.symbol, date, time)) || spot;
            }
          }
          window = nbStrikeWindow(expiryOptions, spot);
        }
      }
      const strikes = window.strikes;

      // 4. Map strikes to option symbols (stock_names) in the refdata
      const symbolsMap = new Map<string, { strike: number; type: 'CE' | 'PE' }>();
      const symbolsToFetch: string[] = [];

      for (const strike of strikes) {
        const ceOpt = expiryOptions.find(
          (x) => x.strike_price === strike * 100 && x.option_type === 'CE',
        );
        const peOpt = expiryOptions.find(
          (x) => x.strike_price === strike * 100 && x.option_type === 'PE',
        );

        if (ceOpt?.stock_name) {
          const name = String(ceOpt.stock_name);
          symbolsToFetch.push(name);
          symbolsMap.set(name, { strike, type: 'CE' });
        }
        if (peOpt?.stock_name) {
          const name = String(peOpt.stock_name);
          symbolsToFetch.push(name);
          symbolsMap.set(name, { strike, type: 'PE' });
        }
      }

      const optRes = await nbFetchTs(
        exchange,
        'OPT',
        symbolsToFetch,
        ['close', 'iv_mid', 'cumulative_volume', 'open_interest', 'oi'],
        date,
        '1m',
        false,
      );
      const optAll = nbCollect(optRes);

      // 6. Build chain rows
      const chainRowsMap = new Map<
        number,
        {
          strike: number;
          ceLtp: number;
          ceIv: number;
          ceOi: number;
          ceVol: number;
          peLtp: number;
          peIv: number;
          peOi: number;
          peVol: number;
        }
      >();
      for (const strike of strikes) {
        chainRowsMap.set(strike, {
          strike,
          ceLtp: 0,
          ceIv: 0,
          ceOi: 0,
          ceVol: 0,
          peLtp: 0,
          peIv: 0,
          peOi: 0,
          peVol: 0,
        });
      }

      for (const sym of symbolsToFetch) {
        const mapping = symbolsMap.get(sym);
        if (!mapping) continue;
        const chart = optAll[sym];
        if (!chart) continue;

        const bars = nbParseBars(chart);
        const bar = nbFindBar(bars, time);
        if (!bar) continue;

        const row = chainRowsMap.get(mapping.strike);
        if (row) {
          if (mapping.type === 'CE') {
            row.ceLtp = bar.close;
            row.ceIv = bar.iv;
            row.ceVol = bar.vol;
            row.ceOi = bar.oi;
          } else {
            row.peLtp = bar.close;
            row.peIv = bar.iv;
            row.peVol = bar.vol;
            row.peOi = bar.oi;
          }
        }
      }
      const chain = Array.from(chainRowsMap.values());

      console.log(
        `NubraBacktest chain ${underlying} ${date} ${time} exp=${selectedExpiry}: ${chain.length} strikes, spot=${spot} in ${Date.now() - t0}ms`,
      );
      // The chain itself is exact either way — a substitute snapshot is checked for the expiry it
      // picked and for the strikes around ATM before it is used at all. What it can be short of is
      // the far end of the expiry LIST: a weekly listed between the snapshot and this date is one no
      // earlier master could have known about. Measured on the real cached files, that is a handful
      // of expiries a month or more out. So say the list is still filling, and go and fetch the
      // date's own master at warm priority — nobody waits on it, and the next visit is exact.
      if (!exact) void nbRefdata.prefetchForDate(exchange, date);
      return {
        ok: true,
        underlying,
        date,
        time,
        spot,
        expiry: selectedExpiry,
        expiryFlag,
        availableExpiries: expiries.map((e) => ({ expiry: e, flag: expiryFlag })),
        expiriesPartial: !exact,
        chain,
        source: 'nubra' as DataSource,
      };
    } catch (e) {
      console.error('NubraBacktest chain error:', e);
      reply.code(500);
      return { ok: false, error: nbErrorMessage(e) };
    }
  }

  interface NbEvalLeg {
    strike: number;
    optionType: 'CALL' | 'PUT';
    side: 'BUY' | 'SELL';
    lots: number;
  }
  interface NbEvalBody {
    underlying: string;
    exchange?: string;
    date: string;
    expiry: string;
    entryTime: string;
    exitTime: string;
    legs: NbEvalLeg[];
    lotSize: number;
    /** 'auto' | 'nubra' | 'local' — see resolveSource. Absent means 'auto'. */
    source?: string;
  }

  const IST_OFFSET = 19800; // 5h30m in seconds

  /**
   * Entry → exit replay of a fixed basket over already-fetched 1m bars. Pure: both sources fetch
   * (broker timeseries or the local parquet tree) and hand the bars here, so the result is computed
   * the same way whichever one answered.
   */
  function nbEvaluateFromBars(args: {
    legs: NbEvalLeg[];
    legBarsList: NbBar[][];
    spotBars: NbBar[];
    daySpot: number;
    entryTime: string;
    exitTime: string;
    lotSize: number;
  }) {
    const { legs, legBarsList, spotBars, daySpot, entryTime, exitTime, lotSize } = args;
    const underlyingBars = spotBars.map((b) => ({
      time: Number(BigInt(b.ts) / 1000000000n) + IST_OFFSET,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));

    const entryMin = nbTimeToMin(entryTime);
    const exitMin = nbTimeToMin(exitTime);

    // 3. Replay leg results
    const legResults: Array<{
      strike: number;
      optionType: string;
      side: string;
      lots: number;
      entryPrice: number;
      exitPrice: number;
      highAfterEntry: number;
      lowAfterEntry: number;
      pnl: number;
    }> = [];
    let totalPnl = 0;

    const legPriceData: Array<{
      legIndex: number;
      data: Array<{ time: number; value: number }>;
    }> = [];
    const legPnlData: Array<{ legIndex: number; data: Array<{ time: number; value: number }> }> =
      [];

    for (let li = 0; li < legs.length; li++) {
      const leg = legs[li];
      const bars = legBarsList[li];

      const entryBar = nbFindBar(bars, entryTime);
      const exitBar = nbFindBar(bars, exitTime);
      const entryPrice = entryBar?.close ?? 0;
      const exitPrice = exitBar?.close ?? 0;

      const rangeBars = bars.filter((b) => {
        const m = nbTsToIstMin(b.ts);
        return m >= entryMin && m <= exitMin;
      });
      const high = rangeBars.length ? Math.max(...rangeBars.map((b) => b.close)) : entryPrice;
      const low = rangeBars.length ? Math.min(...rangeBars.map((b) => b.close)) : entryPrice;

      const qty = leg.lots * lotSize;
      const sign = leg.side === 'BUY' ? 1 : -1;
      const pnl = (exitPrice - entryPrice) * qty * sign;
      totalPnl += pnl;

      legResults.push({
        strike: leg.strike,
        optionType: leg.optionType,
        side: leg.side,
        lots: leg.lots,
        entryPrice,
        exitPrice,
        highAfterEntry: high,
        lowAfterEntry: low,
        pnl,
      });

      const pricePoints = bars.map((b) => ({
        time: Number(BigInt(b.ts) / 1000000000n) + IST_OFFSET,
        value: b.close,
      }));
      legPriceData.push({ legIndex: li, data: pricePoints });

      const pnlPoints = bars.map((b) => {
        const t = Number(BigInt(b.ts) / 1000000000n) + IST_OFFSET;
        const m = nbTsToIstMin(b.ts);
        if (m < entryMin) return { time: t, value: 0 };
        if (m > exitMin) return { time: t, value: (exitPrice - entryPrice) * qty * sign };
        return { time: t, value: (b.close - entryPrice) * qty * sign };
      });
      legPnlData.push({ legIndex: li, data: pnlPoints });
    }

    // 4. Build intraday P&L curve at 1-minute resolution
    const timeSet = new Set<string>();
    for (const bars of legBarsList) {
      for (const b of bars) {
        const m = nbTsToIstMin(b.ts);
        if (m >= entryMin && m <= exitMin) timeSet.add(nbTsToIstHHMM(b.ts));
      }
    }
    const sortedTimes = [...timeSet].sort();

    const intradayCurve: Array<{ hhmm: string; spot: number; total: number }> = [];
    const basketPnlData: Array<{ time: number; value: number }> = [];

    for (const hhmm of sortedTimes) {
      let total = 0;
      let timestamp = 0;
      let currentSpot = daySpot;

      const spotBar = nbFindBar(spotBars, hhmm);
      if (spotBar) currentSpot = spotBar.close;

      for (let li = 0; li < legs.length; li++) {
        const leg = legs[li];
        const bars = legBarsList[li];
        const entry = nbFindBar(bars, entryTime);
        const cur = nbFindBar(bars, hhmm);
        if (!entry || !cur) continue;
        total += (cur.close - entry.close) * leg.lots * lotSize * (leg.side === 'BUY' ? 1 : -1);
        if (!timestamp) {
          timestamp = Number(BigInt(cur.ts) / 1000000000n) + IST_OFFSET;
        }
      }
      intradayCurve.push({ hhmm, spot: currentSpot, total: Math.round(total * 100) / 100 });
      if (timestamp) {
        basketPnlData.push({ time: timestamp, value: Math.round(total * 100) / 100 });
      }
    }

    const entrySpotBar = nbFindBar(spotBars, entryTime);
    const exitSpotBar = nbFindBar(spotBars, exitTime);
    const entrySpot = entrySpotBar?.close ?? daySpot;
    const exitSpot = exitSpotBar?.close ?? daySpot;

    return {
      ok: true as const,
      entrySpot,
      exitSpot,
      legs: legResults,
      grossPnl: Math.round(totalPnl * 100) / 100,
      intradayCurve,
      underlyingBars,
      legPriceData,
      legPnlData,
      basketPnlData,
    };
  }

  fastify.post<{ Body: NbEvalBody }>('/api/nubra-backtest/evaluate', async (req, reply) => {
    const body = req.body;
    if (!body?.underlying || !body?.date || !body?.legs?.length) {
      reply.code(400);
      return { ok: false, error: 'underlying, date, and at least one leg are required.' };
    }
    if ((await nbSource(body.underlying, body.date, body.source)) === 'local') {
      try {
        return await localEvaluate(body);
      } catch (e) {
        console.error('NubraBacktest local eval error:', e);
        reply.code(500);
        return { ok: false, source: 'local', error: (e as Error).message };
      }
    }
    if (!requireAuth(reply)) return;

    try {
      const t0 = Date.now();
      const { underlying, date, expiry, entryTime, exitTime, legs, lotSize } = body;
      const exchange = nbResolveExchange(underlying, body.exchange);

      // 1. Fetch historical refdata to map legs to option symbols
      const refdata = await nbGetRefdataForDate(exchange, date);
      const targetExpiryNum = Number(expiry.replace(/-/g, ''));
      const underlyingSeries = nbResolveUnderlyingSeries(
        underlying,
        exchange,
        refdata,
        targetExpiryNum,
      );
      if (!underlyingSeries) {
        return {
          ok: false,
          error: `Could not resolve the ${underlying} futures contract for expiry ${expiry}.`,
        };
      }
      const indexName = underlyingSeries.symbol;
      const spotType = underlyingSeries.type;
      const expiryOptions = refdata.filter(
        (x) =>
          x.asset === underlying && x.derivative_type === 'OPT' && x.expiry === targetExpiryNum,
      );

      const legSymbols: string[] = [];
      for (const leg of legs) {
        const opt = expiryOptions.find(
          (x) =>
            x.strike_price === leg.strike * 100 &&
            x.option_type === (leg.optionType === 'CALL' ? 'CE' : 'PE'),
        );
        if (opt?.stock_name) {
          legSymbols.push(String(opt.stock_name));
        } else {
          return {
            ok: false,
            error: `Leg strike ${leg.strike} ${leg.optionType} not found in refdata for expiry ${expiry}.`,
          };
        }
      }

      // 2. Fetch 1m candles for option legs + 1m spot index close
      const [optRes, spotRes] = await Promise.all([
        nbFetchTs(exchange, 'OPT', legSymbols, ['close'], date, '1m', false),
        nbFetchTs(
          exchange,
          spotType,
          [indexName],
          ['open', 'high', 'low', 'close'],
          date,
          '1m',
          false,
        ),
      ]);
      const optAll = nbCollect(optRes);
      const spotAll = nbCollect(spotRes);
      const spotData = spotAll[indexName] || {};
      const spotBars = nbParseBars(spotData);

      let daySpot = 0;
      if (spotBars.length) {
        daySpot = spotBars[spotBars.length - 1].close;
      } else {
        const dailyRes = await nubraPost(
          '/charts/timeseries',
          {
            query: [
              {
                exchange,
                type: spotType,
                values: [indexName],
                fields: ['close'],
                startDate: `${date}T00:00:00.000Z`,
                endDate: `${date}T23:59:59.000Z`,
                interval: '1d',
                intraDay: false,
                realTime: false,
              },
            ],
          },
          { Authorization: `Bearer ${getSessionToken()!}` },
        );
        const dailyAll = nbCollect(dailyRes);
        const closes = (dailyAll[indexName]?.close || []) as Array<{ ts?: string; v: number }>;
        if (closes.length) daySpot = closes[0].v / 100;
      }

      const result = nbEvaluateFromBars({
        legs,
        legBarsList: legSymbols.map((symbol) =>
          optAll[symbol] ? nbParseBars(optAll[symbol]) : [],
        ),
        spotBars,
        daySpot,
        entryTime,
        exitTime,
        lotSize,
      });

      console.log(
        `NubraBacktest eval ${underlying} ${date} ${entryTime}→${exitTime}: ${legs.length} legs, P&L=${Math.round(result.grossPnl)} in ${Date.now() - t0}ms`,
      );
      return { ...result, source: 'nubra' as DataSource };
    } catch (e) {
      console.error('NubraBacktest eval error:', e);
      reply.code(500);
      return { ok: false, error: nbErrorMessage(e) };
    }
  });

  // ─── Decay matcher over a backtest day ──────────────────────────────────────
  // Additive: the evaluate route above is untouched, so turning Decay on changes nothing else the
  // view shows. The engine and the tick/minute walk live in backtestDecay.ts.

  /** 1s closes of one symbol from `startMs` to the end of `date`, as IST seconds of that date. */
  async function nbFetchSeconds(
    exchange: string,
    type: string,
    symbol: string,
    date: string,
    startMs: number,
    today: boolean,
  ): Promise<Array<{ sec: number; close: number }>> {
    const res = await nubraPost(
      '/charts/timeseries',
      {
        query: [
          {
            exchange,
            type,
            values: [symbol],
            fields: ['close'],
            startDate: new Date(Math.max(startMs, Date.parse(`${date}T00:00:00Z`))).toISOString(),
            endDate: `${date}T23:59:59.000Z`,
            interval: '1s',
            intraDay: today,
            realTime: false,
          },
        ],
      },
      { Authorization: `Bearer ${getSessionToken()!}` },
    );
    return parseSecondBars(res, symbol, date).map((b) => ({ sec: b.sec, close: b.close }));
  }

  fastify.post<{ Body: NbEvalBody }>('/api/nubra-backtest/decay', async (req, reply) => {
    const body = req.body;
    if (!body?.underlying || !body?.date || !body?.expiry || !body?.legs?.length) {
      reply.code(400);
      return { ok: false, error: 'underlying, date, expiry and legs are required.' };
    }
    const ceLegs = body.legs.filter((l) => l.optionType === 'CALL');
    const peLegs = body.legs.filter((l) => l.optionType === 'PUT');
    if (body.legs.length !== 2 || ceLegs.length !== 1 || peLegs.length !== 1) {
      return { ok: false, error: 'Decay needs exactly one CE and one PE leg.' };
    }
    if ((await nbSource(body.underlying, body.date, body.source)) === 'local') {
      try {
        return await localDecay(body, ceLegs[0], peLegs[0]);
      } catch (e) {
        console.error('NubraBacktest local decay error:', e);
        reply.code(500);
        return { ok: false, error: (e as Error).message };
      }
    }
    if (!requireAuth(reply)) return;

    try {
      const t0 = Date.now();
      const { underlying, date, expiry, entryTime, exitTime, lotSize } = body;
      const exchange = nbResolveExchange(underlying, body.exchange);
      const refdata = await nbGetRefdataForDate(exchange, date);
      const targetExpiryNum = Number(expiry.replace(/-/g, ''));
      const series = nbResolveUnderlyingSeries(underlying, exchange, refdata, targetExpiryNum);
      if (!series) {
        return {
          ok: false,
          error: `Could not resolve the ${underlying} underlying for ${expiry}.`,
        };
      }
      const symbolOf = (leg: NbEvalLeg) =>
        refdata.find(
          (x) =>
            x.asset === underlying &&
            x.derivative_type === 'OPT' &&
            x.expiry === targetExpiryNum &&
            x.strike_price === leg.strike * 100 &&
            x.option_type === (leg.optionType === 'CALL' ? 'CE' : 'PE'),
        );
      const ceRef = symbolOf(ceLegs[0]);
      const peRef = symbolOf(peLegs[0]);
      if (!ceRef?.stock_name || !peRef?.stock_name) {
        return { ok: false, error: `A leg is not in the instrument master for ${expiry}.` };
      }
      const ceName = String(ceRef.stock_name);
      const peName = String(peRef.stock_name);

      const session = sessionMinutes(exchange);
      const entryMinute = Math.max(session.open, nbTimeToMin(entryTime));
      const exitMinute = Math.min(session.last, nbTimeToMin(exitTime));
      if (exitMinute <= entryMinute) {
        return { ok: false, error: 'Exit must be after entry.' };
      }
      const signed = (leg: NbEvalLeg) => leg.lots * lotSize * (leg.side === 'BUY' ? 1 : -1);
      const legs: StrategyLegs = {
        basketGroupId: 'nubra-bt',
        asset: underlying,
        exchange: exchange as StrategyLegs['exchange'],
        underlyingType: series.type,
        ce: { refId: Number(ceRef.ref_id) || 0, nubraName: ceName, qty: signed(ceLegs[0]) },
        pe: { refId: Number(peRef.ref_id) || 0, nubraName: peName, qty: signed(peLegs[0]) },
        entryNs: istMinuteToMs(date, entryMinute) * 1_000_000,
      };

      // The "earlier minute" side: the broker's 1m closes, the same (cached) bars evaluate reads.
      const [optRes, spotRes] = await Promise.all([
        nbFetchTs(exchange, 'OPT', [ceName, peName], ['close'], date, '1m', false),
        nbFetchTs(exchange, series.type, [series.symbol], ['close'], date, '1m', false),
      ]);
      const optAll = nbCollect(optRes);
      const spotAll = nbCollect(spotRes);
      const minuteCloses = (payload: Record<string, unknown> | undefined) =>
        payload
          ? nbParseBars(payload)
              .filter((b) => b.close > 0)
              .map((b) => ({ minute: nbTsToIstMin(b.ts), close: b.close }))
          : [];
      const closes = {
        spot: minuteCloses(spotAll[series.symbol]),
        ce: minuteCloses(optAll[ceName]),
        pe: minuteCloses(optAll[peName]),
      };

      // The "now" side: recorded ticks wherever the broker still keeps them.
      const nowMs = Date.now();
      const tickFromSec = tickCoverageStart(date, entryMinute * 60, exitMinute * 60 + 59, nowMs);
      let ticks: SecondCloses | null = null;
      let tickError: string | null = null;
      if (tickFromSec != null) {
        // A little before the switch, so each series' price as of it is known.
        const startMs = Math.max(
          istMinuteToMs(date, 0) + (tickFromSec - 300) * 1000,
          nowMs - TICK_RETENTION_MS + 5 * 60_000,
        );
        const today = istDate(nowMs) === date;
        try {
          const [spot, ce, pe] = await Promise.all([
            nbFetchSeconds(exchange, series.type, series.symbol, date, startMs, today),
            nbFetchSeconds(exchange, 'OPT', ceName, date, startMs, today),
            nbFetchSeconds(exchange, 'OPT', peName, date, startMs, today),
          ]);
          if (spot.length && ce.length && pe.length) ticks = { spot, ce, pe };
          else tickError = 'the broker returned no ticks for this day';
        } catch (e) {
          // Minute closes still score the day; say why it isn't tick by tick.
          tickError = nbErrorMessage(e);
        }
      }

      const result = replayDecay({
        legs,
        date,
        entryMinute,
        exitMinute,
        closes,
        ticks,
        tickFromSec: ticks ? tickFromSec : null,
      });
      console.log(
        `NubraBacktest decay ${underlying} ${date} ${entryTime}→${exitTime}: ${result.cases.length} cases, ${result.resolution} (${result.steps} steps) in ${Date.now() - t0}ms`,
      );
      return {
        ok: true,
        resolution: result.resolution,
        tickFrom:
          ticks && tickFromSec != null ? formatHms(Math.max(tickFromSec, entryMinute * 60)) : null,
        tickError,
        cases: result.cases.map(decayCaseDto),
      };
    } catch (e) {
      console.error('NubraBacktest decay error:', e);
      reply.code(500);
      return { ok: false, error: nbErrorMessage(e) };
    }
  });
}
