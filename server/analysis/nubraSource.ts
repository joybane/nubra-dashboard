/**
 * Builds an analysis day from Nubra's `charts/timeseries`.
 *
 * Measured 2026-09-13, not taken from the vendor docs (which say three months):
 *  - NIFTY index 1m bars exist from 2025-03-17. Option 1m bars from 2025-03-24, gated by TRADE
 *    DATE — the March monthly had no bars on 03-21 and a full session on 03-24.
 *  - An unknown symbol 500s the whole request, so a failed batch is retried symbol by symbol.
 *  - At most 10 queries per request; the REST ceiling is 60 requests a minute, shared with the rest
 *    of the dashboard, so requests go through a pacer.
 *
 * Whether the start date is fixed or a rolling window could not be told from one day of probing, so
 * `findNubraStart` looks for it instead of hard-coding it.
 */
import type { Underlying } from '../backtest/types.ts';
import {
  SESSION_BARS,
  STRIKE_STEP,
  emptyGrid,
  minuteIndex,
  strikeCoverage,
  type EmptyDay,
  type Grid,
  type StoredDay,
} from './daySeries.ts';
import {
  MASTER_EXCHANGE,
  addExpiry,
  isMonthly,
  nearestExpiry,
  type ExpiryCalendar,
} from './expiryCalendar.ts';
import { nseOptionSymbol, type OptionSide } from './optionNames.ts';

export type PostTimeseries = (body: object) => Promise<Record<string, unknown>>;

export interface NubraDeps {
  post: PostTimeseries;
  /** Resolves when the next request may go out. */
  pace: () => Promise<void>;
  log?: (msg: string) => void;
}

const BATCH = 10;
const ATTEMPTS = 3;

export function createPacer(minIntervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minIntervalMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  };
}

interface Point {
  ts?: string | number;
  v: number;
}

interface Query {
  symbol: string;
  type: 'INDEX' | 'OPT';
  fields: string[];
}

function exchangeFor(underlying: string): string {
  return MASTER_EXCHANGE[underlying] ?? 'NSE';
}

function body(underlying: string, date: string, queries: Query[], toDate = date): object {
  return {
    query: queries.map((q) => ({
      exchange: exchangeFor(underlying),
      type: q.type,
      values: [q.symbol],
      fields: q.fields,
      startDate: `${date}T00:00:00.000Z`,
      endDate: `${toDate}T23:59:59.000Z`,
      interval: '1m',
      intraDay: false,
      realTime: false,
    })),
  };
}

function collect(res: Record<string, unknown>): Map<string, Record<string, Point[]>> {
  const out = new Map<string, Record<string, Point[]>>();
  const groups = (res as { result?: Array<{ values?: Array<Record<string, unknown>> }> }).result;
  for (const group of groups ?? []) {
    for (const symbolMap of group.values ?? []) {
      for (const [sym, data] of Object.entries(symbolMap)) {
        out.set(sym, (data ?? {}) as Record<string, Point[]>);
      }
    }
  }
  return out;
}

function istParts(ts: string | number | undefined): { date: string; hhmm: string } | null {
  if (ts == null) return null;
  let ms: number;
  try {
    ms = Number(BigInt(String(ts)) / 1000000n);
  } catch {
    return null;
  }
  const iso = new Date(ms + 19800000).toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

/** Paise points → a rupee grid for one date. */
function toGrid(points: Point[] | undefined, date: string): Grid {
  const g = emptyGrid();
  for (const p of points ?? []) {
    const t = istParts(p.ts);
    if (!t || t.date !== date) continue;
    const i = minuteIndex(t.hhmm);
    if (i >= 0 && Number.isFinite(p.v) && p.v > 0) g[i] = p.v / 100;
  }
  return g;
}

const hasData = (g: Grid) => g.some((v) => v != null);

async function request(deps: NubraDeps, b: object): Promise<Record<string, unknown>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await deps.pace();
    try {
      return await deps.post(b);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message || '';
      // An unlisted symbol comes back as `unexpected status 404` inside a 500. Asking again cannot
      // change that answer, and three attempts with backoff cost ~12s per name.
      if (/status 404/.test(msg)) throw e;
      // A rate-limit answer deserves a real pause; anything else a short one.
      const backoff = /429|rate|too many/i.test(msg) ? 30_000 : 2_000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * Fetch option closes for many symbols in batches. A batch that fails is retried one symbol at a
 * time, so one unlisted strike cannot blank its nine neighbours. Returns null only when every
 * request failed — that is an outage, not an answer, and must not be stored.
 */
async function fetchCloses(
  deps: NubraDeps,
  underlying: string,
  date: string,
  symbols: string[],
): Promise<Map<string, Grid> | null> {
  const out = new Map<string, Grid>();
  let succeeded = 0;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const q = (s: string): Query => ({ symbol: s, type: 'OPT', fields: ['close'] });
    try {
      const res = collect(await request(deps, body(underlying, date, batch.map(q))));
      succeeded++;
      for (const s of batch) out.set(s, toGrid(res.get(s)?.close, date));
    } catch {
      for (const s of batch) {
        try {
          const res = collect(await request(deps, body(underlying, date, [q(s)])));
          succeeded++;
          out.set(s, toGrid(res.get(s)?.close, date));
        } catch (e) {
          deps.log?.(`[analysis nubra] ${date} ${s}: ${(e as Error).message}`);
        }
      }
    }
  }
  return succeeded ? out : null;
}

/**
 * Find the nearest expiry for a date the calendar has no entry for.
 *
 * Weekly names carry the day, so a weekly candidate that returns bars IS the expiry. A monthly name
 * does not: `NIFTY26JUN23500CE` trades on every June date, so "it has bars" says nothing about when
 * it expires — an earlier version of this took the trade date itself for the expiry on exactly that
 * evidence. The monthly contract's expiry is instead read off where its bars stop, over a window
 * reaching past the latest date it could be nearest for.
 */
async function probeExpiry(
  deps: NubraDeps,
  underlying: string,
  date: string,
  atm: number,
): Promise<{ expiry: string; monthly: boolean } | null> {
  const single = async (sym: string, to = date) => {
    try {
      const res = collect(
        await request(
          deps,
          body(underlying, date, [{ symbol: sym, type: 'OPT', fields: ['close'] }], to),
        ),
      );
      return res.get(sym)?.close ?? [];
    } catch {
      return []; // an unlisted name 500s — just not this one
    }
  };

  const start = Date.parse(`${date}T00:00:00Z`);
  for (let d = 0; d <= 7; d++) {
    const dt = new Date(start + d * 86400000);
    if (dt.getUTCDay() === 0 || dt.getUTCDay() === 6) continue;
    const expiry = dt.toISOString().slice(0, 10);
    const sym = nseOptionSymbol(underlying, expiry, atm, 'CE', false);
    if (hasData(toGrid(await single(sym), date))) return { expiry, monthly: false };
  }

  const windowEnd = new Date(start + 8 * 86400000).toISOString().slice(0, 10);
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const monthSym = nseOptionSymbol(underlying, `${date.slice(0, 7)}-01`, atm, 'CE', true);
  const days = (await single(monthSym, windowEnd))
    .map((p) => istParts(p.ts)?.date)
    .filter((x): x is string => !!x)
    .sort();
  const last = days[days.length - 1];
  // Bars running to the end of the window (or to today) mean it expires later than that.
  if (!last || last >= windowEnd || last >= today) return null;
  return { expiry: last, monthly: true };
}

export async function fetchNubraDay(
  deps: NubraDeps,
  underlying: Underlying,
  date: string,
  calendar: ExpiryCalendar,
): Promise<StoredDay> {
  const empty = (reason: string): EmptyDay => ({
    v: 1,
    underlying,
    date,
    source: 'nubra',
    empty: true,
    reason,
  });

  // 1. Underlying OHLC. Throws on outage — the caller retries on a later sync.
  const idx = collect(
    await request(
      deps,
      body(underlying, date, [
        { symbol: underlying, type: 'INDEX', fields: ['open', 'high', 'low', 'close'] },
      ]),
    ),
  ).get(underlying);
  const spot = toGrid(idx?.close, date);
  if (!hasData(spot)) return empty('no-index-bars');
  const spotOhlc = {
    o: toGrid(idx?.open, date),
    h: toGrid(idx?.high, date),
    l: toGrid(idx?.low, date),
  };

  const step = STRIKE_STEP[underlying] ?? 50;
  const firstSpot = spot.find((v) => v != null)!;
  const atm = Math.round(firstSpot / step) * step;

  // 2. Expiry.
  let expiry = nearestExpiry(calendar, date);
  if (!expiry) {
    const probed = await probeExpiry(deps, underlying, date, atm);
    if (!probed) return empty('no-option-data');
    addExpiry(calendar, probed.expiry, probed.monthly);
    expiry = probed.expiry;
    deps.log?.(`[analysis nubra] probed expiry ${probed.expiry} for ${date}`);
  }
  let monthly = isMonthly(calendar, expiry);

  // 3. Option ladder.
  const coverage = strikeCoverage(spot, step)!;
  const plan = (m: boolean) => [
    ...coverage.ce.map((k) => ({
      k,
      side: 'CE' as OptionSide,
      sym: nseOptionSymbol(underlying, expiry!, k, 'CE', m),
    })),
    ...coverage.pe.map((k) => ({
      k,
      side: 'PE' as OptionSide,
      sym: nseOptionSymbol(underlying, expiry!, k, 'PE', m),
    })),
  ];
  let legs = plan(monthly);
  let closes = await fetchCloses(
    deps,
    underlying,
    date,
    legs.map((l) => l.sym),
  );
  if (!closes) {
    // Every name 404s both when Nubra is down and when the calendar's expiry is wrong — a bad date, or
    // the right date in the wrong name form (2025-04-24 was April's monthly, yet a 04-30 expiry made
    // it look weekly). A probe tells them apart: it finds the listed contract, or fails as well.
    const probed = await probeExpiry(deps, underlying, date, atm);
    if (!probed || (probed.expiry === expiry && probed.monthly === monthly)) {
      throw new Error(`every option request failed for ${date}`);
    }
    const form = (m: boolean) => (m ? 'monthly' : 'weekly');
    deps.log?.(
      `[analysis nubra] ${date}: ${form(monthly)} ${expiry} is unlisted, using ${form(probed.monthly)} ${probed.expiry}`,
    );
    addExpiry(calendar, probed.expiry, probed.monthly);
    expiry = probed.expiry;
    monthly = probed.monthly;
    legs = plan(monthly);
    closes = await fetchCloses(
      deps,
      underlying,
      date,
      legs.map((l) => l.sym),
    );
    if (!closes) throw new Error(`every option request failed for ${date}`);
  }

  if (![...closes.values()].some(hasData)) {
    // Either before option history starts, or the calendar guessed the name form wrong. One probe
    // of the other form tells them apart.
    const alt = nseOptionSymbol(underlying, expiry, atm, 'CE', !monthly);
    const again = await fetchCloses(deps, underlying, date, [alt]);
    if (!again || !hasData(again.get(alt) ?? [])) return empty('no-option-data');
    monthly = !monthly;
    addExpiry(calendar, expiry, monthly);
    legs = plan(monthly);
    closes = await fetchCloses(
      deps,
      underlying,
      date,
      legs.map((l) => l.sym),
    );
    if (!closes) throw new Error(`every option request failed for ${date}`);
  }

  const ce: Record<string, Grid> = {};
  const pe: Record<string, Grid> = {};
  for (const l of legs) {
    const g = closes.get(l.sym);
    if (!g || !hasData(g)) continue;
    (l.side === 'CE' ? ce : pe)[String(l.k)] = g;
  }
  if (!Object.keys(ce).length || !Object.keys(pe).length) return empty('no-option-data');

  return { v: 1, underlying, date, source: 'nubra', expiry, monthly, spot, spotOhlc, ce, pe };
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/**
 * First date Nubra has index 1m bars for, by binary search over 5-day windows (a window rather than
 * a single date, so a holiday cannot read as "before history"). About eight requests.
 */
export async function findNubraStart(
  deps: NubraDeps,
  underlying: string,
  today: string,
  lookbackDays = 1000,
): Promise<string> {
  const windowHasData = async (from: string) => {
    const res = collect(
      await request(
        deps,
        body(
          underlying,
          from,
          [{ symbol: underlying, type: 'INDEX', fields: ['close'] }],
          addDays(from, 4),
        ),
      ),
    );
    return (res.get(underlying)?.close ?? []).length > 0;
  };
  let lo = addDays(today, -lookbackDays);
  if (await windowHasData(lo)) return lo;
  let hi = addDays(today, -7);
  while (Date.parse(hi) - Date.parse(lo) > 5 * 86400000) {
    const mid = addDays(lo, Math.floor((Date.parse(hi) - Date.parse(lo)) / 86400000 / 2));
    if (await windowHasData(mid)) hi = mid;
    else lo = mid;
  }
  // [lo, lo+4] had nothing; history starts after it.
  return addDays(lo, 5);
}

export { SESSION_BARS };
