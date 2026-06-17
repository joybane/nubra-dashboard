import { createContext, useCallback, useContext, useState } from 'react';
import type { WatchlistItem } from '../types';
import { generateId } from '../lib/utils';

interface WatchlistContextValue {
  items:      WatchlistItem[];
  addItem:    (item: Omit<WatchlistItem, 'id'>) => void;
  removeItem: (id: string) => void;
  hasItem:    (ref_id: number | undefined, displayName: string) => boolean;
}

const WatchlistCtx = createContext<WatchlistContextValue | null>(null);

function load(): WatchlistItem[] {
  try { return JSON.parse(localStorage.getItem('nubra-watchlist') || '[]') as WatchlistItem[]; }
  catch { return []; }
}

export function WatchlistProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<WatchlistItem[]>(load);

  const addItem = useCallback((item: Omit<WatchlistItem, 'id'>) => {
    setItems((prev) => {
      if (item.ref_id && prev.some(i => i.ref_id === item.ref_id)) return prev;
      if (!item.ref_id && prev.some(i => i.displayName === item.displayName)) return prev;
      const next = [...prev, { ...item, id: generateId() }];
      localStorage.setItem('nubra-watchlist', JSON.stringify(next));
      return next;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const next = prev.filter(i => i.id !== id);
      localStorage.setItem('nubra-watchlist', JSON.stringify(next));
      return next;
    });
  }, []);

  const hasItem = useCallback((ref_id: number | undefined, displayName: string): boolean => {
    if (ref_id) return items.some(i => i.ref_id === ref_id);
    return items.some(i => i.displayName === displayName);
  }, [items]);

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
