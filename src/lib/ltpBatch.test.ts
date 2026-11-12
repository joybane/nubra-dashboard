import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLtpBatcher, mergeLtps } from './ltpBatch';

// node has no animation frames; queue them by hand so a test decides when a frame "paints".
let frames: Map<number, FrameRequestCallback>;
let nextId: number;
const paint = () => {
  const due = [...frames.values()];
  frames.clear();
  for (const cb of due) cb(0);
};

beforeEach(() => {
  frames = new Map();
  nextId = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

const pos = (ref_id: number, ltp: number) => ({ ref_id, last_traded_price: ltp, qty: 75 });

test('mergeLtps updates only the positions whose price moved', () => {
  const prev = [pos(1, 100), pos(2, 200)];
  const next = mergeLtps(
    prev,
    new Map([
      [2, 210],
      [99, 5],
    ]),
  );
  expect(next).not.toBe(prev);
  expect(next[0]).toBe(prev[0]); // untouched rows keep identity
  expect(next[1]).toEqual({ ref_id: 2, last_traded_price: 210, qty: 75 });
});

test('mergeLtps returns the same array when nothing changed, so React can skip the render', () => {
  const prev = [pos(1, 100)];
  expect(mergeLtps(prev, new Map([[1, 100]]))).toBe(prev);
  expect(mergeLtps(prev, new Map([[7, 1]]))).toBe(prev);
});

test('updates within one frame apply once, last write winning per leg', () => {
  const apply = vi.fn();
  const b = createLtpBatcher(apply);
  b.push(
    new Map([
      [1, 100],
      [2, 200],
    ]),
  ); // option_chain
  b.push(new Map([[1, 101]])); // position_ltp right behind it
  expect(apply).not.toHaveBeenCalled();
  paint();
  expect(apply).toHaveBeenCalledTimes(1);
  expect([...apply.mock.calls[0][0]]).toEqual([
    [1, 101],
    [2, 200],
  ]);
});

test('each frame gets its own flush', () => {
  const apply = vi.fn();
  const b = createLtpBatcher(apply);
  b.push(new Map([[1, 100]]));
  paint();
  b.push(new Map([[1, 102]]));
  paint();
  expect(apply).toHaveBeenCalledTimes(2);
  expect(apply.mock.calls[1][0].get(1)).toBe(102);
});

test('cancel drops queued prices and the pending frame', () => {
  const apply = vi.fn();
  const b = createLtpBatcher(apply);
  b.push(new Map([[1, 100]]));
  b.cancel();
  paint();
  expect(apply).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
});

test('an empty push schedules nothing', () => {
  const b = createLtpBatcher(vi.fn());
  b.push(new Map());
  expect(frames.size).toBe(0);
});
