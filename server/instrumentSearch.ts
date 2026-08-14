/**
 * Ranked instrument search over the day's instrument master.
 *
 * `/api/instruments/search` used to scan the raw ~100k-record array on every keystroke, and the
 * cost was not the scan — it was that `matchScore` rebuilt an item's seven searchable names and
 * `expiryValue` ran a regex plus a `new Date()` *inside the sort comparator*. For a query like
 * "nifty", which matches tens of thousands of contracts, that is hundreds of thousands of regex and
 * Date constructions to produce twenty rows.
 *
 * Two changes fix it: derive each record's search fields exactly once into an index that lives as
 * long as the day's master does, and select the top `limit` in a single pass instead of sorting
 * every match.
 *
 * The ranking rules are deliberately unchanged, and are deliberately NOT shared with
 * src/lib/instrumentSearchIndex.ts: the tsconfigs for src/ and server/ are disjoint (the same
 * reason server/tradingDay.ts is duplicated), and the two differ on purpose — the client also
 * indexes its rendered contract label, which has no server-side equivalent.
 */

/** See the SEP docblock in src/lib/instrumentSearchIndex.ts — NUL, so a query can never span names. */
const SEP = String.fromCharCode(0);

export interface SearchEntry {
  item: Record<string, unknown>;
  /** Every searchable name, lowercased, separated and bracketed by SEP. */
  haystack: string;
  /** `derivative_type || asset_type`, uppercased. Empty when the record carries neither. */
  type: string;
  typePriority: number;
  expiry: number;
}

function expiryValue(item: Record<string, unknown>): number {
  const symbolExpiry = /(?:^|_)(\d{8})(?:_|$)/.exec(
    String(item.zanskar_name || item.nubra_name || item.symbol || item.stock_name || ''),
  )?.[1];
  const raw = String(item.expiry ?? symbolExpiry ?? '');
  if (/^\d{8}$/.test(raw)) return Number(raw);
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

export function buildSearchEntries(items: Record<string, unknown>[]): SearchEntry[] {
  return items.map((item) => {
    const type = String(item.derivative_type || item.asset_type || '').toUpperCase();
    const terms = [
      item.asset,
      item.stock_name,
      item.display_name,
      item.zanskar_name,
      item.nubra_name,
      item.symbol,
      item.trading_symbol,
    ].filter(Boolean);
    return {
      item,
      type,
      // An empty type ranks with cash instruments, which is what the original `dt === ''` did.
      typePriority:
        type === 'STOCK' || type === 'INDEX' || type === '' ? 0 : type === 'FUT' ? 1 : 2,
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

function isBetter(
  score: number,
  entry: SearchEntry,
  thanScore: number,
  than: SearchEntry,
): boolean {
  if (score !== thanScore) return score < thanScore;
  if (entry.typePriority !== than.typePriority) return entry.typePriority < than.typePriority;
  return entry.expiry < than.expiry;
}

/**
 * Top `limit` matches, best first.
 *
 * An empty query matches everything and scores every record 1, exactly as the original
 * `terms.some((t) => t.startsWith(''))` did — callers rely on that to list instruments unfiltered.
 */
export function searchEntries(
  index: SearchEntry[],
  query: string,
  typeFilter = '',
  limit = 20,
): Record<string, unknown>[] {
  if (!index.length || limit <= 0) return [];
  const q = query.toLowerCase();
  const requestedType = typeFilter.toUpperCase();

  const best: SearchEntry[] = [];
  const bestScores: number[] = [];

  for (const entry of index) {
    if (requestedType && entry.type !== requestedType) continue;
    if (q && !entry.haystack.includes(q)) continue;

    const score = matchScore(entry.haystack, q);
    if (best.length === limit && !isBetter(score, entry, bestScores[limit - 1], best[limit - 1])) {
      continue;
    }

    // Walk back only past entries this one genuinely beats, leaving ties in encounter order — the
    // same result the previous stable sort produced.
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

/**
 * Index for one day's master, built at most once per array.
 *
 * Keyed on the array itself rather than on the exchange name, because the refdata cache hands back
 * the same array all day and swaps in a new one at rollover — so identity already encodes "is this
 * still the master I indexed?", with no rollover rule to keep in sync. A WeakMap also means the
 * index is collected with the master it describes, rather than pinning yesterday's ~100k records.
 */
const indexCache = new WeakMap<Record<string, unknown>[], SearchEntry[]>();

export function searchIndexFor(items: Record<string, unknown>[]): SearchEntry[] {
  const hit = indexCache.get(items);
  if (hit) return hit;
  const built = buildSearchEntries(items);
  indexCache.set(items, built);
  return built;
}

/**
 * `ref_id` → record, for the same master and on the same terms as `searchIndexFor`.
 *
 * `/api/instruments/lookup` scanned all ~100k records with `Array.find`, and the option chain calls
 * it every time a strike is clicked. Numbers are coerced on the way in because the master is not
 * consistent about whether `ref_id` arrives as a number or a string.
 */
const refIdCache = new WeakMap<Record<string, unknown>[], Map<number, Record<string, unknown>>>();

export function refIdIndexFor(
  items: Record<string, unknown>[],
): Map<number, Record<string, unknown>> {
  const hit = refIdCache.get(items);
  if (hit) return hit;
  const built = new Map<number, Record<string, unknown>>();
  for (const item of items) {
    if (item.ref_id == null) continue;
    const id = Number(item.ref_id);
    // First writer wins, matching `Array.find`, which returned the earliest match.
    if (Number.isFinite(id) && !built.has(id)) built.set(id, item);
  }
  refIdCache.set(items, built);
  return built;
}
