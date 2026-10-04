import { useEffect, type RefObject } from 'react';

/** Keyboard support for the existing inline menus without changing their placement. */
export function useMenuKeyboard(
  root: RefObject<HTMLDivElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const host = root.current;
    if (!host) return;
    const items = () =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    const active = items().find((item) => item.getAttribute('aria-checked') === 'true');
    (active || items()[0])?.focus();
    // close changes identity as callers render; focus only once per opening.
  }, [root, open]);
  useEffect(() => {
    if (!open) return;
    const host = root.current;
    if (!host) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        host.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus();
      } else if (event.key === 'Tab') {
        close();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(
          host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
        );
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index]?.focus();
      }
    };
    host.addEventListener('keydown', onKey);
    return () => host.removeEventListener('keydown', onKey);
  }, [root, open, close]);
}
