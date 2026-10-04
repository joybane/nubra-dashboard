import { useEffect, useState } from 'react';
import type { Theme } from '../types';
import { parseTheme } from '../lib/experience';

function readTheme(): Theme {
  return parseTheme(document.documentElement.dataset.theme);
}

/** For standalone chart views that are not passed the app's theme as a prop. */
export function useAppearanceTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const read = () => setTheme(readTheme());
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    read();
    return () => observer.disconnect();
  }, []);
  return theme;
}
