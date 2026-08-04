// Web Worker — runs instrument search off the main thread
// Receives: { type: 'search', q, exchange, typeFilter, limit }  OR  { type: 'load', items }

import type { Instrument } from '../types';
import {
  buildInstrumentSearchIndex,
  searchInstrumentIndex,
  type InstrumentSearchEntry,
} from '../lib/instrumentSearchIndex';

let searchIndex: InstrumentSearchEntry[] = [];

self.onmessage = (
  e: MessageEvent<{
    type: string;
    q?: string;
    typeFilter?: string;
    limit?: number;
    items?: Instrument[];
  }>,
) => {
  const msg = e.data;

  if (msg.type === 'load') {
    searchIndex = buildInstrumentSearchIndex(msg.items || []);
    self.postMessage({ type: 'loaded', count: searchIndex.length });
    return;
  }

  if (msg.type === 'search') {
    const q = msg.q || '';
    const results = searchInstrumentIndex(searchIndex, q, msg.typeFilter || '', msg.limit || 15);
    self.postMessage({ type: 'results', q, results });
    return;
  }
};
