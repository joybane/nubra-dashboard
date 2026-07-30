import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { registerNubraBacktestRoutes } from './nubraBacktestRoutes.ts';

let app: ReturnType<typeof Fastify>;
const nubraGet = vi.fn(async () => ({}));
const nubraPost = vi.fn(async () => ({}));

beforeEach(async () => {
  nubraGet.mockClear();
  nubraPost.mockClear();
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
