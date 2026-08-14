import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWs } from './hooks/useWsContext';
import type { Instrument, OptionChainData, OptionLeg, ViewType, WsMessage } from './types';
import { getChainAsset, getSymbol } from './types';
import { useWatchlist } from './hooks/useWatchlistContext';
import { usePaperTrading } from './hooks/usePaperTrading';
import { useBasket } from './hooks/useBasketContext';
import { legMtm, legQty, netGreeks, netPremium } from './lib/basketMath';
import { fmtPrice, fmtLakh, formatExpiry, strikeRs } from './lib/utils';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function normalizeIndiaVix(input: string): string | null {
  const key = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return key === 'INDIAVIX' ? 'INDIA_VIX' : null;
}

function isOptionChainUnavailableError(input: unknown): boolean {
  const msg = String(input instanceof Error ? input.message : input || '').toLowerCase();
  return (
    msg.includes('not fno') ||
    msg.includes('not f&o') ||
    msg.includes('option chain') ||
    msg.includes('no chain')
  );
}

function inferChartType(symbol: string, fallback?: Instrument): Instrument['derivative_type'] {
  const existing = (fallback?.derivative_type || fallback?.asset_type || '').toUpperCase();
  if (existing === 'INDEX' || existing === 'STOCK' || existing === 'ETF') return existing;
  const key = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (
    key.includes('VIX') ||
    ['NIFTY', 'NIFTY50', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(key)
  )
    return 'INDEX';
  return 'STOCK';
}

function extractUnderlying(input: string): string {
  const special = normalizeIndiaVix(input);
  if (special) return special;
  if (input.includes('_')) {
    const parts = input.split('_');
    if (['STOCK', 'INDEX', 'FUT', 'OPT'].includes(parts[0].toUpperCase()) && parts.length >= 2) {
      return parts[1].split('.')[0].toUpperCase();
    }
    return input.toUpperCase();
  }
  const m = input.match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : input.toUpperCase();
}

const QUICK_PICKS: { sym: string; exch: string }[] = [
  { sym: 'NIFTY', exch: 'NSE' },
  { sym: 'SENSEX', exch: 'BSE' },
];

function orientCePe(ceIn: OptionLeg[], peIn: OptionLeg[]): { ce: OptionLeg[]; pe: OptionLeg[] } {
  let pos = 0,
    neg = 0;
  for (const item of ceIn) {
    const d = g(item, 'delta');
    if (d != null && d !== 0) {
      if (d > 0) pos++;
      else neg++;
    }
  }
  if (neg > pos && neg > 3) return { ce: peIn, pe: ceIn };
  return { ce: ceIn, pe: peIn };
}

function g(row: unknown, field: string): number | null {
  if (row == null) return null;
  const row_ = row as Record<string, unknown>;
  const aliases: Record<string, string[]> = {
    ltp: ['ltp', 'last_traded_price'],
    ltpchg: ['ltpchg', 'last_traded_price_change'],
    oi: ['oi', 'open_interest'],
    volume: ['volume'],
    iv: ['iv'],
    delta: ['delta'],
    gamma: ['gamma'],
    theta: ['theta'],
    vega: ['vega'],
  };
  for (const k of aliases[field] || [field]) {
    const v = row_[k];
    if (v !== undefined && v !== null) return Number(v);
  }
  return null;
}

function optionLegRefId(leg: OptionLeg | null): number | undefined {
  if (!leg) return undefined;
  const raw = leg as unknown as Record<string, unknown>;
  const refId = Number(raw.ref_id ?? raw.refId);
  return refId > 0 ? refId : undefined;
}

interface Props {
  instrument: Instrument | null;
  onNavigateToChart?: (inst: Instrument) => void;
  onChangeView?: (view: ViewType) => void;
  /** Rendered inside the Basket builder, which owns basket mode and shows the legs itself. */
  embedded?: boolean;
}

export default function OptionChain({
  instrument,
  onNavigateToChart,
  onChangeView,
  embedded,
}: Props) {
  const [symbol, setSymbol] = useState('');
  const [exchange, setExchange] = useState('NSE');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [spot, setSpot] = useState<number | null>(null);
  const [chain, setChain] = useState<OptionChainData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Instrument[]>([]);
  const [showSug, setShowSug] = useState(false);
  const [symInput, setSymInput] = useState('');
  const [activeQuick, setActiveQuick] = useState<string | null>(null);
  const [showGoToAtm, setShowGoToAtm] = useState(false);
  const [atmDir, setAtmDir] = useState<'up' | 'down'>('up');
  const [showGreeks, setShowGreeks] = useState(true);

  const cellMapRef = useRef(new Map<string, HTMLElement>());
  const maxCeOiRef = useRef(1);
  const maxPeOiRef = useRef(1);
  const currentSymRef = useRef('');
  const currentExchRef = useRef('NSE');
  const currentExpRef = useRef('');
  const pollRef = useRef<number | null>(null);
  const sugTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symInputRef = useRef<HTMLInputElement>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const scrollDoneRef = useRef(false); // true only after a successful scroll-to-ATM

  const { subscribe, subscribeOC, unsubscribeOC } = useWs();
  const { addItem: watchlistAdd } = useWatchlist();
  const { openTicket } = usePaperTrading();
  const {
    basketMode,
    setBasketMode,
    legs,
    addLeg,
    removeLeg,
    updateLeg,
    clearBasket,
    legCount,
    multiplier,
    applyMultiplier,
    margin,
    marginLoading,
    marginError,
    persistence,
    placeBasket,
    registerViewer,
  } = useBasket();

  const drawerOpen = basketMode && !embedded;
  useEffect(() => {
    if (!drawerOpen) return;
    return registerViewer();
  }, [drawerOpen, registerViewer]);

  const [placed, setPlaced] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [trading, setTrading] = useState(false);

  const totalPremium = useMemo(() => netPremium(legs), [legs]);
  const greeks = useMemo(() => netGreeks(legs), [legs]);

  const tradeBasket = useCallback(async () => {
    if (!legs.length || trading) return;
    setTrading(true);
    setPlaced(null);
    const result = await placeBasket();
    setPlaced(result);
    setTrading(false);
    if (result.ok) setTimeout(() => setPlaced(null), 5000);
  }, [legs.length, trading, placeBasket]);

  // Arriving on this tab with a basket already built (from the Basket tab, or
  // from an earlier visit here) should show it — mount only, so closing sticks.
  useEffect(() => {
    if (!embedded && legCount > 0) setBasketMode(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveStrategy = useCallback(() => {
    if (!saveName.trim() || !legs.length) return;
    persistence.saveBasket(saveName, legs[0].asset, legs[0].expiry, legs).then((r) => {
      setPlaced(r);
      setShowSaveModal(false);
      setSaveName('');
      setTimeout(() => setPlaced(null), 3000);
    });
  }, [saveName, legs, persistence]);

  const openOrderTicket = useCallback(
    (sp: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL', leg: OptionLeg | null) => {
      if (!leg) return;
      const la = leg as unknown as Record<string, unknown>;
      openTicket({
        instrument: {
          zanskar_name: String(la.zanskar_name || la.nubra_name || la.symbol || ''),
          stock_name: currentSymRef.current,
          asset: currentSymRef.current,
          exchange: currentExchRef.current,
          derivative_type: 'OPT',
          option_type: optType,
          strike_price: sp * 100,
          expiry: currentExpRef.current,
          ref_id: (la.ref_id as number | undefined) ?? undefined,
          lot_size: (la.ls as number | undefined) ?? (la.lot_size as number | undefined),
        },
        side,
        ltp: g(leg, 'ltp') ?? undefined,
        ltpChg: g(leg, 'ltpchg') ?? undefined,
      });
    },
    [openTicket],
  );

  const addToWatchlistFn = useCallback(
    (sp: number, optType: 'CE' | 'PE', leg: OptionLeg | null) => {
      if (!leg) return;
      const la = leg as unknown as Record<string, unknown>;
      const ltp = g(leg, 'ltp');
      watchlistAdd({
        displayName: `${currentSymRef.current} ${sp} ${optType}`,
        underlying: currentSymRef.current,
        exchange: currentExchRef.current,
        ref_id: (la.ref_id as number | undefined) ?? undefined,
        nubraName: String(la.zanskar_name || la.nubra_name || la.symbol || ''),
        optionType: optType,
        strike: sp,
        expiry: currentExpRef.current,
        ltpAtAdd: ltp != null ? ltp / 100 : 0,
      });
    },
    [watchlistAdd],
  );

  const addToBasketLeg = useCallback(
    (sp: number, optType: 'CE' | 'PE', side: 'BUY' | 'SELL', leg: OptionLeg | null) => {
      if (!leg) return;
      const la = leg as unknown as Record<string, unknown>;
      addLeg({
        strike: sp,
        optionType: optType,
        side,
        ltp: (g(leg, 'ltp') ?? 0) / 100,
        refId: (la.ref_id as number | undefined) ?? null,
        nubraName: String(la.zanskar_name || la.nubra_name || la.symbol || ''),
        lotSize: Number(la.ls || la.lot_size || 1),
        asset: currentSymRef.current,
        symbol: currentSymRef.current,
        exchange: currentExchRef.current,
        expiry: currentExpRef.current,
        iv: g(leg, 'iv'),
        delta: g(leg, 'delta'),
        gamma: g(leg, 'gamma'),
        theta: g(leg, 'theta'),
        vega: g(leg, 'vega'),
      });
    },
    [addLeg],
  );

  const addToBasketFn = useCallback(() => {
    onChangeView?.('basket');
  }, [onChangeView]);

  // ── scroll-to-ATM ──────────────────────────────────────────────────────────
  function scrollToAtm(): boolean {
    const container = tableContainerRef.current;
    if (!container) return false;
    const atmRow =
      atmRowRef.current ?? (container.querySelector('tr.atm-row') as HTMLElement | null);
    if (!atmRow) return false;

    const cRect = container.getBoundingClientRect();
    const rRect = atmRow.getBoundingClientRect();
    const newScrollTop =
      container.scrollTop +
      (rRect.top - cRect.top) -
      container.clientHeight / 2 +
      atmRow.offsetHeight / 2;
    container.scrollTop = Math.max(0, newScrollTop);
    return true;
  }

  // Reset scroll-done whenever a fresh load starts (chain cleared to null)
  useEffect(() => {
    if (!chain) {
      scrollDoneRef.current = false;
      atmRowRef.current = null;
    }
  }, [chain]);

  // Scroll to ATM once the table is visible and ATM is known.
  useEffect(() => {
    if (!chain || loading || scrollDoneRef.current) return;
    const raf = requestAnimationFrame(() => {
      if (scrollToAtm()) scrollDoneRef.current = true;
    });
    return () => cancelAnimationFrame(raf);
  }, [chain, loading, spot]);

  // Track ATM visibility to show/hide "Go to ATM" button
  useEffect(() => {
    const container = tableContainerRef.current;
    if (!container || !chain) {
      setShowGoToAtm(false);
      return;
    }

    function checkAtm() {
      const atmRow =
        atmRowRef.current ?? (container!.querySelector('tr.atm-row') as HTMLElement | null);
      if (!atmRow) {
        setShowGoToAtm(false);
        return;
      }
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
    const derivType = (instrument.derivative_type || instrument.asset_type || '').toUpperCase();
    const isDerivative = derivType === 'FUT' || derivType === 'OPT';
    let sym: string;
    if (isDerivative) {
      sym = instrument.asset
        ? instrument.asset.toUpperCase()
        : extractUnderlying(getSymbol(instrument));
    } else {
      sym = getSymbol(instrument).toUpperCase();
    }
    const exch = instrument.exchange || 'NSE';
    // Safety: strip expiry/strike suffixes so we pass just the index/stock name.
    // Skipped when refdata already gave us the asset outright, which it always does
    // on MCX — the suffix strip is name-shaped guesswork and would cut a trailing
    // digit off assets like SILVER100.
    if (!(exch.toUpperCase() === 'MCX' && instrument.asset)) sym = extractUnderlying(sym) || sym;
    setSymInput(sym);
    setSymbol(sym);
    setExchange(exch);
    loadExpiryThenChain(sym, exch, instrument);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  const wsActiveRef = useRef(false);
  const wsActiveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Feed health. `lastTickRef` is stamped by whichever source last delivered data
  // for the chain on screen; `feed` mirrors it into render once a second so a dead
  // feed is visible instead of silently showing load-time prices.
  const lastTickRef = useRef(0);
  const feedSrcRef = useRef<'ws' | 'poll'>('poll');
  const [feed, setFeed] = useState<{ src: 'ws' | 'poll'; ageMs: number } | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setFeed(
        lastTickRef.current
          ? { src: feedSrcRef.current, ageMs: Date.now() - lastTickRef.current }
          : null,
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // WS subscription for live updates
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const asset = (data.asset || '').toUpperCase();
      const exp = data.expiry || '';
      if (asset !== currentSymRef.current || exp !== currentExpRef.current) return;
      wsActiveRef.current = true;
      lastTickRef.current = Date.now();
      feedSrcRef.current = 'ws';
      if (wsActiveTimerRef.current) clearTimeout(wsActiveTimerRef.current);
      wsActiveTimerRef.current = setTimeout(() => {
        wsActiveRef.current = false;
      }, 10000);
      updateCells(data);
    });
    return unsub;
  }, [subscribe]);

  // Tear down the live feed on unmount: stops the REST poll, sends the OC
  // unsubscribe, and clears the WS-activity timeout. Without this, closing the
  // Option Chain pane leaks a network poll + a server-side subscription forever.
  useEffect(
    () => () => {
      stopLiveFeed();
      if (wsActiveTimerRef.current) clearTimeout(wsActiveTimerRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function startPoll(sym: string, exch: string, exp: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      if (!sym || !exp || wsActiveRef.current) return;
      try {
        const data = await fetchChainApi(sym, exch, exp);
        if (data.chain) {
          lastTickRef.current = Date.now();
          feedSrcRef.current = 'poll';
          updateCells(data.chain);
        }
      } catch (e) {
        console.warn('[OC] Poll failed:', e);
      }
    }, 5000);
  }

  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  const startLiveFeed = useCallback(
    (sym: string, exp: string, exch: string) => {
      stopPoll();
      if (sym && exp) subscribeOC(sym, exp, exch);
      startPoll(sym, exch, exp);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribeOC],
  );

  function stopLiveFeed() {
    stopPoll();
    if (currentSymRef.current && currentExpRef.current) {
      unsubscribeOC(currentSymRef.current, currentExpRef.current, currentExchRef.current);
    }
  }

  async function loadExpiryThenChain(sym: string, exch: string, fallbackInstrument?: Instrument) {
    stopLiveFeed();
    cellMapRef.current.clear();
    setLoading(true);
    setError(null);
    setChain(null);
    try {
      const data = await fetchChainApi(sym, exch, '');
      const rawExps = data.chain?.all_expiries || [];
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const sorted = [...rawExps].sort();
      const future = sorted.filter((e) => e >= today);
      const exps = future.length ? future : sorted;
      setExpiries(exps);
      const firstExp = exps[0] || '';
      setExpiry(firstExp);
      currentSymRef.current = sym;
      currentExchRef.current = exch;
      currentExpRef.current = firstExp;

      const data2 = await fetchChainApi(sym, exch, firstExp);
      setChain(data2.chain || null);
      const cp2 = data2.chain?.cp ?? data2.chain?.currentprice;
      if (cp2) setSpot(Number(cp2) / 100);
      lastTickRef.current = Date.now();
      feedSrcRef.current = 'poll';
      startLiveFeed(sym, firstExp, exch);
    } catch (err: unknown) {
      if (isOptionChainUnavailableError(err) && onNavigateToChart) {
        onNavigateToChart({
          ...(fallbackInstrument || {}),
          stock_name: fallbackInstrument?.stock_name || fallbackInstrument?.display_name || sym,
          nubra_name: fallbackInstrument?.nubra_name || fallbackInstrument?.zanskar_name || sym,
          exchange: fallbackInstrument?.exchange || exch,
          derivative_type: inferChartType(sym, fallbackInstrument),
          asset_type: inferChartType(sym, fallbackInstrument),
        });
        return;
      }
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
      lastTickRef.current = Date.now();
      feedSrcRef.current = 'poll';
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
    let maxCeOi = 1,
      maxPeOi = 1;
    for (const ce of ceList) {
      const v = g(ce, 'oi') || 0;
      if (v > maxCeOi) maxCeOi = v;
    }
    for (const pe of peList) {
      const v = g(pe, 'oi') || 0;
      if (v > maxPeOi) maxPeOi = v;
    }
    maxCeOiRef.current = maxCeOi;
    maxPeOiRef.current = maxPeOi;

    const peMap = new Map<number, OptionLeg>();
    for (const pe of peList) peMap.set(strikeRs(pe), pe);

    for (const ce of ceList) {
      const sp = strikeRs(ce);
      const pe = peMap.get(sp) ?? null;
      const iv = g(ce, 'iv') ?? g(pe, 'iv');
      const ceOi = g(ce, 'oi') || 0;
      const cePct = Math.min(100, (ceOi / maxCeOiRef.current) * 100);
      setLtpCells(sp, 'ce', ce);
      setCellText(`${sp}-ce-iv`, fmtIV(iv));
      setCellHtml(
        `${sp}-ce-oi`,
        `<div>${fmtOI(ceOi)}</div><div class="oi-bar-wrap"><div class="oi-bar oi-bar-ce" style="width:${cePct}%"></div></div>`,
      );
      setCellText(`${sp}-ce-vol`, fmtOI(g(ce, 'volume')));
      setCellText(`${sp}-ce-delta`, fmtDec(g(ce, 'delta'), 4));
      setCellText(`${sp}-ce-gamma`, fmtDec(g(ce, 'gamma'), 4));
      setCellText(`${sp}-ce-theta`, fmtDec(g(ce, 'theta'), 2));
      setCellText(`${sp}-ce-vega`, fmtDec(g(ce, 'vega'), 4));
    }
    for (const pe of peList) {
      const sp = strikeRs(pe);
      const peOi = g(pe, 'oi') || 0;
      const pePct = Math.min(100, (peOi / maxPeOiRef.current) * 100);
      setLtpCells(sp, 'pe', pe);
      setCellHtml(
        `${sp}-pe-oi`,
        `<div>${fmtOI(peOi)}</div><div class="oi-bar-wrap"><div class="oi-bar oi-bar-pe" style="width:${pePct}%"></div></div>`,
      );
      setCellText(`${sp}-pe-vol`, fmtOI(g(pe, 'volume')));
      setCellText(`${sp}-pe-delta`, fmtDec(g(pe, 'delta'), 4));
      setCellText(`${sp}-pe-gamma`, fmtDec(g(pe, 'gamma'), 4));
      setCellText(`${sp}-pe-theta`, fmtDec(g(pe, 'theta'), 2));
      setCellText(`${sp}-pe-vega`, fmtDec(g(pe, 'vega'), 4));
    }
  }

  // Plain-text cells. Used for every column except the two OI cells, which build
  // a bar and therefore need markup.
  function setCellText(key: string, text: string) {
    const el = cellMapRef.current.get(key);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setCellHtml(key: string, html: string) {
    const td = cellMapRef.current.get(key);
    if (td && td.innerHTML !== html) td.innerHTML = html;
  }

  // Price and change % live in two separately registered text nodes so they update
  // through the same mechanism as the other columns. They used to be one node
  // written with dangerouslySetInnerHTML and then patched imperatively, which made
  // this the only column whose live updates could silently stop landing.
  function setLtpCells(sp: number, side: 'ce' | 'pe', row: OptionLeg) {
    setCellText(`${sp}-${side}-ltp`, fmtLtp(g(row, 'ltp')));
    const chgEl = cellMapRef.current.get(`${sp}-${side}-ltpchg`);
    if (!chgEl) return;
    const chg = g(row, 'ltpchg');
    const text = fmtChg(chg);
    if (chgEl.textContent !== text) chgEl.textContent = text;
    chgEl.style.color = chgColor(chg);
  }

  function fmtDec(v: number | null, dp: number): string {
    return v == null ? '—' : v.toFixed(dp);
  }

  // LTP arrives in paise on both the REST chain and the WS feed.
  function fmtLtp(ltp: number | null): string {
    return ltp == null ? '—' : `₹${fmtPrice(ltp / 100)}`;
  }

  function fmtChg(chg: number | null): string {
    return chg == null ? '' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
  }

  function chgColor(chg: number | null): string {
    return chg == null || chg >= 0 ? 'var(--green)' : 'var(--red)';
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
    if (q.length < 1) {
      setSuggestions([]);
      setShowSug(false);
      return;
    }
    sugTimerRef.current = setTimeout(async () => {
      try {
        // MCX has to be asked for separately — the search endpoint takes one exchange
        // and defaults to NSE.
        const [nse, bse, mcx] = await Promise.all(
          [
            `/api/instruments/search?q=${encodeURIComponent(q)}&limit=10`,
            `/api/instruments/search?q=${encodeURIComponent(q)}&exchange=BSE&limit=10`,
            `/api/instruments/search?q=${encodeURIComponent(q)}&exchange=MCX&type=FUT&limit=25`,
          ].map((url) =>
            fetch(url)
              .then((r) => r.json() as Promise<{ results?: Instrument[] }>)
              .then((d) => d.results ?? [])
              .catch(() => [] as Instrument[]),
          ),
        );

        const items = [...nse, ...bse].filter((it) => {
          const dt = (it.derivative_type || '').toUpperCase();
          return dt !== 'OPT' && dt !== 'FUT'; // only allow underlying assets (INDEX/STOCK/ETF)
        });

        // On MCX the underlying IS a future, so the filter above cannot apply. Collapse
        // the six-odd contracts per commodity down to one row keyed by asset.
        const seenAssets = new Set<string>();
        for (const it of mcx) {
          const asset = (it.asset || '').toUpperCase();
          if (!asset || seenAssets.has(asset)) continue;
          seenAssets.add(asset);
          items.push({ ...it, stock_name: asset, nubra_name: asset });
        }

        setSuggestions(items.slice(0, 8));
        setShowSug(true);
      } catch (e) {
        console.warn('[OC] Search failed:', e);
      }
    }, 75);
  }

  function selectSuggestion(item: Instrument) {
    // MCX rows are futures contracts standing in for their commodity; the chain is
    // keyed by the commodity.
    const sym = getChainAsset(item).toUpperCase();
    setSymInput(sym);
    setSymbol(sym);
    setExchange(item.exchange || 'NSE');
    setActiveQuick(null);
    setSuggestions([]);
    setShowSug(false);
    loadExpiryThenChain(sym, item.exchange || 'NSE', item);
  }

  async function navigateToChart(strike: number, optType: 'CE' | 'PE', leg: OptionLeg | null) {
    if (!onNavigateToChart) return;

    const fromLeg = (): Instrument => {
      const raw = (leg || {}) as unknown as Record<string, unknown>;
      const exactSymbol = String(
        raw.symbol || raw.stock_name || raw.zanskar_name || raw.nubra_name || '',
      ).trim();
      const exp = currentExpRef.current;
      const yr = exp.slice(2, 4);
      const mo = exp.length >= 6 ? MONTHS[parseInt(exp.slice(4, 6)) - 1] : '';
      const fallbackName = `${currentSymRef.current}${yr}${mo}${strike}${optType}`;
      return {
        stock_name: exactSymbol || fallbackName,
        zanskar_name: String(raw.zanskar_name || raw.nubra_name || '').trim() || undefined,
        exchange: currentExchRef.current,
        derivative_type: 'OPT',
        asset: currentSymRef.current,
        option_type: optType,
        strike_price: strike * 100,
        expiry: currentExpRef.current,
        ref_id: optionLegRefId(leg),
        lot_size: Number(raw.ls || raw.lot_size || 0) || undefined,
      };
    };

    const refId = optionLegRefId(leg);
    if (refId) {
      try {
        const params = new URLSearchParams({
          ref_id: String(refId),
          exchange: currentExchRef.current,
        });
        const res = await fetch(`/api/instruments/lookup?${params}`);
        const data = (await res.json()) as { instrument?: Instrument | null };
        if (data.instrument) {
          onNavigateToChart({
            ...data.instrument,
            ref_id: refId,
            exchange: data.instrument.exchange || currentExchRef.current,
            derivative_type: 'OPT',
            option_type: data.instrument.option_type || optType,
            strike_price: Number(data.instrument.strike_price) || strike * 100,
            expiry: data.instrument.expiry ?? currentExpRef.current,
            asset: data.instrument.asset || currentSymRef.current,
          });
          return;
        }
      } catch (e) {
        console.warn('[OC] navigateToChart ref_id lookup failed:', e);
      }
    }

    const legInstrument = fromLeg();
    if (legInstrument.ref_id || getSymbol(legInstrument)) {
      onNavigateToChart(legInstrument);
      return;
    }

    try {
      const q = `${symbol}${strike}${optType}`;
      const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=50`);
      const data = (await res.json()) as { results: Instrument[] };
      const match = (data.results || []).find((it) => {
        if ((it.derivative_type || '').toUpperCase() !== 'OPT') return false;
        if ((it.option_type || '').toUpperCase() !== optType) return false;
        const itemExpiry = String(it.expiry ?? '');
        if (currentExpRef.current && itemExpiry && itemExpiry !== currentExpRef.current)
          return false;
        const sp = Number(it.strike_price);
        return sp === strike || sp === strike * 100 || Math.round(sp / 100) === strike;
      });
      if (match) {
        onNavigateToChart(match);
        return;
      }
    } catch (e) {
      console.warn('[OC] navigateToChart lookup failed:', e);
    }
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
    const strikes = Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b);
    maxCeOiRef.current = Math.max(1, ...ceList.map((c) => g(c, 'oi') || 0));
    maxPeOiRef.current = Math.max(1, ...peList.map((p) => g(p, 'oi') || 0));

    const chainCp = chain.cp ?? chain.currentprice;
    // Treat 0 as missing (API sometimes returns 0 before market open)
    const refPrice =
      spot && spot > 0
        ? spot
        : ((chainCp && chainCp > 0 ? chainCp / 100 : null) ??
          (chain.atm && chain.atm > 0 ? chain.atm / 100 : null));
    const atm =
      refPrice != null
        ? strikes.reduce(
            (b, s) => (Math.abs(s - refPrice) < Math.abs(b - refPrice) ? s : b),
            strikes[0],
          )
        : null;

    const registerCell = (sp: number, key: string) => (el: HTMLElement | null) => {
      if (el) cellMapRef.current.set(`${sp}-${key}`, el);
    };

    const rows: React.ReactNode[] = [];
    for (const sp of strikes) {
      const { ce, pe } = map[sp];
      const isAtm = sp === atm;
      const ceOi = g(ce, 'oi') || 0;
      const peOi = g(pe, 'oi') || 0;
      const iv = g(ce, 'iv') ?? g(pe, 'iv');

      const spotLine =
        isAtm && spot ? (
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
          ref={
            isAtm
              ? (el) => {
                  atmRowRef.current = el;
                }
              : undefined
          }
        >
          {/* CE: Vega Gamma Theta Delta OI Vol LTP */}
          {showGreeks && (
            <>
              <td
                ref={registerCell(sp, 'ce-vega')}
                className="ce-side text-right px-2 py-1.5 text-[12px]"
              >
                {ce ? fmtDec(g(ce, 'vega'), 4) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'ce-gamma')}
                className="ce-side text-right px-2 py-1.5 text-[12px]"
              >
                {ce ? fmtDec(g(ce, 'gamma'), 4) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'ce-theta')}
                className="ce-side text-right px-2 py-1.5 text-[12px]"
              >
                {ce ? fmtDec(g(ce, 'theta'), 2) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'ce-delta')}
                className="ce-side text-right px-2 py-1.5 text-[12px]"
              >
                {ce ? fmtDec(g(ce, 'delta'), 4) : '—'}
              </td>
            </>
          )}
          <td
            ref={registerCell(sp, 'ce-oi')}
            className="ce-side text-right px-2 py-1.5 text-[12px]"
          >
            {ce ? (
              <>
                <div>{fmtOI(g(ce, 'oi'))}</div>
                <div className="oi-bar-wrap">
                  <div
                    className="oi-bar oi-bar-ce"
                    style={{ width: `${Math.min(100, (ceOi / maxCeOiRef.current) * 100)}%` }}
                  />
                </div>
              </>
            ) : (
              '—'
            )}
          </td>
          <td
            ref={registerCell(sp, 'ce-vol')}
            className="ce-side text-right px-2 py-1.5 text-[12px]"
          >
            {ce ? fmtOI(g(ce, 'volume')) : '—'}
          </td>

          {/* CE LTP — live price + B/S buttons revealed on row hover */}
          <td className="ce-side ltp-cell px-2 py-1.5 text-[12px] font-semibold">
            <div className="flex items-center justify-end gap-0.5">
              {ce && (
                <div className="invisible group-hover:visible flex items-center gap-0.5 shrink-0">
                  <button
                    className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--green)] bg-[var(--green)]/15 hover:bg-[var(--green)]/40 border border-[var(--green)]/30 leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      basketMode
                        ? addToBasketLeg(sp, 'CE', 'BUY', ce)
                        : openOrderTicket(sp, 'CE', 'BUY', ce);
                    }}
                  >
                    B
                  </button>
                  <button
                    className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--red)] bg-[var(--red)]/15 hover:bg-[var(--red)]/40 border border-[var(--red)]/30 leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      basketMode
                        ? addToBasketLeg(sp, 'CE', 'SELL', ce)
                        : openOrderTicket(sp, 'CE', 'SELL', ce);
                    }}
                  >
                    S
                  </button>
                </div>
              )}
              <div
                className="cursor-pointer text-right"
                // Left-click sells, right-click buys — the convention the Nubra BT chain
                // has always used, now matched here. Only in basket mode: outside it a
                // left-click still opens the chart, because silently turning that into a
                // live order would be a nasty surprise.
                title={basketMode ? 'Left-click: SELL  |  Right-click: BUY' : 'Open chart'}
                onClick={() =>
                  basketMode ? addToBasketLeg(sp, 'CE', 'SELL', ce) : navigateToChart(sp, 'CE', ce)
                }
                onContextMenu={(e) => {
                  if (!basketMode) return;
                  e.preventDefault();
                  addToBasketLeg(sp, 'CE', 'BUY', ce);
                }}
              >
                <div ref={registerCell(sp, 'ce-ltp')}>{fmtLtp(g(ce, 'ltp'))}</div>
                <div
                  ref={registerCell(sp, 'ce-ltpchg')}
                  className="text-[10px]"
                  style={{ color: chgColor(g(ce, 'ltpchg')) }}
                >
                  {fmtChg(g(ce, 'ltpchg'))}
                </div>
              </div>
            </div>
          </td>

          {/* Strike (center) — watchlist/basket buttons revealed on row hover */}
          <td className="strike-cell text-center px-1 py-1.5 text-[13px] font-bold">
            <div className="relative inline-block w-full">
              <span className="group-hover:invisible transition-opacity select-none">
                {sp.toLocaleString('en-IN')}
              </span>
              <div className="invisible group-hover:visible absolute inset-0 flex items-center justify-center gap-0.5">
                <button
                  className="px-1 py-0.5 rounded text-[9px] font-bold text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30 leading-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    addToWatchlistFn(sp, 'CE', ce);
                  }}
                >
                  ★CE
                </button>
                <button
                  className={`px-1 py-0.5 rounded text-[9px] font-bold leading-none ${
                    basketMode
                      ? 'text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30'
                      : 'text-[var(--accent)] bg-[var(--accent)]/15 hover:bg-[var(--accent)]/40 border border-[var(--accent)]/30'
                  }`}
                  // Short straddle, to agree with the LTP cells either side of it:
                  // a plain click sells, and right-click buys.
                  title={
                    basketMode
                      ? 'Left-click: SELL straddle  |  Right-click: BUY straddle'
                      : 'Open the basket builder'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (basketMode) {
                      if (ce) addToBasketLeg(sp, 'CE', 'SELL', ce);
                      if (pe) addToBasketLeg(sp, 'PE', 'SELL', pe);
                    } else {
                      addToBasketFn();
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!basketMode) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (ce) addToBasketLeg(sp, 'CE', 'BUY', ce);
                    if (pe) addToBasketLeg(sp, 'PE', 'BUY', pe);
                  }}
                >
                  +
                </button>
                <button
                  className="px-1 py-0.5 rounded text-[9px] font-bold text-amber-400 bg-amber-500/15 hover:bg-amber-500/40 border border-amber-500/30 leading-none"
                  onClick={(e) => {
                    e.stopPropagation();
                    addToWatchlistFn(sp, 'PE', pe);
                  }}
                >
                  ★PE
                </button>
              </div>
            </div>
          </td>

          <td
            ref={registerCell(sp, 'ce-iv')}
            className="iv-cell text-center px-2 py-1.5 text-[11px] font-medium"
          >
            {fmtIV(iv)}
          </td>

          {/* PE LTP — live price + B/S buttons revealed on row hover */}
          <td className="pe-side ltp-cell px-2 py-1.5 text-[12px] font-semibold">
            <div className="flex items-center justify-start gap-0.5">
              <div
                className="cursor-pointer flex-1 text-right"
                title={basketMode ? 'Left-click: SELL  |  Right-click: BUY' : 'Open chart'}
                onClick={() =>
                  basketMode ? addToBasketLeg(sp, 'PE', 'SELL', pe) : navigateToChart(sp, 'PE', pe)
                }
                onContextMenu={(e) => {
                  if (!basketMode) return;
                  e.preventDefault();
                  addToBasketLeg(sp, 'PE', 'BUY', pe);
                }}
              >
                <div ref={registerCell(sp, 'pe-ltp')}>{fmtLtp(g(pe, 'ltp'))}</div>
                <div
                  ref={registerCell(sp, 'pe-ltpchg')}
                  className="text-[10px]"
                  style={{ color: chgColor(g(pe, 'ltpchg')) }}
                >
                  {fmtChg(g(pe, 'ltpchg'))}
                </div>
              </div>
              {pe && (
                <div className="invisible group-hover:visible flex items-center gap-0.5 shrink-0">
                  <button
                    className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--green)] bg-[var(--green)]/15 hover:bg-[var(--green)]/40 border border-[var(--green)]/30 leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      basketMode
                        ? addToBasketLeg(sp, 'PE', 'BUY', pe)
                        : openOrderTicket(sp, 'PE', 'BUY', pe);
                    }}
                  >
                    B
                  </button>
                  <button
                    className="px-1 py-0.5 rounded text-[9px] font-bold text-[var(--red)] bg-[var(--red)]/15 hover:bg-[var(--red)]/40 border border-[var(--red)]/30 leading-none"
                    onClick={(e) => {
                      e.stopPropagation();
                      basketMode
                        ? addToBasketLeg(sp, 'PE', 'SELL', pe)
                        : openOrderTicket(sp, 'PE', 'SELL', pe);
                    }}
                  >
                    S
                  </button>
                </div>
              )}
            </div>
          </td>

          {/* PE: Vol OI Delta Theta Gamma Vega */}
          <td
            ref={registerCell(sp, 'pe-vol')}
            className="pe-side text-right px-2 py-1.5 text-[12px]"
          >
            {pe ? fmtOI(g(pe, 'volume')) : '—'}
          </td>
          <td
            ref={registerCell(sp, 'pe-oi')}
            className="pe-side text-right px-2 py-1.5 text-[12px]"
          >
            {pe ? (
              <>
                <div>{fmtOI(g(pe, 'oi'))}</div>
                <div className="oi-bar-wrap">
                  <div
                    className="oi-bar oi-bar-pe"
                    style={{ width: `${Math.min(100, (peOi / maxPeOiRef.current) * 100)}%` }}
                  />
                </div>
              </>
            ) : (
              '—'
            )}
          </td>
          {showGreeks && (
            <>
              <td
                ref={registerCell(sp, 'pe-delta')}
                className="pe-side text-right px-2 py-1.5 text-[12px]"
              >
                {pe ? fmtDec(g(pe, 'delta'), 4) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'pe-theta')}
                className="pe-side text-right px-2 py-1.5 text-[12px]"
              >
                {pe ? fmtDec(g(pe, 'theta'), 2) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'pe-gamma')}
                className="pe-side text-right px-2 py-1.5 text-[12px]"
              >
                {pe ? fmtDec(g(pe, 'gamma'), 4) : '—'}
              </td>
              <td
                ref={registerCell(sp, 'pe-vega')}
                className="pe-side text-right px-2 py-1.5 text-[12px]"
              >
                {pe ? fmtDec(g(pe, 'vega'), 4) : '—'}
              </td>
            </>
          )}
        </tr>,
      );

      if (spotLine && spot != null && spot > sp) rows.push(spotLine);
    }
    return rows;
    // basketMode belongs here: the row handlers below close over it, so leaving it
    // out froze B/S on whatever mode was active when the chain last loaded — turning
    // basket mode on after loading a chain left the buttons still placing orders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, spot, showGreeks, basketMode]);

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
              if (e.key === 'Enter') {
                const u = extractUnderlying(symInput);
                setSymInput(u);
                setSymbol(u);
                setActiveQuick(null);
                loadExpiryThenChain(u, exchange);
              }
              if (e.key === 'Escape') setShowSug(false);
            }}
            placeholder="Symbol"
            className="w-[110px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none focus:border-[var(--accent)]"
          />
          {showSug &&
            suggestions.length > 0 &&
            (() => {
              const rect = symInputRef.current?.getBoundingClientRect();
              return (
                <div
                  style={{
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
                  }}
                >
                  {suggestions.map((it, i) => (
                    <div
                      key={i}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectSuggestion(it);
                      }}
                      className="flex justify-between items-center px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] text-[13px] border-b border-[var(--border)]/50 last:border-0"
                    >
                      <span className="font-semibold text-[var(--text-primary)]">
                        {getSymbol(it).toUpperCase()}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400">
                        {it.exchange}
                      </span>
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
          <option value="MCX">MCX</option>
        </select>

        <select
          value={expiry}
          onChange={(e) => {
            setExpiry(e.target.value);
            loadChain(e.target.value);
          }}
          className="w-[130px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none"
        >
          {expiries.map((exp) => (
            <option key={exp} value={exp}>
              {formatExpiry(exp)}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            const u = extractUnderlying(symInput) || symbol;
            setSymInput(u);
            setSymbol(u);
            setActiveQuick(null);
            loadExpiryThenChain(u, exchange);
          }}
          className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[12px] font-semibold hover:bg-[var(--accent-dim)] transition-colors shrink-0"
        >
          Load
        </button>

        <div className="w-px h-5 bg-[var(--border)] shrink-0 mx-1" />

        {/* Greeks column toggle */}
        <button
          onClick={() => setShowGreeks((v) => !v)}
          className={`px-2.5 py-1 rounded text-[11px] font-semibold border transition-all shrink-0 ${
            showGreeks
              ? 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              : 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
          }`}
          title="Show or hide the option Greeks columns (Delta, Gamma, Theta, Vega)"
        >
          {showGreeks ? 'Hide Greeks' : 'Show Greeks'}
        </button>

        {/* Basket mode toggle — the Basket builder owns the mode when embedded */}
        {!embedded && (
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
            {legCount > 0 && (
              <span className="ml-0.5 px-1.5 py-0 rounded-full bg-amber-500/30 text-amber-300 text-[9px] font-bold">
                {legCount}
              </span>
            )}
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <FeedBadge feed={feed} />
          {spot && (
            <div className="text-[13px] font-semibold text-[var(--text-primary)]">
              Spot: <span className="text-[var(--accent)]">₹{fmtPrice(spot)}</span>
            </div>
          )}
        </div>
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
            {error && (
              <div className="flex items-center justify-center h-40 text-[var(--red)] text-[14px]">
                {error}
              </div>
            )}
            {!loading && !error && (
              <table
                className="oc-table w-full text-[12px] border-collapse"
                style={{ tableLayout: 'fixed' }}
              >
                <thead>
                  <tr className="sticky top-0 z-10">
                    <th
                      colSpan={showGreeks ? 7 : 3}
                      className="oc-calls-th text-center py-1.5 text-[13px] font-bold"
                    >
                      Calls
                    </th>
                    <th
                      colSpan={2}
                      className="bg-[var(--bg-card)] border-b-2 border-[var(--border)]"
                    />
                    <th
                      colSpan={showGreeks ? 7 : 3}
                      className="oc-puts-th text-center py-1.5 text-[13px] font-bold"
                    >
                      Puts
                    </th>
                  </tr>
                  <tr className="sticky top-8 z-10 bg-[var(--bg-secondary)]">
                    {showGreeks &&
                      ['Vega', 'Gamma', 'Theta', 'Delta'].map((h) => (
                        <th
                          key={`ce-${h}`}
                          className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    {['OI (L)', 'Vol (L)', 'LTP'].map((h) => (
                      <th
                        key={`ce-${h}`}
                        className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                    <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">
                      Strike
                    </th>
                    <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">
                      IV %
                    </th>
                    {['LTP', 'Vol (L)', 'OI (L)'].map((h) => (
                      <th
                        key={`pe-${h}`}
                        className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                    {showGreeks &&
                      ['Delta', 'Theta', 'Gamma', 'Vega'].map((h) => (
                        <th
                          key={`pe-${h}`}
                          className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap"
                        >
                          {h}
                        </th>
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

        {/* Custom Basket Side Drawer — the same basket the Basket tab builds */}
        {basketMode && !embedded && (
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
                  <div className="text-xs font-semibold text-[var(--text-secondary)] mb-1">
                    Your basket is empty
                  </div>
                  <div className="text-[10px] text-[var(--text-muted)] leading-relaxed">
                    Click <span className="font-bold text-emerald-400">B</span> or{' '}
                    <span className="font-bold text-red-400">S</span> on any strike row to add
                    strategy legs.
                  </div>
                </div>
              ) : (
                legs.map((leg) => {
                  const isBuy = leg.side === 'BUY';
                  const mtm = legMtm(leg);
                  return (
                    <div
                      key={leg.id}
                      className="p-2 rounded border border-[var(--border)] bg-[var(--bg-card)] hover:border-[var(--accent)]/40 transition-all text-xs"
                    >
                      {/* Top Row: Side toggle, Expiry, Strike & Type, Remove */}
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => updateLeg(leg.id, { side: isBuy ? 'SELL' : 'BUY' })}
                            title="Switch between buy and sell"
                            className={`w-4 h-4 rounded flex items-center justify-center font-bold text-[9px] transition-colors ${
                              isBuy
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/40'
                                : 'bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/40'
                            }`}
                          >
                            {isBuy ? 'B' : 'S'}
                          </button>
                          <span className="text-[10px] text-[var(--text-muted)]">
                            {formatExpiry(leg.expiry)}
                          </span>
                          <span className="font-bold text-[var(--text-primary)]">
                            {fmtPrice(leg.strike)} {leg.optionType}
                          </span>
                        </div>
                        <button
                          onClick={() => removeLeg(leg.id)}
                          className="w-4 h-4 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--red)] hover:bg-[var(--red)]/10 transition-colors text-xs"
                          title="Remove leg"
                        >
                          ✕
                        </button>
                      </div>

                      {/* Bottom Row: Qty (lots × lot size), live LTP and MTM */}
                      <div className="flex items-center justify-between text-[11px] pt-1 border-t border-[var(--border)]/40">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => updateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                            className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                            title="Remove one lot"
                          >
                            −
                          </button>
                          <span className="font-semibold text-[var(--text-primary)] min-w-[28px] text-center">
                            {legQty(leg)}
                          </span>
                          <button
                            onClick={() => updateLeg(leg.id, { lots: leg.lots + 1 })}
                            className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                            title="Add one lot"
                          >
                            +
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-semibold ${mtm >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
                          >
                            {mtm >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(mtm))}
                          </span>
                          <span className="font-semibold text-[var(--text-primary)]">
                            ₹{fmtPrice(leg.ltp)}
                          </span>
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
                  <span className="text-[var(--text-muted)]">Total Premium:</span>
                  <span className={totalPremium >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                    {totalPremium >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPremium))}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-[var(--text-muted)]">Lot Multiplier</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => applyMultiplier(Math.max(1, multiplier - 1))}
                      className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                    >
                      −
                    </button>
                    <span className="font-bold text-[var(--text-primary)] min-w-[14px] text-center">
                      {multiplier}
                    </span>
                    <button
                      onClick={() => applyMultiplier(multiplier + 1)}
                      className="w-4 h-4 rounded bg-[var(--bg-primary)] border border-[var(--border)] flex items-center justify-center text-[10px] hover:bg-[var(--bg-hover)] text-[var(--text-secondary)]"
                    >
                      +
                    </button>
                  </div>
                </div>

                {legs.some((l) => l.delta != null) && (
                  <div className="grid grid-cols-4 gap-1 text-[10px] pt-1 border-t border-[var(--border)]/40">
                    {(
                      [
                        ['Delta', greeks.delta.toFixed(2)],
                        ['Theta', greeks.theta.toFixed(2)],
                        ['Gamma', greeks.gamma.toFixed(4)],
                        ['Vega', greeks.vega.toFixed(2)],
                      ] as const
                    ).map(([label, val]) => (
                      <div key={label} className="text-center">
                        <div className="text-[var(--text-muted)]">{label}</div>
                        <div className="font-semibold text-[var(--text-primary)]">{val}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Margin — same figures the Basket tab shows */}
                <div className="pt-1 border-t border-[var(--border)]/40 space-y-1">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-[var(--text-muted)] font-semibold">Margin</span>
                    {marginLoading ? (
                      <span className="text-[var(--text-muted)]">Calculating…</span>
                    ) : margin ? (
                      margin.estimated ? (
                        <span
                          className="px-1.5 rounded border border-yellow-500/30 bg-yellow-500/15 text-yellow-500 font-semibold cursor-help"
                          title={
                            margin.message ||
                            'Broker margin unavailable. Calculated locally via exchange-style fallback / SPAN risk data.'
                          }
                        >
                          ⚡ Local Est.
                        </span>
                      ) : (
                        <span
                          className="px-1.5 rounded border border-emerald-500/30 bg-emerald-500/15 text-emerald-500 font-semibold"
                          title="Calculated live from Nubra API"
                        >
                          ✓ Nubra API
                        </span>
                      )
                    ) : null}
                  </div>
                  {margin ? (
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Span</span>
                        <span className="text-[var(--text-primary)]">
                          {margin.span ? fmtPrice(margin.span) : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Exposure</span>
                        <span className="text-[var(--text-primary)]">
                          {margin.exposure ? fmtPrice(margin.exposure) : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-muted)]">Premium</span>
                        <span className="text-[var(--text-primary)]">
                          {margin.premium
                            ? fmtPrice(margin.premium)
                            : fmtPrice(Math.abs(totalPremium))}
                        </span>
                      </div>
                      <div className="flex justify-between font-semibold">
                        <span className="text-[var(--text-muted)]">Total</span>
                        <span className="text-[var(--text-primary)]">{fmtPrice(margin.total)}</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`text-[10px] ${marginError ? 'text-[var(--red)]' : 'text-[var(--text-muted)]'}`}
                    >
                      {marginError ? `Margin unavailable: ${marginError}` : 'Calculating margin…'}
                    </div>
                  )}
                </div>

                {placed && (
                  <div
                    className={`text-[10px] leading-snug ${placed.ok ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
                  >
                    {placed.msg}
                  </div>
                )}

                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  <button
                    onClick={() => {
                      setShowSaveModal(true);
                      setSaveName('');
                    }}
                    className="w-full py-1.5 rounded border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] font-semibold text-xs transition-all"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => onChangeView?.('basket')}
                    className="w-full py-1.5 rounded border border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 font-semibold text-xs transition-all flex items-center justify-center gap-1"
                  >
                    📊 Analyze
                  </button>
                  <button
                    onClick={tradeBasket}
                    disabled={trading}
                    className="w-full py-1.5 rounded bg-[var(--accent)] text-white hover:bg-[var(--accent-dim)] font-semibold text-xs shadow transition-all flex items-center justify-center gap-1 disabled:opacity-50"
                  >
                    {trading ? '…' : '⚡ Trade'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Save modal — writes to the same /paper/baskets store as the Basket tab */}
      {showSaveModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setShowSaveModal(false)}
        >
          <div
            className="w-[360px] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-base font-bold text-[var(--text-primary)]">Save Strategy</span>
              <button
                onClick={() => setShowSaveModal(false)}
                className="text-lg text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                ✕
              </button>
            </div>
            <div className="text-xs text-[var(--text-secondary)] mb-2">Name your strategy</div>
            <input
              type="text"
              value={saveName}
              autoFocus
              placeholder="e.g. NIFTY Iron Condor"
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveStrategy();
              }}
              className="w-full px-3 py-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] outline-none"
            />
            <div className="flex gap-2.5 mt-4">
              <button
                onClick={() => setShowSaveModal(false)}
                className="flex-1 py-2.5 rounded-lg border border-[var(--border)] text-[13px] font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              <button
                onClick={saveStrategy}
                disabled={!saveName.trim()}
                className="flex-1 py-2.5 rounded-lg bg-[var(--accent)] text-[13px] font-semibold text-white hover:bg-[var(--accent-dim)] disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Live-feed health for the chain on screen. The WS feed can go away silently —
 * an unsubscribe from another consumer, a reconnect that was never replayed — and
 * the table then keeps rendering whatever it last received. This makes that
 * visible: green while ticks arrive over the socket, amber on the 5s REST
 * fallback, red once nothing has landed for a while.
 */
function FeedBadge({ feed }: { feed: { src: 'ws' | 'poll'; ageMs: number } | null }) {
  if (!feed) return null;
  const age = Math.round(feed.ageMs / 1000);
  const live = feed.src === 'ws' && feed.ageMs < 3000;
  const poll = !live && feed.ageMs < 15000;

  const label = live ? 'LIVE' : poll ? 'POLL' : `STALE ${age}s`;
  const tone = live
    ? 'bg-[var(--green)]/15 border-[var(--green)]/40 text-[var(--green)]'
    : poll
      ? 'bg-amber-500/15 border-amber-500/40 text-amber-400'
      : 'bg-[var(--red)]/15 border-[var(--red)]/40 text-[var(--red)]';
  const title = live
    ? 'Streaming tick-by-tick over the WebSocket feed'
    : poll
      ? 'No WebSocket ticks — falling back to the 5s REST poll, so prices lag'
      : `No update for ${age}s — prices on screen are stale`;

  return (
    <div
      className={`flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold ${tone}`}
      title={title}
    >
      <span className="text-[8px]">●</span>
      {label}
    </div>
  );
}

async function fetchChainApi(
  symbol: string,
  exchange: string,
  expiry: string,
): Promise<{ chain?: OptionChainData }> {
  const params = new URLSearchParams({ exchange });
  if (expiry) params.set('expiry', expiry);
  const res = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${params}`);
  const data = (await res.json()) as { chain?: OptionChainData; error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}
