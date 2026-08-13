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
