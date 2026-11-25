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

test('releases expired history responses without another read', async () => {
  vi.useFakeTimers();
  const history = Array.from({ length: 240 }, (_, i) =>
    sharedJson(`history-${i}`, 15_000, () => Promise.resolve(i)),
  );
  await Promise.all(history);

  expect(sharedEntryCount()).toBe(240);
  expect(vi.getTimerCount()).toBe(1);

  vi.advanceTimersByTime(14_999);
  expect(sharedEntryCount()).toBe(240);
  vi.advanceTimersByTime(1);
  expect(sharedEntryCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps fresh responses and cancels cleanup after invalidation', async () => {
  vi.useFakeTimers();
  await sharedJson('long', 2_000, () => Promise.resolve('long'));
  vi.advanceTimersByTime(100);
  await sharedJson('short', 500, () => Promise.resolve('short'));
  expect(vi.getTimerCount()).toBe(1);

  vi.advanceTimersByTime(500);
  expect(sharedEntryCount()).toBe(1);
  expect(await sharedJson('long', 2_000, () => Promise.resolve('new'))).toBe('long');
  expect(vi.getTimerCount()).toBe(1);

  invalidateShared('long');
  expect(sharedEntryCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
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

test('expiration releases pending work without affecting its result or replacement', async () => {
  vi.useFakeTimers();
  let finish: (value: string) => void = () => {};
  const first = sharedJson(
    'k',
    100,
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  vi.advanceTimersByTime(100);
  expect(sharedEntryCount()).toBe(0);

  const second = sharedJson('k', 100, () => Promise.resolve('current'));
  finish('original');
  await expect(first).resolves.toBe('original');
  await expect(second).resolves.toBe('current');
  expect(sharedJson('k', 100, () => Promise.resolve('unused'))).toBe(second);
});
