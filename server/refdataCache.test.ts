import { beforeEach, expect, test, vi } from 'vitest';
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

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

test('collapses concurrent misses into a single download', () => {
  // Two InstrumentSearch mounts × three exchanges used to mean six copies of a multi-megabyte
  // download in flight at once.
  const gate = deferred<Record<string, unknown>>();
  const nubraGet = vi.fn(() => gate.promise);
  const { getRefdata } = createRefdataCache({ nubraGet });

  const first = getRefdata('NSE');
  const second = getRefdata('NSE');

  expect(nubraGet).toHaveBeenCalledTimes(1);
  expect(first).toBe(second);

  gate.resolve({ refdata: INSTRUMENTS });
  return expect(Promise.all([first, second])).resolves.toEqual([INSTRUMENTS, INSTRUMENTS]);
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
