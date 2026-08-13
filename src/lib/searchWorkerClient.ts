/**
 * One shared instrument-search worker, refcounted across the components that use it.
 *
 * Two InstrumentSearch instances mount at once (the Navbar's and the OrderTicket's) and each used
 * to construct its own worker, so the multi-megabyte instrument master was downloaded, parsed and
 * indexed twice over — two copies of a ~100k-entry index resident for the life of the page.
 * Sharing one worker halves both, and callers see no difference: search requests carry their query
 * string and every listener already discards results that do not match its own current query.
 *
 * Index construction is NOT started on acquire. It pulls three multi-megabyte payloads, so the
 * caller decides when — see ensureIndex.
 */

import type { Instrument } from '../types';
import NubraWorker from '../workers/nubraSearch.worker?worker';

export type SearchWorkerMessage =
  | { type: 'loaded'; count: number }
  | { type: 'load_failed' }
  | { type: 'results'; q: string; results: Instrument[] };

type Listener = (msg: SearchWorkerMessage) => void;

let worker: Worker | null = null;
let refCount = 0;
let initRequested = false;
/** Non-null once the index is built, so a late subscriber can be told immediately. */
let loadedCount: number | null = null;
const listeners = new Set<Listener>();

function ensureWorker(): Worker {
  if (worker) return worker;
  const created = new NubraWorker();
  created.onmessage = (e: MessageEvent<SearchWorkerMessage>) => {
    if (e.data.type === 'loaded') loadedCount = e.data.count;
    // Release the latch so the next ensureIndex() re-attempts the load rather than assuming a
    // build is still pending. The worker has already cleared its own.
    if (e.data.type === 'load_failed') initRequested = false;
    // Copy first: a listener may release() during dispatch.
    for (const listener of [...listeners]) listener(e.data);
  };
  worker = created;
  return created;
}

export interface SearchWorkerHandle {
  /** Idempotent, process-wide. Safe to call on every focus. */
  ensureIndex(): void;
  search(q: string, limit: number): void;
  release(): void;
}

export function acquireSearchWorker(onMessage: Listener): SearchWorkerHandle {
  refCount++;
  listeners.add(onMessage);
  // A component mounting after the index was already built would otherwise never hear 'loaded'
  // and would sit on the server-search fallback forever.
  if (loadedCount !== null) onMessage({ type: 'loaded', count: loadedCount });

  let released = false;

  return {
    ensureIndex() {
      if (initRequested) return;
      initRequested = true;
      ensureWorker().postMessage({ type: 'init' });
    },

    search(q: string, limit: number) {
      ensureWorker().postMessage({ type: 'search', q, limit });
    },

    release() {
      // Guard against a double release; React can invoke a cleanup more than once in StrictMode.
      if (released) return;
      released = true;
      listeners.delete(onMessage);
      refCount--;
      if (refCount > 0) return;

      worker?.terminate();
      worker = null;
      initRequested = false;
      loadedCount = null;
    },
  };
}

/** Test/diagnostic use only. */
export function searchWorkerRefCount(): number {
  return refCount;
}
