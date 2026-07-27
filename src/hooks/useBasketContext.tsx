import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { WsMessage } from '../types';
import { generateId } from '../lib/utils';
import { useWs } from './useWsContext';
import { useMarginCalc, type MarginData } from './useMarginCalc';
import { useBasketPersistence, type BasketPersistenceApi } from './useBasketPersistence';

/**
 * The single basket shared by the Option Chain drawer and the Basket tab builder.
 *
 * Both surfaces render *the same* legs: this provider owns the leg list, keeps it
 * priced from the live feed, computes margin once, and places orders through one
 * code path so a basket traded from either place lands as one strategy group.
 */

export interface BasketLeg {
  id:           string;
  symbol:       string;
  asset:        string;
  exchange:     string;
  optionType:   'CE' | 'PE';
  side:         'BUY' | 'SELL';
  strike:       number;
  expiry:       string;
  lots:         number;
  lotSize:      number;
  ltp:          number;
  entryLtp:     number;
  refId:        number | null;
  nubraName:    string;
  orderType:    'MKT' | 'LIMIT' | 'SL';
  limitPrice:   number | null;
  triggerPrice: number | null;
  deliveryType: 'IDAY' | 'CNC';
  iv:           number | null;
  delta:        number | null;
  gamma:        number | null;
  theta:        number | null;
  vega:         number | null;
}

/** What a caller must supply to add a leg — the rest gets sensible defaults. */
export type NewLegInput =
  Omit<BasketLeg, 'id' | 'symbol' | 'entryLtp' | 'lots' | 'orderType' | 'limitPrice' | 'triggerPrice' | 'deliveryType'>
  & Partial<Pick<BasketLeg, 'id' | 'symbol' | 'entryLtp' | 'lots' | 'orderType' | 'limitPrice' | 'triggerPrice' | 'deliveryType'>>;

export interface PlaceBasketOptions {
  /** Expiry recorded on the saved strategy — defaults to the first leg's expiry. */
  expiry?: string;
  /** Underlying recorded on the saved strategy — defaults to the first leg's asset. */
  symbol?: string | null;
}

interface BasketContextValue {
  basketMode:      boolean;
  setBasketMode:   (on: boolean) => void;
  legs:            BasketLeg[];
  setLegs:         React.Dispatch<React.SetStateAction<BasketLeg[]>>;
  addLeg:          (leg: NewLegInput) => string;
  removeLeg:       (id: string) => void;
  updateLeg:       (id: string, patch: Partial<BasketLeg>) => void;
  clearBasket:     () => void;
  legCount:        number;
  multiplier:      number;
  applyMultiplier: (n: number) => void;
  strategyName:    string;
  setStrategyName: (name: string) => void;
  exchange:        string;
  /** Call from an effect while a basket UI is on screen; margin only runs for viewers. */
  registerViewer:  () => () => void;
  margin:          MarginData | null;
  marginLoading:   boolean;
  marginError:     string;
  persistence:     BasketPersistenceApi;
  placeBasket:     (opts?: PlaceBasketOptions) => Promise<{ ok: boolean; msg: string }>;
}

const ORDER_TYPE_MAP: Record<BasketLeg['orderType'], string> = {
  MKT:   'ORDER_TYPE_MARKET',
  LIMIT: 'ORDER_TYPE_REGULAR',
  SL:    'ORDER_TYPE_STOPLOSS',
};

const DEFAULT_STRATEGY_NAME = 'Custom Strategy';

/** Stable empty array — a fresh `[]` would re-trigger the margin effect. */
const NO_LEGS: BasketLeg[] = [];

const BasketContext = createContext<BasketContextValue | null>(null);

function numField(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (obj[k] != null && !isNaN(Number(obj[k]))) return Number(obj[k]);
  }
  return undefined;
}

interface StrikeUpdate {
  ltp?:   number;
  iv?:    number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?:  number;
}

/** `{strike → update}` for one side of an option_chain payload; prices are paise. */
function buildUpdateMap(rows: Array<Record<string, unknown>>): Map<number, StrikeUpdate> {
  const map = new Map<number, StrikeUpdate>();
  for (const r of rows) {
    const sp = Number(r.sp) > 10000 ? Number(r.sp) / 100 : Number(r.sp);
    map.set(sp, {
      ltp:   r.ltp != null ? Number(r.ltp) / 100 : undefined,
      iv:    numField(r, 'iv', 'implied_volatility'),
      delta: numField(r, 'delta'),
      gamma: numField(r, 'gamma'),
      theta: numField(r, 'theta'),
      vega:  numField(r, 'vega'),
    });
  }
  return map;
}

export function BasketProvider({ children }: { children: React.ReactNode }) {
  const [basketMode,   setBasketMode]   = useState(false);
  const [legs,         setLegs]         = useState<BasketLeg[]>([]);
  const [multiplier,   setMultiplier]   = useState(1);
  const [strategyName, setStrategyName] = useState(DEFAULT_STRATEGY_NAME);

  const { subscribe, subscribeOC, unsubscribeOC, wsReady } = useWs();
  const persistence = useBasketPersistence();

  const exchange = legs[0]?.exchange || 'NSE';

  const addLeg = useCallback((leg: NewLegInput): string => {
    const id = leg.id || generateId();
    setLegs(prev => [...prev, {
      ...leg,
      id,
      symbol:       leg.symbol ?? leg.asset,
      entryLtp:     leg.entryLtp ?? leg.ltp,
      lots:         leg.lots ?? 1,
      orderType:    leg.orderType ?? 'MKT',
      limitPrice:   leg.limitPrice ?? null,
      triggerPrice: leg.triggerPrice ?? null,
      deliveryType: leg.deliveryType ?? 'IDAY',
    }]);
    return id;
  }, []);

  const removeLeg = useCallback((id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  const updateLeg = useCallback((id: string, patch: Partial<BasketLeg>) => {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, ...patch } : l));
  }, []);

  const clearBasket = useCallback(() => {
    setLegs([]);
    setMultiplier(1);
    setStrategyName(DEFAULT_STRATEGY_NAME);
  }, []);

  const applyMultiplier = useCallback((newMult: number) => {
    if (newMult < 1 || newMult === multiplier) return;
    const ratio = newMult / multiplier;
    setLegs(prev => prev.map(l => ({ ...l, lots: Math.max(1, Math.round(l.lots * ratio)) })));
    setMultiplier(newMult);
  }, [multiplier]);

  // ── Live pricing ───────────────────────────────────────────────────────────
  // Legs can span symbols and expiries the visible chain isn't showing, so the
  // basket subscribes for its own legs rather than piggybacking on a view.
  const legFeedKey = useMemo(
    () => JSON.stringify([...new Set(legs.map(l => `${l.asset}|${l.expiry}|${l.exchange}`))].sort()),
    [legs],
  );

  useEffect(() => {
    const feeds = (JSON.parse(legFeedKey) as string[]).map(k => k.split('|'));
    if (!feeds.length || !wsReady) return;
    for (const [asset, expiry, exch] of feeds) {
      if (asset && expiry) subscribeOC(asset, expiry, exch || 'NSE');
    }
    return () => {
      for (const [asset, expiry, exch] of feeds) {
        if (asset && expiry) unsubscribeOC(asset, expiry, exch || 'NSE');
      }
    };
  }, [legFeedKey, wsReady, subscribeOC, unsubscribeOC]);

  useEffect(() => {
    const unsubOc = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const d = msg.data as unknown as Record<string, unknown> | undefined;
      if (!d) return;
      const asset  = String(d.asset || '').toUpperCase();
      const expiry = String(d.expiry || '');
      const ceMap  = buildUpdateMap((d.ce || []) as Array<Record<string, unknown>>);
      const peMap  = buildUpdateMap((d.pe || []) as Array<Record<string, unknown>>);

      setLegs(prev => {
        let changed = false;
        const next = prev.map(leg => {
          if (leg.expiry !== expiry || leg.asset.toUpperCase() !== asset) return leg;
          const u = (leg.optionType === 'CE' ? ceMap : peMap).get(leg.strike);
          if (!u) return leg;
          const merged = {
            ...leg,
            ltp:   u.ltp   ?? leg.ltp,
            iv:    u.iv    ?? leg.iv,
            delta: u.delta ?? leg.delta,
            gamma: u.gamma ?? leg.gamma,
            theta: u.theta ?? leg.theta,
            vega:  u.vega  ?? leg.vega,
          };
          if (merged.ltp !== leg.ltp || merged.iv !== leg.iv || merged.delta !== leg.delta
            || merged.gamma !== leg.gamma || merged.theta !== leg.theta || merged.vega !== leg.vega) {
            changed = true;
            return merged;
          }
          return leg;
        });
        return changed ? next : prev;
      });
    });

    // Secondary feed: traded legs keep ticking from the positions stream.
    const unsubPos = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data;
      if (!updates?.length) return;
      const ltpMap = new Map<number, number>();
      for (const u of updates) ltpMap.set(u.ref_id, u.ltp / 100);
      setLegs(prev => {
        let changed = false;
        const next = prev.map(leg => {
          if (!leg.refId) return leg;
          const newLtp = ltpMap.get(leg.refId);
          if (newLtp != null && newLtp !== leg.ltp) { changed = true; return { ...leg, ltp: newLtp }; }
          return leg;
        });
        return changed ? next : prev;
      });
    });

    return () => { unsubOc(); unsubPos(); };
  }, [subscribe]);

  // ── Margin ─────────────────────────────────────────────────────────────────
  // The margin endpoint echoes back resolved instruments, which is how legs that
  // were added without a ref_id (saved baskets, templates) get one.
  const onLegsResolved = useCallback((resolved: Array<Record<string, unknown>>) => {
    setLegs(prev => {
      let changed = false;
      const next = prev.map(leg => {
        const found = resolved.find(r =>
          Number(r.strike) === leg.strike && r.optionType === leg.optionType && r.expiry === leg.expiry);
        if (!found) return leg;
        const refId     = (found.refId as number | null | undefined) ?? leg.refId;
        const ltp       = (found.ltp as number | undefined) ?? leg.ltp;
        const nubraName = (found.nubraName as string | undefined) ?? leg.nubraName;
        if (refId === leg.refId && ltp === leg.ltp && nubraName === leg.nubraName
          && (found.delta as number | undefined) === leg.delta) return leg;
        changed = true;
        return {
          ...leg,
          refId, ltp, nubraName,
          iv:      (found.iv    as number | null | undefined) ?? leg.iv,
          delta:   (found.delta as number | null | undefined) ?? leg.delta,
          gamma:   (found.gamma as number | null | undefined) ?? leg.gamma,
          theta:   (found.theta as number | null | undefined) ?? leg.theta,
          vega:    (found.vega  as number | null | undefined) ?? leg.vega,
          lotSize: (found.lotSize as number | undefined) || leg.lotSize,
        };
      });
      return changed ? next : prev;
    });
  }, []);

  // The provider outlives every basket UI, so margin is only calculated while a
  // surface is actually displaying it — otherwise a forgotten basket would keep
  // hitting the broker margin endpoint on every price tick.
  const [viewers, setViewers] = useState(0);
  const registerViewer = useCallback(() => {
    setViewers(v => v + 1);
    return () => setViewers(v => Math.max(0, v - 1));
  }, []);

  const marginLegs = viewers > 0 ? legs : NO_LEGS;
  const { margin, loading: marginLoading, error: marginError } =
    useMarginCalc(marginLegs, exchange, multiplier, onLegsResolved);

  // ── Order placement ────────────────────────────────────────────────────────
  const fetchMarginRequiredPaise = useCallback(async (orderLegs: BasketLeg[]): Promise<number | undefined> => {
    const validLegs = orderLegs.filter(l => l.strike > 0 && l.lots > 0 && l.lotSize > 0);
    if (!validLegs.length) return undefined;
    const res = await fetch('/paper/margin/basket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exchange,
        multiplier,
        orders: validLegs.map(l => ({
          ref_id: l.refId,
          order_qty: l.lots * l.lotSize,
          strike: l.strike,
          option_type: l.optionType,
          ltp: l.ltp,
          lot_size: l.lotSize,
          expiry: l.expiry,
          symbol: l.symbol,
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
        })),
      }),
    });
    if (!res.ok) return undefined;
    const data = await res.json() as Record<string, unknown>;
    const total = Number(data.total_margin ?? 0);
    return total > 0 ? total : undefined;
  }, [exchange, multiplier]);

  const placeBasket = useCallback(async (opts?: PlaceBasketOptions): Promise<{ ok: boolean; msg: string }> => {
    if (!legs.length) return { ok: false, msg: 'Basket is empty' };
    const missing = legs.filter(l => !l.refId && !l.nubraName);
    if (missing.length) return { ok: false, msg: `${missing.length} leg(s) missing instrument IDs.` };
    // Buys first so the broker sees the hedge before the short leg.
    const sorted = [...legs].sort((a, b) => {
      if (a.side === 'BUY' && b.side === 'SELL') return -1;
      if (a.side === 'SELL' && b.side === 'BUY') return 1;
      return 0;
    });
    const finalName = strategyName && strategyName !== DEFAULT_STRATEGY_NAME
      ? strategyName
      : persistence.getNextCustomName();
    try {
      const marginRequired = margin?.total && margin.total > 0
        ? Math.round(margin.total * 100)
        : await fetchMarginRequiredPaise(sorted);
      if (!marginRequired) throw new Error('Margin unavailable. Please wait for the margin calculation and try again.');
      const res = await fetch('/paper/orders/basket', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy_name: finalName, margin_required: marginRequired, orders: sorted.map(l => ({
          nubraName: l.nubraName || `${l.symbol}${l.strike}${l.optionType}`, liveRefId: l.refId,
          display_name: `${l.symbol} ${l.strike} ${l.optionType}`, order_type: ORDER_TYPE_MAP[l.orderType],
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL', order_qty: l.lots * l.lotSize,
          order_price: l.limitPrice ? Math.round(l.limitPrice * 100) : undefined,
          trigger_price: l.triggerPrice ? Math.round(l.triggerPrice * 100) : undefined,
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
          validity_type: 'DAY', asset: l.asset, expiry: l.expiry, derivative_type: 'OPT',
        })) }),
      });
      const d = await res.json() as { orders?: Array<{ order_id: number }>; basket_group_id?: string; error?: string };
      if (!res.ok || d.error) throw new Error(d.error || 'Basket placement failed');
      persistence.saveBasket(finalName, opts?.symbol ?? legs[0].asset, opts?.expiry ?? legs[0].expiry, legs, d.basket_group_id);
      setStrategyName(DEFAULT_STRATEGY_NAME);
      return { ok: true, msg: `${d.orders?.length ?? legs.length} order(s) placed & saved as "${finalName}"` };
    } catch (e) {
      return { ok: false, msg: (e as Error).message };
    }
  }, [legs, strategyName, margin, persistence, fetchMarginRequiredPaise]);

  return (
    <BasketContext.Provider value={{
      basketMode, setBasketMode,
      legs, setLegs, addLeg, removeLeg, updateLeg, clearBasket, legCount: legs.length,
      multiplier, applyMultiplier,
      strategyName, setStrategyName,
      exchange, registerViewer,
      margin, marginLoading, marginError,
      persistence, placeBasket,
    }}>
      {children}
    </BasketContext.Provider>
  );
}

export function useBasket(): BasketContextValue {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used within BasketProvider');
  return ctx;
}
