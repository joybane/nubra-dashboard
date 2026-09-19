import { useLayoutEffect, useState } from 'react';
import { placePopup, type Placement } from '../lib/popupPlacement';

/**
 * Above every in-pane layer (the highest is OptionChain's z-[100]) but below app modals.
 */
export const SETTINGS_POPUP_Z = 150;

/**
 * Viewport-fixed position for a portalled popup, tracking its anchor.
 *
 * Portalling prevents overflow-hidden panes and the order tray from clipping or painting over
 * settings. Because the popup leaves its anchor's box, scroll and resize are re-measured here.
 */
export function useAnchoredPopup(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  popupRef: React.RefObject<HTMLElement | null>,
): Placement | null {
  const [pos, setPos] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const el = popupRef.current;
      setPos(
        placePopup(
          anchor,
          {
            width: el?.offsetWidth || 300,
            // scrollHeight remains the natural content height after maxHeight caps the popup.
            height: el?.scrollHeight || 0,
          },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };

    const schedule = () => {
      if (frame == null) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // Capture catches scroll events from non-window ancestor panes too.
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, anchorRef, popupRef]);

  return pos;
}
