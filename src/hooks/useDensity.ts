import { useEffect, useSyncExternalStore } from 'react';

const eventName = 'nubra-density-change';
const snapshot = () =>
  localStorage.getItem('nubra-density') === 'comfortable' ? 'comfortable' : 'compact';
function subscribe(listener: () => void) {
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(eventName, listener);
    window.removeEventListener('storage', listener);
  };
}

/** One preference shared by every shell, including switches without remounting. */
export function useDensity() {
  const density = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
  const toggleDensity = () => {
    localStorage.setItem('nubra-density', snapshot() === 'compact' ? 'comfortable' : 'compact');
    window.dispatchEvent(new Event(eventName));
  };
  return { density, toggleDensity };
}
