import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerNubraBacktestRoutes } from './nubraBacktestRoutes.ts';

let app: ReturnType<typeof Fastify>;
const nubraGet = vi.fn(async () => ({}));
const nubraPost = vi.fn(async () => ({}));

beforeEach(async () => {
  nubraGet.mockReset();
  nubraGet.mockResolvedValue({});
  nubraPost.mockReset();
  nubraPost.mockResolvedValue({});
  app = Fastify();
  registerNubraBacktestRoutes({
    fastify: app,
    nubraGet,
    nubraPost,
    requireAuth: () => true,
    getSessionToken: () => 'test-session-token',
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

test('registers the existing debug and Nubra historical-replay endpoints', () => {
  expect(app.hasRoute({ method: 'GET', url: '/api/debug-chart' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/nubra-backtest/chain' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/nubra-backtest/evaluate' })).toBe(true);
});

test('preserves chain validation before making a broker request', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/nubra-backtest/chain' });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'date is required.' });
  expect(nubraGet).not.toHaveBeenCalled();
  expect(nubraPost).not.toHaveBeenCalled();
});

test('preserves evaluate validation before making a broker request', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/nubra-backtest/evaluate',
    payload: {},
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    ok: false,
    error: 'underlying, date, and at least one leg are required.',
  });
  expect(nubraGet).not.toHaveBeenCalled();
  expect(nubraPost).not.toHaveBeenCalled();
});

test('preserves the authentication guard ahead of chain work', async () => {
  await app.close();
  app = Fastify();
  registerNubraBacktestRoutes({
    fastify: app,
    nubraGet,
    nubraPost,
    requireAuth: (reply) => {
      reply.status(401).send({ error: 'Not authenticated' });
      return false;
    },
    getSessionToken: () => null,
  });
  await app.ready();

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?date=2026-07-17',
  });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: 'Not authenticated' });
  expect(nubraGet).not.toHaveBeenCalled();
  expect(nubraPost).not.toHaveBeenCalled();
});

test('resolves an MCX option chain through its backing futures ticker', async () => {
  const timestamp = '1785450000000000000';
  nubraGet.mockResolvedValue({
    refdata: [
      {
        asset: 'CRUDEOIL',
        derivative_type: 'FUT',
        expiry: 20260819,
        stock_name: 'FUT_CRUDEOIL_20260819',
      },
      {
        asset: 'CRUDEOIL',
        derivative_type: 'OPT',
        expiry: 20260817,
        strike_price: 760000,
        option_type: 'CE',
        stock_name: 'OPT_CRUDEOIL_20260817_CE_760000',
      },
      {
        asset: 'CRUDEOIL',
        derivative_type: 'OPT',
        expiry: 20260817,
        strike_price: 760000,
        option_type: 'PE',
        stock_name: 'OPT_CRUDEOIL_20260817_PE_760000',
      },
    ],
  });
  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] = { close: [{ ts: timestamp, v: item.type === 'FUT' ? 765000 : 25000 }] };
      }
    }
    return { result: [{ values: [values] }] };
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=CRUDEOIL&exchange=MCX&date=2026-07-31&time=09:20',
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    ok: true,
    underlying: 'CRUDEOIL',
    spot: 7650,
    expiry: '2026-08-17',
    expiryFlag: 'MONTH',
  });
  expect(nubraPost).toHaveBeenCalledWith(
    '/charts/timeseries',
    expect.objectContaining({
      query: expect.arrayContaining([
        expect.objectContaining({
          exchange: 'MCX',
          type: 'FUT',
          values: ['FUT_CRUDEOIL_20260819'],
        }),
      ]),
    }),
    expect.any(Object),
  );
});

// nbParseBars aligns each secondary field to the close bars by carrying the last value at or
// before each close timestamp. The scan behind that was rewritten from a restart-at-zero rescan
// into a forward-only cursor; these two tests pin the four cases where the two could diverge:
// a field that starts AFTER the first close, a field with an interior gap, an entry BEFORE the
// first close, and an entry beyond the last close.
const RAGGED_DATE = '2026-07-31';
/** IST wall-clock to the nanosecond timestamp the upstream returns. */
function nsAtIst(hour: number, minute: number): string {
  return String(BigInt(Date.UTC(2026, 6, 31, hour - 5, minute - 30)) * 1_000_000n);
}

function raggedChainMocks() {
  const t1 = nsAtIst(9, 20);
  const t2 = nsAtIst(9, 21);
  const t3 = nsAtIst(9, 22);

  nubraGet.mockResolvedValue({
    refdata: [
      {
        asset: 'NIFTY',
        derivative_type: 'OPT',
        expiry: 20260806,
        strike_price: 2400000,
        option_type: 'CE',
        stock_name: 'NIFTY_CE_24000',
      },
    ],
  });

  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] =
          item.type === 'INDEX'
            ? { close: [{ ts: t3, v: 2400000 }] }
            : {
                close: [
                  { ts: t1, v: 10000 },
                  { ts: t2, v: 11000 },
                  { ts: t3, v: 12000 },
                ],
                // Starts after the first close: nothing is in scope at t1.
                iv_mid: [{ ts: t2, v: 14 }],
                // Interior gap at t2: t1's value must still be the answer there.
                open_interest: [
                  { ts: t1, v: 500 },
                  { ts: t3, v: 700 },
                ],
                // One entry before every close, one after every close. The late entry is
                // never in scope; the early one is in scope throughout.
                cumulative_volume: [
                  { ts: nsAtIst(9, 19), v: 42 },
                  { ts: nsAtIst(15, 30), v: 999 },
                ],
              };
      }
    }
    return { result: [{ values: [values] }] };
  });
}

test('carries ragged field arrays forward onto the last close bar', async () => {
  raggedChainMocks();

  const response = await app.inject({
    method: 'GET',
    url: `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:22`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().chain).toContainEqual(
    expect.objectContaining({
      strike: 24000,
      ceLtp: 120,
      ceIv: 14, // held from t2
      ceOi: 700, // its own entry at t3
      ceVol: 42, // the pre-open entry; the 15:30 one is past t3 and out of scope
    }),
  );
});

test('reports zero for a field whose first entry is later than the bar', async () => {
  raggedChainMocks();

  const response = await app.inject({
    method: 'GET',
    url: `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:20`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().chain).toContainEqual(
    expect.objectContaining({
      strike: 24000,
      ceLtp: 100,
      ceIv: 0, // iv_mid does not start until t2
      ceOi: 500, // its own entry at t1
      ceVol: 42, // the pre-open entry is already in scope
    }),
  );
});

// The upstream caps a timeseries request at 10 symbols, so nbFetchTs chunks and merges. Every
// other test here uses one or two symbols and never crosses that boundary, which left both the
// chunking and the merge unexercised — and both are on the path of every real chain load.
test('chunks past the 10-symbol upstream cap and merges every batch back together', async () => {
  const timestamp = nsAtIst(9, 20);
  const strikes = Array.from({ length: 12 }, (_, i) => 24000 + i * 100);

  nubraGet.mockResolvedValue({
    refdata: strikes.flatMap((strike) =>
      (['CE', 'PE'] as const).map((optionType) => ({
        asset: 'NIFTY',
        derivative_type: 'OPT',
        expiry: 20260806,
        strike_price: strike * 100,
        option_type: optionType,
        stock_name: `NIFTY_${optionType}_${strike}`,
      })),
    ),
  });

  const batchSizes: number[] = [];
  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    batchSizes.push(query.length);
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] =
          item.type === 'INDEX'
            ? { close: [{ ts: timestamp, v: 2450000 }] }
            : { close: [{ ts: timestamp, v: 12345 }] };
      }
    }
    return { result: [{ values: [values] }] };
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:20`,
  });

  expect(response.statusCode).toBe(200);
  // 24 option symbols → three batches of 10/10/4, plus the single-symbol spot request.
  expect(batchSizes.filter((n) => n > 1)).toEqual([10, 10, 4]);
  // Nothing may be dropped by the merge: every strike carries a price from its own batch.
  const chain = response.json().chain as Array<{ strike: number; ceLtp: number; peLtp: number }>;
  expect(chain).toHaveLength(strikes.length);
  for (const strike of strikes) {
    expect(chain).toContainEqual(expect.objectContaining({ strike, ceLtp: 123.45, peLtp: 123.45 }));
  }
});

test('bounds how many timeseries requests are in flight at once', async () => {
  const timestamp = nsAtIst(9, 20);
  // 20 strikes → 40 option symbols → 4 batches, enough to exceed the pool if it were unbounded.
  const strikes = Array.from({ length: 20 }, (_, i) => 24000 + i * 100);
  nubraGet.mockResolvedValue({
    refdata: strikes.flatMap((strike) =>
      (['CE', 'PE'] as const).map((optionType) => ({
        asset: 'NIFTY',
        derivative_type: 'OPT',
        expiry: 20260806,
        strike_price: strike * 100,
        option_type: optionType,
        stock_name: `NIFTY_${optionType}_${strike}`,
      })),
    ),
  });

  let inFlight = 0;
  let peak = 0;
  nubraPost.mockImplementation(async (_endpoint, body) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] =
          item.type === 'INDEX'
            ? { close: [{ ts: timestamp, v: 2450000 }] }
            : { close: [{ ts: timestamp, v: 12345 }] };
      }
    }
    return { result: [{ values: [values] }] };
  });

  const response = await app.inject({
    method: 'GET',
    url: `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:20`,
  });

  expect(response.statusCode).toBe(200);
  // Six simultaneous downloads for one click is the socket pressure behind the intermittent
  // "fetch failed"; the pool is what holds it down.
  expect(peak).toBeLessThanOrEqual(4);
  expect(peak).toBeGreaterThan(1); // still parallel — a serial fan-out would be far slower
});

// Past dates' bars are immutable, so the pane should pay for them exactly once. These two tests
// are what stop that guarantee from silently regressing — in particular the second one pins the
// canonical-field widening, without which the chain and evaluate would never share a cache entry.
test('serves a repeated chain request entirely from cache', async () => {
  raggedChainMocks();
  const url = `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:22`;

  const first = await app.inject({ method: 'GET', url });
  expect(first.statusCode).toBe(200);
  expect(nubraPost).toHaveBeenCalled();

  nubraPost.mockClear();
  const second = await app.inject({ method: 'GET', url });

  expect(second.statusCode).toBe(200);
  expect(second.json().chain).toEqual(first.json().chain);
  expect(nubraPost).not.toHaveBeenCalled();
});

test('serves evaluate from the bars the chain already downloaded', async () => {
  raggedChainMocks();

  await app.inject({
    method: 'GET',
    url: `/api/nubra-backtest/chain?underlying=NIFTY&date=${RAGGED_DATE}&time=09:20`,
  });
  expect(nubraPost).toHaveBeenCalled();

  nubraPost.mockClear();
  const response = await app.inject({
    method: 'POST',
    url: '/api/nubra-backtest/evaluate',
    payload: {
      underlying: 'NIFTY',
      date: RAGGED_DATE,
      expiry: '2026-08-06',
      entryTime: '09:20',
      exitTime: '09:22',
      lotSize: 65,
      legs: [{ strike: 24000, optionType: 'CALL', side: 'BUY', lots: 1 }],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().ok).toBe(true);
  // The legs are a subset of the strikes the chain fetched, and the spot series is the same one.
  expect(nubraPost).not.toHaveBeenCalled();
});

test('does not cache today, whose bars are still being written', async () => {
  const today = new Date().toISOString().slice(0, 10);
  // Has to be an expiry that is still live on the trade date: the route now drops expiries that had
  // already passed, rather than offering one nobody could have traded that day.
  const liveExpiry = Number(
    new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10).replace(/-/g, ''),
  );
  nubraGet.mockResolvedValue({
    refdata: [
      {
        asset: 'NIFTY',
        derivative_type: 'OPT',
        expiry: liveExpiry,
        strike_price: 2400000,
        option_type: 'CE',
        stock_name: 'NIFTY_CE_24000',
      },
    ],
  });
  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] = { close: [{ ts: '1785450000000000000', v: 10000 }] };
      }
    }
    return { result: [{ values: [values] }] };
  });

  const url = `/api/nubra-backtest/chain?underlying=NIFTY&date=${today}&time=09:20`;
  await app.inject({ method: 'GET', url });
  nubraPost.mockClear();
  await app.inject({ method: 'GET', url });

  expect(nubraPost).toHaveBeenCalled();
});

// ─── Reusing a nearby date's instrument master ────────────────────────────────
//
// A cold /refdata/refdata/<date> is 40-45s of a ~34 MB dump and it is charged per date, so browsing
// a week of dates used to pay it a week of times over. Measured across the real cached masters, an
// earlier date's master is a strict subset of a later one — it can be short of contracts, never
// wrong about one. These pin down where the route is willing to rely on that and where it is not.

function niftyOptions(expiry: number, strikes: number[]): Record<string, unknown>[] {
  return strikes.flatMap((strike) =>
    (['CE', 'PE'] as const).map((option_type) => ({
      asset: 'NIFTY',
      derivative_type: 'OPT',
      expiry,
      strike_price: strike * 100,
      option_type,
      stock_name: `NIFTY_${expiry}_${option_type}_${strike}`,
    })),
  );
}

/** ATM 24000 sits in the middle with room for ±14, so the window is never truncated. */
const WIDE_STRIKES = Array.from({ length: 61 }, (_, i) => 23400 + i * 20);

/** Prices every symbol asked for, so the chain gets as far as needing the strike list. */
function priceEverything(): void {
  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] = {
          close: [{ ts: '1785450000000000000', v: item.type === 'OPT' ? 12000 : 2400000 }],
        };
      }
    }
    return { result: [{ values: [values] }] };
  });
}

async function withStore(
  near: { rows: Record<string, unknown>[]; snapshotDate: string } | null,
  exact: Record<string, unknown>[],
) {
  const getRefdataForDate = vi.fn(async () => exact);
  const peekRefdataNear = vi.fn(async () => near);
  await app.close();
  app = Fastify();
  registerNubraBacktestRoutes({
    fastify: app,
    nubraGet,
    nubraPost,
    requireAuth: () => true,
    getSessionToken: () => 'test-session-token',
    refdataStore: { getRefdataForDate, peekRefdataNear, prefetchForDate: vi.fn(async () => {}) },
  });
  await app.ready();
  return { getRefdataForDate, peekRefdataNear };
}

test('answers from a nearby snapshot instead of paying for the date its own master', async () => {
  priceEverything();
  const { getRefdataForDate } = await withStore(
    { rows: niftyOptions(20260818, WIDE_STRIKES), snapshotDate: '2026-08-10' },
    [],
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=NIFTY&date=2026-08-12&time=09:20',
  });

  expect(response.json()).toMatchObject({ ok: true, expiry: '2026-08-18', spot: 24000 });
  expect(response.json().chain).toHaveLength(29);
  expect(getRefdataForDate).not.toHaveBeenCalled();
});

test('refuses a snapshot whose nearest expiry is too far out to be the real one', async () => {
  // Nothing here says the snapshot is wrong — only that it was taken early enough that a nearer
  // weekly could have been listed since, and picking the default expiry is not a guess worth making.
  priceEverything();
  const exact = niftyOptions(20260818, WIDE_STRIKES);
  const { getRefdataForDate } = await withStore(
    { rows: niftyOptions(20260924, WIDE_STRIKES), snapshotDate: '2026-08-10' },
    exact,
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=NIFTY&date=2026-08-12&time=09:20',
  });

  expect(getRefdataForDate).toHaveBeenCalledWith('NSE', '2026-08-12');
  expect(response.json()).toMatchObject({ ok: true, expiry: '2026-08-18' });
});

test('accepts a far-out snapshot once the caller names an expiry it holds', async () => {
  // With the expiry given, the snapshot is not being asked to choose one — only to supply its
  // strikes, which is the half it is reliable about.
  priceEverything();
  const { getRefdataForDate } = await withStore(
    { rows: niftyOptions(20260924, WIDE_STRIKES), snapshotDate: '2026-08-10' },
    [],
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=NIFTY&date=2026-08-12&time=09:20&expiry=2026-09-24',
  });

  expect(response.json()).toMatchObject({ ok: true, expiry: '2026-09-24' });
  expect(getRefdataForDate).not.toHaveBeenCalled();
});

test('goes back for the exact master when the ATM window runs off the snapshot', async () => {
  // The one symptom of strikes listed after the snapshot was taken. Returning the narrow chain
  // would be quietly wrong, which is the one outcome this whole path must not have.
  priceEverything();
  const exact = niftyOptions(20260818, WIDE_STRIKES);
  const { getRefdataForDate } = await withStore(
    { rows: niftyOptions(20260818, [23980, 24000, 24020]), snapshotDate: '2026-08-10' },
    exact,
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=NIFTY&date=2026-08-12&time=09:20',
  });

  expect(getRefdataForDate).toHaveBeenCalledWith('NSE', '2026-08-12');
  expect(response.json().chain).toHaveLength(29);
});

test('drops expiries that had already passed on the trade date', async () => {
  priceEverything();
  nubraGet.mockResolvedValue({
    refdata: [...niftyOptions(20260804, WIDE_STRIKES), ...niftyOptions(20260818, WIDE_STRIKES)],
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/nubra-backtest/chain?underlying=NIFTY&date=2026-08-12&time=09:20',
  });

  // The 4th had expired eight days earlier; offering it as the default would have backtested a
  // contract nobody could have traded that day.
  expect(response.json()).toMatchObject({ ok: true, expiry: '2026-08-18' });
  expect(response.json().availableExpiries).toEqual([{ expiry: '2026-08-18', flag: 'WEEK' }]);
});

test('returns true MCX futures OHLC candles for backtest evaluation', async () => {
  const timestamp = '1785450000000000000';
  nubraGet.mockResolvedValue({
    refdata: [
      {
        asset: 'CRUDEOIL',
        derivative_type: 'FUT',
        expiry: 20260819,
        stock_name: 'FUT_CRUDEOIL_20260819',
      },
      {
        asset: 'CRUDEOIL',
        derivative_type: 'OPT',
        expiry: 20260817,
        strike_price: 760000,
        option_type: 'CE',
        stock_name: 'OPT_CRUDEOIL_20260817_CE_760000',
      },
    ],
  });
  nubraPost.mockImplementation(async (_endpoint, body) => {
    const query = (body as any).query as Array<{ type: string; values: string[] }>;
    const values: Record<string, unknown> = {};
    for (const item of query) {
      for (const symbol of item.values) {
        values[symbol] =
          item.type === 'FUT'
            ? {
                open: [{ ts: timestamp, v: 760000 }],
                high: [{ ts: timestamp, v: 770000 }],
                low: [{ ts: timestamp, v: 755000 }],
                close: [{ ts: timestamp, v: 765000 }],
              }
            : { close: [{ ts: timestamp, v: 25000 }] };
      }
    }
    return { result: [{ values: [values] }] };
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/nubra-backtest/evaluate',
    payload: {
      underlying: 'CRUDEOIL',
      exchange: 'MCX',
      date: '2026-07-31',
      expiry: '2026-08-17',
      entryTime: '09:20',
      exitTime: '15:15',
      lotSize: 100,
      legs: [{ strike: 7600, optionType: 'CALL', side: 'BUY', lots: 1 }],
    },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().underlyingBars).toEqual([
    expect.objectContaining({ open: 7600, high: 7700, low: 7550, close: 7650 }),
  ]);
});
