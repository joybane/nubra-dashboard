// The backdated_trades table against a scratch database, never the live paper.db.
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
let handle: Database.Database | null = null;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'paperdb-backdated-'));
  process.env.PAPER_DB_PATH = path.join(dir, 'paper.db');
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PAPER_DB_PATH;
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
  rmSync(dir, { recursive: true, force: true });
});

const ENTRY_NS = Date.parse('2026-09-15T03:55:30Z') * 1_000_000;

test('initDb leaves the schema alone; the table appears on first use and round-trips rows', async () => {
  const mod = await import('./paperDb.ts');
  handle = mod.initDb();
  const table = () =>
    handle!.prepare("SELECT name FROM sqlite_master WHERE name = 'backdated_trades'").get();
  expect(table()).toBeUndefined();

  mod.dbInsertBackdatedTrade({
    order_id: 7,
    ref_id: 101,
    basket_group_id: '',
    entry_time_ns: ENTRY_NS,
    entry_label: '09:25:30',
    price_source: 'close',
    exact: 1,
    fill_price: 8_450,
    symbol: 'NIFTY2691523350CE',
    exchange: 'NSE',
    instrument_type: 'OPT',
  });
  expect(table()).toBeDefined();

  const startOfDayNs = Date.parse('2026-09-14T18:30:00Z') * 1_000_000;
  expect(mod.dbListBackdatedTrades(startOfDayNs)).toEqual([
    expect.objectContaining({ order_id: 7, entry_label: '09:25:30', replayed_json: '{}' }),
  ]);
  expect(mod.dbListBackdatedTrades(ENTRY_NS + 1_000_000_000_000)).toEqual([]);

  mod.dbSetBackdatedReplayed(7, '{"101:":"{}"}');
  expect(mod.dbListBackdatedTrades(startOfDayNs)[0].replayed_json).toBe('{"101:":"{}"}');
});
