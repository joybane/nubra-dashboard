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

// pnl ticks are buffered and written a second at a time; closeDb is what saves the tail on shutdown.
test('pnl ticks reach disk on the timed flush and on close, unchanged and in order', async () => {
  vi.useFakeTimers();
  try {
    const { initDb, dbInsertPnlTick, closeDb } = await loadDb();
    initDb();
    const tick = (ts: number) => ({
      ts,
      ref_id: 101,
      ltp: 10_000 + ts,
      qty: 65,
      avg_price: 9_000,
      unrealized_pnl: 1,
      realized_pnl: 2,
      total_pnl: 3,
    });
    const count = () => {
      const reader = registerHandle(new Database(dbPath, { readonly: true }));
      const n = (reader.prepare('SELECT COUNT(*) AS n FROM pnl_ticks').get() as { n: number }).n;
      reader.close();
      return n;
    };

    dbInsertPnlTick(tick(1));
    dbInsertPnlTick(tick(2));
    expect(count()).toBe(0); // still buffered
    vi.advanceTimersByTime(1_000);
    expect(count()).toBe(2);

    dbInsertPnlTick(tick(3));
    closeDb();
    closeDb(); // idempotent: the exit hook calls it again after a signal already did

    const reader = registerHandle(new Database(dbPath, { readonly: true }));
    const rows = reader.prepare('SELECT ts, ltp FROM pnl_ticks ORDER BY id').all();
    expect(rows).toEqual([
      { ts: 1, ltp: 10_001 },
      { ts: 2, ltp: 10_002 },
      { ts: 3, ltp: 10_003 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

function seedPnlTicks(file: string, stamps: number[]): void {
  const raw = new Database(file);
  try {
    const ins = raw.prepare(
      `INSERT INTO pnl_ticks (ts, ref_id, ltp, qty, avg_price, unrealized_pnl, realized_pnl, total_pnl)
       VALUES (?, 101, ?, 65, 9000, 1, 2, 3)`,
    );
    raw.transaction(() => stamps.forEach((ts) => ins.run(ts, ts)))();
  } finally {
    raw.close();
  }
}

function pnlRows(file: string): Array<{ id: number; ts: number; ltp: number }> {
  const raw = new Database(file, { readonly: true });
  try {
    return raw.prepare('SELECT id, ts, ltp FROM pnl_ticks ORDER BY id').all() as never;
  } finally {
    raw.close();
  }
}

test('archiving moves old pnl ticks, ids and values intact, and is a no-op the second time', async () => {
  const { initDb, closeDb, dbArchivePnlTicks, PNL_ARCHIVE_PATH } = await loadDb();
  initDb();
  seedPnlTicks(dbPath, [100, 200, 300, 400]);

  expect(dbArchivePnlTicks(250)).toMatchObject({ moved: 2, vacuumed: false });
  expect(dbArchivePnlTicks(250).moved).toBe(0);
  closeDb();

  expect(pnlRows(dbPath)).toEqual([
    { id: 3, ts: 300, ltp: 300 },
    { id: 4, ts: 400, ltp: 400 },
  ]);
  expect(pnlRows(PNL_ARCHIVE_PATH)).toEqual([
    { id: 1, ts: 100, ltp: 100 },
    { id: 2, ts: 200, ltp: 200 },
  ]);
});

test('archiving after a crash between copy and delete neither duplicates nor loses rows', async () => {
  const { initDb, closeDb, dbArchivePnlTicks, PNL_ARCHIVE_PATH } = await loadDb();
  initDb();
  seedPnlTicks(dbPath, [100, 200, 300]);
  dbArchivePnlTicks(150); // archives id 1 and creates the archive file
  // Now simulate a run that crashed after committing its copy of id 2 but before the delete.
  const raw = new Database(PNL_ARCHIVE_PATH);
  raw.prepare(`INSERT INTO pnl_ticks VALUES (2, 200, 101, 200, 65, 9000, 1, 2, 3)`).run();
  raw.close();

  expect(dbArchivePnlTicks(250).moved).toBe(1);
  closeDb();
  expect(pnlRows(dbPath).map((r) => r.id)).toEqual([3]);
  expect(pnlRows(PNL_ARCHIVE_PATH).map((r) => r.id)).toEqual([1, 2]);
});

test('the startup run vacuums once enough of paper.db is free, and the file shrinks', async () => {
  const { initDb, closeDb, dbArchivePnlTicks } = await loadDb();
  initDb();
  seedPnlTicks(
    dbPath,
    Array.from({ length: 50_000 }, (_, i) => i + 1),
  );
  const before = dbArchivePnlTicks(0).bytesAfter; // nothing is older than 0

  const run = dbArchivePnlTicks(Number.MAX_SAFE_INTEGER, { vacuumOverBytes: 1024 * 1024 });
  closeDb();
  expect(run.moved).toBe(50_000);
  expect(run.vacuumed).toBe(true);
  expect(run.bytesAfter).toBeLessThan(before / 4);
});
