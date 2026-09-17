// The mismatch tracker tables against a scratch database, never the live paper.db.
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let dir: string;
let handle: Database.Database | null = null;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'paperdb-mismatch-'));
  process.env.PAPER_DB_PATH = path.join(dir, 'paper.db');
  vi.resetModules();
});

afterEach(() => {
  delete process.env.PAPER_DB_PATH;
  try {
    handle?.close();
  } catch {
    /* already closed */
  }
  handle = null;
  rmSync(dir, { recursive: true, force: true });
});

test('initDb leaves the schema alone; trackers and versions round-trip once used', async () => {
  const mod = await import('./paperDb.ts');
  handle = mod.initDb();
  const table = (name: string) =>
    handle!.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(name);
  expect(table('mismatch_trackers')).toBeUndefined();
  expect(table('mismatch_versions')).toBeUndefined();

  mod.dbSetMismatchTracker('bg_1', true);
  mod.dbSetMismatchTracker('bg_2', true);
  mod.dbSetMismatchTracker('bg_1', false);
  expect(mod.dbListMismatchTrackers()).toEqual([
    { basket_group_id: 'bg_1', enabled: 0 },
    { basket_group_id: 'bg_2', enabled: 1 },
  ]);

  const T1 = Date.parse('2026-09-16T04:30:00Z') * 1_000_000;
  const version = (case_no: number, t2_ns: number, gap: number) => ({
    basket_group_id: 'bg_1',
    case_no,
    color_idx: case_no - 1,
    t1_ns: T1,
    t2_ns,
    spot1: 23226,
    spot2: 23226.5,
    ce1: 120,
    ce2: 103.3,
    pe1: 110,
    pe2: 116.25,
    ce_delta: 1085.5,
    pe_delta: -406.25,
    gap,
  });
  mod.dbInsertMismatchVersion(version(1, T1 + 3e12, 10));
  mod.dbInsertMismatchVersion(version(2, T1 + 5e12, 30));
  mod.dbInsertMismatchVersion(version(1, T1 + 4e12, 20));
  mod.dbInsertMismatchVersion({ ...version(1, T1 + 6e12, 5), basket_group_id: 'bg_9' });

  const rows = mod.dbListMismatchVersions('bg_1');
  expect(rows.map((r) => [r.case_no, r.gap])).toEqual([
    [1, 10],
    [1, 20],
    [2, 30],
  ]);
  expect(rows[0]).toMatchObject({ t1_ns: T1, spot2: 23226.5, pe_delta: -406.25 });
  expect(mod.dbListMismatchVersions()).toHaveLength(4);
});
