import { describe, expect, test } from 'vitest';
import { SESSION_BARS } from '../analysis/daySeries.ts';
import { createParquetOhlcLoader, type BucketColumns, type BucketPair } from './ohlc.ts';
import type { OhlcDayStore, StitchedDay } from './ohlcDayStore.ts';

/** Epoch seconds of an IST wall-clock time. */
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00Z`) / 1000 - 5.5 * 3600;

interface Row {
  ts: number;
  strike: number;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
}

const columns = (rows: Row[]): BucketColumns => {
  const f = (pick: (r: Row) => number | undefined) =>
    Float64Array.from(rows.map((r) => pick(r) ?? NaN));
  return {
    ts: f((r) => r.ts),
    open: f((r) => r.o),
    high: f((r) => r.h),
    low: f((r) => r.l),
    close: f((r) => r.c),
    strike: f((r) => r.strike),
  };
};

/** A tree of fake buckets: each entry is one ATM-offset folder with its call and put rows. */
function fakeTree(
  folders: Array<{ call?: Row[]; put?: Row[]; unreadable?: boolean }>,
  store?: OhlcDayStore,
) {
  const files = new Map<string, BucketColumns | null>();
  const pairs: BucketPair[] = folders.map((folder, i) => {
    const pair: BucketPair = { call: null, put: null };
    if (folder.call) {
      pair.call = `bucket${i}-call`;
      files.set(pair.call, folder.unreadable ? null : columns(folder.call));
    }
    if (folder.put) {
      pair.put = `bucket${i}-put`;
      files.set(pair.put, folder.unreadable ? null : columns(folder.put));
    }
    return pair;
  });
  const reads: string[] = [];
  const load = createParquetOhlcLoader({
    resolve: async () => ({ expiry: '2026-01-06', flag: 'WEEK' }),
    listBuckets: async () => pairs,
    store,
    readBucket: async (file) => {
      reads.push(file);
      return files.get(file) ?? null;
    },
  });
  return { load, reads };
}

const D = '2026-01-05';

describe('parquet OHLC loader', () => {
  test('regroups the ATM-relative buckets by absolute strike, calls and puts apart', () => {
    // The strike a bucket holds floats with spot: 23500 in the first minute, 23550 in the second.
    const { load } = fakeTree([
      {
        call: [
          { ts: ist(D, '09:15'), strike: 23500, o: 100, h: 104, l: 99, c: 101 },
          { ts: ist(D, '09:16'), strike: 23550, o: 70, h: 72, l: 68, c: 71 },
        ],
        put: [{ ts: ist(D, '09:15'), strike: 23500, o: 80, h: 81, l: 79, c: 80.5 }],
      },
      { call: [{ ts: ist(D, '09:16'), strike: 23500, o: 98, h: 99, l: 96, c: 97 }] },
    ]);
    return load('NIFTY', D, '2026-01-06').then((src) => {
      const ce = src!.series('CE', 23500)!;
      expect(ce.c[0]).toBe(101);
      expect(ce.c[1]).toBe(97); // the same strike, from the other bucket
      expect(ce.o[1]).toBe(98);
      expect(ce.h[0]).toBe(104);
      expect(ce.l[0]).toBe(99);
      expect(ce.c).toHaveLength(SESSION_BARS);
      expect(src!.series('CE', 23550)!.c[1]).toBe(71);
      expect(src!.series('PE', 23500)!.c[0]).toBe(80.5);
      // Calls and puts do not mix.
      expect(src!.series('PE', 23550)).toBeNull();
      expect(src!.strikes('CE')).toEqual([23500, 23550]);
      expect(src!.strikes('PE')).toEqual([23500]);
    });
  });

  test('takes only the asked date, by Indian date, from files that span the whole expiry', async () => {
    const { load } = fakeTree([
      {
        call: [
          { ts: ist('2026-01-02', '15:29'), strike: 23500, c: 1 },
          { ts: ist(D, '09:15'), strike: 23500, c: 2 },
          { ts: ist(D, '15:29'), strike: 23500, c: 3 },
          { ts: ist('2026-01-06', '09:15'), strike: 23500, c: 4 },
        ],
      },
    ]);
    const ce = (await load('NIFTY', D, '2026-01-06'))!.series('CE', 23500)!;
    expect(ce.c[0]).toBe(2);
    expect(ce.c[SESSION_BARS - 1]).toBe(3);
    expect(ce.c.filter((v) => v != null)).toHaveLength(2);
  });

  test('a strike seen only outside the session is listed but has no prices', async () => {
    const { load } = fakeTree([
      {
        call: [
          { ts: ist(D, '09:14'), strike: 23400, c: 5 },
          { ts: ist(D, '15:30'), strike: 23400, c: 6 },
        ],
      },
    ]);
    const src = (await load('NIFTY', D, '2026-01-06'))!;
    expect(src.strikes('CE')).toEqual([23400]);
    expect(src.series('CE', 23400)!.c.every((v) => v == null)).toBe(true);
  });

  test('two bars on one strike and minute: the first bucket’s stands, whole', async () => {
    const { load } = fakeTree([
      { call: [{ ts: ist(D, '09:20'), strike: 23500, o: 10, h: 12, l: 9, c: 11 }] },
      { call: [{ ts: ist(D, '09:20'), strike: 23500, o: 50, h: 52, l: 49, c: 51 }] },
    ]);
    const ce = (await load('NIFTY', D, '2026-01-06'))!.series('CE', 23500)!;
    expect([ce.o[5], ce.h[5], ce.l[5], ce.c[5]]).toEqual([10, 12, 9, 11]);
  });

  test('a missing field stays empty rather than becoming zero', async () => {
    const { load } = fakeTree([{ call: [{ ts: ist(D, '09:15'), strike: 23500, c: 7 }] }]);
    const ce = (await load('NIFTY', D, '2026-01-06'))!.series('CE', 23500)!;
    expect(ce.c[0]).toBe(7);
    expect(ce.o[0]).toBeNull();
    expect(ce.h[0]).toBeNull();
    expect(ce.l[0]).toBeNull();
  });

  test('null when nothing is held for the date, or the expiry is not the day’s own', async () => {
    const { load } = fakeTree([
      { call: [{ ts: ist('2026-01-02', '09:15'), strike: 23500, c: 1 }] },
    ]);
    expect(await load('NIFTY', D, '2026-01-06')).toBeNull();
    expect(await load('NIFTY', '2026-01-02', '2026-01-13')).toBeNull(); // resolves to Jan 6
    expect(await load('BANKNIFTY', '2026-01-02', '2026-01-06')).toBeNull();
  });

  test('an unreadable bucket is skipped; the rest of the day still stitches', async () => {
    const { load } = fakeTree([
      { call: [{ ts: ist(D, '09:15'), strike: 23500, c: 1 }], unreadable: true },
      { call: [{ ts: ist(D, '09:15'), strike: 23600, c: 2 }] },
    ]);
    const src = (await load('NIFTY', D, '2026-01-06'))!;
    expect(src.strikes('CE')).toEqual([23600]);
  });

  test('a file is decoded once however many days of its expiry are asked for', async () => {
    const { load, reads } = fakeTree([
      {
        call: [
          { ts: ist(D, '09:15'), strike: 23500, c: 1 },
          { ts: ist('2026-01-06', '09:15'), strike: 23500, c: 2 },
        ],
      },
    ]);
    const first = await load('NIFTY', D, '2026-01-06');
    const second = await load('NIFTY', '2026-01-06', '2026-01-06');
    expect(first!.series('CE', 23500)!.c[0]).toBe(1);
    expect(second!.series('CE', 23500)!.c[0]).toBe(2);
    expect(reads).toEqual(['bucket0-call']);
    // The same day twice is the same stitched day.
    expect(await load('NIFTY', D, '2026-01-06')).toBe(first);
  });
});

/** A store held in memory, remembering what was written. */
function memoryStore(failWrites = false) {
  const days = new Map<string, StitchedDay>();
  const store: OhlcDayStore = {
    read: async (u, date) => days.get(`${u}|${date}`) ?? null,
    write: async (u, date, day) => {
      if (failWrites) throw new Error('disk full');
      days.set(`${u}|${date}`, day);
    },
  };
  return { store, days };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('parquet OHLC loader with a day store', () => {
  const rows: Row[] = [
    { ts: ist(D, '09:15'), strike: 23500, o: 10, h: 12, l: 9, c: 11 },
    { ts: ist(D, '09:16'), strike: 23550, o: 20, h: 22, l: 19, c: 21 },
  ];

  test('a day read from the tree is kept, and a fresh loader then needs no parquet at all', async () => {
    const { store, days } = memoryStore();
    const first = fakeTree([{ call: rows, put: rows }], store);
    const a = (await first.load('NIFTY', D, '2026-01-06'))!;
    await tick();
    expect(days.size).toBe(1);
    expect(first.reads.length).toBe(2);

    // A new loader (a new run, or a restarted server) has no files to read.
    const second = fakeTree([{ call: rows, put: rows }], store);
    const b = (await second.load('NIFTY', D, '2026-01-06'))!;
    expect(second.reads).toEqual([]);
    for (const kind of ['CE', 'PE'] as const) {
      expect(b.strikes(kind)).toEqual(a.strikes(kind));
      for (const k of a.strikes(kind)) expect(b.series(kind, k)).toEqual(a.series(kind, k));
    }
  });

  test('a kept day for another expiry is not used', async () => {
    const { store, days } = memoryStore();
    days.set(`NIFTY|${D}`, {
      expiry: '2025-12-30',
      flag: 'WEEK',
      strikes: { CE: [1], PE: [] },
      blocks: { CE: [new Float64Array(4 * SESSION_BARS)], PE: [] },
    });
    const { load, reads } = fakeTree([{ call: rows }], store);
    const src = (await load('NIFTY', D, '2026-01-06'))!;
    expect(reads.length).toBe(1);
    expect(src.strikes('CE')).toEqual([23500, 23550]);
  });

  test('a day built while a file was unreadable is not kept, so mending the file takes effect', async () => {
    const { store, days } = memoryStore();
    const { load } = fakeTree(
      [{ call: rows, unreadable: true }, { call: [{ ts: ist(D, '09:15'), strike: 23600, c: 2 }] }],
      store,
    );
    const src = (await load('NIFTY', D, '2026-01-06'))!;
    await tick();
    expect(src.strikes('CE')).toEqual([23600]);
    expect(days.size).toBe(0);
  });

  test('a store that cannot write does not break the run', async () => {
    const { store } = memoryStore(true);
    const { load } = fakeTree([{ call: rows }], store);
    const src = await load('NIFTY', D, '2026-01-06');
    await tick();
    expect(src!.series('CE', 23500)!.c[0]).toBe(11);
  });

  test('a day with no prices is not kept', async () => {
    const { store, days } = memoryStore();
    const { load } = fakeTree(
      [{ call: [{ ts: ist('2026-01-02', '09:15'), strike: 1, c: 1 }] }],
      store,
    );
    expect(await load('NIFTY', D, '2026-01-06')).toBeNull();
    await tick();
    expect(days.size).toBe(0);
  });
});
