import Database from 'better-sqlite3';

const db = new Database('paper.db');
console.log('Querying paper.db for refdata of NIFTY 24350 CE on 28 Jul 26...');

// Let's search the name_map or other records to see if the instrument exists.
const rows = db.prepare("SELECT * FROM name_map WHERE name LIKE '%nifty2672824350ce%' OR name LIKE '%nifty28jul24350ce%'").all();
console.log('Matches:', rows);
