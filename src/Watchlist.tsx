import { useEffect, useRef, useState } from 'react';
import { useWatchlist } from './hooks/useWatchlistContext';
import { useWs } from './hooks/useWsContext';
import type { IndexTickData, OptionChainData, WatchlistItem, WsMessage } from './types';
import { fmtPrice } from './lib/utils';

interface LivePrice { ltp: number; chg?: number }

export default function Watchlist() {
  const { items, removeItem } = useWatchlist();
  const { subscribe }         = useWs();
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
        } catch { /* ignore */ }
      }
    }

    fetchPrices();
    pollRef.current = window.setInterval(fetchPrices, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items.filter(i => i.optionType).map(i => i.id))]);

  // Subscribe to index_tick for spot/index watchlist items
  useEffect(() => {
    const indexItems = items.filter(i => !i.optionType);
    if (!indexItems.length) return;
    return subscribe('index_tick', (msg: WsMessage) => {
      if (msg.type !== 'index_tick') return;
      const data  = msg.data as IndexTickData;
      const ticks = [...(data.indexes || []), ...(data.instruments || [])];
      for (const tick of ticks) {
        const name = (tick.indexname || '').toUpperCase();
        for (const item of indexItems) {
          if (item.underlying.toUpperCase() === name && tick.index_value) {
            const ltp = parseFloat(tick.index_value);
            setPrices(prev => ({ ...prev, [item.id]: { ltp, chg: tick.changepercent ?? undefined } }));
          }
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(items.filter(i => !i.optionType).map(i => i.id))]);

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

              {/* Remove button */}
              <button
                onClick={() => removeItem(item.id)}
                className="w-5 text-[var(--text-muted)] hover:text-[var(--red)] opacity-0 group-hover:opacity-100 transition-opacity text-[12px]"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
