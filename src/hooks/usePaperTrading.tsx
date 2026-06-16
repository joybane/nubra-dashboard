import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { Instrument } from '../types';

export type UatStatus = 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated';

export interface OrderTicketConfig {
  instrument: Instrument | null;
  side: 'BUY' | 'SELL';
}

interface PaperTradingCtx {
  uatStatus:      UatStatus;
  refMapSize:     number;
  refreshUatStatus: () => Promise<void>;
  ticketOpen:     boolean;
  ticketConfig:   OrderTicketConfig;
  openTicket:     (cfg?: Partial<OrderTicketConfig>) => void;
  closeTicket:    () => void;
}

const Ctx = createContext<PaperTradingCtx | null>(null);

export function PaperTradingProvider({ children }: { children: React.ReactNode }) {
  const [uatStatus,  setUatStatus]  = useState<UatStatus>('idle');
  const [refMapSize, setRefMapSize] = useState(0);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketConfig, setTicketConfig] = useState<OrderTicketConfig>({ instrument: null, side: 'BUY' });

  const refreshUatStatus = useCallback(async () => {
    try {
      const res = await fetch('/paper/auth/status');
      const d   = await res.json() as { status: UatStatus; refMapSize: number };
      setUatStatus(d.status);
      setRefMapSize(d.refMapSize ?? 0);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refreshUatStatus(); }, [refreshUatStatus]);

  const openTicket = useCallback((cfg?: Partial<OrderTicketConfig>) => {
    setTicketConfig((prev) => ({ ...prev, ...cfg }));
    setTicketOpen(true);
  }, []);

  const closeTicket = useCallback(() => setTicketOpen(false), []);

  return (
    <Ctx.Provider value={{ uatStatus, refMapSize, refreshUatStatus, ticketOpen, ticketConfig, openTicket, closeTicket }}>
      {children}
    </Ctx.Provider>
  );
}

export function usePaperTrading(): PaperTradingCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePaperTrading must be inside PaperTradingProvider');
  return ctx;
}
