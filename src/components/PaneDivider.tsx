import { useCallback, useState } from 'react';
import { measureSlack, paneFloor, planResize } from '../lib/paneResize';

/**
 * The drag handle between two stacked chart panes. It resizes the pane BELOW it, moving that
 * boundary the way a splitter should: the pane above gives up the height, and only once it is at
 * its floor does the drag reach past it to the panes further up.
 *
 * Both views hand-rolled this four times each, and every copy had the same three problems — a
 * 6px target that is genuinely hard to hit, an upper bound worked out from a hard-coded count of
 * how many panes were assumed to be on screen, and height that was only ever taken from the one
 * pane that flexes. That last one is why hiding the price chart made every other handle feel
 * dead: the flexing pane became whichever short pane was left at the top, and once its ~100px
 * were spent there was nothing else the drag was allowed to touch.
 */

/** Thickness of the bar as laid out — the space the panes above and below actually give up. */
const BAR_HEIGHT = 8;

/**
 * How far past the bar, top and bottom, the grab zone reaches. The zone is an absolutely
 * positioned overlay, so these pixels are borrowed from the neighbouring panes' edges rather
 * than added to the layout: the handle still reads as a thin line but is 16px tall to the
 * pointer, which is the difference between fiddly and grabbable.
 */
const GRAB_OVERHANG = 4;

/** Accepts a ref from either `useRef<HTMLDivElement>(null)` or a callback-assigned holder. */
type ElementRef = { readonly current: HTMLElement | null };

/** One pane of a stack, as the dividers in that stack need to see it. */
export interface PaneSpec {
  ref: ElementRef;
  /**
   * Its committed height. Left out for the pane that flexes to fill the column: it has no height
   * of its own to write or commit, it simply takes whatever the fixed panes leave.
   */
  height?: number;
  /** Called once on release, with the height this pane came to rest at. */
  onCommit?: (height: number) => void;
  /** Its floor. Defaults to its own CSS `min-height`. */
  min?: number;
}

export interface PaneDividerProps {
  /** Every pane of the stack that is on screen, top to bottom. */
  panes: PaneSpec[];
  /** Which of them this handle resizes — the one directly below the bar. */
  target: ElementRef;
  /** Grip colour while hovered or dragging. */
  accent?: string;
  /** Renders the bar as a plain separator with no grip and no drag. */
  disabled?: boolean;
  title?: string;
}

export default function PaneDivider({
  panes,
  target,
  accent = 'var(--accent)',
  disabled = false,
  title = 'Drag to resize',
}: PaneDividerProps) {
  // Two flags rather than one: while the pointer is captured the browser stops sending boundary
  // events, so a single "active" flag set by pointerenter/leave would come back wrong the moment
  // the drag ends with the pointer still resting on the handle.
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);

  const beginDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pane = target.current;
      const index = panes.findIndex((p) => p.ref === target);
      const spec = index >= 0 ? panes[index] : undefined;
      // A pane with no commit is the flexing one; it has no height to drag.
      if (e.button !== 0 || !pane || !spec?.onCommit) return;
      // Deliberately no preventDefault: that would suppress the compatibility mousedown, and the
      // views listen for it on document to close an open dropdown. Selection is held off by the
      // body style below instead.

      // The stack as it stands, nearest-first — the order the drag consumes it in. A pane's own
      // committed height is what the drag starts from where there is one, because `offsetHeight`
      // counts the panes' bottom borders and starting from it would creep the height a pixel per
      // drag; the flexing pane has no committed height, so it is measured.
      const stacked = panes
        .slice(0, index)
        .reverse()
        .flatMap((p) => {
          const el = p.ref.current;
          return el
            ? [{ el, spec: p, height: p.height ?? el.offsetHeight, min: paneFloor(el, p.min) }]
            : [];
        });
      const fixed = stacked.filter((p) => p.spec.onCommit);
      const flex = stacked.find((p) => !p.spec.onCommit);
      const start = { height: spec.height ?? pane.offsetHeight, min: paneFloor(pane, spec.min) };
      const flexGive = flex ? flex.height - flex.min : 0;
      const slack = measureSlack(pane.parentElement);

      const handle = e.currentTarget;
      const startY = e.clientY;

      // Pointer capture is what makes the drag survive leaving the handle: every move and the
      // release are retargeted here, so the chart canvases underneath never see them and stop
      // swapping the cursor and chasing the pointer with a crosshair mid-drag.
      handle.setPointerCapture(e.pointerId);
      const restore = {
        cursor: document.body.style.cursor,
        userSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      setDragging(true);

      // Written straight to the DOM while dragging and committed to state once, on release:
      // re-rendering the whole view on every pointer move is what made the order book handle
      // lag behind the cursor.
      let plan = planResize(0, start, fixed, flexGive, slack);
      const onMove = (ev: PointerEvent) => {
        plan = planResize(startY - ev.clientY, start, fixed, flexGive, slack);
        pane.style.height = `${plan.target}px`;
        fixed.forEach((p, i) => {
          p.el.style.height = `${plan.above[i]}px`;
        });
      };
      const finish = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        document.body.style.cursor = restore.cursor;
        document.body.style.userSelect = restore.userSelect;
        setDragging(false);
        if (plan.target !== start.height) spec.onCommit?.(plan.target);
        fixed.forEach((p, i) => {
          if (plan.above[i] !== p.height) p.spec.onCommit?.(plan.above[i]);
        });
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    },
    [panes, target],
  );

  return (
    <div
      style={{
        height: BAR_HEIGHT,
        flexShrink: 0,
        position: 'relative',
        zIndex: 20,
        background: 'var(--bg-secondary)',
      }}
    >
      {!disabled && (
        <div
          onPointerDown={beginDrag}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          title={title}
          style={{
            position: 'absolute',
            top: -GRAB_OVERHANG,
            bottom: -GRAB_OVERHANG,
            left: 0,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'row-resize',
            // Or a touch drag scrolls the page instead of reaching pointermove.
            touchAction: 'none',
          }}
        >
          <div
            style={{
              width: 40,
              height: 2,
              borderRadius: 2,
              background: hover || dragging ? accent : 'var(--border)',
              transition: 'background 120ms',
            }}
          />
        </div>
      )}
    </div>
  );
}
