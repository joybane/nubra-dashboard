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
