import { test, expect, beforeEach, vi } from 'vitest';
import { sharedJson, invalidateShared, sharedEntryCount } from './sharedRequest.ts';

beforeEach(() => {
  invalidateShared();
  vi.useRealTimers();
});

test('coalesces concurrent callers into a single request', async () => {
  let calls = 0;
  const run = () => {
    calls++;
    return new Promise<number>((r) => setTimeout(() => r(42), 10));
  };

  // Three overlays asking at the same instant — the shape this exists to fix.
  const [a, b, c] = await Promise.all([
    sharedJson('k', 1000, run),
    sharedJson('k', 1000, run),
    sharedJson('k', 1000, run),
  ]);

  expect(calls).toBe(1);
  expect([a, b, c]).toEqual([42, 42, 42]);
});

test('serves the cached result until the TTL expires, then refetches', async () => {
  let calls = 0;
  const run = () => {
    calls++;
    return Promise.resolve(calls);
  };

  expect(await sharedJson('k', 50, run)).toBe(1);
  expect(await sharedJson('k', 50, run)).toBe(1); // within TTL — same value, no new call
  expect(calls).toBe(1);

  await new Promise((r) => setTimeout(r, 60));
  expect(await sharedJson('k', 50, run)).toBe(2); // TTL elapsed — refetched
  expect(calls).toBe(2);
});

test('distinct keys do not share', async () => {
  const run = (v: number) => () => Promise.resolve(v);
  expect(await sharedJson('a', 1000, run(1))).toBe(1);
  expect(await sharedJson('b', 1000, run(2))).toBe(2);
  expect(sharedEntryCount()).toBe(2);
});

test('a rejection is evicted immediately so retries are not blocked', async () => {
  let calls = 0;
  const run = () => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
  };

  await expect(sharedJson('k', 10_000, run)).rejects.toThrow('boom');
  // Without eviction this would serve the rejected promise for the full 10 s TTL.
  expect(await sharedJson('k', 10_000, run)).toBe('ok');
  expect(calls).toBe(2);
});

test('every concurrent caller sees the same rejection', async () => {
  const run = () => Promise.reject(new Error('boom'));
  const results = await Promise.allSettled([
    sharedJson('k', 1000, run),
    sharedJson('k', 1000, run),
  ]);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
});

test('a late rejection does not evict a newer entry for the same key', async () => {
  // Ordering guard: the first promise rejects AFTER a second entry has replaced it. Evicting
  // blindly on catch would throw away the good entry.
  let reject1: (e: Error) => void = () => {};
  const slowFail = () =>
    new Promise<string>((_, rej) => {
      reject1 = rej;
    });

  const first = sharedJson('k', 1000, slowFail);
  invalidateShared('k'); // simulate TTL/manual expiry
  const second = sharedJson('k', 1000, () => Promise.resolve('good'));

  reject1(new Error('late'));
  await expect(first).rejects.toThrow('late');
  expect(await second).toBe('good');
  expect(await sharedJson('k', 1000, () => Promise.resolve('unused'))).toBe('good');
});
