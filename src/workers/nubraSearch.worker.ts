// Web Worker — runs instrument search off the main thread
// Receives: { type: 'search', q, exchange, typeFilter, limit }  OR  { type: 'load', items }

import type { Instrument, InstrumentType } from '../types';

let cachedItems: Instrument[] = [];

function getType(item: Instrument): InstrumentType {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type      || '').toUpperCase();
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (at === 'ETF') return 'ETF';
  return 'STOCK';
}

function typePriority(item: Instrument): number {
  const t = getType(item);
  if (t === 'STOCK' || t === 'INDEX') return 0;
  if (t === 'FUT') return 1;
  return 2;
}

function matchScore(item: Instrument, q: string): number {
  const name = (item.stock_name || item.asset || '').toLowerCase();
  const sym  = (item.nubra_name || item.zanskar_name || item.symbol || '').toLowerCase();
  if (name === q || sym === q) return 0;
  if (name.startsWith(q) || sym.startsWith(q)) return 1;
  return 2;
}

function search(q: string, typeFilter: string, limit: number): Instrument[] {
  if (!q || !cachedItems.length) return [];
  const qLow = q.toLowerCase();

  return cachedItems
    .filter((item) => {
      const name = (item.stock_name || item.asset || item.symbol || '').toLowerCase();
      const sym  = (item.nubra_name || item.zanskar_name || item.symbol || '').toLowerCase();
      const tm   = !typeFilter || getType(item).toUpperCase() === typeFilter.toUpperCase();
      return tm && (name.includes(qLow) || sym.includes(qLow));
    })
    .sort((a, b) => {
      const ms = matchScore(a, qLow) - matchScore(b, qLow);
      if (ms !== 0) return ms;
      return typePriority(a) - typePriority(b);
    })
    .slice(0, limit);
}

self.onmessage = (e: MessageEvent<{ type: string; q?: string; typeFilter?: string; limit?: number; items?: Instrument[] }>) => {
  const msg = e.data;

  if (msg.type === 'load') {
    cachedItems = msg.items || [];
    self.postMessage({ type: 'loaded', count: cachedItems.length });
    return;
  }

  if (msg.type === 'search') {
    const results = search(msg.q || '', msg.typeFilter || '', msg.limit || 15);
    self.postMessage({ type: 'results', results });
    return;
  }
};
