import { expect, test } from 'vitest';
import { chartSubscriptionKey, createChartSubRegistry } from './chartSubRegistry.ts';

const crude = {
  payload: { indexes: ['FUT_CRUDEOIL_20260819'] },
  interval: '1m',
  exchange: 'MCX',
};

test('chart subscription keys normalize exchange, object keys, and symbol order', () => {
  expect(chartSubscriptionKey(crude)).toBe(
    chartSubscriptionKey({
      payload: { indexes: ['FUT_CRUDEOIL_20260819'] },
      interval: '1m',
      exchange: 'mcx',
    }),
  );
});

test('shared chart subscriptions only signal on the first acquire and last release', () => {
  const registry = createChartSubRegistry();
  expect(registry.acquire(crude)).toBe(true);
  expect(registry.acquire(crude)).toBe(false);
  expect(registry.release(crude)).toBe(false);
  expect(registry.active()).toEqual([crude]);
  expect(registry.release(crude)).toBe(true);
  expect(registry.active()).toEqual([]);
});

test('active chart subscriptions remain available for reconnect replay', () => {
  const registry = createChartSubRegistry();
  registry.acquire(crude);
  expect(registry.active()).toEqual([crude]);
});
