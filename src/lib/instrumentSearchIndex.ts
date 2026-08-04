import type { Instrument, InstrumentType } from '../types';
import { getInstrumentType } from '../types';
import { formatInstrumentName } from './instrumentDisplay';

export interface InstrumentSearchEntry {
  item: Instrument;
  terms: string[];
  type: InstrumentType;
  typePriority: number;
  expiry: number;
}

function expiryValue(item: Instrument): number {
  const symbolExpiry = /(?:^|_)(\d{8})(?:_|$)/.exec(
    String(item.zanskar_name || item.nubra_name || item.symbol || item.stock_name || ''),
  )?.[1];
  const raw = String(item.expiry ?? symbolExpiry ?? '');
  if (/^\d{8}$/.test(raw)) return Number(raw);
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

export function buildInstrumentSearchIndex(items: Instrument[]): InstrumentSearchEntry[] {
  return items.map((item) => {
    const type = getInstrumentType(item);
    return {
      item,
      type,
      typePriority: type === 'STOCK' || type === 'INDEX' ? 0 : type === 'FUT' ? 1 : 2,
      expiry: expiryValue(item),
      terms: [
        item.asset,
        item.stock_name,
        item.display_name,
        item.nubra_name,
        item.zanskar_name,
        item.symbol,
        item.trading_symbol,
        formatInstrumentName(item),
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase()),
    };
  });
}

function matchScore(entry: InstrumentSearchEntry, query: string): number {
  if (entry.terms.some((term) => term === query)) return 0;
  if (entry.terms.some((term) => term.startsWith(query))) return 1;
  return 2;
}

export function searchInstrumentIndex(
  index: InstrumentSearchEntry[],
  query: string,
  typeFilter = '',
  limit = 15,
): Instrument[] {
  const q = query.trim().toLowerCase();
  if (!q || !index.length) return [];
  const requestedType = typeFilter.toUpperCase();

  return index
    .filter(
      (entry) =>
        (!requestedType || entry.type === requestedType) &&
        entry.terms.some((term) => term.includes(q)),
    )
    .sort((a, b) => {
      const score = matchScore(a, q) - matchScore(b, q);
      if (score !== 0) return score;
      const type = a.typePriority - b.typePriority;
      if (type !== 0) return type;
      return a.expiry - b.expiry;
    })
    .slice(0, limit)
    .map((entry) => entry.item);
}
