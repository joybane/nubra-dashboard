// ─── Choosing which line the price axis describes ────────────────────────────────
//
// A lightweight-charts pane builds a price-axis widget for 'left' and 'right' and nothing else, so
// a pane stacking several measures on overlay scales can label at most two of them and the rest are
// read off floating last-value tags. Rather than pick two and leave the others mute, the axis
// FOLLOWS the cursor: point at a line and the axis takes that line's range and number format.
//
// The selection has to be sticky or it is useless. Nine lines in a 200px pane cross each other
// constantly, and an axis that re-ticks on every pixel of cursor drift is harder to read than no
// axis at all. Two rules do it, and they are the whole of this file:
//
//   • a line has to be within `maxDistancePx` to be a candidate at all — drifting into empty space
//     keeps the axis on whatever you were last reading rather than blanking it;
//   • a challenger has to beat the incumbent by `stickinessPx`, not merely tie it, so two lines
//     running close together do not trade the axis back and forth as the cursor wobbles.

/** One line's position at the hovered bar. `key` is whatever the caller uses to identify it. */
export interface AxisCandidate<K> {
  key: K;
  /** Pixel y of the line at the hovered bar, in the same frame as the cursor's y. */
  y: number;
}

export interface AxisFollowOpts {
  /** Beyond this the cursor is over nothing in particular. Default 40px. */
  maxDistancePx?: number;
  /** How much nearer a challenger must be before it takes the axis. Default 12px. */
  stickinessPx?: number;
}

/**
 * Which line the axis should describe now, given where the cursor is and what it describes already.
 *
 * Returns `current` unchanged whenever nothing better is on offer — including when the cursor is
 * far from every line — so the axis holds still while you move across the pane to read it. Returns
 * null only when there is genuinely nothing to point at and nothing was selected before.
 */
export function pickAxisTarget<K>(
  candidates: ReadonlyArray<AxisCandidate<K>>,
  cursorY: number | null,
  current: K | null,
  opts: AxisFollowOpts = {},
): K | null {
  const maxDistance = opts.maxDistancePx ?? 40;
  const stickiness = opts.stickinessPx ?? 12;

  if (cursorY == null || !Number.isFinite(cursorY)) return current;

  let best: AxisCandidate<K> | null = null;
  let bestDist = Infinity;
  let currentDist = Infinity;

  for (const c of candidates) {
    if (!Number.isFinite(c.y)) continue;
    const d = Math.abs(c.y - cursorY);
    if (c.key === current) currentDist = d;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  if (!best || bestDist > maxDistance) return current;
  if (best.key === current) return current;
  // The incumbent keeps the axis unless it has dropped out of range entirely or been clearly beaten.
  // `currentDist` is Infinity when the incumbent is no longer on the chart at all — a measure
  // switched off, say — and then any candidate in range wins immediately.
  if (currentDist <= maxDistance && bestDist > currentDist - stickiness) return current;
  return best.key;
}
