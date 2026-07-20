import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWs } from './hooks/useWsContext';
import type { Instrument, OptionChainData, OptionLeg, ViewType, WsMessage } from './types';
import { getSymbol } from './types';
import { useWatchlist } from './hooks/useWatchlistContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import { useBasket } from './hooks/useBasketContext';
import { fmtPrice, fmtLakh, formatExpiry, strikeRs } from './lib/utils';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function extractUnderlying(input: string): string {
  if (input.includes('_')) {
    const parts = input.split('_');
    if (['STOCK', 'INDEX', 'FUT', 'OPT'].includes(parts[0].toUpperCase()) && parts.length >= 2) {
      return parts[1].split('.')[0].toUpperCase();
    }
  }
  const m = input.match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : input.toUpperCase();
}

const QUICK_PICKS: { sym: string; exch: string }[] = [
  { sym: 'NIFTY', exch: 'NSE' },
  { sym: 'SENSEX', exch: 'BSE' },
];

function orientCePe(ceIn: OptionLeg[], peIn: OptionLeg[]): { ce: OptionLeg[]; pe: OptionLeg[] } {
  let pos = 0, neg = 0;
  for (const item of ceIn) {
    const d = g(item, 'delta');
    if (d != null && d !== 0) { if (d > 0) pos++; else neg++; }
  }
  if (neg > pos && neg > 3) return { ce: peIn, pe: ceIn };
  return { ce: ceIn, pe: peIn };
}

function g(row: unknown, field: string): number | null {
  if (row == null) return null;
  const row_ = row as Record<string, unknown>;
  const aliases: Record<string, string[]> = {
    ltp:    ['ltp', 'last_traded_price'],
    ltpchg: ['ltpchg', 'last_traded_price_change'],
    oi:     ['oi', 'open_interest'],
    volume: ['volume'],
    iv:     ['iv'],
    delta:  ['delta'], gamma: ['gamma'], theta: ['theta'], vega: ['vega'],
  };
  for (const k of (aliases[field] || [field])) {
    const v = row_[k];
    if (v !== undefined && v !== null) return Number(v);
  }
  return null;
}

interface Props {
  instrument:         Instrument | null;
  onNavigateToChart?: (inst: Instrument) => void;
  onChangeView?:      (view: ViewType) => void;
}

export default function OptionChain({ instrument, onNavigateToChart, onChangeView }: Props) {
  const [symbol,      setSymbol]      = useState('');
  const [exchange,    setExchange]    = useState('NSE');
  const [expiry,      setExpiry]      = useState('');
  const [expiries,    setExpiries]    = useState<string[]>([]);
  const [spot,        setSpot]        = useState<number | null>(null);
  const [chain,       setChain]       = useState<OptionChainData | null>(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Instrument[]>([]);
  const [showSug,     setShowSug]     = useState(false);
  const [symInput,    setSymInput]    = useState('');
  const [activeQuick, setActiveQuick] = useState<string | null>(null);
  const [showGoToAtm, setShowGoToAtm] = useState(false);
  const [atmDir,      setAtmDir]      = useState<'up' | 'down'>('up');
  const [showGreeks,  setShowGreeks]  = useState(true);

  const cellMapRef        = useRef(new Map<string, HTMLElement>());
  const maxCeOiRef        = useRef(1);
  const maxPeOiRef        = useRef(1);
  const currentSymRef     = useRef('');
  const currentExchRef    = useRef('NSE');
  const currentExpRef     = useRef('');
  const pollRef           = useRef<number | null>(null);
  const sugTimerRef       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symInputRef       = useRef<HTMLInputElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const atmRowRef         = useRef<HTMLTableRowElement | null>(null);
  const scrollDoneRef     = useRef(false); // true only after a successful scroll-to-ATM

  const { subscribe, subscribeOC, unsubscribeOC } = useWs();
  const { addItem: watchlistAdd } = useWatchlist();
  const { openTicket } = usePaperTrading();
  const { basketMode, setBasketMode, legs, addLegFromChain, removeLeg, updateLegQty, clearBasket, legCount } = useBasket();

  const netPrem = useMemo(() => {
    return legs.reduce((acc, leg) => {
      const qty = leg.qty || leg.lotSize || 65;
      return acc + (leg.side === 'SELL' ? 1 : -1) * (leg.ltp || 0) * qty;
    }, 0);
  }, [legs]);

  const tradeBasketDirectly = useCallback(async () => {
    if (!legs.length) return;
    try {
      for (const leg of legs) {
        await fetch('/paper/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nubraName: leg.nubraName,
            liveRefId: leg.refId,
            display_name: `${leg.asset} ${formatExpiry(leg.expiry)} ${leg.strike} ${leg.optionType}`,
            order_type: 'ORDER_TYPE_MARKET',
            order_qty: leg.qty || leg.lotSize || 65,
            order_side: leg.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
            order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
            validity_type: 'DAY',
          }),
        });
      }
      clearBasket();
      setBasketMode(false);
      onChangeView?.('tracker');
    } catch (e) {
      console.warn('[OptionChain] Trade basket failed:', e);
    }
  }, [legs, clearBasket, setBasketMode, onChangeView]);

  const openOrderTicket = useCallback((
    sp: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL', leg: OptionLeg | null,
  ) => {
    if (!leg) return;
    const la = leg as unknown as Record<string, unknown>;
    openTicket({
      instrument: {
        zanskar_name:    String(la.zanskar_name || la.nubra_name || la.symbol || ''),
        stock_name:      currentSymRef.current,
        asset:           currentSymRef.current,
        exchange:        currentExchRef.current,
        derivative_type: 'OPT',
        option_type:     optType,
        strike_price:    sp * 100,
        expiry:          currentExpRef.current,
        ref_id:          (la.ref_id as number | undefined) ?? undefined,
        lot_size:        (la.ls as number | undefined) ?? (la.lot_size as number | undefined),
      },
      side,
      ltp:    g(leg, 'ltp') ?? undefined,
      ltpChg: g(leg, 'ltpchg') ?? undefined,
    });
  }, [openTicket]);

  const addToWatchlistFn = useCallback((sp: number, optType: 'CE' | 'PE', leg: OptionLeg | null) => {
    if (!leg) return;
    const la  = leg as unknown as Record<string, unknown>;
    const ltp = g(leg, 'ltp');
    watchlistAdd({
      displayName: `${currentSymRef.current} ${sp} ${optType}`,
      underlying:  currentSymRef.current,
      exchange:    currentExchRef.current,
      ref_id:      (la.ref_id as number | undefined) ?? undefined,
      nubraName:   String(la.zanskar_name || la.nubra_name || la.symbol || ''),
      optionType:  optType,
      strike:      sp,
      expiry:      currentExpRef.current,
      ltpAtAdd:    ltp != null ? ltp / 100 : 0,
    });
  }, [watchlistAdd]);

  const addToBasketLeg = useCallback((
    sp: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL', leg: OptionLeg | null,
  ) => {
    if (!leg) return;
    const la = leg as unknown as Record<string, unknown>;
    addLegFromChain({
      strike:     sp,
      optionType: optType,
      side,
      ltp:        (g(leg, 'ltp') ?? 0) / 100,
      refId:      (la.ref_id as number | undefined) ?? null,
      nubraName:  String(la.zanskar_name || la.nubra_name || la.symbol || ''),
      lotSize:    Number(la.ls || la.lot_size || 1),
      asset:      currentSymRef.current,
      expiry:     currentExpRef.current,
      iv:         g(leg, 'iv'),
      delta:      g(leg, 'delta'),
      gamma:      g(leg, 'gamma'),
      theta:      g(leg, 'theta'),
      vega:       g(leg, 'vega'),
    });
  }, [addLegFromChain]);

  const addToBasketFn = useCallback(() => {
    onChangeView?.('basket');
  }, [onChangeView]);

  // ── scroll-to-ATM ──────────────────────────────────────────────────────────
  function scrollToAtm(): boolean {
    const container = tableContainerRef.current;
    if (!container) return false;
    const atmRow = atmRowRef.current ?? (container.querySelector('tr.atm-row') as HTMLElement | null);
    if (!atmRow) return false;

    const cRect = container.getBoundingClientRect();
    const rRect = atmRow.getBoundingClientRect();
    const newScrollTop = container.scrollTop + (rRect.top - cRect.top)
      - container.clientHeight / 2 + atmRow.offsetHeight / 2;
    container.scrollTop = Math.max(0, newScrollTop);
    return true;
  }

  // Reset scroll-done whenever a fresh load starts (chain cleared to null)
  useEffect(() => {
    if (!chain) { scrollDoneRef.current = false; atmRowRef.current = null; }
  }, [chain]);

  // Scroll to ATM once the table is visible and ATM is known.
  useEffect(() => {
    if (!chain || loading || scrollDoneRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (scrollToAtm()) scrollDoneRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, loading, spot]);

  // Track ATM visibility to show/hide "Go to ATM" button
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !chain) { setShowGoToAtm(false); return; }

    function checkAtm() {
      const atmRow = atmRowRef.current ?? (container!.querySelector('tr.atm-row') as HTMLElement | null);
      if (!atmRow) { setShowGoToAtm(false); return; }
      const cRect = container!.getBoundingClientRect();
      const rRect = atmRow.getBoundingClientRect();
      const visible = rRect.bottom > cRect.top + 32 && rRect.top < cRect.bottom - 32;
      setShowGoToAtm(!visible);
      if (!visible) setAtmDir(rRect.top < cRect.top ? 'up' : 'down');
    }

    container.addEventListener('scroll', checkAtm, { passive: true });
    requestAnimationFrame(checkAtm);
    return () => container.removeEventListener('scroll', checkAtm);
  }, [chain]);

  // Load from instrument prop — if a derivative (FUT/OPT) is passed, use its underlying asset
  useEffect(() => {
    if (!instrument) return;
    const derivType    = (instrument.derivative_type || instrument.asset_type || '').toUpperCase();
    const isDerivative = derivType === 'FUT' || derivType === 'OPT';
    let sym: string;
    if (isDerivative) {
      sym = instrument.asset
        ? instrument.asset.toUpperCase()
        : extractUnderlying(getSymbol(instrument));
    } else {
      sym = getSymbol(instrument).toUpperCase();
    }
    // Safety: always strip expiry/strike suffixes so we pass just the index/stock name
    sym = extractUnderlying(sym) || sym;
    const exch = instrument.exchange || 'NSE';
    setSymInput(sym);
    setSymbol(sym);
    setExchange(exch);
    loadExpiryThenChain(sym, exch);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  const wsActiveRef = useRef(false);
  const wsActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WS subscription for live updates
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const asset = (data.asset || '').toUpperCase();
      const exp   = data.expiry || '';
      if (asset !== currentSymRef.current || exp !== currentExpRef.current) return;
      wsActiveRef.current = true;
      if (wsActiveTimerRef.current) clearTimeout(wsActiveTimerRef.current);
      wsActiveTimerRef.current = setTimeout(() => { wsActiveRef.current = false; }, 10000);
      updateCells(data);
    });
    return unsub;
  }, [subscribe]);

  function startPoll(sym: string, exch: string, exp: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      if (!sym || !exp || wsActiveRef.current) return;
      try {
        const data = await fetchChainApi(sym, exch, exp);
        if (data.chain) updateCells(data.chain);
      } catch (e) { console.warn('[OC] Poll failed:', e); }
    }, 5000);
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  const startLiveFeed = useCallback((sym: string, exp: string, exch: string) => {
    stopPoll();
    if (sym && exp) subscribeOC(sym, exp, exch);
    startPoll(sym, exch, exp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeOC]);

  function stopLiveFeed() {
    stopPoll();
    if (currentSymRef.current && currentExpRef.current) {
      unsubscribeOC(currentSymRef.current, currentExpRef.current, currentExchRef.current);
    }
  }

  async function loadExpiryThenChain(sym: string, exch: string) {
    stopLiveFeed();
    cellMapRef.current.clear();
    setLoading(true);
    setError(null);
    setChain(null);
    try {
      const data    = await fetchChainApi(sym, exch, '');
      const rawExps = data.chain?.all_expiries || [];
      const today   = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const sorted  = [...rawExps].sort();
      const future  = sorted.filter((e) => e >= today);
      const exps    = future.length ? future : sorted;
      setExpiries(exps);
      const firstExp = exps[0] || '';
      setExpiry(firstExp);
      currentSymRef.current  = sym;
      currentExchRef.current = exch;
      currentExpRef.current  = firstExp;

      const data2 = await fetchChainApi(sym, exch, firstExp);
      setChain(data2.chain || null);
      const cp2 = data2.chain?.cp ?? data2.chain?.currentprice;
      if (cp2) setSpot(Number(cp2) / 100);
      startLiveFeed(sym, firstExp, exch);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadChain(exp: string) {
    stopLiveFeed();
    cellMapRef.current.clear();
    setLoading(true);
    setError(null);
    setChain(null);
    currentExpRef.current = exp;
    try {
      const data = await fetchChainApi(currentSymRef.current, currentExchRef.current, exp);
      setChain(data.chain || null);
      const cp = data.chain?.cp ?? data.chain?.currentprice;
      if (cp) setSpot(Number(cp) / 100);
      startLiveFeed(currentSymRef.current, exp, currentExchRef.current);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // ── DOM cell updates (no full re-render) ───────────────────────────────────
  function updateCells(data: OptionChainData) {
    const oriented = orientCePe(data.ce || [], data.pe || []);
    const ceList = oriented.ce;
    const peList = oriented.pe;

    const cp = data.cp ?? data.currentprice;
    if (cp) setSpot(Number(cp) / 100);

    // Recompute max OI on every tick so bar widths scale correctly after data changes.
    // Without this, live updates would call setCellHtml with plain fmtOI() text, stripping the bar.
    let maxCeOi = 1, maxPeOi = 1;
    for (const ce of ceList) { const v = g(ce, 'oi') || 0; if (v > maxCeOi) maxCeOi = v; }
    for (const pe of peList) { const v = g(pe, 'oi') || 0; if (v > maxPeOi) maxPeOi = v; }
    maxCeOiRef.current = maxCeOi;
    maxPeOiRef.current = maxPeOi;

    const peMap = new Map<number, OptionLeg>();
    for (const pe of peList) peMap.set(strikeRs(pe), pe);

    for (const ce of ceList) {
      const sp    = strikeRs(ce);
      const pe    = peMap.get(sp) ?? null;
      const iv    = g(ce, 'iv') ?? g(pe, 'iv');
      const ceOi  = g(ce, 'oi') || 0;
      const cePct = Math.min(100, (ceOi / maxCeOiRef.current) * 100);
      setCellHtml(`${sp}-ce-ltp`,   ltpHtml(ce, 'ce'));
      setCellHtml(`${sp}-ce-iv`,    fmtIV(iv));
      setCellHtml(`${sp}-ce-oi`,    `<div>${fmtOI(ceOi)}</div><div class="oi-bar-wrap"><div class="oi-bar oi-bar-ce" style="width:${cePct}%"></div></div>`);
      setCellHtml(`${sp}-ce-vol`,   fmtOI(g(ce, 'volume')));
      setCellHtml(`${sp}-ce-delta`, fmtDec(g(ce, 'delta'), 4));
      setCellHtml(`${sp}-ce-gamma`, fmtDec(g(ce, 'gamma'), 4));
      setCellHtml(`${sp}-ce-theta`, fmtDec(g(ce, 'theta'), 2));
      setCellHtml(`${sp}-ce-vega`,  fmtDec(g(ce, 'vega'), 4));
    }
    for (const pe of peList) {
      const sp    = strikeRs(pe);
      const peOi  = g(pe, 'oi') || 0;
      const pePct = Math.min(100, (peOi / maxPeOiRef.current) * 100);
      setCellHtml(`${sp}-pe-ltp`,   ltpHtml(pe, 'pe'));
      setCellHtml(`${sp}-pe-oi`,    `<div>${fmtOI(peOi)}</div><div class="oi-bar-wrap"><div class="oi-bar oi-bar-pe" style="width:${pePct}%"></div></div>`);
      setCellHtml(`${sp}-pe-vol`,   fmtOI(g(pe, 'volume')));
      setCellHtml(`${sp}-pe-delta`, fmtDec(g(pe, 'delta'), 4));
      setCellHtml(`${sp}-pe-gamma`, fmtDec(g(pe, 'gamma'), 4));
      setCellHtml(`${sp}-pe-theta`, fmtDec(g(pe, 'theta'), 2));
      setCellHtml(`${sp}-pe-vega`,  fmtDec(g(pe, 'vega'), 4));
    }
  }

  function setCellHtml(key: string, html: string) {
    const td = cellMapRef.current.get(key);
    if (td && td.innerHTML !== html) td.innerHTML = html;
  }

  function ltpHtml(row: OptionLeg, _side: string): string {
    const ltp = g(row, 'ltp');
    if (ltp == null) return '—';
    const price = ltp / 100;
    const chg   = g(row, 'ltpchg');
    const up    = chg == null ? true : chg >= 0;
    const pct   = chg != null
      ? `<div style="font-size:10px;color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : ''}${chg.toFixed(2)}%</div>`
      : '';
    return `₹${fmtPrice(price)}${pct}`;
  }

  function fmtDec(v: number | null, dp: number): string {
    return v == null ? '—' : v.toFixed(dp);
  }

  // API returns IV as decimal (0.1905); display as percentage (19.05)
  function fmtIV(v: number | null): string {
    return v == null ? '—' : (v * 100).toFixed(2);
  }

  // Show '0' for zero (distinguishes 0 from null/missing)
  function fmtOI(v: number | null): string {
    if (v == null) return '—';
    if (v === 0) return '0';
    return fmtLakh(v);
  }

  // ── Search suggestions ─────────────────────────────────────────────────────
  function onSymInput(e: React.ChangeEvent<HTMLInputElement>) {
    setSymInput(e.target.value);
    if (sugTimerRef.current) clearTimeout(sugTimerRef.current);
    const q = e.target.value.trim();
    if (q.length < 1) { setSuggestions([]); setShowSug(false); return; }
    sugTimerRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=10`);
        const data = await res.json() as { results: Instrument[] };
        const items = (data.results || []).filter((it) => {
          const dt = (it.derivative_type || '').toUpperCase();
          return dt !== 'OPT' && dt !== 'FUT';  // only allow underlying assets (INDEX/STOCK/ETF)
        });
        setSuggestions(items.slice(0, 8));
        setShowSug(true);
      } catch (e) { console.warn('[OC] Search failed:', e); }
    }, 200);
  }

  function selectSuggestion(item: Instrument) {
    const sym = getSymbol(item).toUpperCase();
    setSymInput(sym);
    setSymbol(sym);
    setExchange(item.exchange || 'NSE');
    setActiveQuick(null);
    setSuggestions([]);
    setShowSug(false);
    loadExpiryThenChain(sym, item.exchange || 'NSE');
  }

  async function navigateToChart(strike: number, optType: 'CE' | 'PE') {
    if (!onNavigateToChart) return;
    try {
      const q   = `${symbol}${strike}${optType}`;
      const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=50`);
      const data = await res.json() as { results: Instrument[] };
      const match = (data.results || []).find((it) => {
        if ((it.derivative_type || '').toUpperCase() !== 'OPT') return false;
        if ((it.option_type || '').toUpperCase() !== optType) return false;
        const itemExpiry = String(it.expiry ?? '');
        if (currentExpRef.current && itemExpiry && itemExpiry !== currentExpRef.current) return false;
        const sp = Number(it.strike_price);
        return sp === strike || sp === strike * 100 || Math.round(sp / 100) === strike;
      });
      if (match) { onNavigateToChart(match); return; }
    } catch (e) { console.warn('[OC] navigateToChart lookup failed:', e); }
    const exp  = currentExpRef.current;
    const yr   = exp.slice(2, 4);
    const mo   = exp.length >= 6 ? MONTHS[parseInt(exp.slice(4, 6)) - 1] : '';
    const name = `${symbol}${yr}${mo}${strike}${optType}`;
    onNavigateToChart({ stock_name: name, nubra_name: name, exchange: currentExchRef.current, derivative_type: 'OPT', asset: currentSymRef.current });
  }

  // ── Render rows ────────────────────────────────────────────────────────────
  // Memoised on [chain, spot]: spot drives ATM detection; chain changes only on load.
  // All other state changes (search input, scroll buttons, etc.) no longer rebuild the table.
  const tableRows = useMemo(() => {
    if (!chain) return null;
    const oriented = orientCePe(chain.ce || [], chain.pe || []);
    const ceList = oriented.ce;
    const peList = oriented.pe;
    const map: Record<number, { ce: OptionLeg | null; pe: OptionLeg | null }> = {};
    for (const ce of ceList) {
      const sp = strikeRs(ce);
      if (!map[sp]) map[sp] = { ce: null, pe: null };
      map[sp].ce = ce;
    }
    for (const pe of peList) {
      const sp = strikeRs(pe);
      if (!map[sp]) map[sp] = { ce: null, pe: null };
      map[sp].pe = pe;
    }
    const strikes = Object.keys(map).map(Number).sort((a, b) => a - b);
    maxCeOiRef.current = Math.max(1, ...ceList.map((c) => g(c, 'oi') || 0));
    maxPeOiRef.current = Math.max(1, ...peList.map((p) => g(p, 'oi') || 0));

    const chainCp  = chain.cp ?? chain.currentprice;
    // Treat 0 as missing (API sometimes returns 0 before market open)
    const refPrice = (spot && spot > 0)
      ? spot
      : (chainCp && chainCp > 0 ? chainCp / 100 : null)
        ?? (chain.atm && chain.atm > 0 ? chain.atm / 100 : null);
    const atm = refPrice != null
      ? strikes.reduce((b, s) => Math.abs(s - refPrice) < Math.abs(b - refPrice) ? s : b, strikes[0])
      : null;

    const registerCell = (sp: number, key: string) => (el: HTMLElement | null) => {
      if (el) cellMapRef.current.set(`${sp}-${key}`, el);
    };

    const rows: React.ReactNode[] = [];
    for (const sp of strikes) {
      const { ce, pe } = map[sp];
      const isAtm  = sp === atm;
      const ceOi   = g(ce, 'oi') || 0;
      const peOi   = g(pe, 'oi') || 0;
      const iv     = g(ce, 'iv') ?? g(pe, 'iv');

      const spotLine = isAtm && spot ? (
        <tr key={`${sp}-spot-line`} className="pointer-events-none select-none">
          <td colSpan={showGreeks ? 16 : 8} className="p-0" style={{ height: '18px' }}>
            <div className="flex items-center h-full px-1">
              <div className="flex-1 h-px bg-[var(--accent)] opacity-50" />
              <span className="mx-2 px-2 py-[2px] rounded text-[9px] font-bold bg-[var(--accent)] text-white leading-none whitespace-nowrap">
                Spot: {fmtPrice(spot)}
              </span>
              <div className="flex-1 h-px bg-[var(--accent)] opacity-50" />
            </div>
          </td>
        </tr>
      ) : null;

      if (spotLine && spot != null && spot <= sp) rows.push(spotLine);

      rows.push(
        <tr
          key={sp}
          className={`group ${isAtm ? 'atm-row' : ''}`}
          data-strike={sp}
          ref={isAtm ? (el) => { atmRowRef.current = el; } : undefined}
        >
          {/* CE: Vega Gamma Theta Delta OI Vol LTP */}
          {showGreeks && (<>
          <td ref={registerCell(sp,'ce-vega')}  className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'vega'), 4) : '—'}</td>
          <td ref={registerCell(sp,'ce-gamma')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'gamma'), 4) : '—'}</td>
          <td ref={registerCell(sp,'ce-theta')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'theta'), 2) : '—'}</td>
          <td ref={registerCell(sp,'ce-delta')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'delta'), 4) : '—'}</td>
          </>)}
          <td ref={registerCell(sp,'ce-oi')} className="ce-side text-right px-2 py-1.5 text-[12px]">
            {ce
              ? <><div>{fmtOI(g(ce, 'oi'))}</div><div className="oi-bar-wrap"><div className="oi-bar oi-bar-ce" style={{ width: `${Math.min(100, (ceOi / maxCeOiRef.current) * 100)}%` }} /></div></>
              : '—'}
          </td>
          <td ref={registerCell(sp,'ce-vol')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtOI(g(ce, 'volume')) : '—'}</td>

          {/* CE LTP — live price + B/S buttons revealed on row hover */}
          <td className="ce-side ltp-cell px-2 py-1.5 text-[12px] font-semibold">
            <div className="flex items-center justify-end gap-0.5">
              {ce && (
                <div className="invisible group-hover:visible flex items-center gap-0.5 shrink-0">
                  <button className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--green)] bg-[var(--green)]/15 hover:bg-[var(--green)]/40 border border-[var(--green)]/30 leading-none"
                    onClick={(e) => { e.stopPropagation(); basketMode ? addToBasketLeg(sp, 'CE', 'BUY', ce) : openOrderTicket(sp, 'CE', 'BUY', ce); }}>B</button>
                  <button className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--red)] bg-[var(--red)]/15 hover:bg-[var(--red)]/40 border border-[var(--red)]/30 leading-none"
                    onClick={(e) => { e.stopPropagation(); basketMode ? addToBasketLeg(sp, 'CE', 'SELL', ce) : openOrderTicket(sp, 'CE', 'SELL', ce); }}>S</button>
                </div>
              )}
              <div
                ref={(el) => { if (el) cellMapRef.current.set(`${sp}-ce-ltp`, el); }}
                className="cursor-pointer text-right"
                onClick={() => navigateToChart(sp, 'CE')}
                dangerouslySetInnerHTML={{ __html: ce ? ltpHtml(ce, 'ce') : '—' }}
              />
            </div>
          </td>

          {/* Strike (center) — watchlist/basket buttons revealed on row hover */}
          <td className="strike-cell text-center px-1 py-1.5 text-[13px] font-bold">
            <div className="relative inline-block w-full">
              <span className="group-hover:invisible transition-opacity select-none">{sp.toLocaleString('en-IN')}</span>
              <div className="invisible group-hover:visible absolute inset-0 flex items-center justify-center gap-0.5">
                <button className="px-1 py-0.5 rounded text-[9px] font-bold text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30 leading-none"
                  onClick={(e) => { e.stopPropagation(); addToWatchlistFn(sp, 'CE', ce); }}>★CE</button>
                <button className={`px-1 py-0.5 rounded text-[9px] font-bold leading-none ${
                    basketMode
                      ? 'text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30'
                      : 'text-[var(--accent)] bg-[var(--accent)]/15 hover:bg-[var(--accent)]/40 border border-[var(--accent)]/30'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (basketMode) {
                      if (ce) addToBasketLeg(sp, 'CE', 'BUY', ce);
                      if (pe) addToBasketLeg(sp, 'PE', 'BUY', pe);
                    } else {
                      addToBasketFn();
                    }
                  }}>+</button>
                <button className="px-1 py-0.5 rounded text-[9px] font-bold text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30 leading-none"
                  onClick={(e) => { e.stopPropagation(); addToWatchlistFn(sp, 'PE', pe); }}>★PE</button>
              </div>
            </div>
          </td>

          <td ref={registerCell(sp,'ce-iv')} className="iv-cell text-center px-2 py-1.5 text-[11px] font-medium">
            {fmtIV(iv)}
          </td>

          {/* PE LTP — live price + B/S buttons revealed on row hover */}
          <td className="pe-side ltp-cell px-2 py-1.5 text-[12px] font-semibold">
            <div className="flex items-center justify-start gap-0.5">
              <div
                ref={(el) => { if (el) cellMapRef.current.set(`${sp}-pe-ltp`, el); }}
                className="cursor-pointer flex-1 text-right"
                onClick={() => navigateToChart(sp, 'PE')}
                dangerouslySetInnerHTML={{ __html: pe ? ltpHtml(pe, 'pe') : '—' }}
              />
              {pe && (
                <div className="invisible group-hover:visible flex items-center gap-0.5 shrink-0">
                  <button className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--green)] bg-[var(--green)]/15 hover:bg-[var(--green)]/40 border border-[var(--green)]/30 leading-none"
                    onClick={(e) => { e.stopPropagation(); basketMode ? addToBasketLeg(sp, 'PE', 'BUY', pe) : openOrderTicket(sp, 'PE', 'BUY', pe); }}>B</button>
                  <button className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--red)] bg-[var(--red)]/15 hover:bg-[var(--red)]/40 border border-[var(--red)]/30 leading-none"
                    onClick={(e) => { e.stopPropagation(); basketMode ? addToBasketLeg(sp, 'PE', 'SELL', pe) : openOrderTicket(sp, 'PE', 'SELL', pe); }}>S</button>
                </div>
              )}
            </div>
          </td>

          {/* PE: Vol OI Delta Theta Gamma Vega */}
          <td ref={registerCell(sp,'pe-vol')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtOI(g(pe, 'volume')) : '—'}</td>
          <td ref={registerCell(sp,'pe-oi')} className="pe-side text-right px-2 py-1.5 text-[12px]">
            {pe
              ? <><div>{fmtOI(g(pe, 'oi'))}</div><div className="oi-bar-wrap"><div className="oi-bar oi-bar-pe" style={{ width: `${Math.min(100, (peOi / maxPeOiRef.current) * 100)}%` }} /></div></>
              : '—'}
          </td>
          {showGreeks && (<>
          <td ref={registerCell(sp,'pe-delta')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'delta'), 4) : '—'}</td>
          <td ref={registerCell(sp,'pe-theta')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'theta'), 2) : '—'}</td>
          <td ref={registerCell(sp,'pe-gamma')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'gamma'), 4) : '—'}</td>
          <td ref={registerCell(sp,'pe-vega')}  className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'vega'), 4) : '—'}</td>
          </>)}
        </tr>
      );

      if (spotLine && spot != null && spot > sp) rows.push(spotLine);
    }
    return rows;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, spot, showGreeks]);

  // ── JSX ────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 overflow-x-auto shrink-0">
        <div className="flex gap-1 shrink-0">
          {QUICK_PICKS.map(({ sym, exch }) => (
            <button
              key={sym}
              onClick={() => {
                setActiveQuick(sym);
                setSymInput(sym);
                setSymbol(sym);
                setExchange(exch);
                loadExpiryThenChain(sym, exch);
              }}
              className={`px-2.5 py-1 rounded text-[12px] font-semibold border transition-all ${
                activeQuick === sym
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                  : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {sym}
            </button>
          ))}
        </div>
        <div className="w-px h-5 bg-[var(--border)] shrink-0 mx-1" />

        {/* Symbol input */}
        <div className="relative shrink-0">
          <input
            ref={symInputRef}
            type="text"
            value={symInput}
            onChange={onSymInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { const u = extractUnderlying(symInput); setSymInput(u); setSymbol(u); setActiveQuick(null); loadExpiryThenChain(u, exchange); }
              if (e.key === 'Escape') setShowSug(false);
            }}
            placeholder="Symbol"
            className="w-[110px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none focus:border-[var(--accent)]"
          />
          {showSug && suggestions.length > 0 && (() => {
            const rect = symInputRef.current?.getBoundingClientRect();
            return (
              <div style={{
                position: 'fixed',
                top: rect ? rect.bottom + 4 : 0,
                left: rect ? rect.left : 0,
                width: 240,
                maxHeight: 280,
                overflowY: 'auto',
                zIndex: 9999,
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}>
                {suggestions.map((it, i) => (
                  <div
                    key={i}
                    onMouseDown={(e) => { e.preventDefault(); selectSuggestion(it); }}
                    className="flex justify-between items-center px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] text-[13px] border-b border-[var(--border)]/50 last:border-0"
                  >
                    <span className="font-semibold text-[var(--text-primary)]">{getSymbol(it).toUpperCase()}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400">{it.exchange}</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>

        <select
          value={exchange}
          onChange={(e) => setExchange(e.target.value)}
          className="px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none"
        >
          <option value="NSE">NSE</option>
          <option value="BSE">BSE</option>
        </select>

        <select
          value={expiry}
          onChange={(e) => { setExpiry(e.target.value); loadChain(e.target.value); }}
          className="w-[130px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none"
        >
          {expiries.map((exp) => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
        </select>

        <button
          onClick={() => { const u = extractUnderlying(symInput) || symbol; setSymInput(u); setSymbol(u); setActiveQuick(null); loadExpiryThenChain(u, exchange); }}
          className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[12px] font-semibold hover:bg-[var(--accent-dim)] transition-colors shrink-0"
        >
          Load
        </button>

        <div className="w-px h-5 bg-[var(--border)] shrink-0 mx-1" />

        {/* Greeks column toggle */}
        <button
          onClick={() => setShowGreeks(v => !v)}
          className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-all shrink-0 ${
            showGreeks
              ? 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              : 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
          }`}
          title="Show or hide the option Greeks columns (Delta, Gamma, Theta, Vega)"
        >
          {showGreeks ? 'Hide Greeks' : 'Show Greeks'}
        </button>

        {/* Basket mode toggle */}
        <button
          onClick={() => setBasketMode(!basketMode)}
          className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-all shrink-0 flex items-center gap-1 ${
            basketMode
              ? 'bg-amber-500/20 border-amber-500/40 text-amber-400'
              : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
          }`}
          title="Basket mode: B/S buttons add to basket instead of placing orders"
        >
          <span className="text-[13px]">🧺</span>
          Basket
          {basketMode && legCount > 0 && (
            <span className="ml-0.5 px-1.5 py-0 rounded-full bg-amber-500/30 text-amber-300 text-[9px] font-bold">
              {legCount}
            </span>
          )}
        </button>

        {spot && (
          <div className="ml-auto text-[13px] font-semibold text-[var(--text-primary)] shrink-0">
            Spot: <span className="text-[var(--accent)]">₹{fmtPrice(spot)}</span>
          </div>
        )}
      </div>

      {/* Main Container: Table + Optional Custom Basket Side Drawer */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Table container */}
        <div className="flex-1 relative overflow-hidden">
          <div ref={tableContainerRef} className="h-full overflow-auto bg-[var(--bg-primary)]">
            {loading && (
              <div className="flex flex-col items-center justify-center h-40 gap-3 text-[var(--text-secondary)]">
                <div className="w-6 h-6 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
                <span className="text-[12px]">Loading option chain…</span>
              </div>
            )}
            {error   && <div className="flex items-center justify-center h-40 text-[var(--red)] text-[14px]">{error}</div>}
            {!loading && !error && (
              <table className="oc-table w-full text-[12px] border-collapse" style={{ tableLayout: 'fixed' }}>
                <thead>
                  <tr className="sticky top-0 z-10">
                    <th colSpan={showGreeks ? 7 : 3} className="oc-calls-th text-center py-1.5 text-[13px] font-bold">Calls</th>
                    <th colSpan={2} className="bg-[var(--bg-card)] border-b-2 border-[var(--border)]" />
                    <th colSpan={showGreeks ? 7 : 3} className="oc-puts-th text-center py-1.5 text-[13px] font-bold">Puts</th>
                  </tr>
                  <tr className="sticky top-8 z-10 bg-[var(--bg-secondary)]">
                    {showGreeks && ['Vega','Gamma','Theta','Delta'].map((h) => (
                      <th key={`ce-${h}`} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                    ))}
                    {['OI (L)','Vol (L)','LTP'].map((h) => (
                      <th key={`ce-${h}`} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                    ))}
                    <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">Strike</th>
                    <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">IV %</th>
                    {['LTP','Vol (L)','OI (L)'].map((h) => (
                      <th key={`pe-${h}`} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                    ))}
                    {showGreeks && ['Delta','Theta','Gamma','Vega'].map((h) => (
                      <th key={`pe-${h}`} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>{tableRows}</tbody>
              </table>
            )}
            {!loading && !error && !chain && (
              <div className="flex items-center justify-center h-40 text-[var(--text-muted)] text-[14px]">
                Select a symbol and click Load
              </div>
            )}
          </div>

          {/* Go to ATM floating button */}
          {showGoToAtm && chain && (
            <button
              onClick={scrollToAtm}
              className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--accent)] text-white text-[12px] font-semibold shadow-lg hover:bg-[var(--accent-dim)] transition-all"
              style={{ [atmDir === 'up' ? 'top' : 'bottom']: '10px' }}
            >
              {atmDir === 'up' ? '↑' : '↓'} Go to ATM
            </button>
          )}
        </div>

        {/* Custom Basket Side Drawer (matching Nubra design) */}
        {basketMode && (
          <div className="w-[310px] shrink-0 border-l border-[var(--border)] bg-[var(--bg-secondary)] flex flex-col h-full overflow-hidden shadow-2xl z-20">
            {/* Header */}
            <div className="p-3 border-b border-[var(--border)] flex items-center justify-between bg-[var(--bg-card)]">
              <div className="flex items-center gap-2">
                <span className="text-base">🧺</span>
                <span className="font-bold text-xs text-[var(--text-primary)]">Custom Basket</span>
                {legs.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] text-[10px] font-semibold">
                    {legs.length} {legs.length === 1 ? 'leg' : 'legs'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {legs.length > 0 && (
                  <button
                    onClick={clearBasket}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--red)] transition-colors"
                  >
                    Clear
                  </button>
                )}
                <button
                  onClick={() => setBasketMode(false)}
                  className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors text-xs"
                  title="Close basket"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Legs List */}
            <div className="flex-1 overflow-auto p-2.5 space-y-2">
              {legs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center p-4 border border-dashed border-[var(--border)] rounded-lg">
                  <div className="text-2xl mb-2 opacity-50">🧺</div>
                  <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">Your basket is empty</div>
                  <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                    Click <span className="font-bold text-emerald-400">B</span> or <span className="font-bold text-red-400">S</span> on any strike row to add strategy legs.
                  </div>
                </div>
              ) : (
                legs.map((leg, idx) => {
                  const isBuy = leg.side === 'BUY';
                  const lotSize = leg.lotSize || 65;
                  const currentQty = leg.qty || lotSize;
                  return (
                    <div
                      key={leg.id || idx}
                      className="p-2 rounded border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-all text-xs"
                    >
                      {/* Top Row: Side badge, Expiry, Strike & Type, Remove */}
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-4 h-4 rounded flex items-center justify-center font-bold text-[9px] ${
                            isBuy ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'
                          }`}>
                            {isBuy ? 'B' : 'S'}
                          </span>
                          <span className="text-[10px] text-[var(--text-muted)]">{formatExpiry(leg.expiry)}</span>
                          <span className="font-bold text-[var(--text-primary)]">{fmtPrice(leg.strike)} {leg.optionType}</span>
                        </div>
                        <button
                          onClick={() => removeLeg(idx)}
                          className="w-4 h-4 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--red)] hover:bg-[var(--red)]/10 transition-colors text-xs"
                          title="Remove leg"
                        >
                          ✕
                        </button>
                      </div>

                      {/* Bottom Row: Qty adjustment & Price */}
                      <div className="flex items-center justify-between text-[11px] pt-1 border-t border-[var(--border)]/40">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => updateLegQty(idx, Math.max(lotSize, currentQty - lotSize))}
                            className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                          >
                            −
                          </button>
                          <span className="font-semibold text-[var(--text-primary)] min-w-[28px] text-center">{currentQty}</span>
                          <button
                            onClick={() => updateLegQty(idx, currentQty + lotSize)}
                            className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                          >
                            +
                          </button>
                        </div>
                        <div className="font-semibold text-[var(--text-primary)]">
                          ₹{fmtPrice(leg.ltp)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Footer Actions */}
            {legs.length > 0 && (
              <div className="p-2.5 border-t border-[var(--border)] bg-[var(--bg-card)] space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold">
                  <span className="text-[var(--text-muted)]">Net Premium:</span>
                  <span className={netPrem >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                    {netPrem >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(netPrem))}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    onClick={() => onChangeView?.('basket')}
                    className="w-full py-1.5 rounded border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 font-semibold text-xs transition-all flex items-center justify-center gap-1"
                  >
                    📊 Analyze
                  </button>
                  <button
                    onClick={tradeBasketDirectly}
                    className="w-full py-1.5 rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] font-semibold text-xs shadow transition-all flex items-center justify-center gap-1"
                  >
                    ⚡ Trade
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

async function fetchChainApi(symbol: string, exchange: string, expiry: string): Promise<{ chain?: OptionChainData }> {
  const params = new URLSearchParams({ exchange });
  if (expiry) params.set('expiry', expiry);
  const res  = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${params}`);
  const data = await res.json() as { chain?: OptionChainData; error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}
