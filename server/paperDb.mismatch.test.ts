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

test('versions reload in saved order; coverage only moves forward; prune drops and renumbers', async () => {
  const mod = await import('./paperDb.ts');
  handle = mod.initDb();
  const T1 = Date.parse('2026-09-24T03:47:00Z') * 1_000_000;
  const row = (case_no: number, t2Min: number, gap: number) => ({
    basket_group_id: 'bg_1',
    case_no,
    color_idx: case_no - 1,
    t1_ns: T1,
    t2_ns: T1 + t2Min * 60e9,
    spot1: 1,
    spot2: 1,
    ce1: 1,
    ce2: 1,
    pe1: 1,
    pe2: 1,
    ce_delta: 1,
    pe_delta: 1,
    gap,
  });
  // A stronger reading saved last with an EARLIER t2 is still the case's latest version.
  mod.dbInsertMismatchVersion(row(1, 45, 692.25));
  mod.dbInsertMismatchVersion(row(1, 41, 705.25));
  mod.dbInsertMismatchVersion(row(3, 50, 10));
  mod.dbInsertMismatchVersion(row(4, 60, 20));
  expect(mod.dbListMismatchVersions('bg_1').map((r) => r.gap)).toEqual([692.25, 705.25, 10, 20]);

  expect(mod.dbGetMismatchCoverage('bg_1')).toBeNull();
  mod.dbSetMismatchCoverage('bg_1', 2000);
  mod.dbSetMismatchCoverage('bg_1', 1000);
  expect(mod.dbGetMismatchCoverage('bg_1')).toBe(2000);

  const [, , third] = mod.dbListMismatchVersions('bg_1');
  mod.dbPruneMismatchVersions(
    'bg_1',
    [third.id!],
    [
      [1, 1],
      [4, 2],
    ],
  );
  expect(mod.dbListMismatchVersions('bg_1').map((r) => [r.case_no, r.color_idx, r.gap])).toEqual([
    [1, 0, 692.25],
    [1, 0, 705.25],
    [2, 1, 20],
  ]);
});
