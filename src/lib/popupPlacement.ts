// ─── Viewport placement for portalled anchor popups ─────────────────────────────
//
// The Greek settings tray used to be an `absolute` child of its trigger, which meant every
// `overflow-hidden` ancestor between it and the viewport clipped it — four of them, ending at
// the pane boundary where the positions panel starts. z-index cannot fix that: overflow clips
// descendants no matter what stacking context they sit in.
//
// The fix is to portal the tray to document.body and position it with `fixed`, which is what
// this module computes. Once the popup no longer lives inside its trigger's box, nothing keeps
// it on screen for free, so the arithmetic that CSS used to do implicitly has to be explicit —
// and being a pure function, it can actually be tested, which the absolute version never could.

/** The subset of DOMRect this module needs — so tests need not fabricate a whole DOMRect. */
export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /** Cap for the popup's own height; it scrolls internally beyond this. */
  maxHeight: number;
  /** Which side of the anchor was chosen — exposed mainly so tests can assert the flip. */
  side: 'below' | 'above';
}

/** Keep-off distance from every viewport edge. */
const MARGIN = 8;
/** Gap between the anchor and the popup — matches the `mt-1` the absolute version used. */
const GAP = 4;
/**
 * Never shrink below this, even in a viewport too short to honour it. A popup clamped to 40px
 * is indistinguishable from a rendering bug; one that overflows a very short window is at least
 * legible and scrollable.
 */
const MIN_HEIGHT = 120;

/**
 * Position a popup against its anchor in viewport coordinates.
 *
 * Right-aligned to the anchor (the trigger sits at the right end of a toolbar, so its left edge
 * is the one that moves), flipped above when there is meaningfully more room up there, and
 * clamped inside the viewport on both axes.
 *
 * The flip is decided on *fit first, space second*: if the popup fits below it stays below, even
 * when above is roomier, because a tray that jumps sides as its content grows is disorienting.
 * Only when it cannot fit below does the larger side win.
 */
export function placePopup(anchor: AnchorRect, size: PopupSize, viewport: Viewport): Placement {
  const spaceBelow = viewport.height - anchor.bottom - GAP - MARGIN;
  const spaceAbove = anchor.top - GAP - MARGIN;

  const side: 'below' | 'above' =
    size.height <= spaceBelow || spaceBelow >= spaceAbove ? 'below' : 'above';

  const maxHeight = Math.max(MIN_HEIGHT, side === 'below' ? spaceBelow : spaceAbove);
  const height = Math.min(size.height, maxHeight);

  const top = side === 'below' ? anchor.bottom + GAP : Math.max(MARGIN, anchor.top - GAP - height);

  // Right-align, then clamp. A popup wider than the viewport pins to the left margin rather
  // than producing a negative left, which would put its content off the near edge instead.
  const maxLeft = viewport.width - size.width - MARGIN;
  const left =
    maxLeft < MARGIN ? MARGIN : Math.min(Math.max(anchor.right - size.width, MARGIN), maxLeft);

  return { left, top, maxHeight, side };
}
