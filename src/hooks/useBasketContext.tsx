import { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface BasketLegInput {
  id?:        string;
  strike:     number;
  optionType: 'CE' | 'PE';
  side:       'BUY' | 'SELL';
  ltp:        number;
  refId:      number | null;
  nubraName:  string;
  lotSize:    number;
  qty?:       number;
  asset:      string;
  expiry:     string;
  iv:         number | null;
  delta:      number | null;
  gamma:      number | null;
  theta:      number | null;
  vega:       number | null;
}

interface BasketContextValue {
  basketMode:      boolean;
  setBasketMode:   (on: boolean) => void;
  legs:            BasketLegInput[];
  addLegFromChain: (leg: BasketLegInput) => void;
  removeLeg:       (index: number) => void;
  updateLegQty:    (index: number, qty: number) => void;
  clearBasket:     () => void;
  legCount:        number;
  onLegAdded:      (cb: (leg: BasketLegInput) => void) => () => void;
}

const BasketContext = createContext<BasketContextValue | null>(null);

export function BasketProvider({ children }: { children: React.ReactNode }) {
  const [basketMode, setBasketMode] = useState(false);
  const [legs, setLegs]             = useState<BasketLegInput[]>([]);
  const callbacks = useRef(new Set<(leg: BasketLegInput) => void>());

  const onLegAdded = useCallback((cb: (leg: BasketLegInput) => void) => {
    callbacks.current.add(cb);
    return () => { callbacks.current.delete(cb); };
  }, []);

  const addLegFromChain = useCallback((leg: BasketLegInput) => {
    const newLeg = { ...leg, qty: leg.qty || leg.lotSize || 65, id: String(Date.now() + Math.random()) };
    setLegs(prev => [...prev, newLeg]);
    for (const cb of callbacks.current) cb(newLeg);
  }, []);

  const removeLeg = useCallback((index: number) => {
    setLegs(prev => prev.filter((_, i) => i !== index));
  }, []);

  const updateLegQty = useCallback((index: number, qty: number) => {
    setLegs(prev => prev.map((l, i) => i === index ? { ...l, qty } : l));
  }, []);

  const clearBasket = useCallback(() => {
    setLegs([]);
  }, []);

  return (
    <BasketContext.Provider value={{
      basketMode, setBasketMode, legs, addLegFromChain, removeLeg, updateLegQty, clearBasket, legCount: legs.length, onLegAdded,
    }}>
      {children}
    </BasketContext.Provider>
  );
}

export function useBasket(): BasketContextValue & { updateLegCount: (n: number) => void } {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used within BasketProvider');
  return { ...ctx, updateLegCount: (n: number) => {} };
}
