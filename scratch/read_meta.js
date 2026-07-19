import Database from 'better-sqlite3';
const db = new Database('paper.db');
console.log('meta contents:', db.prepare('SELECT * FROM meta').all());
