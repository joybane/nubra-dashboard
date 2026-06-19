import { useEffect, useState } from 'react';

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
  saveBasket: (name: string, sym: string | null, expiry: string, legs: unknown[], basketGroupId?: string) => Promise<{ ok: boolean; msg: string }>;
  deleteSavedBasket: (id: string) => Promise<void>;
  updateBasketName: (id: string, name: string) => Promise<void>;
  renameStrategy: (basketGroupId: string, name: string) => Promise<boolean>;
  getNextCustomName: () => string;
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

  function getNextCustomName(): string {
    const prefix = 'Custom Strategy';
    const existing = savedBaskets
      .map(b => b.name)
      .filter(n => n.startsWith(prefix))
      .map(n => {
        const suffix = n.slice(prefix.length).trim();
        return suffix === '' ? 0 : parseInt(suffix, 10);
      })
      .filter(n => !isNaN(n));
    const next = existing.length === 0 ? 1 : Math.max(...existing) + 1;
    return `${prefix} ${next}`;
  }

  async function saveBasket(name: string, sym: string | null, expiry: string, legs: unknown[], basketGroupId?: string): Promise<{ ok: boolean; msg: string }> {
    if (!legs.length || !name.trim()) return { ok: false, msg: 'Name and legs required' };
    try {
      await fetch('/paper/baskets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), symbol: sym, expiry, legs, basket_group_id: basketGroupId }) });
      loadSavedBaskets();
      return { ok: true, msg: 'Strategy saved!' };
    } catch (e) {
      return { ok: false, msg: (e as Error).message };
    }
  }

  async function deleteSavedBasket(id: string) {
    try { await fetch(`/paper/baskets/${id}`, { method: 'DELETE' }); loadSavedBaskets(); } catch { /* ignore */ }
  }

  async function updateBasketName(id: string, name: string) {
    try {
      await fetch(`/paper/baskets/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }) });
      loadSavedBaskets();
    } catch { /* ignore */ }
  }

  async function renameStrategy(basketGroupId: string, name: string): Promise<boolean> {
    try {
      const res = await fetch('/paper/strategy/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basket_group_id: basketGroupId, name: name.trim() }) });
      return res.ok;
    } catch { return false; }
  }

  return { savedBaskets, loadSavedBaskets, saveBasket, deleteSavedBasket, updateBasketName, renameStrategy, getNextCustomName };
}
