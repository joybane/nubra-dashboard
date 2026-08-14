import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createBacktestBarStore, type BarPayload } from './backtestBarStore.ts';

const TODAY = '2026-08-14';
const PAST = '2026-08-13';

const BARS: BarPayload = {
  close: [
    { ts: '1785450000000000000', v: 12345 },
    { ts: '1785450060000000000', v: 12400 },
  ],
  iv_mid: [{ ts: '1785450000000000000', v: 21 }],
};

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bar-store-'));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function store(overrides: Parameters<typeof createBacktestBarStore>[0] = {}) {
  return createBacktestBarStore({ cacheDir, sharedDay: () => TODAY, ...overrides });
}

test('round-trips a payload through memory', async () => {
  const s = store();
  await s.put('NSE', PAST, '1m', new Map([['NIFTY_CE_24000', BARS]]));

  const hits = await s.get('NSE', PAST, '1m', ['NIFTY_CE_24000']);
  expect(hits.get('NIFTY_CE_24000')).toEqual(BARS);
});

test('round-trips a payload through disk in a fresh process', async () => {
  await store().put('NSE', PAST, '1m', new Map([['NIFTY_CE_24000', BARS]]));

  const restarted = store();
  const hits = await restarted.get('NSE', PAST, '1m', ['NIFTY_CE_24000']);
  expect(hits.get('NIFTY_CE_24000')).toEqual(BARS);
});

test('returns only the symbols it has, so callers can fetch the rest', async () => {
  const s = store();
  await s.put('NSE', PAST, '1m', new Map([['A', BARS]]));

  const hits = await s.get('NSE', PAST, '1m', ['A', 'B', 'C']);
  expect([...hits.keys()]).toEqual(['A']);
});

test('caches an empty payload — an illiquid strike genuinely has no bars', async () => {
  // This is where copying backtestRefdataStore's "never cache empty" rule would be a bug: the
  // deep wings would re-download on every single chain load, forever.
  const s = store();
  await s.put('NSE', PAST, '1m', new Map([['NIFTY_CE_99000', {}]]));

  const hits = await s.get('NSE', PAST, '1m', ['NIFTY_CE_99000']);
  expect(hits.has('NIFTY_CE_99000')).toBe(true);
  expect(hits.get('NIFTY_CE_99000')).toEqual({});
});

test('keys separately by exchange, date and interval', async () => {
  const s = store();
  await s.put('NSE', PAST, '1m', new Map([['SYM', BARS]]));

  expect((await s.get('BSE', PAST, '1m', ['SYM'])).size).toBe(0);
  expect((await s.get('NSE', '2026-08-12', '1m', ['SYM'])).size).toBe(0);
  expect((await s.get('NSE', PAST, '1d', ['SYM'])).size).toBe(0);
  expect((await s.get('NSE', PAST, '1m', ['SYM'])).size).toBe(1);
});

test('bypasses the cache entirely for today, whose bars are still growing', async () => {
  const s = store();

  expect(s.isCacheable(TODAY)).toBe(false);
  expect(s.isCacheable('2026-08-15')).toBe(false);
  expect(s.isCacheable(PAST)).toBe(true);

  await s.put('NSE', TODAY, '1m', new Map([['SYM', BARS]]));

  // Neither tier may hold it: memory would serve a stale morning snapshot all afternoon.
  expect((await s.get('NSE', TODAY, '1m', ['SYM'])).size).toBe(0);
  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
});

test('discards a truncated cache file and reports a miss', async () => {
  await store().put('NSE', PAST, '1m', new Map([['SYM', BARS]]));
  const file = path.join(cacheDir, `NSE_${PAST}`, 'SYM_1m_v1.json.gz');
  await fs.writeFile(file, Buffer.from('not gzip'));

  const restarted = store();
  expect((await restarted.get('NSE', PAST, '1m', ['SYM'])).size).toBe(0);
  // It is removed rather than left to fail forever.
  await expect(fs.access(file)).rejects.toThrow();
});

test('keeps a malformed key out of the cache directory', async () => {
  const s = store();
  await s.put('NSE', PAST, '1m', new Map([['../../etc/passwd', BARS]]));
  await s.put('../evil', PAST, '1m', new Map([['SYM', BARS]]));
  await s.put('NSE', PAST, '../1m', new Map([['SYM', BARS]]));

  // Nothing is written at all — not even the containing directory.
  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
  // …but the payload is still memoised, so an unusual symbol is slower, never broken.
  expect((await s.get('NSE', PAST, '1m', ['../../etc/passwd'])).size).toBe(1);
});

test('works with no cacheDir at all, keeping everything in memory', async () => {
  const s = createBacktestBarStore({ sharedDay: () => TODAY });
  await s.put('NSE', PAST, '1m', new Map([['SYM', BARS]]));
  expect((await s.get('NSE', PAST, '1m', ['SYM'])).get('SYM')).toEqual(BARS);
});

test('bounds how many payloads stay resident in memory', async () => {
  // No cacheDir, so a memory eviction is observable as a miss rather than falling through to disk.
  const s = createBacktestBarStore({ sharedDay: () => TODAY, maxResident: 2 });
  for (const sym of ['A', 'B', 'C']) {
    await s.put('NSE', PAST, '1m', new Map([[sym, BARS]]));
  }

  expect((await s.get('NSE', PAST, '1m', ['A'])).size).toBe(0);
  expect((await s.get('NSE', PAST, '1m', ['B', 'C'])).size).toBe(2);
});

test('prunes whole date directories past the cap', async () => {
  const s = store({ maxDates: 2 });

  for (const date of ['2026-08-10', '2026-08-11', '2026-08-12']) {
    await s.put('NSE', date, '1m', new Map([['SYM', BARS]]));
    // Distinct mtimes, so "least recently used" is unambiguous on a coarse filesystem clock.
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  const dirs = (await fs.readdir(cacheDir)).sort();
  expect(dirs).toHaveLength(2);
  expect(dirs).not.toContain('NSE_2026-08-10');
});

test('a disk failure degrades to a miss rather than rejecting', async () => {
  // Point the store at a path that cannot hold a directory, so every write fails.
  const blocked = path.join(cacheDir, 'blocker');
  await fs.writeFile(blocked, 'not a directory');
  const s = createBacktestBarStore({ cacheDir: blocked, sharedDay: () => TODAY, maxResident: 0 });

  await expect(s.put('NSE', PAST, '1m', new Map([['SYM', BARS]]))).resolves.toBeUndefined();
  await expect(s.get('NSE', PAST, '1m', ['SYM'])).resolves.toEqual(new Map());
});
