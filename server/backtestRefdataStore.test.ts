import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBacktestRefdataStore } from './backtestRefdataStore.ts';

const INSTRUMENTS = [{ asset: 'NIFTY', derivative_type: 'OPT', expiry: 20260806 }];

let cacheDir: string;
const nubraGet = vi.fn(async () => ({ refdata: INSTRUMENTS }) as Record<string, unknown>);

beforeEach(async () => {
  nubraGet.mockReset();
  nubraGet.mockResolvedValue({ refdata: INSTRUMENTS });
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'refdata-store-'));
});

afterEach(async () => {
  // Disk writes are deliberately not awaited by the request path, so on Windows a `.tmp` file can
  // still be open here and rmdir fails with ENOTEMPTY. Retry rather than fail an unrelated test.
  await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Lets a test hold the upstream call open so concurrency is observable. */
function gate() {
  let release!: (v: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>((res) => {
    release = res;
  });
  return { promise, release };
}

test('single-flights concurrent requests for the same date', async () => {
  const held = gate();
  nubraGet.mockReturnValue(held.promise);
  const store = createBacktestRefdataStore({ nubraGet });

  const first = store.getRefdataForDate('NSE', '2026-08-10');
  const second = store.getRefdataForDate('NSE', '2026-08-10');
  held.release({ refdata: INSTRUMENTS });

  await expect(first).resolves.toEqual(INSTRUMENTS);
  await expect(second).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('memoises a settled date in memory', async () => {
  const store = createBacktestRefdataStore({ nubraGet });

  await store.getRefdataForDate('NSE', '2026-08-10');
  await store.getRefdataForDate('NSE', '2026-08-10');

  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('keys separately by exchange', async () => {
  const store = createBacktestRefdataStore({ nubraGet });

  await store.getRefdataForDate('NSE', '2026-08-10');
  await store.getRefdataForDate('MCX', '2026-08-10');

  expect(nubraGet).toHaveBeenCalledTimes(2);
  expect(nubraGet).toHaveBeenCalledWith('/refdata/refdata/2026-08-10', { exchange: 'MCX' });
});

test('returns an empty array on upstream failure without caching it', async () => {
  const store = createBacktestRefdataStore({ nubraGet });
  nubraGet.mockRejectedValueOnce(new Error('fetch failed'));

  await expect(store.getRefdataForDate('NSE', '2026-08-10')).resolves.toEqual([]);
  await expect(store.getRefdataForDate('NSE', '2026-08-10')).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).toHaveBeenCalledTimes(2);
});

test('does not cache an empty result', async () => {
  const store = createBacktestRefdataStore({ nubraGet });
  nubraGet.mockResolvedValueOnce({ refdata: [] });

  await expect(store.getRefdataForDate('NSE', '2026-08-10')).resolves.toEqual([]);
  await expect(store.getRefdataForDate('NSE', '2026-08-10')).resolves.toEqual(INSTRUMENTS);
});

test("serves today's date from the shared day cache instead of downloading again", async () => {
  const getSharedRefdata = vi.fn(async () => INSTRUMENTS as Record<string, unknown>[]);
  const store = createBacktestRefdataStore({
    nubraGet,
    getSharedRefdata,
    sharedDay: () => '2026-08-13',
    cacheDir,
  });

  await expect(store.getRefdataForDate('NSE', '2026-08-13')).resolves.toEqual(INSTRUMENTS);

  expect(getSharedRefdata).toHaveBeenCalledWith('NSE');
  expect(nubraGet).not.toHaveBeenCalled();
  // Instruments can be listed intraday, so today's snapshot must never become a durable file.
  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
});

test('falls back to an empty array when the shared day cache rejects', async () => {
  const store = createBacktestRefdataStore({
    nubraGet,
    getSharedRefdata: vi.fn(async () => {
      throw new Error('upstream timeout');
    }),
    sharedDay: () => '2026-08-13',
  });

  await expect(store.getRefdataForDate('NSE', '2026-08-13')).resolves.toEqual([]);
});

test('persists a past date and reuses it from disk in a fresh process', async () => {
  const deps = { nubraGet, sharedDay: () => '2026-08-13', cacheDir };
  await createBacktestRefdataStore(deps).getRefdataForDate('NSE', '2026-08-10');

  // The write is deliberately not awaited by the request path, so wait for the file to land.
  await vi.waitFor(async () => {
    await expect(fs.readdir(cacheDir)).resolves.toEqual(['NSE_2026-08-10.json.gz']);
  });

  nubraGet.mockReset();
  const restarted = createBacktestRefdataStore(deps);
  await expect(restarted.getRefdataForDate('NSE', '2026-08-10')).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).not.toHaveBeenCalled();
});

test('discards an unreadable cache file and re-downloads', async () => {
  const deps = { nubraGet, sharedDay: () => '2026-08-13', cacheDir };
  const file = path.join(cacheDir, 'NSE_2026-08-10.json.gz');
  await fs.writeFile(file, Buffer.from('not gzip'));

  await expect(
    createBacktestRefdataStore(deps).getRefdataForDate('NSE', '2026-08-10'),
  ).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('keeps a malformed date out of the cache directory', async () => {
  const store = createBacktestRefdataStore({
    nubraGet,
    sharedDay: () => '2026-08-13',
    cacheDir,
  });

  await store.getRefdataForDate('NSE', '../../etc/passwd');

  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
});

test('bounds how many dates stay resident in memory', async () => {
  const store = createBacktestRefdataStore({ nubraGet, maxResident: 2 });

  await store.getRefdataForDate('NSE', '2026-08-10');
  await store.getRefdataForDate('NSE', '2026-08-11');
  await store.getRefdataForDate('NSE', '2026-08-12');
  expect(nubraGet).toHaveBeenCalledTimes(3);

  // The oldest was evicted; the two most recent are still served from memory.
  await store.getRefdataForDate('NSE', '2026-08-12');
  await store.getRefdataForDate('NSE', '2026-08-11');
  expect(nubraGet).toHaveBeenCalledTimes(3);

  await store.getRefdataForDate('NSE', '2026-08-10');
  expect(nubraGet).toHaveBeenCalledTimes(4);
});

test('prefetch lands the file on disk without occupying a memory slot', async () => {
  const store = createBacktestRefdataStore({
    nubraGet,
    sharedDay: () => '2026-08-13',
    cacheDir,
    maxResident: 1,
  });

  await store.prefetchForDate('NSE', '2026-08-12');
  await expect(fs.readdir(cacheDir)).resolves.toEqual(['NSE_2026-08-12.json.gz']);

  // The warmed date must not have evicted anything, so a later browse still gets its full LRU.
  await store.getRefdataForDate('NSE', '2026-08-11');
  expect(nubraGet).toHaveBeenCalledTimes(2);
  await store.getRefdataForDate('NSE', '2026-08-11');
  expect(nubraGet).toHaveBeenCalledTimes(2);

  // That browse fires its own unawaited write; let it land before the fixture is torn down.
  await vi.waitFor(async () => {
    expect(await fs.readdir(cacheDir)).toContain('NSE_2026-08-11.json.gz');
  });
});

test('prefetch removes the cold download from the request path', async () => {
  const deps = { nubraGet, sharedDay: () => '2026-08-13', cacheDir };
  const store = createBacktestRefdataStore(deps);

  await store.prefetchForDate('NSE', '2026-08-12');
  expect(nubraGet).toHaveBeenCalledTimes(1);

  // This is the whole point: the user's request is served from disk, not from a 40s download.
  nubraGet.mockReset();
  await expect(
    createBacktestRefdataStore(deps).getRefdataForDate('NSE', '2026-08-12'),
  ).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).not.toHaveBeenCalled();
});

test('prefetch is a cheap no-op once the file is already there', async () => {
  const deps = { nubraGet, sharedDay: () => '2026-08-13', cacheDir };
  await createBacktestRefdataStore(deps).prefetchForDate('NSE', '2026-08-12');

  nubraGet.mockReset();
  await createBacktestRefdataStore(deps).prefetchForDate('NSE', '2026-08-12');
  expect(nubraGet).not.toHaveBeenCalled();
});

test('prefetch never downloads today, which is the shared day cache’s job', async () => {
  const store = createBacktestRefdataStore({
    nubraGet,
    sharedDay: () => '2026-08-13',
    cacheDir,
  });

  await store.prefetchForDate('NSE', '2026-08-13');

  expect(nubraGet).not.toHaveBeenCalled();
  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
});

test('prefetch single-flights against a concurrent request rather than downloading twice', async () => {
  const held = gate();
  nubraGet.mockReturnValue(held.promise);
  const store = createBacktestRefdataStore({ nubraGet, sharedDay: () => '2026-08-13', cacheDir });

  const warm = store.prefetchForDate('NSE', '2026-08-12');
  const request = store.getRefdataForDate('NSE', '2026-08-12');
  held.release({ refdata: INSTRUMENTS });

  await expect(request).resolves.toEqual(INSTRUMENTS);
  await warm;
  expect(nubraGet).toHaveBeenCalledTimes(1);

  // The joining request still wants its result resident, even though the prefetch did not.
  await store.getRefdataForDate('NSE', '2026-08-12');
  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('prefetch swallows an upstream failure instead of crashing the warm loop', async () => {
  nubraGet.mockRejectedValueOnce(new Error('fetch failed'));
  const store = createBacktestRefdataStore({ nubraGet, sharedDay: () => '2026-08-13', cacheDir });

  await expect(store.prefetchForDate('NSE', '2026-08-12')).resolves.toBeUndefined();
  await expect(fs.readdir(cacheDir)).resolves.toEqual([]);
});

test('prunes the least recently used files past the cap', async () => {
  const deps = { nubraGet, sharedDay: () => '2026-08-13', cacheDir, maxFiles: 2 };
  const store = createBacktestRefdataStore(deps);

  for (const date of ['2026-08-05', '2026-08-06', '2026-08-07']) {
    await store.getRefdataForDate('NSE', date);
    await vi.waitFor(async () => {
      expect(await fs.readdir(cacheDir)).toContain(`NSE_${date}.json.gz`);
    });
  }

  await vi.waitFor(async () => {
    const names = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.json.gz'));
    expect(names).toHaveLength(2);
    expect(names).not.toContain('NSE_2026-08-05.json.gz');
  });
});
