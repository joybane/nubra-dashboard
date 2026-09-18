import { useCallback, useEffect, useState } from 'react';
import type { IChartApi, IPaneApi, Time } from 'lightweight-charts';

/** Floor so a drag can't collapse a pane out of existence. */
const MIN_PANE_HEIGHT = 24;
/** The strip's hit-zone, centered on the boundary — matches PaneDivider's own grab zone
 * (8px bar + 4px overhang each side) rather than the library's bare 1px seam. */
const HIT_HEIGHT = 16;
const GRIP_WIDTH = 36;
/** Cheap poll for pane heights moving without our involvement — a container resize, or
 * someone actually landing a drag on the library's own 1px seam. */
const POLL_MS = 400;

interface Boundary {
  /** Sits between chart.panes()[index] and chart.panes()[index + 1]. */
  index: number;
  /** Cumulative px from the pane stack's top to the boundary's center. */
  top: number;
}

function measureBoundaries(chart: IChartApi | null): Boundary[] {
  if (!chart) return [];
  let panes;
  try {
    panes = chart.panes();
  } catch {
    return [];
  }
  if (panes.length < 2) return [];
  const list: Boundary[] = [];
  let acc = 0;
  for (let i = 0; i < panes.length - 1; i++) {
    try {
      acc += panes[i].getHeight();
    } catch {
      /* pane mid-teardown */
    }
    list.push({ index: i, top: acc });
  }
  return list;
}

/**
 * Draggable strips over the boundaries between a chart's native panes (the price pane and
 * one sub-pane per enabled Greek in `CandleChart`). `layout.panes.enableResize` defaults to
 * true, so the library already resizes adjacent panes on drag — the problem is its hit zone,
 * the bare 1px seam it paints between them, which is well under a mouse's practical grab
 * tolerance and reads as "you can't resize these" even though the mechanism underneath is
 * fine.
 *
 * The gesture is claimed on the container in the pointerdown CAPTURE phase — the same trick
 * `GreekIndicatorPane`'s own stretch-drag uses on this same node — so lightweight-charts' own
 * separator-drag detection never sees the mousedown and cannot also start a drag of its own.
 *
 * The resize itself goes through `setStretchFactor`, not the more obvious `setHeight`.
 * `IPaneApi.setHeight(px)` (confirmed by reading the library's own source, `_internal_
 * changePanesHeight`) recomputes EVERY pane's stretch factor to hold the total height fixed —
 * it is built for "make this one pane N px tall and let the rest share the remainder", which
 * is a different gesture from "move the boundary between these two, leave every other pane
 * alone". Driving a two-pane drag through it means every move's call also nudges every OTHER
 * pane, and those nudges compound call over call — which is what made an early version of this
 * either drag three panes at once or, once a pane's internal state got far enough out of sync
 * with a naive "reassert everyone's height" workaround, stop visibly responding at all.
 * `setStretchFactor` sets one pane's factor directly with no such side effect, so the fix is to
 * convert the drag's target pixel heights to stretch factors ourselves and only ever touch the
 * two panes on either side of the boundary being dragged.
 *
 * Sizes itself off `chart.panes()` directly rather than mirroring counts from the host, so it
 * stays correct across Greek toggles and mine/industry/both switches without the host having
 * to describe its own pane layout to it. The visible strips are decoration only
 * (`pointerEvents: none`) — all hit-testing happens against the same boundary list here.
 */
export default function ChartPaneResizer({
  chartRef,
  containerRef,
  refreshKey,
}: {
  chartRef: React.RefObject<IChartApi | null>;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Bumped (any changed value) whenever the pane count may have changed — a Greek toggled
   * on/off, method switched to/from 'both' — so boundaries are recomputed immediately
   * instead of waiting for the next poll. */
  refreshKey: unknown;
}) {
  const [boundaries, setBoundaries] = useState<Boundary[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const measure = useCallback(() => {
    setBoundaries(measureBoundaries(chartRef.current));
  }, [chartRef]);

  useEffect(() => {
    measure();
  }, [measure, refreshKey]);

  useEffect(() => {
    const id = window.setInterval(measure, POLL_MS);
    return () => window.clearInterval(id);
  }, [measure]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Read fresh on every hit-test rather than closing over the `boundaries` state, which is
    // only as current as the last render — a toggle that just added a pane must be gadgetable
    // immediately, not after this effect's next render.
    const hitTest = (clientY: number): Boundary | null => {
      const rect = el.getBoundingClientRect();
      const y = clientY - rect.top;
      for (const b of measureBoundaries(chartRef.current)) {
        if (Math.abs(y - b.top) <= HIT_HEIGHT / 2) return b;
      }
      return null;
    };

    let drag: {
      above: IPaneApi<Time>;
      below: IPaneApi<Time>;
      boundaryIndex: number;
      startAbovePx: number;
      pairPxTotal: number;
      pairStretchTotal: number;
      startY: number;
      pointerId: number;
      restoreCursor: string;
      restoreUserSelect: string;
    } | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      const { above, below, startAbovePx, pairPxTotal, pairStretchTotal } = drag;
      const dy = ev.clientY - drag.startY;
      const newAbovePx = Math.max(
        MIN_PANE_HEIGHT,
        Math.min(pairPxTotal - MIN_PANE_HEIGHT, startAbovePx + dy),
      );
      // Split the pair's combined stretch in the same proportion as the new pixel split. The
      // pair's total stretch (not the whole chart's) is what has to stay fixed here — that is
      // what keeps every pane OUTSIDE this pair, whose share of the total is unaffected, at
      // exactly the height it started the drag at.
      const newAboveStretch = pairStretchTotal * (newAbovePx / pairPxTotal);
      try {
        above.setStretchFactor(newAboveStretch);
        below.setStretchFactor(pairStretchTotal - newAboveStretch);
      } catch {
        /* a pane was torn down mid-drag (its Greek got toggled off elsewhere) */
      }
      measure();
    };

    const endDrag = () => {
      if (!drag) return;
      document.body.style.cursor = drag.restoreCursor;
      document.body.style.userSelect = drag.restoreUserSelect;
      drag = null;
      setDragIndex(null);
      measure();
    };

    const onUp = (ev: PointerEvent) => {
      if (!drag || ev.pointerId !== drag.pointerId) return;
      endDrag();
    };

    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || drag) return;
      const boundary = hitTest(ev.clientY);
      if (!boundary) return;
      const chart = chartRef.current;
      if (!chart) return;
      let panes: IPaneApi<Time>[];
      try {
        panes = chart.panes();
      } catch {
        return;
      }
      const above = panes[boundary.index];
      const below = panes[boundary.index + 1];
      if (!above || !below) return;
      let startAbovePx: number, startBelowPx: number, pairStretchTotal: number;
      try {
        startAbovePx = above.getHeight();
        startBelowPx = below.getHeight();
        pairStretchTotal = above.getStretchFactor() + below.getStretchFactor();
      } catch {
        return;
      }
      const pairPxTotal = startAbovePx + startBelowPx;
      if (pairPxTotal <= MIN_PANE_HEIGHT * 2) return;

      // Claim it — the library must not also see this mousedown as the start of its own
      // separator drag.
      ev.preventDefault();
      ev.stopPropagation();
      drag = {
        above,
        below,
        boundaryIndex: boundary.index,
        startAbovePx,
        pairPxTotal,
        pairStretchTotal,
        startY: ev.clientY,
        pointerId: ev.pointerId,
        restoreCursor: document.body.style.cursor,
        restoreUserSelect: document.body.style.userSelect,
      };
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      setDragIndex(boundary.index);
    };

    const onHoverMove = (ev: PointerEvent) => {
      if (drag) return;
      const b = hitTest(ev.clientY);
      setHoverIndex(b ? b.index : null);
      // The strip itself is pointer-events:none (so it never fights the library for the
      // gesture — see the header note), so the cursor the library's own canvas would show
      // has to be overridden here instead of relying on the strip's own CSS.
      el.style.cursor = b ? 'row-resize' : '';
    };
    const onHoverLeave = () => {
      if (!drag) {
        setHoverIndex(null);
        el.style.cursor = '';
      }
    };

    // Capture phase: this must run before lightweight-charts' own listeners on the same
    // container get a chance to start their own drag — see the header note.
    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onHoverMove, true);
    el.addEventListener('pointerleave', onHoverLeave, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    window.addEventListener('blur', endDrag);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onHoverMove, true);
      el.removeEventListener('pointerleave', onHoverLeave, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('blur', endDrag);
      endDrag();
      el.style.cursor = '';
    };
  }, [chartRef, containerRef, measure]);

  if (!boundaries.length) return null;

  return (
    <>
      {boundaries.map((b) => (
        <div
          key={b.index}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: b.top - HIT_HEIGHT / 2,
            height: HIT_HEIGHT,
            zIndex: 40,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: GRIP_WIDTH,
              height: 2,
              borderRadius: 2,
              background:
                dragIndex === b.index || hoverIndex === b.index
                  ? 'var(--accent)'
                  : 'var(--border)',
              transition: 'background 120ms',
            }}
          />
        </div>
      ))}
    </>
  );
}
