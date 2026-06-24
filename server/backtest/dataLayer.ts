// ─────────────────────────────────────────────────────────────────────────────
// Data layer — reads the historical options parquet tree and exposes it to the
// engine as cached, IST-localised bar arrays plus a per-expiry strike index.
//
// Layout:  <DATA_ROOT>/<UND>/<expiry>/<ATM±N>/<WEEK|MONTH>/<UND>_<expiry>_<FLAG>_<CALL|PUT>.parquet
// Columns: symbol expiry expiryFlag expiryCode atmStrike optionType timestamp
//          datetime open high low close iv volume strike oi spot
// ─────────────────────────────────────────────────────────────────────────────
import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { ExpiryFlag, OptionType, Underlying } from './types.ts';

export const DATA_ROOT =
  process.env.BACKTEST_DATA_ROOT || 'E:/Derivativesproject/ATM Wise data';

const IST_OFFSET_SEC = 5.5 * 3600;

export interface Bar {
  ts:     number;  // epoch seconds (UTC)
  date:   string;  // IST yyyy-mm-dd
  hhmm:   string;  // IST HH:MM
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  iv:     number;
  volume: number;
  strike: number;
  oi:     number;
  spot:   number;
}

export interface StrikeFile {
  strike:   number;
  callPath: string;
  putPath:  string;
}

export interface Contract {
  strike:     number;
  optionType: OptionType;
  bars:       Bar[];
  byDate:     Map<string, Bar[]>;
}

// One trading day across an entire expiry, re-keyed by ABSOLUTE strike. The raw
// files are ATM-relative buckets (ATM±N) whose absolute strike floats minute by
// minute as spot moves, so a single bucket file is NOT one strike. To trade a
// fixed strike we stitch every bucket's bars for the date and regroup by their
// own `strike` value — yielding a continuous intraday series per absolute strike.
export interface ExpiryDay {
  date:    string;
  strikes: number[];            // sorted ascending, strikes present on this date
  call:    Map<number, Bar[]>;  // absolute strike → intraday bars (sorted by ts)
  put:     Map<number, Bar[]>;
}

// ── caches ───────────────────────────────────────────────────────────────────
const contractCache = new Map<string, Promise<Contract>>();
const strikeIdxCache = new Map<string, Promise<StrikeFile[]>>();
const expiryDayCache = new Map<string, Promise<ExpiryDay>>();
const expiryCache    = new Map<string, Promise<string[]>>();

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}

function toIst(tsSec: number): { date: string; hhmm: string } {
  const d = new Date((tsSec + IST_OFFSET_SEC) * 1000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

// ── expiries ─────────────────────────────────────────────────────────────────
/** Sorted list of expiry dates (folder names) that contain the given flag. */
export function listExpiries(und: Underlying, flag: ExpiryFlag): Promise<string[]> {
  const key = `${und}|${flag}`;
  let p = expiryCache.get(key);
  if (!p) {
    p = (async () => {
      const undDir = path.join(DATA_ROOT, und);
      if (!existsSync(undDir)) return [];
      const entries = await readdir(undDir, { withFileTypes: true });
      const out: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        // an expiry has this flag if <expiry>/ATM/<flag> exists
        const atmFlagDir = path.join(undDir, e.name, 'ATM', flag);
        if (existsSync(atmFlagDir)) out.push(e.name);
      }
      out.sort();
      return out;
    })();
    expiryCache.set(key, p);
  }
  return p;
}

export interface ResolvedExpiry { expiry: string; flag: ExpiryFlag; }

/**
 * Resolve a relative expiry offset (0 = nearest ≥ tradeDate).
 *
 * Data quirk: each contract only stores its own expiry week, and on a monthly
 * expiry week the expiry lives under the MONTH flag (not WEEK). So a WEEK request
 * resolves against the UNION of WEEK+MONTH dates and returns whichever flag
 * actually holds the data — keeping weekly strategies continuous across monthly
 * weeks. A MONTH request stays restricted to MONTH expiries.
 */
export async function resolveExpiry(
  und: Underlying, flag: ExpiryFlag, tradeDate: string, offset: number,
): Promise<ResolvedExpiry | null> {
  if (flag === 'MONTH') {
    const months = await listExpiries(und, 'MONTH');
    const i = months.findIndex((e) => e >= tradeDate);
    if (i === -1) return null;
    const t = i + offset;
    return t < months.length ? { expiry: months[t], flag: 'MONTH' } : null;
  }
  const wk = await listExpiries(und, 'WEEK');
  const mo = await listExpiries(und, 'MONTH');
  const weekSet = new Set(wk);
  const union = [...new Set([...wk, ...mo])].sort();
  const i = union.findIndex((e) => e >= tradeDate);
  if (i === -1) return null;
  const t = i + offset;
  if (t >= union.length) return null;
  const expiry = union[t];
  return { expiry, flag: weekSet.has(expiry) ? 'WEEK' : 'MONTH' };
}

// ── strike index ─────────────────────────────────────────────────────────────
/** All available strikes for an expiry/flag with their CALL/PUT file paths, sorted asc. */
export function getStrikeIndex(
  und: Underlying, expiry: string, flag: ExpiryFlag,
): Promise<StrikeFile[]> {
  const key = `${und}|${expiry}|${flag}`;
  let p = strikeIdxCache.get(key);
  if (!p) {
    p = (async () => {
      const expDir = path.join(DATA_ROOT, und, expiry);
      if (!existsSync(expDir)) return [];
      const offsets = await readdir(expDir, { withFileTypes: true });
      const out: StrikeFile[] = [];
      for (const off of offsets) {
        if (!off.isDirectory()) continue;
        const flagDir = path.join(expDir, off.name, flag);
        const callPath = path.join(flagDir, `${und}_${expiry}_${flag}_CALL.parquet`);
        const putPath  = path.join(flagDir, `${und}_${expiry}_${flag}_PUT.parquet`);
        if (!existsSync(callPath)) continue;
        const strike = await readFirstStrike(callPath);
        if (strike == null) continue;
        out.push({ strike, callPath, putPath: existsSync(putPath) ? putPath : callPath });
      }
      out.sort((a, b) => a.strike - b.strike);
      // de-dup identical strikes (defensive)
      return out.filter((v, i) => i === 0 || v.strike !== out[i - 1].strike);
    })();
    strikeIdxCache.set(key, p);
  }
  return p;
}

async function readFirstStrike(file: string): Promise<number | null> {
  try {
    const buf = await asyncBufferFromFile(file);
    const rows = await parquetReadObjects({ file: buf, compressors, rowStart: 0, rowEnd: 1 });
    if (!rows.length) return null;
    return num(rows[0].strike);
  } catch {
    return null;
  }
}

/** Inferred strike step (gap between adjacent strikes). Falls back to 50/100. */
export function strikeStep(idx: StrikeFile[], und: Underlying): number {
  if (idx.length >= 2) {
    const gaps = idx.slice(1).map((s, i) => s.strike - idx[i].strike).filter((g) => g > 0);
    if (gaps.length) return Math.min(...gaps);
  }
  return und === 'SENSEX' ? 100 : 50;
}

// ── contract bars ────────────────────────────────────────────────────────────
// Corrupt/unreadable bucket files (e.g. a truncated parquet whose footer != PAR1).
// Tracked so a single bad file is skipped — and logged exactly once — instead of
// aborting the whole trading day and flooding the UI with per-day warnings.
export const corruptFiles = new Set<string>();
const EMPTY_CONTRACT = (optionType: OptionType): Contract => ({
  strike: NaN, optionType, bars: [], byDate: new Map(),
});

export function readContract(file: string, optionType: OptionType): Promise<Contract> {
  let p = contractCache.get(file);
  if (!p) {
    p = (async () => {
      let rows: Record<string, unknown>[];
      try {
        const buf = await asyncBufferFromFile(file);
        rows = await parquetReadObjects({ file: buf, compressors });
      } catch (e) {
        // Skip this bucket: the rest of the expiry's buckets still stitch fine.
        if (!corruptFiles.has(file)) {
          corruptFiles.add(file);
          console.warn(`[backtest] skipping unreadable parquet: ${path.basename(file)} — ${(e as Error).message}`);
        }
        return EMPTY_CONTRACT(optionType);
      }
      const bars: Bar[] = new Array(rows.length);
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const ts = num(r.timestamp);
        const { date, hhmm } = toIst(ts);
        bars[i] = {
          ts, date, hhmm,
          open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close),
          iv: num(r.iv), volume: num(r.volume), strike: num(r.strike),
          oi: num(r.oi), spot: num(r.spot),
        };
      }
      bars.sort((a, b) => a.ts - b.ts);
      const byDate = new Map<string, Bar[]>();
      for (const b of bars) {
        let arr = byDate.get(b.date);
        if (!arr) { arr = []; byDate.set(b.date, arr); }
        arr.push(b);
      }
      const strike = bars.length ? bars[0].strike : NaN;
      return { strike, optionType, bars, byDate };
    })();
    contractCache.set(file, p);
    // light cache cap
    if (contractCache.size > 600) {
      const firstKey = contractCache.keys().next().value;
      if (firstKey && firstKey !== file) contractCache.delete(firstKey);
    }
  }
  return p;
}

// Stitch every ATM-relative bucket for an expiry into fixed-strike intraday
// series for one date. Reuses the per-file parse cache, so repeated dates within
// the same expiry are cheap. A given (strike, minute) lives in exactly one bucket,
// so regrouping by `strike` yields a gap-free series while the strike stays inside
// the ATM±N window (it drops out only if spot drifts beyond the captured wing).
export function loadExpiryDay(
  und: Underlying, expiry: string, flag: ExpiryFlag, date: string,
): Promise<ExpiryDay> {
  const key = `${und}|${expiry}|${flag}|${date}`;
  let p = expiryDayCache.get(key);
  if (!p) {
    p = (async () => {
      const call = new Map<number, Bar[]>();
      const put = new Map<number, Bar[]>();
      const expDir = path.join(DATA_ROOT, und, expiry);
      if (!existsSync(expDir)) return { date, strikes: [], call, put };
      const offsets = await readdir(expDir, { withFileTypes: true });
      for (const off of offsets) {
        if (!off.isDirectory()) continue;
        const flagDir = path.join(expDir, off.name, flag);
        const callPath = path.join(flagDir, `${und}_${expiry}_${flag}_CALL.parquet`);
        const putPath  = path.join(flagDir, `${und}_${expiry}_${flag}_PUT.parquet`);
        if (existsSync(callPath)) await stitchInto(callPath, 'CALL', date, call);
        if (existsSync(putPath))  await stitchInto(putPath, 'PUT', date, put);
      }
      for (const m of [call, put]) {
        for (const [k, arr] of m) {
          arr.sort((a, b) => a.ts - b.ts);
          // a strike may surface in two adjacent buckets on the same minute at a
          // boundary cross — keep one bar per ts.
          const seen = new Set<number>();
          m.set(k, arr.filter((b) => (seen.has(b.ts) ? false : (seen.add(b.ts), true))));
        }
      }
      const strikes = [...new Set([...call.keys(), ...put.keys()])].sort((a, b) => a - b);
      return { date, strikes, call, put };
    })();
    expiryDayCache.set(key, p);
    if (expiryDayCache.size > 200) {
      const firstKey = expiryDayCache.keys().next().value;
      if (firstKey && firstKey !== key) expiryDayCache.delete(firstKey);
    }
  }
  return p;
}

async function stitchInto(
  file: string, optionType: OptionType, date: string, into: Map<number, Bar[]>,
): Promise<void> {
  const c = await readContract(file, optionType);
  const bars = c.byDate.get(date);
  if (!bars) return;
  for (const b of bars) {
    if (!Number.isFinite(b.strike)) continue;
    let arr = into.get(b.strike);
    if (!arr) { arr = []; into.set(b.strike, arr); }
    arr.push(b);
  }
}

export function clearCaches(): void {
  contractCache.clear();
  strikeIdxCache.clear();
  expiryCache.clear();
  expiryDayCache.clear();
}
