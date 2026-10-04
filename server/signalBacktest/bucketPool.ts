/**
 * A small pool of worker threads that decode parquet bucket files.
 *
 * A multi-year Signal Backtest decodes tens of thousands of bucket files; decoding is CPU-bound, and
 * on the main thread it uses one core while the rest idle (and it stalls the server's other work).
 * Spreading it over a few workers makes a cold run several times faster.
 *
 * Workers start on the first read and are shut down after `idleMs` with nothing to do, so an idle
 * server holds no extra threads or memory. `read` rejects if the file could not be decoded or the
 * worker died; the caller decides what that means (the loader retries in-process, then skips the
 * file).
 */
import { Worker } from 'worker_threads';
import type { BucketColumns } from './bucketDecode.ts';

export interface BucketPool {
  read(file: string): Promise<BucketColumns>;
  /** Stop every worker now. Reads still waiting are rejected. */
  close(): void;
}

interface Slot {
  worker: Worker;
  inFlight: number;
  /** Stopped on purpose (idle or closed), so its exit is not a failure. */
  closed: boolean;
}

interface Pending {
  slot: Slot;
  resolve(cols: BucketColumns): void;
  reject(err: Error): void;
}

export function createBucketPool(options: {
  /** How many workers to run at most. */
  size: number;
  /** Shut the workers down after this long with no read in flight. */
  idleMs?: number;
  /** Where the worker script lives; defaults to parquetWorker.ts beside this file. */
  workerUrl?: URL;
}): BucketPool {
  const { size, idleMs = 20_000 } = options;
  const workerUrl = options.workerUrl ?? new URL('./parquetWorker.ts', import.meta.url);
  const slots: Slot[] = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | null = null;
  // Workers that die before ever answering mean threads cannot run the script here (a missing
  // flag, a bad path): stop spawning them and let every read fall back to the caller.
  let answered = false;
  let failures = 0;
  let broken = false;

  const failAll = (slot: Slot, err: Error) => {
    for (const [id, p] of pending) {
      if (p.slot !== slot) continue;
      pending.delete(id);
      p.reject(err);
    }
  };

  const spawn = (): Slot => {
    const worker = new Worker(workerUrl);
    // A worker must never be what keeps the server process alive.
    worker.unref();
    const slot: Slot = { worker, inFlight: 0, closed: false };
    worker.on('message', (msg: { id: number; cols?: BucketColumns; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      p.slot.inFlight--;
      answered = true;
      if (msg.cols) p.resolve(msg.cols);
      else p.reject(new Error(msg.error ?? 'parquet worker returned nothing'));
      armIdle();
    });
    const gone = (err: Error) => {
      const at = slots.indexOf(slot);
      if (at < 0) return;
      slots.splice(at, 1);
      if (!slot.closed && !answered && ++failures >= 2) broken = true;
      failAll(slot, err);
    };
    worker.on('error', (e) => gone(e));
    worker.on('exit', (code) => gone(new Error(`parquet worker exited (${code})`)));
    slots.push(slot);
    return slot;
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (pending.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (pending.size === 0) closeAll();
    }, idleMs);
    idleTimer.unref();
  };

  const closeAll = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    for (const slot of [...slots]) {
      slot.closed = true;
      slots.splice(slots.indexOf(slot), 1);
      failAll(slot, new Error('parquet worker pool closed'));
      void slot.worker.terminate();
    }
  };

  return {
    read(file) {
      if (broken) return Promise.reject(new Error('worker threads are unavailable'));
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      // The least busy worker, starting another while there is room for one.
      let slot = slots.reduce<Slot | null>((a, b) => (a && a.inFlight <= b.inFlight ? a : b), null);
      if (!slot || (slot.inFlight > 0 && slots.length < size)) slot = spawn();
      const id = nextId++;
      return new Promise<BucketColumns>((resolve, reject) => {
        pending.set(id, { slot: slot!, resolve, reject });
        slot!.inFlight++;
        try {
          slot!.worker.postMessage({ id, file });
        } catch (e) {
          pending.delete(id);
          slot!.inFlight--;
          reject(e as Error);
        }
      });
    },
    close: closeAll,
  };
}
