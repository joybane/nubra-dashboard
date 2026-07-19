import Database from 'better-sqlite3';
import path from 'path';

const db = new Database('paper.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables);

for (const t of tables) {
  try {
    const count = db.prepare(`SELECT count(*) as c FROM \`${t.name}\``).get();
    console.log(`Table ${t.name} count:`, count.c);
  } catch (e) {
    console.log(`Failed to get count for ${t.name}:`, e.message);
  }
}

try {
  const sample = db.prepare("SELECT * FROM name_map LIMIT 5").all();
  console.log('name_map sample:', sample);
} catch (e) {
  console.log('Failed name_map sample:', e.message);
}
