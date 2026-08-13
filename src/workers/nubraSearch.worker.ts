// Web Worker — runs instrument search off the main thread
// Receives: { type: 'init' }  OR  { type: 'search', q, typeFilter?, limit? }
// Sends:    { type: 'loaded', count }  OR  { type: 'results', q, results }

import type { Instrument } from '../types';
import { fetchRefdata } from '../db';
import {
  buildInstrumentSearchIndex,
  searchInstrumentIndex,
  type InstrumentSearchEntry,
} from '../lib/instrumentSearchIndex';

/**
 * The worker fetches the instrument master itself. It used to be handed the finished array.
 *
 * Each exchange is a multi-megabyte, ~100k-record payload, and under the old arrangement every
 * step ran on the main thread: the caller fetched all three, JSON-parsed them, de-duplicated the
 * combined array, then structured-cloned the whole thing across the worker boundary via
 * postMessage. Nothing could paint during any of that — which is how an option chain that had
 * already arrived could still be sitting behind a "Loading…" placeholder.
 *
 * Fetching here means the main thread never touches the payload; only the small 'loaded'
 * acknowledgement crosses back.
 */
const EXCHANGES = ['NSE', 'BSE', 'MCX'] as const;

let searchIndex: InstrumentSearchEntry[] = [];
/** Non-null once a load is in flight or has succeeded, so repeated 'init' messages are cheap. */
let loading: Promise<void> | null = null;

/**
 * Concatenation order decides which copy of a duplicate instrument survives, so NSE→BSE→MCX has
 * to match what the caller used to do — changing it would reorder search results.
 */
function dedupe(sets: Instrument[][]): Instrument[] {
  const seen = new Set<string>();
  return sets.flat().filter((item) => {
    const key = `${item.exchange || ''}:${item.ref_id || item.stock_name || item.nubra_name || item.zanskar_name || item.symbol || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Deliberately no per-exchange catch. If one exchange fails, the whole load fails and no 'loaded'
 * is posted, which leaves the caller on its server-side search fallback. Salvaging the exchanges
 * that did load would look healthier while silently returning nothing for the one that did not.
 */
async function loadIndex(): Promise<void> {
  const sets = (await Promise.all(
    EXCHANGES.map((exchange) => fetchRefdata(exchange)),
  )) as Instrument[][];
  searchIndex = buildInstrumentSearchIndex(dedupe(sets));
}

self.onmessage = (
  e: MessageEvent<{
    type: string;
    q?: string;
    typeFilter?: string;
    limit?: number;
  }>,
) => {
  const msg = e.data;

  if (msg.type === 'init') {
    if (loading) return;
    loading = loadIndex().then(
      () => {
        self.postMessage({ type: 'loaded', count: searchIndex.length });
      },
      (err: unknown) => {
        // Clear the latch and say so, which lets a later init (the user reaching for the search
        // box again) retry instead of leaving search on its server-side fallback for the rest of
        // the session because of one transient failure.
        loading = null;
        console.error('[search worker] refdata load failed', err);
        self.postMessage({ type: 'load_failed' });
      },
    );
    return;
  }

  if (msg.type === 'search') {
    const q = msg.q || '';
    const results = searchInstrumentIndex(searchIndex, q, msg.typeFilter || '', msg.limit || 15);
    self.postMessage({ type: 'results', q, results });
    return;
  }
};
