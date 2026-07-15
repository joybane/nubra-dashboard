import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = path.join(import.meta.dirname ?? __dirname, '..', 'paper.db');

let db: Database.Database;

export function initDb(): Database.Database {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id            INTEGER PRIMARY KEY,
      ref_id              INTEGER NOT NULL,
      nubra_name          TEXT NOT NULL,
      display_name        TEXT NOT NULL,
      order_type          TEXT NOT NULL,
      order_side          TEXT NOT NULL,
      order_price         INTEGER NOT NULL DEFAULT 0,
      trigger_price       INTEGER NOT NULL DEFAULT 0,
      order_qty           INTEGER NOT NULL,
      filled_qty          INTEGER NOT NULL DEFAULT 0,
      avg_filled_price    INTEGER NOT NULL DEFAULT 0,
      order_status        TEXT NOT NULL,
      order_time          INTEGER NOT NULL,
      filled_time         INTEGER,
      order_delivery_type TEXT NOT NULL,
      validity_type       TEXT NOT NULL DEFAULT 'DAY',
      tag                 TEXT,
      sl_triggered        INTEGER NOT NULL DEFAULT 0,
      basket_group_id     TEXT,
      strategy_name       TEXT
    );

    CREATE TABLE IF NOT EXISTS fills (
      fill_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL,
      ref_id     INTEGER NOT NULL,
      fill_price INTEGER NOT NULL,
      fill_qty   INTEGER NOT NULL,
      fill_time  INTEGER NOT NULL,
      side       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS positions (
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
      PRIMARY KEY (ref_id, basket_group_id)
    );

    CREATE TABLE IF NOT EXISTS pnl_ticks (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ts               INTEGER NOT NULL,
      ref_id           INTEGER NOT NULL,
      ltp              INTEGER NOT NULL,
      qty              INTEGER NOT NULL,
      avg_price        INTEGER NOT NULL,
      unrealized_pnl   INTEGER NOT NULL,
      realized_pnl     INTEGER NOT NULL,
      total_pnl        INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS name_map (
      name   TEXT PRIMARY KEY,
      ref_id INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_baskets (
      basket_id   TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      expiry      TEXT NOT NULL,
      legs_json   TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oc_subs (
      key TEXT PRIMARY KEY
    );

    -- Frozen snapshots of a strategy's day: everything needed to re-render the Strategy
    -- Analysis chart (underlying candles, leg prices, P&L curves, greeks) as JSON, so the
    -- chart survives after the option historical API rolls those contracts off.
    CREATE TABLE IF NOT EXISTS saved_strategies (
      snapshot_id      TEXT PRIMARY KEY,
      basket_group_id  TEXT NOT NULL,
      strategy_name    TEXT,
      underlying       TEXT,
      trade_date       TEXT NOT NULL,
      total_pnl        INTEGER NOT NULL DEFAULT 0,
      leg_count        INTEGER NOT NULL DEFAULT 0,
      source           TEXT NOT NULL DEFAULT 'manual',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      data_json        TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_basket_date ON saved_strategies(basket_group_id, trade_date);

    CREATE INDEX IF NOT EXISTS idx_pnl_ref_ts ON pnl_ticks(ref_id, ts);
    CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(order_status);
  `);

  // ── Migrations: add basket_group_id / strategy_name to existing tables ───
  const cols = (table: string) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
  };
  const orderCols = cols('orders');
  if (!orderCols.has('basket_group_id')) db.exec(`ALTER TABLE orders ADD COLUMN basket_group_id TEXT`);
  if (!orderCols.has('strategy_name'))   db.exec(`ALTER TABLE orders ADD COLUMN strategy_name TEXT`);
  if (!orderCols.has('margin_required')) db.exec(`ALTER TABLE orders ADD COLUMN margin_required INTEGER`);

  // Positions table migration: old schema had PRIMARY KEY (ref_id) only.
  // If basket_group_id column is missing, recreate the table with composite key.
  const posCols = cols('positions');
  if (!posCols.has('basket_group_id')) {
    db.exec(`
      ALTER TABLE positions RENAME TO positions_old;
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
        PRIMARY KEY (ref_id, basket_group_id)
      );
      INSERT INTO positions SELECT ref_id, nubra_name, display_name, qty, avg_price,
        realized_pnl, last_traded_price, order_delivery_type, '', NULL FROM positions_old;
      DROP TABLE positions_old;
    `);
  }

  // Add entry_time, exit_time, exit_price columns to positions if missing
  const posCols2 = cols('positions');
  if (!posCols2.has('entry_time'))       db.exec(`ALTER TABLE positions ADD COLUMN entry_time INTEGER`);
  if (!posCols2.has('exit_time'))        db.exec(`ALTER TABLE positions ADD COLUMN exit_time INTEGER`);
  if (!posCols2.has('exit_price'))       db.exec(`ALTER TABLE positions ADD COLUMN exit_price INTEGER`);
  if (!posCols2.has('margin_required'))  db.exec(`ALTER TABLE positions ADD COLUMN margin_required INTEGER`);

  const basketCols = cols('saved_baskets');
  if (!basketCols.has('basket_group_id')) db.exec(`ALTER TABLE saved_baskets ADD COLUMN basket_group_id TEXT`);

  console.log(`[PaperDB] Opened ${DB_PATH}`);
  return db;
}

// ── Orders ──────────────────────────────────────────────────────────────────

let _stmtInsertOrder: ReturnType<typeof db.prepare> | null = null;
const _insertOrder = () => _stmtInsertOrder ??= db.prepare(`
  INSERT INTO orders (order_id, ref_id, nubra_name, display_name, order_type, order_side,
    order_price, trigger_price, order_qty, filled_qty, avg_filled_price, order_status,
    order_time, filled_time, order_delivery_type, validity_type, tag, sl_triggered,
    basket_group_id, strategy_name, margin_required)
  VALUES (@order_id, @ref_id, @nubra_name, @display_name, @order_type, @order_side,
    @order_price, @trigger_price, @order_qty, @filled_qty, @avg_filled_price, @order_status,
    @order_time, @filled_time, @order_delivery_type, @validity_type, @tag, @sl_triggered,
    @basket_group_id, @strategy_name, @margin_required)
`);

let _stmtUpdateOrder: ReturnType<typeof db.prepare> | null = null;
const _updateOrder = () => _stmtUpdateOrder ??= db.prepare(`
  UPDATE orders SET filled_qty=@filled_qty, avg_filled_price=@avg_filled_price,
    order_status=@order_status, filled_time=@filled_time, sl_triggered=@sl_triggered
  WHERE order_id=@order_id
`);

export function dbInsertOrder(o: {
  order_id: number; ref_id: number; nubraName: string; display_name: string;
  order_type: string; order_side: string; order_price: number; trigger_price: number;
  order_qty: number; filled_qty: number; avg_filled_price: number; order_status: string;
  order_time: number; filled_time: number | null; order_delivery_type: string;
  validity_type: string; tag?: string; sl_triggered: boolean;
  basket_group_id?: string; strategy_name?: string; margin_required?: number;
}): void {
  _insertOrder().run({
    order_id: o.order_id, ref_id: o.ref_id, nubra_name: o.nubraName,
    display_name: o.display_name, order_type: o.order_type, order_side: o.order_side,
    order_price: o.order_price, trigger_price: o.trigger_price, order_qty: o.order_qty,
    filled_qty: o.filled_qty, avg_filled_price: o.avg_filled_price,
    order_status: o.order_status, order_time: o.order_time, filled_time: o.filled_time,
    order_delivery_type: o.order_delivery_type, validity_type: o.validity_type,
    tag: o.tag ?? null, sl_triggered: o.sl_triggered ? 1 : 0,
    basket_group_id: o.basket_group_id ?? null, strategy_name: o.strategy_name ?? null,
    margin_required: o.margin_required ?? null,
  });
}

export function dbUpdateOrder(o: {
  order_id: number; filled_qty: number; avg_filled_price: number;
  order_status: string; filled_time: number | null; sl_triggered: boolean;
}): void {
  _updateOrder().run({
    order_id: o.order_id, filled_qty: o.filled_qty, avg_filled_price: o.avg_filled_price,
    order_status: o.order_status, filled_time: o.filled_time, sl_triggered: o.sl_triggered ? 1 : 0,
  });
}

export function dbLoadOrders(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM orders ORDER BY order_time DESC').all() as Array<Record<string, unknown>>;
}

// ── Fills ───────────────────────────────────────────────────────────────────

export function dbInsertFill(f: {
  order_id: number; ref_id: number; fill_price: number;
  fill_qty: number; fill_time: number; side: string;
}): void {
  db.prepare(`INSERT INTO fills (order_id, ref_id, fill_price, fill_qty, fill_time, side)
    VALUES (@order_id, @ref_id, @fill_price, @fill_qty, @fill_time, @side)`).run(f);
}

// ── Positions ───────────────────────────────────────────────────────────────

export function dbUpsertPosition(p: {
  ref_id: number; nubraName: string; display_name: string; qty: number;
  avg_price: number; realized_pnl: number; last_traded_price: number;
  order_delivery_type: string; basket_group_id?: string; strategy_name?: string;
  entry_time?: number; exit_time?: number; exit_price?: number; margin_required?: number;
}): void {
  db.prepare(`INSERT INTO positions (ref_id, nubra_name, display_name, qty, avg_price,
      realized_pnl, last_traded_price, order_delivery_type, basket_group_id, strategy_name,
      entry_time, exit_time, exit_price, margin_required)
    VALUES (@ref_id, @nubra_name, @display_name, @qty, @avg_price,
      @realized_pnl, @last_traded_price, @order_delivery_type, @basket_group_id, @strategy_name,
      @entry_time, @exit_time, @exit_price, @margin_required)
    ON CONFLICT(ref_id, basket_group_id) DO UPDATE SET
      qty=@qty, avg_price=@avg_price, realized_pnl=@realized_pnl,
      last_traded_price=@last_traded_price, display_name=@display_name,
      exit_time=@exit_time, exit_price=@exit_price,
      margin_required=COALESCE(@margin_required, margin_required)
  `).run({
    ref_id: p.ref_id, nubra_name: p.nubraName, display_name: p.display_name,
    qty: p.qty, avg_price: p.avg_price, realized_pnl: p.realized_pnl,
    last_traded_price: p.last_traded_price, order_delivery_type: p.order_delivery_type,
    basket_group_id: p.basket_group_id ?? '', strategy_name: p.strategy_name ?? null,
    entry_time: p.entry_time ?? null, exit_time: p.exit_time ?? null, exit_price: p.exit_price ?? null,
    margin_required: p.margin_required ?? null,
  });
}

export function dbLoadPositions(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM positions WHERE qty != 0').all() as Array<Record<string, unknown>>;
}

export function dbLoadClosedPositions(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM positions WHERE qty = 0 AND realized_pnl != 0').all() as Array<Record<string, unknown>>;
}

// ── PnL Ticks ───────────────────────────────────────────────────────────────

export function dbInsertPnlTick(t: {
  ts: number; ref_id: number; ltp: number; qty: number;
  avg_price: number; unrealized_pnl: number; realized_pnl: number; total_pnl: number;
}): void {
  db.prepare(`INSERT INTO pnl_ticks (ts, ref_id, ltp, qty, avg_price,
    unrealized_pnl, realized_pnl, total_pnl)
    VALUES (@ts, @ref_id, @ltp, @qty, @avg_price,
    @unrealized_pnl, @realized_pnl, @total_pnl)`).run(t);
}

// ── Name Map ────────────────────────────────────────────────────────────────

export function dbUpsertName(name: string, refId: number): void {
  db.prepare('INSERT OR REPLACE INTO name_map (name, ref_id) VALUES (?, ?)').run(name, refId);
}

export function dbLoadNameMap(): Map<string, number> {
  const rows = db.prepare('SELECT name, ref_id FROM name_map').all() as Array<{ name: string; ref_id: number }>;
  return new Map(rows.map(r => [r.name, r.ref_id]));
}

// ── OC Subscriptions ───────────────────────────────────────────────────────

export function dbUpsertOcSub(key: string): void {
  db.prepare('INSERT OR IGNORE INTO oc_subs (key) VALUES (?)').run(key);
}

export function dbLoadOcSubs(): string[] {
  return (db.prepare('SELECT key FROM oc_subs').all() as Array<{ key: string }>).map(r => r.key);
}

// ── Meta ────────────────────────────────────────────────────────────────────

export function dbGetMeta(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function dbSetMeta(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

// ── Saved Baskets ──────────────────────────────────────────────────────────

export function dbInsertBasket(b: {
  basket_id: string; name: string; symbol: string; expiry: string;
  legs_json: string; created_at: number; updated_at: number; basket_group_id?: string;
}): void {
  db.prepare(`INSERT INTO saved_baskets (basket_id, name, symbol, expiry, legs_json, created_at, updated_at, basket_group_id)
    VALUES (@basket_id, @name, @symbol, @expiry, @legs_json, @created_at, @updated_at, @basket_group_id)`).run({
    ...b, basket_group_id: b.basket_group_id ?? null,
  });
}

export function dbLoadBaskets(): Array<{
  basket_id: string; name: string; symbol: string; expiry: string;
  legs_json: string; created_at: number; updated_at: number; basket_group_id: string | null;
}> {
  return db.prepare('SELECT * FROM saved_baskets ORDER BY updated_at DESC').all() as Array<{
    basket_id: string; name: string; symbol: string; expiry: string;
    legs_json: string; created_at: number; updated_at: number; basket_group_id: string | null;
  }>;
}

export function dbDeleteBasket(basketId: string): boolean {
  const info = db.prepare('DELETE FROM saved_baskets WHERE basket_id = ?').run(basketId);
  return info.changes > 0;
}

export function dbUpdateBasket(basketId: string, name: string, legsJson: string): boolean {
  const info = db.prepare(`UPDATE saved_baskets SET name = ?, legs_json = ?, updated_at = ? WHERE basket_id = ?`)
    .run(name, legsJson, Date.now(), basketId);
  return info.changes > 0;
}

export function dbRenameStrategy(basketGroupId: string, newName: string): void {
  db.prepare('UPDATE orders SET strategy_name = ? WHERE basket_group_id = ?').run(newName, basketGroupId);
  db.prepare('UPDATE positions SET strategy_name = ? WHERE basket_group_id = ?').run(newName, basketGroupId);
  db.prepare('UPDATE saved_baskets SET name = ?, updated_at = ? WHERE basket_group_id = ?').run(newName, Date.now(), basketGroupId);
}

// ── Saved Strategy Snapshots ─────────────────────────────────────────────────

export interface SnapshotMeta {
  snapshot_id: string; basket_group_id: string; strategy_name: string | null;
  underlying: string | null; trade_date: string; total_pnl: number;
  leg_count: number; source: string; created_at: number; updated_at: number;
}

// Upsert keyed on snapshot_id (deterministic = basket_group_id + trade_date), so re-saving the
// same strategy-day overwrites in place and preserves the original created_at.
export function dbUpsertSnapshot(s: {
  snapshot_id: string; basket_group_id: string; strategy_name?: string | null;
  underlying?: string | null; trade_date: string; total_pnl: number;
  leg_count: number; source: string; data_json: string;
}): void {
  const now = Date.now();
  db.prepare(`INSERT INTO saved_strategies
      (snapshot_id, basket_group_id, strategy_name, underlying, trade_date,
       total_pnl, leg_count, source, created_at, updated_at, data_json)
    VALUES (@snapshot_id, @basket_group_id, @strategy_name, @underlying, @trade_date,
       @total_pnl, @leg_count, @source, @now, @now, @data_json)
    ON CONFLICT(snapshot_id) DO UPDATE SET
      strategy_name=@strategy_name, underlying=@underlying, total_pnl=@total_pnl,
      leg_count=@leg_count, source=@source, updated_at=@now, data_json=@data_json
  `).run({
    snapshot_id: s.snapshot_id, basket_group_id: s.basket_group_id,
    strategy_name: s.strategy_name ?? null, underlying: s.underlying ?? null,
    trade_date: s.trade_date, total_pnl: Math.round(s.total_pnl), leg_count: s.leg_count,
    source: s.source, now, data_json: s.data_json,
  });
}

export function dbListSnapshots(): SnapshotMeta[] {
  return db.prepare(`SELECT snapshot_id, basket_group_id, strategy_name, underlying, trade_date,
    total_pnl, leg_count, source, created_at, updated_at
    FROM saved_strategies ORDER BY trade_date DESC, updated_at DESC`).all() as SnapshotMeta[];
}

export function dbGetSnapshot(id: string): (SnapshotMeta & { data_json: string }) | undefined {
  return db.prepare('SELECT * FROM saved_strategies WHERE snapshot_id = ?').get(id) as
    (SnapshotMeta & { data_json: string }) | undefined;
}

export function dbDeleteSnapshot(id: string): boolean {
  return db.prepare('DELETE FROM saved_strategies WHERE snapshot_id = ?').run(id).changes > 0;
}

export function dbSnapshotExists(basketGroupId: string, tradeDate: string): boolean {
  const row = db.prepare('SELECT 1 FROM saved_strategies WHERE basket_group_id = ? AND trade_date = ?')
    .get(basketGroupId, tradeDate);
  return row != null;
}

export function dbRenameSavedBasket(basketId: string, newName: string): { basket_group_id: string | null } {
  const row = db.prepare('SELECT basket_group_id FROM saved_baskets WHERE basket_id = ?').get(basketId) as { basket_group_id: string | null } | undefined;
  db.prepare('UPDATE saved_baskets SET name = ?, updated_at = ? WHERE basket_id = ?').run(newName, Date.now(), basketId);
  const bgId = row?.basket_group_id || null;
  if (bgId) {
    db.prepare('UPDATE orders SET strategy_name = ? WHERE basket_group_id = ?').run(newName, bgId);
    db.prepare('UPDATE positions SET strategy_name = ? WHERE basket_group_id = ?').run(newName, bgId);
  }
  return { basket_group_id: bgId };
}
