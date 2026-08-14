import { expect, test } from 'vitest';
import { createRefdataQueue, runImmediately } from './refdataQueue.ts';

/** A task that records when it ran and stays open until released. */
function task(log: string[], label: string) {
  let release!: () => void;
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    run: async () => {
      log.push(label);
      await finished;
      return label;
    },
  };
}

test('runs one download at a time', async () => {
  const queue = createRefdataQueue();
  const log: string[] = [];
  const first = task(log, 'first');
  const second = task(log, 'second');

  const running = [queue.run('user', first.run), queue.run('user', second.run)];
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(log).toEqual(['first']);

  first.release();
  second.release();
  await expect(Promise.all(running)).resolves.toEqual(['first', 'second']);
  expect(log).toEqual(['first', 'second']);
});

test('lets a user request overtake queued warms', async () => {
  // The case this exists for: three startup warms are queued when someone opens a pane. Sharing the
  // link between them does not make the warms finish sooner, it just makes the person wait.
  const queue = createRefdataQueue();
  const log: string[] = [];
  const holding = task(log, 'in-progress warm');
  const warm = task(log, 'queued warm');
  const user = task(log, 'user');

  const running = [queue.run('warm', holding.run), queue.run('warm', warm.run)];
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Arrives after the warm was already waiting, and still goes first.
  running.push(queue.run('user', user.run));

  holding.release();
  warm.release();
  user.release();
  await Promise.all(running);

  expect(log).toEqual(['in-progress warm', 'user', 'queued warm']);
});

test('frees the lane when a task throws', async () => {
  const queue = createRefdataQueue();
  const log: string[] = [];

  await expect(
    queue.run('user', () => {
      log.push('failing');
      return Promise.reject(new Error('fetch failed'));
    }),
  ).rejects.toThrow('fetch failed');

  await expect(queue.run('user', async () => 'after')).resolves.toBe('after');
  expect(log).toEqual(['failing']);
});

test('runImmediately is a pass-through for callers given no queue', async () => {
  await expect(runImmediately('user', async () => 'value')).resolves.toBe('value');
});
