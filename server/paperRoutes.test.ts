import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerPaperRoutes } from './paperRoutes.ts';
import { clearMarginCalibrations } from './marginEngine.ts';

let app: ReturnType<typeof Fastify>;
const simBroker = {
  getOrders: vi.fn(() => []),
  placeOrder: vi.fn(() => ({ order_id: 1 })),
  getPositions: vi.fn(() => []),
  getClosedPositions: vi.fn(() => []),
  modifyOrder: vi.fn(() => false),
  cancelOrder: vi.fn(() => false),
  registerName: vi.fn(),
  renameStrategy: vi.fn(() => false),
};
const subscribeForSim = vi.fn();
const fireRules = vi.fn();
const buildDebugResponse = vi.fn(() => ({ feed: 'unchanged' }));
const nubraGet = vi.fn(async () => ({}));
const nubraPostAt = vi.fn(async () => ({}));

function register(
  requireAuth: Parameters<typeof registerPaperRoutes>[0]['requireAuth'] = () => true,
) {
  registerPaperRoutes({
    fastify: app,
    requireAuth,
    getAuthStatus: () => 'authenticated',
    getSessionToken: () => 'test-session-token',
    simBroker,
    subscribeForSim,
    fireRules,
    buildDebugResponse,
    nubraGet,
    nubraPostAt,
    marginBaseUrl: 'https://margin.test',
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearMarginCalibrations();
  app = Fastify();
  register();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

test('registers every existing paper-trading endpoint', () => {
  const routes: Array<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; url: string }> = [
    { method: 'GET', url: '/paper/auth/status' },
    { method: 'GET', url: '/paper/orders' },
    { method: 'POST', url: '/paper/orders' },
    { method: 'POST', url: '/paper/orders/multi' },
    { method: 'GET', url: '/paper/positions/rules' },
    { method: 'PUT', url: '/paper/positions/rules/leg' },
    { method: 'PUT', url: '/paper/positions/rules/group' },
    { method: 'DELETE', url: '/paper/positions/rules/leg' },
    { method: 'DELETE', url: '/paper/positions/rules/group' },
    { method: 'POST', url: '/paper/orders/basket' },
    { method: 'POST', url: '/paper/orders/modify/:id' },
    { method: 'DELETE', url: '/paper/orders/:id' },
    { method: 'GET', url: '/paper/positions' },
    { method: 'GET', url: '/paper/positions/closed' },
    { method: 'GET', url: '/paper/debug' },
    { method: 'GET', url: '/paper/holdings' },
    { method: 'GET', url: '/paper/pnl' },
    { method: 'POST', url: '/paper/margin/basket' },
    { method: 'GET', url: '/paper/baskets' },
    { method: 'POST', url: '/paper/baskets' },
    { method: 'DELETE', url: '/paper/baskets/:id' },
    { method: 'PUT', url: '/paper/baskets/:id' },
    { method: 'PUT', url: '/paper/strategy/rename' },
    { method: 'POST', url: '/paper/strategy/snapshot' },
    { method: 'GET', url: '/paper/strategy/snapshots' },
    { method: 'GET', url: '/paper/strategy/snapshot/:id' },
    { method: 'DELETE', url: '/paper/strategy/snapshot/:id' },
    { method: 'POST', url: '/paper/margin' },
  ];

  for (const route of routes) expect(app.hasRoute(route)).toBe(true);
});

test('preserves paper auth-status and debug response envelopes', async () => {
  const auth = await app.inject({ method: 'GET', url: '/paper/auth/status' });
  const debug = await app.inject({ method: 'GET', url: '/paper/debug' });

  expect(auth.json()).toEqual({ status: 'authenticated', authenticated: true });
  expect(debug.json()).toEqual({ feed: 'unchanged' });
  expect(buildDebugResponse).toHaveBeenCalledOnce();
});

test('preserves order validation before subscription or placement', async () => {
  const response = await app.inject({ method: 'POST', url: '/paper/orders', payload: {} });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'liveRefId is required for live simulation.' });
  expect(subscribeForSim).not.toHaveBeenCalled();
  expect(simBroker.placeOrder).not.toHaveBeenCalled();
});

test('preserves basket and multi-order validation', async () => {
  const multi = await app.inject({
    method: 'POST',
    url: '/paper/orders/multi',
    payload: { orders: [] },
  });
  const basket = await app.inject({
    method: 'POST',
    url: '/paper/orders/basket',
    payload: { orders: [] },
  });

  expect(multi.statusCode).toBe(400);
  expect(multi.json()).toEqual({ error: 'orders must be a non-empty array' });
  expect(basket.statusCode).toBe(400);
  expect(basket.json()).toEqual({ error: 'orders must be a non-empty array' });
});

test('preserves holdings and PnL calculations', async () => {
  simBroker.getPositions.mockReturnValueOnce([
    {
      ref_id: 1,
      nubraName: 'NIFTY',
      display_name: 'NIFTY',
      qty: 2,
      avg_price: 100,
      realized_pnl: 5,
      last_traded_price: 120,
      order_delivery_type: 'IDAY',
    },
  ]);
  simBroker.getClosedPositions.mockReturnValueOnce([
    {
      ref_id: 2,
      nubraName: 'NIFTY',
      display_name: 'NIFTY',
      qty: 0,
      avg_price: 90,
      realized_pnl: 10,
      last_traded_price: 90,
      order_delivery_type: 'IDAY',
    },
  ]);

  const holdings = await app.inject({ method: 'GET', url: '/paper/holdings' });
  const pnl = await app.inject({ method: 'GET', url: '/paper/pnl' });

  expect(holdings.json()).toEqual([]);
  expect(pnl.json()).toEqual({ realised: 15, unrealised: 40, total: 55 });
});

// ── Order amendment ──────────────────────────────────────────────────────────

test('rejects an empty or malformed amendment before it reaches the broker', async () => {
  const cases: Array<[unknown, string]> = [
    [{}, 'supply at least one of order_price, trigger_price, order_qty'],
    [{ order_qty: 0 }, 'order_qty must be greater than zero'],
    [{ order_qty: -3 }, 'order_qty must be a non-negative number'],
    [{ order_qty: 65.5 }, 'order_qty must be a whole number'],
    [{ order_price: -1 }, 'order_price must be a non-negative number'],
    [{ order_price: 'cheap' }, 'order_price must be a non-negative number'],
  ];

  for (const [payload, error] of cases) {
    const response = await app.inject({
      method: 'POST',
      url: '/paper/orders/modify/7',
      payload: payload as object,
    });
    expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    expect(response.json()).toEqual({ error });
  }

  const badId = await app.inject({
    method: 'POST',
    url: '/paper/orders/modify/not-a-number',
    payload: { order_qty: 1 },
  });
  expect(badId.statusCode).toBe(400);
  expect(simBroker.modifyOrder).not.toHaveBeenCalled();
});

test('returns the amended order so a fill on amendment is visible without polling', async () => {
  simBroker.modifyOrder.mockReturnValueOnce(true);
  simBroker.getOrders.mockReturnValueOnce([
    { order_id: 7, order_status: 'ORDER_STATUS_FILLED', order_price: 9_500 },
  ]);

  const response = await app.inject({
    method: 'POST',
    url: '/paper/orders/modify/7',
    payload: { order_price: 9_500 },
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    ok: true,
    order: { order_id: 7, order_status: 'ORDER_STATUS_FILLED', order_price: 9_500 },
  });
  expect(simBroker.modifyOrder).toHaveBeenCalledWith(7, { order_price: 9_500 });
});

test('still 404s an amendment the broker refuses', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/paper/orders/modify/7',
    payload: { order_price: 9_500 },
  });

  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ error: 'Order not found or already filled/cancelled.' });
});

// ── Saved baskets ────────────────────────────────────────────────────────────

test('answers a malformed basket with the field that is wrong, not a driver 500', async () => {
  const cases: Array<[object, string]> = [
    [{}, 'name is required'],
    [{ name: '  ' }, 'name is required'],
    [{ name: 'Condor' }, 'symbol is required'],
    [{ name: 'Condor', symbol: 'NIFTY' }, 'expiry is required'],
    [{ name: 'Condor', symbol: 'NIFTY', expiry: '20260827' }, 'legs must be a non-empty array'],
    [
      { name: 'Condor', symbol: 'NIFTY', expiry: '20260827', legs: [] },
      'legs must be a non-empty array',
    ],
  ];

  for (const [payload, error] of cases) {
    const response = await app.inject({ method: 'POST', url: '/paper/baskets', payload });
    expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    expect(response.json()).toEqual({ error });
  }
});

test('puts the snapshot store behind the same auth guard as every other paper route', async () => {
  await app.close();
  app = Fastify();
  register((reply) => {
    reply.status(401).send({ error: 'Not authenticated. Complete login first.' });
    return false;
  });
  await app.ready();

  const guarded: Array<{ method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
    { method: 'POST', url: '/paper/strategy/snapshot' },
    { method: 'GET', url: '/paper/strategy/snapshots' },
    { method: 'GET', url: '/paper/strategy/snapshot/abc' },
    { method: 'DELETE', url: '/paper/strategy/snapshot/abc' },
  ];

  for (const route of guarded) {
    const response = await app.inject({ ...route, payload: {} });
    expect(response.statusCode, route.url).toBe(401);
  }
});

test('preserves the authentication guard ahead of broker work', async () => {
  await app.close();
  app = Fastify();
  register((reply) => {
    reply.status(401).send({ error: 'Not authenticated. Complete login first.' });
    return false;
  });
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/paper/orders' });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ error: 'Not authenticated. Complete login first.' });
  expect(simBroker.getOrders).not.toHaveBeenCalled();
});

function optionChain(ts = Date.now()) {
  return {
    chain: {
      cp: 2_400_000,
      ce: [
        {
          sp: 2_400_000,
          ref_id: 101,
          ltp: 15_000,
          iv: 0.12,
          delta: 0.5,
          gamma: 0.001,
          theta: -8,
          vega: 12,
          oi: 25_000,
          volume: 5_000,
          ls: 65,
          ts: String(BigInt(ts) * 1_000_000n),
        },
      ],
      pe: [],
    },
  };
}

function dailyHistory() {
  const end = new Date('2026-08-09T10:00:00Z').getTime();
  const prices = [23350, 23420, 23510, 23390, 23620, 23700, 23810, 23760, 23900, 23950];
  return {
    result: [
      {
        values: [
          {
            NIFTY: {
              close: prices.map((price, index) => ({
                ts: String(BigInt(end - (prices.length - 1 - index) * 86_400_000) * 1_000_000n),
                v: price * 100,
              })),
            },
          },
        ],
      },
    ],
  };
}

const marginPayload = {
  exchange: 'NSE',
  orders: [
    {
      ref_id: 101,
      order_qty: 65,
      order_side: 'ORDER_SIDE_SELL',
      order_type: 'MARKET',
      order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
      strike: 2_400_000, // order-ticket/refdata paise; route must normalize to rupees
      option_type: 'CE',
      expiry: '20260904',
      symbol: 'NIFTY',
      lot_size: 65,
    },
  ],
};

test('keeps the Nubra quote authoritative and does not load history on success', async () => {
  nubraGet.mockResolvedValueOnce(optionChain());
  nubraPostAt.mockResolvedValueOnce({ marginInfo: { totalMargin: 18_000_000 } });

  const response = await app.inject({
    method: 'POST',
    url: '/paper/margin/basket',
    payload: marginPayload,
  });
  const body = response.json();

  expect(response.statusCode).toBe(200);
  expect(body.total_margin).toBe(18_000_000);
  expect(body.estimated).toBe(false);
  expect(body.source).toBe('nubra-margin-api');
  expect(body.confidence).toBe('authoritative');
  expect(nubraPostAt).toHaveBeenCalledTimes(1);
});

test('preserves basket ratios with the quantity GCD in Nubra multi-leg quotes', async () => {
  nubraGet.mockResolvedValueOnce(optionChain());
  nubraPostAt.mockResolvedValueOnce({ marginInfo: { totalMargin: 18_000_000 } });

  const response = await app.inject({
    method: 'POST',
    url: '/paper/margin/basket',
    payload: {
      ...marginPayload,
      orders: [
        { ...marginPayload.orders[0], order_qty: 130, order_side: 'ORDER_SIDE_BUY' },
        { ...marginPayload.orders[0], ref_id: 102, order_qty: 195 },
      ],
    },
  });
  const request = nubraPostAt.mock.calls[0][2] as {
    orders: Array<{ qty: number; legs: Array<{ unitQty: number }> }>;
  };

  expect(response.statusCode).toBe(200);
  expect(request.orders[0].qty).toBe(65);
  expect(request.orders[0].legs.map((leg) => leg.unitQty)).toEqual([2, -3]);
});

test('normalizes paise strikes and builds a conservative fallback from existing feeds', async () => {
  nubraGet.mockResolvedValueOnce(optionChain());
  nubraPostAt
    .mockRejectedValueOnce(new Error('margin service unavailable'))
    .mockResolvedValueOnce(dailyHistory());

  const response = await app.inject({
    method: 'POST',
    url: '/paper/margin/basket',
    payload: marginPayload,
  });
  const body = response.json();

  expect(response.statusCode).toBe(200);
  expect(body.estimated).toBe(true);
  expect(body.source).toBe('feed-dynamic-span');
  expect(body.confidence).toBe('medium');
  expect(body.total_margin).toBe(body.conservative_total);
  expect(body.total_margin).toBeGreaterThan(body.raw_estimate);
  expect(body.resolved_legs[0]).toMatchObject({ strike: 24000, spot: 24000 });
  expect(body.message).toMatch(/safety buffer/i);
  expect(nubraPostAt).toHaveBeenNthCalledWith(
    2,
    process.env.NUBRA_BASE_URL || 'https://api2.nubra.io',
    '/charts/timeseries',
    expect.any(Object),
    { Authorization: 'Bearer test-session-token' },
  );
});

test('normalizes option-chain spot correctly for stocks priced below Rs 100', async () => {
  const chain = optionChain();
  chain.chain.cp = 5_000;
  chain.chain.ce[0].sp = 5_000;
  nubraGet.mockResolvedValueOnce(chain);
  nubraPostAt.mockResolvedValueOnce({ marginInfo: { totalMargin: 250_000 } });

  const response = await app.inject({
    method: 'POST',
    url: '/paper/margin/basket',
    payload: {
      ...marginPayload,
      orders: [{ ...marginPayload.orders[0], strike: 5_000, symbol: 'LOWSTOCK' }],
    },
  });
  const body = response.json();

  expect(response.statusCode).toBe(200);
  expect(body.resolved_legs[0]).toMatchObject({ strike: 50, spot: 50 });
});

test('single-order fallback also normalizes refdata strikes before pricing', async () => {
  nubraGet.mockResolvedValueOnce(optionChain());
  nubraPostAt
    .mockRejectedValueOnce(new Error('margin service unavailable'))
    .mockResolvedValueOnce(dailyHistory());

  const response = await app.inject({
    method: 'POST',
    url: '/paper/margin',
    payload: {
      liveRefId: 101,
      order_qty: 65,
      order_side: 'ORDER_SIDE_SELL',
      order_type: 'ORDER_TYPE_MARKET',
      order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
      exchange: 'NSE',
      strike: 2_400_000,
      option_type: 'CE',
      expiry: '20260904',
      symbol: 'NIFTY',
      lot_size: 65,
      ltp: 150,
    },
  });
  const body = response.json();

  expect(response.statusCode).toBe(200);
  expect(body.estimated).toBe(true);
  expect(body.source).toBe('feed-dynamic-span');
  expect(body.confidence).toBe('medium');
  expect(body.total_margin).toBeGreaterThan(0);
  expect(body.total_margin).toBeLessThan(50_000_000);
});
