/**
 * Nubra BT over the local parquet tree ("ATM Wise data").
 *
 * The broker's history starts on a fixed date per underlying (NIFTY 2025-03-24, SENSEX 2025-07-14);
 * the parquet tree goes back years further. Everything here turns that tree into the exact shapes the
 * Nubra BT routes already build from broker bars — `NbBar`s, a strike → bars ladder, a spot series —
 * so the routes branch on WHERE the bars come from and nothing downstream of them changes.
 *
 * What the tree cannot supply, and how each gap is filled:
 * - Spot OHLC: only a per-minute spot close exists. Candles are built close-to-close (open = the
 *   previous minute's close), which draws the same path without inventing intra-minute range.
 * - Strikes: only ATM±10 at each minute are captured, so a strike far from the money has bars only
 *   while spot was near it. Callers must check a bar's distance from the minute they asked for.
 * - Ticks: none. Decay runs on minute closes, as an out-of-window broker day already does.
 * - Greeks: none stored. `localGreekSeries` reconstructs them with Black-76 off the put-call-parity
 *   forward (never spot — NIFTY's forward sits below it), the same method the Greek overlay uses.
 */
import {
  loadExpiryDay,
  listExpiries,
  readContract,
  DATA_ROOT,
  type Bar,
} from './backtest/dataLayer.ts';
import type { ExpiryFlag, Underlying } from './backtest/types.ts';
import { createDayStore } from './analysis/daySeries.ts';
import path from 'path';
import { existsSync } from 'fs';
import {
  blackScholes,
  forwardFromParity,
  impliedVolatility,
  RISK_FREE,
} from '../src/lib/GexService.ts';

export type DataSource = 'nubra' | 'local';
export type SourcePref = 'auto' | DataSource;

/** Same shape as the routes' NbBar: `ts` is epoch nanoseconds as a string, prices in rupees. */
export interface LocalBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Decimal (0.14 = 14 %), matching the broker's `iv_mid`. The tree stores vol points. */
  iv: number;
  /** Cumulative volume up to and including this minute, like the broker's `cumulative_volume`. */
  vol: number;
  oi: number;
}

export interface LocalDay {
  underlying: Underlying;
  date: string;
  expiry: string;
  flag: ExpiryFlag;
  /** Strikes with at least one bar on `date`, ascending. */
  strikes: number[];
  ce: Map<number, LocalBar[]>;
  pe: Map<number, LocalBar[]>;
  /** Underlying per minute, OHLC synthesised from consecutive closes. */
  spot: LocalBar[];
}

/**
 * First date with broker history, used when the Analysis cache has no Nubra days to read it from.
 * Measured from that cache on 2026-10-02.
 */
const NUBRA_FROM_FALLBACK: Record<Underlying, string> = {
  NIFTY: '2025-03-24',
  SENSEX: '2025-07-14',
};

/**
 * First date the broker has an instrument master (`/refdata/refdata/<date>`) for. Nubra BT cannot
 * use the broker without one — the master is what maps a strike to the symbol its bars are filed
 * under — so for this view broker history starts here, not at the first date it has bars for.
 * Measured 2026-10-02 on both NSE and BSE: every date probed up to 2025-07-18 returned an empty
 * master, every one from 2025-07-21 a full one, though bars exist from 2025-03-24 (NIFTY).
 */
const BROKER_REFDATA_FROM = '2025-07-21';

/** Only the underlyings the tree holds can be served locally. */
export function isLocalUnderlying(und: string): und is Underlying {
  return und === 'NIFTY' || und === 'SENSEX';
}

export function parseSourcePref(raw: unknown): SourcePref {
  return raw === 'nubra' || raw === 'local' ? raw : 'auto';
}

const NS_PER_SEC = 1_000_000_000n;

export function secToNs(sec: number): string {
  return String(BigInt(Math.round(sec)) * NS_PER_SEC);
}

export function nsToMs(ns: string): number {
  return Number(BigInt(ns) / 1_000_000n);
}

/** IST minutes since midnight for an ns timestamp string. */
export function nsToIstMin(ns: string): number {
  const d = new Date(nsToMs(ns) + 19_800_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Option bars → LocalBars. Volume is accumulated so it reads like the broker's cumulative field. */
export function toLocalBars(bars: Bar[]): LocalBar[] {
  const out: LocalBar[] = [];
  let cum = 0;
  for (const b of bars) {
    if (!Number.isFinite(b.close)) continue;
    cum += Number.isFinite(b.volume) ? b.volume : 0;
    out.push({
      ts: secToNs(b.ts),
      open: Number.isFinite(b.open) ? b.open : b.close,
      high: Number.isFinite(b.high) ? b.high : b.close,
      low: Number.isFinite(b.low) ? b.low : b.close,
      close: b.close,
      iv: Number.isFinite(b.iv) && b.iv > 0 ? b.iv / 100 : 0,
      vol: cum,
      oi: Number.isFinite(b.oi) ? b.oi : 0,
    });
  }
  return out;
}

/**
 * The day's spot series from every bar's `spot` column (identical across a minute's bars), as
 * candles drawn close-to-close: open = previous minute's close, so the line is continuous and no
 * high/low beyond what was actually observed is invented.
 */
export function spotFromBars(bars: Iterable<Bar>): LocalBar[] {
  const bySec = new Map<number, number>();
  for (const b of bars) {
    if (!bySec.has(b.ts) && Number.isFinite(b.spot) && b.spot > 0) bySec.set(b.ts, b.spot);
  }
  const secs = [...bySec.keys()].sort((a, b) => a - b);
  const out: LocalBar[] = [];
  let prev = NaN;
  for (const sec of secs) {
    const close = bySec.get(sec)!;
    const open = Number.isFinite(prev) ? prev : close;
    out.push({
      ts: secToNs(sec),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      iv: 0,
      vol: 0,
      oi: 0,
    });
    prev = close;
  }
  return out;
}

/** Whether `flag`'s ATM file for `expiry` has bars on `date`. Reads one cached file. */
async function hasBarsOn(
  und: Underlying,
  expiry: string,
  flag: ExpiryFlag,
  date: string,
): Promise<boolean> {
  const file = path.join(
    DATA_ROOT,
    und,
    expiry,
    'ATM',
    flag,
    `${und}_${expiry}_${flag}_CALL.parquet`,
  );
  if (!existsSync(file)) return false;
  const c = await readContract(file, 'CALL');
  return (c.byDate.get(date)?.length ?? 0) > 0;
}

/**
 * How far ahead of the trade date an expiry can still hold that date's bars. A MONTH file covers
 * about a month of run-up, a WEEK file only its own week; 40 days covers both with room.
 */
const EXPIRY_LOOKAHEAD_DAYS = 40;

const expiriesMemo = new Map<string, Promise<Array<{ expiry: string; flag: ExpiryFlag }>>>();

/**
 * Expiries that actually carry bars on `date`, ascending — in practice the nearest weekly and the
 * running monthly. A weekly's file covers only its own week, so a later weekly is never offered.
 */
export function localExpiriesFor(
  und: Underlying,
  date: string,
): Promise<Array<{ expiry: string; flag: ExpiryFlag }>> {
  const key = `${und}|${date}`;
  let p = expiriesMemo.get(key);
  if (!p) {
    p = (async () => {
      const [wk, mo] = await Promise.all([listExpiries(und, 'WEEK'), listExpiries(und, 'MONTH')]);
      const limit = new Date(Date.parse(`${date}T00:00:00Z`) + EXPIRY_LOOKAHEAD_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const candidates = [...new Set([...wk, ...mo])].filter((e) => e >= date && e <= limit).sort();
      const weekSet = new Set(wk);
      const monthSet = new Set(mo);
      const out: Array<{ expiry: string; flag: ExpiryFlag }> = [];
      for (const expiry of candidates) {
        // An expiry folder can in principle hold both flags; whichever has the date wins, WEEK first.
        const flags: ExpiryFlag[] = [];
        if (weekSet.has(expiry)) flags.push('WEEK');
        if (monthSet.has(expiry)) flags.push('MONTH');
        for (const flag of flags) {
          if (await hasBarsOn(und, expiry, flag, date)) {
            out.push({ expiry, flag });
            break;
          }
        }
      }
      return out;
    })();
    expiriesMemo.set(key, p);
    // Failures are not cached: a transient read error must not stick for the process lifetime.
    p.catch(() => expiriesMemo.delete(key));
    if (expiriesMemo.size > 500) {
      const first = expiriesMemo.keys().next().value;
      if (first && first !== key) expiriesMemo.delete(first);
    }
  }
  return p;
}

const dayMemo = new Map<string, Promise<LocalDay | null>>();

/**
 * One expiry's ladder on one date, stitched by ABSOLUTE strike (`loadExpiryDay` regroups the
 * floating ATM±N buckets by each bar's own strike — reading a bucket as a strike is the bug the
 * ATM-wise data note warns about). Null when the expiry holds nothing for the date.
 */
export function localDay(und: Underlying, expiry: string, date: string): Promise<LocalDay | null> {
  const key = `${und}|${expiry}|${date}`;
  let p = dayMemo.get(key);
  if (!p) {
    p = (async () => {
      const listed = (await localExpiriesFor(und, date)).find((e) => e.expiry === expiry);
      if (!listed) return null;
      const raw = await loadExpiryDay(und, expiry, listed.flag, date);
      if (!raw.strikes.length) return null;
      const ce = new Map<number, LocalBar[]>();
      const pe = new Map<number, LocalBar[]>();
      for (const [k, bars] of raw.call) ce.set(k, toLocalBars(bars));
      for (const [k, bars] of raw.put) pe.set(k, toLocalBars(bars));
      const all: Bar[] = [];
      for (const bars of raw.call.values()) all.push(...bars);
      for (const bars of raw.put.values()) all.push(...bars);
      return {
        underlying: und,
        date,
        expiry,
        flag: listed.flag,
        strikes: raw.strikes,
        ce,
        pe,
        spot: spotFromBars(all),
      };
    })();
    dayMemo.set(key, p);
    p.catch(() => dayMemo.delete(key));
    if (dayMemo.size > 60) {
      const first = dayMemo.keys().next().value;
      if (first && first !== key) dayMemo.delete(first);
    }
  }
  return p;
}

/**
 * The bar at `hhmm`, or null when the nearest one is more than `maxGapMin` away.
 *
 * The broker routes take the nearest bar at any distance, which is harmless on a full ladder. Here
 * it is not: a strike outside the captured ATM±10 wing has no bars for whole stretches of the day,
 * and "nearest" would quietly price a leg from a different hour.
 */
export function localBarAt(
  bars: LocalBar[] | undefined,
  hhmm: string,
  maxGapMin = 2,
): LocalBar | null {
  if (!bars?.length) return null;
  const target = hhmmToMin(hhmm);
  let best: LocalBar | null = null;
  let bestD = Infinity;
  for (const b of bars) {
    const d = Math.abs(nsToIstMin(b.ts) - target);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best && bestD <= maxGapMin ? best : null;
}

// ── which source answers a date ─────────────────────────────────────────────

const NUBRA_FROM_TTL_MS = 10 * 60_000;
const nubraFromMemo = new Map<string, { at: number; value: string }>();

/**
 * First date Nubra BT can read from the broker: the later of where its bars start — read from the
 * Analysis cache's Nubra days (that sync walks back until the broker answers empty), or the
 * measured constant without that cache — and where its instrument masters start.
 */
export async function nubraFromFor(und: Underlying, analysisCacheDir?: string): Promise<string> {
  const hit = nubraFromMemo.get(und);
  if (hit && Date.now() - hit.at < NUBRA_FROM_TTL_MS) return hit.value;
  let value = NUBRA_FROM_FALLBACK[und];
  if (analysisCacheDir) {
    try {
      const listing = await createDayStore(analysisCacheDir).listDetailed(und, 'nubra');
      const first = listing.find((d) => !d.empty)?.date;
      if (first) value = first;
    } catch {
      /* keep the fallback */
    }
  }
  if (value < BROKER_REFDATA_FROM) value = BROKER_REFDATA_FROM;
  nubraFromMemo.set(und, { at: Date.now(), value });
  return value;
}

/**
 * The source a request is served from. Explicit choices are honoured (a forced 'local' for an
 * underlying the tree does not hold is answered as 'nubra' — there is nothing else to read);
 * 'auto' picks local only for dates before broker history that the tree actually covers.
 */
export async function resolveSource(
  und: string,
  date: string,
  pref: SourcePref,
  analysisCacheDir?: string,
): Promise<DataSource> {
  if (!isLocalUnderlying(und)) return 'nubra';
  if (pref !== 'auto') return pref;
  if (date >= (await nubraFromFor(und, analysisCacheDir))) return 'nubra';
  return (await localExpiriesFor(und, date)).length ? 'local' : 'nubra';
}

// ── local contract names, for the Greek overlay ─────────────────────────────

/** `LOCAL|NIFTY|2024-01-04|21500|CE` — what /band-contracts hands out and /local-historical reads. */
export function localContractName(
  und: Underlying,
  expiry: string,
  strike: number,
  side: 'CE' | 'PE',
): string {
  return `LOCAL|${und}|${expiry}|${strike}|${side}`;
}

export function parseLocalContractName(
  name: string,
): { und: Underlying; expiry: string; strike: number; side: 'CE' | 'PE' } | null {
  const parts = name.split('|');
  if (parts.length !== 5 || parts[0] !== 'LOCAL') return null;
  const [, und, expiry, strikeRaw, side] = parts;
  const strike = Number(strikeRaw);
  if (!isLocalUnderlying(und) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  if (!Number.isFinite(strike) || strike <= 0 || (side !== 'CE' && side !== 'PE')) return null;
  return { und, expiry, strike, side };
}

/** Weekdays (IST calendar dates) from `startMs` to `endMs` inclusive. */
export function istDatesBetween(startMs: number, endMs: number): string[] {
  const out: string[] = [];
  const IST = 19_800_000;
  const first = new Date(startMs + IST).toISOString().slice(0, 10);
  const last = new Date(endMs + IST).toISOString().slice(0, 10);
  for (
    let t = Date.parse(`${first}T00:00:00Z`);
    t <= Date.parse(`${last}T00:00:00Z`);
    t += 86_400_000
  ) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Expiry instant (15:30 IST) — NSE and BSE index options both settle at the cash close. */
function expiryMs(expiry: string): number {
  return Date.parse(`${expiry}T00:00:00Z`) - 19_800_000 + (15 * 60 + 30) * 60_000;
}

/** Same floor as the overlay's yearsToExpiry: never below one hour, so expiry day stays priceable. */
function yearsToExpiry(expiry: string, ms: number): number {
  const days = Math.max(0, (expiryMs(expiry) - ms) / 86_400_000);
  return Math.max(days / 365, 1 / (365 * 24));
}

export interface GreekPoint {
  ts: string;
  delta: number;
  vega: number;
  theta: number;
  iv: number;
}

/**
 * Per-minute Black-76 greeks for every strike of a day, keyed `${strike}|${side}`.
 *
 * The forward at each minute comes from put-call parity at the strike nearest spot that has both a
 * CE and a PE close — the overlay's own `buildParityForwards`, done once here. A print whose IV will
 * not invert (sub-intrinsic, stale) is dropped rather than given a made-up vol. Units are the ones
 * `blackScholes` returns: vega per 1 vol point, delta as a fraction, theta per calendar day (the
 * instantaneous rate; near expiry it reads higher than the broker's, which reprices a day later).
 */
export function localGreekSeries(day: LocalDay): Map<string, GreekPoint[]> {
  const spotByTs = new Map(day.spot.map((b) => [b.ts, b.close]));
  // ts → strike → { ce, pe }
  const pairs = new Map<string, Map<number, { ce?: number; pe?: number }>>();
  const note = (side: 'ce' | 'pe', strike: number, bars: LocalBar[]) => {
    for (const b of bars) {
      if (!(b.close > 0)) continue;
      let byStrike = pairs.get(b.ts);
      if (!byStrike) {
        byStrike = new Map();
        pairs.set(b.ts, byStrike);
      }
      const pair = byStrike.get(strike) ?? {};
      pair[side] = b.close;
      byStrike.set(strike, pair);
    }
  };
  for (const [k, bars] of day.ce) note('ce', k, bars);
  for (const [k, bars] of day.pe) note('pe', k, bars);

  const forward = new Map<string, number>();
  for (const [ts, byStrike] of pairs) {
    const S = spotByTs.get(ts);
    if (!(S && S > 0)) continue;
    let bestK = 0;
    let bestGap = Infinity;
    let ce = 0;
    let pe = 0;
    for (const [K, pair] of byStrike) {
      if (pair.ce == null || pair.pe == null) continue;
      const gap = Math.abs(K - S);
      if (gap < bestGap) {
        bestGap = gap;
        bestK = K;
        ce = pair.ce;
        pe = pair.pe;
      }
    }
    if (bestK > 0)
      forward.set(
        ts,
        forwardFromParity(bestK, ce, pe, RISK_FREE, yearsToExpiry(day.expiry, nsToMs(ts))),
      );
  }

  const out = new Map<string, GreekPoint[]>();
  const build = (side: 'CE' | 'PE', ladder: Map<number, LocalBar[]>) => {
    for (const [K, bars] of ladder) {
      const points: GreekPoint[] = [];
      for (const b of bars) {
        const F = forward.get(b.ts) ?? spotByTs.get(b.ts);
        if (!(F && F > 0) || !(b.close > 0)) continue;
        const T = yearsToExpiry(day.expiry, nsToMs(b.ts));
        const iv = impliedVolatility(b.close, F, K, T, RISK_FREE, side);
        if (!Number.isFinite(iv) || iv <= 0) continue;
        const g = blackScholes(F, K, T, RISK_FREE, iv, side);
        points.push({ ts: b.ts, delta: g.delta, vega: g.vega, theta: g.theta, iv });
      }
      out.set(`${K}|${side}`, points);
    }
  };
  build('CE', day.ce);
  build('PE', day.pe);
  return out;
}

const greekMemo = new Map<string, Map<string, GreekPoint[]>>();

/** `localGreekSeries`, memoised per day — Vega, Theta and IV overlays all ask for the same one. */
export function localGreeksFor(day: LocalDay): Map<string, GreekPoint[]> {
  const key = `${day.underlying}|${day.expiry}|${day.date}`;
  let hit = greekMemo.get(key);
  if (!hit) {
    hit = localGreekSeries(day);
    greekMemo.set(key, hit);
    if (greekMemo.size > 30) {
      const first = greekMemo.keys().next().value;
      if (first && first !== key) greekMemo.delete(first);
    }
  }
  return hit;
}
