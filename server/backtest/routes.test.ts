import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { registerBacktestRoutes } from './routes.ts';

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  app = Fastify();
  registerBacktestRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

test('registers every existing local backtest endpoint', () => {
  expect(app.hasRoute({ method: 'GET', url: '/api/backtest/meta' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/backtest/run' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/backtest/day' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/backtest/sweep' })).toBe(true);
  expect(app.hasRoute({ method: 'POST', url: '/api/backtest/walkforward' })).toBe(true);
});

test('preserves run validation status and response shape', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/backtest/run', payload: {} });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'Unknown underlying: undefined' });
});

test('preserves day validation status and response shape', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/backtest/day', payload: {} });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'Missing config.' });
});

test('preserves sweep validation status and response shape', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/backtest/sweep',
    payload: { base: {} },
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'Unknown underlying: undefined' });
});

test('preserves walk-forward validation status and response shape', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/backtest/walkforward',
    payload: { base: {} },
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ ok: false, error: 'Unknown underlying: undefined' });
});
