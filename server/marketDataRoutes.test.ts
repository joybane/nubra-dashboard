import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerMarketDataRoutes } from './marketDataRoutes.ts';

let app: ReturnType<typeof Fastify>;
const getRefdata = vi.fn(async () => [] as Record<string, unknown>[]);
const nubraGet = vi.fn(async () => ({}));
const nubraPost = vi.fn(async () => ({}));

beforeEach(async () => {
  getRefdata.mockClear();
  nubraGet.mockClear();
  nubraPost.mockClear();
  app = Fastify();
  registerMarketDataRoutes({
    fastify: app,
    getRefdata,
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

test('registers every existing market-data endpoint', () => {
  expect(app.hasRoute({ method: 'GET', url: '/api/refdata' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/instruments/search' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/instruments/lookup' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/historical' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/optionchain/:instrument' })).toBe(true);
  expect(app.hasRoute({ method: 'GET', url: '/api/optionchain/:instrument/price' })).toBe(true);
});

test('preserves lookup validation before loading refdata', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/instruments/lookup' });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'ref_id required' });
  expect(getRefdata).not.toHaveBeenCalled();
});

test('preserves historical proxy payload and session authorization', async () => {
  nubraPost.mockResolvedValueOnce({ result: ['unchanged'] });

  const response = await app.inject({
    method: 'POST',
    url: '/api/historical',
    payload: { query: [] },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ result: ['unchanged'] });
  expect(nubraPost).toHaveBeenCalledWith(
    '/charts/timeseries',
    { query: [] },
    { Authorization: 'Bearer test-session-token' },
  );
});

test('preserves search ordering and result envelope', async () => {
  getRefdata.mockResolvedValueOnce([
    { stock_name: 'NIFTYBANK', derivative_type: 'FUT' },
    { stock_name: 'NIFTY', derivative_type: 'INDEX' },
    { stock_name: 'NIFTY 25000 CE', derivative_type: 'OPT' },
  ]);

  const response = await app.inject({
    method: 'GET',
    url: '/api/instruments/search?q=nifty&limit=2',
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    results: [
      { stock_name: 'NIFTY', derivative_type: 'INDEX' },
      { stock_name: 'NIFTYBANK', derivative_type: 'FUT' },
    ],
  });
});

test('ranks an exact commodity asset first and its contracts by nearest expiry', async () => {
  getRefdata.mockResolvedValueOnce([
    {
      stock_name: 'FUT_CRUDEOILM_20260819',
      asset: 'CRUDEOILM',
      derivative_type: 'FUT',
    },
    {
      stock_name: 'FUT_CRUDEOIL_20270919',
      asset: 'CRUDEOIL',
      derivative_type: 'FUT',
    },
    {
      stock_name: 'FUT_CRUDEOIL_20260819',
      asset: 'CRUDEOIL',
      derivative_type: 'FUT',
    },
  ]);

  const response = await app.inject({
    method: 'GET',
    url: '/api/instruments/search?q=crudeoil&exchange=MCX',
  });

  expect(response.statusCode).toBe(200);
  expect(
    (response.json<{ results: Array<{ stock_name: string }> }>().results || []).map(
      (item) => item.stock_name,
    ),
  ).toEqual(['FUT_CRUDEOIL_20260819', 'FUT_CRUDEOIL_20270919', 'FUT_CRUDEOILM_20260819']);
});

test('preserves the authentication guard ahead of market-data work', async () => {
  await app.close();
  app = Fastify();
  registerMarketDataRoutes({
    fastify: app,
    getRefdata,
    nubraGet,
    nubraPost,
    requireAuth: (reply) => {
      reply.status(401).send({ error: 'Not authenticated. Complete login first.' });
      return false;
    },
    getSessionToken: () => null,
  });
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/api/refdata' });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: 'Not authenticated. Complete login first.' });
  expect(getRefdata).not.toHaveBeenCalled();
  expect(nubraGet).not.toHaveBeenCalled();
  expect(nubraPost).not.toHaveBeenCalled();
});
