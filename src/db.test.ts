import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fetchRefdata } from './db';
import { invalidateShared } from './lib/sharedRequest';

// indexedDB is undefined under Node, so openDB() rejects and both cache helpers fall through
// their existing catch blocks. That leaves the network path directly testable.

beforeEach(() => {
  invalidateShared();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateShared();
});

test('surfaces a server error instead of laundering it into an empty list', async () => {
  // The old behaviour resolved [], which then got written to IndexedDB and read back as a valid
  // cache hit — silently emptying search for the rest of the day.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'fetch failed' }), { status: 500 })),
  );

  await expect(fetchRefdata('MCX')).rejects.toThrow('fetch failed');
});

test('falls back to a generic message when the error body is unusable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })),
  );

  await expect(fetchRefdata('NSE')).rejects.toThrow('HTTP 502');
});

test('returns the instrument list on success', async () => {
  const refdata = [{ ref_id: 1, stock_name: 'NIFTY' }];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ refdata }), { status: 200 })),
  );

  await expect(fetchRefdata('NSE')).resolves.toEqual(refdata);
});

test('coalesces concurrent callers into one request per exchange', async () => {
  // Navbar and OrderTicket each mount an InstrumentSearch, and each asks for all three exchanges.
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ refdata: [{ ref_id: 1 }] }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await Promise.all([fetchRefdata('NSE'), fetchRefdata('NSE')]);

  expect(fetchMock).toHaveBeenCalledTimes(1);
});
