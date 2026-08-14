// ─────────────────────────────────────────────────────────────────────────────
// Daily ATM implied-volatility history, read straight out of the historical
// options parquet tree.
//
// Why this exists: the broker serves no historical IV (probed 2026-07-30 — the
// timeseries endpoint returns delta/vega/theta but no `iv` under any name), so
// the Tracker's IV overlay can show the LEVEL of vol but has nothing to say
// about whether that level is high or low. IV rank and IV percentile need a long
// baseline, and the backtest parquet tree already holds five years of one: the
// `ATM` bucket is by construction the strike nearest spot at each minute (measured:
// |K − S| stays under one strike step), which is the textbook ATM definition.
//
// So no broker calls and no expiry-calendar reconstruction: the expiry folder names
// ARE the calendar, and the ATM bucket already tracks spot. The IV itself is
// inverted from the CE/PE closes rather than read from the vendor's `iv` column —
// see "One pipeline, not two" further down for the measurement that forced that.
//
// Layout read:  <DATA_ROOT>/<UND>/<expiry>/ATM/<WEEK|MONTH>/<UND>_<expiry>_<FLAG>_<CALL|PUT>.parquet
//
// Maturity caveat, and why observations carry their DTE
// ────────────────────────────────────────────────────
// A weekly expiry's file only covers its own final week, so on any given date the
// tree offers a weekly at 0-6 DTE and (during a monthly's run-up) a monthly at up
// to ~30 DTE. There is NOT enough coverage to build a daily constant-maturity
// series — a 30-DTE reading exists on roughly one date per month. Emitting one
// anyway would mean silently interpolating across a gap the data cannot support.
//
// Instead every observation is emitted with the DTE it was measured at, and the
// client ranks a live reading only against observations at a comparable DTE (see
// src/lib/ivRank.ts). That is not a workaround — index IV rises mechanically into
// expiry, so a DTE-matched comparison is strictly more meaningful than the naive
// "front-week IV rank" that mixes 0-DTE and 6-DTE readings into one range.
// ─────────────────────────────────────────────────────────────────────────────
import path from 'path';
import { existsSync } from 'fs';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { DATA_ROOT, listExpiries } from './dataLayer.ts';
import type { ExpiryFlag, Underlying } from './types.ts';
// Shared with the frontend on purpose — see "One pipeline, not two" below. GexService is pure
// math with no imports of its own, so nothing browser-shaped comes across the boundary.
import { forwardFromParity, impliedVolatility, RISK_FREE } from '../../src/lib/GexService.ts';

const IST_OFFSET_SEC = 5.5 * 3600;

// The day's mark. Deliberately not the 15:29 close: the closing minutes carry
// auction noise. 15:15 is late enough to be the settled level.
const MARK_HHMM = '15:15';

// Bar-level band, in vol POINTS (the parquet stores 12.658 for 12.66 %). Loose on
// purpose — its only job is to skip bars carrying no IV at all (the vendor writes a
// literal 0 in the last minutes of expiry day) so the mark lands on a real print.
// Plausibility is judged on the finished observation instead, below.
const IV_BAR_MAX = 200;

// Observation-level floor. Measured against 5 years of this tree: 28 observations at
// 1+ DTE fall under 6 vol points, and they are vendor breakages rather than quiet
// markets — 2025-12-30 reports the identical 1.2818695 from two unrelated contracts
// (0 DTE and 28 DTE), which only happens when the feed broke for the whole day.
// NIFTY ATM IV has never genuinely printed below ~8. Left in, a single such day would
// define the bottom of the range and pull every IV rank upward.
const IV_FLOOR = 6;

// Expiry day is excluded outright, and this is the substantive modelling decision in
// this file. At 0 DTE the ATM premium is almost pure remaining-minutes, so the implied
// vol it inverts to measures the countdown, not the market: on 2025-11-04 the ATM call
// went 14.1 → 7.7 → 3.5 → 0.4 across one afternoon while nothing about NIFTY's
// volatility changed. The two distributions are plainly different animals (0 DTE
// p05/p25 = 1.97/5.26 against 1 DTE's 9.71/11.87), so mixing them would widen every
// range downward. src/lib/ivRank.ts refuses to rank a 0-DTE selection for the same
// reason, rather than quietly comparing it to 1-2 DTE history.
const MIN_DTE = 1;

/** One day's ATM IV, tagged with how far from expiry it was measured. */
export interface IvObservation {
  date: string; // IST yyyy-mm-dd
  dte: number; // calendar days from `date` to the expiry it came from
  iv: number; // vol points, mean of the CE and PE inversions at the ATM strike
  /** The vendor's own IV for the same bar. Diagnostic only — see "One pipeline, not two". */
  vendorIv: number;
}

export interface IvHistoryResult {
  und: Underlying;
  from: string;
  to: string;
  observations: IvObservation[];
  expiriesScanned: number;
  ms: number;
}

const UNDERLYINGS: Underlying[] = ['NIFTY', 'SENSEX'];

/**
 * Map whatever the frontend calls an instrument onto an underlying we hold data
 * for. Accepts 'NIFTY', 'nifty 50', 'NIFTY50', 'SENSEX'; returns null for
 * anything else (BANKNIFTY, single stocks) so the caller can say "no baseline"
 * rather than rank against the wrong instrument.
 */
export function normalizeUnderlying(raw: string): Underlying | null {
  const s = (raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  for (const u of UNDERLYINGS) if (s.startsWith(u)) return u;
  return null;
}

function istParts(tsSec: number): { date: string; hhmm: string } {
  const iso = new Date((tsSec + IST_OFFSET_SEC) * 1000).toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

const DAY_MS = 86_400_000;

function dteBetween(date: string, expiry: string): number {
  return Math.round((Date.parse(expiry) - Date.parse(date)) / DAY_MS);
}

// ── per-file mark extraction ─────────────────────────────────────────────────
// Only the columns needed are pulled, and the parsed bars are NOT retained: this
// path would otherwise push hundreds of full contracts through dataLayer's shared
// contract cache and evict what the backtest engine is using.
interface Mark {
  ts: number; // epoch seconds, so time-to-expiry uses the bar's real minute
  hhmm: string;
  iv: number; // vendor's own number, kept for the cross-check below
  strike: number;
  spot: number;
  close: number;
}

type MarkMap = Map<string, Mark>; // IST date → the day's mark bar

async function marksFrom(file: string): Promise<MarkMap> {
  const out: MarkMap = new Map();
  let rows: Record<string, unknown>[];
  try {
    const buf = await asyncBufferFromFile(file);
    rows = await parquetReadObjects({
      file: buf,
      compressors,
      columns: ['timestamp', 'iv', 'strike', 'spot', 'close'],
    });
  } catch {
    return out; // corrupt/truncated bucket — dataLayer logs these for the engine
  }

  // Keep the latest bar at or before the mark for each date. Files are not
  // guaranteed sorted, so compare rather than assume.
  for (const r of rows) {
    const iv = num(r.iv);
    if (!(iv > 0 && iv < IV_BAR_MAX)) continue;
    const close = num(r.close);
    if (!(close > 0)) continue;
    const ts = num(r.timestamp);
    const { date, hhmm } = istParts(ts);
    if (hhmm > MARK_HHMM) continue;
    const prev = out.get(date);
    if (prev === undefined || hhmm > prev.hhmm) {
      out.set(date, { ts, hhmm, iv, strike: num(r.strike), spot: num(r.spot), close });
    }
  }
  return out;
}

// ── One pipeline, not two ────────────────────────────────────────────────────
// The baseline could just use the vendor's `iv` column, and the first cut did. But
// the live reading being ranked comes from the app's own inversion (parity forward
// into Black-76, src/lib/GexService.ts), and measuring the two against each other
// over 160 matched 15:15 marks showed the app sitting ABOVE the vendor on ~95 % of
// them — median +0.26 vol points, mean absolute 0.74. Small, but a one-directional
// offset between a reading and the range it is placed inside is exactly the kind of
// definitional mismatch that produces confident, wrong numbers: worth ~2 rank points
// and rather more percentile near the mode, where the distribution is tight.
//
// So the baseline is inverted here with the same code the overlay uses, from the CE
// and PE closes the parquet already carries at the same ATM strike. The offset is
// then structurally zero rather than merely small, and the vendor's own number stays
// available for the regression test that watches the two apart.
const EXPIRY_UTC_TIME = 'T10:00:00Z'; // 15:30 IST, matching yearsToExpiry in useGreekOverlay
const MIN_T = 1 / (365 * 24 * 60); // one minute, floor so T is never <= 0

function invertAtm(ce: Mark, pe: Mark, expiry: string): number {
  const K = ce.strike;
  const T = Math.max((Date.parse(expiry + EXPIRY_UTC_TIME) - ce.ts * 1000) / (365 * DAY_MS), MIN_T);
  // Market-implied forward from put-call parity at the ATM strike. NIFTY's basis is
  // routinely negative, so spot and spot*e^(rT) are both measurably worse here.
  const F = forwardFromParity(K, ce.close, pe.close, RISK_FREE, T);
  const sides = [
    impliedVolatility(ce.close, F, K, T, RISK_FREE, 'CE'),
    impliedVolatility(pe.close, F, K, T, RISK_FREE, 'PE'),
  ].filter((v) => Number.isFinite(v) && v > 0);
  // Solver returns NaN rather than a default when a price is unpriceable; no finite
  // side means no observation for the day.
  return sides.length ? (sides.reduce((a, b) => a + b, 0) / sides.length) * 100 : NaN;
}

// Observations are cached per expiry rather than per request window, so a 1-year
// and a 5-year request share all the work they have in common.
const expiryObsCache = new Map<string, Promise<IvObservation[]>>();

function observationsFor(
  und: Underlying,
  expiry: string,
  flag: ExpiryFlag,
): Promise<IvObservation[]> {
  const key = `${und}|${expiry}|${flag}`;
  let p = expiryObsCache.get(key);
  if (!p) {
    p = (async () => {
      const dir = path.join(DATA_ROOT, und, expiry, 'ATM', flag);
      const call = path.join(dir, `${und}_${expiry}_${flag}_CALL.parquet`);
      const put = path.join(dir, `${und}_${expiry}_${flag}_PUT.parquet`);
      const empty = () => Promise.resolve(new Map<string, Mark>());
      const [ce, pe] = await Promise.all([
        existsSync(call) ? marksFrom(call) : empty(),
        existsSync(put) ? marksFrom(put) : empty(),
      ]);

      const out: IvObservation[] = [];
      for (const date of ce.keys()) {
        const dte = dteBetween(date, expiry);
        if (dte < MIN_DTE) continue;
        const c = ce.get(date)!;
        const p2 = pe.get(date);
        // Parity needs both sides priced on the same minute at the same strike. The ATM
        // bucket's strike floats with spot, so a CE and PE mark can land on different
        // strikes if one side is missing a bar; that is not a forward, so skip it.
        if (!p2 || p2.hhmm !== c.hhmm || p2.strike !== c.strike) continue;
        const iv = invertAtm(c, p2, expiry);
        if (!(iv >= IV_FLOOR)) continue;
        out.push({ date, dte, iv, vendorIv: (c.iv + p2.iv) / 2 });
      }
      out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      return out;
    })();
    expiryObsCache.set(key, p);
  }
  return p;
}

/**
 * Every ATM IV observation in the trailing `days` calendar days of AVAILABLE data.
 *
 * An expiry is scanned when its data window can overlap [from, to]: its own date
 * must be at or after `from` (everything it holds sits before its expiry) and no
 * more than LOOKAHEAD days past `to` (a monthly starts recording ~31 days out).
 *
 * The window ends where the data ends, not at wall-clock now. This tree is a static drop
 * that can sit months behind today, and anchoring to `now` walks the window off the end of
 * it: measured 2026-08-14, the tree stopped at 2026-06-01, so a nominal 365-day baseline
 * covered 292 days and lost one more every day. That decay is silent and it lands hardest on
 * the thinnest band — 1-2 DTE was down to 40 observations against MIN_SAMPLE 20, on its way
 * to the point where src/lib/ivRank.ts stops quoting a rank for expiry week at all.
 *
 * An expiry's file never holds a date past its own expiry, so the newest expiry folder is a
 * safe upper bound on the data. A tree that IS current has a future expiry on disk, which
 * clamps to today and reproduces the original behaviour exactly.
 */
export async function buildIvHistory(und: Underlying, days: number): Promise<IvHistoryResult> {
  const t0 = Date.now();
  const LOOKAHEAD = 45;
  const today = new Date().toISOString().slice(0, 10);

  const flags: ExpiryFlag[] = ['WEEK', 'MONTH'];
  const byFlag = await Promise.all(
    flags.map(async (flag) => [flag, await listExpiries(und, flag)] as const),
  );

  let newest = '';
  for (const [, list] of byFlag) for (const e of list) if (e > newest) newest = e;
  const to = newest && newest < today ? newest : today;
  const from = new Date(Date.parse(to) - days * DAY_MS).toISOString().slice(0, 10);
  const cutoff = new Date(Date.parse(to) + LOOKAHEAD * DAY_MS).toISOString().slice(0, 10);

  const jobs: Promise<IvObservation[]>[] = [];
  let expiriesScanned = 0;
  for (const [flag, list] of byFlag) {
    for (const expiry of list) {
      if (expiry < from || expiry > cutoff) continue;
      expiriesScanned++;
      jobs.push(observationsFor(und, expiry, flag));
    }
  }

  const observations = (await Promise.all(jobs))
    .flat()
    .filter((o) => o.date >= from && o.date <= to)
    .sort((a, b) => (a.date === b.date ? a.dte - b.dte : a.date < b.date ? -1 : 1));

  return { und, from, to, observations, expiriesScanned, ms: Date.now() - t0 };
}

/** Test/diagnostic hook — drops the per-expiry observation cache. */
export function clearIvHistoryCache(): void {
  expiryObsCache.clear();
}
