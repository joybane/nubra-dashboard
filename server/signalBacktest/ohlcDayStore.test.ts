import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  BLOCK,
  createOhlcDayStore,
  decodeDay,
  encodeDay,
  type StitchedDay,
} from './ohlcDayStore.ts';

const block = (seed: number) => {
  const b = new Float64Array(BLOCK).fill(NaN);
  b[0] = seed;
  b[374] = seed + 0.05;
  b[375 + 10] = seed + 2;
  b[3 * 375 + 374] = seed + 1.35;
  return b;
};

const day = (): StitchedDay => ({
  expiry: '2026-01-06',
  flag: 'WEEK',
  strikes: { CE: [23500, 23550, 23600], PE: [23400] },
  blocks: { CE: [block(1), block(2), block(3)], PE: [block(9)] },
});

describe('encodeDay / decodeDay', () => {
  test('round-trips the strikes, their order and every value, empty minutes included', () => {
    const back = decodeDay(encodeDay(day()))!;
    expect(back.expiry).toBe('2026-01-06');
    expect(back.flag).toBe('WEEK');
    expect(back.strikes).toEqual({ CE: [23500, 23550, 23600], PE: [23400] });
    expect(back.blocks.CE).toHaveLength(3);
    expect(back.blocks.PE).toHaveLength(1);
    const want = day();
    for (const kind of ['CE', 'PE'] as const) {
      want.blocks[kind].forEach((b, i) => {
        // NaN is what an empty minute is, and toEqual treats NaN as equal to NaN.
        expect(Array.from(back.blocks[kind][i])).toEqual(Array.from(b));
      });
    }
  });

  test('a day with a side that has no strikes round-trips too', () => {
    const d: StitchedDay = {
      ...day(),
      strikes: { CE: [], PE: [23400] },
      blocks: { CE: [], PE: [block(4)] },
    };
    const back = decodeDay(encodeDay(d))!;
    expect(back.strikes.CE).toEqual([]);
    expect(back.strikes.PE).toEqual([23400]);
  });

  test('anything that is not a day of this version reads as nothing', () => {
    expect(decodeDay(Buffer.alloc(0))).toBeNull();
    expect(decodeDay(Buffer.from('not a day at all'))).toBeNull();
    const ok = encodeDay(day());
    expect(decodeDay(ok.subarray(0, ok.length - 8))).toBeNull(); // cut short
    const head = Buffer.from(JSON.stringify({ v: 2, expiry: 'x', flag: 'WEEK', CE: [], PE: [] }));
    const wrongVersion = Buffer.alloc(8 * Math.ceil((4 + head.length) / 8));
    wrongVersion.writeUInt32LE(head.length, 0);
    head.copy(wrongVersion, 4);
    expect(decodeDay(wrongVersion)).toBeNull();
  });
});

describe('createOhlcDayStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ohlc-day-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writes under the underlying and reads it back', async () => {
    const store = createOhlcDayStore(dir);
    expect(await store.read('NIFTY', '2026-01-05')).toBeNull();
    await store.write('NIFTY', '2026-01-05', day());
    const back = (await store.read('NIFTY', '2026-01-05'))!;
    expect(back.strikes.CE).toEqual([23500, 23550, 23600]);
    expect(back.blocks.CE[1][0]).toBe(2);
    // Mostly empty minutes compress to a small fraction of the raw four blocks.
    const bytes = (await readFile(path.join(dir, 'NIFTY', 'parquet', '2026-01-05.ohlc.gz'))).length;
    expect(bytes).toBeLessThan(BLOCK * 8);
    expect(await store.read('SENSEX', '2026-01-05')).toBeNull();
  });

  test('a damaged file reads as nothing instead of throwing', async () => {
    const store = createOhlcDayStore(dir);
    await store.write('NIFTY', '2026-01-05', day());
    const f = path.join(dir, 'NIFTY', 'parquet', '2026-01-05.ohlc.gz');
    await writeFile(f, 'garbage');
    expect(await store.read('NIFTY', '2026-01-05')).toBeNull();
    await writeFile(f, gzipSync(Buffer.from('gzip of the wrong thing')));
    expect(await store.read('NIFTY', '2026-01-05')).toBeNull();
  });
});
