import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createDayStore, emptyGrid, type DaySeries, type DayStore } from '../analysis/daySeries.ts';
import { nseOptionSymbol } from '../analysis/optionNames.ts';
import {
  createWideStore,
  createWideSync,
  fetchWideDay,
  wideOhlcSource,
  wideStrikes,
  type WideStore,
} from './wideSource.ts';

const DATE = '2026-01-05';
const EXPIRY = '2026-01-06';

function nubraDay(date = DATE): DaySeries {
  const spot = emptyGrid().map(() => 23250);
  return {
    v: 1,
    underlying: 'NIFTY',
    date,
    source: 'nubra',
    expiry: EXPIRY,
    monthly: false,
    spot,
    ce: { '23350': emptyGrid().map(() => 60) },
    pe: { '23150': emptyGrid().map(() => 55) },
  };
}

/** Nanosecond timestamp of an IST minute on DATE, as Nubra sends it. */
const ns = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return String(BigInt(Date.UTC(2026, 0, 5, h, m) - 19800000) * 1000000n);
};

/** A fake charts/timeseries: every symbol trades at a flat paise price, except unlisted ones. */
function fakePost(unlisted: Set<string>, calls: string[][]) {
  return async (b: object) => {
    const syms = (b as { query: Array<{ values: string[] }> }).query.map((q) => q.values[0]);
    calls.push(syms);
    if (syms.some((s) => unlisted.has(s))) throw new Error('unexpected status 404');
    const pt = (v: number) => [{ ts: ns('09:46'), v }];
    return {
      result: [
        {
          values: syms.map((s) => ({
            [s]: { open: pt(1000), high: pt(1200), low: pt(900), close: pt(1100) },
          })),
        },
      ],
    };
  };
}

const noPace = async () => {};

describe('wideStrikes', () => {
  test('ten strikes out of the money beyond the day range, three in the money', () => {
    const w = wideStrikes(nubraDay().spot, 50)!;
    expect(w.ce[0]).toBe(23100);
    expect(w.ce.at(-1)).toBe(23750);
    expect(w.pe[0]).toBe(22750);
    expect(w.pe.at(-1)).toBe(23400);
  });
});

describe('fetchWideDay', () => {
  test('stores open/high/low/close in rupees; an unlisted strike does not blank its batch', async () => {
    const bad = nseOptionSymbol('NIFTY', EXPIRY, 23750, 'CE', false);
    const calls: string[][] = [];
    const wide = await fetchWideDay(
      { post: fakePost(new Set([bad]), calls), pace: noPace },
      nubraDay(),
    );
    expect(wide).not.toBeNull();
    const src = wideOhlcSource(wide!);
    const s = src.series('CE', 23700)!;
    const i = 31; // 09:46
    expect([s.o[i], s.h[i], s.l[i], s.c[i]]).toEqual([10, 12, 9, 11]);
    expect(src.series('CE', 23750)).toBeNull();
    expect(src.strikes('CE')).toHaveLength(13); // 14 asked, one unlisted
    expect(src.strikes('PE')).toHaveLength(14);
    // Batches are at most 10 names; the failed batch was retried name by name.
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(10);
    expect(calls.some((c) => c.length === 1 && c[0] === bad)).toBe(true);
  });

  test('an outage (every request failing) is null, not an empty day', async () => {
    const wide = await fetchWideDay(
      {
        post: async () => {
          throw new Error('unexpected status 404');
        },
        pace: noPace,
      },
      nubraDay(),
    );
    expect(wide).toBeNull();
  });
});

describe('createWideSync', () => {
  let dir: string;
  let analysis: DayStore;
  let wide: WideStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'signal-wide-'));
    analysis = createDayStore(path.join(dir, 'analysis'));
    wide = createWideStore(path.join(dir, 'signal'));
    await analysis.write(nubraDay('2026-01-05'));
    await analysis.write(nubraDay('2026-01-06'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('downloads Nubra days not yet stored, newest first, and skips them next time', async () => {
    const calls: string[][] = [];
    const sync = createWideSync({
      analysisStore: analysis,
      wideStore: wide,
      getPost: () => fakePost(new Set(), calls),
      minIntervalMs: 0,
    });
    expect(sync.start('NIFTY')).toBe(true);
    expect(sync.start('NIFTY')).toBe(false); // already running
    await sync.whenIdle();
    expect(sync.getState()).toMatchObject({ running: false, done: 2, total: 2, failed: 0 });
    expect(await wide.list('NIFTY')).toEqual(['2026-01-05', '2026-01-06']);
    expect((await wide.read('NIFTY', '2026-01-06'))?.expiry).toBe(EXPIRY);

    calls.length = 0;
    sync.start('NIFTY');
    await sync.whenIdle();
    expect(sync.getState()).toMatchObject({ done: 0, total: 0 });
    expect(calls).toEqual([]);
  });

  test('stops when the broker session is gone', async () => {
    const sync = createWideSync({ analysisStore: analysis, wideStore: wide, getPost: () => null });
    sync.start('NIFTY');
    await sync.whenIdle();
    expect(sync.getState().lastError).toMatch(/log in/);
    expect(await wide.list('NIFTY')).toEqual([]);
  });
});
