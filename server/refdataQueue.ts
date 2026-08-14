/**
 * One lane for instrument-master downloads, with the user's request ahead of the background ones.
 *
 * Every `/refdata/refdata/<date>` is a ~34 MB dump that takes 40-45 s. Boot used to start four of
 * them at once — `warmRefdata()` fires NSE, BSE and MCX in parallel and `warmBacktestRefdata()`
 * starts the previous trading day alongside — and anything the user did in the first minute became
 * a fifth. Sharing a link four ways does not make four downloads finish sooner; it makes all four
 * finish late, and the one someone is actually waiting for is late along with them.
 *
 * So: one at a time, and when the lane frees up, whoever is waiting on a person goes first. A warm
 * that loses its place has nobody watching it.
 *
 * Only the download is serialised. Reads served from the disk cache never come here at all, which
 * is why a warm start still brings up three exchanges at once.
 */

export type RefdataPriority = 'user' | 'warm';

export interface RefdataQueue {
  run<T>(priority: RefdataPriority, task: () => Promise<T>): Promise<T>;
}

/** The shape the caches accept, so one that is handed nothing still runs its tasks directly. */
export type RefdataSchedule = <T>(priority: RefdataPriority, task: () => Promise<T>) => Promise<T>;

export const runImmediately: RefdataSchedule = (_priority, task) => task();

interface Waiter {
  priority: RefdataPriority;
  start: () => void;
}

export function createRefdataQueue({ concurrency = 1 } = {}): RefdataQueue {
  const waiting: Waiter[] = [];
  let active = 0;

  function pump(): void {
    while (active < concurrency && waiting.length) {
      // A linear scan, because this queue is a handful of entries deep at its very worst.
      let next = 0;
      for (let i = 1; i < waiting.length; i++) {
        if (waiting[i].priority === 'user' && waiting[next].priority !== 'user') next = i;
      }
      const [waiter] = waiting.splice(next, 1);
      active++;
      waiter.start();
    }
  }

  async function run<T>(priority: RefdataPriority, task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      waiting.push({ priority, start: resolve });
      pump();
    });
    try {
      return await task();
    } finally {
      active--;
      pump();
    }
  }

  return { run };
}
