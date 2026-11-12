import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isPageHidden, setVisibleInterval } from './visibleInterval';

// The suite runs in node, so stand up the one piece of `document` the helper touches.
class FakeDocument extends EventTarget {
  hidden = false;
  setHidden(h: boolean) {
    this.hidden = h;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}
let doc: FakeDocument;

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('ticks normally while the page is visible', () => {
  const fn = vi.fn();
  const stop = setVisibleInterval(fn, 1000);
  vi.advanceTimersByTime(3000);
  expect(fn).toHaveBeenCalledTimes(3);
  stop();
});

test('skips ticks while hidden and refreshes once on return', () => {
  const fn = vi.fn();
  const stop = setVisibleInterval(fn, 1000);
  doc.setHidden(true);
  vi.advanceTimersByTime(10_000);
  expect(fn).not.toHaveBeenCalled();
  doc.setHidden(false);
  expect(fn).toHaveBeenCalledTimes(1); // immediate catch-up, not up to a full interval later
  vi.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(2);
  stop();
});

test('cleanup stops both the timer and the visibility listener', () => {
  const fn = vi.fn();
  const stop = setVisibleInterval(fn, 1000);
  stop();
  vi.advanceTimersByTime(5000);
  doc.setHidden(true);
  doc.setHidden(false);
  expect(fn).not.toHaveBeenCalled();
});

test('isPageHidden follows document.hidden', () => {
  expect(isPageHidden()).toBe(false);
  doc.hidden = true;
  expect(isPageHidden()).toBe(true);
});
