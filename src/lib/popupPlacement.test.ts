import { test, expect } from 'vitest';
import { placePopup, type AnchorRect } from './popupPlacement.ts';

// A 1920x1080 window with the toolbar trigger near the top-right, which is where the Greek
// buttons actually sit. Tray dimensions match GreekControls: 300px wide, tall enough to need
// capping in a short pane.
const VIEWPORT = { width: 1920, height: 1080 };
const SIZE = { width: 300, height: 620 };
const anchor = (top: number, right: number, h = 26): AnchorRect => ({
  top,
  bottom: top + h,
  right,
  left: right - 90,
});

test('placePopup: right-aligns to the anchor and sits just below it', () => {
  const p = placePopup(anchor(140, 1900), SIZE, VIEWPORT);
  expect(p.side).toBe('below');
  expect(p.left).toBe(1900 - 300); // right edges flush
  expect(p.top).toBe(140 + 26 + 4); // anchor bottom + GAP
});

/**
 * maxHeight is measured against the VIEWPORT, which is the whole point of portalling.
 *
 * The old tray was `max-h-[80vh]` — sized against the window — while `overflow-hidden`
 * ancestors clipped it against its pane, so it was sheared off with no scrollbar and no way to
 * reach the rest of the form. In a 1080px window the tray now gets 902px and does not need to
 * scroll at all, which is exactly the reported bug going away.
 */
test('placePopup: measures available height against the viewport, not the pane', () => {
  const p = placePopup(anchor(140, 1900), SIZE, VIEWPORT);
  expect(p.maxHeight).toBe(1080 - 166 - 4 - 8); // viewport − anchor.bottom − GAP − MARGIN
  expect(p.maxHeight).toBeGreaterThan(SIZE.height); // fits whole — no clipping, no scrollbar
});

/** In a genuinely short window it still caps, so the tray scrolls rather than overflowing. */
test('placePopup: caps and scrolls when the window really is too short', () => {
  const p = placePopup(anchor(140, 1900), SIZE, { width: 1920, height: 620 });
  expect(p.side).toBe('below');
  expect(p.maxHeight).toBe(620 - 166 - 4 - 8);
  expect(p.maxHeight).toBeLessThan(SIZE.height);
});

test('placePopup: flips above only when it cannot fit below', () => {
  // Anchor low in the window: 120px below, 900px above.
  const low = anchor(940, 1900);
  const flipped = placePopup(low, SIZE, VIEWPORT);
  expect(flipped.side).toBe('above');
  expect(flipped.top).toBe(940 - 4 - 620); // anchor.top − GAP − full height (it fits above)
  expect(flipped.top).toBeGreaterThanOrEqual(8);

  // Same anchor, a short popup that DOES fit below: stays below even though above is roomier.
  const short = placePopup(low, { width: 300, height: 100 }, VIEWPORT);
  expect(short.side).toBe('below');
});

test('placePopup: clamps to the viewport on both edges', () => {
  // Trigger hard against the right edge — right-aligning would push the popup off-screen.
  const atRight = placePopup(anchor(140, 1918), SIZE, VIEWPORT);
  expect(atRight.left).toBeLessThanOrEqual(1920 - 300 - 8);

  // Trigger near the left edge — right-aligning would yield a negative left.
  const atLeft = placePopup({ top: 140, bottom: 166, left: 0, right: 90 }, SIZE, VIEWPORT);
  expect(atLeft.left).toBe(8);

  // Viewport narrower than the popup: pin to the left margin, never negative.
  const narrow = placePopup(anchor(140, 300), SIZE, { width: 280, height: 1080 });
  expect(narrow.left).toBe(8);
});

/**
 * A window too short for MIN_HEIGHT on either side. Clamping to the literal 30px available would
 * render a sliver that reads as a broken component; overflowing a very short window is the
 * better failure.
 */
test('placePopup: never returns a maxHeight below the legibility floor', () => {
  // 200px window with the anchor mid-height: 72px below, 78px above — both under the floor.
  const p = placePopup(anchor(90, 400), SIZE, { width: 1920, height: 200 });
  expect(p.side).toBe('above'); // the roomier of two bad options
  expect(p.maxHeight).toBe(120); // floored, not the literal 78 available
});
