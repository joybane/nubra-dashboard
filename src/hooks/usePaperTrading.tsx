import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Instrument } from '../types';

export type AuthStatus = 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated';

export interface OrderTicketConfig {
  instrument: Instrument | null;
  side: 'BUY' | 'SELL';
  ltp?: number;
  ltpChg?: number;
  qty?: number;
}

interface PaperTradingCtx {
  authenticated:    boolean;
  refreshAuthStatus: () => Promise<void>;
  ticketOpen:       boolean;
  ticketConfig:     OrderTicketConfig;
  openTicket:       (cfg?: Partial<OrderTicketConfig>) => void;
  closeTicket:      () => void;
}

const Ctx = createContext<PaperTradingCtx | null>(null);

export function PaperTradingProvider({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [ticketOpen,    setTicketOpen]    = useState(false);
  const [ticketConfig,  setTicketConfig]  = useState<OrderTicketConfig>({ instrument: null, side: 'BUY' });

  const refreshAuthStatus = useCallback(async () => {
    try {
      const res = await fetch('/paper/auth/status');
      const d   = await res.json() as { authenticated: boolean };
      setAuthenticated(d.authenticated);
    } catch (e) { console.warn('[Auth] refreshAuthStatus failed:', e); }
  }, []);

  useEffect(() => { refreshAuthStatus(); }, [refreshAuthStatus]);

  const openTicket = useCallback((cfg?: Partial<OrderTicketConfig>) => {
    setTicketConfig((prev) => ({ ...prev, ...cfg }));
    setTicketOpen(true);
  }, []);

  const closeTicket = useCallback(() => setTicketOpen(false), []);

  return (
    <Ctx.Provider value={{ authenticated, refreshAuthStatus, ticketOpen, ticketConfig, openTicket, closeTicket }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePaperTrading(): PaperTradingCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePaperTrading must be inside PaperTradingProvider');
  return ctx;
}
