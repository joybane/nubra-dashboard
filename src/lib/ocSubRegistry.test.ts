import { test, expect } from 'vitest';
import { createOcSubRegistry, ocKey } from './ocSubRegistry.ts';

const NIFTY = ocKey('NIFTY', '20260728', 'NSE');
const BANK = ocKey('BANKNIFTY', '20260728', 'NSE');

// ─── §1  Key normalisation ───────────────────────────────────────────────────────
test('ocKey is case-insensitive on asset and exchange but not on expiry', () => {
  expect(ocKey('nifty', '20260728', 'nse')).toBe(NIFTY);
  expect(ocKey('NIFTY', '20260804', 'NSE')).not.toBe(NIFTY);
  expect(ocKey('NIFTY', '20260728', 'BSE')).not.toBe(NIFTY);
});

// ─── §2  Only the edges talk to the socket ───────────────────────────────────────
test('acquire signals upstream only on 0 -> 1, release only on 1 -> 0', () => {
  const r = createOcSubRegistry();

  expect(r.acquire(NIFTY)).toBe(true); // first consumer — subscribe
  expect(r.acquire(NIFTY)).toBe(false); // second consumer — already streaming
  expect(r.acquire(NIFTY)).toBe(false);
  expect(r.count(NIFTY)).toBe(3);

  expect(r.release(NIFTY)).toBe(false); // two consumers left — keep the feed
  expect(r.release(NIFTY)).toBe(false); // one left — keep the feed
  expect(r.release(NIFTY)).toBe(true); // last one out — unsubscribe
  expect(r.count(NIFTY)).toBe(0);
});

// This is the bug the registry exists to prevent: the basket dropping a leg must
// not tear the feed out from under an Option Chain tab that is still on screen.
test('one consumer releasing does not stop a feed another still holds', () => {
  const r = createOcSubRegistry();
  r.acquire(NIFTY); // Option Chain tab
  r.acquire(NIFTY); // basket leg on the same expiry

  expect(r.release(NIFTY)).toBe(false); // leg removed
  expect(r.active()).toContain(NIFTY); // tab still fed
});

// ─── §3  Unbalanced cleanups are inert ───────────────────────────────────────────
test('release on an unheld key is a no-op and cannot go negative', () => {
  const r = createOcSubRegistry();

  expect(r.release(NIFTY)).toBe(false);
  expect(r.count(NIFTY)).toBe(0);

  // A stray release must not leave a debt that swallows the next real subscribe.
  expect(r.acquire(NIFTY)).toBe(true);
  expect(r.count(NIFTY)).toBe(1);
});

test('double release after a single acquire signals upstream exactly once', () => {
  const r = createOcSubRegistry();
  r.acquire(NIFTY);

  expect(r.release(NIFTY)).toBe(true);
  expect(r.release(NIFTY)).toBe(false);
  expect(r.active()).toEqual([]);
});

// ─── §4  Replay set after a reconnect ────────────────────────────────────────────
test('active() lists every wanted key and drops fully released ones', () => {
  const r = createOcSubRegistry();
  r.acquire(NIFTY);
  r.acquire(BANK);
  r.acquire(BANK);

  expect(r.active().sort()).toEqual([BANK, NIFTY].sort());

  r.release(NIFTY);
  expect(r.active()).toEqual([BANK]);

  r.release(BANK);
  expect(r.active()).toEqual([BANK]); // one holder left
  r.release(BANK);
  expect(r.active()).toEqual([]);
});

// Subscriptions issued before the socket opened are still "wanted", so the
// open handler replays them — this is what fixes the cold-start race.
test('keys acquired while disconnected are still replayable', () => {
  const r = createOcSubRegistry();
  r.acquire(NIFTY);
  r.acquire(BANK);
  expect(r.active().sort()).toEqual([BANK, NIFTY].sort());
});
