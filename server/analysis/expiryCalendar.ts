/**
 * Which expiries existed, so a trade date can be mapped to its nearest contract without asking the
 * broker for a per-date instrument master.
 *
 * Three sources, unioned and persisted to `<cache>/<UND>/calendar.json`:
 *
 *  1. The local parquet tree's expiry folders — complete from 2021 up to where that data stops.
 *  2. Instrument masters already on disk (`.refdata-cache`, `.refdata-live`). Each lists roughly a
 *     month of expiries ahead of the day it was taken; each file is read once and remembered.
 *  3. Probes (see nubraSource.ts) for any week neither covers. Measured 2026-09-13, the only such
 *     week for NIFTY was the one expiring 2026-06-09: the tree stops at 06-02 and the earliest cached
 *     master, 06-15, no longer lists it.
 *
 * Masters are ~34 MB of JSON each, so reading one is done at most once per file for the life of the
 * cache — `mastersRead` is what makes that true across restarts.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { listExpiries } from '../backtest/dataLayer.ts';
import type { Underlying } from '../backtest/types.ts';
import { isMonthlyExpiry } from './optionNames.ts';
import type { DayStore } from './daySeries.ts';

const gunzipAsync = promisify(gunzip);

export interface ExpiryCalendar {
  /** YYYY-MM-DD, ascending, unique. */
  expiries: string[];
  /** Monthly-form flags learned by probing, which beat the "last in month" inference. */
  monthlyOverride: Record<string, boolean>;
  /** Master file names already folded in. */
  mastersRead: string[];
}

/** Weeklies are at most seven days apart, so a further "nearest" means a week is missing. */
export const MAX_EXPIRY_GAP_DAYS = 7;

export const MASTER_EXCHANGE: Record<string, string> = { NIFTY: 'NSE', SENSEX: 'BSE' };

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** The nearest expiry on or after `date`, or null when the calendar cannot vouch for it. */
export function nearestExpiry(cal: ExpiryCalendar, date: string): string | null {
  const e = cal.expiries.find((x) => x >= date);
  if (!e || daysBetween(date, e) > MAX_EXPIRY_GAP_DAYS) return null;
  return e;
}

export function isMonthly(cal: ExpiryCalendar, expiry: string): boolean {
  return cal.monthlyOverride[expiry] ?? isMonthlyExpiry(expiry, cal.expiries);
}

export function addExpiry(cal: ExpiryCalendar, expiry: string, monthly?: boolean): void {
  if (!cal.expiries.includes(expiry)) {
    cal.expiries.push(expiry);
    cal.expiries.sort();
  }
  if (monthly !== undefined) cal.monthlyOverride[expiry] = monthly;
}

function calendarFile(store: DayStore, underlying: string): string {
  return path.join(store.dir(underlying), 'calendar.json');
}

export async function saveCalendar(
  store: DayStore,
  underlying: string,
  cal: ExpiryCalendar,
): Promise<void> {
  const file = calendarFile(store, underlying);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cal));
  await fs.rename(tmp, file);
}

function toIso(yyyymmdd: unknown): string | null {
  const s = String(yyyymmdd ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

export async function loadCalendar(
  store: DayStore,
  underlying: Underlying,
  masterDirs: string[],
  log: (msg: string) => void = () => {},
): Promise<ExpiryCalendar> {
  let cal: ExpiryCalendar = { expiries: [], monthlyOverride: {}, mastersRead: [] };
  try {
    cal = JSON.parse(await fs.readFile(calendarFile(store, underlying), 'utf8')) as ExpiryCalendar;
  } catch {
    /* first run */
  }
  let changed = false;

  // No NSE/BSE contract expires on a weekend, but the local tree has a folder named 2026-05-02 (a
  // Saturday). Trusting it named every 04-29/04-30 option wrongly, so each one 404'd on Nubra.
  const weekend = (iso: string) => [0, 6].includes(new Date(`${iso}T00:00:00Z`).getUTCDay());
  const weekday = cal.expiries.filter((e) => !weekend(e));
  if (weekday.length !== cal.expiries.length) {
    log(`[analysis calendar] dropped weekend expiries ${cal.expiries.filter(weekend).join(', ')}`);
    cal.expiries = weekday;
    changed = true;
  }

  const local = new Set([
    ...(await listExpiries(underlying, 'WEEK')),
    ...(await listExpiries(underlying, 'MONTH')),
  ]);
  for (const e of local) {
    if (weekend(e)) continue;
    if (!cal.expiries.includes(e)) {
      addExpiry(cal, e);
      changed = true;
    }
  }

  const prefix = `${MASTER_EXCHANGE[underlying] ?? 'NSE'}_`;
  for (const dir of masterDirs) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.startsWith(prefix) && n.endsWith('.json.gz'));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (cal.mastersRead.includes(name)) continue;
      try {
        const raw = JSON.parse(
          (await gunzipAsync(await fs.readFile(path.join(dir, name)))).toString('utf8'),
        ) as unknown;
        const rows = (Array.isArray(raw) ? raw : []) as Record<string, unknown>[];
        let added = 0;
        for (const r of rows) {
          if (r.asset !== underlying || r.derivative_type !== 'OPT') continue;
          const iso = toIso(r.expiry);
          if (iso && !cal.expiries.includes(iso)) {
            addExpiry(cal, iso);
            added++;
          }
        }
        cal.mastersRead.push(name);
        changed = true;
        log(`[analysis calendar] ${name}: +${added} ${underlying} expiries`);
      } catch (e) {
        log(`[analysis calendar] skipped unreadable master ${name}: ${(e as Error).message}`);
      }
    }
  }

  if (changed) await saveCalendar(store, underlying, cal);
  return cal;
}
