// Exercises the real DDL and the real migrations against a scratch database.
//
// The migration path is the riskiest part of this module — it runs unattended against a book that
// may hold months of trades — and it had no coverage at all. `PAPER_DB_PATH` exists so these run
// against a temp file instead of the live paper.db.
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
let dbPath: string;
/** Every handle opened by a test. Windows refuses to remove the directory while one is live. */
let open: Database.Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'paperdb-'));
  dbPath = path.join(dir, 'paper.db');
  process.env.PAPER_DB_PATH = dbPath;
  open = [];
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PAPER_DB_PATH;
  for (const handle of open) {
    try {
      handle.close();
    } catch {
      /* already closed */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Import fresh so the module-level `db` binds to this test's file. `vi.resetModules()` in
 * `beforeEach` is what makes the re-import re-evaluate rather than hand back the cached instance.
 */
async function loadDb() {
  const mod = await import('./paperDb.ts');
  return { ...mod, initDb: () => registerHandle(mod.initDb()) };
}

function registerHandle(handle: Database.Database): Database.Database {
  open.push(handle);
  return handle;
}

function columns(file: string, table: string): Set<string> {
  const raw = new Database(file);
  try {
    const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((r) => r.name));
  } finally {
    raw.close();
  }
}

test('creates every table the app reads on a fresh database', async () => {
  const { initDb } = await loadDb();
  initDb();

  expect(columns(dbPath, 'positions')).toContain('entry_qty');
  expect(columns(dbPath, 'orders')).toContain('margin_required');
  expect(columns(dbPath, 'saved_strategies')).toContain('data_json');
  expect(columns(dbPath, 'position_rules')).toContain('rule_json');
});

test('migrates a pre-entry_qty positions table without losing rows', async () => {
  // The shape the table had before entry_qty existed — every other column present.
  const seed = registerHandle(new Database(dbPath));
  seed.exec(`
    CREATE TABLE positions (
      ref_id              INTEGER NOT NULL,
      nubra_name          TEXT NOT NULL,
      display_name        TEXT NOT NULL,
      qty                 INTEGER NOT NULL,
      avg_price           INTEGER NOT NULL,
      realized_pnl        INTEGER NOT NULL DEFAULT 0,
      last_traded_price   INTEGER NOT NULL DEFAULT 0,
      order_delivery_type TEXT NOT NULL,
      basket_group_id     TEXT NOT NULL DEFAULT '',
      strategy_name       TEXT,
      entry_time          INTEGER,
      exit_time           INTEGER,
      exit_price          INTEGER,
      margin_required     INTEGER,
      PRIMARY KEY (ref_id, basket_group_id)
    );
    INSERT INTO positions VALUES
      (101, 'NIFTY_CE', 'NIFTY 24000 CE', 0, 10000, 6500, 10100,
       'ORDER_DELIVERY_TYPE_IDAY', 'bg_old', 'Legacy', 1, 2, 10100, 500);
  `);
  seed.close();

  const { initDb, dbLoadClosedPositions } = await loadDb();
  initDb();

  expect(columns(dbPath, 'positions')).toContain('entry_qty');
  const rows = dbLoadClosedPositions();
  expect(rows).toHaveLength(1);
  // Pre-existing rows keep NULL, which is what makes SimBroker fall back to deriving the size.
  expect(rows[0]).toMatchObject({ ref_id: 101, strategy_name: 'Legacy', entry_qty: null });
});

test('running the migrations twice is a no-op', async () => {
  const first = await loadDb();
  first.initDb();
  vi.resetModules();
  const second = await loadDb();
  expect(() => second.initDb()).not.toThrow();
  expect(columns(dbPath, 'positions')).toContain('entry_qty');
});

test('re-opening a closed position re-dates it instead of keeping the first entry', async () => {
  const { initDb, dbUpsertPosition, dbLoadPositions, dbLoadClosedPositions } = await loadDb();
  initDb();

  const base = {
    ref_id: 202,
    nubraName: 'NIFTY_PE',
    display_name: 'NIFTY 24000 PE',
    avg_price: 10_000,
    last_traded_price: 10_000,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    basket_group_id: 'bg_1',
  };

  dbUpsertPosition({ ...base, qty: 65, realized_pnl: 0, entry_time: 1_000, entry_qty: 65 });
  dbUpsertPosition({
    ...base,
    qty: 0,
    realized_pnl: 500,
    entry_time: 1_000,
    entry_qty: 65,
    exit_time: 2_000,
    exit_price: 10_100,
  });
  expect(dbLoadClosedPositions()[0]).toMatchObject({ entry_time: 1_000, entry_qty: 65 });

  // Same ref_id and basket, re-entered later and on the other side. Before the ON CONFLICT
  // clause updated these, the row stayed dated to the *first* entry — and the EOD snapshot
  // groups a strategy's trade date by exactly this column.
  dbUpsertPosition({ ...base, qty: -50, realized_pnl: 500, entry_time: 9_000, entry_qty: -50 });

  expect(dbLoadPositions()[0]).toMatchObject({
    ref_id: 202,
    qty: -50,
    entry_time: 9_000,
    entry_qty: -50,
  });
});

test('an amendment writes only price, trigger and quantity', async () => {
  const { initDb, dbInsertOrder, dbModifyOrder, dbLoadOrders } = await loadDb();
  initDb();

  dbInsertOrder({
    order_id: 1,
    ref_id: 303,
    nubraName: 'NIFTY_CE',
    display_name: 'NIFTY 24000 CE',
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_BUY',
    order_price: 900_000,
    trigger_price: 0,
    order_qty: 65,
    filled_qty: 0,
    avg_filled_price: 0,
    order_status: 'ORDER_STATUS_OPEN',
    order_time: 1_234,
    filled_time: null,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
    sl_triggered: false,
  });

  dbModifyOrder({ order_id: 1, order_price: 950_000, trigger_price: 0, order_qty: 130 });

  expect(dbLoadOrders()[0]).toMatchObject({
    order_id: 1,
    order_price: 950_000,
    order_qty: 130,
    // Untouched: the whole point of the narrow write is that an open order keeps its fill block.
    order_status: 'ORDER_STATUS_OPEN',
    filled_qty: 0,
    avg_filled_price: 0,
    order_time: 1_234,
  });
});
