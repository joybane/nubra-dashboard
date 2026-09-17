import { useEffect, useState } from 'react';
import type { Theme } from '../types';

function readTheme(): Theme {
  const value = document.documentElement.dataset.theme;
  return value === 'light' || value === 'bloomberg' || value === 'graphite' ? value : 'dark';
}

/** For standalone chart views that are not passed the app's theme as a prop. */
export function useAppearanceTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const read = () => setTheme(readTheme());
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    read();
    return () => observer.disconnect();
  }, []);
  return theme;
}
