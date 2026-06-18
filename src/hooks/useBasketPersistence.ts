import { useEffect, useState } from 'react';
import { formatExpiry } from '../lib/utils';

export interface SavedBasket {
  basket_id: string;
  name: string;
  symbol: string;
  expiry: string;
  legs: Array<Record<string, unknown>>;
  created_at: number;
}

export interface BasketPersistenceApi {
  savedBaskets: SavedBasket[];
  loadSavedBaskets: () => Promise<void>;
  saveBasket: (name: string, sym: string | null, expiry: string, legs: unknown[]) => Promise<{ ok: boolean; msg: string }>;
  deleteSavedBasket: (id: string) => Promise<void>;
}

export function useBasketPersistence(): BasketPersistenceApi {
  const [savedBaskets, setSavedBaskets] = useState<SavedBasket[]>([]);

  async function loadSavedBaskets() {
    try {
      const res = await fetch('/paper/baskets');
      const data = await res.json() as { baskets: SavedBasket[] };
      setSavedBaskets(data.baskets || []);
    } catch { /* ignore */ }
  }

  useEffect(() => { loadSavedBaskets(); }, []);

  async function saveBasket(name: string, sym: string | null, expiry: string, legs: unknown[]): Promise<{ ok: boolean; msg: string }> {
    if (!legs.length || !name.trim()) return { ok: false, msg: 'Name and legs required' };
    try {
      await fetch('/paper/baskets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), symbol: sym, expiry, legs }) });
      loadSavedBaskets();
      return { ok: true, msg: 'Strategy saved!' };
    } catch (e) {
      return { ok: false, msg: (e as Error).message };
    }
  }

  async function deleteSavedBasket(id: string) {
    try { await fetch(`/paper/baskets/${id}`, { method: 'DELETE' }); loadSavedBaskets(); } catch { /* ignore */ }
  }

  return { savedBaskets, loadSavedBaskets, saveBasket, deleteSavedBasket };
}
