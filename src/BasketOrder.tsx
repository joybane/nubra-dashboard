import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import SvgChart from './components/SvgChart';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { fmtPrice, generateId, formatExpiry } from './lib/utils';
import { payoffAtExpiry, daysToExpiry } from './lib/GexService';
import { STRATEGY_TEMPLATES, type Sentiment } from './lib/strategyTemplates';
import { useWs } from './hooks/useWsContext';
import { useBasket, type BasketLegInput } from './hooks/useBasketContext';
import { useBasketChain, type ChainRow } from './hooks/useBasketChain';
import { useBasketPersistence } from './hooks/useBasketPersistence';
import { useMarginCalc } from './hooks/useMarginCalc';
import OptionChain from './OptionChain';

// Interfaces

interface Leg {
  id: string;
  symbol: string;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  strike: number;
  expiry: string;
  lots: number;
  lotSize: number;
  ltp: number;
  entryLtp: number;
  refId: number | null;
  nubraName: string;
  asset: string;
  orderType: 'MKT' | 'LIMIT' | 'SL';
  limitPrice: number | null;
  triggerPrice: number | null;
  deliveryType: 'IDAY' | 'CNC';
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface Props {
  instrument: Instrument | null;
}

type ViewMode = 'prebuilt' | 'saved' | 'builder';

// Helpers

function numField(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    if (obj[k] != null && !isNaN(Number(obj[k]))) return Number(obj[k]);
  }
  return null;
}

const ORDER_TYPE_MAP: Record<string, string> = {
  MKT: 'ORDER_TYPE_MARKET',
  LIMIT: 'ORDER_TYPE_REGULAR',
  SL: 'ORDER_TYPE_STOPLOSS',
};

const SENTIMENT_COLORS: Record<Sentiment, string> = {
  Bullish: '#22c55e',
  Bearish: '#ef4444',
  Neutral: '#6366f1',
  Volatile: '#f59e0b',
};

function miniPayoff(legs: Array<{ optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; strikeDist: number; lots: number }>): Array<{ x: number; y: number }> {
  const mapped = legs.map(l => ({
    strike: 24000 + l.strikeDist * 100,
    type: l.optionType, side: l.side, qty: l.lots, premium: 100,
  }));
  const strikes = mapped.map(l => l.strike);
  const min = Math.min(...strikes) - 400;
  const max = Math.max(...strikes) + 400;
  const step = (max - min) / 40;
  return Array.from({ length: 41 }, (_, i) => ({ x: i, y: payoffAtExpiry(min + i * step, mapped) }));
}

// Component

export default function BasketOrder({ instrument }: Props) {
  const [legs, setLegs] = useState<Leg[]>([]);
  const [placed, setPlaced] = useState<{ ok: boolean; msg: string } | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>('prebuilt');
  const [sentimentFilter, setSentimentFilter] = useState<Sentiment | 'All'>('All');
  const [saveName, setSaveName] = useState('');
  const [strategyName, setStrategyName] = useState<string>('Custom Strategy');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [targetDays, setTargetDays] = useState(5);
  const [addScripQuery, setAddScripQuery] = useState('');
  const [addScripResults, setAddScripResults] = useState<Array<Record<string, unknown>>>([]);
  const [showAddScrip, setShowAddScrip] = useState(false);
  const [rightTab, setRightTab] = useState<'payoff' | 'optionchain'>('optionchain');
  const [editingBasketId, setEditingBasketId] = useState<string | null>(null);
  const [editingBasketName, setEditingBasketName] = useState('');
  const [symSearch, setSymSearch] = useState('');
  const [symResults, setSymResults] = useState<Array<Record<string, unknown>>>([]);
  const [showSymSearch, setShowSymSearch] = useState(false);
  const [leftWidth, setLeftWidth] = useState(480);
  const symSearchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
  const addScripTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { subscribe } = useWs();
  const { onLegAdded, setBasketMode } = useBasket();

  const sym = instrument
    ? (instrument.asset || (instrument.stock_name || '').replace(/\s+\d+$/, '').replace(/\s+/g, '') || getSymbol(instrument).replace(/\d.*/, '') || getSymbol(instrument))
    : null;
  const exch = instrument?.exchange || 'NSE';
  const instLotSize = instrument?.lot_size ?? 1;

  const legExpiries = useMemo(() => Array.from(new Set(legs.map(l => l.expiry).filter(Boolean))), [legs]);

  const chain = useBasketChain({ sym, exch, legExpiries });
  const persistence = useBasketPersistence();
  const { margin, loading: marginLoading, error: marginError } = useMarginCalc(legs, exch, multiplier, useCallback((resolved: any[]) => {
    setLegs(prev => {
      let changed = false;
      const next = prev.map(leg => {
        const found = resolved.find((r: any) => r.strike === leg.strike && r.optionType === leg.optionType && r.expiry === leg.expiry);
        if (found) {
          if (leg.refId !== found.refId || leg.delta !== found.delta || leg.ltp !== found.ltp || leg.nubraName !== found.nubraName) {
            changed = true;
            return {
              ...leg,
              refId: found.refId,
              ltp: found.ltp,
              iv: found.iv ?? leg.iv,
              delta: found.delta ?? leg.delta,
              gamma: found.gamma ?? leg.gamma,
              theta: found.theta ?? leg.theta,
              vega: found.vega ?? leg.vega,
              nubraName: found.nubraName,
              lotSize: found.lotSize || leg.lotSize
            };
          }
        }
        return leg;
      });
      return changed ? next : prev;
    });
  }, []));

  // Auto-enable basket mode when OC tab active in builder
  useEffect(() => {
    if (viewMode === 'builder' && rightTab === 'optionchain') {
      setBasketMode(true);
      return () => setBasketMode(false);
    }
  }, [viewMode, rightTab, setBasketMode]);

  // Listen for legs added from OptionChain basket mode
  useEffect(() => {
    const unsub = onLegAdded((input: BasketLegInput) => {
      setLegs(prev => [...prev, {
        id: generateId(), symbol: input.asset, optionType: input.optionType,
        side: input.side, strike: input.strike, expiry: input.expiry,
        lots: 1, lotSize: input.lotSize, ltp: input.ltp, entryLtp: input.ltp, refId: input.refId,
        nubraName: input.nubraName, asset: input.asset, orderType: 'MKT',
        limitPrice: null, triggerPrice: null, deliveryType: 'IDAY',
        iv: input.iv, delta: input.delta, gamma: input.gamma,
        theta: input.theta, vega: input.vega,
      }]);
      setViewMode('builder');
    });
    return unsub;
  }, [onLegAdded]);

  // WS leg LTP updates - option chain (primary) + position_ltp (secondary for traded legs)
  useEffect(() => {
    if (!sym) return;
    const unsub1 = subscribe('option_chain', (msg) => {
      const d = (msg as any).data as Record<string, unknown> | undefined;
      if (!d || String(d.asset || '').toUpperCase() !== sym.toUpperCase()) return;
      const msgExpiry = String(d.expiry || '');
      const ceArr = (d.ce || []) as Array<Record<string, unknown>>;
      const peArr = (d.pe || []) as Array<Record<string, unknown>>;

      const ltpMap = new Map<number, Record<string, number | undefined>>();
      for (const ce of ceArr) {
        const sp = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
        ltpMap.set(sp, { ...ltpMap.get(sp), ce: ce.ltp != null ? Number(ce.ltp) / 100 : undefined,
          ceIv: numField(ce, 'iv', 'implied_volatility') ?? undefined, ceDelta: numField(ce, 'delta') ?? undefined,
          ceGamma: numField(ce, 'gamma') ?? undefined, ceTheta: numField(ce, 'theta') ?? undefined, ceVega: numField(ce, 'vega') ?? undefined });
      }
      for (const pe of peArr) {
        const sp = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
        ltpMap.set(sp, { ...ltpMap.get(sp), pe: pe.ltp != null ? Number(pe.ltp) / 100 : undefined,
          peIv: numField(pe, 'iv', 'implied_volatility') ?? undefined, peDelta: numField(pe, 'delta') ?? undefined,
          peGamma: numField(pe, 'gamma') ?? undefined, peTheta: numField(pe, 'theta') ?? undefined, peVega: numField(pe, 'vega') ?? undefined });
      }

      setLegs(prev => prev.map(leg => {
        if (leg.expiry !== msgExpiry) return leg;
        const u = ltpMap.get(leg.strike); if (!u) return leg;
        return { ...leg, ltp: (leg.optionType === 'CE' ? u.ce : u.pe) ?? leg.ltp,
          iv: (leg.optionType === 'CE' ? u.ceIv : u.peIv) ?? leg.iv, delta: (leg.optionType === 'CE' ? u.ceDelta : u.peDelta) ?? leg.delta,
          gamma: (leg.optionType === 'CE' ? u.ceGamma : u.peGamma) ?? leg.gamma, theta: (leg.optionType === 'CE' ? u.ceTheta : u.peTheta) ?? leg.theta,
          vega: (leg.optionType === 'CE' ? u.ceVega : u.peVega) ?? leg.vega };
      }));
    });

    const unsub2 = subscribe('position_ltp', (msg) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data as { ref_id: number; ltp: number }[];
      if (!updates || updates.length === 0) return;
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

    return () => { unsub1(); unsub2(); };
  }, [subscribe, sym, chain.expiry]);
  // Leg CRUD

  function addLeg(strike: number, optionType: 'CE' | 'PE', side: 'BUY' | 'SELL', row: ChainRow) {
    const ltp = optionType === 'CE' ? row.ceLtp : row.peLtp;
    const refId = optionType === 'CE' ? row.ceRefId : row.peRefId;
    const nubraName = optionType === 'CE' ? row.ceNubraName : row.peNubraName;
    setLegs(prev => [...prev, {
      id: generateId(), symbol: sym!, optionType, side, strike, expiry: chain.expiry,
      lots: 1, lotSize: row.lotSize, ltp, entryLtp: ltp, refId, nubraName, asset: sym!,
      orderType: 'MKT', limitPrice: null, triggerPrice: null, deliveryType: 'IDAY',
      iv: optionType === 'CE' ? row.ceIv : row.peIv, delta: optionType === 'CE' ? row.ceDelta : row.peDelta,
      gamma: optionType === 'CE' ? row.ceGamma : row.peGamma, theta: optionType === 'CE' ? row.ceTheta : row.peTheta,
      vega: optionType === 'CE' ? row.ceVega : row.peVega,
    }]);
  }

  function removeLeg(id: string) { setLegs(prev => prev.filter(l => l.id !== id)); }
  function updateLeg(id: string, u: Partial<Leg>) { setLegs(prev => prev.map(l => l.id === id ? { ...l, ...u } : l)); }

  function addEmptyOptLeg() {
    const atm = chain.spot ? chain.chainRows.reduce((best, r) => Math.abs(r.strike - chain.spot!) < Math.abs(best.strike - chain.spot!) ? r : best, chain.chainRows[0]) : chain.chainRows[Math.floor(chain.chainRows.length / 2)];
    if (atm) addLeg(atm.strike, 'CE', 'BUY', atm);
  }
  // Symbol search

  function searchSymbol(q: string) {
    setSymSearch(q);
    clearTimeout(symSearchTimer.current);
    if (q.length < 1) { setSymResults([]); return; }
    symSearchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=8&type=INDEX`);
        const data = await res.json() as Record<string, unknown>;
        const r1 = ((data.results || data) as Array<Record<string, unknown>>);
        const res2 = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=8`);
        const data2 = await res2.json() as Record<string, unknown>;
        const r2 = ((data2.results || data2) as Array<Record<string, unknown>>);
        const seen = new Set<string>();
        const merged = [...r1, ...r2].filter(it => {
          const k = String(it.asset || it.stock_name || '');
          if (!k || seen.has(k)) return false; seen.add(k); return true;
        }).slice(0, 8);
        setSymResults(merged);
      } catch { setSymResults([]); }
    }, 250);
  }

  function selectSymbol(inst: Record<string, unknown>) {
    const newSym = String(inst.asset || inst.stock_name || '').replace(/\s+\d+$/, '').replace(/\s+/g, '');
    if (!newSym) return;
    setShowSymSearch(false); setSymSearch(''); setSymResults([]);
    chain.loadChainForSymbol(newSym, String(inst.exchange || 'NSE'));
  }
  // Add scrip search

  async function searchScrip(q: string) {
    setAddScripQuery(q);
    clearTimeout(addScripTimer.current);
    if (q.length < 2) { setAddScripResults([]); return; }
    addScripTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=10`);
        const data = await res.json() as Record<string, unknown>;
        const results = (data.results || data) as Array<Record<string, unknown>>;
        setAddScripResults(Array.isArray(results) ? results : []);
      } catch { setAddScripResults([]); }
    }, 300);
  }

  function addScripToBasket(inst: Record<string, unknown>) {
    const refId = inst.ref_id != null ? Number(inst.ref_id) : null;
    const name = String(inst.zanskar_name || inst.nubra_name || inst.stock_name || inst.symbol || '');
    const strike = inst.strike_price ? (Number(inst.strike_price) > 10000 ? Number(inst.strike_price) / 100 : Number(inst.strike_price)) : 0;
    const optType = String(inst.option_type || 'CE').toUpperCase() as 'CE' | 'PE';
    const lotSize = Number(inst.lot_size || inst.ls || instLotSize || 1);
    const ltp = inst.ltp != null ? Number(inst.ltp) / 100 : 0;
    const exp = String(inst.expiry || chain.expiry || '');
    setLegs(prev => [...prev, {
      id: generateId(), symbol: String(inst.asset || inst.stock_name || sym || ''),
      optionType: optType, side: 'BUY', strike, expiry: exp,
      lots: 1, lotSize, ltp, entryLtp: ltp, refId, nubraName: name,
      asset: String(inst.asset || inst.stock_name || sym || ''),
      orderType: 'MKT', limitPrice: null, triggerPrice: null, deliveryType: 'IDAY',
      iv: null, delta: null, gamma: null, theta: null, vega: null,
    }]);
    setShowAddScrip(false); setAddScripQuery(''); setAddScripResults([]);
  }
  // Strategy templates

  function applyTemplate(tmplId: string) {
    const tmpl = STRATEGY_TEMPLATES.find(t => t.id === tmplId);
    if (!tmpl || !chain.chainRows.length) return;
    const strikes = chain.chainRows.map(r => r.strike).sort((a, b) => a - b);
    const step = strikes.length >= 2 ? strikes[1] - strikes[0] : 50;
    const atm = chain.spot ? strikes.reduce((best, s) => Math.abs(s - chain.spot!) < Math.abs(best - chain.spot!) ? s : best, strikes[0]) : strikes[Math.floor(strikes.length / 2)];

    const newLegs: Leg[] = tmpl.legs.map(tl => {
      const target = atm + tl.strikeDist * step;
      const row = chain.chainRows.reduce((best, r) => Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best);
      return {
        id: generateId(), symbol: sym!, optionType: tl.optionType, side: tl.side,
        strike: row.strike, expiry: chain.expiry, lots: tl.lots, lotSize: row.lotSize,
        ltp: tl.optionType === 'CE' ? row.ceLtp : row.peLtp,
        entryLtp: tl.optionType === 'CE' ? row.ceLtp : row.peLtp,
        refId: tl.optionType === 'CE' ? row.ceRefId : row.peRefId,
        nubraName: tl.optionType === 'CE' ? row.ceNubraName : row.peNubraName,
        asset: sym!, orderType: 'MKT' as const, limitPrice: null, triggerPrice: null, deliveryType: 'IDAY' as const,
        iv: tl.optionType === 'CE' ? row.ceIv : row.peIv, delta: tl.optionType === 'CE' ? row.ceDelta : row.peDelta,
        gamma: tl.optionType === 'CE' ? row.ceGamma : row.peGamma, theta: tl.optionType === 'CE' ? row.ceTheta : row.peTheta,
        vega: tl.optionType === 'CE' ? row.ceVega : row.peVega,
      };
    });
    setLegs(newLegs);
    setStrategyName(tmpl.label);
    setViewMode('builder');
  }

  function applyMultiplier(newMult: number) {
    if (newMult < 1 || newMult === multiplier) return;
    const ratio = newMult / multiplier;
    setLegs(prev => prev.map(l => ({ ...l, lots: Math.max(1, Math.round(l.lots * ratio)) })));
    setMultiplier(newMult);
  }

  function loadSavedBasket(basket: { name?: string; legs: Array<Record<string, unknown>>; expiry: string }) {
    setLegs((basket.legs as unknown as Leg[]).map(l => ({ ...l, id: generateId(), entryLtp: l.entryLtp ?? l.ltp })));
    if (basket.expiry && basket.expiry !== chain.expiry) chain.changeExpiry(basket.expiry);
    setStrategyName(basket.name || 'Custom Strategy');
    setViewMode('builder');
  }
  // Computed values

  const totalPrice = useMemo(() => legs.reduce((acc, l) => acc + (l.side === 'BUY' ? 1 : -1) * l.ltp, 0), [legs]);
  const totalPremium = useMemo(() => legs.reduce((acc, l) => acc + (l.side === 'BUY' ? -1 : 1) * l.ltp * l.lots * l.lotSize, 0), [legs]);
  const totalMtm = useMemo(() => legs.reduce((acc, l) => acc + (l.ltp - l.entryLtp) * l.lots * l.lotSize * (l.side === 'BUY' ? 1 : -1), 0), [legs]);

  const netGreeks = useMemo(() => legs.reduce((acc, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    const qty = l.lots * l.lotSize;
    return { delta: acc.delta + (l.delta ?? 0) * qty * sign, gamma: acc.gamma + (l.gamma ?? 0) * qty * sign,
      theta: acc.theta + (l.theta ?? 0) * qty * sign, vega: acc.vega + (l.vega ?? 0) * qty * sign };
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 }), [legs]);

  const payoffData = useMemo(() => {
    if (!legs.length) return [];
    const payoffLegs = legs.map(l => ({ strike: l.strike, type: l.optionType, side: l.side, qty: l.lots * l.lotSize, premium: l.ltp }));
    const strikes = payoffLegs.map(l => l.strike);
    const minS = Math.min(...strikes) * 0.90;
    const maxS = Math.max(...strikes) * 1.10;
    const step = (maxS - minS) / 200;
    return Array.from({ length: 201 }, (_, i) => {
      const s = minS + i * step;
      return { spot: Math.round(s), pnl: Math.round(payoffAtExpiry(s, payoffLegs) * 100) / 100 };
    });
  }, [legs]);

  const maxProfit = payoffData.length ? Math.max(...payoffData.map(d => d.pnl)) : 0;
  const maxLoss = payoffData.length ? Math.min(...payoffData.map(d => d.pnl)) : 0;
  const breakevenPoints = useMemo(() => {
    const bps: number[] = [];
    for (let i = 1; i < payoffData.length; i++) {
      if ((payoffData[i-1].pnl < 0 && payoffData[i].pnl >= 0) || (payoffData[i-1].pnl >= 0 && payoffData[i].pnl < 0))
        bps.push(Math.round((payoffData[i-1].spot + payoffData[i].spot) / 2));
    }
    return bps;
  }, [payoffData]);
  const riskReward = maxLoss !== 0 ? Math.abs(maxProfit / maxLoss) : 0;
  // Place orders

  async function fetchMarginRequiredPaise(orderLegs: Leg[]): Promise<number | undefined> {
    const validLegs = orderLegs.filter(l => l.strike > 0 && l.lots > 0 && l.lotSize > 0);
    if (!validLegs.length) return undefined;
    const res = await fetch('/paper/margin/basket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exchange: exch,
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
  }

  async function placeOrders() {
    if (!legs.length) return;
    const missing = legs.filter(l => !l.refId && !l.nubraName);
    if (missing.length) { setPlaced({ ok: false, msg: `${missing.length} leg(s) missing instrument IDs.` }); return; }
    const sorted = [...legs].sort((a, b) => { if (a.side === 'BUY' && b.side === 'SELL') return -1; if (a.side === 'SELL' && b.side === 'BUY') return 1; return 0; });
    setPlaced(null);
    const finalName = strategyName === 'Custom Strategy' ? persistence.getNextCustomName() : (strategyName || persistence.getNextCustomName());
    try {
      const marginRequired = margin?.total && margin.total > 0
        ? Math.round(margin.total * 100)
        : await fetchMarginRequiredPaise(sorted);
      if (!marginRequired) throw new Error('Margin unavailable. Please wait for the margin calculation and try again.');
      const res = await fetch('/paper/orders/basket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy_name: finalName, margin_required: marginRequired, orders: sorted.map(l => ({
          nubraName: l.nubraName || `${l.symbol}${l.strike}${l.optionType}`, liveRefId: l.refId,
          display_name: `${l.symbol} ${l.strike} ${l.optionType}`, order_type: ORDER_TYPE_MAP[l.orderType],
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL', order_qty: l.lots * l.lotSize,
          order_price: l.limitPrice ? Math.round(l.limitPrice * 100) : undefined,
          trigger_price: l.triggerPrice ? Math.round(l.triggerPrice * 100) : undefined,
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
          validity_type: 'DAY', asset: l.asset, expiry: l.expiry, derivative_type: 'OPT',
        })) }) });
      const d = await res.json() as { orders?: Array<{ order_id: number }>; basket_group_id?: string; error?: string };
      if (!res.ok || d.error) throw new Error(d.error || 'Basket placement failed');
      persistence.saveBasket(finalName, sym, chain.expiry, legs, d.basket_group_id);
      setStrategyName('Custom Strategy');
      setPlaced({ ok: true, msg: `${d.orders?.length ?? legs.length} order(s) placed & saved as "${finalName}"` });
      setTimeout(() => setPlaced(null), 5000);
    } catch (e) { setPlaced({ ok: false, msg: (e as Error).message }); }
  }
  // Render

  const dte = chain.expiry ? daysToExpiry(chain.expiry) : 0;

  if (!instrument) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 14, background: 'var(--bg-primary)' }}>
<span style={{ fontSize: 30, opacity: 0.5 }}>📊</span>
        Select an F&O instrument to build strategies
      </div>
    );
  }

  // PRE-BUILT / SAVED VIEWS

  if (viewMode !== 'builder') {
    const filtered = sentimentFilter === 'All' ? STRATEGY_TEMPLATES : STRATEGY_TEMPLATES.filter(t => t.sentiment === sentimentFilter);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', overflow: 'hidden', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
            <button onClick={() => setViewMode('prebuilt')}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === 'prebuilt' ? '#5865f2' : 'transparent', color: viewMode === 'prebuilt' ? '#fff' : 'var(--text-secondary)' }}>
              Pre-built
            </button>
            <button onClick={() => { setViewMode('saved'); persistence.loadSavedBaskets(); }}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === 'saved' ? '#5865f2' : 'transparent', color: viewMode === 'saved' ? '#fff' : 'var(--text-secondary)' }}>
              Saved
            </button>
          </div>

          {viewMode === 'prebuilt' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, fontSize: 12 }}>
<span style={{ color: 'var(--text-secondary)', marginRight: 2 }}>🔍</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{sym}</span>
                <span style={{ color: 'var(--green)', fontSize: 11 }}>{chain.spot ? chain.spot.toLocaleString('en-IN') : ''}</span>
                <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{exch}</span>
              </div>
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {(['All', 'Bullish', 'Bearish', 'Neutral', 'Volatile'] as const).map(s => (
                  <button key={s} onClick={() => setSentimentFilter(s)}
                    style={{ padding: '4px 12px', borderRadius: 16, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                      border: sentimentFilter === s ? '1px solid #5865f2' : '1px solid var(--border)',
                      background: sentimentFilter === s ? '#5865f2' + '20' : 'transparent',
                      color: sentimentFilter === s ? '#5865f2' : 'var(--text-secondary)' }}>
{s !== 'All' && <span style={{ marginRight: 4 }}>{s === 'Bullish' ? '🟢' : s === 'Bearish' ? '🔴' : s === 'Neutral' ? '🟣' : '🟡'}</span>}
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {viewMode === 'prebuilt' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {filtered.map(tmpl => {
                const mini = miniPayoff(tmpl.legs);
                const color = SENTIMENT_COLORS[tmpl.sentiment];
                return (
                  <div key={tmpl.id} style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ position: 'relative', height: 100, padding: '8px 12px 0' }}>
                      <button onClick={() => applyTemplate(tmpl.id)}
                        style={{ position: 'absolute', top: 8, right: 8, padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
                          background: '#5865f2' + '20', color: '#5865f2', border: '1px solid #5865f2' + '40', cursor: 'pointer' }}>
                        View legs
                      </button>
                      <svg viewBox="0 0 41 30" style={{ width: '100%', height: '100%' }} preserveAspectRatio="none">
                        {(() => {
                          const ys = mini.map(p => p.y);
                          const minY = Math.min(...ys); const maxY = Math.max(...ys);
                          const range = maxY - minY || 1;
                          const pts = mini.map(p => `${p.x},${28 - ((p.y - minY) / range) * 24}`).join(' ');
                          const zeroY = 28 - ((0 - minY) / range) * 24;
                          return (<>
                            <line x1="0" y1={zeroY} x2="41" y2={zeroY} stroke="#2a2d42" strokeWidth="0.5" strokeDasharray="2 2" />
                            <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
                          </>);
                        })()}
                      </svg>
                    </div>
                    <div style={{ padding: '8px 12px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{tmpl.label}</span>
                        <span style={{ fontSize: 10, color, fontWeight: 500 }}>{tmpl.sentiment}</span>
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, margin: 0, flex: 1 }}>{tmpl.description}</p>
                      <button onClick={() => applyTemplate(tmpl.id)}
                        style={{ marginTop: 10, width: '100%', padding: '8px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                          background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 12 }}>
                        Build
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {viewMode === 'saved' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {persistence.savedBaskets.length === 0 ? (
              <div style={{ display: 'flex', height: '100%', gap: 24 }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                  <svg viewBox="0 0 300 160" style={{ width: 300, height: 160, opacity: 0.6 }}>
                    <defs>
                      <linearGradient id="savedGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} /><stop offset="100%" stopColor="#22c55e" stopOpacity={0} /></linearGradient>
                      <linearGradient id="savedRed" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stopColor="#ef4444" stopOpacity={0.2} /><stop offset="100%" stopColor="#ef4444" stopOpacity={0} /></linearGradient>
                    </defs>
                    <path d="M0,140 L60,140 L100,100 L150,60 L200,40 L250,30 L300,25" fill="none" stroke="#22c55e" strokeWidth="2" />
                    <path d="M0,140 L60,140 L100,100 L150,60 L200,40 L250,30 L300,25 L300,160 L0,160 Z" fill="url(#savedGreen)" />
                    <path d="M0,20 L50,30 L100,80 L150,100 L200,115 L250,120 L300,120" fill="none" stroke="#ef4444" strokeWidth="1.5" opacity={0.6} />
                    <line x1="0" y1="100" x2="300" y2="100" stroke="#2a2d42" strokeWidth="0.5" strokeDasharray="4 4" />
                  </svg>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>Your Strategies Will Appear Here</div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Build and save strategies to analyze your trades better</div>
                </div>
                <div style={{ width: 260, background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, alignSelf: 'center' }}>
<div style={{ fontSize: 40 }}>🎯</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', textAlign: 'center' as const }}>Ready to create your own strategy?</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'center' as const }}>Take control and build one that works for you.</div>
                  <button onClick={() => setViewMode('builder')}
                    style={{ marginTop: 4, padding: '10px 24px', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', width: '100%' }}>
                    Build my strategy
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                {persistence.savedBaskets.map(b => (
                  <div key={b.basket_id} style={{ background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      {editingBasketId === b.basket_id ? (
                        <input type="text" value={editingBasketName} autoFocus
                          onChange={e => setEditingBasketName(e.target.value)}
                          onBlur={() => { if (editingBasketName.trim()) persistence.updateBasketName(b.basket_id, editingBasketName); setEditingBasketId(null); }}
                          onKeyDown={e => { if (e.key === 'Enter') { if (editingBasketName.trim()) persistence.updateBasketName(b.basket_id, editingBasketName); setEditingBasketId(null); } if (e.key === 'Escape') setEditingBasketId(null); }}
                          style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', background: 'var(--bg-card)', border: '1px solid #5865f2', borderRadius: 4, padding: '2px 6px', outline: 'none', flex: 1, marginRight: 6 }} />
                      ) : (
                        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', cursor: 'pointer' }}
                          onDoubleClick={() => { setEditingBasketId(b.basket_id); setEditingBasketName(b.name); }}
                          title="Double-click to rename">{b.name}</span>
                      )}
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <button onClick={() => { setEditingBasketId(b.basket_id); setEditingBasketName(b.name); }}
                          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.3)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 8, fontWeight: 600, padding: '1px 3px', borderRadius: 3, lineHeight: 1, width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} title="Rename">R</button>
                        <button onClick={() => persistence.deleteSavedBasket(b.basket_id)}
style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 10 }}>{b.symbol} · {formatExpiry(b.expiry)} · {b.legs.length} legs</div>
                    <button onClick={() => loadSavedBasket(b)}
                      style={{ width: '100%', padding: '7px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                      Load Strategy
                    </button>
                  </div>
                ))}
                <div style={{ background: 'var(--bg-card)', borderRadius: 10, border: '1px dashed var(--border)', padding: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 100 }}>
                  <span style={{ fontSize: 24, color: '#5865f2' }}>+</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>Build New Strategy</span>
                  <button onClick={() => setViewMode('builder')}
                    style={{ padding: '7px 20px', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                    Build
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // BUILDER VIEW

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', overflow: 'hidden', fontVariantNumeric: 'tabular-nums' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
        <button onClick={() => setViewMode('prebuilt')} style={{ background: 'none', border: 'none', color: '#5865f2', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
          &lt; Back to all strategies
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
          {chain.expiry && `${Math.round(dte)}d to expiry`}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* LEFT PANEL */}
        <div style={{ width: leftWidth, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, position: 'relative' as const }}>
<span style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }} onClick={() => setShowSymSearch(!showSymSearch)}>🔍</span>
              {showSymSearch ? (
                <div style={{ position: 'relative' }}>
                  <input type="text" value={symSearch} onChange={e => searchSymbol(e.target.value)} autoFocus
                    placeholder="Search NIFTY, BANKNIFTY..."
                    onBlur={() => setTimeout(() => setShowSymSearch(false), 200)}
                    style={{ padding: '4px 10px', background: 'var(--bg-card)', border: '1px solid #5865f2', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, fontWeight: 700, outline: 'none', width: 200 }} />
                  {symResults.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 240, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 50, overflow: 'hidden' }}>
                      {symResults.map((inst, i) => (
                        <button key={i} onMouseDown={() => selectSymbol(inst)}
                          style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '8px 12px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}>
                          <span style={{ fontWeight: 700 }}>{String(inst.asset || inst.stock_name || '')}</span>
<span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 10 }}>{String(inst.exchange || '')} · {String(inst.derivative_type || inst.asset_type || '')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', cursor: 'pointer' }} onClick={() => setShowSymSearch(true)}>{sym}</span>
              )}
              <span style={{ fontSize: 13, color: 'var(--green)' }}>{chain.spot ? chain.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}</span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{exch}</span>
              <select value="" onChange={e => { if (e.target.value) applyTemplate(e.target.value); }}
                style={{ marginLeft: 'auto', padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-secondary)', fontSize: 11 }}>
                <option value="">Custom Strategy</option>
                {STRATEGY_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            {chain.spot && (
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {totalPrice.toFixed(2)} <span style={{ color: totalPrice >= 0 ? 'var(--green)' : 'var(--red)' }}>+0.00 (0.00%)</span>
                <span style={{ marginLeft: 12, color: 'var(--text-muted)' }}>Bid 0.00  Ask 0.00</span>
              </div>
            )}
          </div>

          {/* Legs table */}
          <div style={{ padding: '0 12px 8px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '30px 88px 96px 30px 68px 52px 64px 24px', alignItems: 'center', gap: 2, padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' as const }}>
              <span>B/S</span><span>Expiry</span><span>Strike</span><span>Type</span><span>Qty</span><span>LTP</span><span>P&L</span><span></span>
            </div>

            {legs.map(leg => (
              <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '30px 88px 96px 30px 68px 52px 64px 24px', alignItems: 'center', gap: 2, padding: '6px 0', borderBottom: '1px solid var(--bg-card)' }}>
                <button onClick={() => updateLeg(leg.id, { side: leg.side === 'BUY' ? 'SELL' : 'BUY' })}
                  style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 11,
                    background: leg.side === 'BUY' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>
                  {leg.side === 'BUY' ? 'B' : 'S'}
                </button>
                <select value={leg.expiry} onChange={e => updateLeg(leg.id, { expiry: e.target.value })}
                  style={{ padding: '3px 2px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 11, width: '100%' }}>
                  {chain.expiries.map(exp => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button onClick={() => { const idx = chain.chainRows.findIndex(r => r.strike === leg.strike); if (idx > 0) { const r = chain.chainRows[idx - 1]; const newLtp = leg.optionType === 'CE' ? r.ceLtp : r.peLtp; updateLeg(leg.id, { strike: r.strike, ltp: newLtp, entryLtp: newLtp, refId: leg.optionType === 'CE' ? r.ceRefId : r.peRefId, nubraName: leg.optionType === 'CE' ? r.ceNubraName : r.peNubraName }); } }}
style={{ width: 18, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                  <span style={{ fontWeight: 600, fontSize: 11, color: 'var(--text-primary)', flex: 1, textAlign: 'center' as const }}>{leg.strike.toLocaleString('en-IN')}</span>
                  <button onClick={() => { const idx = chain.chainRows.findIndex(r => r.strike === leg.strike); if (idx < chain.chainRows.length - 1) { const r = chain.chainRows[idx + 1]; const newLtp = leg.optionType === 'CE' ? r.ceLtp : r.peLtp; updateLeg(leg.id, { strike: r.strike, ltp: newLtp, entryLtp: newLtp, refId: leg.optionType === 'CE' ? r.ceRefId : r.peRefId, nubraName: leg.optionType === 'CE' ? r.ceNubraName : r.peNubraName }); } }}
                    style={{ width: 18, height: 20, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                </div>
                <button onClick={() => updateLeg(leg.id, { optionType: leg.optionType === 'CE' ? 'PE' : 'CE' })}
                  style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 10,
                    background: leg.optionType === 'CE' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.optionType === 'CE' ? 'var(--green)' : 'var(--red)' }}>
                  {leg.optionType}
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button onClick={() => updateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-primary)', flex: 1, textAlign: 'center' as const }}>{leg.lots * leg.lotSize}</span>
                  <button onClick={() => updateLeg(leg.id, { lots: leg.lots + 1 })}
                    style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{fmtPrice(leg.ltp)}</span>
                {(() => {
                  const mtm = (leg.ltp - leg.entryLtp) * leg.lots * leg.lotSize * (leg.side === 'BUY' ? 1 : -1);
return <span style={{ fontSize: 11, fontWeight: 600, color: mtm >= 0 ? 'var(--green)' : 'var(--red)' }}>{mtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(mtm))}</span>;
                })()}
                <button onClick={() => removeLeg(leg.id)}
                  style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid transparent', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--red-dim)'; e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.borderColor = '#ef444440'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.borderColor = 'transparent'; }}>
✕
                </button>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 12, padding: '10px 0', fontSize: 12 }}>
              <button onClick={addEmptyOptLeg} disabled={!chain.chainRows.length}
                style={{ background: 'none', border: 'none', color: '#5865f2', cursor: 'pointer', fontWeight: 600, fontSize: 12, opacity: chain.chainRows.length ? 1 : 0.4 }}>
                + Add OPT Leg
              </button>
              <button onClick={addEmptyOptLeg} disabled={!chain.chainRows.length}
                style={{ background: 'none', border: 'none', color: '#5865f2', cursor: 'pointer', fontWeight: 600, fontSize: 12, opacity: chain.chainRows.length ? 1 : 0.4 }}>
                + Add FUT Leg
              </button>
              <button onClick={() => { setShowAddScrip(true); setAddScripQuery(''); setAddScripResults([]); }}
                style={{ background: 'none', border: 'none', color: 'var(--green)', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                + Add Scrip
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Total Price: </span>
<span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>₹{totalPrice.toFixed(2)}</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 16 }}>Total Premium: </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: totalPremium >= 0 ? 'var(--green)' : 'var(--red)' }}>{totalPremium >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPremium))}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Lot Multiplier:</span>
                <button onClick={() => applyMultiplier(Math.max(1, multiplier - 1))}
style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <span style={{ fontWeight: 700, color: 'var(--text-primary)', minWidth: 16, textAlign: 'center' as const }}>{multiplier}</span>
                <button onClick={() => applyMultiplier(multiplier + 1)}
                  style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
              </div>
            </div>

            {totalPremium > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
<span style={{ color: 'var(--text-muted)' }}>ℹ</span> Negative prices indicate that executing this strategy will result in a net cash inflow.
              </div>
            )}

            {(margin || marginLoading || marginError) && (
              <div style={{ marginTop: 8, background: 'var(--bg-card)', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  <span>Margin Requirements</span>
                  {marginLoading ? (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Calculating...</span>
                  ) : margin ? (
                    margin.estimated ? (
                      <span
                        style={{ background: 'rgba(234, 179, 8, 0.15)', color: '#eab308', border: '1px solid rgba(234, 179, 8, 0.3)', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600, cursor: 'help' }}
                        title={margin.message || 'Broker margin unavailable. Calculated locally via exchange-style fallback / SPAN risk data.'}
                      >
                        ⚡ Local Est.
                      </span>
                    ) : (
                      <span
                        style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}
                        title="Calculated live from Nubra API"
                      >
                        ✓ Nubra API
                      </span>
                    )
                  ) : null}
                </div>
                {margin ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '10px 12px' }}>
                    <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Span</div><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{margin.span ? fmtPrice(margin.span) : '—'}</div></div>
                    <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Exposure</div><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{margin.exposure ? fmtPrice(margin.exposure) : '—'}</div></div>
                    <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Total Margin</div><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{fmtPrice(margin.total)}</div></div>
                    <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Premium Payable</div><div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{margin.premium ? fmtPrice(margin.premium) : fmtPrice(Math.abs(totalPremium))}</div></div>
                  </div>
                ) : (
                  <div style={{ padding: '12px 14px', fontSize: 11, color: marginError ? 'var(--red)' : 'var(--text-muted)' }}>
                    {marginError ? `Margin unavailable: ${marginError}` : 'Calculating margin...'}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, padding: '10px 0' }}>
              <button onClick={() => { setShowSaveModal(true); setSaveName(''); }}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Save
              </button>
              <button onClick={placeOrders} disabled={!legs.length}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: !legs.length ? 0.5 : 1 }}>
                Trade
              </button>
            </div>
          </div>

          {/* Greeks table */}
          {legs.length > 0 && legs.some(l => l.delta != null) && (
            <div style={{ margin: '0 12px 12px', background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>
                <span>Greeks</span>
                <span
                  style={{ background: 'rgba(34, 197, 94, 0.15)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.3)', padding: '2px 7px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}
                  title="Option Greeks received live from Nubra Option Chain feed"
                >
                  ✓ Nubra API
                </span>
              </div>
              <div style={{ padding: '0 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg-card)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>
                  <span>B/S</span><span>Instrument</span><span>Strike</span><span>Qty</span><span>Delta</span><span>Theta</span><span>Gamma</span><span>Vega</span>
                </div>
                {legs.map(leg => (
                  <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--bg-card)', fontSize: 11 }}>
                    <span style={{ width: 22, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 10,
                      background: leg.side === 'BUY' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{leg.side === 'BUY' ? 'B' : 'S'}</span>
                    <span style={{ color: 'var(--text-primary)', fontSize: 11 }}>{formatExpiry(leg.expiry)} {leg.optionType}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{leg.strike.toLocaleString('en-IN')}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{leg.lots * leg.lotSize}</span>
<span style={{ color: 'var(--text-primary)' }}>{leg.delta?.toFixed(2) ?? '—'}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{leg.theta?.toFixed(2) ?? '—'}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{leg.gamma?.toFixed(4) ?? '—'}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{leg.vega?.toFixed(2) ?? '—'}</span>
                  </div>
                ))}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '8px 0', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                  <span></span><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Total × (Lot size × Lots)</span><span></span><span></span>
                  <span>{netGreeks.delta.toFixed(2)}</span><span>{netGreeks.theta.toFixed(2)}</span><span>{netGreeks.gamma.toFixed(4)}</span><span>{netGreeks.vega.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* P&L table */}
          {legs.length > 0 && (
            <div style={{ margin: '0 12px 16px', background: 'var(--bg-card)', borderRadius: 10, border: '1px solid var(--border)', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>Profit / Loss</div>
              <div style={{ padding: '0 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg-card)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>
                  <span>B/S</span><span>Instrument</span><span>Strike</span><span>Qty</span><span style={{ textAlign: 'right' as const }}>Unrealized P&L</span>
                </div>
                {legs.map(leg => {
                  const mtm = (leg.ltp - leg.entryLtp) * leg.lots * leg.lotSize * (leg.side === 'BUY' ? 1 : -1);
                  return (
                    <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--bg-card)', fontSize: 11 }}>
                      <span style={{ width: 22, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 10,
                        background: leg.side === 'BUY' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{leg.side === 'BUY' ? 'B' : 'S'}</span>
                      <span style={{ color: 'var(--text-primary)' }}>{formatExpiry(leg.expiry)} {leg.optionType}</span>
                      <span style={{ color: 'var(--text-primary)' }}>{leg.strike.toLocaleString('en-IN')}</span>
                      <span style={{ color: 'var(--text-primary)' }}>{leg.lots * leg.lotSize}</span>
<span style={{ textAlign: 'right' as const, fontWeight: 600, color: mtm >= 0 ? 'var(--green)' : 'var(--red)' }}>{mtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(mtm))}</span>
                    </div>
                  );
                })}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '8px 0', fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>
                  <span></span><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Total Unrealized P&L</span><span></span><span></span>
<span style={{ textAlign: 'right' as const, color: totalMtm >= 0 ? 'var(--green)' : 'var(--red)' }}>{totalMtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalMtm))}</span>
                </div>
                <div style={{ padding: '6px 0 8px', fontSize: 10, color: 'var(--text-muted)' }}>P&L is mark-to-market (entry price vs current LTP).</div>
              </div>
            </div>
          )}
        </div>

        {/* RESIZE HANDLE */}
        <div
          onMouseDown={e => {
            e.preventDefault();
            resizeRef.current = { startX: e.clientX, startW: leftWidth };
            const onMove = (ev: MouseEvent) => { if (!resizeRef.current) return; setLeftWidth(Math.max(320, Math.min(800, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX)))); };
            const onUp = () => { resizeRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
          }}
          style={{ width: 5, cursor: 'col-resize', background: 'var(--border)', flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget.style.background = '#5865f2')}
          onMouseLeave={e => { if (!resizeRef.current) e.currentTarget.style.background = 'var(--border)'; }}
        />

        {/* RIGHT PANEL */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
<div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Max Profit</div><div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>{maxProfit > 1e6 ? 'Unlimited' : `+₹${fmtPrice(maxProfit)}`}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Max Loss</div><div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>{maxLoss < -1e6 ? 'Unlimited' : `-₹${fmtPrice(Math.abs(maxLoss))}`}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Breakeven</div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{breakevenPoints.length ? breakevenPoints.map(bp => bp.toLocaleString('en-IN')).join(', ') : '—'}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Risk Reward Ratio</div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{riskReward ? `1:${riskReward.toFixed(2)}` : '—'}</div></div>
            <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Probability of profit</div><div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {breakevenPoints.length && chain.spot ? (() => {
                const bullish = payoffData.filter(d => d.spot >= chain.spot! && d.pnl > 0).length;
                const total = payoffData.filter(d => d.spot >= chain.spot! * 0.95).length;
                return total > 0 ? `${((bullish / total) * 100).toFixed(1)}%` : '-';
              })() : '-'}
            </div></div>
          </div>

          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            {([['payoff', 'Payoff Graph'], ['optionchain', 'Option Chain']] as const).map(([key, label]) => (
              <button key={key} onClick={() => setRightTab(key)}
                style={{ padding: '8px 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', borderBottom: rightTab === key ? '2px solid #5865f2' : '2px solid transparent',
                  background: 'transparent', color: rightTab === key ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                {label}
              </button>
            ))}
            {rightTab === 'payoff' && (
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', paddingRight: 16, fontSize: 10, color: 'var(--text-secondary)' }}>
                <span><span style={{ display: 'inline-block', width: 12, height: 2, background: '#5865f2', marginRight: 4, verticalAlign: 'middle' }}></span> P/L at target</span>
                <span><span style={{ display: 'inline-block', width: 12, height: 2, background: 'var(--green)', marginRight: 4, verticalAlign: 'middle' }}></span> P/L at expiry</span>
              </div>
            )}
          </div>

          {rightTab === 'payoff' && (
            <>
              <div style={{ flex: 1, minHeight: 250, padding: '0 8px' }}>
                <SvgChart
                  data={payoffData}
                  xKey="spot"
                  series={[{ dataKey: 'pnl', color: '#22c55e', fill: 'rgba(34,197,94,0.15)' }]}
                  refLines={[
                    { axis: 'y', value: 0, color: '#2a2d42' },
                    ...(chain.spot ? [{ axis: 'x' as const, value: chain.spot, color: '#5865f2', dashed: true, label: chain.spot.toLocaleString('en-IN'), labelColor: '#5865f2' }] : []),
                  ]}
                  xFormatter={v => v.toLocaleString('en-IN')}
                  yFormatter={v => `Rs ${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v)}`}
                  tooltipFormatter={d => `Spot: ${d.spot.toLocaleString('en-IN')}\nP&L: Rs ${fmtPrice(d.pnl)}`}
                  legendLabels={{ pnl: 'P&L at expiry' }}
                />
              </div>
              <div style={{ padding: '8px 16px 16px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                <span>Target Date: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{targetDays} Day from Expiry</span></span>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setTargetDays(Math.max(0, targetDays - 1))}
style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>−</button>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{chain.expiry ? formatExpiry(chain.expiry) : '—'}</span>
                  <button onClick={() => setTargetDays(targetDays + 1)}
                    style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 14 }}>+</button>
                </div>
              </div>
            </>
          )}

          {rightTab === 'optionchain' && (
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column' }}>
                <OptionChain instrument={instrument} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save modal */}
      {showSaveModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setShowSaveModal(false)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 24, width: 360 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>Save Strategy</span>
<button onClick={() => setShowSaveModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Name your strategy</div>
            <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { persistence.saveBasket(saveName, sym, chain.expiry, legs).then(r => { setPlaced(r); setShowSaveModal(false); setSaveName(''); setTimeout(() => setPlaced(null), 3000); }); } }}
              autoFocus placeholder="e.g. NIFTY Iron Condor"
              style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setShowSaveModal(false)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={() => { persistence.saveBasket(saveName, sym, chain.expiry, legs).then(r => { setPlaced(r); setShowSaveModal(false); setSaveName(''); setTimeout(() => setPlaced(null), 3000); }); }} disabled={!saveName.trim()}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: saveName.trim() ? 1 : 0.5 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Scrip modal */}
      {showAddScrip && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 120, zIndex: 100 }}
          onClick={() => setShowAddScrip(false)}>
          <div style={{ background: 'var(--bg-card)', borderRadius: 12, border: '1px solid var(--border)', padding: 20, width: 400, boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)' }}>Add Scrip</span>
<button onClick={() => setShowAddScrip(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <input type="text" value={addScripQuery} onChange={e => searchScrip(e.target.value)}
              autoFocus placeholder="Search stocks, futures, options..."
              style={{ width: '100%', padding: '10px 12px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const, marginBottom: 8 }} />
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {addScripResults.length === 0 && addScripQuery.length >= 2 && (
<div style={{ padding: 16, textAlign: 'center' as const, color: 'var(--text-muted)', fontSize: 12 }}>Searching…</div>
              )}
              {addScripResults.map((inst, i) => (
                <button key={i} onClick={() => addScripToBasket(inst)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left' as const, padding: '8px 10px', background: 'none', border: 'none',
                    borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}
                  onMouseOver={e => (e.currentTarget.style.background = 'var(--border)')}
                  onMouseOut={e => (e.currentTarget.style.background = 'none')}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{String(inst.stock_name || inst.symbol || inst.zanskar_name || '')}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
{String(inst.exchange || '')} · {String(inst.derivative_type || 'EQ')}
                      {inst.strike_price ? ` · Strike: ${Number(inst.strike_price) > 10000 ? (Number(inst.strike_price) / 100).toLocaleString('en-IN') : Number(inst.strike_price).toLocaleString('en-IN')}` : ''}
                      {inst.expiry ? ` · ${formatExpiry(String(inst.expiry))}` : ''}
                      {inst.lot_size ? ` · Lot: ${inst.lot_size}` : ''}
                    </div>
                  </div>
                  <span style={{ color: '#5865f2', fontWeight: 600, fontSize: 11, flexShrink: 0 }}>+ Add</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {placed && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '10px 20px', borderRadius: 8, fontSize: 12, fontWeight: 600, zIndex: 110, boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          background: placed.ok ? 'var(--green-dim)' : 'var(--red-dim)', color: placed.ok ? 'var(--green)' : 'var(--red)', border: `1px solid ${placed.ok ? '#22c55e40' : '#ef444440'}` }}>
          {placed.msg}
        </div>
      )}
    </div>
  );
}
