/**
 * Where the height goes when a pane divider is dragged, for `components/PaneDivider`.
 *
 * Lives here rather than beside the component so the rule can be unit-tested without a DOM: it is
 * the substance of the fix. The rule this replaced only ever took height from the one pane that
 * flexes, so a handle went dead whenever that pane was small — which is what hiding the price
 * chart does, since the pane below it becomes the flexing one and it is nowhere near as tall.
 */

/** A pane as it stands at the moment the drag starts. */
export interface PaneMetrics {
  height: number;
  /** The floor it may not be squeezed past. */
  min: number;
}

/** Heights to write: the dragged pane, and the fixed panes above it in the order handed in. */
export interface ResizePlan {
  target: number;
  above: number[];
}

/**
 * The heights a stack should take when the boundary below `target`'s neighbours moves `delta` px
 * upward — positive `delta` growing the dragged pane.
 *
 * Growing takes from the panes above nearest-first, each down to its own floor, which is what
 * makes the handle move the boundary it is actually sitting on rather than quietly resizing some
 * pane at the top of the column. `slack` (height the stack has not handed out) is spent first
 * because it costs nobody anything, and `flexGive` — the room left in the flexing pane, which is
 * always the topmost one — is spent last and needs no height written for it: it takes whatever
 * the fixed panes leave.
 *
 * Shrinking hands the freed height straight to the pane above, so the drag is reversible.
 *
 * @param above the FIXED panes above the dragged one, nearest first.
 */
export function planResize(
  delta: number,
  target: PaneMetrics,
  above: PaneMetrics[],
  flexGive = 0,
  slack = 0,
): ResizePlan {
  const next = above.map((p) => p.height);

  if (delta >= 0) {
    const fromAbove = above.reduce((sum, p) => sum + Math.max(0, p.height - p.min), 0);
    const grow = Math.min(delta, Math.max(0, slack) + fromAbove + Math.max(0, flexGive));
    let need = grow - Math.max(0, slack);
    for (let i = 0; i < above.length && need > 0; i++) {
      const take = Math.min(need, Math.max(0, above[i].height - above[i].min));
      next[i] = above[i].height - take;
      need -= take;
    }
    return { target: target.height + grow, above: next };
  }

  const give = Math.min(-delta, Math.max(0, target.height - target.min));
  if (above.length > 0) next[0] = above[0].height + give;
  return { target: target.height - give, above: next };
}

/** A CSS length that is `auto`/`none`/unset reads as no constraint. */
function pxOr(value: string, fallback: number): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** A pane's floor: what the caller declared, else its own `min-height`, else none. */
export function paneFloor(el: HTMLElement, declared?: number): number {
  return declared ?? pxOr(getComputedStyle(el).minHeight, 0);
}

/**
 * Height in a stack that no child has claimed. Normally zero — a flexing pane swallows it — but
 * with every flexing pane switched off it is the whole gap at the bottom of the column, and it is
 * the only room a drag has to grow into.
 */
export function measureSlack(wrapper: HTMLElement | null): number {
  if (!wrapper) return 0;
  const cs = getComputedStyle(wrapper);
  const inner = wrapper.clientHeight - pxOr(cs.paddingTop, 0) - pxOr(cs.paddingBottom, 0);
  let used = 0;
  for (const child of Array.from(wrapper.children)) used += (child as HTMLElement).offsetHeight;
  return Math.max(0, inner - used);
}
