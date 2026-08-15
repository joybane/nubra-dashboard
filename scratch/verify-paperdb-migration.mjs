// Runs the app's real initDb() against a COPY of the live paper.db and reports what changed.
// Point PAPER_DB_PATH at the copy before running. Never run this against the real book.
import path from 'path';
import Database from 'better-sqlite3';

const target = process.env.PAPER_DB_PATH;
if (!target) throw new Error('set PAPER_DB_PATH to a COPY of paper.db');
if (path.resolve(target).endsWith(path.join('nubra-dashboard', 'paper.db')))
  throw new Error('refusing to run against the live paper.db');

function snapshot(label) {
  const db = new Database(target);
  const cols = db
    .prepare('PRAGMA table_info(positions)')
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const t of ['orders', 'positions', 'fills', 'saved_baskets', 'saved_strategies']) {
    try {
      counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    } catch {
      counts[t] = 'missing';
    }
  }
  const integrity = db.pragma('integrity_check', { simple: true });
  db.close();
  console.log(`\n-- ${label} --`);
  console.log('positions columns:', cols.join(', '));
  console.log('row counts:', JSON.stringify(counts));
  console.log('integrity_check:', integrity);
  return { cols, counts };
}

const before = snapshot('BEFORE migration');

const { initDb, dbLoadPositions, dbLoadClosedPositions, dbLoadOrders, dbLoadBaskets } =
  await import('../server/paperDb.ts');
initDb();

const after = snapshot('AFTER migration');

console.log('\ncolumns added:', after.cols.filter((c) => !before.cols.includes(c)).join(', ') || '(none)');
console.log('row counts unchanged:', JSON.stringify(before.counts) === JSON.stringify(after.counts));
console.log('open positions loaded:', dbLoadPositions().length);
console.log('closed positions loaded:', dbLoadClosedPositions().length);
console.log('orders loaded:', dbLoadOrders().length);
console.log('baskets loaded:', dbLoadBaskets().length);
const sample = dbLoadPositions()[0] ?? dbLoadClosedPositions()[0];
if (sample)
  console.log('sample row -> entry_qty:', sample.entry_qty, '| entry_time:', sample.entry_time);
