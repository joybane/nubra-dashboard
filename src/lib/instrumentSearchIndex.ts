import type { Instrument, InstrumentType } from '../types';
import { getInstrumentType } from '../types';
import { formatInstrumentName } from './instrumentDisplay';

/**
 * Separator wrapped around every searchable name, so a single string can answer all three questions
 * the ranking asks — contains, starts-with and exact — with a plain `indexOf`.
 *
 * The alternative, an array of terms plus `.some()` per question, ran up to three closure calls per
 * term per entry across ~100k entries on every keystroke.
 *
 * It is NUL, built through `fromCharCode` rather than written as an escape so no tooling has to
 * round-trip an invisible byte in this file. A query can never contain NUL, so joining on it cannot
 * produce a match spanning two names — which a space separator would, and instrument labels are
 * full of spaces.
 */
const SEP = String.fromCharCode(0);

export interface InstrumentSearchEntry {
  item: Instrument;
  /** Every searchable name, lowercased, separated and bracketed by SEP. */
  haystack: string;
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
    const terms = [
      item.asset,
      item.stock_name,
      item.display_name,
      item.nubra_name,
      item.zanskar_name,
      item.symbol,
      item.trading_symbol,
      formatInstrumentName(item),
    ].filter(Boolean);
    return {
      item,
      type,
      typePriority: type === 'STOCK' || type === 'INDEX' ? 0 : type === 'FUT' ? 1 : 2,
      expiry: expiryValue(item),
      haystack: SEP + terms.map((value) => String(value).toLowerCase()).join(SEP) + SEP,
    };
  });
}

/** 0 = a name is exactly the query, 1 = a name starts with it, 2 = merely contains it. */
function matchScore(haystack: string, query: string): number {
  if (haystack.includes(SEP + query + SEP)) return 0;
  if (haystack.includes(SEP + query)) return 1;
  return 2;
}

/** Ranking order: how well the name matched, then instrument kind, then nearest expiry. */
function isBetter(
  score: number,
  entry: InstrumentSearchEntry,
  thanScore: number,
  than: InstrumentSearchEntry,
): boolean {
  if (score !== thanScore) return score < thanScore;
  if (entry.typePriority !== than.typePriority) return entry.typePriority < than.typePriority;
  return entry.expiry < than.expiry;
}

export function searchInstrumentIndex(
  index: InstrumentSearchEntry[],
  query: string,
  typeFilter = '',
  limit = 15,
): Instrument[] {
  const q = query.trim().toLowerCase();
  if (!q || !index.length || limit <= 0) return [];
  const requestedType = typeFilter.toUpperCase();

  // Selection rather than filter-then-sort. A query like "nifty" matches tens of thousands of
  // contracts, and the previous version sorted every one of them while recomputing the score inside
  // the comparator — so the expensive part ran O(n log n) times to produce 15 rows. Keeping only the
  // best `limit` costs one pass plus a bounded insert, and scores each entry exactly once.
  const best: InstrumentSearchEntry[] = [];
  const bestScores: number[] = [];

  for (const entry of index) {
    if (requestedType && entry.type !== requestedType) continue;
    if (!entry.haystack.includes(q)) continue;

    const score = matchScore(entry.haystack, q);
    if (best.length === limit && !isBetter(score, entry, bestScores[limit - 1], best[limit - 1])) {
      continue;
    }

    // Walk back only past entries this one genuinely beats, which leaves ties in encounter order —
    // the same result the previous stable sort produced.
    let i = Math.min(best.length, limit - 1);
    while (i > 0 && isBetter(score, entry, bestScores[i - 1], best[i - 1])) i--;
    best.splice(i, 0, entry);
    bestScores.splice(i, 0, score);
    if (best.length > limit) {
      best.length = limit;
      bestScores.length = limit;
    }
  }

  return best.map((entry) => entry.item);
}
