import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRefdataCache } from './refdataCache.ts';

/** A promise we can settle from the outside, so we can observe mid-flight behaviour. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const INSTRUMENTS = [{ ref_id: 1, stock_name: 'NIFTY' }];

let cacheDir: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // A background refresh can still be writing when afterEach removes the directory underneath it.
  // That is the fire-and-forget write behaving exactly as designed; it just should not print.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'refdata-live-'));
});

afterEach(async () => {
  // The disk write is deliberately not awaited by the request path, so on Windows a `.tmp` file can
  // still be open here and rmdir fails with ENOTEMPTY. Retry rather than fail an unrelated test.
  await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

/** Waits for the un-awaited disk write the request path fires and forgets. */
async function settleWrites(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const names = await fs.readdir(cacheDir).catch(() => [] as string[]);
    if (names.some((n) => n.endsWith('.json.gz'))) return;
  }
}

test('collapses concurrent misses into a single download', async () => {
  // Two InstrumentSearch mounts × three exchanges used to mean six copies of a multi-megabyte
  // download in flight at once.
  const gate = deferred<Record<string, unknown>>();
  const nubraGet = vi.fn(() => gate.promise);
  const { getRefdata } = createRefdataCache({ nubraGet });

  const first = getRefdata('NSE');
  const second = getRefdata('NSE');

  // Sharing the promise is the property that matters, and it still holds synchronously. The
  // download itself now sits behind a look at the day's disk copy, so it starts a turn later.
  expect(first).toBe(second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(nubraGet).toHaveBeenCalledTimes(1);

  gate.resolve({ refdata: INSTRUMENTS });
  await expect(Promise.all([first, second])).resolves.toEqual([INSTRUMENTS, INSTRUMENTS]);
});

test('serves a completed download from cache', async () => {
  const nubraGet = vi.fn(async () => ({ refdata: INSTRUMENTS }));
  const { getRefdata } = createRefdataCache({ nubraGet });

  await getRefdata('NSE');
  await getRefdata('NSE');

  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('evicts a rejection instead of memoizing it', async () => {
  // dataLayer.ts and ivHistory.ts get this wrong: a single transient failure there poisons the
  // cache for the life of the process.
  const nubraGet = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('fetch failed'))
    .mockResolvedValueOnce({ refdata: INSTRUMENTS });
  const { getRefdata } = createRefdataCache({ nubraGet });

  await expect(getRefdata('NSE')).rejects.toThrow('fetch failed');
  await expect(getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).toHaveBeenCalledTimes(2);
});

test('evicts an empty result instead of serving it all day', async () => {
  const nubraGet = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce({ refdata: [] })
    .mockResolvedValueOnce({ refdata: INSTRUMENTS });
  const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet });

  await expect(getRefdata('NSE')).resolves.toEqual([]);
  expect(peekRefdata('NSE')).toBeNull();
  await expect(getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);
});

test('treats an unrecognised payload shape as empty and does not cache it', async () => {
  const nubraGet = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValue({ unexpected: 'shape' });
  const { getRefdata } = createRefdataCache({ nubraGet });

  await expect(getRefdata('NSE')).resolves.toEqual([]);
  await getRefdata('NSE');
  expect(nubraGet).toHaveBeenCalledTimes(2);
});

test('accepts the alternative payload shapes the API returns', async () => {
  const viaData = createRefdataCache({ nubraGet: async () => ({ data: INSTRUMENTS }) });
  await expect(viaData.getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);

  const bare = createRefdataCache({
    nubraGet: async () => INSTRUMENTS as unknown as Record<string, unknown>,
  });
  await expect(bare.getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);
});

test('peek is null before the download lands and populated after', async () => {
  const gate = deferred<Record<string, unknown>>();
  const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet: () => gate.promise });

  const pending = getRefdata('MCX');
  expect(peekRefdata('MCX')).toBeNull();

  gate.resolve({ refdata: INSTRUMENTS });
  await pending;
  expect(peekRefdata('MCX')).toEqual(INSTRUMENTS);
});

test('keeps exchanges independent', async () => {
  const nubraGet = vi.fn(async (_endpoint: string, params?: Record<string, string>) => ({
    refdata: [{ exchange: params?.exchange }],
  }));
  const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet });

  await getRefdata('NSE');
  expect(peekRefdata('MCX')).toBeNull();
  await getRefdata('MCX');
  expect(peekRefdata('MCX')).toEqual([{ exchange: 'MCX' }]);
});

test('re-downloads once the calendar date rolls over', async () => {
  let clock = Date.parse('2026-08-12T10:00:00Z');
  const nubraGet = vi.fn(async () => ({ refdata: INSTRUMENTS }));
  const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet, now: () => clock });

  await getRefdata('NSE');
  expect(nubraGet).toHaveBeenLastCalledWith('/refdata/refdata/2026-08-12', { exchange: 'NSE' });

  clock = Date.parse('2026-08-13T10:00:00Z');
  expect(peekRefdata('NSE')).toBeNull();
  await getRefdata('NSE');

  expect(nubraGet).toHaveBeenCalledTimes(2);
  expect(nubraGet).toHaveBeenLastCalledWith('/refdata/refdata/2026-08-13', { exchange: 'NSE' });
});

test('a restart serves the day from disk instead of downloading again', async () => {
  // The point of the whole disk layer: three cold masters at 40-45s each used to be the price of
  // every server restart, which during development is every code change.
  const clock = Date.parse('2026-08-12T10:00:00Z');
  const first = vi.fn(async () => ({ refdata: INSTRUMENTS }));
  await createRefdataCache({ nubraGet: first, now: () => clock, cacheDir }).getRefdata('NSE');
  await settleWrites();

  // Never resolves, so if the restart waited on the network at all this test would hang rather than
  // quietly pass on a value that happened to match.
  const stalled = deferred<Record<string, unknown>>();
  const restarted = createRefdataCache({
    nubraGet: () => stalled.promise,
    now: () => clock,
    cacheDir,
  });
  await expect(restarted.getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);
  expect(first).toHaveBeenCalledTimes(1);
});

test('replaces the disk copy with a fresh download behind the caller', async () => {
  // Instruments are only ever added intraday, so serving a few-hour-old copy cannot produce a wrong
  // record — but a listing created since it was written should still turn up without a restart.
  const clock = Date.parse('2026-08-12T10:00:00Z');
  await createRefdataCache({
    nubraGet: async () => ({ refdata: INSTRUMENTS }),
    now: () => clock,
    cacheDir,
  }).getRefdata('NSE');
  await settleWrites();

  const fresh = [
    { ref_id: 1, stock_name: 'NIFTY' },
    { ref_id: 9, stock_name: 'NEWLY_LISTED' },
  ];
  const { getRefdata, peekRefdata } = createRefdataCache({
    nubraGet: async () => ({ refdata: fresh }),
    now: () => clock,
    cacheDir,
  });

  expect(await getRefdata('NSE')).toEqual(INSTRUMENTS);
  await vi.waitFor(() => expect(peekRefdata('NSE')).toEqual(fresh));
});

test('ignores a disk copy belonging to another day', async () => {
  let clock = Date.parse('2026-08-12T10:00:00Z');
  const nubraGet = vi.fn(async () => ({ refdata: INSTRUMENTS }));
  await createRefdataCache({ nubraGet, now: () => clock, cacheDir }).getRefdata('NSE');
  await settleWrites();

  clock = Date.parse('2026-08-13T10:00:00Z');
  await createRefdataCache({ nubraGet, now: () => clock, cacheDir }).getRefdata('NSE');

  expect(nubraGet).toHaveBeenLastCalledWith('/refdata/refdata/2026-08-13', { exchange: 'NSE' });
});

test('discards an unreadable disk copy rather than failing on it forever', async () => {
  const clock = Date.parse('2026-08-12T10:00:00Z');
  const file = path.join(cacheDir, 'NSE_2026-08-12.json.gz');
  await fs.writeFile(file, Buffer.from('not gzip'));

  const nubraGet = vi.fn(async () => ({ refdata: INSTRUMENTS }));
  const { getRefdata } = createRefdataCache({ nubraGet, now: () => clock, cacheDir });

  await expect(getRefdata('NSE')).resolves.toEqual(INSTRUMENTS);
  expect(nubraGet).toHaveBeenCalledTimes(1);
});

test('a late rejection does not evict the healthy entry that replaced it', async () => {
  const first = deferred<Record<string, unknown>>();
  const nubraGet = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ refdata: INSTRUMENTS });
  const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet });

  const failing = getRefdata('NSE');
  first.reject(new Error('fetch failed'));
  await expect(failing).rejects.toThrow('fetch failed');

  await getRefdata('NSE');
  expect(peekRefdata('NSE')).toEqual(INSTRUMENTS);

  // Let any straggling eviction callback from the first attempt run.
  await Promise.resolve();
  expect(peekRefdata('NSE')).toEqual(INSTRUMENTS);
});
