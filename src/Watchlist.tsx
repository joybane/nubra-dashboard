import { useEffect, useRef, useState } from 'react';
import { useWatchlist } from './hooks/useWatchlistContext';
import { useWs } from './hooks/useWsContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import type {
  IndexTickData,
  Instrument,
  OhlcvData,
  OptionChainData,
  OptionLeg,
  WatchlistItem,
  WsMessage,
} from './types';
import { fmtPrice } from './lib/utils';

interface LivePrice {
  ltp: number;
  chg?: number;
}

interface WatchlistProps {
  onNavigateToChart?: (inst: Instrument) => void;
}

/** [underlying, expiry, exchange] — one option-chain feed the watchlist holds. */
type OcHold = [string, string, string];

/** A live chain tick younger than this stands in for the REST poll (as in OptionChain.tsx). */
const WS_FRESH_MS = 10_000;

/** Expiry compared on digits alone, so `20260929`, `2026-09-29` and a number all agree. */
function expiryDigits(expiry: string | number | undefined | null): string {
  return String(expiry ?? '').replace(/\D/g, '');
}

function chainKey(asset: string, expiry: string | number | undefined | null): string {
  return `${asset.toUpperCase()}|${expiryDigits(expiry)}`;
}

export default function Watchlist({ onNavigateToChart }: WatchlistProps = {}) {
  const { items, removeItem } = useWatchlist();
  const { subscribe } = useWs();
  const { openTicket } = usePaperTrading();
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});
  const pollRef = useRef<number | null>(null);
  // Mirrors `prices` for the poll below, which runs from a closure created once per item set.
  const pricesRef = useRef(prices);
  pricesRef.current = prices;
  // When the live option-chain feed last delivered each asset/expiry (key: chainKey). The REST poll
  // is a fallback for a silent feed; while the feed is flowing it was fetching a whole chain from
  // the broker every 2s per group just to re-read prices the socket had already pushed.
  const wsLastTickRef = useRef(new Map<string, number>());

  // Poll option chain REST API for option prices
  useEffect(() => {
    const optItems = items.filter(
      (i) => i.optionType && i.strike != null && i.expiry && i.underlying,
    );
    if (!optItems.length) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    async function fetchPrices(initial = false) {
      const groups = new Map<
        string,
        { underlying: string; expiry: string; exchange: string; items: WatchlistItem[] }
      >();
      for (const item of optItems) {
        const key = `${item.underlying}|${item.expiry}`;
        if (!groups.has(key))
          groups.set(key, {
            underlying: item.underlying,
            expiry: item.expiry!,
            exchange: item.exchange,
            items: [],
          });
        groups.get(key)!.items.push(item);
      }

      for (const { underlying, expiry, exchange, items: gItems } of groups.values()) {
        // Always fetch on the first pass, and whenever an item still has no price: a strike that
        // has not traded since the feed came up would otherwise never get one.
        const lastWs = wsLastTickRef.current.get(chainKey(underlying, expiry)) ?? 0;
        if (
          !initial &&
          Date.now() - lastWs < WS_FRESH_MS &&
          gItems.every((item) => pricesRef.current[item.id] != null)
        ) {
          continue;
        }
        try {
          const res = await fetch(
            `/api/optionchain/${encodeURIComponent(underlying)}?exchange=${exchange}&expiry=${expiry}`,
          );
          const data = (await res.json()) as { chain?: OptionChainData };
          const chain = data.chain;
          if (!chain) continue;

          for (const item of gItems) {
            const legList = item.optionType === 'CE' ? chain.ce : chain.pe;
            const leg = (legList || []).find((l) => {
              const sp = l.sp > 10000 ? l.sp / 100 : l.sp;
              return sp === item.strike;
            });
            if (leg?.ltp != null) {
              const ltp = Number(leg.ltp) / 100;
              const chg = leg.ltpchg ?? undefined;
              setPrices((prev) => {
                if (prev[item.id]?.ltp === ltp && prev[item.id]?.chg === chg) return prev;
                return { ...prev, [item.id]: { ltp, chg } };
              });
            }
          }
        } catch (e) {
          console.warn('[Watchlist] fetchPrices failed:', e);
        }
      }
    }

    fetchPrices(true);
    pollRef.current = window.setInterval(() => void fetchPrices(), 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(items.filter((i) => i.optionType).map((i) => i.id))]);

  // Subscribe OHLCV feeds + listen for index_tick & ohlcv for non-option watchlist items
  const { subscribeOC, unsubscribeOC, subscribeChart, unsubscribeChart } = useWs();
  const ocHeldRef = useRef(new Map<string, OcHold>());
  useEffect(
    () => () => {
      for (const hold of ocHeldRef.current.values()) unsubscribeOC(...hold);
      ocHeldRef.current = new Map();
    },
    [unsubscribeOC],
  );
  useEffect(() => {
    const spotItems = items.filter((i) => !i.optionType);
    if (!spotItems.length) return;

    // Subscribe each item to the OHLCV feed so ticks flow
    for (const item of spotItems) {
      const sym = (item.nubraName || item.underlying).toUpperCase();
      const payload = { indexes: [sym] };
      subscribeChart(payload, '1m', item.exchange);
    }

    const unsub1 = subscribe('index_tick', (msg: WsMessage) => {
      if (msg.type !== 'index_tick') return;
      const data = msg.data as IndexTickData;
      const ticks = [...(data.indexes || []), ...(data.instruments || [])];
      for (const tick of ticks) {
        const name = (tick.indexname || '').toUpperCase();
        for (const item of spotItems) {
          if (item.underlying.toUpperCase() === name && tick.index_value) {
            const ltp = parseFloat(tick.index_value);
            setPrices((prev) => {
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
            setPrices((prev) => {
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
        const payload = { indexes: [sym] };
        unsubscribeChart(payload, '1m', item.exchange);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subscribe,
    subscribeChart,
    unsubscribeChart,
    JSON.stringify(items.filter((i) => !i.optionType).map((i) => i.id)),
  ]);

  // Subscribe OC feeds for option watchlist items and update LTPs from WS
  useEffect(() => {
    const optItems = items.filter(
      (i) => i.optionType && i.strike != null && i.expiry && i.underlying,
    );
    // Diffed against what is already held, so adding or removing one chain never drops and
    // re-subscribes the others. These holds used to be taken and never released: every chain the
    // watchlist ever showed stayed subscribed for the life of the tab.
    const want = new Map<string, OcHold>();
    for (const item of optItems) {
      const key = `${item.underlying}:${item.expiry}:${item.exchange}`;
      if (!want.has(key)) want.set(key, [item.underlying, item.expiry!, item.exchange]);
    }
    const held = ocHeldRef.current;
    for (const [key, hold] of want) if (!held.has(key)) subscribeOC(...hold);
    for (const [key, hold] of held) if (!want.has(key)) unsubscribeOC(...hold);
    ocHeldRef.current = want;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    subscribeOC,
    unsubscribeOC,
    JSON.stringify(
      items
        .filter((i) => i.optionType)
        .map((i) => `${i.underlying}:${i.expiry}`)
        .filter((v, i, a) => a.indexOf(v) === i),
    ),
  ]);

  useEffect(() => {
    const optItems = items.filter((i) => i.optionType && i.strike != null);
    if (!optItems.length) return;
    const unsub1 = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const asset = (data.asset || '').toUpperCase();
      if (data.expiry) wsLastTickRef.current.set(chainKey(asset, data.expiry), Date.now());
      for (const item of optItems) {
        if (item.underlying.toUpperCase() !== asset) continue;
        // Only this item's own side. CE and PE legs used to be searched together, and since a
        // leg matched on ref_id *or* strike, a PE item took the price of the same-strike CE,
        // which comes first — the price flickered between the two until the REST poll reset it.
        const legs = (item.optionType === 'CE' ? data.ce : data.pe) || [];
        const byRef = item.ref_id
          ? legs.find((l) => Number(l.ref_id ?? l.refId ?? 0) === item.ref_id)
          : undefined;
        // A strike match means nothing on another expiry's chain; ref_id is unique per contract.
        const sameExpiry =
          !data.expiry || !item.expiry || expiryDigits(data.expiry) === expiryDigits(item.expiry);
        const leg = (byRef ??
          (sameExpiry
            ? legs.find((l) => (l.sp > 10000 ? l.sp / 100 : l.sp) === item.strike)
            : undefined)) as (OptionLeg & Record<string, unknown>) | undefined;
        if (leg?.ltp != null && Number(leg.ltp) > 0) {
          const ltp = Number(leg.ltp) / 100;
          setPrices((prev) => {
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
          setPrices((prev) => {
            if (prev[item.id]?.ltp === newLtp) return prev;
            return { ...prev, [item.id]: { ltp: newLtp, chg: prev[item.id]?.chg } };
          });
        }
      }
    });

    return () => {
      unsub1();
      unsub2();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, JSON.stringify(items.filter((i) => i.optionType).map((i) => i.id))]);

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
          const live = prices[item.id];
          const ltp = live?.ltp ?? item.ltpAtAdd;
          const chg = live?.chg;
          const pclr =
            chg == null
              ? 'text-[var(--text-muted)]'
              : chg >= 0
                ? 'text-[var(--green)]'
                : 'text-[var(--red)]';
          const ltpStr = `₹${fmtPrice(ltp)}`;

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
                  {item.exchange}
                  {item.expiry
                    ? ` · ${item.expiry.slice(4, 6)}/${item.expiry.slice(0, 4).slice(2)}`
                    : ''}
                </span>
              </div>

              {/* Price + change */}
              <div className="text-right pr-2">
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">{ltpStr}</div>
                {chg != null && (
                  <div className={`text-[10px] ${pclr}`}>
                    {chg >= 0 ? '+' : ''}
                    {chg.toFixed(2)}%
                  </div>
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
                    onClick={() =>
                      onNavigateToChart({
                        stock_name: item.displayName,
                        nubra_name: item.nubraName || '',
                        exchange: item.exchange,
                        ref_id: item.ref_id,
                        derivative_type: item.optionType ? 'OPT' : undefined,
                        option_type: item.optionType,
                        strike_price: item.strike ? item.strike * 100 : undefined,
                        expiry: item.expiry,
                        asset: item.underlying,
                      })
                    }
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
