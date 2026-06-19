import { useEffect, useRef, useState } from 'react';
import { useWatchlist } from './hooks/useWatchlistContext';
import { useWs } from './hooks/useWsContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import type { IndexTickData, Instrument, OhlcvData, OptionChainData, OptionLeg, WatchlistItem, WsMessage } from './types';
import { fmtPrice } from './lib/utils';

const KNOWN_INDICES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'NIFTY50']);

interface LivePrice { ltp: number; chg?: number }

interface WatchlistProps {
  onNavigateToChart?: (inst: Instrument) => void;
}

export default function Watchlist({ onNavigateToChart }: WatchlistProps = {}) {
  const { items, removeItem } = useWatchlist();
  const { subscribe }         = useWs();
  const { openTicket }        = usePaperTrading();
  const [prices, setPrices]   = useState<Record<string, LivePrice>>({});
  const pollRef               = useRef<number | null>(null);

  // Poll option chain REST API for option prices
  useEffect(() => {
    const optItems = items.filter(i => i.optionType && i.strike != null && i.expiry && i.underlying);
    if (!optItems.length) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    async function fetchPrices() {
      const groups = new Map<string, { underlying: string; expiry: string; exchange: string; items: WatchlistItem[] }>();
      for (const item of optItems) {
        const key = `${item.underlying}|${item.expiry}`;
        if (!groups.has(key)) groups.set(key, { underlying: item.underlying, expiry: item.expiry!, exchange: item.exchange, items: [] });
        groups.get(key)!.items.push(item);
      }

      for (const { underlying, expiry, exchange, items: gItems } of groups.values()) {
        try {
          const res  = await fetch(`/api/optionchain/${encodeURIComponent(underlying)}?exchange=${exchange}&expiry=${expiry}`);
          const data = await res.json() as { chain?: OptionChainData };
          const chain = data.chain;
          if (!chain) continue;

          for (const item of gItems) {
            const legList = item.optionType === 'CE' ? chain.ce : chain.pe;
            const leg = (legList || []).find(l => {
              const sp = l.sp > 10000 ? l.sp / 100 : l.sp;
              return sp === item.strike;
            });
            if (leg?.ltp != null) {
              const ltp = Number(leg.ltp) / 100;
              setPrices(prev => ({ ...prev, [item.id]: { ltp, chg: leg.ltpchg ?? undefined } }));
            }
          }
        } catch (e) { console.warn('[Watchlist] fetchPrices failed:', e); }
      }
    }

    fetchPrices();
    pollRef.current = window.setInterval(fetchPrices, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items.filter(i => i.optionType).map(i => i.id))]);

  // Subscribe OHLCV feeds + listen for index_tick & ohlcv for non-option watchlist items
  const { subscribeOC, subscribeChart, unsubscribeChart } = useWs();
  useEffect(() => {
    const spotItems = items.filter(i => !i.optionType);
    if (!spotItems.length) return;

    // Subscribe each item to the OHLCV feed so ticks flow
    for (const item of spotItems) {
      const sym = (item.nubraName || item.underlying).toUpperCase();
      const isIdx = KNOWN_INDICES.has(item.underlying.toUpperCase());
      const payload = isIdx ? { indexes: [sym] } : { instruments: [sym] };
      subscribeChart(payload, '1m', item.exchange);
    }

    const unsub1 = subscribe('index_tick', (msg: WsMessage) => {
      if (msg.type !== 'index_tick') return;
      const data  = msg.data as IndexTickData;
      const ticks = [...(data.indexes || []), ...(data.instruments || [])];
      for (const tick of ticks) {
        const name = (tick.indexname || '').toUpperCase();
        for (const item of spotItems) {
          if (item.underlying.toUpperCase() === name && tick.index_value) {
            const ltp = parseFloat(tick.index_value);
            setPrices(prev => {
              if (prev[item.id]?.ltp === ltp) return prev;
              return { ...prev, [item.id]: { ltp, chg: tick.changepercent ?? undefined } };
            });
          }
        }
      }
    });

    const unsub2 = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv') return;
      const data = msg.data as OhlcvData;
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const name = (b.indexname || '').toUpperCase();
        if (!b.close) continue;
        for (const item of spotItems) {
          const sym = (item.nubraName || item.underlying).toUpperCase();
          if (sym === name || item.underlying.toUpperCase() === name) {
            const ltp = Number(b.close) / 100;
            setPrices(prev => {
              if (prev[item.id]?.ltp === ltp) return prev;
              return { ...prev, [item.id]: { ltp, chg: prev[item.id]?.chg } };
            });
          }
        }
      }
    });

    return () => {
      unsub1();
      unsub2();
      for (const item of spotItems) {
        const sym = (item.nubraName || item.underlying).toUpperCase();
        const isIdx = KNOWN_INDICES.has(item.underlying.toUpperCase());
        const payload = isIdx ? { indexes: [sym] } : { instruments: [sym] };
        unsubscribeChart(payload, '1m', item.exchange);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, subscribeChart, unsubscribeChart, JSON.stringify(items.filter(i => !i.optionType).map(i => i.id))]);

  // Subscribe OC feeds for option watchlist items and update LTPs from WS
  useEffect(() => {
    const optItems = items.filter(i => i.optionType && i.strike != null && i.expiry && i.underlying);
    if (!optItems.length) return;
    const seen = new Set<string>();
    for (const item of optItems) {
      const key = `${item.underlying}:${item.expiry}`;
      if (!seen.has(key)) { seen.add(key); subscribeOC(item.underlying, item.expiry!, item.exchange); }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeOC, JSON.stringify(items.filter(i => i.optionType).map(i => `${i.underlying}:${i.expiry}`).filter((v,i,a) => a.indexOf(v)===i))]);

  useEffect(() => {
    const optItems = items.filter(i => i.optionType && i.strike != null);
    if (!optItems.length) return;
    const unsub1 = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const asset = (data.asset || '').toUpperCase();
      const allLegs = [...(data.ce || []), ...(data.pe || [])];
      for (const item of optItems) {
        if (item.underlying.toUpperCase() !== asset) continue;
        const leg = allLegs.find(l => {
          const leg_ = l as OptionLeg & Record<string, unknown>;
          const refId = Number(leg_.ref_id ?? leg_.refId ?? 0);
          if (item.ref_id && refId === item.ref_id) return true;
          const sp = l.sp > 10000 ? l.sp / 100 : l.sp;
          return sp === item.strike;
        }) as (OptionLeg & Record<string, unknown>) | undefined;
        if (leg?.ltp != null && Number(leg.ltp) > 0) {
          const ltp = Number(leg.ltp) / 100;
          setPrices(prev => {
            if (prev[item.id]?.ltp === ltp) return prev;
            return { ...prev, [item.id]: { ltp, chg: (leg.ltpchg as number) ?? undefined } };
          });
        }
      }
    });

    const unsub2 = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = (msg as { data: { ref_id: number; ltp: number }[] }).data;
      if (!updates?.length) return;
      const ltpMap = new Map<number, number>();
      for (const u of updates) ltpMap.set(u.ref_id, u.ltp / 100);
      for (const item of optItems) {
        if (!item.ref_id) continue;
        const newLtp = ltpMap.get(item.ref_id);
        if (newLtp != null) {
          setPrices(prev => {
            if (prev[item.id]?.ltp === newLtp) return prev;
            return { ...prev, [item.id]: { ltp: newLtp, chg: prev[item.id]?.chg } };
          });
        }
      }
    });

    return () => { unsub1(); unsub2(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(items.filter(i => i.optionType).map(i => i.id))]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-2 text-[var(--text-muted)]">
        <span className="text-2xl">★</span>
        <span className="text-[14px]">Watchlist is empty</span>
        <span className="text-[12px] text-center max-w-[220px]">
          Hover an option chain row and click ★CE or ★PE to add items
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-8 shrink-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center px-3">
        <span className="text-[12px] font-semibold text-[var(--text-secondary)]">
          Watchlist <span className="text-[var(--text-muted)]">({items.length})</span>
        </span>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {/* Column header */}
        <div className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] grid grid-cols-[1fr_auto_auto] px-3 py-1 text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">
          <span>Symbol</span>
          <span className="text-right pr-6">LTP</span>
          <span className="w-5" />
        </div>

        {items.map((item) => {
          const live    = prices[item.id];
          const ltp     = live?.ltp ?? item.ltpAtAdd;
          const chg     = live?.chg;
          const pclr    = chg == null ? 'text-[var(--text-muted)]' : chg >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]';
          const ltpStr  = `₹${fmtPrice(ltp)}`;

          return (
            <div
              key={item.id}
              className="group grid grid-cols-[1fr_auto_auto] items-center px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              {/* Name + exchange */}
              <div className="flex flex-col min-w-0">
                <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
                  {item.displayName}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">
                  {item.exchange}{item.expiry ? ` · ${item.expiry.slice(4, 6)}/${item.expiry.slice(0, 4).slice(2)}` : ''}
                </span>
              </div>

              {/* Price + change */}
              <div className="text-right pr-2">
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">{ltpStr}</div>
                {chg != null && (
                  <div className={`text-[10px] ${pclr}`}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</div>
                )}
              </div>

              {/* Action buttons — visible on hover */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => {
                    const inst: Instrument = {
                      stock_name: item.displayName,
                      nubra_name: item.nubraName || '',
                      exchange: item.exchange,
                      ref_id: item.ref_id,
                      derivative_type: item.optionType ? 'OPT' : undefined,
                      option_type: item.optionType,
                      strike_price: item.strike ? item.strike * 100 : undefined,
                      expiry: item.expiry,
                      asset: item.underlying,
                    };
                    openTicket({ instrument: inst, side: 'BUY', ltp: ltp });
                  }}
                  className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white bg-[var(--green)] hover:brightness-110"
                >
                  B
                </button>
                <button
                  onClick={() => {
                    const inst: Instrument = {
                      stock_name: item.displayName,
                      nubra_name: item.nubraName || '',
                      exchange: item.exchange,
                      ref_id: item.ref_id,
                      derivative_type: item.optionType ? 'OPT' : undefined,
                      option_type: item.optionType,
                      strike_price: item.strike ? item.strike * 100 : undefined,
                      expiry: item.expiry,
                      asset: item.underlying,
                    };
                    openTicket({ instrument: inst, side: 'SELL', ltp: ltp });
                  }}
                  className="px-1.5 py-0.5 rounded text-[9px] font-bold text-white bg-[var(--red)] hover:brightness-110"
                >
                  S
                </button>
                {onNavigateToChart && (
                  <button
                    onClick={() => onNavigateToChart({
                      stock_name: item.displayName,
                      nubra_name: item.nubraName || '',
                      exchange: item.exchange,
                      ref_id: item.ref_id,
                      derivative_type: item.optionType ? 'OPT' : undefined,
                      option_type: item.optionType,
                      strike_price: item.strike ? item.strike * 100 : undefined,
                      expiry: item.expiry,
                      asset: item.underlying,
                    })}
                    className="px-1.5 py-0.5 rounded text-[9px] font-bold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30"
                  >
                    C
                  </button>
                )}
                <button
                  onClick={() => removeItem(item.id)}
                  className="px-1 py-0.5 text-[var(--text-muted)] hover:text-[var(--red)] text-[10px]"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
