import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { fmtPrice, generateId, formatExpiry } from './lib/utils';
import { payoffAtExpiry, daysToExpiry } from './lib/GexService';
import { STRATEGY_TEMPLATES, type Sentiment } from './lib/strategyTemplates';
import { useWs } from './hooks/useWsContext';
import { useBasket, type BasketLegInput } from './hooks/useBasketContext';
import OptionChain from './OptionChain';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ChainRow {
  strike:      number;
  ceLtp:       number;
  peLtp:       number;
  ceRefId:     number | null;
  peRefId:     number | null;
  ceNubraName: string;
  peNubraName: string;
  lotSize:     number;
  ceIv:        number | null;
  peIv:        number | null;
  ceDelta:     number | null;
  peDelta:     number | null;
  ceGamma:     number | null;
  peGamma:     number | null;
  ceTheta:     number | null;
  peTheta:     number | null;
  ceVega:      number | null;
  peVega:      number | null;
  ceOi:        number | null;
  peOi:        number | null;
  ceVol:       number | null;
  peVol:       number | null;
}

interface Leg {
  id:           string;
  symbol:       string;
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
  asset:        string;
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

interface Props {
  instrument: Instrument | null;
}

type ViewMode = 'prebuilt' | 'saved' | 'builder';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function numField(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    if (obj[k] != null && !isNaN(Number(obj[k]))) return Number(obj[k]);
  }
  return null;
}

const ORDER_TYPE_MAP: Record<string, string> = {
  MKT:   'ORDER_TYPE_MARKET',
  LIMIT: 'ORDER_TYPE_REGULAR',
  SL:    'ORDER_TYPE_STOPLOSS',
};

const SENTIMENT_COLORS: Record<Sentiment, string> = {
  Bullish:  '#22c55e',
  Bearish:  '#ef4444',
  Neutral:  '#6366f1',
  Volatile: '#f59e0b',
};

// Mini payoff chart data for template cards
function miniPayoff(legs: Array<{ optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; strikeDist: number; lots: number }>): Array<{ x: number; y: number }> {
  const mapped = legs.map(l => ({
    strike: 24000 + l.strikeDist * 100,
    type: l.optionType,
    side: l.side,
    qty: l.lots,
    premium: l.side === 'BUY' ? 100 : 100,
  }));
  const strikes = mapped.map(l => l.strike);
  const min = Math.min(...strikes) - 400;
  const max = Math.max(...strikes) + 400;
  const step = (max - min) / 40;
  return Array.from({ length: 41 }, (_, i) => {
    const s = min + i * step;
    return { x: i, y: payoffAtExpiry(s, mapped) };
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function BasketOrder({ instrument }: Props) {
  const [legs,      setLegs]      = useState<Leg[]>([]);
  const [expiries,  setExpiries]  = useState<string[]>([]);
  const [expiry,    setExpiry]    = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [chainRows, setChainRows] = useState<ChainRow[]>([]);
  const [spot,      setSpot]      = useState<number | null>(null);
  const [placed,    setPlaced]    = useState<{ ok: boolean; msg: string } | null>(null);
  const [margin,    setMargin]    = useState<{ span?: number; exposure?: number; total: number; premium?: number; benefit?: number } | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [viewMode,  setViewMode]  = useState<ViewMode>('prebuilt');
  const [sentimentFilter, setSentimentFilter] = useState<Sentiment | 'All'>('All');
  const [savedBaskets, setSavedBaskets] = useState<Array<{ basket_id: string; name: string; symbol: string; expiry: string; legs: Leg[]; created_at: number }>>([]);
  const [saveName,  setSaveName]  = useState('');
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [targetDays, setTargetDays] = useState(5);
  const [addScripQuery, setAddScripQuery] = useState('');
  const [addScripResults, setAddScripResults] = useState<Array<Record<string, unknown>>>([]);
  const [showAddScrip, setShowAddScrip] = useState(false);
  const [rightTab, setRightTab] = useState<'payoff' | 'optionchain'>('payoff');
  const [symSearch, setSymSearch] = useState('');
  const [symResults, setSymResults] = useState<Array<Record<string, unknown>>>([]);
  const [showSymSearch, setShowSymSearch] = useState(false);
  const [leftWidth, setLeftWidth] = useState(480);
  const symSearchTimer = useRef<ReturnType<typeof setTimeout>>();
  const resizeRef = useRef<{ startX: number; startW: number } | null>(null);

  const marginTimer = useRef<ReturnType<typeof setTimeout>>();
  const addScripTimer = useRef<ReturnType<typeof setTimeout>>();
  const { subscribe, subscribeOC, unsubscribeOC } = useWs();
  const { onLegAdded, setBasketMode } = useBasket();

  const sym  = instrument
    ? (instrument.asset || (instrument.stock_name || '').replace(/\s+\d+$/, '').replace(/\s+/g, '') || getSymbol(instrument).replace(/\d.*/, '') || getSymbol(instrument))
    : null;
  const exch = instrument?.exchange || 'NSE';
  const instLotSize = instrument?.lot_size ?? 1;

  // Auto-enable basket mode when OC tab active in builder
  useEffect(() => {
    if (viewMode === 'builder' && rightTab === 'optionchain') {
      setBasketMode(true);
      return () => setBasketMode(false);
    }
  }, [viewMode, rightTab, setBasketMode]);

  // Auto-load chain when instrument changes
  useEffect(() => {
    if (sym) loadChain();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym]);

  // ── Listen for legs added from OptionChain basket mode ─────────────────────

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

  // ── Load chain ─────────────────────────────────────────────────────────────

  async function loadChain() {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}`);
      const data = await res.json() as {
        chain?: { all_expiries?: string[]; ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number };
      };
      const chain = data.chain;
      if (!chain) return;
      const exps = chain.all_expiries || [];
      setExpiries(exps);
      if (!expiry || !exps.includes(expiry)) setExpiry(exps[0] || '');
      if (chain.cp) setSpot(chain.cp > 10000 ? chain.cp / 100 : chain.cp);
      buildChainRows(chain.ce || [], chain.pe || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function changeExpiry(exp: string) {
    if (!sym) return;
    setExpiry(exp);
    setLoading(true);
    try {
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}&expiry=${exp}`);
      const data = await res.json() as { chain?: { ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number } };
      if (data.chain) {
        if (data.chain.cp) setSpot(data.chain.cp > 10000 ? data.chain.cp / 100 : data.chain.cp);
        buildChainRows(data.chain.ce || [], data.chain.pe || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  function buildChainRows(ceListIn: Array<Record<string, unknown>>, peListIn: Array<Record<string, unknown>>) {
    let ceList = ceListIn, peList = peListIn;
    if (ceList.length >= 3 && peList.length >= 3) {
      const sample = ceList.slice(0, Math.min(ceList.length, 40));
      const sorted = [...sample].sort((a, b) => (Number(a.sp) || 0) - (Number(b.sp) || 0));
      let ups = 0, downs = 0;
      for (let i = 1; i < sorted.length; i++) {
        const prev = Number(sorted[i - 1].ltp) || 0, curr = Number(sorted[i].ltp) || 0;
        if (prev > 0 && curr > 0) { if (curr > prev) ups++; else if (curr < prev) downs++; }
      }
      if (ups > downs && ups > 3) [ceList, peList] = [peList, ceList];
    }
    const map: Record<number, ChainRow> = {};
    for (const ce of ceList) {
      const sp  = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
      const ltp = ce.ltp != null ? Number(ce.ltp) / 100 : 0;
      const refId     = ce.ref_id != null ? Number(ce.ref_id) : null;
      const nubraName = String(ce.zanskar_name || ce.nubra_name || ce.symbol || '');
      const lotSize   = Number(ce.ls || ce.lot_size || 1);
      if (!map[sp]) map[sp] = { strike: sp, ceLtp: 0, peLtp: 0, ceRefId: null, peRefId: null, ceNubraName: '', peNubraName: '', lotSize, ceIv: null, peIv: null, ceDelta: null, peDelta: null, ceGamma: null, peGamma: null, ceTheta: null, peTheta: null, ceVega: null, peVega: null, ceOi: null, peOi: null, ceVol: null, peVol: null };
      map[sp].ceLtp = ltp; map[sp].ceRefId = refId; map[sp].ceNubraName = nubraName; map[sp].lotSize = lotSize;
      map[sp].ceIv = numField(ce, 'iv', 'implied_volatility'); map[sp].ceDelta = numField(ce, 'delta');
      map[sp].ceGamma = numField(ce, 'gamma'); map[sp].ceTheta = numField(ce, 'theta'); map[sp].ceVega = numField(ce, 'vega');
      map[sp].ceOi = numField(ce, 'oi', 'open_interest'); map[sp].ceVol = numField(ce, 'volume', 'vol');
    }
    for (const pe of peList) {
      const sp  = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
      const ltp = pe.ltp != null ? Number(pe.ltp) / 100 : 0;
      const refId     = pe.ref_id != null ? Number(pe.ref_id) : null;
      const nubraName = String(pe.zanskar_name || pe.nubra_name || pe.symbol || '');
      const lotSize   = Number(pe.ls || pe.lot_size || 1);
      if (!map[sp]) map[sp] = { strike: sp, ceLtp: 0, peLtp: 0, ceRefId: null, peRefId: null, ceNubraName: '', peNubraName: '', lotSize, ceIv: null, peIv: null, ceDelta: null, peDelta: null, ceGamma: null, peGamma: null, ceTheta: null, peTheta: null, ceVega: null, peVega: null, ceOi: null, peOi: null, ceVol: null, peVol: null };
      map[sp].peLtp = ltp; map[sp].peRefId = refId; map[sp].peNubraName = nubraName;
      if (!map[sp].lotSize || map[sp].lotSize <= 1) map[sp].lotSize = lotSize;
      map[sp].peIv = numField(pe, 'iv', 'implied_volatility'); map[sp].peDelta = numField(pe, 'delta');
      map[sp].peGamma = numField(pe, 'gamma'); map[sp].peTheta = numField(pe, 'theta'); map[sp].peVega = numField(pe, 'vega');
      map[sp].peOi = numField(pe, 'oi', 'open_interest'); map[sp].peVol = numField(pe, 'volume', 'vol');
    }
    setChainRows(Object.values(map).sort((a, b) => a.strike - b.strike));
  }

  // ── WebSocket live LTP ─────────────────────────────────────────────────────

  const legExpiries = useMemo(() => {
    const s = new Set(legs.map(l => l.expiry).filter(Boolean));
    return Array.from(s);
  }, [legs]);

  useEffect(() => {
    if (!sym) return;
    const allExpiries = new Set<string>();
    if (expiry) allExpiries.add(expiry);
    for (const e of legExpiries) allExpiries.add(e);
    for (const exp of allExpiries) subscribeOC(sym, exp, exch);
    return () => { for (const exp of allExpiries) unsubscribeOC(sym, exp, exch); };
  }, [sym, expiry, exch, legExpiries, subscribeOC, unsubscribeOC]);

  useEffect(() => {
    if (!sym) return;
    const unsub = subscribe('option_chain', (msg) => {
      const d = msg.data as Record<string, unknown> | undefined;
      if (!d) return;
      if (String(d.asset || '').toUpperCase() !== sym.toUpperCase()) return;
      const msgExpiry = String(d.expiry || '');
      const ceArr = (d.ce || []) as Array<Record<string, unknown>>;
      const peArr = (d.pe || []) as Array<Record<string, unknown>>;
      if (d.cp) setSpot(Number(d.cp) > 10000 ? Number(d.cp) / 100 : Number(d.cp));

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

      if (msgExpiry === expiry) {
        setChainRows(prev => prev.map(row => {
          const u = ltpMap.get(row.strike);
          if (!u) return row;
          return { ...row, ceLtp: u.ce ?? row.ceLtp, peLtp: u.pe ?? row.peLtp,
            ceIv: u.ceIv ?? row.ceIv, peIv: u.peIv ?? row.peIv, ceDelta: u.ceDelta ?? row.ceDelta, peDelta: u.peDelta ?? row.peDelta,
            ceGamma: u.ceGamma ?? row.ceGamma, peGamma: u.peGamma ?? row.peGamma, ceTheta: u.ceTheta ?? row.ceTheta, peTheta: u.peTheta ?? row.peTheta,
            ceVega: u.ceVega ?? row.ceVega, peVega: u.peVega ?? row.peVega };
        }));
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
    return unsub;
  }, [subscribe, sym, expiry]);

  // ── Leg CRUD ───────────────────────────────────────────────────────────────

  function addLeg(strike: number, optionType: 'CE' | 'PE', side: 'BUY' | 'SELL', row: ChainRow) {
    const ltp       = optionType === 'CE' ? row.ceLtp       : row.peLtp;
    const refId     = optionType === 'CE' ? row.ceRefId     : row.peRefId;
    const nubraName = optionType === 'CE' ? row.ceNubraName : row.peNubraName;
    setLegs(prev => [...prev, {
      id: generateId(), symbol: sym!, optionType, side, strike, expiry,
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
    const atm = spot ? chainRows.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best, chainRows[0]) : chainRows[Math.floor(chainRows.length / 2)];
    if (atm) addLeg(atm.strike, 'CE', 'BUY', atm);
  }

  function addEmptyFutLeg() {
    addEmptyOptLeg();
  }

  // ── Symbol search (change underlying) ──────────────────────────────────────

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
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        }).slice(0, 8);
        setSymResults(merged);
      } catch { setSymResults([]); }
    }, 250);
  }

  function selectSymbol(inst: Record<string, unknown>) {
    const newSym = String(inst.asset || inst.stock_name || '').replace(/\s+\d+$/, '').replace(/\s+/g, '');
    if (!newSym) return;
    setShowSymSearch(false);
    setSymSearch('');
    setSymResults([]);
    setChainRows([]);
    setExpiries([]);
    setExpiry('');
    setSpot(null);
    // Fetch new chain
    (async () => {
      setLoading(true);
      try {
        const newExch = String(inst.exchange || 'NSE');
        const res = await fetch(`/api/optionchain/${encodeURIComponent(newSym)}?exchange=${newExch}`);
        const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number } };
        if (data.chain) {
          const exps = data.chain.all_expiries || [];
          setExpiries(exps);
          setExpiry(exps[0] || '');
          if (data.chain.cp) setSpot(data.chain.cp > 10000 ? data.chain.cp / 100 : data.chain.cp);
          buildChainRows(data.chain.ce || [], data.chain.pe || []);
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }

  // ── Add Scrip search ──────────────────────────────────────────────────────

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
    const exp = String(inst.expiry || expiry || '');
    setLegs(prev => [...prev, {
      id: generateId(), symbol: String(inst.asset || inst.stock_name || sym || ''),
      optionType: optType, side: 'BUY', strike, expiry: exp,
      lots: 1, lotSize, ltp, entryLtp: ltp, refId, nubraName: name,
      asset: String(inst.asset || inst.stock_name || sym || ''),
      orderType: 'MKT', limitPrice: null, triggerPrice: null, deliveryType: 'IDAY',
      iv: null, delta: null, gamma: null, theta: null, vega: null,
    }]);
    setShowAddScrip(false);
    setAddScripQuery('');
    setAddScripResults([]);
  }

  // ── Strategy templates ─────────────────────────────────────────────────────

  function applyTemplate(tmplId: string) {
    const tmpl = STRATEGY_TEMPLATES.find(t => t.id === tmplId);
    if (!tmpl || !chainRows.length) return;
    const strikes = chainRows.map(r => r.strike).sort((a, b) => a - b);
    const step = strikes.length >= 2 ? strikes[1] - strikes[0] : 50;
    const atm = spot ? strikes.reduce((best, s) => Math.abs(s - spot) < Math.abs(best - spot) ? s : best, strikes[0]) : strikes[Math.floor(strikes.length / 2)];

    const newLegs: Leg[] = tmpl.legs.map(tl => {
      const target = atm + tl.strikeDist * step;
      const row = chainRows.reduce((best, r) => Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best);
      return {
        id: generateId(), symbol: sym!, optionType: tl.optionType, side: tl.side,
        strike: row.strike, expiry, lots: tl.lots, lotSize: row.lotSize,
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
    setViewMode('builder');
  }

  // ── Multiplier ─────────────────────────────────────────────────────────────

  function applyMultiplier(newMult: number) {
    if (newMult < 1 || newMult === multiplier) return;
    const ratio = newMult / multiplier;
    setLegs(prev => prev.map(l => ({ ...l, lots: Math.max(1, Math.round(l.lots * ratio)) })));
    setMultiplier(newMult);
  }

  // ── Save / Load baskets ─────────────────────────────────────────────────────

  async function loadSavedBaskets() {
    try {
      const res = await fetch('/paper/baskets');
      const data = await res.json() as { baskets: Array<{ basket_id: string; name: string; symbol: string; expiry: string; legs: Leg[]; created_at: number }> };
      setSavedBaskets(data.baskets || []);
    } catch { /* ignore */ }
  }
  useEffect(() => { loadSavedBaskets(); }, []);

  async function saveBasket() {
    if (!legs.length || !saveName.trim()) return;
    try {
      await fetch('/paper/baskets', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName.trim(), symbol: sym, expiry, legs }) });
      setShowSaveModal(false); setSaveName(''); loadSavedBaskets();
      setPlaced({ ok: true, msg: 'Strategy saved!' }); setTimeout(() => setPlaced(null), 3000);
    } catch (e) { setPlaced({ ok: false, msg: (e as Error).message }); }
  }

  async function deleteSavedBasket(id: string) {
    try { await fetch(`/paper/baskets/${id}`, { method: 'DELETE' }); loadSavedBaskets(); } catch { /* ignore */ }
  }

  function loadSavedBasket(basket: { legs: Leg[]; expiry: string }) {
    setLegs(basket.legs.map(l => ({ ...l, id: generateId(), entryLtp: l.entryLtp ?? l.ltp })));
    if (basket.expiry && basket.expiry !== expiry) changeExpiry(basket.expiry);
    setViewMode('builder');
  }

  // ── Computed values ────────────────────────────────────────────────────────

  const totalPrice = useMemo(() => legs.reduce((acc, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    return acc + sign * l.ltp;
  }, 0), [legs]);

  const totalPremium = useMemo(() => legs.reduce((acc, l) => {
    const sign = l.side === 'BUY' ? -1 : 1;
    return acc + sign * l.ltp * l.lots * l.lotSize;
  }, 0), [legs]);

  const totalMtm = useMemo(() => legs.reduce((acc, l) => {
    const mtm = (l.ltp - l.entryLtp) * l.lots * l.lotSize * (l.side === 'BUY' ? 1 : -1);
    return acc + mtm;
  }, 0), [legs]);

  const netGreeks = useMemo(() => legs.reduce((acc, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    const qty  = l.lots * l.lotSize;
    return { delta: acc.delta + (l.delta ?? 0) * qty * sign, gamma: acc.gamma + (l.gamma ?? 0) * qty * sign,
      theta: acc.theta + (l.theta ?? 0) * qty * sign, vega: acc.vega + (l.vega ?? 0) * qty * sign };
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 }), [legs]);

  // ── Payoff chart ──────────────────────────────────────────────────────────

  const payoffData = useMemo(() => {
    if (!legs.length) return [];
    const payoffLegs = legs.map(l => ({ strike: l.strike, type: l.optionType, side: l.side, qty: l.lots * l.lotSize, premium: l.ltp }));
    const strikes = payoffLegs.map(l => l.strike);
    const minS = Math.min(...strikes) * 0.90;
    const maxS = Math.max(...strikes) * 1.10;
    const step = (maxS - minS) / 200;
    return Array.from({ length: 201 }, (_, i) => {
      const s = minS + i * step;
      const pnl = payoffAtExpiry(s, payoffLegs);
      return { spot: Math.round(s), pnl: Math.round(pnl * 100) / 100 };
    });
  }, [legs]);

  const maxProfit = payoffData.length ? Math.max(...payoffData.map(d => d.pnl)) : 0;
  const maxLoss   = payoffData.length ? Math.min(...payoffData.map(d => d.pnl)) : 0;
  const breakevenPoints = useMemo(() => {
    const bps: number[] = [];
    for (let i = 1; i < payoffData.length; i++) {
      if ((payoffData[i-1].pnl < 0 && payoffData[i].pnl >= 0) || (payoffData[i-1].pnl >= 0 && payoffData[i].pnl < 0))
        bps.push(Math.round((payoffData[i-1].spot + payoffData[i].spot) / 2));
    }
    return bps;
  }, [payoffData]);

  const riskReward = maxLoss !== 0 ? Math.abs(maxProfit / maxLoss) : 0;

  // ── Margin fetch ───────────────────────────────────────────────────────────

  const fetchMargin = useCallback(async () => {
    if (!legs.length) { setMargin(null); return; }
    const validLegs = legs.filter(l => l.refId && l.strike > 0 && l.lots > 0 && l.lotSize > 0 && (l.optionType === 'CE' || l.optionType === 'PE'));
    if (!validLegs.length) { setMargin(null); return; }
    try {
      const res = await fetch('/paper/margin/basket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: exch, multiplier, orders: validLegs.map(l => ({
          ref_id: l.refId, order_qty: l.lots * l.lotSize,
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
        })) }) });
      if (!res.ok) { setMargin(null); return; }
      const data = await res.json() as Record<string, unknown>;
      const total = Number(data.total_margin ?? 0) / 100;
      const span = Number(data.span ?? 0) / 100;
      const exposure = Number(data.exposure ?? 0) / 100;
      const premium = Number(data.opt_prem ?? 0) / 100;
      // Hedge benefit = sum of individual margins - basket margin (if we had individual sums)
      // For now, show the margin breakdown from Nubra directly
      const individualSum = span + exposure + premium;
      const benefit = individualSum > total && total > 0 ? individualSum - total : 0;
      setMargin({ total, benefit: benefit > 0 ? benefit : undefined, span: span > 0 ? span : undefined,
        exposure: exposure > 0 ? exposure : undefined, premium: premium > 0 ? premium : undefined });
    } catch { setMargin(null); }
  }, [legs, exch, multiplier]);

  useEffect(() => {
    clearTimeout(marginTimer.current);
    marginTimer.current = setTimeout(fetchMargin, 400);
    return () => clearTimeout(marginTimer.current);
  }, [fetchMargin]);

  // ── Place orders ───────────────────────────────────────────────────────────

  async function placeOrders() {
    if (!legs.length) return;
    const missing = legs.filter(l => !l.refId && !l.nubraName);
    if (missing.length) { setPlaced({ ok: false, msg: `${missing.length} leg(s) missing instrument IDs.` }); return; }
    const sorted = [...legs].sort((a, b) => { if (a.side === 'BUY' && b.side === 'SELL') return -1; if (a.side === 'SELL' && b.side === 'BUY') return 1; return 0; });
    setLoading(true); setPlaced(null);
    try {
      const res = await fetch('/paper/orders/basket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: sorted.map(l => ({
          nubraName: l.nubraName || `${l.symbol}${l.strike}${l.optionType}`, liveRefId: l.refId,
          display_name: `${l.symbol} ${l.strike} ${l.optionType}`, order_type: ORDER_TYPE_MAP[l.orderType],
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL', order_qty: l.lots * l.lotSize,
          order_price: l.limitPrice ? Math.round(l.limitPrice * 100) : undefined,
          trigger_price: l.triggerPrice ? Math.round(l.triggerPrice * 100) : undefined,
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
          validity_type: 'DAY', asset: l.asset, expiry: l.expiry, derivative_type: 'OPT',
        })) }) });
      const d = await res.json() as { orders?: Array<{ order_id: number }>; error?: string };
      if (!res.ok || d.error) throw new Error(d.error || 'Basket placement failed');
      setPlaced({ ok: true, msg: `${d.orders?.length ?? legs.length} order(s) placed!` });
      setTimeout(() => setPlaced(null), 5000);
    } catch (e) { setPlaced({ ok: false, msg: (e as Error).message }); }
    finally { setLoading(false); }
  }

  // ── Render helpers ─────────────────────────────────────────────────────────

  const dte = expiry ? daysToExpiry(expiry) : 0;

  // ── No instrument selected ─────────────────────────────────────────────────

  if (!instrument) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#8b8fa3', fontSize: 14, background: '#0f0f14' }}>
        Select an F&O instrument to build strategies
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-BUILT / SAVED VIEWS
  // ═══════════════════════════════════════════════════════════════════════════

  if (viewMode !== 'builder') {
    const filtered = sentimentFilter === 'All' ? STRATEGY_TEMPLATES : STRATEGY_TEMPLATES.filter(t => t.sentiment === sentimentFilter);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f14', color: '#e2e4f0', overflow: 'hidden' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #1e2030', background: '#13141c' }}>
          <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid #2a2d42' }}>
            <button onClick={() => setViewMode('prebuilt')}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === 'prebuilt' ? '#5865f2' : 'transparent', color: viewMode === 'prebuilt' ? '#fff' : '#8b8fa3' }}>
              Pre-built
            </button>
            <button onClick={() => { setViewMode('saved'); loadSavedBaskets(); }}
              style={{ padding: '6px 16px', fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: viewMode === 'saved' ? '#5865f2' : 'transparent', color: viewMode === 'saved' ? '#fff' : '#8b8fa3' }}>
              Saved
            </button>
          </div>

          {viewMode === 'prebuilt' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 12, fontSize: 12 }}>
                <span style={{ color: '#8b8fa3', marginRight: 2 }}>🔍</span>
                <span style={{ fontWeight: 600, color: '#e2e4f0' }}>{sym}</span>
                <span style={{ color: '#22c55e', fontSize: 11 }}>{spot ? spot.toLocaleString('en-IN') : ''}</span>
                <span style={{ color: '#8b8fa3', fontSize: 11 }}>{exch}</span>
              </div>

              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {(['All', 'Bullish', 'Bearish', 'Neutral', 'Volatile'] as const).map(s => (
                  <button key={s} onClick={() => setSentimentFilter(s)}
                    style={{ padding: '4px 12px', borderRadius: 16, fontSize: 11, fontWeight: 500, cursor: 'pointer',
                      border: sentimentFilter === s ? '1px solid #5865f2' : '1px solid #2a2d42',
                      background: sentimentFilter === s ? '#5865f2' + '20' : 'transparent',
                      color: sentimentFilter === s ? '#5865f2' : '#8b8fa3' }}>
                    {s !== 'All' && <span style={{ marginRight: 4 }}>{s === 'Bullish' ? '🟢' : s === 'Bearish' ? '🔴' : s === 'Neutral' ? '🟣' : '🟡'}</span>}
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Pre-built grid */}
        {viewMode === 'prebuilt' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
              {filtered.map(tmpl => {
                const mini = miniPayoff(tmpl.legs);
                const color = SENTIMENT_COLORS[tmpl.sentiment];
                return (
                  <div key={tmpl.id}
                    style={{ background: '#181a25', borderRadius: 12, border: '1px solid #1e2030', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    {/* Mini payoff */}
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
                          return (
                            <>
                              <line x1="0" y1={zeroY} x2="41" y2={zeroY} stroke="#2a2d42" strokeWidth="0.5" strokeDasharray="2 2" />
                              <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
                            </>
                          );
                        })()}
                      </svg>
                    </div>
                    {/* Info */}
                    <div style={{ padding: '8px 12px 12px', flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e4f0' }}>{tmpl.label}</span>
                        <span style={{ fontSize: 10, color, fontWeight: 500 }}>{tmpl.sentiment}</span>
                      </div>
                      <p style={{ fontSize: 11, color: '#8b8fa3', lineHeight: 1.4, margin: 0, flex: 1 }}>{tmpl.description}</p>
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

        {/* Saved view */}
        {viewMode === 'saved' && (
          <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
            {savedBaskets.length === 0 ? (
              <div style={{ display: 'flex', height: '100%', gap: 24 }}>
                {/* Left — empty state with payoff placeholder */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                  {/* Decorative payoff graph */}
                  <svg viewBox="0 0 300 160" style={{ width: 300, height: 160, opacity: 0.6 }}>
                    <defs>
                      <linearGradient id="savedGreen" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="savedRed" x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0%" stopColor="#ef4444" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <path d="M0,140 L60,140 L100,100 L150,60 L200,40 L250,30 L300,25" fill="none" stroke="#22c55e" strokeWidth="2" />
                    <path d="M0,140 L60,140 L100,100 L150,60 L200,40 L250,30 L300,25 L300,160 L0,160 Z" fill="url(#savedGreen)" />
                    <path d="M0,20 L50,30 L100,80 L150,100 L200,115 L250,120 L300,120" fill="none" stroke="#ef4444" strokeWidth="1.5" opacity={0.6} />
                    <line x1="0" y1="100" x2="300" y2="100" stroke="#2a2d42" strokeWidth="0.5" strokeDasharray="4 4" />
                  </svg>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#e2e4f0' }}>Your Strategies Will Appear Here</div>
                  <div style={{ fontSize: 13, color: '#8b8fa3' }}>Build and save strategies to analyze your trades better</div>
                </div>
                {/* Right — CTA card */}
                <div style={{ width: 260, background: '#181a25', borderRadius: 12, border: '1px solid #1e2030', padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, alignSelf: 'center' }}>
                  <div style={{ fontSize: 40 }}>🎯</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e4f0', textAlign: 'center' as const }}>Ready to create your own strategy?</div>
                  <div style={{ fontSize: 12, color: '#8b8fa3', textAlign: 'center' as const }}>Take control and build one that works for you.</div>
                  <button onClick={() => setViewMode('builder')}
                    style={{ marginTop: 4, padding: '10px 24px', borderRadius: 8, border: 'none', background: '#5865f2',
                      color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', width: '100%' }}>
                    Build my strategy
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
                {savedBaskets.map(b => (
                  <div key={b.basket_id} style={{ background: '#181a25', borderRadius: 10, border: '1px solid #1e2030', padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e4f0' }}>{b.name}</span>
                      <button onClick={() => deleteSavedBasket(b.basket_id)}
                        style={{ background: 'none', border: 'none', color: '#8b8fa3', cursor: 'pointer', fontSize: 14 }}>✕</button>
                    </div>
                    <div style={{ fontSize: 11, color: '#8b8fa3', marginBottom: 10 }}>{b.symbol} · {formatExpiry(b.expiry)} · {b.legs.length} legs</div>
                    <button onClick={() => loadSavedBasket(b)}
                      style={{ width: '100%', padding: '7px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>
                      Load Strategy
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUILDER VIEW — Nubra-style two-panel layout
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f14', color: '#e2e4f0', overflow: 'hidden' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderBottom: '1px solid #1e2030', background: '#13141c', flexShrink: 0 }}>
        <button onClick={() => setViewMode('prebuilt')} style={{ background: 'none', border: 'none', color: '#5865f2', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
          ← Back to all strategies
        </button>
        <div style={{ marginLeft: 'auto', fontSize: 10, color: '#6b6f85' }}>
          {expiry && `${Math.round(dte)}d to expiry`}
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* ═══ LEFT PANEL — legs + analysis ═══ */}
        <div style={{ width: leftWidth, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* Symbol header */}
          <div style={{ padding: '10px 16px', borderBottom: '1px solid #1e2030' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, position: 'relative' as const }}>
              <span style={{ fontSize: 12, color: '#8b8fa3', cursor: 'pointer' }} onClick={() => setShowSymSearch(!showSymSearch)}>🔍</span>
              {showSymSearch ? (
                <div style={{ position: 'relative' }}>
                  <input type="text" value={symSearch} onChange={e => searchSymbol(e.target.value)} autoFocus
                    placeholder="Search NIFTY, BANKNIFTY..."
                    onBlur={() => setTimeout(() => setShowSymSearch(false), 200)}
                    style={{ padding: '4px 10px', background: '#1a1c28', border: '1px solid #5865f2', borderRadius: 6, color: '#e2e4f0', fontSize: 13, fontWeight: 700, outline: 'none', width: 200 }} />
                  {symResults.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, width: 240, background: '#181a25', border: '1px solid #2a2d42', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', zIndex: 50, overflow: 'hidden' }}>
                      {symResults.map((inst, i) => (
                        <button key={i} onMouseDown={() => selectSymbol(inst)}
                          style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '8px 12px', background: 'none', border: 'none', borderBottom: '1px solid #1e2030', color: '#e2e4f0', cursor: 'pointer', fontSize: 12 }}>
                          <span style={{ fontWeight: 700 }}>{String(inst.asset || inst.stock_name || '')}</span>
                          <span style={{ color: '#6b6f85', marginLeft: 6, fontSize: 10 }}>{String(inst.exchange || '')} · {String(inst.derivative_type || inst.asset_type || '')}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <span style={{ fontWeight: 700, fontSize: 15, color: '#e2e4f0', cursor: 'pointer' }} onClick={() => setShowSymSearch(true)}>{sym}</span>
              )}
              <span style={{ fontSize: 13, color: '#22c55e' }}>{spot ? spot.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}</span>
              <span style={{ fontSize: 11, color: '#8b8fa3' }}>{exch}</span>
              <select value="" onChange={e => { if (e.target.value) applyTemplate(e.target.value); }}
                style={{ marginLeft: 'auto', padding: '4px 8px', background: '#1a1c28', border: '1px solid #2a2d42', borderRadius: 6, color: '#8b8fa3', fontSize: 11 }}>
                <option value="">Custom Strategy</option>
                {STRATEGY_TEMPLATES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </div>
            {spot && (
              <div style={{ fontSize: 11, color: '#8b8fa3' }}>
                {totalPrice.toFixed(2)} <span style={{ color: totalPrice >= 0 ? '#22c55e' : '#ef4444' }}>+0.00 (0.00%)</span>
                <span style={{ marginLeft: 12, color: '#6b6f85' }}>Bid 0.00  Ask 0.00</span>
              </div>
            )}
          </div>

          {/* Legs table */}
          <div style={{ padding: '0 12px 8px' }}>
            {/* Header */}
            <div style={{ display: 'grid', gridTemplateColumns: '30px 88px 96px 30px 68px 52px 64px 24px', alignItems: 'center', gap: 2, padding: '8px 0', borderBottom: '1px solid #1e2030', fontSize: 10, fontWeight: 600, color: '#6b6f85', textTransform: 'uppercase' as const }}>
              <span>B/S</span><span>Expiry</span><span>Strike</span><span>Type</span><span>Qty</span><span>LTP</span><span>P&L</span><span></span>
            </div>

            {/* Leg rows */}
            {legs.map(leg => (
              <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '30px 88px 96px 30px 68px 52px 64px 24px', alignItems: 'center', gap: 2, padding: '6px 0', borderBottom: '1px solid #1a1c28' }}>
                {/* B/S badge */}
                <button onClick={() => updateLeg(leg.id, { side: leg.side === 'BUY' ? 'SELL' : 'BUY' })}
                  style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 11,
                    background: leg.side === 'BUY' ? '#1a3a2a' : '#3a1a1a', color: leg.side === 'BUY' ? '#22c55e' : '#ef4444' }}>
                  {leg.side === 'BUY' ? 'B' : 'S'}
                </button>

                {/* Expiry */}
                <select value={leg.expiry} onChange={e => updateLeg(leg.id, { expiry: e.target.value })}
                  style={{ padding: '3px 2px', background: '#1a1c28', border: '1px solid #2a2d42', borderRadius: 4, color: '#e2e4f0', fontSize: 11, width: '100%' }}>
                  {expiries.map(exp => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
                </select>

                {/* Strike stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button onClick={() => { const idx = chainRows.findIndex(r => r.strike === leg.strike); if (idx > 0) { const r = chainRows[idx - 1]; const newLtp = leg.optionType === 'CE' ? r.ceLtp : r.peLtp; updateLeg(leg.id, { strike: r.strike, ltp: newLtp, entryLtp: newLtp, refId: leg.optionType === 'CE' ? r.ceRefId : r.peRefId, nubraName: leg.optionType === 'CE' ? r.ceNubraName : r.peNubraName }); } }}
                    style={{ width: 18, height: 20, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                  <span style={{ fontWeight: 600, fontSize: 11, color: '#e2e4f0', flex: 1, textAlign: 'center' as const }}>{leg.strike.toLocaleString('en-IN')}</span>
                  <button onClick={() => { const idx = chainRows.findIndex(r => r.strike === leg.strike); if (idx < chainRows.length - 1) { const r = chainRows[idx + 1]; const newLtp = leg.optionType === 'CE' ? r.ceLtp : r.peLtp; updateLeg(leg.id, { strike: r.strike, ltp: newLtp, entryLtp: newLtp, refId: leg.optionType === 'CE' ? r.ceRefId : r.peRefId, nubraName: leg.optionType === 'CE' ? r.ceNubraName : r.peNubraName }); } }}
                    style={{ width: 18, height: 20, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                </div>

                {/* CE/PE badge */}
                <button onClick={() => updateLeg(leg.id, { optionType: leg.optionType === 'CE' ? 'PE' : 'CE' })}
                  style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 10,
                    background: leg.optionType === 'CE' ? '#1a3a2a' : '#3a1a1a', color: leg.optionType === 'CE' ? '#22c55e' : '#ef4444' }}>
                  {leg.optionType}
                </button>

                {/* Qty stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                  <button onClick={() => updateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                    style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#e2e4f0', flex: 1, textAlign: 'center' as const }}>{leg.lots * leg.lotSize}</span>
                  <button onClick={() => updateLeg(leg.id, { lots: leg.lots + 1 })}
                    style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                </div>

                {/* LTP */}
                <span style={{ fontSize: 11, color: '#8b8fa3' }}>{fmtPrice(leg.ltp)}</span>

                {/* Premium (unrealized P&L) */}
                {(() => {
                  const mtm = (leg.ltp - leg.entryLtp) * leg.lots * leg.lotSize * (leg.side === 'BUY' ? 1 : -1);
                  return (
                    <span style={{ fontSize: 11, fontWeight: 600, color: mtm >= 0 ? '#22c55e' : '#ef4444' }}>
                      {mtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(mtm))}
                    </span>
                  );
                })()}

                {/* Delete */}
                <button onClick={() => removeLeg(leg.id)}
                  style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid transparent', background: 'transparent', color: '#6b6f85', cursor: 'pointer', fontSize: 13,
                    display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#3a1a1a'; e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.borderColor = '#ef444440'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#6b6f85'; e.currentTarget.style.borderColor = 'transparent'; }}>
                  ✕
                </button>
              </div>
            ))}

            {/* Add leg buttons */}
            <div style={{ display: 'flex', gap: 12, padding: '10px 0', fontSize: 12 }}>
              <button onClick={addEmptyOptLeg} disabled={!chainRows.length}
                style={{ background: 'none', border: 'none', color: '#5865f2', cursor: 'pointer', fontWeight: 600, fontSize: 12, opacity: chainRows.length ? 1 : 0.4 }}>
                + Add OPT Leg
              </button>
              <button onClick={addEmptyFutLeg} disabled={!chainRows.length}
                style={{ background: 'none', border: 'none', color: '#5865f2', cursor: 'pointer', fontWeight: 600, fontSize: 12, opacity: chainRows.length ? 1 : 0.4 }}>
                + Add FUT Leg
              </button>
              <button onClick={() => { setShowAddScrip(true); setAddScripQuery(''); setAddScripResults([]); }}
                style={{ background: 'none', border: 'none', color: '#22c55e', cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>
                + Add Scrip
              </button>
            </div>

            {/* Total Price + Lot Multiplier */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid #1e2030' }}>
              <div>
                <span style={{ fontSize: 11, color: '#6b6f85' }}>Total Price: </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e4f0' }}>₹{totalPrice.toFixed(2)}</span>
                <span style={{ fontSize: 11, color: '#6b6f85', marginLeft: 16 }}>Total Premium: </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: totalPremium >= 0 ? '#22c55e' : '#ef4444' }}>{totalPremium >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPremium))}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ color: '#6b6f85' }}>Lot Multiplier:</span>
                <button onClick={() => applyMultiplier(Math.max(1, multiplier - 1))}
                  style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                <span style={{ fontWeight: 700, color: '#e2e4f0', minWidth: 16, textAlign: 'center' as const }}>{multiplier}</span>
                <button onClick={() => applyMultiplier(multiplier + 1)}
                  style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
              </div>
            </div>

            {totalPremium > 0 && (
              <div style={{ fontSize: 10, color: '#8b8fa3', padding: '4px 0', display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#6b6f85' }}>ℹ</span> Negative prices indicate that executing this strategy will result in a net cash inflow.
              </div>
            )}

            {/* Margin Breakdown — above Save/Trade */}
            {margin && (
              <div style={{ background: '#181a25', borderRadius: 10, border: '1px solid #1e2030', overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #1e2030' }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e4f0' }}>Margin Breakdown</span>
                  {margin.benefit && margin.benefit > 0 && (
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#22c55e' }}>Margin Benefit: {fmtPrice(margin.benefit)}</span>
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '12px 14px' }}>
                  <div><div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Span</div><div style={{ fontSize: 13, fontWeight: 600, color: '#e2e4f0' }}>{margin.span ? fmtPrice(margin.span) : '—'}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Exposure</div><div style={{ fontSize: 13, fontWeight: 600, color: '#e2e4f0' }}>{margin.exposure ? fmtPrice(margin.exposure) : '—'}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Total Margin</div><div style={{ fontSize: 13, fontWeight: 600, color: '#e2e4f0' }}>{fmtPrice(margin.total)}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Premium Payable</div><div style={{ fontSize: 13, fontWeight: 600, color: '#e2e4f0' }}>{margin.premium ? fmtPrice(margin.premium) : fmtPrice(Math.abs(totalPremium))}</div></div>
                </div>
              </div>
            )}

            {/* Save + Trade buttons */}
            <div style={{ display: 'flex', gap: 10, padding: '10px 0' }}>
              <button onClick={() => { setShowSaveModal(true); setSaveName(''); }}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #2a2d42', background: 'transparent', color: '#e2e4f0', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Save
              </button>
              <button onClick={placeOrders} disabled={loading || !legs.length}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: loading || !legs.length ? 0.5 : 1 }}>
                {loading ? 'Placing…' : 'Trade'}
              </button>
            </div>
          </div>

          {/* Greeks table */}
          {legs.length > 0 && legs.some(l => l.delta != null) && (
            <div style={{ margin: '0 12px 12px', background: '#181a25', borderRadius: 10, border: '1px solid #1e2030', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e2030', fontWeight: 700, fontSize: 13, color: '#e2e4f0' }}>Greeks</div>
              <div style={{ padding: '0 14px' }}>
                {/* Header */}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1a1c28', fontSize: 10, fontWeight: 600, color: '#6b6f85' }}>
                  <span>B/S</span><span>Instrument</span><span>Strike</span><span>Qty</span><span>Delta</span><span>Theta</span><span>Gamma</span><span>Vega</span>
                </div>
                {/* Rows */}
                {legs.map(leg => (
                  <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1a1c28', fontSize: 11 }}>
                    <span style={{ width: 22, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 10,
                      background: leg.side === 'BUY' ? '#1a3a2a' : '#3a1a1a', color: leg.side === 'BUY' ? '#22c55e' : '#ef4444' }}>
                      {leg.side === 'BUY' ? 'B' : 'S'}
                    </span>
                    <span style={{ color: '#e2e4f0', fontSize: 11 }}>{formatExpiry(leg.expiry)} {leg.optionType}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.strike.toLocaleString('en-IN')}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.lots * leg.lotSize}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.delta?.toFixed(2) ?? '—'}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.theta?.toFixed(2) ?? '—'}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.gamma?.toFixed(4) ?? '—'}</span>
                    <span style={{ color: '#e2e4f0' }}>{leg.vega?.toFixed(2) ?? '—'}</span>
                  </div>
                ))}
                {/* Totals */}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 60px 40px 60px 60px 60px 60px', alignItems: 'center', padding: '8px 0', fontSize: 11, fontWeight: 700, color: '#e2e4f0' }}>
                  <span></span>
                  <span style={{ fontSize: 10, color: '#6b6f85' }}>Total × (Lot size × Lots)</span>
                  <span></span><span></span>
                  <span>{netGreeks.delta.toFixed(2)}</span>
                  <span>{netGreeks.theta.toFixed(2)}</span>
                  <span>{netGreeks.gamma.toFixed(4)}</span>
                  <span>{netGreeks.vega.toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Profit / Loss table */}
          {legs.length > 0 && (
            <div style={{ margin: '0 12px 16px', background: '#181a25', borderRadius: 10, border: '1px solid #1e2030', overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid #1e2030', fontWeight: 700, fontSize: 13, color: '#e2e4f0' }}>Profit / Loss</div>
              <div style={{ padding: '0 14px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1a1c28', fontSize: 10, fontWeight: 600, color: '#6b6f85' }}>
                  <span>B/S</span><span>Instrument</span><span>Strike</span><span>Qty</span><span style={{ textAlign: 'right' as const }}>Unrealized P&L</span>
                </div>
                {legs.map(leg => {
                  const mtm = (leg.ltp - leg.entryLtp) * leg.lots * leg.lotSize * (leg.side === 'BUY' ? 1 : -1);
                  return (
                    <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1a1c28', fontSize: 11 }}>
                      <span style={{ width: 22, height: 18, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 10,
                        background: leg.side === 'BUY' ? '#1a3a2a' : '#3a1a1a', color: leg.side === 'BUY' ? '#22c55e' : '#ef4444' }}>
                        {leg.side === 'BUY' ? 'B' : 'S'}
                      </span>
                      <span style={{ color: '#e2e4f0' }}>{formatExpiry(leg.expiry)} {leg.optionType}</span>
                      <span style={{ color: '#e2e4f0' }}>{leg.strike.toLocaleString('en-IN')}</span>
                      <span style={{ color: '#e2e4f0' }}>{leg.lots * leg.lotSize}</span>
                      <span style={{ textAlign: 'right' as const, fontWeight: 600, color: mtm >= 0 ? '#22c55e' : '#ef4444' }}>
                        {mtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(mtm))}
                      </span>
                    </div>
                  );
                })}
                <div style={{ display: 'grid', gridTemplateColumns: '32px 90px 80px 50px 1fr', alignItems: 'center', padding: '8px 0', fontSize: 11, fontWeight: 700, color: '#e2e4f0' }}>
                  <span></span>
                  <span style={{ fontSize: 10, color: '#6b6f85' }}>Total Unrealized P&L</span>
                  <span></span><span></span>
                  <span style={{ textAlign: 'right' as const, color: totalMtm >= 0 ? '#22c55e' : '#ef4444' }}>{totalMtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalMtm))}</span>
                </div>
                <div style={{ padding: '6px 0 8px', fontSize: 10, color: '#6b6f85' }}>
                  P&L is mark-to-market (entry price vs current LTP).
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ═══ RESIZE HANDLE ═══ */}
        <div
          onMouseDown={e => {
            e.preventDefault();
            resizeRef.current = { startX: e.clientX, startW: leftWidth };
            const onMove = (ev: MouseEvent) => {
              if (!resizeRef.current) return;
              setLeftWidth(Math.max(320, Math.min(800, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX))));
            };
            const onUp = () => { resizeRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
          style={{ width: 5, cursor: 'col-resize', background: '#1e2030', flexShrink: 0 }}
          onMouseEnter={e => (e.currentTarget.style.background = '#5865f2')}
          onMouseLeave={e => { if (!resizeRef.current) e.currentTarget.style.background = '#1e2030'; }}
        />

        {/* ═══ RIGHT PANEL — payoff chart + option chain ═══ */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {/* Stats bar */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, padding: '12px 16px', borderBottom: '1px solid #1e2030', flexShrink: 0 }}>
                <div>
                  <div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Max Profit</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#22c55e' }}>
                    {maxProfit > 1e6 ? 'Unlimited' : `+₹${fmtPrice(maxProfit)}`}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Max Loss</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#ef4444' }}>
                    {maxLoss < -1e6 ? 'Unlimited' : `-₹${fmtPrice(Math.abs(maxLoss))}`}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Breakeven</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e4f0' }}>
                    {breakevenPoints.length ? breakevenPoints.map(bp => bp.toLocaleString('en-IN')).join(', ') : '—'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Risk Reward Ratio</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e4f0' }}>{riskReward ? `1:${riskReward.toFixed(2)}` : '—'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#6b6f85', marginBottom: 2 }}>Probability of profit</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#e2e4f0' }}>
                    {breakevenPoints.length && spot ? (() => {
                      const bullish = payoffData.filter(d => d.spot >= spot && d.pnl > 0).length;
                      const total = payoffData.filter(d => d.spot >= spot * 0.95).length;
                      return total > 0 ? `${((bullish / total) * 100).toFixed(1)}%` : '—';
                    })() : '—'}
                  </div>
                </div>
              </div>

              {/* Tab bar: Payoff Graph | Option Chain */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1e2030', flexShrink: 0 }}>
                {([['payoff', 'Payoff Graph'], ['optionchain', 'Option Chain']] as const).map(([key, label]) => (
                  <button key={key} onClick={() => setRightTab(key)}
                    style={{ padding: '8px 20px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none', borderBottom: rightTab === key ? '2px solid #5865f2' : '2px solid transparent',
                      background: 'transparent', color: rightTab === key ? '#e2e4f0' : '#6b6f85' }}>
                    {label}
                  </button>
                ))}
                {rightTab === 'payoff' && (
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', paddingRight: 16, fontSize: 10, color: '#8b8fa3' }}>
                    <span><span style={{ display: 'inline-block', width: 12, height: 2, background: '#5865f2', marginRight: 4, verticalAlign: 'middle' }}></span> P/L at target</span>
                    <span><span style={{ display: 'inline-block', width: 12, height: 2, background: '#22c55e', marginRight: 4, verticalAlign: 'middle' }}></span> P/L at expiry</span>
                  </div>
                )}
              </div>

              {/* ── Payoff Graph tab ────────────────────────────────────────── */}
              {rightTab === 'payoff' && (
                <>
                  <div style={{ flex: 1, minHeight: 250, padding: '0 8px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={payoffData} margin={{ top: 10, right: 20, bottom: 20, left: 20 }}>
                        <defs>
                          <linearGradient id="payoffGreen" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                            <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2030" />
                        <XAxis dataKey="spot" tick={{ fontSize: 10, fill: '#6b6f85' }} tickFormatter={v => v.toLocaleString('en-IN')} />
                        <YAxis tick={{ fontSize: 10, fill: '#6b6f85' }} tickFormatter={v => `₹${v >= 1000 || v <= -1000 ? (v / 1000).toFixed(1) + 'K' : v}`} />
                        <Tooltip contentStyle={{ background: '#181a25', border: '1px solid #2a2d42', borderRadius: 8, fontSize: 11, color: '#e2e4f0' }}
                          formatter={(v: number) => [`₹${fmtPrice(v)}`, 'P&L']} labelFormatter={v => `Spot: ${Number(v).toLocaleString('en-IN')}`} />
                        <ReferenceLine y={0} stroke="#2a2d42" strokeWidth={1} />
                        {spot && <ReferenceLine x={spot} stroke="#5865f2" strokeDasharray="4 4" opacity={0.7}
                          label={{ value: spot.toLocaleString('en-IN'), fill: '#5865f2', fontSize: 10, position: 'top' }} />}
                        <Area type="monotone" dataKey="pnl" stroke="#22c55e" fill="url(#payoffGreen)" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#22c55e' }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ padding: '8px 16px 16px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#6b6f85', flexShrink: 0 }}>
                    <span>Target Date: <span style={{ color: '#e2e4f0', fontWeight: 600 }}>{targetDays} Day from Expiry</span></span>
                    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <button onClick={() => setTargetDays(Math.max(0, targetDays - 1))}
                        style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 14 }}>−</button>
                      <span style={{ color: '#e2e4f0', fontWeight: 600 }}>{expiry ? formatExpiry(expiry) : '—'}</span>
                      <button onClick={() => setTargetDays(targetDays + 1)}
                        style={{ width: 22, height: 22, borderRadius: 4, border: '1px solid #2a2d42', background: '#1a1c28', color: '#8b8fa3', cursor: 'pointer', fontSize: 14 }}>+</button>
                    </div>
                  </div>
                </>
              )}

              {/* ── Option Chain tab — reuse the real OptionChain component ── */}
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
          <div style={{ background: '#181a25', borderRadius: 12, border: '1px solid #2a2d42', padding: 24, width: 360 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: '#e2e4f0' }}>Save Strategy</span>
              <button onClick={() => setShowSaveModal(false)} style={{ background: 'none', border: 'none', color: '#6b6f85', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#8b8fa3', marginBottom: 8 }}>Name your strategy</div>
            <input type="text" value={saveName} onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveBasket(); }}
              autoFocus placeholder="e.g. NIFTY Iron Condor"
              style={{ width: '100%', padding: '10px 12px', background: '#1a1c28', border: '1px solid #2a2d42', borderRadius: 8, color: '#e2e4f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setShowSaveModal(false)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #2a2d42', background: 'transparent', color: '#8b8fa3', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveBasket} disabled={!saveName.trim()}
                style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: saveName.trim() ? 1 : 0.5 }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Scrip modal */}
      {showAddScrip && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 120, zIndex: 100 }}
          onClick={() => setShowAddScrip(false)}>
          <div style={{ background: '#181a25', borderRadius: 12, border: '1px solid #2a2d42', padding: 20, width: 400, boxShadow: '0 12px 48px rgba(0,0,0,0.6)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 15, color: '#e2e4f0' }}>Add Scrip</span>
              <button onClick={() => setShowAddScrip(false)} style={{ background: 'none', border: 'none', color: '#6b6f85', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>
            <input type="text" value={addScripQuery} onChange={e => searchScrip(e.target.value)}
              autoFocus placeholder="Search stocks, futures, options..."
              style={{ width: '100%', padding: '10px 12px', background: '#1a1c28', border: '1px solid #2a2d42', borderRadius: 8, color: '#e2e4f0', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const, marginBottom: 8 }} />
            <div style={{ maxHeight: 320, overflow: 'auto' }}>
              {addScripResults.length === 0 && addScripQuery.length >= 2 && (
                <div style={{ padding: 16, textAlign: 'center' as const, color: '#6b6f85', fontSize: 12 }}>Searching…</div>
              )}
              {addScripResults.map((inst, i) => (
                <button key={i} onClick={() => addScripToBasket(inst)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left' as const, padding: '8px 10px', background: 'none', border: 'none',
                    borderBottom: '1px solid #1e2030', color: '#e2e4f0', cursor: 'pointer', fontSize: 12 }}
                  onMouseOver={e => (e.currentTarget.style.background = '#1e2030')}
                  onMouseOut={e => (e.currentTarget.style.background = 'none')}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 12 }}>{String(inst.stock_name || inst.symbol || inst.zanskar_name || '')}</div>
                    <div style={{ fontSize: 10, color: '#6b6f85', marginTop: 2 }}>
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

      {/* Toast */}
      {placed && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, padding: '10px 20px', borderRadius: 8, fontSize: 12, fontWeight: 600, zIndex: 110, boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          background: placed.ok ? '#1a3a2a' : '#3a1a1a', color: placed.ok ? '#22c55e' : '#ef4444', border: `1px solid ${placed.ok ? '#22c55e40' : '#ef444440'}` }}>
          {placed.msg}
        </div>
      )}
    </div>
  );
}
