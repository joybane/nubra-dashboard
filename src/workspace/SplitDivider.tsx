import { useCallback, useRef } from 'react';

interface SplitDividerProps {
  direction:  'horizontal' | 'vertical';
  onResize:   (delta: number) => void;
}

export default function SplitDivider({ direction, onResize }: SplitDividerProps) {
  const dragging = useRef(false);
  const lastPos  = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    lastPos.current  = direction === 'horizontal' ? e.clientX : e.clientY;
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const pos   = direction === 'horizontal' ? ev.clientX : ev.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      onResize(delta);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [direction, onResize]);

  const isH = direction === 'horizontal';

  return (
    <div
      onMouseDown={onMouseDown}
      className={`
        shrink-0 bg-[var(--border)] transition-colors hover:bg-[var(--accent)] select-none z-10
        ${isH ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'}
      `}
    />
  );
}
