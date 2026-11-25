import type { OpeningDates, OpeningResearchRow } from '../../src/lib/openingStrangle.ts';
import type { SignalUnderlying } from '../../src/lib/signalBacktest.ts';
import { daysToExpiry } from '../signalBacktest/expiry.ts';
import { isEmptyDay, SESSION_BARS, type DayStore } from './daySeries.ts';
import { readOpeningResearchEntry, type OpeningReplay } from './openingStrangle.ts';

const RECENT_SIZE = 20;
const CLOSE = SESSION_BARS - 1;

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** Compare with earlier valid observations, then add the current one for later sessions. */
function recentRatio(history: number[], value: number | null): number | null {
  const current = positive(value);
  if (current == null) return null;
  let ratio: number | null = null;
  if (history.length === RECENT_SIZE) {
    const sorted = [...history].sort((a, b) => a - b);
    const middle = RECENT_SIZE / 2;
    const median = (sorted[middle - 1] + sorted[middle]) / 2;
    ratio = (100 * current) / median;
    history.shift();
  }
  history.push(current);
  return ratio;
}

/** Warm the entry measurements on the full source calendar and default opening rule. */
export async function buildOpeningResearch(
  store: Pick<DayStore, 'read'>,
  underlying: SignalUnderlying,
  dates: OpeningDates['dates'],
  replays: OpeningReplay[],
  cancelled: () => boolean,
): Promise<OpeningResearchRow[]> {
  const last = replays[replays.length - 1]?.summary.date;
  if (!last) return [];
  const selected = new Map(replays.map((row) => [row.summary.date, row]));
  const calendar = dates.map(({ date }) => date);
  const throughLast = dates.filter(({ date }) => date <= last);
  const recent = new Map<number, { credit: number[]; iv: number[] }>();
  const rows: OpeningResearchRow[] = [];
  let previousSpotClose: number | null = null;
  for (let i = 0; i < throughLast.length; i += 16) {
    if (cancelled()) return rows;
    const batch = await Promise.all(
      throughLast.slice(i, i + 16).map(async ({ date, source }) => ({
        date,
        stored: await store.read(underlying, source, date),
      })),
    );
    for (const { date, stored } of batch) {
      const previous = previousSpotClose;
      // A missing exact close clears the reference. Never bridge an unavailable stored session.
      const day = stored && !isEmptyDay(stored) ? stored : null;
      previousSpotClose = positive(day?.spot[CLOSE]);
      if (!day) continue;

      const replay = selected.get(date);
      const dte = daysToExpiry(date, day.expiry, calendar);
      if (dte == null) continue;
      const entry = replay
        ? { ...replay.summary, ivSkew: replay.entryIvSkew }
        : readOpeningResearchEntry(day, underlying);
      if (!entry) continue;
      const history = recent.get(dte) ?? { credit: [], iv: [] };
      if (!recent.has(dte)) recent.set(dte, history);
      const creditVsRecent = recentRatio(history.credit, entry.entryCredit);
      const ivVsRecent = recentRatio(history.iv, entry.entryIv);
      if (!replay) continue;

      const spot = positive(entry.entrySpot);
      const premium = positive(entry.ceEntry + entry.peEntry);
      rows.push({
        date,
        pnl: replay.pnl,
        features: {
          entryCredit: positive(entry.entryCredit),
          premiumImbalance:
            premium == null ? null : (100 * (entry.ceEntry - entry.peEntry)) / premium,
          entryIv: entry.entryIv,
          ivSkew: entry.ivSkew,
          callDistancePct: spot == null ? null : (100 * (entry.ceStrike - spot)) / spot,
          putDistancePct: spot == null ? null : (100 * (spot - entry.peStrike)) / spot,
          overnightGapPct:
            spot == null || previous == null ? null : (100 * (spot - previous)) / previous,
          dte,
          monthly: day.monthly ? 1 : 0,
          creditVsRecent,
          ivVsRecent,
        },
      });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return rows;
}
