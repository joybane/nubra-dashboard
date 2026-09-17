import { useCallback, useRef } from 'react';

interface SplitDividerProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
}

export default function SplitDivider({ direction, onResize }: SplitDividerProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragging.current = true;
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
      e.preventDefault();
      const handle = e.currentTarget;
      const pointerId = e.pointerId;
      handle.setPointerCapture(pointerId);
      const previousCursor = document.body.style.cursor;
      const previousSelection = document.body.style.userSelect;
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (ev: PointerEvent) => {
        if (!dragging.current || ev.pointerId !== pointerId) return;
        const pos = direction === 'horizontal' ? ev.clientX : ev.clientY;
        const delta = pos - lastPos.current;
        lastPos.current = pos;
        onResize(delta);
      };

      let finished = false;
      const finish = (ev?: Event) => {
        if (ev instanceof PointerEvent && ev.pointerId !== pointerId) return;
        if (finished) return;
        finished = true;
        dragging.current = false;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', finish, true);
        window.removeEventListener('pointercancel', finish, true);
        window.removeEventListener('blur', finish);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelection;
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', finish, true);
      window.addEventListener('pointercancel', finish, true);
      window.addEventListener('blur', finish);
    },
    [direction, onResize],
  );

  const isH = direction === 'horizontal';

  return (
    <div
      onPointerDown={onPointerDown}
      style={{ touchAction: 'none' }}
      className={`
        shrink-0 bg-[var(--border)] transition-colors hover:bg-[var(--accent)] select-none z-10
        ${isH ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
      `}
    />
  );
}
