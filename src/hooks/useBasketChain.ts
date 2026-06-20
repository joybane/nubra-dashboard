import { useEffect, useMemo, useRef, useState } from 'react';
import { useWs } from './useWsContext';

function numField(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    if (obj[k] != null && !isNaN(Number(obj[k]))) return Number(obj[k]);
  }
  return null;
}

export interface ChainRow {
  strike: number;
  ceLtp: number;
  peLtp: number;
  ceRefId: number | null;
  peRefId: number | null;
  ceNubraName: string;
  peNubraName: string;
  lotSize: number;
  ceIv: number | null;
  peIv: number | null;
  ceDelta: number | null;
  peDelta: number | null;
  ceGamma: number | null;
  peGamma: number | null;
  ceTheta: number | null;
  peTheta: number | null;
  ceVega: number | null;
  peVega: number | null;
  ceOi: number | null;
  peOi: number | null;
  ceVol: number | null;
  peVol: number | null;
}

interface Deps {
  sym: string | null;
  exch: string;
  legExpiries: string[];
}

function emptyRow(strike: number, lotSize: number): ChainRow {
  return { strike, ceLtp: 0, peLtp: 0, ceRefId: null, peRefId: null, ceNubraName: '', peNubraName: '', lotSize, ceIv: null, peIv: null, ceDelta: null, peDelta: null, ceGamma: null, peGamma: null, ceTheta: null, peTheta: null, ceVega: null, peVega: null, ceOi: null, peOi: null, ceVol: null, peVol: null };
}

function buildChainRows(ceListIn: Array<Record<string, unknown>>, peListIn: Array<Record<string, unknown>>): ChainRow[] {
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
    const sp = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
    const ltp = ce.ltp != null ? Number(ce.ltp) / 100 : 0;
    const refId = ce.ref_id != null ? Number(ce.ref_id) : null;
    const nubraName = String(ce.zanskar_name || ce.nubra_name || ce.symbol || '');
    const lotSize = Number(ce.ls || ce.lot_size || 1);
    if (!map[sp]) map[sp] = emptyRow(sp, lotSize);
    map[sp].ceLtp = ltp; map[sp].ceRefId = refId; map[sp].ceNubraName = nubraName; map[sp].lotSize = lotSize;
    map[sp].ceIv = numField(ce, 'iv', 'implied_volatility'); map[sp].ceDelta = numField(ce, 'delta');
    map[sp].ceGamma = numField(ce, 'gamma'); map[sp].ceTheta = numField(ce, 'theta'); map[sp].ceVega = numField(ce, 'vega');
    map[sp].ceOi = numField(ce, 'oi', 'open_interest'); map[sp].ceVol = numField(ce, 'volume', 'vol');
  }
  for (const pe of peList) {
    const sp = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
    const ltp = pe.ltp != null ? Number(pe.ltp) / 100 : 0;
    const refId = pe.ref_id != null ? Number(pe.ref_id) : null;
    const nubraName = String(pe.zanskar_name || pe.nubra_name || pe.symbol || '');
    const lotSize = Number(pe.ls || pe.lot_size || 1);
    if (!map[sp]) map[sp] = emptyRow(sp, lotSize);
    map[sp].peLtp = ltp; map[sp].peRefId = refId; map[sp].peNubraName = nubraName;
    if (!map[sp].lotSize || map[sp].lotSize <= 1) map[sp].lotSize = lotSize;
    map[sp].peIv = numField(pe, 'iv', 'implied_volatility'); map[sp].peDelta = numField(pe, 'delta');
    map[sp].peGamma = numField(pe, 'gamma'); map[sp].peTheta = numField(pe, 'theta'); map[sp].peVega = numField(pe, 'vega');
    map[sp].peOi = numField(pe, 'oi', 'open_interest'); map[sp].peVol = numField(pe, 'volume', 'vol');
  }
  return Object.values(map).sort((a, b) => a.strike - b.strike);
}

export interface BasketChainApi {
  expiries: string[];
  expiry: string;
  chainRows: ChainRow[];
  spot: number | null;
  loading: boolean;
  error: string | null;
  changeExpiry: (exp: string) => Promise<void>;
  setChainRows: React.Dispatch<React.SetStateAction<ChainRow[]>>;
  resetChain: () => void;
  loadChainForSymbol: (newSym: string, newExch: string) => Promise<void>;
}

export function useBasketChain({ sym, exch, legExpiries }: Deps): BasketChainApi {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [chainRows, setChainRows] = useState<ChainRow[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { subscribe, subscribeOC, unsubscribeOC } = useWs();

  async function loadChain() {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number } };
      const chain = data.chain;
      if (!chain) return;
      const exps = chain.all_expiries || [];
      setExpiries(exps);
      setExpiry(prev => (!prev || !exps.includes(prev)) ? (exps[0] || '') : prev);
      if (chain.cp) setSpot(chain.cp > 10000 ? chain.cp / 100 : chain.cp);
      setChainRows(buildChainRows(chain.ce || [], chain.pe || []));
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }

  async function changeExpiry(exp: string) {
    if (!sym) return;
    setExpiry(exp);
    setLoading(true);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}&expiry=${exp}`);
      const data = await res.json() as { chain?: { ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number } };
      if (data.chain) {
        if (data.chain.cp) setSpot(data.chain.cp > 10000 ? data.chain.cp / 100 : data.chain.cp);
        setChainRows(buildChainRows(data.chain.ce || [], data.chain.pe || []));
      }
    } catch (e) { console.warn('[BasketChain] loadChain failed:', e); }
    setLoading(false);
  }

  async function loadChainForSymbol(newSym: string, newExch: string) {
    setChainRows([]);
    setExpiries([]);
    setExpiry('');
    setSpot(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(newSym)}?exchange=${newExch}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>>; cp?: number } };
      if (data.chain) {
        const exps = data.chain.all_expiries || [];
        setExpiries(exps);
        setExpiry(exps[0] || '');
        if (data.chain.cp) setSpot(data.chain.cp > 10000 ? data.chain.cp / 100 : data.chain.cp);
        setChainRows(buildChainRows(data.chain.ce || [], data.chain.pe || []));
      }
    } catch (e) { console.warn('[BasketChain] loadChainForSymbol failed:', e); }
    setLoading(false);
  }

  function resetChain() {
    setChainRows([]);
    setExpiries([]);
    setExpiry('');
    setSpot(null);
  }

  // Auto-load on sym change
  useEffect(() => {
    if (sym) loadChain();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym]);

  // WS subscription — stabilize legExpiries dependency to avoid churn on every LTP tick
  const legExpKey = JSON.stringify(legExpiries);
  useEffect(() => {
    if (!sym) return;
    const allExpiries = new Set<string>();
    if (expiry) allExpiries.add(expiry);
    for (const e of legExpiries) allExpiries.add(e);
    for (const exp of allExpiries) subscribeOC(sym, exp, exch);
    return () => { for (const exp of allExpiries) unsubscribeOC(sym, exp, exch); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym, expiry, exch, legExpKey, subscribeOC, unsubscribeOC]);

  // WS live updates
  useEffect(() => {
    if (!sym) return;
    const unsub = subscribe('option_chain', (msg) => {
      const d = (msg as any).data as Record<string, unknown> | undefined;
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

      return { msgExpiry, ltpMap };
    });
    return unsub;
  }, [subscribe, sym, expiry]);

  return { expiries, expiry, chainRows, spot, loading, error, changeExpiry, setChainRows, resetChain, loadChainForSymbol };
}
