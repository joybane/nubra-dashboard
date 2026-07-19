import Database from 'better-sqlite3';
const db = new Database('paper.db');
console.log('name_map contents:', db.prepare('SELECT * FROM name_map').all());
