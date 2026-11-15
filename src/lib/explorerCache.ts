/**
 * Trade Explorer response cache. A day's chart, chain and strike-set comparison never change
 * until the data is updated, so each is fetched once and reused: revisiting a day, stepping back
 * with ↑, or switching index is instant. Neighbouring days are fetched ahead while idle.
 * `clearExplorerCache()` runs after "Update data".
 */
import type { SignalBacktestRow } from './signalBacktest';

interface Entry {
  promise: Promise<unknown>;
  value?: unknown;
}

const MAX_ENTRIES = 240;
/** Whole trade-set lists are 8 MB each, so only a few are kept. */
const MAX_SETS = 3;
const entries = new Map<string, Entry>();

const isSetList = (url: string) =>
  url.startsWith('/api/signal-backtest/explorer-sets?') && !url.includes('&date=');

/** Oldest first; whole lists and per-day answers are capped separately. */
function remember(url: string, entry: Entry) {
  entries.set(url, entry);
  const list = isSetList(url);
  const same = [...entries.keys()].filter((k) => isSetList(k) === list);
  const max = list ? MAX_SETS : MAX_ENTRIES;
  for (const k of same.slice(0, Math.max(0, same.length - max))) entries.delete(k);
}

/**
 * JSON from `url`, shared by every caller. A failed or not-ok answer is not kept, so a retry
 * asks the server again. Callers that unmount just ignore the answer; the request still lands
 * in the cache for next time.
 */
export function cachedJson<T>(url: string): Promise<T> {
  const hit = entries.get(url);
  if (hit) {
    // Keep recently used entries at the back of the eviction order.
    entries.delete(url);
    entries.set(url, hit);
    return hit.promise as Promise<T>;
  }
  const entry: Entry = {
    promise: fetch(url).then(async (res) => {
      const body = await res.json();
      if (!res.ok || body?.ok === false) entries.delete(url);
      else entry.value = body;
      return body;
    }),
  };
  entry.promise.catch(() => entries.delete(url));
  remember(url, entry);
  return entry.promise as Promise<T>;
}

/** The cached answer if it has already arrived (lets a view draw in the same frame). */
export function cachedValue<T>(url: string): T | undefined {
  return entries.get(url)?.value as T | undefined;
}

export function clearExplorerCache() {
  entries.clear();
}

export const chainUrl = (
  underlying: string,
  row: Pick<SignalBacktestRow, 'date' | 'source'> & { signal: { t2: string } },
) =>
  `/api/signal-backtest/chain?${new URLSearchParams({
    underlying,
    date: row.date,
    source: row.source,
    time: row.signal.t2,
  })}`;

export const dayUrl = (underlying: string, row: SignalBacktestRow) => {
  const qs = new URLSearchParams({
    underlying,
    date: row.date,
    source: row.source,
    ceStrike: String(row.signal.legs.ceStrike),
    peStrike: String(row.signal.legs.peStrike),
    legs: row.trade.legs.map((l) => `${l.kind}:${l.strike}`).join(','),
  });
  if (row.ohlcSource) qs.set('ohlc', row.ohlcSource);
  return `/api/signal-backtest/day?${qs}`;
};

export const comparisonUrl = (underlying: string, date: string) =>
  `/api/signal-backtest/explorer-sets?underlying=${underlying}&set=saved&date=${date}`;

/** Fetch a day's detail ahead of time, one request at a time, when the browser is idle. */
const queue: string[] = [];
let running = false;
export function prefetchDay(
  underlying: string,
  row: SignalBacktestRow & { comparisons?: unknown },
  /** A row under the mouse: fetch now rather than when idle. */
  now = false,
) {
  const urls = [chainUrl(underlying, row), dayUrl(underlying, row)];
  if (!row.comparisons) urls.push(comparisonUrl(underlying, row.date));
  if (now) {
    for (const u of urls) void cachedJson(u).catch(() => undefined);
    return;
  }
  for (const u of urls) if (!entries.has(u) && !queue.includes(u)) queue.push(u);
  // Only the latest neighbours matter; drop stale ones when the user moves fast.
  queue.splice(0, Math.max(0, queue.length - 9));
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    await new Promise<void>((resolve) =>
      'requestIdleCallback' in window
        ? window.requestIdleCallback(() => resolve(), { timeout: 400 })
        : setTimeout(resolve, 50),
    );
    const url = queue.shift()!;
    if (!entries.has(url)) await cachedJson(url).catch(() => undefined);
  }
  running = false;
}
