import type { FastifyInstance, FastifyReply } from 'fastify';
import { createBacktestRefdataStore, type BacktestRefdataStore } from './backtestRefdataStore.ts';

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
}

export function registerNubraBacktestRoutes({
  fastify,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken,
  refdataStore,
}: NubraBacktestRouteDeps): void {
  // ─── Nubra Backtest — Utilities ───────────────────────────────────────────────

  const nbRefdata = refdataStore ?? createBacktestRefdataStore({ nubraGet });

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

  async function nbFetchTs(
    exchange: string,
    type: string,
    symbols: string[],
    fields: string[],
    date: string,
    interval: string,
    intraDay: boolean,
  ): Promise<Record<string, unknown>> {
    // Nubra API limits 10 values/queries per request — chunk and merge
    const BATCH = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += BATCH) chunks.push(symbols.slice(i, i + BATCH));

    const results = await Promise.all(
      chunks.map((batch) =>
        nubraPost(
          '/charts/timeseries',
          {
            query: batch.map((sym) => ({
              exchange,
              type,
              values: [sym],
              fields,
              startDate: `${date}T00:00:00.000Z`,
              endDate: `${date}T23:59:59.000Z`,
              interval,
              intraDay,
              realTime: false,
            })),
          },
          { Authorization: `Bearer ${getSessionToken()!}` },
        ),
      ),
    );

    // Merge all batch results into a single response shape
    const merged: Record<string, unknown> = { result: [{ values: [{}] }] };
    const mergedMap = (merged as any).result[0].values[0] as Record<string, unknown>;
    for (const res of results) {
      for (const group of (res as any).result || []) {
        for (const symbolMap of group.values || []) {
          for (const [sym, data] of Object.entries(symbolMap as Record<string, unknown>)) {
            mergedMap[sym] = data;
          }
        }
      }
    }
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

  // ─── Nubra Backtest — Routes ──────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      underlying?: string;
      date?: string;
      time?: string;
      expiry?: string;
      exchange?: string;
    };
  }>('/api/nubra-backtest/chain', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { underlying = 'NIFTY', date, time = '09:20', expiry } = req.query;
    if (!date) {
      reply.code(400);
      return { ok: false, error: 'date is required.' };
    }

    try {
      const t0 = Date.now();
      const exchange = nbResolveExchange(underlying, req.query.exchange);
      const expiryFlag = exchange === 'MCX' ? 'MONTH' : 'WEEK';

      // Resolve the option expiry first. MCX has no cash/index ticker named
      // CRUDEOIL; its historical underlying is the futures contract backing the
      // selected option expiry (for example FUT_CRUDEOIL_20260819).
      const refdata = await nbGetRefdataForDate(exchange, date);
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
      const assetRef = refdata.filter(
        (item) => item.asset === underlying && item.derivative_type === 'OPT',
      );
      if (!assetRef.length) {
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
      const expiryNumbers = Array.from(new Set(assetRef.map((item) => Number(item.expiry)))).sort(
        (a, b) => a - b,
      );
      const expiries = expiryNumbers.map((num) => {
        const value = String(num);
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
      });
      const selectedExpiry = expiry && expiries.includes(expiry) ? expiry : expiries[0];
      const targetExpiryNum = Number(selectedExpiry.replace(/-/g, ''));
      const expiryOptions = assetRef.filter((item) => Number(item.expiry) === targetExpiryNum);
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
      const spotRes = await nbFetchTs(
        exchange,
        spotType,
        [indexName],
        ['close'],
        date,
        '1m',
        false,
      );
      const spotAll = nbCollect(spotRes);
      const spotChart = spotAll[indexName];
      let spot = 0;
      if (spotChart) {
        const bars = nbParseBars(spotChart);
        const bar = nbFindBar(bars, time);
        if (bar) spot = bar.close;
      }
      if (!spot) {
        // Fallback to daily bar if 1m is not found (e.g. out of market hours or database lag)
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
        const dailyChart = dailyAll[indexName];
        if (dailyChart) {
          const closes = (dailyChart.close || []) as Array<{ ts?: string; v: number }>;
          if (closes.length) spot = closes[0].v / 100;
        }
      }
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
      const strikes: number[] = [];
      const startIdx = Math.max(0, closestIdx - 14);
      const endIdx = Math.min(availableStrikes.length - 1, closestIdx + 14);
      for (let i = startIdx; i <= endIdx; i++) strikes.push(availableStrikes[i]);

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
      return {
        ok: true,
        underlying,
        date,
        time,
        spot,
        expiry: selectedExpiry,
        expiryFlag,
        availableExpiries: expiries.map((e) => ({ expiry: e, flag: expiryFlag })),
        chain,
      };
    } catch (e) {
      console.error('NubraBacktest chain error:', e);
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

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
  }

  const IST_OFFSET = 19800; // 5h30m in seconds

  fastify.post<{ Body: NbEvalBody }>('/api/nubra-backtest/evaluate', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const body = req.body;
    if (!body?.underlying || !body?.date || !body?.legs?.length) {
      reply.code(400);
      return { ok: false, error: 'underlying, date, and at least one leg are required.' };
    }

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

      const underlyingBars = spotBars.map((b) => ({
        time: Number(BigInt(b.ts) / 1000000000n) + IST_OFFSET,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }));

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
      const legBarsList: NbBar[][] = [];
      let totalPnl = 0;

      const legPriceData: Array<{
        legIndex: number;
        data: Array<{ time: number; value: number }>;
      }> = [];
      const legPnlData: Array<{ legIndex: number; data: Array<{ time: number; value: number }> }> =
        [];

      for (let li = 0; li < legs.length; li++) {
        const leg = legs[li];
        const symbol = legSymbols[li];
        const bars = optAll[symbol] ? nbParseBars(optAll[symbol]) : [];
        legBarsList.push(bars);

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

      console.log(
        `NubraBacktest eval ${underlying} ${date} ${entryTime}→${exitTime}: ${legs.length} legs, P&L=${Math.round(totalPnl)} in ${Date.now() - t0}ms`,
      );
      return {
        ok: true,
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
    } catch (e) {
      console.error('NubraBacktest eval error:', e);
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
