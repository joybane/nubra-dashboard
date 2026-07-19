import Database from 'better-sqlite3';
const db = new Database('paper.db');
console.log('Saved strategies:', db.prepare('SELECT * FROM saved_strategies').all());
