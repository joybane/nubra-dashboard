import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { WatchlistItem } from '../types';
import { generateId } from '../lib/utils';

interface WatchlistContextValue {
  items: WatchlistItem[];
  addItem: (item: Omit<WatchlistItem, 'id'>) => void;
  removeItem: (id: string) => void;
  hasItem: (ref_id: number | undefined, displayName: string) => boolean;
}

const WatchlistCtx = createContext<WatchlistContextValue | null>(null);

const STORAGE_KEY = 'nubra-watchlist';

function load(): WatchlistItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as unknown;
    return Array.isArray(parsed) ? (parsed as WatchlistItem[]) : [];
  } catch {
    return [];
  }
}

/**
 * Guarded like the workspace's own persistence: a full or blocked quota throws, and this used to
 * throw from *inside* a state updater, which surfaces as a render error rather than a lost save.
 */
function save(items: WatchlistItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* the watchlist is a convenience — losing the write must not break the app */
  }
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<WatchlistItem[]>(load);

  // Persisting in an effect rather than in the updater keeps the updater pure, which is what
  // React's double-invoked development renders assume.
  useEffect(() => {
    save(items);
  }, [items]);

  const addItem = useCallback((item: Omit<WatchlistItem, 'id'>) => {
    setItems((prev) => {
      if (item.ref_id && prev.some((i) => i.ref_id === item.ref_id)) return prev;
      if (!item.ref_id && prev.some((i) => i.displayName === item.displayName)) return prev;
      return [...prev, { ...item, id: generateId() }];
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const hasItem = useCallback(
    (ref_id: number | undefined, displayName: string): boolean => {
      if (ref_id) return items.some((i) => i.ref_id === ref_id);
      return items.some((i) => i.displayName === displayName);
    },
    [items],
  );

  return (
    <WatchlistCtx.Provider value={{ items, addItem, removeItem, hasItem }}>
      {children}
    </WatchlistCtx.Provider>
  );
}

export function useWatchlist() {
  const ctx = useContext(WatchlistCtx);
  if (!ctx) throw new Error('useWatchlist must be inside WatchlistProvider');
  return ctx;
}
