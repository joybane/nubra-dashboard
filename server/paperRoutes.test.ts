import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerPaperRoutes } from './paperRoutes.ts';

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
