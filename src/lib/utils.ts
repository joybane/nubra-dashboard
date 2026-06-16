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
  if (n >= 1e7)  return (n / 1e7).toFixed(2) + 'Cr';
  if (n >= 1e5)  return (n / 1e5).toFixed(2) + 'L';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

export function fmtVol(v: number | null | undefined): string {
  if (v == null) return '—';
  if (v >= 1e7)  return (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5)  return (v / 1e5).toFixed(2) + ' L';
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
    if (!isNaN(d.getTime())) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
  } catch { /* ignore */ }
  return s;
}

// ─── IST chart time ──────────────────────────────────────────────────────────
export const IST_OFFSET = 5.5 * 60 * 60; // seconds

export function toChartTime(tsNs: bigint | string | number, iv: string): number | { year: number; month: number; day: number } {
  const utcSec = Number(BigInt(tsNs.toString()) / 1_000_000_000n);
  const intraday = isIntradayInterval(iv);
  if (intraday) return utcSec + IST_OFFSET;
  const d = new Date((utcSec + IST_OFFSET) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function snapToCandle(utcSec: number, iv: string): number | { year: number; month: number; day: number } {
  const intSec  = intervalToSeconds(iv);
  const istSec  = utcSec + IST_OFFSET;
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
    '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600,
    '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400, '1w': 604800, '1mt': 2592000,
  };
  return map[iv] || 300;
}

const INTRADAY_SET = new Set(['1m', '2m', '3m', '5m', '10m', '15m', '30m', '1h']);
export function isIntradayInterval(iv: string): boolean { return INTRADAY_SET.has(iv); }

export function historyDays(iv: string): number {
  const map: Record<string, number> = {
    '1m': 3, '2m': 5, '3m': 5, '5m': 7, '10m': 10,
    '15m': 15, '30m': 20, '1h': 45, '1d': 365, '1w': 730, '1mt': 1825,
  };
  return map[iv] || 30;
}

export function chunkDays(iv: string): number {
  const map: Record<string, number> = {
    '1m': 3, '2m': 5, '3m': 7, '5m': 10, '10m': 15,
    '15m': 20, '30m': 30, '1h': 60, '1d': 180, '1w': 365, '1mt': 730,
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
