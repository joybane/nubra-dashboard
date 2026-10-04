import { afterEach, describe, expect, test } from 'vitest';
import { createBucketPool, type BucketPool } from './bucketPool.ts';

/** A stand-in worker: answers with the file name's length as the close and its thread as the strike. */
const echoWorker = new URL(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { parentPort, threadId } from 'node:worker_threads';
      parentPort.on('message', (m) => {
        if (m.file === 'hang') return;
        if (m.file === 'boom') return parentPort.postMessage({ id: m.id, error: 'bad parquet' });
        const one = (v) => new Float64Array([v]);
        parentPort.postMessage({ id: m.id, cols: {
          ts: one(1), open: one(2), high: one(3), low: one(4), close: one(m.file.length), strike: one(threadId),
        } });
      });
    `),
);

/** A worker script that cannot even load. */
const brokenWorker = new URL(
  'data:text/javascript,' + encodeURIComponent(`throw new Error('cannot start');`),
);

const pools: BucketPool[] = [];
const make = (opts: Parameters<typeof createBucketPool>[0]) => {
  const pool = createBucketPool(opts);
  pools.push(pool);
  return pool;
};
afterEach(() => {
  while (pools.length) pools.pop()!.close();
});

describe('bucket pool', () => {
  test('returns what the worker decoded', async () => {
    const pool = make({ size: 2, workerUrl: echoWorker });
    const cols = await pool.read('abcd');
    expect(cols.close[0]).toBe(4);
    expect(cols.ts[0]).toBe(1);
  });

  test('spreads reads that arrive together over several workers, up to the size', async () => {
    const pool = make({ size: 3, workerUrl: echoWorker });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => pool.read(`f${i}`)));
    const threads = new Set(results.map((c) => c.strike[0]));
    expect(threads.size).toBe(3);
  });

  test('a file that cannot be decoded rejects that read only', async () => {
    const pool = make({ size: 2, workerUrl: echoWorker });
    await expect(pool.read('boom')).rejects.toThrow('bad parquet');
    expect((await pool.read('fine')).close[0]).toBe(4);
  });

  test('close rejects what is waiting and the pool starts fresh workers afterwards', async () => {
    const pool = make({ size: 1, workerUrl: echoWorker });
    const stuck = pool.read('hang');
    const expectation = expect(stuck).rejects.toThrow(/closed/);
    pool.close();
    await expectation;
    expect((await pool.read('ok')).close[0]).toBe(2);
  });

  test('workers that go idle are shut down, and the next read gets a new one', async () => {
    const pool = make({ size: 1, idleMs: 40, workerUrl: echoWorker });
    const first = (await pool.read('a')).strike[0];
    await new Promise((r) => setTimeout(r, 250));
    const second = (await pool.read('b')).strike[0];
    expect(second).not.toBe(first);
  });

  test('workers that cannot start fail the read, and after two the pool stops trying', async () => {
    const pool = make({ size: 2, workerUrl: brokenWorker });
    await expect(pool.read('a')).rejects.toThrow();
    await expect(pool.read('b')).rejects.toThrow();
    await expect(pool.read('c')).rejects.toThrow(/unavailable/);
  });
});
