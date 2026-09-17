/**
 * Today's traded seconds for one instrument, and the price a backdated paper entry fills at.
 *
 * Deliberately self-contained rather than reusing Nubra BT's private `nb*` helpers: the backdated
 * trade feature must not change a line of code that any existing view runs.
 *
 * Facts this relies on (README "Historical data retention"):
 *  - 1s bars are kept for a rolling 168h, so today is always covered.
 *  - A 1s bar exists only for a second that traded. A quiet second has no bar at all.
 *  - Prices come in paise and timestamps as UTC nanoseconds.
 */

export type TimeseriesPost = (body: object) => Promise<Record<string, unknown>>;

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'vwap';
export const PRICE_SOURCES: readonly PriceSource[] = ['open', 'high', 'low', 'close', 'vwap'];

/** One traded second. `sec` is IST seconds past midnight; prices are rupees. */
export interface SecBar {
  sec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** The day's cumulative traded volume as of this second, when the feed carries it. */
  cumVol: number | null;
}

const IST_OFFSET_MS = 19_800_000;
const HMS = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

export function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function istSecondOfDay(ms: number): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

export function parseHms(v: unknown): number | null {
  const m = typeof v === 'string' ? HMS.exec(v.trim()) : null;
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

export function formatHms(sec: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor(sec / 60) % 60)}:${p(sec % 60)}`;
}

/** Epoch nanoseconds for an IST second of an IST date — the unit SimBroker stamps orders in. */
export function istSecondToEpochNs(date: string, sec: number): number {
  return (Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS + sec * 1000) * 1_000_000;
}

/** Trading session in IST seconds. MCX runs into the evening; NSE and BSE close at 15:30. */
export function sessionFor(exchange: string | undefined): { open: number; close: number } {
  return String(exchange).toUpperCase() === 'MCX'
    ? { open: 9 * 3600, close: 23 * 3600 + 30 * 60 }
    : { open: 9 * 3600 + 15 * 60, close: 15 * 3600 + 30 * 60 };
}

export type EntryCheck =
  { ok: true; date: string; sec: number; timeNs: number } | { ok: false; error: string };

/** An entry must be today, inside the session, and strictly before now. */
export function validateEntryTime(
  exchange: string | undefined,
  hms: unknown,
  nowMs: number,
): EntryCheck {
  const sec = parseHms(hms);
  if (sec == null) return { ok: false, error: 'entry_time must be HH:MM:SS' };
  const date = istDateOf(nowMs);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) return { ok: false, error: 'the market is closed today' };
  const { open, close } = sessionFor(exchange);
  if (sec < open || sec > close) {
    return {
      ok: false,
      error: `entry_time must be within the session, ${formatHms(open)}–${formatHms(close)}`,
    };
  }
  if (sec >= istSecondOfDay(nowMs)) {
    return { ok: false, error: 'entry_time must be earlier than now' };
  }
  return { ok: true, date, sec, timeNs: istSecondToEpochNs(date, sec) };
}

interface Point {
  ts?: string | number;
  v: number;
}

/** Nubra's `result[].values[].{symbol}.{field}[]` for one symbol → sorted seconds of one date. */
export function parseSecondBars(
  res: Record<string, unknown>,
  symbol: string,
  date: string,
): SecBar[] {
  const fields: Record<string, Point[]> = {};
  const groups = (res as { result?: Array<{ values?: Array<Record<string, unknown>> }> }).result;
  for (const group of groups ?? []) {
    for (const symbolMap of group.values ?? []) {
      for (const [name, data] of Object.entries(symbolMap)) {
        if (name !== symbol && Object.keys(symbolMap).length > 1) continue;
        for (const [field, points] of Object.entries((data ?? {}) as Record<string, Point[]>)) {
          (fields[field] ??= []).push(...(points ?? []));
        }
      }
    }
  }

  const bySec = new Map<number, SecBar>();
  const at = (ts: Point['ts']): number | null => {
    if (ts == null) return null;
    try {
      const ms = Number(BigInt(String(ts)) / 1_000_000n);
      return istDateOf(ms) === date ? istSecondOfDay(ms) : null;
    } catch {
      return null;
    }
  };
  for (const p of fields.close ?? []) {
    const sec = at(p.ts);
    if (sec == null || !Number.isFinite(p.v) || p.v <= 0) continue;
    const c = p.v / 100;
    bySec.set(sec, { sec, open: c, high: c, low: c, close: c, cumVol: null });
  }
  const apply = (field: string, set: (bar: SecBar, v: number) => void) => {
    for (const p of fields[field] ?? []) {
      const sec = at(p.ts);
      const bar = sec == null ? undefined : bySec.get(sec);
      if (bar && Number.isFinite(p.v)) set(bar, p.v);
    }
  };
  apply('open', (b, v) => v > 0 && (b.open = v / 100));
  apply('high', (b, v) => v > 0 && (b.high = v / 100));
  apply('low', (b, v) => v > 0 && (b.low = v / 100));
  apply('cumulative_volume', (b, v) => (b.cumVol = v));
  return [...bySec.values()].sort((a, b) => a.sec - b.sec);
}

export async function fetchTodaySeconds(
  post: TimeseriesPost,
  q: { exchange: string; type: string; symbol: string; date: string },
): Promise<SecBar[]> {
  const res = await post({
    query: [
      {
        exchange: q.exchange,
        type: q.type,
        values: [q.symbol],
        fields: ['open', 'high', 'low', 'close', 'cumulative_volume'],
        startDate: `${q.date}T00:00:00.000Z`,
        endDate: `${q.date}T23:59:59.000Z`,
        interval: '1s',
        intraDay: true,
        realTime: false,
      },
    ],
  });
  return parseSecondBars(res, q.symbol, q.date);
}

/** The trade at `sec`, or the last one before it. Never a later trade: that price had not happened. */
export function barAt(bars: SecBar[], sec: number): { bar: SecBar; exact: boolean } | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].sec <= sec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : { bar: bars[found], exact: bars[found].sec === sec };
}

export type EntryPrice =
  | {
      ok: true;
      price: number;
      bar: SecBar;
      exact: boolean;
      /** VWAP could not be formed (no volume in the window) and Close was used instead. */
      vwapFallback: boolean;
      vwap: number | null;
    }
  | { ok: false; error: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * VWAP over the entry's minute, from its first second up to and including the entry second.
 * Per-second volume is the step in the day's cumulative volume; each step is priced at that
 * second's close. Null when no volume can be measured in the window.
 */
export function minuteVwap(bars: SecBar[], sec: number): number | null {
  const start = sec - (sec % 60);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.sec < start) continue;
    if (b.sec > sec) break;
    const prev = i > 0 ? bars[i - 1].cumVol : 0;
    if (b.cumVol == null || prev == null) continue;
    const dv = b.cumVol - prev;
    if (dv <= 0) continue;
    pv += dv * b.close;
    vol += dv;
  }
  return vol > 0 ? round2(pv / vol) : null;
}

export function pickEntryPrice(bars: SecBar[], sec: number, source: PriceSource): EntryPrice {
  const hit = barAt(bars, sec);
  if (!hit) return { ok: false, error: 'no trade at or before that time today' };
  const vwap = minuteVwap(bars, sec);
  if (source === 'vwap') {
    return {
      ok: true,
      price: vwap ?? hit.bar.close,
      bar: hit.bar,
      exact: hit.exact,
      vwapFallback: vwap == null,
      vwap,
    };
  }
  return {
    ok: true,
    price: hit.bar[source],
    bar: hit.bar,
    exact: hit.exact,
    vwapFallback: false,
    vwap,
  };
}
