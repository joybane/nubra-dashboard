import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { runPaperBackup } from './paperBackup.ts';

let dir: string;
let src: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'paperbackup-'));
  src = new Database(path.join(dir, 'live.db'));
  src.pragma('journal_mode = WAL');
  src.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2), (3);');
});
afterEach(() => {
  src.close();
  rmSync(dir, { recursive: true, force: true });
});

const backups = () => path.join(dir, 'backups');
const copy = (dest: string) => src.backup(dest).then(() => undefined);

test('writes a readable, complete copy named for the day', async () => {
  const r = await runPaperBackup({ dir: backups(), dateKey: '2026-11-11', keep: 5, copy });
  expect(r.written).toBe(path.join(backups(), 'paper-2026-11-11.db'));
  const b = new Database(r.written!, { readonly: true });
  expect(b.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 3 });
  b.close();
  expect(existsSync(`${r.written}.partial`)).toBe(false);
});

test("does not overwrite a day's existing copy", async () => {
  await runPaperBackup({ dir: backups(), dateKey: '2026-11-11', keep: 5, copy });
  let called = false;
  const r = await runPaperBackup({
    dir: backups(),
    dateKey: '2026-11-11',
    keep: 5,
    copy: async () => {
      called = true;
    },
  });
  expect(r.written).toBeNull();
  expect(called).toBe(false);
});

test('keeps only the newest copies and leaves unrelated files alone', async () => {
  for (const d of ['2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) {
    await runPaperBackup({ dir: backups(), dateKey: d, keep: 99, copy });
  }
  writeFileSync(path.join(backups(), 'notes.txt'), 'keep me');
  const r = await runPaperBackup({ dir: backups(), dateKey: '2026-11-09', keep: 3, copy });
  expect(r.pruned.sort()).toEqual(['paper-2026-11-05.db', 'paper-2026-11-06.db']);
  expect(readdirSync(backups()).sort()).toEqual([
    'notes.txt',
    'paper-2026-11-07.db',
    'paper-2026-11-08.db',
    'paper-2026-11-09.db',
  ]);
});

test('a failed copy leaves no file under the real name', async () => {
  await expect(
    runPaperBackup({
      dir: backups(),
      dateKey: '2026-11-11',
      keep: 5,
      copy: async (dest) => {
        writeFileSync(dest, 'half');
        throw new Error('disk full');
      },
    }),
  ).rejects.toThrow('disk full');
  expect(existsSync(path.join(backups(), 'paper-2026-11-11.db'))).toBe(false);
});
