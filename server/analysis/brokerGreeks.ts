/**
 * The broker's own stored greeks for one day's two contracts, merged with the reconstruction.
 *
 * Nubra's `charts/timeseries` serves delta, gamma, theta and vega per minute for options traded since
 * about 2026-06 (measured 2026-10-03 on 2026-08-03 and 2026-08-28: 386 points each, gamma within
 * ~1.4% of the Black-76 reconstruction, same units as `blackScholes`). They are what Nubra itself
 * shows, so a day that has them uses them. Everything else — local-source days, older Nubra days, a
 * minute the broker skipped, or no broker session at all — is filled from `greeks.ts`, which
 * rebuilds them off the put-call-parity forward. Nothing here ever throws on a broker failure: the
 * reconstruction is always there to answer.
 *
 * Greeks are not paise (only `close` is); IV is not requested because the Analysis pane has none.
 */
import { SESSION_BARS, emptyGrid, minuteIndex, type Grid } from './daySeries.ts';
import { MASTER_EXCHANGE } from './expiryCalendar.ts';
import { nseOptionSymbol, type OptionSide } from './optionNames.ts';
import type { DayGreekSeries } from './greeks.ts';
import type { PostTimeseries } from './nubraSource.ts';

export const PANE_GREEKS = ['delta', 'gamma', 'theta', 'vega'] as const;
export type PaneGreek = (typeof PANE_GREEKS)[number];
export type SideGreeks = Record<PaneGreek, Grid>;

/** Where a side's numbers came from: all broker, broker with reconstructed gaps, or all rebuilt. */
export type GreekSource = 'broker' | 'mixed' | 'parity';

export interface MergedGreeks {
  CE: SideGreeks;
  PE: SideGreeks;
  source: Record<OptionSide, GreekSource>;
}

export interface BrokerDay {
  CE: SideGreeks | null;
  PE: SideGreeks | null;
}

interface Point {
  ts?: string | number;
  v: number;
}

/** IST date and minute of a broker timestamp (epoch nanoseconds). */
function istParts(ts: string | number | undefined): { date: string; hhmm: string } | null {
  if (ts == null) return null;
  try {
    const ms = Number(BigInt(String(ts)) / 1000000n);
    const iso = new Date(ms + 19800000).toISOString();
    return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
  } catch {
    return null;
  }
}

function gridOf(points: Point[] | undefined, date: string): Grid {
  const g = emptyGrid();
  for (const p of points ?? []) {
    const t = istParts(p.ts);
    if (!t || t.date !== date) continue;
    const i = minuteIndex(t.hhmm);
    // Zero is a real value for gamma and vega far out of the money, and theta/delta are signed.
    if (i >= 0 && Number.isFinite(p.v)) g[i] = p.v;
  }
  return g;
}

function sideOf(fields: Record<string, Point[]> | undefined, date: string): SideGreeks | null {
  if (!fields?.delta?.length) return null;
  const side = {} as SideGreeks;
  for (const key of PANE_GREEKS) side[key] = gridOf(fields[key], date);
  return side.delta.some((v) => v != null) ? side : null;
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

export interface BrokerGreeksArgs {
  underlying: string;
  date: string;
  expiry: string;
  monthly: boolean;
  ceStrike: number;
  peStrike: number;
}

/**
 * Both contracts' stored greeks, or `{ CE: null, PE: null }` when the broker has none or cannot be
 * reached. A request carrying an unlisted symbol fails whole (measured in `nubraSource.ts`), so a
 * failure is retried one contract at a time and one bad name cannot blank the other side.
 */
export async function fetchBrokerGreeks(
  post: PostTimeseries,
  pace: () => Promise<void>,
  a: BrokerGreeksArgs,
): Promise<{ day: BrokerDay; error: string | null }> {
  const names = {
    CE: nseOptionSymbol(a.underlying, a.expiry, a.ceStrike, 'CE', a.monthly),
    PE: nseOptionSymbol(a.underlying, a.expiry, a.peStrike, 'PE', a.monthly),
  };
  const exchange = MASTER_EXCHANGE[a.underlying] ?? 'NSE';
  const query = (symbol: string) => ({
    exchange,
    type: 'OPT',
    values: [symbol],
    fields: [...PANE_GREEKS],
    startDate: `${a.date}T00:00:00.000Z`,
    endDate: `${a.date}T23:59:59.000Z`,
    interval: '1m',
    intraDay: false,
    realTime: false,
  });

  let error: string | null = null;
  const got = new Map<string, Record<string, Point[]>>();
  try {
    await pace();
    for (const [k, v] of collect(await post({ query: [query(names.CE), query(names.PE)] }))) {
      got.set(k, v);
    }
  } catch {
    for (const side of ['CE', 'PE'] as const) {
      try {
        await pace();
        for (const [k, v] of collect(await post({ query: [query(names[side])] }))) got.set(k, v);
      } catch (e) {
        error = (e as Error).message || 'broker request failed';
      }
    }
  }
  return {
    day: {
      CE: sideOf(got.get(names.CE), a.date),
      PE: sideOf(got.get(names.PE), a.date),
    },
    error: got.size ? null : error,
  };
}

/**
 * Broker value where the broker has one for that minute, the reconstruction where it does not.
 * A minute the reconstruction cannot price either stays null.
 */
export function mergeGreeks(rebuilt: DayGreekSeries, broker: BrokerDay | null): MergedGreeks {
  const out = {} as MergedGreeks;
  out.source = { CE: 'parity', PE: 'parity' };
  for (const side of ['CE', 'PE'] as const) {
    const b = broker?.[side] ?? null;
    const merged = {} as SideGreeks;
    let fromBroker = 0;
    let fromRebuilt = 0;
    for (const key of PANE_GREEKS) {
      const grid = new Array<number | null>(SESSION_BARS).fill(null);
      for (let i = 0; i < SESSION_BARS; i++) {
        const bv = b?.[key][i];
        if (bv != null) {
          grid[i] = bv;
          fromBroker++;
        } else if (rebuilt[side][key][i] != null) {
          grid[i] = rebuilt[side][key][i];
          fromRebuilt++;
        }
      }
      merged[key] = grid;
    }
    out[side] = merged;
    out.source[side] = !fromBroker ? 'parity' : fromRebuilt ? 'mixed' : 'broker';
  }
  return out;
}
