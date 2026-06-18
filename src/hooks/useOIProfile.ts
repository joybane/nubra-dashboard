import { useCallback, useEffect, useRef, useState } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { Instrument, OptionChainData, WsMessage } from '../types';
import { getSymbol } from '../types';
import { formatExpiry } from '../lib/utils';
import { drawOI as renderOI, hitTestOIBar, normalizeStrike, type OiLeg, type OiSnap } from '../lib/oiRenderer';
import { useWs } from './useWsContext';

export interface OIProfileApi {
  // state
  oiOn: boolean;
  showOiPopup: boolean;
  oiExpiries: string[];
  selExpiries: string[];
  oiMode: 'oi' | 'oi_change';
  showCalls: boolean;
  showPuts: boolean;
  oiFromTime: string;
  oiToTime: string;
  oiHover: { x: number; y: number; strike: number; ceOi: number; peOi: number } | null;
  // setters
  setShowOiPopup: (v: boolean | ((p: boolean) => boolean)) => void;
  setSelExpiries: (v: string[] | ((p: string[]) => string[])) => void;
  setOiMode: (v: 'oi' | 'oi_change') => void;
  setShowCalls: (v: boolean) => void;
  setShowPuts: (v: boolean) => void;
  setOiFromTime: (v: string) => void;
  setOiToTime: (v: string) => void;
  setOiHover: (v: { x: number; y: number; strike: number; ceOi: number; peOi: number } | null) => void;
  // actions
  toggleOI: () => void;
  openSettings: () => void;
  applyExpiries: () => void;
  fetchOIHistory: () => void;
  drawOI: () => void;
  requestDraw: () => void;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseLeave: () => void;
  handleFromTimeChange: (v: string) => void;
  handleToTimeChange: (v: string) => void;
  resetTimeRange: () => void;
  clearForInstrumentChange: () => void;
  // refs exposed for chart init listeners
  oiEnabledRef: React.RefObject<boolean>;
  drawOIRef: React.RefObject<() => void>;
  oiDrawPendingRef: React.RefObject<boolean>;
}

interface Deps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  currentInstRef: React.RefObject<Instrument | null>;
}

export function useOIProfile({ containerRef, canvasRef, candleRef, currentInstRef }: Deps): OIProfileApi {
  const { subscribe, subscribeOC, unsubscribeOC } = useWs();

  // ── Refs ──────────────────────────────────────────────────────────────────
  const oiLoopRef = useRef<number | null>(null);
  const oiChainRef = useRef<{ ce: OiLeg[]; pe: OiLeg[] } | null>(null);
  const oiEnabledRef = useRef(false);
  const oiWidthScaleRef = useRef(1.0);
  const oiDragRef = useRef({ dragging: false, startX: 0, startScale: 1 });
  const drawOIRef = useRef<() => void>(() => {});
  const oiSnapshotsRef = useRef<Map<number, OiSnap>>(new Map());
  const oiBaselineRef = useRef<OiSnap | null>(null);
  const oiToSnapRef = useRef<OiSnap | null>(null);
  const lastOiSnapTimeRef = useRef(0);
  const oiWsAssetRef = useRef<string | null>(null);
  const oiWsExpiryRef = useRef<string | null>(null);
  const oiWsExchRef = useRef<string>('NSE');
  const oiHistoricalRef = useRef<Map<string, { ts: number; v: number }[]>>(new Map());
  const oiHistFetchedRef = useRef(false);
  const oiHistLoadingRef = useRef(false);
  const oiFromMsRef = useRef<number | null>(null);
  const oiToMsRef = useRef<number | null>(null);
  const oiDeltasRef = useRef<Record<number, { ceDelta: number; peDelta: number }>>({});
  const oiSymbolMapRef = useRef<{ ce: Map<number, string>; pe: Map<number, string> }>({ ce: new Map(), pe: new Map() });
  const oiDrawPendingRef = useRef(false);

  // ── State ────────────────────────────────────────────────────────────────
  const [oiOn, setOiOn] = useState(false);
  const [showOiPopup, setShowOiPopup] = useState(false);
  const [oiExpiries, setOiExpiries] = useState<string[]>([]);
  const [selExpiries, setSelExpiries] = useState<string[]>([]);
  const [oiMode, setOiMode] = useState<'oi' | 'oi_change'>('oi');
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  const [oiFromTime, setOiFromTime] = useState('');
  const [oiToTime, setOiToTime] = useState('');
  const [oiHover, setOiHover] = useState<{ x: number; y: number; strike: number; ceOi: number; peOi: number } | null>(null);

  const oiModeRef = useRef(oiMode);
  oiModeRef.current = oiMode;

  // ── WS helpers ───────────────────────────────────────────────────────────
  function subscribeOiWs(asset: string, expiry: string, exchange: string) {
    if (oiWsAssetRef.current === asset && oiWsExpiryRef.current === expiry) return;
    if (oiWsAssetRef.current && oiWsExpiryRef.current) {
      unsubscribeOC(oiWsAssetRef.current, oiWsExpiryRef.current, oiWsExchRef.current);
    }
    oiWsAssetRef.current = asset;
    oiWsExpiryRef.current = expiry;
    oiWsExchRef.current = exchange;
    subscribeOC(asset, expiry, exchange);
  }

  function unsubscribeOiWs() {
    if (oiWsAssetRef.current && oiWsExpiryRef.current) {
      unsubscribeOC(oiWsAssetRef.current, oiWsExpiryRef.current, oiWsExchRef.current);
    }
    oiWsAssetRef.current = null;
    oiWsExpiryRef.current = null;
  }

  // ── Live OI WS updates ──────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain' || !oiEnabledRef.current || !oiChainRef.current) return;
      const data = msg.data as OptionChainData;
      if ((data.asset || '').toUpperCase() !== oiWsAssetRef.current) return;
      if ((data.expiry || '') !== oiWsExpiryRef.current) return;

      const ceOiMap: Record<number, number> = {};
      const peOiMap: Record<number, number> = {};
      for (const leg of (data.ce || [])) {
        const sp = normalizeStrike(Number(leg.sp));
        const oi = Number(leg.oi ?? (leg as { open_interest?: number }).open_interest) || 0;
        if (sp > 0 && oi > 0) ceOiMap[sp] = oi;
      }
      for (const leg of (data.pe || [])) {
        const sp = normalizeStrike(Number(leg.sp));
        const oi = Number(leg.oi ?? (leg as { open_interest?: number }).open_interest) || 0;
        if (sp > 0 && oi > 0) peOiMap[sp] = oi;
      }
      if (!Object.keys(ceOiMap).length && !Object.keys(peOiMap).length) return;

      oiChainRef.current = {
        ce: oiChainRef.current.ce.map(leg => {
          const spRs = normalizeStrike(Number(leg.sp));
          return spRs in ceOiMap ? { ...leg, oi: ceOiMap[spRs] } : leg;
        }),
        pe: oiChainRef.current.pe.map(leg => {
          const spRs = normalizeStrike(Number(leg.sp));
          return spRs in peOiMap ? { ...leg, oi: peOiMap[spRs] } : leg;
        }),
      };
    });
    return unsub;
  }, [subscribe]);

  // ── Core draw ────────────────────────────────────────────────────────────
  function drawOI() {
    const canvas = canvasRef.current;
    const cont = containerRef.current;
    const series = candleRef.current;
    if (!canvas || !cont || !series || !oiChainRef.current) return;

    renderOI({
      canvas,
      containerW: cont.clientWidth,
      containerH: cont.clientHeight,
      priceToCoordinate: (p) => series.priceToCoordinate(p),
      oiChain: oiChainRef.current,
      enabled: oiEnabledRef.current,
      widthScale: oiWidthScaleRef.current,
      showCalls,
      showPuts,
      mode: oiModeRef.current,
      histFetched: oiHistFetchedRef.current,
      historicalMap: oiHistoricalRef.current,
      symbolMap: oiSymbolMapRef.current,
      fromMs: oiFromMsRef.current,
      toMs: oiToMsRef.current,
      baseline: oiBaselineRef.current,
      toSnap: oiToSnapRef.current,
      deltasOut: oiDeltasRef.current,
    });
  }
  drawOIRef.current = drawOI;

  function requestDraw() {
    if (!oiEnabledRef.current || oiDrawPendingRef.current) return;
    oiDrawPendingRef.current = true;
    requestAnimationFrame(() => { drawOIRef.current(); oiDrawPendingRef.current = false; });
  }

  // ── Fetch / reload ──────────────────────────────────────────────────────
  async function loadOIChain() {
    if (!currentInstRef.current) return;
    const sym = getSymbol(currentInstRef.current);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: OiLeg[]; pe?: OiLeg[] } };
      if (!data.chain) return;
      const expiries = data.chain.all_expiries || [];
      setOiExpiries(expiries);
      const first = expiries.slice(0, 1);
      setSelExpiries(first);
      await reloadOIExpiries(first);
    } catch { /* ignore */ }
  }

  async function reloadOIExpiries(expiries: string[]) {
    if (!currentInstRef.current || expiries.length === 0) return;
    const sym = getSymbol(currentInstRef.current);
    const ceMap: Record<number, number> = {};
    const peMap: Record<number, number> = {};
    const ceSymMap = new Map<number, string>();
    const peSymMap = new Map<number, string>();
    for (const exp of expiries) {
      try {
        const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${encodeURIComponent(exp)}`);
        const data = await res.json() as { chain?: { ce?: OiLeg[]; pe?: OiLeg[] } };
        if (!data.chain) continue;
        for (const ce of (data.chain.ce || [])) {
          const sp = normalizeStrike(Number(ce.sp));
          const oi = Number(ce.oi ?? ce.open_interest) || 0;
          ceMap[sp] = (ceMap[sp] || 0) + oi;
          if (ce.symbol && !ceSymMap.has(Number(ce.sp))) ceSymMap.set(Number(ce.sp), String(ce.symbol));
        }
        for (const pe of (data.chain.pe || [])) {
          const sp = normalizeStrike(Number(pe.sp));
          const oi = Number(pe.oi ?? pe.open_interest) || 0;
          peMap[sp] = (peMap[sp] || 0) + oi;
          if (pe.symbol && !peSymMap.has(Number(pe.sp))) peSymMap.set(Number(pe.sp), String(pe.symbol));
        }
      } catch { /* ignore */ }
    }
    oiSymbolMapRef.current = { ce: ceSymMap, pe: peSymMap };
    const hasData = Object.values(ceMap).some(v => v > 0) || Object.values(peMap).some(v => v > 0);
    if (hasData) {
      oiChainRef.current = {
        ce: Object.entries(ceMap).map(([sp, oi]) => ({ sp: Number(sp) * 100, oi })),
        pe: Object.entries(peMap).map(([sp, oi]) => ({ sp: Number(sp) * 100, oi })),
      };
    }
    oiHistoricalRef.current = new Map();
    oiHistFetchedRef.current = false;
    oiEnabledRef.current = true;
    setOiOn(true);
    if (expiries.length === 1 && currentInstRef.current) {
      subscribeOiWs(
        getSymbol(currentInstRef.current).toUpperCase(),
        expiries[0],
        currentInstRef.current.exchange || 'NSE',
      );
    } else {
      unsubscribeOiWs();
    }
    startOILoop();
    requestAnimationFrame(drawOI);
  }

  async function fetchOIHistory() {
    if (!oiChainRef.current || !currentInstRef.current || oiHistLoadingRef.current) return;
    const symMap = oiSymbolMapRef.current;
    if (!symMap.ce.size) return;
    oiHistLoadingRef.current = true;

    const values: string[] = [];
    const seen = new Set<string>();
    for (const [sp, ceSym] of symMap.ce.entries()) {
      const peSym = symMap.pe.get(sp);
      if (ceSym && !seen.has(ceSym)) { seen.add(ceSym); values.push(ceSym); }
      if (peSym && !seen.has(peSym)) { seen.add(peSym); values.push(peSym); }
    }

    try {
      const today = new Date();
      const startUTC = new Date(today);
      startUTC.setUTCHours(3, 45, 0, 0);

      const res = await fetch('/api/historical', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ exchange: currentInstRef.current.exchange || 'NSE', type: 'OPT', values, fields: ['cumulative_oi'], startDate: startUTC.toISOString(), endDate: today.toISOString(), interval: '1m', intraDay: true, realTime: false }] }),
      });
      if (!res.ok) { oiHistLoadingRef.current = false; return; }
      const data = await res.json() as { result?: Array<{ values?: Array<Record<string, { cumulative_oi?: Array<{ ts: number; v: number }> }>> }> };
      const map = new Map<string, { ts: number; v: number }[]>();
      for (const row of data.result?.[0]?.values ?? []) {
        for (const [name, series] of Object.entries(row)) {
          if (series?.cumulative_oi?.length) map.set(name, series.cumulative_oi);
        }
      }
      oiHistoricalRef.current = map;
      oiHistFetchedRef.current = true;
      requestAnimationFrame(drawOI);
    } catch { /* ignore */ }
    finally { oiHistLoadingRef.current = false; }
  }

  // ── OI Loop ──────────────────────────────────────────────────────────────
  function startOILoop() {
    if (oiLoopRef.current) return;
    const storeSnap = () => {
      if (!oiChainRef.current) return;
      const now = Date.now();
      if (now - lastOiSnapTimeRef.current > 30000) {
        oiSnapshotsRef.current.set(now, { ce: [...oiChainRef.current.ce], pe: [...oiChainRef.current.pe] });
        lastOiSnapTimeRef.current = now;
        const cutoff = now - 8 * 3_600_000;
        for (const [ts] of oiSnapshotsRef.current) {
          if (ts < cutoff) oiSnapshotsRef.current.delete(ts);
        }
      }
    };
    storeSnap();
    function loop() {
      if (!oiEnabledRef.current) { oiLoopRef.current = null; return; }
      storeSnap();
      drawOI();
      oiLoopRef.current = requestAnimationFrame(() => setTimeout(loop, 100));
    }
    oiLoopRef.current = requestAnimationFrame(loop);
  }

  // ── Mouse handlers ──────────────────────────────────────────────────────
  function handleMouseDown(e: React.MouseEvent) {
    if (!oiEnabledRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const priceScaleW = 72;
    const maxBarW = (containerRef.current.clientWidth - priceScaleW) * 0.35 * oiWidthScaleRef.current;
    const handleX = containerRef.current.clientWidth - priceScaleW - maxBarW;
    if (Math.abs(x - handleX) > 15) return;

    oiDragRef.current = { dragging: true, startX: x, startScale: oiWidthScaleRef.current };
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rx = ev.clientX - containerRef.current.getBoundingClientRect().left;
      const dx = oiDragRef.current.startX - rx;
      const base = (containerRef.current.clientWidth - 72) * 0.35;
      oiWidthScaleRef.current = Math.max(0.2, Math.min(3.0, oiDragRef.current.startScale + dx / base));
      drawOIRef.current();
    };
    const onUp = () => {
      oiDragRef.current.dragging = false;
      if (containerRef.current) containerRef.current.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      drawOIRef.current();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const priceScaleW = 72;
    const w = containerRef.current.clientWidth;
    const maxBarW = (w - priceScaleW) * 0.35 * oiWidthScaleRef.current;
    const handleX = w - priceScaleW - maxBarW;

    if (oiEnabledRef.current) {
      containerRef.current.style.cursor = Math.abs(x - handleX) <= 15 ? 'ew-resize' : '';
    }

    if (oiEnabledRef.current && oiChainRef.current && candleRef.current && x >= handleX - 5) {
      const hit = hitTestOIBar({
        x, y, containerW: w,
        widthScale: oiWidthScaleRef.current,
        oiChain: oiChainRef.current,
        priceToCoordinate: (p) => candleRef.current!.priceToCoordinate(p),
        coordinateToPrice: (py) => candleRef.current!.coordinateToPrice(py),
        mode: oiModeRef.current,
        histFetched: oiHistFetchedRef.current,
        deltas: oiDeltasRef.current,
      });
      if (hit) { setOiHover({ x, y, ...hit }); return; }
    }
    setOiHover(null);
  }

  function handleMouseLeave() {
    if (containerRef.current && !oiDragRef.current.dragging) {
      containerRef.current.style.cursor = '';
    }
    setOiHover(null);
  }

  // ── Time range handlers ─────────────────────────────────────────────────
  function timeToMs(hhmm: string): number {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  function handleFromTimeChange(v: string) {
    setOiFromTime(v);
    if (oiModeRef.current === 'oi_change') {
      oiFromMsRef.current = v ? timeToMs(v) : null;
    } else {
      const snaps = Array.from(oiSnapshotsRef.current.entries()).sort((a, b) => a[0] - b[0]);
      if (v && snaps.length) {
        const ms = timeToMs(v);
        const s = snaps.find(([ts]) => ts >= ms) ?? snaps[0];
        oiBaselineRef.current = s[1];
      } else {
        oiBaselineRef.current = null;
      }
    }
    drawOIRef.current();
  }

  function handleToTimeChange(v: string) {
    setOiToTime(v);
    if (oiModeRef.current === 'oi_change') {
      oiToMsRef.current = v ? timeToMs(v) : null;
    } else {
      const snaps = Array.from(oiSnapshotsRef.current.entries()).sort((a, b) => a[0] - b[0]);
      if (v && snaps.length) {
        const ms = timeToMs(v);
        const candidates = snaps.filter(([ts]) => ts <= ms);
        const s = candidates[candidates.length - 1] ?? snaps[0];
        oiToSnapRef.current = s[1];
      } else {
        oiToSnapRef.current = null;
      }
    }
    drawOIRef.current();
  }

  function resetTimeRange() {
    setOiFromTime('');
    setOiToTime('');
    oiBaselineRef.current = null;
    oiToSnapRef.current = null;
    oiFromMsRef.current = null;
    oiToMsRef.current = null;
    drawOIRef.current();
  }

  // ── Public actions ──────────────────────────────────────────────────────
  function toggleOI() {
    if (oiEnabledRef.current) {
      oiEnabledRef.current = false;
      setOiOn(false);
      setShowOiPopup(false);
      unsubscribeOiWs();
      drawOI();
    } else if (oiChainRef.current) {
      oiEnabledRef.current = true;
      setOiOn(true);
      startOILoop();
    } else if (currentInstRef.current) {
      loadOIChain();
    }
  }

  function openSettings() {
    setShowOiPopup(v => !v);
    if (!oiExpiries.length && currentInstRef.current) loadOIChain();
  }

  function applyExpiries() {
    reloadOIExpiries(selExpiries);
    setShowOiPopup(false);
  }

  function clearForInstrumentChange() {
    if (oiEnabledRef.current) { oiEnabledRef.current = false; setOiOn(false); }
    oiChainRef.current = null;
    oiHistoricalRef.current = new Map();
    oiHistFetchedRef.current = false;
    oiSnapshotsRef.current = new Map();
    oiBaselineRef.current = null;
    oiToSnapRef.current = null;
    unsubscribeOiWs();
  }

  return {
    oiOn, showOiPopup, oiExpiries, selExpiries, oiMode, showCalls, showPuts,
    oiFromTime, oiToTime, oiHover,
    setShowOiPopup, setSelExpiries, setOiMode, setShowCalls, setShowPuts,
    setOiFromTime, setOiToTime, setOiHover,
    toggleOI, openSettings, applyExpiries, fetchOIHistory, drawOI, requestDraw,
    handleMouseDown, handleMouseMove, handleMouseLeave,
    handleFromTimeChange, handleToTimeChange, resetTimeRange,
    clearForInstrumentChange,
    oiEnabledRef, drawOIRef, oiDrawPendingRef,
  };
}
