import { useCallback, useEffect, useRef, useState } from 'react';

// Pinned crosshairs. A pin is a single timestamp: because every pane in a view shares one time
// axis, pinning once lights up the price, P&L and greeks panes together, which is the whole
// point — you pin 14:14, hover 15:37, pin again, and compare all three panes at both instants.
//
// Pins deliberately never touch lightweight-charts' own crosshair state. `setCrosshairPosition`
// is wiped by the next real mouse move, so a persistent crosshair has to be our own DOM element
// anyway — and staying out of the library's way means the existing hover sync (including the
// "only the hovered pane owns the crosshair" guard) is completely unaffected.

/** Slot colours. Index 0 is always the first pin, so line, badge and compare strip agree. */
export const PIN_COLORS = ['#38bdf8', '#fb923c'];

export interface ChartPin {
  id: number;
  /** Chart time (seconds), already snapped to a bar by the crosshair that produced it. */
  time: number;
  color: string;
}

function recolor(pins: ChartPin[]): ChartPin[] {
  return pins.map((p, i) => ({ ...p, color: PIN_COLORS[i % PIN_COLORS.length] }));
}

/**
 * Rolling pin list. `max` pins are kept; adding beyond that drops the oldest, and toggling a
 * time that is already pinned removes it. Escape clears everything.
 */
export function usePinnedTimes(max = 2) {
  const [pins, setPins] = useState<ChartPin[]>([]);
  const idRef = useRef(0);

  const togglePinAt = useCallback(
    (time: number | null | undefined) => {
      if (time == null || !Number.isFinite(time)) return;
      setPins((prev) => {
        const hit = prev.findIndex((p) => p.time === time);
        if (hit >= 0) return recolor(prev.filter((_, i) => i !== hit));
        idRef.current += 1;
        const next = [...prev, { id: idRef.current, time, color: PIN_COLORS[0] }];
        return recolor(next.slice(-max));
      });
    },
    [max],
  );

  const removePin = useCallback((id: number) => {
    setPins((prev) => recolor(prev.filter((p) => p.id !== id)));
  }, []);

  const clearPins = useCallback(() => {
    setPins((prev) => (prev.length ? [] : prev));
  }, []);

  const hasPins = pins.length > 0;
  useEffect(() => {
    if (!hasPins) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clearPins();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasPins, clearPins]);

  return { pins, togglePinAt, removePin, clearPins };
}

/**
 * Middle-click (mouse-wheel click), or Alt + left-click, on a chart pane.
 *
 * Bound in the capture phase so it lands before lightweight-charts' own canvas handlers, and
 * `preventDefault` on both `mousedown` and `auxclick` because otherwise Chrome on Windows opens
 * its autoscroll ring the moment the wheel button goes down.
 *
 * `resolveTime` is asked for the chart time to pin at the moment of the click, so the caller can
 * fall back to the click coordinate when it has no live crosshair time to hand.
 */
export function bindPinTrigger(
  el: HTMLElement | null | undefined,
  resolveTime: (e: MouseEvent) => number | null,
  onPin: (time: number | null) => void,
): () => void {
  if (!el) return () => {};
  const onMouseDown = (e: MouseEvent) => {
    const isMiddle = e.button === 1;
    const isAltLeft = e.button === 0 && e.altKey;
    if (!isMiddle && !isAltLeft) return;
    e.preventDefault();
    e.stopPropagation();
    onPin(resolveTime(e));
  };
  const onAuxClick = (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault();
  };
  el.addEventListener('mousedown', onMouseDown, true);
  el.addEventListener('auxclick', onAuxClick, true);
  return () => {
    el.removeEventListener('mousedown', onMouseDown, true);
    el.removeEventListener('auxclick', onAuxClick, true);
  };
}

/** Gap between a pinned line and its card, mirroring the hover tooltip's own offset. */
export const PIN_CARD_GAP = 14;

/** Vertical stagger so two pins close together don't stack their cards on top of each other. */
export const PIN_CARD_STAGGER = 14;
