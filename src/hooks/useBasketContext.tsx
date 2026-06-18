import { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface BasketLegInput {
  strike:     number;
  optionType: 'CE' | 'PE';
  side:       'BUY' | 'SELL';
  ltp:        number;
  refId:      number | null;
  nubraName:  string;
  lotSize:    number;
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
  addLegFromChain: (leg: BasketLegInput) => void;
  legCount:        number;
  onLegAdded:      (cb: (leg: BasketLegInput) => void) => () => void;
}

const BasketContext = createContext<BasketContextValue | null>(null);

export function BasketProvider({ children }: { children: React.ReactNode }) {
  const [basketMode, setBasketMode] = useState(false);
  const [legCount, setLegCount]     = useState(0);
  const callbacks = useRef(new Set<(leg: BasketLegInput) => void>());

  const onLegAdded = useCallback((cb: (leg: BasketLegInput) => void) => {
    callbacks.current.add(cb);
    return () => { callbacks.current.delete(cb); };
  }, []);

  const addLegFromChain = useCallback((leg: BasketLegInput) => {
    for (const cb of callbacks.current) cb(leg);
    setLegCount(c => c + 1);
  }, []);

  const updateLegCount = useCallback((n: number) => setLegCount(n), []);

  return (
    <BasketContext.Provider value={{ basketMode, setBasketMode, addLegFromChain, legCount, onLegAdded }}>
      {children}
    </BasketContext.Provider>
  );
}

export function useBasket(): BasketContextValue & { updateLegCount: (n: number) => void } {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used within BasketProvider');
  return { ...ctx, updateLegCount: (n: number) => { /* noop — legCount managed by addLegFromChain */ } };
}
