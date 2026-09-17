/**
 * Client side of backdated paper entries ("it is 10:00 now; I entered at 09:25:30").
 *
 * Request shapes for server/backdatedRoutes.ts, plus the small pieces the order ticket, the basket
 * and the Positions tab share. Nothing here is used unless the trader picks "Earlier today".
 */
import type { Instrument } from '../types';
import { getSymbol } from '../types';

export type BackdatedPriceSource = 'open' | 'high' | 'low' | 'close' | 'vwap';

export const BACKDATED_SOURCES: ReadonlyArray<{ id: BackdatedPriceSource; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'high', label: 'High' },
  { id: 'low', label: 'Low' },
  { id: 'close', label: 'Close' },
  { id: 'vwap', label: 'VWAP' },
];

export interface BackdatedEntry {
  enabled: boolean;
  /** IST HH:MM:SS. */
  time: string;
  source: BackdatedPriceSource;
}

/** IST wall clock as HH:MM:SS, `minutesAgo` before now. */
export function istClock(minutesAgo = 0, nowMs = Date.now()): string {
  return new Date(nowMs + 19_800_000 - minutesAgo * 60_000).toISOString().slice(11, 19);
}

export function defaultBackdatedEntry(): BackdatedEntry {
  return { enabled: false, time: istClock(5), source: 'close' };
}

/** `<input type="time" step="1">` drops ":00" seconds in some browsers; the server wants HH:MM:SS. */
export function normalizeHms(v: string): string {
  return /^\d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
}

/** The same resolution as CandleChart's `nubraType`, without pulling the chart module into the ticket. */
export function timeseriesType(inst: Pick<Instrument, 'derivative_type' | 'asset_type'>): string {
  const dt = (inst.derivative_type || '').toUpperCase();
  const at = (inst.asset_type || '').toUpperCase();
  if (dt === 'FUT' || at === 'FUT') return 'FUT';
  if (dt === 'OPT' || at === 'OPT') return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

/** The name the history API knows an instrument by — the one the chart fetches with. */
export function timeseriesSymbol(inst: Instrument): string {
  return getSymbol(inst);
}

export interface BackdatedPreview {
  actual_time: string;
  exact: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number | null;
  vwap_fallback: boolean;
}

export async function fetchBackdatedPreview(
  q: { exchange?: string; type: string; symbol: string; time: string },
  signal?: AbortSignal,
): Promise<BackdatedPreview> {
  const params = new URLSearchParams({
    exchange: q.exchange || 'NSE',
    type: q.type,
    symbol: q.symbol,
    time: normalizeHms(q.time),
  });
  const res = await fetch(`/paper/backdated/price?${params}`, { signal });
  const d = (await res.json()) as BackdatedPreview & { error?: string };
  if (!res.ok || d.error) throw new Error(d.error || 'Price unavailable');
  return d;
}

export interface BackdatedReplayExit {
  ref_id: number;
  basket_group_id: string;
  scope: 'LEG' | 'GROUP';
  reason: 'STOPLOSS' | 'TARGET' | 'PORTFOLIO_TP' | 'PORTFOLIO_SL' | 'TIME_EXIT';
  time: string;
  price: number;
}

const REASON_LABEL: Record<BackdatedReplayExit['reason'], string> = {
  STOPLOSS: 'Stop-loss hit',
  TARGET: 'Target hit',
  PORTFOLIO_TP: 'Max profit hit',
  PORTFOLIO_SL: 'Max loss hit',
  TIME_EXIT: 'Time exit',
};

/** "Stop-loss hit at 09:30:00 — closed at ₹94.50", one clause per distinct exit moment. */
export function describeReplay(exits: BackdatedReplayExit[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of exits) {
    const key = `${e.reason}|${e.time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const legs = exits.filter((x) => x.reason === e.reason && x.time === e.time);
    parts.push(
      legs.length > 1
        ? `${REASON_LABEL[e.reason]} at ${e.time} — ${legs.length} legs closed`
        : `${REASON_LABEL[e.reason]} at ${e.time} — closed at ₹${e.price.toFixed(2)}`,
    );
  }
  return parts.join('; ');
}

/** Today's date in IST, YYYY-MM-DD. */
export function istToday(nowMs = Date.now()): string {
  return new Date(nowMs + 19_800_000).toISOString().slice(0, 10);
}

/**
 * The second of a 1-minute candle a price source refers to, so a trade executed from Nubra BT fills
 * at the price Nubra BT shows for that candle. Measured 2026-09-15 on NIFTY 23300 CE: the candle
 * stamped 09:25 holds the trades from 09:25:00 to 09:25:59 — its open is the 09:25:00 trade, its
 * close the 09:25:59 one, and its minute VWAP is complete at :59.
 */
export function candleSecond(hhmm: string, source: 'open' | 'close' | 'vwap'): string {
  return `${hhmm.slice(0, 5)}:${source === 'open' ? '00' : '59'}`;
}

export interface LiveChainRow {
  ref_id?: number | string;
  /** Strike, in paise on the live chain. Rupees are accepted too. */
  sp?: number | string;
  /** The history symbol the server enriches each row with. */
  symbol?: string;
}

/** Find each leg's live contract in today's chain by strike and side. */
export function matchChainLegs<L extends { strike: number; optionType: 'CE' | 'PE' }>(
  chain: { ce?: LiveChainRow[]; pe?: LiveChainRow[] },
  legs: L[],
): { matched: Array<{ leg: L; refId: number; symbol: string }>; missing: L[] } {
  const matched: Array<{ leg: L; refId: number; symbol: string }> = [];
  const missing: L[] = [];
  for (const leg of legs) {
    const rows = (leg.optionType === 'CE' ? chain.ce : chain.pe) ?? [];
    const row = rows.find((r) => {
      const sp = Number(r.sp);
      return sp === Math.round(leg.strike * 100) || sp === leg.strike;
    });
    const refId = Number(row?.ref_id);
    if (row && refId && row.symbol) matched.push({ leg, refId, symbol: row.symbol });
    else missing.push(leg);
  }
  return { matched, missing };
}

/** IST HH:MM:SS of an epoch-nanosecond stamp (SimBroker's unit). */
export function istHmsFromNs(ns: number | undefined): string {
  return ns ? new Date(ns / 1_000_000 + 19_800_000).toISOString().slice(11, 19) : '';
}

export interface BackdatedTrade {
  order_id: number;
  ref_id: number;
  basket_group_id: string;
  entry_time: string;
  price_source: BackdatedPriceSource;
  exact: boolean;
  fill_price: number;
}
