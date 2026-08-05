import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import { isChartLive } from '../lib/chartLifecycle';
import { PIN_CARD_GAP, type ChartPin } from '../lib/chartPins';

interface Props {
  pins: ChartPin[];
  /** The pane's chart. Read-only here — the layer never mutates chart state. */
  chart: IChartApi | null;
  /**
   * Extra px between the pane's left edge and the plot area, on top of the chart's own left
   * price scale. Only Nubra BT's P&L pane needs it (its chart div carries paddingLeft: 75).
   */
  xAdjust?: number;
  /** Bump when the chart instance is recreated so the layer re-subscribes and re-measures. */
  epoch?: number;
  renderCard: (pin: ChartPin, index: number) => React.ReactNode;
  /** The Δ readout, placed midway between the two pinned lines. */
  compare?: React.ReactNode;
  onRemove: (id: number) => void;
}

/**
 * Draws the pinned crosshairs for one pane: a dashed vertical line per pin, a removable badge
 * at the foot of each line, and the pin's frozen tooltip card beside it.
 *
 * The layer owns its own redraw triggers (visible-range changes, resize) rather than being fed
 * by the pane's existing sync code, so nothing outside this file has to change for pins to
 * follow scroll and zoom.
 */
export default function PinnedCrosshairLayer({
  pins,
  chart,
  xAdjust = 0,
  epoch = 0,
  renderCard,
  compare,
  onRemove,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const compareRef = useRef<HTMLDivElement>(null);
  const compareXRef = useRef(0);
  const [, setTick] = useState(0);
  const rafRef = useRef<number | null>(null);

  const bump = () => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setTick((t) => t + 1);
    });
  };

  useEffect(() => {
    if (!isChartLive(chart) || pins.length === 0) return;
    let ts: ReturnType<IChartApi['timeScale']> | null = null;
    const onRange = () => bump();
    try {
      ts = chart.timeScale();
      ts.subscribeVisibleLogicalRangeChange(onRange);
    } catch {
      ts = null;
    }
    const ro = new ResizeObserver(() => bump());
    if (rootRef.current) ro.observe(rootRef.current);
    // A pin placed before the pane has laid out (or right after a theme flip) needs one
    // post-mount pass to pick up the real coordinates.
    bump();
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      ro.disconnect();
      try {
        ts?.unsubscribeVisibleLogicalRangeChange(onRange);
      } catch {
        /* chart already gone */
      }
    };
  }, [chart, epoch, pins.length]);

  const width = rootRef.current?.clientWidth ?? 0;

  // Resolve each pin's x. A pin scrolled out of the visible range yields null and renders nothing.
  const placed: Array<{ pin: ChartPin; index: number; x: number; alignLeft: boolean }> = [];
  if (isChartLive(chart) && pins.length > 0) {
    let leftScale = 0;
    try {
      leftScale = chart.priceScale('left').width() ?? 0;
    } catch {
      leftScale = 0;
    }
    pins.forEach((pin, index) => {
      let coord: number | null = null;
      try {
        coord = chart.timeScale().timeToCoordinate(pin.time as UTCTimestamp);
      } catch {
        coord = null;
      }
      // Scrolled out of the visible range — nothing to draw for this pin.
      if (coord == null || !Number.isFinite(coord)) return;
      const x = coord + leftScale + xAdjust;
      placed.push({ pin, index, x, alignLeft: width > 0 && x > width * 0.5 });
    });
  }

  // Cards are anchored to their own line, so two pins far apart never interact. When they are
  // close enough to overlap, push the later card below the earlier one instead of letting them
  // stack illegibly. Measured rather than assumed, because card height varies with leg count.
  useLayoutEffect(() => {
    const h = rootRef.current?.clientHeight ?? 0;
    const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const el of cardRefs.current) {
      if (!el) continue;
      el.style.top = '8px';
      const r = el.getBoundingClientRect();
      const rootR = rootRef.current?.getBoundingClientRect();
      if (!rootR || r.width === 0) continue;
      const box = {
        left: r.left - rootR.left,
        right: r.right - rootR.left,
        top: 8,
        bottom: 8 + r.height,
      };
      for (const b of boxes) {
        const overlapsX = box.left < b.right && box.right > b.left;
        const overlapsY = box.top < b.bottom && box.bottom > b.top;
        if (overlapsX && overlapsY) {
          const shift = b.bottom - box.top + 6;
          box.top += shift;
          box.bottom += shift;
        }
      }
      if (h > 0 && box.top > h - 30) {
        const back = box.top - (h - 30);
        box.top -= back;
        box.bottom -= back;
      }
      el.style.top = `${box.top}px`;
      boxes.push(box);
    }

    // Centre the Δ strip on the midpoint, then pull it back inside the pane. Measured, because
    // its width depends on the leg count and it would otherwise be clipped at the edges.
    const strip = compareRef.current;
    const rootW = rootRef.current?.clientWidth ?? 0;
    if (strip && rootW > 0) {
      const sw = strip.getBoundingClientRect().width;
      const left = Math.max(4, Math.min(compareXRef.current - sw / 2, rootW - sw - 4));
      strip.style.left = `${left}px`;
    }
  });

  cardRefs.current = [];

  // Nothing pinned: render nothing at all, so an unpinned pane's DOM is exactly what it was
  // before pins existed.
  if (pins.length === 0) return null;

  // Midpoint of the two lines. With one pin scrolled off screen, hug the one still visible, so
  // the strip is always on show rather than vanishing with the pin.
  compareXRef.current =
    placed.length >= 2
      ? (placed[0].x + placed[placed.length - 1].x) / 2
      : placed.length === 1
        ? placed[0].x
        : width / 2;

  return (
    <div ref={rootRef} className="absolute inset-0 pointer-events-none z-40 overflow-hidden">
      {compare && (
        <div ref={compareRef} className="absolute" style={{ left: 0, bottom: 6 }}>
          {compare}
        </div>
      )}
      {placed.map(({ pin, index, x, alignLeft }) => (
        <React.Fragment key={pin.id}>
          <div
            className="absolute top-0 bottom-0"
            style={{ left: x, width: 0, borderLeft: `1px dashed ${pin.color}`, opacity: 0.85 }}
          />
          <button
            type="button"
            className="absolute pointer-events-auto rounded px-1 leading-none text-[9px] font-bold tracking-tight"
            style={{
              left: x,
              bottom: 4,
              transform: 'translateX(-50%)',
              background: pin.color,
              color: '#0b0e12',
            }}
            title="Remove this pin (Esc clears all)"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(pin.id);
            }}
          >
            {index + 1} ✕
          </button>
          <div
            ref={(el) => {
              cardRefs.current[index] = el;
            }}
            className="absolute"
            style={{
              left: alignLeft ? x - PIN_CARD_GAP : x + PIN_CARD_GAP,
              top: 8,
              transform: alignLeft ? 'translateX(-100%)' : undefined,
              borderLeft: `2px solid ${pin.color}`,
              borderRadius: 8,
            }}
          >
            {renderCard(pin, index)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
