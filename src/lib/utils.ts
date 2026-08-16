// Tailwind class merging utility
export function cn(...classes: (string | undefined | null | false | 0)[]): string {
  return classes.filter(Boolean).join(' ');
}

// ─── Number formatters ────────────────────────────────────────────────────────
export function fmtPrice(v: number | null | undefined): string {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-IN');
}

export function fmtLakh(v: number | null | undefined): string {
  if (v == null || v === 0) return '—';
  const n = Number(v);
  if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

export function fmtOI(v: number | null | undefined): string {
  if (v == null || v === 0) return '—';
  const n = Number(v);
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (n >= 1000) return (n / 1000).toFixed(1) + ' K';
  return n.toLocaleString('en-IN');
}

export function fmtVol(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return String(v);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
export function formatExpiry(exp: string | number | null | undefined): string {
  if (exp == null) return '—';
  const s = String(exp);
  if (/^\d{8}$/.test(s)) {
    const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    }
  }
  try {
    const d = new Date(exp as string);
    if (!isNaN(d.getTime()))
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch {
    /* ignore */
  }
  return s;
}

// ─── IST chart time ──────────────────────────────────────────────────────────
export const IST_OFFSET = 5.5 * 60 * 60; // seconds
export const NSE_MARKET_OPEN_MIN = 9 * 60 + 15;
export const NSE_MARKET_CLOSE_MIN = 15 * 60 + 30;

/**
 * Trading session per exchange, in IST minutes-of-day.
 *
 * MCX runs 09:00–23:30 — 870 one-minute bars a day against NSE's 375 (measured
 * 2026-08-03 across CRUDEOIL and GOLD, every day identical). Anything that
 * filters bars by session has to ask the exchange rather than assume NSE, or
 * two thirds of a commodity session is silently discarded.
 */
export const MARKET_SESSIONS: Record<string, { openMin: number; closeMin: number }> = {
  NSE: { openMin: NSE_MARKET_OPEN_MIN, closeMin: NSE_MARKET_CLOSE_MIN },
  BSE: { openMin: NSE_MARKET_OPEN_MIN, closeMin: NSE_MARKET_CLOSE_MIN },
  MCX: { openMin: 9 * 60, closeMin: 23 * 60 + 30 },
};

/** Unknown exchanges fall back to the NSE session, which is what they got before. */
export function marketSession(exchange?: string): { openMin: number; closeMin: number } {
  return MARKET_SESSIONS[(exchange || 'NSE').toUpperCase()] ?? MARKET_SESSIONS.NSE;
}

export function chartTimeDayKey(
  t: number | { year: number; month: number; day: number },
): string | null {
  if (typeof t === 'object')
    return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`;
  if (!Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function chartTimeMinuteOfDay(
  t: number | { year: number; month: number; day: number },
): number | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  const d = new Date(t * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function isMarketSessionChartTime(
  t: number | { year: number; month: number; day: number },
  exchange?: string,
): boolean {
  const min = chartTimeMinuteOfDay(t);
  if (min == null) return true;
  const { openMin, closeMin } = marketSession(exchange);
  return min >= openMin && min <= closeMin;
}

type ChartTime = number | { year: number; month: number; day: number };

/**
 * The colour painted onto the LAST point of a session so the segment that would run into the
 * next session is stroked invisibly. Every session therefore reads as its own line.
 *
 * Whitespace alone does not do this. On `setData`, lightweight-charts' data layer keeps only the
 * rows that carry a value (`seriesRows.filter(isSeriesPlotRow)` in `DataLayer`); a whitespace item
 * reserves a column on the time scale and is then dropped from the series itself. `walkLine` gets
 * the surviving points and strokes ONE continuous path through all of them, so an overnight gap
 * is drawn as a straight segment no matter how much whitespace sits inside it. (Verified against
 * lightweight-charts 5.2.0 — see `markSessionBreaks`' test.)
 *
 * What lightweight-charts does honour is a per-point colour. `walkLine` draws the segment INTO a
 * point with the style in force at the *previous* point and only then swaps style, so recolouring
 * a session's last point hides exactly the crossing segment and leaves the segment arriving at it
 * — and every other segment — untouched.
 *
 * Series that can carry this colour set `crosshairMarkerBackgroundColor` to their own line colour,
 * because the marker's colour otherwise falls back to the hovered point's colour and the hover dot
 * would vanish on the one bar per session that carries the break.
 */
export const SESSION_BREAK_COLOR = 'transparent';

/**
 * Recolour the last valued point of every session so lightweight-charts stops drawing the line
 * into the next one. Returns a new array; the points it recolours are copied rather than mutated,
 * so callers may pass cached data straight in.
 *
 * Whitespace entries (no finite `value`) are carried through untouched and ignored when locating a
 * session's edge — they are not part of the series as far as the renderer is concerned.
 *
 * Only INTRADAY points are broken. On a 1d/1w/1mt chart a bar IS a session, so every point would
 * otherwise open a new one and the series would render as unconnected dots. The same guard as
 * `barsToSessionLine`'s whitespace: business-day times are passed through.
 *
 * The final point is never recoloured: there is no following session to break away from, and it is
 * the point `lastValueVisible` reads its axis tag's colour from.
 */
export function markSessionBreaks<T extends { time: ChartTime; value?: number; color?: string }>(
  points: ReadonlyArray<T>,
): Array<T & { color?: string }> {
  const out: Array<T & { color?: string }> = points.slice();
  let lastValued = -1;
  let lastDay: string | null = null;

  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    if (p.value == null || !Number.isFinite(p.value)) continue;
    const day = typeof p.time === 'number' ? chartTimeDayKey(p.time) : null;
    if (lastValued >= 0 && lastDay && day && day !== lastDay)
      out[lastValued] = { ...out[lastValued], color: SESSION_BREAK_COLOR };
    lastValued = i;
    lastDay = day;
  }
  return out;
}

/**
 * Bars → line points for a session-aware chart: out-of-session bars dropped, a valueless point
 * inserted at each day boundary so the two sessions never share a column, and the last point of
 * each session recoloured so the line does not run across the overnight gap (which reads as a move
 * that never happened). See `markSessionBreaks` for why the colour, not the whitespace, is what
 * actually breaks the line.
 *
 * Shared by every host that draws an underlying reference line under the Greek overlays, so all
 * of them break their nights identically.
 */
export function barsToSessionLine<T extends { time: ChartTime; close: number }>(
  bars: ReadonlyArray<T>,
  exchange?: string,
): Array<{ time: ChartTime; value?: number; color?: string }> {
  const points: Array<{ time: ChartTime; value?: number; color?: string }> = [];
  let lastDay: string | null = null;
  let lastNumericTime: number | null = null;

  for (const b of bars) {
    if (!isMarketSessionChartTime(b.time, exchange)) continue;
    const day = chartTimeDayKey(b.time);
    if (lastDay && day && day !== lastDay && lastNumericTime != null) {
      points.push({ time: lastNumericTime + 1 });
    }
    points.push({ time: b.time, value: b.close });
    lastDay = day;
    if (typeof b.time === 'number') lastNumericTime = b.time;
  }
  return markSessionBreaks(points);
}

/** @deprecated Prefer `isMarketSessionChartTime(t, exchange)` — this is the NSE-only form. */
export function isNseMarketSessionChartTime(
  t: number | { year: number; month: number; day: number },
): boolean {
  return isMarketSessionChartTime(t, 'NSE');
}

/**
 * The instant an option expires, as epoch ms. Options settle at their exchange's
 * close, so this derives from `MARKET_SESSIONS` rather than repeating a literal:
 * NSE/BSE 15:30 IST, MCX 23:30 IST.
 *
 * The MCX figure was measured, not assumed (2026-08-03, CRUDEOIL 20260817, five
 * strikes, 4344 points): inverting the vendor's own `vega` + `iv_mid` for T under
 * Black-76 puts their expiry at ~00:20 IST on 18 Aug once the method's bias is
 * removed — within about an hour of the 23:30 close, and roughly nine hours away
 * from 15:30. The same inversion run against NIFTY, where 15:30 is known, comes
 * back +41 min, so an hour of residual is inside the method's own error bar and
 * 15:30 is comfortably excluded for MCX.
 *
 * Accepts 'YYYYMMDD' or 'YYYY-MM-DD'. Returns NaN on anything else.
 */
export function expiryInstantMs(expiry: string, exchange?: string): number {
  const s = String(expiry).replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) return NaN;
  const midnightUtc = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(midnightUtc)) return NaN;
  // Midnight IST, then forward to the close.
  return midnightUtc - IST_OFFSET * 1000 + marketSession(exchange).closeMin * 60_000;
}

/**
 * Sub-minute history (`1s`, `10s`) is retained for a rolling 7×24 hours. Asking for
 * anything older does not return a short series — it fails the entire query with a
 * 500, taking the in-window part of the request with it. Measured 2026-08-03 on both
 * NSE and MCX; the vendor docs' "3 months for intervals below a day" holds for `1m`
 * and above only.
 *
 * Returns the clamped start, leaving non-sub-minute intervals untouched. The margin
 * keeps a request issued moments before the boundary moves from landing outside it.
 */
export const SUB_MINUTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function isSubMinuteInterval(iv: string): boolean {
  return iv === '1s' || iv === '10s';
}

export function clampSubMinuteStart(start: Date, iv: string, nowMs: number = Date.now()): Date {
  if (!isSubMinuteInterval(iv)) return start;
  const earliest = nowMs - SUB_MINUTE_RETENTION_MS + 5 * 60_000;
  return start.getTime() < earliest ? new Date(earliest) : start;
}

export function isMarketOpenNow(exchange?: string): boolean {
  const nowChartTime = Math.floor(Date.now() / 1000) + IST_OFFSET;
  return isMarketSessionChartTime(nowChartTime, exchange);
}

export function isNseMarketOpenNow(): boolean {
  return isMarketOpenNow('NSE');
}
export function toChartTime(
  tsNs: bigint | string | number,
  iv: string,
): number | { year: number; month: number; day: number } {
  const utcSec = Number(BigInt(tsNs.toString()) / 1_000_000_000n);
  const intraday = isIntradayInterval(iv);
  if (intraday) return utcSec + IST_OFFSET;
  const d = new Date((utcSec + IST_OFFSET) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function snapToCandle(
  utcSec: number,
  iv: string,
): number | { year: number; month: number; day: number } {
  const intSec = intervalToSeconds(iv);
  const istSec = utcSec + IST_OFFSET;
  const snapped = Math.floor(istSec / intSec) * intSec;
  if (isIntradayInterval(iv)) return snapped;
  const d = new Date(snapped * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function sortKey(t: number | { year: number; month: number; day: number }): number {
  return typeof t === 'object' ? t.year * 10000 + t.month * 100 + t.day : t;
}

export function intervalToSeconds(iv: string): number {
  const map: Record<string, number> = {
    '1m': 60,
    '2m': 120,
    '3m': 180,
    '5m': 300,
    '10m': 600,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '1d': 86400,
    '1w': 604800,
    '1mt': 2592000,
  };
  return map[iv] || 300;
}

const INTRADAY_SET = new Set(['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h']);
export function isIntradayInterval(iv: string): boolean {
  return INTRADAY_SET.has(iv);
}

export function historyDays(iv: string): number {
  const map: Record<string, number> = {
    '1m': 3,
    '2m': 5,
    '3m': 5,
    '5m': 7,
    '10m': 10,
    '15m': 15,
    '30m': 20,
    '1h': 45,
    '1d': 365,
    '1w': 730,
    '1mt': 1825,
  };
  return map[iv] || 30;
}

export function chunkDays(iv: string): number {
  const map: Record<string, number> = {
    '1m': 3,
    '2m': 5,
    '3m': 7,
    '5m': 10,
    '10m': 15,
    '15m': 20,
    '30m': 30,
    '1h': 60,
    '1d': 180,
    '1w': 365,
    '1mt': 730,
  };
  return map[iv] || 30;
}

// ─── Strike helpers ───────────────────────────────────────────────────────────
export function strikeRs(row: unknown): number {
  const r = row as Record<string, unknown>;
  const raw = (r.sp ?? r.strike_price) as number | undefined;
  if (raw == null) return 0;
  return raw > 10000 ? raw / 100 : raw;
}

// ─── Misc ─────────────────────────────────────────────────────────────────────
export function generateId(): string {
  return Math.random().toString(36).slice(2, 9);
}
