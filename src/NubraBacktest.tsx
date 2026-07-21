import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createChart, LineSeries, CandlestickSeries, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import SvgChart from './components/SvgChart';
import type { Instrument } from './types';
import { useWorkspaceState } from './workspace/useWorkspaceState';
import { payoffAtExpiry, blackScholes, impliedVolatility } from './lib/GexService';
import { fmtPrice } from './lib/utils';
import { PriceTooltip, PnlTooltip, GreeksTooltip, PriceTooltipRef, PnlTooltipRef, GreeksTooltipRef } from './components/ChartTooltips';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChainRow {
  strike: number;
  ceLtp: number; ceIv: number; ceOi: number; ceVol: number;
  peLtp: number; peIv: number; peOi: number; peVol: number;
}

interface AvailableExpiry { expiry: string; flag: string; }

interface ChainResponse {
  ok: boolean; underlying: string; date: string; time: string; spot: number;
  expiry: string; expiryFlag: string; availableExpiries: AvailableExpiry[];
  chain: ChainRow[]; error?: string;
}

interface Leg {
  id: string; strike: number; optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; lots: number;
  ltp: number; // price at entry time
}

interface EvalLegResult {
  strike: number; optionType: string; side: string; lots: number;
  entryPrice: number; exitPrice: number; highAfterEntry: number; lowAfterEntry: number; pnl: number;
}

interface IntradayPoint { hhmm: string; spot: number; total: number; }

interface HistBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface LegPriceSeries {
  legIndex: number;
  data: Array<{ time: number; value: number }>;
}

interface LegPnlSeries {
  legIndex: number;
  data: Array<{ time: number; value: number }>;
}

interface EvalResponse {
  ok: boolean; entrySpot: number; exitSpot: number;
  legs: EvalLegResult[]; grossPnl: number; intradayCurve: IntradayPoint[];
  underlyingBars?: HistBar[];
  legPriceData?: LegPriceSeries[];
  legPnlData?: LegPnlSeries[];
  basketPnlData?: Array<{ time: number; value: number }>;
  error?: string;
}

interface Props { instrument: Instrument | null; theme?: 'light' | 'dark'; }

// ── Helpers ───────────────────────────────────────────────────────────────────

const IST_OFFSET = 19800; // 5h 30m

function chartOpts(isDark: boolean) {
  return {
    autoSize: false,
    devicePixelRatio: window.devicePixelRatio,
    layout: {
      background: { color: isDark ? '#0d0f11' : '#ffffff' },
      textColor: isDark ? '#c9d1d9' : '#131722',
      fontSize: 10,
      fontFamily: "'Inter', 'Segoe UI', sans-serif",
    },
    grid: {
      vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: '#4b5563', width: 1 as const, style: 0 as const, labelBackgroundColor: isDark ? '#22262b' : '#e8ecf5' },
      horzLine: { color: '#4b5563', width: 1 as const, style: 0 as const, labelBackgroundColor: '#2962ff' },
    },
    leftPriceScale: { visible: true, borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
    rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
    timeScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', timeVisible: true, secondsVisible: false },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true },
  };
}

const LEG_COLORS = ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6'];

function formatCrosshairTime(timeSec: number): string {
  const totalMin = Math.floor((timeSec % 86400) / 60);
  const hh = Math.floor(totalMin / 60).toString().padStart(2, '0');
  const mm = (totalMin % 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function adjustTime(timeStr: string, deltaMinutes: number): string {
  if (!timeStr) return '09:20';
  const parts = timeStr.split(':');
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  let totalMin = h * 60 + m + deltaMinutes;
  if (totalMin < 0) totalMin += 24 * 60;
  if (totalMin >= 24 * 60) totalMin -= 24 * 60;
  const newH = Math.floor(totalMin / 60).toString().padStart(2, '0');
  const newM = (totalMin % 60).toString().padStart(2, '0');
  return `${newH}:${newM}`;
}

function padToGrid(
  grid: number[],
  data: Array<{ time: number; value: number }>,
): Array<{ time: number; value?: number }> {
  if (grid.length === 0) return data;
  const valMap = new Map<number, number>();
  for (const d of data) valMap.set(Math.floor(d.time / 60) * 60, d.value);

  const result: Array<{ time: number; value?: number }> = [];
  const allTimes = new Set<number>(grid.map(t => Math.floor(t / 60) * 60));
  for (const d of data) allTimes.add(Math.floor(d.time / 60) * 60);

  const sorted = Array.from(allTimes).sort((a, b) => a - b);
  for (const t of sorted) {
    if (valMap.has(t)) {
      result.push({ time: t, value: valMap.get(t) });
    } else {
      result.push({ time: t });
    }
  }
  return result;
}

let _idSeq = 0;
function genId() { return `nbl_${Date.now().toString(36)}_${++_idSeq}`; }

function inr(n: number): string {
  const s = Math.abs(n) >= 100000
    ? `${(n / 100000).toFixed(2)}L`
    : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
  return n < 0 ? `-₹${s.replace('-', '')}` : `₹${s}`;
}

function formatExpiry(exp: string): string {
  if (!exp) return '';
  const d = new Date(exp + 'T00:00:00Z');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' });
}

const DEFAULT_LOT: Record<string, number> = { NIFTY: 65, SENSEX: 20 };

// ── Component ─────────────────────────────────────────────────────────────────

export default function NubraBacktest({ instrument, theme = 'dark' }: Props) {
  const { loadInstrumentInActivePane } = useWorkspaceState();
  // Config state
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [date, setDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day === 0) d.setDate(d.getDate() - 2); // Sun → Fri
    if (day === 6) d.setDate(d.getDate() - 1); // Sat → Fri
    return d.toISOString().slice(0, 10);
  });
  const [entryTime, setEntryTime] = useState('09:20');
  const [exitTime, setExitTime] = useState('15:15');
  const [expiry, setExpiry] = useState('');

  // Chain state
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [availableExpiries, setAvailableExpiries] = useState<AvailableExpiry[]>([]);
  const [spot, setSpot] = useState(0);
  const [chainLoading, setChainLoading] = useState(false);
  const [chainError, setChainError] = useState<string | null>(null);

  const [activeExpiry, setActiveExpiry] = useState('');
  const [activeFlag, setActiveFlag] = useState('');

  // Legs
  const [legs, setLegs] = useState<Leg[]>([]);

  // Eval result
  const [evalResult, setEvalResult] = useState<EvalResponse | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  // Chart hover & crosshair states

  // Refs for lightweight-charts
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const pnlContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const pnlChartRef = useRef<IChartApi | null>(null);
  const [chartEpoch, setChartEpoch] = useState(0);

  // Expand charts: hides left panel so all 3 charts get full width
  const [chartsExpanded, setChartsExpanded] = useState(false);

  // Layout heights & collapse states
  const [pnlHeight, setPnlHeight] = useState(150);
  const [greeksHeight, setGreeksHeight] = useState(150);
  const [positionsHeight, setPositionsHeight] = useState(160);
  const [positionsCollapsed, setPositionsCollapsed] = useState(false);

  // Greeks visible state
  const [greeksVisible, setGreeksVisible] = useState(false);

  // Greeks series data state: split into Net, CE, and PE series arrays
  const [greeksData, setGreeksData] = useState<{
    net: {
      delta: Array<{ time: number; value: number }>;
      gamma: Array<{ time: number; value: number }>;
      theta: Array<{ time: number; value: number }>;
      vega: Array<{ time: number; value: number }>;
    };
    CE: {
      delta: Array<{ time: number; value: number }>;
      gamma: Array<{ time: number; value: number }>;
      theta: Array<{ time: number; value: number }>;
      vega: Array<{ time: number; value: number }>;
    };
    PE: {
      delta: Array<{ time: number; value: number }>;
      gamma: Array<{ time: number; value: number }>;
      theta: Array<{ time: number; value: number }>;
      vega: Array<{ time: number; value: number }>;
    };
  } | null>(null);

  // Hover Greek data


  const priceTooltipRef = useRef<PriceTooltipRef>(null);
  const pnlTooltipRef = useRef<PnlTooltipRef>(null);
  const greeksTooltipRef = useRef<GreeksTooltipRef>(null);
  const [activeChartType, setActiveChartType] = useState<'price' | 'pnl' | 'greeks' | null>(null);

  // Greeks Chart Refs
  const greeksContainerRef = useRef<HTMLDivElement>(null);
  const greeksChartRef = useRef<IChartApi | null>(null);

  // Popup dropdown open states
  const [chartsPopupOpen, setChartsPopupOpen] = useState(false);
  const [pnlPopupOpen, setPnlPopupOpen] = useState(false);
  const [greeksPopupOpen, setGreeksPopupOpen] = useState(false);

  // References for clicking outside to close
  const chartsPopupRef = useRef<HTMLDivElement>(null);
  const pnlPopupRef = useRef<HTMLDivElement>(null);
  const greeksPopupRef = useRef<HTMLDivElement>(null);
  const chartsWrapperRef = useRef<HTMLDivElement>(null);

  // Click outside to close handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (chartsPopupRef.current && !chartsPopupRef.current.contains(event.target as Node)) {
        setChartsPopupOpen(false);
      }
      if (pnlPopupRef.current && !pnlPopupRef.current.contains(event.target as Node)) {
        setPnlPopupOpen(false);
      }
      if (greeksPopupRef.current && !greeksPopupRef.current.contains(event.target as Node)) {
        setGreeksPopupOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Layer toggles
  const [showSpotPrice, setShowSpotPrice] = useState(true);
  const [hiddenLegPrices, setHiddenLegPrices] = useState<Set<string>>(() => new Set());
  const [showTotalPnl, setShowTotalPnl] = useState(true);
  const [hiddenLegPnls, setHiddenLegPnls] = useState<Set<string>>(() => new Set());

  // Greeks options
  const [greeksMode, setGreeksMode] = useState<'unit' | 'lot'>('lot');
  const [selectedGreeks, setSelectedGreeks] = useState<Set<string>>(() => new Set(['delta', 'gamma', 'theta', 'vega']));
  const [greeksLegFilter, setGreeksLegFilter] = useState<Set<string>>(() => new Set(['net'])); // 'net', 'CE', 'PE'
  const [greeksExpanded, setGreeksExpanded] = useState(false);

  // Active crosshair time for Greeks popover Net values and Leg breakdown
  const [activeTime, setActiveTime] = useState<number | null>(null);

  // Layout
  const [leftWidth, setLeftWidth] = useState(480);
  const [isDragging, setIsDragging] = useState(false);

  // Lot Size State
  const [lotSize, setLotSize] = useState(65);

  // Sync lot default value when underlying or instrument changes
  useEffect(() => {
    if (instrument && instrument.lot_size) {
      setLotSize(instrument.lot_size);
    } else {
      setLotSize(DEFAULT_LOT[underlying] ?? 1);
    }
  }, [underlying, instrument]);

  // Find closest strike to spot in chain (ATM)
  const closestStrike = useMemo(() => {
    if (!spot || !chain.length) return null;
    return chain.reduce((prev, curr) => 
      Math.abs(curr.strike - spot) < Math.abs(prev.strike - spot) ? curr : prev
    ).strike;
  }, [spot, chain]);

  // Ref and scroll effect for ATM centering
  const atmRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (closestStrike && atmRowRef.current) {
      atmRowRef.current.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
  }, [closestStrike, chain]);

  // Determine underlying from selected instrument
  useEffect(() => {
    if (!instrument) return;
    const sym = (instrument.asset || instrument.nubra_name || instrument.symbol || instrument.display_name || '').toUpperCase();
    if (sym) {
      setUnderlying(sym);
    }
  }, [instrument]);

  // Dynamic Greeks Calculation
  const spotMap = useMemo(() => {
    const m = new Map<number, number>();
    if (evalResult?.underlyingBars) {
      for (const bar of evalResult.underlyingBars) {
        m.set(Math.floor(bar.time / 60) * 60, bar.close);
      }
    }
    return m;
  }, [evalResult]);

  const legPriceMap = useMemo(() => {
    const m = new Map<number, Map<number, number>>();
    if (evalResult?.legPriceData) {
      for (const lp of evalResult.legPriceData) {
        const sub = new Map<number, number>();
        for (const d of lp.data) {
          sub.set(Math.floor(d.time / 60) * 60, d.value);
        }
        m.set(lp.legIndex, sub);
      }
    }
    return m;
  }, [evalResult]);

  const expiryTimeMs = useMemo(() => {
    if (!activeExpiry) return 0;
    return new Date(activeExpiry + 'T15:30:00+05:30').getTime();
  }, [activeExpiry]);

  // Helper to calculate Greeks breakdown dynamically for popover / table
  const getGreeksAtTime = useCallback((t: number) => {
    const minuteKey = Math.floor(t / 60) * 60;
    const spotPrice = spotMap.get(minuteKey) || 0;
    if (spotPrice <= 0 || !activeExpiry) return null;

    const barTimeMs = (t - IST_OFFSET) * 1000;
    const timeToExpiryMs = Math.max(0, expiryTimeMs - barTimeMs);
    const T = Math.max(timeToExpiryMs / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 60));

    const legBreakdown: Array<{
      id: string;
      strike: number;
      optionType: 'CE' | 'PE';
      side: 'BUY' | 'SELL';
      lots: number;
      delta: number;
      gamma: number;
      theta: number;
      vega: number;
      iv: number;
    }> = [];

    let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0;

    for (let legIdx = 0; legIdx < legs.length; legIdx++) {
      const leg = legs[legIdx];
      const prices = legPriceMap.get(legIdx);
      const ltp = prices?.get(minuteKey) ?? 0;
      if (ltp <= 0) continue;

      const K = leg.strike;
      const type = leg.optionType;
      const sideMultiplier = leg.side === 'BUY' ? 1 : -1;
      const qty = leg.lots * (greeksMode === 'lot' ? lotSize : 1);

      let iv = impliedVolatility(ltp, spotPrice, K, T, 0.07, type);
      if (iv <= 0 || !isFinite(iv)) iv = 0.2;

      const g = blackScholes(spotPrice, K, T, 0.07, iv, type);
      const delta = g.delta * qty * sideMultiplier;
      const gamma = g.gamma * qty * sideMultiplier;
      const theta = g.theta * qty * sideMultiplier;
      const vega = g.vega * qty * sideMultiplier;

      netDelta += delta; netGamma += gamma; netTheta += theta; netVega += vega;

      legBreakdown.push({
        id: leg.id,
        strike: leg.strike,
        optionType: leg.optionType,
        side: leg.side,
        lots: leg.lots,
        delta,
        gamma,
        theta,
        vega,
        iv
      });
    }

    return {
      net: { delta: netDelta, gamma: netGamma, theta: netTheta, vega: netVega },
      legs: legBreakdown
    };
  }, [legs, lotSize, greeksMode, spotMap, legPriceMap, expiryTimeMs, activeExpiry]);

  useEffect(() => {
    if (!evalResult || !evalResult.underlyingBars || !evalResult.legPriceData || !activeExpiry) {
      setGreeksData(null);
      return;
    }

    // Time points in the basket
    const times = evalResult.basketPnlData?.map(d => d.time) || [];
    if (!times.length) {
      setGreeksData(null);
      return;
    }

    // Net points
    const netDelta: Array<{ time: number; value: number }> = [];
    const netGamma: Array<{ time: number; value: number }> = [];
    const netTheta: Array<{ time: number; value: number }> = [];
    const netVega: Array<{ time: number; value: number }> = [];

    // CE points
    const ceDelta: Array<{ time: number; value: number }> = [];
    const ceGamma: Array<{ time: number; value: number }> = [];
    const ceTheta: Array<{ time: number; value: number }> = [];
    const ceVega: Array<{ time: number; value: number }> = [];

    // PE points
    const peDelta: Array<{ time: number; value: number }> = [];
    const peGamma: Array<{ time: number; value: number }> = [];
    const peTheta: Array<{ time: number; value: number }> = [];
    const peVega: Array<{ time: number; value: number }> = [];

    for (const t of times) {
      const minuteKey = Math.floor(t / 60) * 60;
      const spotPrice = spotMap.get(minuteKey) || 0;
      if (spotPrice <= 0) continue;

      const barTimeMs = (t - IST_OFFSET) * 1000;
      const timeToExpiryMs = Math.max(0, expiryTimeMs - barTimeMs);
      const T = Math.max(timeToExpiryMs / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 60));

      let netD = 0, netG = 0, netT = 0, netV = 0;
      let ceD = 0, ceG = 0, ceT = 0, ceV = 0;
      let peD = 0, peG = 0, peT = 0, peV = 0;

      for (let legIdx = 0; legIdx < legs.length; legIdx++) {
        const leg = legs[legIdx];
        const prices = legPriceMap.get(legIdx);
        const ltp = prices?.get(minuteKey) ?? 0;
        if (ltp <= 0) continue;

        const K = leg.strike;
        const type = leg.optionType;
        const sideMultiplier = leg.side === 'BUY' ? 1 : -1;
        const qty = leg.lots * (greeksMode === 'lot' ? lotSize : 1);

        let iv = impliedVolatility(ltp, spotPrice, K, T, 0.07, type);
        if (iv <= 0 || !isFinite(iv)) iv = 0.2;

        const g = blackScholes(spotPrice, K, T, 0.07, iv, type);
        const d = g.delta * qty * sideMultiplier;
        const gm = g.gamma * qty * sideMultiplier;
        const th = g.theta * qty * sideMultiplier;
        const vg = g.vega * qty * sideMultiplier;

        netD += d; netG += gm; netT += th; netV += vg;
        if (type === 'CE') {
          ceD += d; ceG += gm; ceT += th; ceV += vg;
        } else {
          peD += d; peG += gm; peT += th; peV += vg;
        }
      }

      netDelta.push({ time: t, value: netD });
      netGamma.push({ time: t, value: netG });
      netTheta.push({ time: t, value: netT });
      netVega.push({ time: t, value: netV });

      ceDelta.push({ time: t, value: ceD });
      ceGamma.push({ time: t, value: ceG });
      ceTheta.push({ time: t, value: ceT });
      ceVega.push({ time: t, value: ceV });

      peDelta.push({ time: t, value: peD });
      peGamma.push({ time: t, value: peG });
      peTheta.push({ time: t, value: peT });
      peVega.push({ time: t, value: peV });
    }

    setGreeksData({
      net: { delta: netDelta, gamma: netGamma, theta: netTheta, vega: netVega },
      CE: { delta: ceDelta, gamma: ceGamma, theta: ceTheta, vega: ceVega },
      PE: { delta: peDelta, gamma: peGamma, theta: peTheta, vega: peVega }
    });
  }, [evalResult, legs, lotSize, activeExpiry, greeksMode, spotMap, legPriceMap, expiryTimeMs]);

  // ── Load chain ────────────────────────────────────────────────────────────

  const loadChain = useCallback(async (und: string, dt: string, tm: string, exp?: string) => {
    setChainLoading(true); setChainError(null);
    try {
      const qs = new URLSearchParams({ underlying: und, date: dt, time: tm });
      if (exp) qs.set('expiry', exp);
      const res = await fetch(`/api/nubra-backtest/chain?${qs}`);
      const data = await res.json() as ChainResponse;
      if (!data.ok) { setChainError(data.error || 'Failed to load chain.'); setChain([]); return; }
      setChain(data.chain);
      setSpot(data.spot);
      setAvailableExpiries(data.availableExpiries);
      setActiveExpiry(data.expiry);
      setActiveFlag(data.expiryFlag);
      if (!exp) setExpiry(data.expiry);
    } catch (e) {
      setChainError((e as Error).message); setChain([]);
    } finally {
      setChainLoading(false);
    }
  }, []);

  // Load on date / underlying / entry time change
  useEffect(() => {
    if (date) loadChain(underlying, date, entryTime);
  }, [underlying, date, entryTime, loadChain]);

  // Load on expiry change
  function switchExpiry(exp: string) {
    setExpiry(exp);
    loadChain(underlying, date, entryTime, exp);
  }

  // ── Leg CRUD ──────────────────────────────────────────────────────────────

  function addLeg(strike: number, optionType: 'CE' | 'PE', side: 'BUY' | 'SELL') {
    const row = chain.find(r => r.strike === strike);
    if (!row) return;
    const ltp = optionType === 'CE' ? row.ceLtp : row.peLtp;
    setLegs(prev => [...prev, { id: genId(), strike, optionType, side, lots: 1, ltp }]);
  }

  function removeLeg(id: string) { setLegs(prev => prev.filter(l => l.id !== id)); }
  function updateLeg(id: string, u: Partial<Leg>) { setLegs(prev => prev.map(l => l.id === id ? { ...l, ...u } : l)); }

  // ── Simulate ──────────────────────────────────────────────────────────────

  async function simulate() {
    if (!legs.length) return;
    setEvalLoading(true); setEvalError(null); setEvalResult(null);
    try {
      const res = await fetch('/api/nubra-backtest/evaluate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying, date, expiry: activeExpiry, expiryFlag: activeFlag,
          entryTime, exitTime,
          legs: legs.map(l => ({ strike: l.strike, optionType: l.optionType === 'CE' ? 'CALL' : 'PUT', side: l.side, lots: l.lots })),
          lotSize,
        }),
      });
      const data = await res.json() as EvalResponse;
      if (!data.ok) { setEvalError(data.error || 'Evaluation failed.'); return; }
      setEvalResult(data);
    } catch (e) {
      setEvalError((e as Error).message);
    } finally {
      setEvalLoading(false);
    }
  }

  // Re-simulate when entry/exit time changes and we already have a result
  async function resimulate(newEntry: string, newExit: string) {
    if (!legs.length || !evalResult) return;
    setEvalLoading(true); setEvalError(null);
    try {
      const res = await fetch('/api/nubra-backtest/evaluate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying, date, expiry: activeExpiry, expiryFlag: activeFlag,
          entryTime: newEntry, exitTime: newExit,
          legs: legs.map(l => ({ strike: l.strike, optionType: l.optionType === 'CE' ? 'CALL' : 'PUT', side: l.side, lots: l.lots })),
          lotSize,
        }),
      });
      const data = await res.json() as EvalResponse;
      if (!data.ok) { setEvalError(data.error || 'Re-evaluation failed.'); return; }
      setEvalResult(data);
    } catch (e) {
      setEvalError((e as Error).message);
    } finally {
      setEvalLoading(false);
    }
  }

function activeGreekSource(filter: Set<string>): 'net' | 'CE' | 'PE' {
  if (filter.has('CE')) return 'CE';
  if (filter.has('PE')) return 'PE';
  return 'net';
}

  // ── Lightweight Charts Synchronization & Lifecycle ─────────────────────────
  useEffect(() => {
    if (!evalResult) return;
    const isDark = theme === 'dark';
    const activeCharts: IChartApi[] = [];

    // 1. Create Price Chart if container is visible
    let priceChart: IChartApi | null = null;
    let indexSeries: any = null;
    const legPriceSeriesList: Array<{ legIndex: number; series: ISeriesApi<'Line'> }> = [];

    if (priceContainerRef.current) {
      priceChart = createChart(priceContainerRef.current, chartOpts(isDark));
      priceChartRef.current = priceChart;
      activeCharts.push(priceChart);

      // Index Line (NIFTY/SENSEX spot close)
      indexSeries = priceChart.addSeries(LineSeries, {
        priceScaleId: 'left',
        color: '#2962ff',
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
        visible: showSpotPrice,
      });
      const indexBars = evalResult.underlyingBars || [];
      const grid = indexBars.map(b => b.time);

      if (indexBars.length) {
        indexSeries.setData(indexBars.map(b => ({ time: b.time, value: b.close })) as any);
      }

      // Option leg prices (Colored green for CE, red for PE)
      if (evalResult.legPriceData) {
        evalResult.legPriceData.forEach((ld) => {
          const leg = legs[ld.legIndex];
          if (!leg) return;
          const color = leg.optionType === 'CE' ? '#22c55e' : '#ef4444';
          const s = priceChart!.addSeries(LineSeries, {
            priceScaleId: 'right',
            color, lineWidth: 1,
            title: `${leg.side === 'BUY' ? 'B' : 'S'} ${leg.strike} ${leg.optionType}`,
            lastValueVisible: true, priceLineVisible: false,
            visible: !hiddenLegPrices.has(ld.legIndex.toString()),
          });
          s.setData(padToGrid(grid, ld.data as any) as any);
          legPriceSeriesList.push({ legIndex: ld.legIndex, series: s });
        });
      }
    } else {
      priceChartRef.current = null;
    }

    // 2. Create P&L Chart if container is visible
    let pnlChart: IChartApi | null = null;
    let basketSeries: any = null;
    const legPnlSeriesList: Array<{ legIndex: number; series: ISeriesApi<'Line'> }> = [];

    if (pnlContainerRef.current) {
      pnlChart = createChart(pnlContainerRef.current, chartOpts(isDark));
      pnlChartRef.current = pnlChart;
      activeCharts.push(pnlChart);

      const indexBars = evalResult.underlyingBars || [];
      const grid = indexBars.map(b => b.time);

      // Total Basket P&L (White line, width 3)
      basketSeries = pnlChart.addSeries(LineSeries, {
        color: '#ffffff', lineWidth: 3,
        title: 'Total P&L', lastValueVisible: true, priceLineVisible: true,
        visible: showTotalPnl,
      });
      if (evalResult.basketPnlData) {
        basketSeries.setData(padToGrid(grid, evalResult.basketPnlData as any) as any);
      }

      // Leg P&Ls (Colored green for CE, red for PE)
      if (evalResult.legPnlData) {
        evalResult.legPnlData.forEach((ld) => {
          const leg = legs[ld.legIndex];
          if (!leg) return;
          const color = leg.optionType === 'CE' ? '#22c55e' : '#ef4444';
          const s = pnlChart!.addSeries(LineSeries, {
            color, lineWidth: 1,
            title: `${leg.side === 'BUY' ? 'B' : 'S'} ${leg.strike} ${leg.optionType}`,
            lastValueVisible: true, priceLineVisible: false,
            visible: !hiddenLegPnls.has(ld.legIndex.toString()),
          });
          s.setData(padToGrid(grid, ld.data as any) as any);
          legPnlSeriesList.push({ legIndex: ld.legIndex, series: s });
        });
      }
    } else {
      pnlChartRef.current = null;
    }

    // 3. Create Greeks Chart if container is visible and data is ready
    let greeksChart: IChartApi | null = null;
    const greeksSeriesMap: Record<string, ISeriesApi<'Line'>> = {};

    if (greeksVisible && greeksContainerRef.current && greeksData) {
      greeksChart = createChart(greeksContainerRef.current, chartOpts(isDark));
      greeksChartRef.current = greeksChart;
      activeCharts.push(greeksChart);

      const indexBars = evalResult.underlyingBars || [];
      const grid = indexBars.map(b => b.time);

      const gSources = ['net', 'CE', 'PE'] as const;
      const gKeys = ['delta', 'gamma', 'theta', 'vega'] as const;
      const gColors = { delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' };
      const gLineWidths = { net: 2, CE: 1, PE: 1 } as const;
      const gLineStyles = { net: 0, CE: 0, PE: 2 } as const;

      for (const src of gSources) {
        const srcVisible = greeksLegFilter.has(src);
        for (const k of gKeys) {
          const s = greeksChart.addSeries(LineSeries, {
            color: gColors[k],
            lineWidth: gLineWidths[src],
            lineStyle: gLineStyles[src],
            priceScaleId: k,
            title: src === 'net' ? k.charAt(0).toUpperCase() + k.slice(1) : `${src} ${k.charAt(0).toUpperCase() + k.slice(1)}`,
            lastValueVisible: true,
            priceLineVisible: false,
            visible: srcVisible && selectedGreeks.has(k),
          });
          const points = greeksData[src]?.[k] || [];
          s.setData(padToGrid(grid, points as any) as any);
          greeksSeriesMap[`${src}_${k}`] = s;
        }
      }
    } else {
      greeksChartRef.current = null;
    }

    setChartEpoch(e => e + 1);

    // Fit timescale layout
    activeCharts.forEach(c => c.timeScale().fitContent());

    const ro = new ResizeObserver((entries) => {
      try {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          if (entry.target === priceContainerRef.current) {
            priceChartRef.current?.resize(width, height);
          } else if (entry.target === pnlContainerRef.current) {
            pnlChartRef.current?.resize(width, height);
          } else if (entry.target === greeksContainerRef.current) {
            greeksChartRef.current?.resize(width, height);
          }
        }
      } catch (e) {}
    });

    if (priceContainerRef.current) ro.observe(priceContainerRef.current);
    if (pnlContainerRef.current) ro.observe(pnlContainerRef.current);
    if (greeksContainerRef.current) ro.observe(greeksContainerRef.current);

    const updateAllTooltips = (timeVal: number | null, x: number | null, activeChartY: number | null, currentActiveChart: 'price' | 'pnl' | 'greeks' | null) => {
      setActiveTime(timeVal);
      if (timeVal === null || x === null) {
        priceTooltipRef.current?.setVisibility(false);
        pnlTooltipRef.current?.setVisibility(false);
        greeksTooltipRef.current?.setVisibility(false);
        return null;
      }

      const timeStr = formatCrosshairTime(timeVal);
      const minuteKey = Math.floor(timeVal / 60) * 60;

      const findLatest = <T extends { time: any }>(arr: T[] | undefined, targetTime: number): T | undefined => {
        if (!arr || arr.length === 0) return undefined;
        let l = 0, r = arr.length - 1;
        let res: T | undefined = undefined;
        while (l <= r) {
          const m = (l + r) >> 1;
          const time = arr[m].time as number;
          if (time <= targetTime) {
            res = arr[m];
            l = m + 1;
          } else {
            r = m - 1;
          }
        }
        return res;
      };

      // 1. Price Tooltip Data
      const indexBars = evalResult.underlyingBars || [];
      const spotBar = findLatest(indexBars, timeVal);
      const spot = spotBar?.close ?? null;

      const priceLegs: Array<{ strike: number; optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; value: number }> = [];
      if (evalResult.legPriceData) {
        evalResult.legPriceData.forEach((ld) => {
          const leg = legs[ld.legIndex];
          if (!leg) return;
          const match = findLatest(ld.data, timeVal);
          if (match && match.value > 0) {
            priceLegs.push({
              strike: leg.strike,
              optionType: leg.optionType,
              side: leg.side,
              value: match.value,
            });
          }
        });
      }

      // 2. PNL Tooltip Data
      const pnlPoints = evalResult.basketPnlData || [];
      const pnlPoint = findLatest(pnlPoints, timeVal);
      const totalPnl = pnlPoint?.value ?? 0;

      const pnlLegs: Array<{ strike: number; optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; value: number }> = [];
      if (evalResult.legPnlData) {
        evalResult.legPnlData.forEach((ld) => {
          const leg = legs[ld.legIndex];
          if (!leg) return;
          const match = findLatest(ld.data, timeVal);
          if (match) {
            pnlLegs.push({
              strike: leg.strike,
              optionType: leg.optionType,
              side: leg.side,
              value: match.value,
            });
          }
        });
      }

      // 3. Greeks Tooltip Data
      let netG: { delta: number; gamma: number; theta: number; vega: number } | undefined;
      let ceG: { delta: number; gamma: number; theta: number; vega: number } | undefined;
      let peG: { delta: number; gamma: number; theta: number; vega: number } | undefined;
      
      let delta = 0; // fallback delta for syncing
      if (greeksData) {
        const getPts = (src: 'net' | 'CE' | 'PE') => {
          const dPt = findLatest(greeksData[src]?.delta, timeVal);
          const gPt = findLatest(greeksData[src]?.gamma, timeVal);
          const tPt = findLatest(greeksData[src]?.theta, timeVal);
          const vPt = findLatest(greeksData[src]?.vega, timeVal);
          return {
            delta: dPt?.value ?? 0,
            gamma: gPt?.value ?? 0,
            theta: tPt?.value ?? 0,
            vega: vPt?.value ?? 0
          };
        };

        if (greeksLegFilter.has('net')) {
          netG = getPts('net');
          delta = netG.delta;
        }
        if (greeksLegFilter.has('CE')) {
          ceG = getPts('CE');
          if (!netG) delta = ceG.delta;
        }
        if (greeksLegFilter.has('PE')) {
          peG = getPts('PE');
          if (!netG && !ceG) delta = peG.delta;
        }
      }

      const priceMappedLegs = priceLegs.map(leg => ({
        name: (leg.side === 'BUY' ? 'B ' : 'S ') + leg.strike + ' ' + leg.optionType,
        color: leg.optionType === 'CE' ? '#22c55e' : '#ef4444',
        value: leg.value
      }));
      priceTooltipRef.current?.setData(timeStr, spot ? { o: spot, h: spot, l: spot, c: spot } : null, priceMappedLegs, underlying);
      
      const pnlMappedLegs = pnlLegs.map(leg => ({
        name: (leg.side === 'BUY' ? 'B ' : 'S ') + leg.strike + ' ' + leg.optionType,
        color: leg.optionType === 'CE' ? '#22c55e' : '#ef4444',
        value: leg.value
      }));
      pnlTooltipRef.current?.setData(timeStr, { legs: pnlMappedLegs, total: totalPnl });

      greeksTooltipRef.current?.setData(timeStr, { net: netG, CE: ceG, PE: peG });

      const defaultY = 40;
      
      if (priceContainerRef.current && priceTooltipRef.current) {
        const w = priceContainerRef.current.clientWidth || 800;
        const h = priceContainerRef.current.clientHeight || 400;
        priceTooltipRef.current.setPosition(x > w * 0.5 ? x - 180 : x + 25, currentActiveChart === 'price' ? Math.max(8, Math.min((activeChartY ?? defaultY) - 80, h - 100)) : 8);
        priceTooltipRef.current.setVisibility(true);
      }
      if (pnlContainerRef.current && pnlTooltipRef.current) {
        const w = pnlContainerRef.current.clientWidth || 800;
        const h = pnlContainerRef.current.clientHeight || 400;
        pnlTooltipRef.current.setPosition(x > w * 0.5 ? x - 230 : x + 25, currentActiveChart === 'pnl' ? Math.max(8, Math.min((activeChartY ?? defaultY) - 80, h - 100)) : 8);
        pnlTooltipRef.current.setVisibility(true);
      }
      if (greeksContainerRef.current && greeksTooltipRef.current) {
        const w = greeksContainerRef.current.clientWidth || 800;
        const h = greeksContainerRef.current.clientHeight || 400;
        greeksTooltipRef.current.setPosition(x > w * 0.5 ? x - 180 : x + 25, currentActiveChart === 'greeks' ? Math.max(8, Math.min((activeChartY ?? defaultY) - 80, h - 100)) : 8);
        greeksTooltipRef.current.setVisibility(true);
      }

      return { spot, totalPnl, delta };
    };

    // ── Crosshair hover updates (Price Chart) ──
    if (priceChart && indexSeries) {
      priceChart.subscribeCrosshairMove((param) => {
        if (param.point && param.time != null) {
          setActiveChartType('price');
          const res = updateAllTooltips(param.time as number, param.point.x, param.point.y, 'price');
          if (res) {
            if (pnlChart && basketSeries) pnlChart.setCrosshairPosition(res.totalPnl, param.time, basketSeries);
            if (greeksChart) {
              const src = activeGreekSource(greeksLegFilter);
              const activeS = greeksSeriesMap[`${src}_delta`];
              if (activeS) greeksChart.setCrosshairPosition(res.delta, param.time, activeS);
            }
          }
        } else if (param.point === undefined && param.time !== undefined) {
          // Programmatic sync, ignore
        } else {
          setActiveChartType(null);
          updateAllTooltips(null, null, null, null);
          if (pnlChart) pnlChart.clearCrosshairPosition();
          if (greeksChart) greeksChart.clearCrosshairPosition();
        }
      });
    }

    // ── Crosshair hover updates (P&L Chart) ──
    if (pnlChart && basketSeries) {
      pnlChart.subscribeCrosshairMove((param) => {
        if (param.point && param.time != null) {
          setActiveChartType('pnl');
          const res = updateAllTooltips(param.time as number, param.point.x, param.point.y, 'pnl');
          if (res) {
            if (priceChart && indexSeries) priceChart.setCrosshairPosition(res.spot ?? 0, param.time, indexSeries);
            if (greeksChart) {
              const src = activeGreekSource(greeksLegFilter);
              const activeS = greeksSeriesMap[`${src}_delta`];
              if (activeS) greeksChart.setCrosshairPosition(res.delta, param.time, activeS);
            }
          }
        } else if (param.point === undefined && param.time !== undefined) {
          // Programmatic sync, ignore
        } else {
          setActiveChartType(null);
          updateAllTooltips(null, null, null, null);
          if (priceChart) priceChart.clearCrosshairPosition();
          if (greeksChart) greeksChart.clearCrosshairPosition();
        }
      });
    }

    // ── Crosshair hover updates (Greeks Chart) ──
    if (greeksChart) {
      greeksChart.subscribeCrosshairMove((param) => {
        if (param.point && param.time != null) {
          setActiveChartType('greeks');
          const res = updateAllTooltips(param.time as number, param.point.x, param.point.y, 'greeks');
          if (res) {
            if (priceChart && indexSeries) priceChart.setCrosshairPosition(res.spot ?? 0, param.time, indexSeries);
            if (pnlChart && basketSeries) pnlChart.setCrosshairPosition(res.totalPnl, param.time, basketSeries);
          }
        } else if (param.point === undefined && param.time !== undefined) {
          // Programmatic sync, ignore
        } else {
          setActiveChartType(null);
          updateAllTooltips(null, null, null, null);
          if (priceChart) priceChart.clearCrosshairPosition();
          if (pnlChart) pnlChart.clearCrosshairPosition();
        }
      });
    }

    // ── Sync Scroll & Zoom ──
    let syncing = false;
    const syncTimeScale = (sourceChart: IChartApi, targets: IChartApi[]) => {
      return (range: any) => {
        if (syncing || !range) return;
        syncing = true;
        for (const target of targets) {
          try { target.timeScale().setVisibleLogicalRange(range); } catch {}
        }
        syncing = false;
      };
    };

    if (priceChart && pnlChart) {
      const priceTargets = [pnlChart];
      if (greeksChart) priceTargets.push(greeksChart);

      const pnlTargets = [priceChart];
      if (greeksChart) pnlTargets.push(greeksChart);

      priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncTimeScale(priceChart, priceTargets));
      pnlChart.timeScale().subscribeVisibleLogicalRangeChange(syncTimeScale(pnlChart, pnlTargets));

      if (greeksChart) {
        const greeksTargets = [priceChart, pnlChart];
        greeksChart.timeScale().subscribeVisibleLogicalRangeChange(syncTimeScale(greeksChart, greeksTargets));
      }
    }

    return () => {
      ro.disconnect();
      priceChartRef.current = null;
      pnlChartRef.current = null;
      greeksChartRef.current = null;
      if (priceChart) try { priceChart.remove(); } catch {}
      if (pnlChart) try { pnlChart.remove(); } catch {}
      if (greeksChart) try { greeksChart.remove(); } catch {}
    };
  }, [evalResult, theme, greeksVisible, greeksData, chartsExpanded, showSpotPrice, hiddenLegPrices, showTotalPnl, hiddenLegPnls, selectedGreeks, greeksLegFilter]);

  // ── Computed ───────────────────────────────────────────────────────────────

  const payoffData = useMemo(() => {
    if (!legs.length) return [];
    const payoffLegs = legs.map(l => ({ strike: l.strike, type: l.optionType, side: l.side, qty: l.lots * lotSize, premium: l.ltp }));
    const strikes = payoffLegs.map(l => l.strike);
    const minS = Math.min(...strikes) * 0.90;
    const maxS = Math.max(...strikes) * 1.10;
    const step = (maxS - minS) / 200;
    return Array.from({ length: 201 }, (_, i) => {
      const s = minS + i * step;
      return { spot: Math.round(s), pnl: Math.round(payoffAtExpiry(s, payoffLegs) * 100) / 100 };
    });
  }, [legs, lotSize]);

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

  const totalPremium = useMemo(() => legs.reduce((acc, l) =>
    acc + (l.side === 'BUY' ? -1 : 1) * l.ltp * l.lots * lotSize, 0), [legs, lotSize]);

  // ── Resize handle ─────────────────────────────────────────────────────────

  const onDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX; const startW = leftWidth;
    const onMove = (ev: MouseEvent) => setLeftWidth(Math.max(320, Math.min(800, startW + (ev.clientX - startX))));
    const onUp = () => { setIsDragging(false); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    setIsDragging(true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [leftWidth]);

  const onPnlDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = pnlHeight;
    const totalH = chartsWrapperRef.current?.clientHeight ?? 600;
    const dividersH = greeksVisible ? 12 : 6;
    const maxCombined = totalH - 8 - dividersH - 120;
    const maxPnl = greeksVisible ? Math.max(80, maxCombined - greeksHeight) : maxCombined;

    const onMove = (ev: MouseEvent) => {
      setPnlHeight(Math.max(80, Math.min(maxPnl, startH - (ev.clientY - startY))));
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [pnlHeight, greeksHeight, greeksVisible]);

  const onGreeksDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = greeksHeight;
    const totalH = chartsWrapperRef.current?.clientHeight ?? 600;
    const dividersH = greeksVisible ? 12 : 6;
    const maxCombined = totalH - 8 - dividersH - 120;
    const maxGreeks = Math.max(80, maxCombined - pnlHeight);

    const onMove = (ev: MouseEvent) => {
      setGreeksHeight(Math.max(80, Math.min(maxGreeks, startH - (ev.clientY - startY))));
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [greeksHeight, pnlHeight, greeksVisible]);

  const onPositionsDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = positionsHeight;
    const onMove = (ev: MouseEvent) => setPositionsHeight(Math.max(40, startH - (ev.clientY - startY)));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [positionsHeight]);

  // ── No instrument selected ────────────────────────────────────────────────

  if (!instrument) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', fontSize: 14, background: 'var(--bg-primary)' }}>
        <span style={{ fontSize: 30, opacity: 0.5 }}>🕐</span>
        Select an F&O instrument to start manual backtesting
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isDark = theme === 'dark';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', overflow: 'hidden', fontVariantNumeric: 'tabular-nums' }}>
      {/* ── Top bar: date, times, underlying, expiry ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>Nubra Backtest</span>

        {/* Underlying toggle */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {['NIFTY', 'SENSEX'].map(u => (
            <button key={u} onClick={() => {
              setUnderlying(u);
              const popular: Record<string, Instrument> = {
                NIFTY: { stock_name: 'NIFTY 50', nubra_name: 'NIFTY', exchange: 'NSE', derivative_type: 'INDEX' },
                SENSEX: { stock_name: 'SENSEX', nubra_name: 'SENSEX', exchange: 'BSE', derivative_type: 'INDEX' },
              };
              if (popular[u]) {
                loadInstrumentInActivePane(popular[u]);
              }
            }}
              style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: underlying === u ? '#5865f2' : 'transparent', color: underlying === u ? '#fff' : 'var(--text-secondary)' }}>
              {u}
            </button>
          ))}
        </div>

        {underlying !== 'NIFTY' && underlying !== 'SENSEX' && (
          <span style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-hover)', color: 'var(--text-primary)' }}>
            Active: {underlying}
          </span>
        )}

        {/* Date picker */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Date</span>
          <input type="date" value={date} onChange={e => { setDate(e.target.value); setLegs([]); setEvalResult(null); }}
            style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
        </label>

        {/* Entry time */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Entry</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <input type="time" value={entryTime} onChange={e => {
              setEntryTime(e.target.value);
              if (evalResult) resimulate(e.target.value, exitTime);
            }}
              style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <button
                onClick={() => {
                  const next = adjustTime(entryTime, 1);
                  setEntryTime(next);
                  if (evalResult) resimulate(next, exitTime);
                }}
                style={{ border: 'none', background: 'var(--border)', color: 'var(--text-primary)', fontSize: 7, padding: '1px 3px', borderRadius: 2, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 10 }}
                title="+1 Minute"
              >
                ▲
              </button>
              <button
                onClick={() => {
                  const next = adjustTime(entryTime, -1);
                  setEntryTime(next);
                  if (evalResult) resimulate(next, exitTime);
                }}
                style={{ border: 'none', background: 'var(--border)', color: 'var(--text-primary)', fontSize: 7, padding: '1px 3px', borderRadius: 2, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 10 }}
                title="-1 Minute"
              >
                ▼
              </button>
            </div>
          </div>
        </label>

        {/* Exit time */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Exit</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <input type="time" value={exitTime} onChange={e => {
              setExitTime(e.target.value);
              if (evalResult) resimulate(entryTime, e.target.value);
            }}
              style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
              <button
                onClick={() => {
                  const next = adjustTime(exitTime, 1);
                  setExitTime(next);
                  if (evalResult) resimulate(entryTime, next);
                }}
                style={{ border: 'none', background: 'var(--border)', color: 'var(--text-primary)', fontSize: 7, padding: '1px 3px', borderRadius: 2, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 10 }}
                title="+1 Minute"
              >
                ▲
              </button>
              <button
                onClick={() => {
                  const next = adjustTime(exitTime, -1);
                  setExitTime(next);
                  if (evalResult) resimulate(entryTime, next);
                }}
                style={{ border: 'none', background: 'var(--border)', color: 'var(--text-primary)', fontSize: 7, padding: '1px 3px', borderRadius: 2, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', height: 10 }}
                title="-1 Minute"
              >
                ▼
              </button>
            </div>
          </div>
        </label>

        {/* Lot Size */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Lot Size</span>
          <input type="number" value={lotSize} onChange={e => setLotSize(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: 52, padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12, fontWeight: 600 }} />
        </label>

        {/* Expiry dropdown */}
        {availableExpiries.length > 0 && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Expiry</span>
            <select value={activeExpiry} onChange={e => switchExpiry(e.target.value)}
              style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }}>
              {availableExpiries.map(ae => (
                <option key={ae.expiry} value={ae.expiry}>{formatExpiry(ae.expiry)} ({ae.flag})</option>
              ))}
            </select>
          </label>
        )}

        {evalResult && (
          <>
            <div style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 4px' }} />
            
            <button
              onClick={() => setChartsExpanded(v => !v)}
              style={{
                padding: '3px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                border: '1px solid ' + (chartsExpanded ? 'var(--accent)' : 'var(--border)'),
                background: chartsExpanded ? 'rgba(88,101,242,0.15)' : 'transparent',
                color: chartsExpanded ? 'var(--accent)' : 'var(--text-secondary)',
                transition: 'all 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
              title={chartsExpanded ? 'Collapse charts' : 'Expand charts to full width'}
            >
              {chartsExpanded ? '⤡ Collapse' : '⤢ Expand'}
            </button>

            {/* Charts Split Dropdown */}
            <div ref={chartsPopupRef} className="relative flex items-stretch" style={{ height: 24 }}>
              <button
                onClick={() => setShowSpotPrice(s => !s)}
                style={{
                  padding: '0 8px',
                  borderRadius: '4px 0 0 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (showSpotPrice ? 'var(--accent)' : 'var(--border)'),
                  borderRight: 'none',
                  background: showSpotPrice ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: showSpotPrice ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                Charts
              </button>
              <button
                onClick={() => setChartsPopupOpen(o => !o)}
                style={{
                  padding: '0 4px',
                  borderRadius: '0 4px 4px 0',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (showSpotPrice ? 'var(--accent)' : 'var(--border)'),
                  borderLeft: 'none',
                  background: showSpotPrice ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: showSpotPrice ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                ▾
              </button>
              {chartsPopupOpen && (
                <div
                  className="absolute top-full left-0 mt-1 z-50 w-[220px] rounded-xl shadow-2xl border"
                  style={{
                    background: 'var(--bg-secondary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-[11px] font-semibold">Chart Layers</span>
                    <button onClick={() => setChartsPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                  </div>
                  <div className="px-3 py-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setShowSpotPrice(s => !s)}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                        showSpotPrice ? 'border-white/40 bg-white/10 text-white' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                      }`}
                      style={{ cursor: 'pointer' }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: showSpotPrice ? '#3b82f6' : 'transparent', border: '1px solid #3b82f6' }} />
                      {underlying} Spot
                    </button>
                    {legs.map((leg, idx) => {
                      const active = !hiddenLegPrices.has(idx.toString());
                      const color = leg.optionType === 'CE' ? '#22c55e' : '#ef4444';
                      return (
                        <button
                          key={leg.id}
                          onClick={() => setHiddenLegPrices(prev => {
                            const n = new Set(prev);
                            if (n.has(idx.toString())) n.delete(idx.toString());
                            else n.add(idx.toString());
                            return n;
                          })}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                            active ? 'border-white/20 bg-white/5 text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                          }`}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: active ? color : 'transparent', border: `1px solid ${color}` }} />
                          {leg.side === 'BUY' ? 'B' : 'S'} {leg.strike} {leg.optionType}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* P&L Split Dropdown */}
            <div ref={pnlPopupRef} className="relative flex items-stretch" style={{ height: 24 }}>
              <button
                onClick={() => setShowTotalPnl(s => !s)}
                style={{
                  padding: '0 8px',
                  borderRadius: '4px 0 0 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (showTotalPnl ? 'var(--accent)' : 'var(--border)'),
                  borderRight: 'none',
                  background: showTotalPnl ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: showTotalPnl ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                P&L
              </button>
              <button
                onClick={() => setPnlPopupOpen(o => !o)}
                style={{
                  padding: '0 4px',
                  borderRadius: '0 4px 4px 0',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (showTotalPnl ? 'var(--accent)' : 'var(--border)'),
                  borderLeft: 'none',
                  background: showTotalPnl ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: showTotalPnl ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                ▾
              </button>
              {pnlPopupOpen && (
                <div
                  className="absolute top-full left-0 mt-1 z-50 w-[220px] rounded-xl shadow-2xl border"
                  style={{
                    background: 'var(--bg-secondary)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                    <span className="text-[11px] font-semibold">P&amp;L Layers</span>
                    <button onClick={() => setPnlPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                  </div>
                  <div className="px-3 py-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setShowTotalPnl(s => !s)}
                      className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                        showTotalPnl ? 'border-white/40 bg-white/10 text-white' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                      }`}
                      style={{ cursor: 'pointer' }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: showTotalPnl ? '#ffffff' : 'transparent', border: '1px solid #ffffff' }} />
                      Total P&amp;L
                    </button>
                    {legs.map((leg, idx) => {
                      const active = !hiddenLegPnls.has(idx.toString());
                      const color = leg.optionType === 'CE' ? '#22c55e' : '#ef4444';
                      return (
                        <button
                          key={leg.id}
                          onClick={() => setHiddenLegPnls(prev => {
                            const n = new Set(prev);
                            if (n.has(idx.toString())) n.delete(idx.toString());
                            else n.add(idx.toString());
                            return n;
                          })}
                          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border ${
                            active ? 'border-white/20 bg-white/5 text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                          }`}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: active ? color : 'transparent', border: `1px solid ${color}` }} />
                          {leg.side === 'BUY' ? 'B' : 'S'} {leg.strike} {leg.optionType}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Greeks Split Dropdown */}
            <div ref={greeksPopupRef} className="relative flex items-stretch" style={{ height: 24 }}>
              <button
                onClick={() => setGreeksVisible(s => !s)}
                style={{
                  padding: '0 8px',
                  borderRadius: '4px 0 0 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (greeksVisible ? 'var(--accent)' : 'var(--border)'),
                  borderRight: 'none',
                  background: greeksVisible ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: greeksVisible ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                Greeks
              </button>
              <button
                onClick={() => setGreeksPopupOpen(o => !o)}
                style={{
                  padding: '0 4px',
                  borderRadius: '0 4px 4px 0',
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: '1px solid ' + (greeksVisible ? 'var(--accent)' : 'var(--border)'),
                  borderLeft: 'none',
                  background: greeksVisible ? 'rgba(88,101,242,0.15)' : 'transparent',
                  color: greeksVisible ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'all 0.15s',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                ▾
              </button>
              {greeksPopupOpen && (() => {
                const activeGreeks = ['delta', 'gamma', 'theta', 'vega'].filter(k => selectedGreeks.has(k));
                const targetT = activeTime || (evalResult?.basketPnlData && evalResult.basketPnlData.length > 0 ? evalResult.basketPnlData[evalResult.basketPnlData.length - 1].time : null);
                const breakdown = targetT ? getGreeksAtTime(targetT) : null;
                const netGreeks = breakdown?.net || { delta: 0, gamma: 0, theta: 0, vega: 0 };
                const fmtG = (v: number, key: string) => key === 'gamma' ? v.toFixed(4) : v.toFixed(2);
                return (
                  <div
                    className="absolute top-full right-0 mt-1 z-50 w-[280px] rounded-xl shadow-2xl border"
                    style={{
                      background: 'var(--bg-secondary)',
                      borderColor: 'var(--border)',
                      color: 'var(--text-primary)',
                    }}
                  >
                    <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                      <span className="text-[11px] font-semibold">Greeks Settings</span>
                      <button onClick={() => setGreeksPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>×</button>
                    </div>
                    {/* Unit / Lot toggle */}
                    <div className="px-3 py-2 flex items-center gap-2 border-b" style={{ borderColor: 'var(--border)' }}>
                      <div className="flex items-center bg-[var(--bg-primary)] rounded overflow-hidden border" style={{ borderColor: 'var(--border)' }}>
                        <button
                          onClick={() => setGreeksMode('unit')}
                          style={{ border: 'none', cursor: 'pointer' }}
                          className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${greeksMode === 'unit' ? 'bg-[#a78bfa]/20 text-[#a78bfa]' : 'text-[var(--text-muted)]'}`}
                        >
                          1 Unit
                        </button>
                        <button
                          onClick={() => setGreeksMode('lot')}
                          style={{ border: 'none', cursor: 'pointer' }}
                          className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${greeksMode === 'lot' ? 'bg-[#a78bfa]/20 text-[#a78bfa]' : 'text-[var(--text-muted)]'}`}
                        >
                          1 Lot
                        </button>
                      </div>
                      {greeksMode === 'lot' && (
                        <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                          <span>Lot Size:</span>
                          <span className="text-[var(--text-primary)] font-semibold">{lotSize}</span>
                        </div>
                      )}
                    </div>
                    {/* Greek selectors */}
                    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                      <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1.5">GREEKS</div>
                      <div className="flex items-center gap-1">
                        {['delta', 'gamma', 'theta', 'vega'].map(k => {
                          const gColors: Record<string, string> = { delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' };
                          const active = selectedGreeks.has(k);
                          return (
                            <button
                              key={k}
                              onClick={() => setSelectedGreeks(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                                active ? `border-transparent text-white` : 'border-[var(--border)] text-[var(--text-muted)]'
                              }`}
                              style={active ? { backgroundColor: gColors[k] + '33', color: gColors[k], borderColor: gColors[k] + '55', cursor: 'pointer' } : { cursor: 'pointer' }}
                            >
                              {k.charAt(0).toUpperCase() + k.slice(1)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {/* Source filter: Net / CE / PE */}
                    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                      <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1.5">SHOW IN CHART</div>
                      <div className="flex items-center gap-1">
                        {['net', 'CE', 'PE'].map(src => (
                          <button
                            key={src}
                            onClick={() => setGreeksLegFilter(prev => { const n = new Set(prev); if (n.has(src)) n.delete(src); else n.add(src); return n; })}
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                              greeksLegFilter.has(src) ? 'border-[#a78bfa]/40 bg-[#a78bfa]/15 text-[#a78bfa]' : 'border-[var(--border)] text-[var(--text-muted)]'
                            }`}
                            style={{ cursor: 'pointer' }}
                          >
                            {src === 'net' ? 'Net' : `${src} Leg`}
                            {src !== 'net' && <span className="ml-1 text-[8px] text-[var(--text-muted)]">{src === 'CE' ? '━━' : '╌╌'}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Net Greeks values */}
                    <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                      <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1">NET GREEKS</div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                        {activeGreeks.map(k => (
                          <div key={k} className="flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: ({ delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' } as any)[k] }} />
                            <span className="text-[var(--text-muted)] text-[10px]">{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                            <span className={`font-semibold tabular-nums ${(netGreeks as any)[k] >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{(netGreeks as any)[k] >= 0 ? '+' : ''}{fmtG((netGreeks as any)[k], k)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    {/* Leg breakdown */}
                    <div className="px-3 py-1.5">
                      <button
                        onClick={() => setGreeksExpanded(v => !v)}
                        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1"
                        style={{ background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        <span className="text-[8px]">{greeksExpanded ? '▾' : '▸'}</span> Leg breakdown
                      </button>
                      {greeksExpanded && (
                        <div className="mt-1.5 grid gap-0 text-[10px]" style={{ gridTemplateColumns: `20px 1fr ${activeGreeks.map(() => '48px').join(' ')} 40px` }}>
                          <span className="text-[var(--text-muted)] font-semibold py-0.5">B/S</span>
                          <span className="text-[var(--text-muted)] font-semibold py-0.5">Instrument</span>
                          {activeGreeks.map(k => <span key={k} className="text-[var(--text-muted)] font-semibold py-0.5 text-right">{k.charAt(0).toUpperCase() + k.slice(1)}</span>)}
                          <span className="text-[var(--text-muted)] font-semibold py-0.5 text-right">IV%</span>
                          {breakdown?.legs.map(p => {
                            const side = p.side;
                            const metaColor = p.optionType === 'CE' ? '#22c55e' : '#ef4444';
                            return (
                              <>
                                <span className={`py-0.5 font-bold text-[9px] ${side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{side === 'BUY' ? 'B' : 'S'}</span>
                                <span className="py-0.5 text-[var(--text-primary)] flex items-center gap-1 truncate">
                                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: metaColor }} />
                                  {p.strike} {p.optionType}
                                </span>
                                {activeGreeks.map(k => {
                                  const val = (p as any)[k];
                                  return <span key={k} className={`py-0.5 text-right tabular-nums font-medium ${val >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{val >= 0 ? '+' : ''}{fmtG(val, k)}</span>;
                                })}
                                <span className="py-0.5 text-right tabular-nums text-[var(--text-secondary)]">{(p.iv * 100).toFixed(1)}%</span>
                              </>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          {spot > 0 && (
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
              {underlying} {spot.toLocaleString('en-IN')}
            </span>
          )}
          {evalResult && (
            <span style={{ fontSize: 12, fontWeight: 600, color: evalResult.grossPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
              Gross P&L: {evalResult.grossPnl >= 0 ? '+' : ''}₹{fmtPrice(evalResult.grossPnl)}
            </span>
          )}
        </div>
      </div>

      {/* ── Main content ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* LEFT: Legs + chain */}
        {!chartsExpanded && (
          <div style={{ width: leftWidth, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {/* Legs section */}
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Legs ({legs.length})</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>Click chain rows to add</span>
            </div>

            {legs.length === 0 ? (
              <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                Click on CE/PE prices in the chain below to add legs
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '30px 58px 60px 30px 68px 52px 24px', alignItems: 'center', gap: 2, padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  <span>B/S</span><span>Strike</span><span>LTP</span><span>Type</span><span>Qty</span><span>Prem</span><span></span>
                </div>
                {legs.map(leg => {
                  const prem = (leg.side === 'BUY' ? -1 : 1) * leg.ltp * leg.lots * lotSize;
                  return (
                    <div key={leg.id} style={{ display: 'grid', gridTemplateColumns: '30px 58px 60px 30px 68px 52px 24px', alignItems: 'center', gap: 2, padding: '5px 0', borderBottom: '1px solid var(--bg-card)' }}>
                      <button onClick={() => updateLeg(leg.id, { side: leg.side === 'BUY' ? 'SELL' : 'BUY' })}
                        style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 11,
                          background: leg.side === 'BUY' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>
                        {leg.side === 'BUY' ? 'B' : 'S'}
                      </button>
                      <span style={{ fontWeight: 600, fontSize: 11 }}>{leg.strike.toLocaleString('en-IN')}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{leg.ltp.toFixed(2)}</span>
                      <button onClick={() => updateLeg(leg.id, { optionType: leg.optionType === 'CE' ? 'PE' : 'CE' })}
                        style={{ width: 26, height: 22, borderRadius: 4, border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: 10,
                          background: leg.optionType === 'CE' ? 'var(--green-dim)' : 'var(--red-dim)', color: leg.optionType === 'CE' ? 'var(--green)' : 'var(--red)' }}>
                        {leg.optionType}
                      </button>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <button onClick={() => updateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                          style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
                        <span style={{ fontSize: 11, fontWeight: 600, flex: 1, textAlign: 'center' }}>{leg.lots * lotSize}</span>
                        <button onClick={() => updateLeg(leg.id, { lots: leg.lots + 1 })}
                          style={{ width: 18, height: 18, borderRadius: 3, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
                      </div>
                      <span style={{ fontSize: 10, color: prem >= 0 ? 'var(--green)' : 'var(--red)' }}>{inr(prem)}</span>
                      <button onClick={() => removeLeg(leg.id)}
                        style={{ width: 22, height: 22, borderRadius: 4, border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--red-dim)'; e.currentTarget.style.color = 'var(--red)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
                        ✕
                      </button>
                    </div>
                  );
                })}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)', marginTop: 4 }}>
                  <div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Net Premium: </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: totalPremium >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {totalPremium >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPremium))}
                    </span>
                  </div>
                </div>
                <button onClick={simulate} disabled={evalLoading || !legs.length}
                  style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: '#5865f2', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: evalLoading || !legs.length ? 0.5 : 1, marginTop: 6 }}>
                  {evalLoading ? 'Simulating…' : '▶ Simulate'}
                </button>
                {evalError && <div style={{ marginTop: 6, padding: '6px 10px', borderRadius: 6, background: 'var(--red-dim)', color: 'var(--red)', fontSize: 11 }}>{evalError}</div>}
              </>
            )}
          </div>

          {/* Historical Option Chain */}
          <div style={{ flex: 1, overflow: 'auto', padding: '0 4px' }}>
            {chainLoading && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Loading historical chain…</div>
            )}
            {chainError && (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--red)', fontSize: 12 }}>{chainError}</div>
            )}
            {!chainLoading && !chainError && chain.length > 0 && (
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 2 }}>
                  <tr>
                    {['OI', 'Vol', 'IV', 'CE LTP', 'Strike', 'PE LTP', 'IV', 'Vol', 'OI'].map(h => (
                      <th key={h} style={{ padding: '6px 4px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 500, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontSize: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chain.map(row => {
                    const isAtm = row.strike === closestStrike;
                    return (
                      <tr key={row.strike} ref={isAtm ? atmRowRef : undefined} style={{ borderBottom: '1px solid var(--bg-card)', background: isAtm ? 'rgba(88,101,242,0.08)' : undefined }}>
                        <td style={{ padding: '4px 3px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{row.ceOi ? (row.ceOi / 1000).toFixed(0) + 'K' : '—'}</td>
                        <td style={{ padding: '4px 3px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{row.ceVol ? (row.ceVol / 1000).toFixed(0) + 'K' : '—'}</td>
                        <td style={{ padding: '4px 3px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{row.ceIv > 0 ? (row.ceIv * 100).toFixed(2) + '%' : '—'}</td>
                        <td style={{ padding: '4px 3px', textAlign: 'right', cursor: 'pointer' }}
                          onClick={() => addLeg(row.strike, 'CE', 'SELL')}
                          onContextMenu={e => { e.preventDefault(); addLeg(row.strike, 'CE', 'BUY'); }}
                          title="Left-click: SELL  |  Right-click: BUY">
                          <span style={{ color: 'var(--green)', fontWeight: 500 }}>{row.ceLtp > 0 ? row.ceLtp.toFixed(2) : '—'}</span>
                        </td>
                        <td style={{ padding: '4px 6px', textAlign: 'center', fontWeight: 700, fontSize: 11, color: isAtm ? '#5865f2' : 'var(--text-primary)', background: isAtm ? 'rgba(88,101,242,0.05)' : undefined }}>
                          {row.strike.toLocaleString('en-IN')}
                        </td>
                        <td style={{ padding: '4px 3px', textAlign: 'left', cursor: 'pointer' }}
                          onClick={() => addLeg(row.strike, 'PE', 'SELL')}
                          onContextMenu={e => { e.preventDefault(); addLeg(row.strike, 'PE', 'BUY'); }}
                          title="Left-click: SELL  |  Right-click: BUY">
                          <span style={{ color: 'var(--red)', fontWeight: 500 }}>{row.peLtp > 0 ? row.peLtp.toFixed(2) : '—'}</span>
                        </td>
                        <td style={{ padding: '4px 3px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10 }}>{row.peIv > 0 ? (row.peIv * 100).toFixed(2) + '%' : '—'}</td>
                        <td style={{ padding: '4px 3px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10 }}>{row.peVol ? (row.peVol / 1000).toFixed(0) + 'K' : '—'}</td>
                        <td style={{ padding: '4px 3px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10 }}>{row.peOi ? (row.peOi / 1000).toFixed(0) + 'K' : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {!chainLoading && !chainError && chain.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                Select a date to load the historical option chain.
              </div>
            )}
          </div>
        </div>
      )}

        {/* RESIZE HANDLE */}
        {!chartsExpanded && (
          <div onMouseDown={onDrag}
            style={{ width: 5, cursor: 'col-resize', background: isDragging ? '#5865f2' : 'var(--border)', flexShrink: 0, transition: isDragging ? 'none' : 'background 0.15s' }}
            onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = '#5865f2'; }}
            onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'var(--border)'; }}
          />
        )}

        {/* RIGHT: Payoff + Results */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>


          {/* Payoff chart - Only show pre-simulation or when evalResult is not loaded yet */}
          {legs.length > 0 && payoffData.length > 0 && !evalResult && (
            <div style={{ height: 200, padding: '8px 8px 0', flexShrink: 0, borderBottom: '1px solid var(--border)' }}>
              <SvgChart
                data={payoffData}
                xKey="spot"
                series={[{ dataKey: 'pnl', color: '#22c55e', fill: 'rgba(34,197,94,0.15)' }]}
                refLines={[
                  { axis: 'y', value: 0, color: '#2a2d42' },
                  ...(spot ? [{ axis: 'x' as const, value: spot, color: '#5865f2', dashed: true, label: spot.toLocaleString('en-IN'), labelColor: '#5865f2' }] : []),
                ]}
                xFormatter={v => v.toLocaleString('en-IN')}
                yFormatter={v => `₹${Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'K' : String(v)}`}
                tooltipFormatter={d => `Spot: ${d.spot.toLocaleString('en-IN')}\nP&L: ₹${fmtPrice(d.pnl)}`}
                legendLabels={{ pnl: 'P&L at expiry' }}
              />
            </div>
          )}

          {/* Simulation result: Synced Lightweight Charts */}
          {evalResult && (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div ref={chartsWrapperRef} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '4px', gap: 0 }}>
                {/* Price Chart Container */}
                <div style={{
                  flex: 1,
                  minHeight: 120,
                  position: 'relative',
                  borderBottom: '1px solid var(--border)'
                }}>
                  <div ref={priceContainerRef} style={{ width: '100%', height: '100%' }} />

                  <PriceTooltip ref={priceTooltipRef} />
                </div>

                {/* Divider 1: Price / PNL */}
                <div
                  onMouseDown={onPnlDividerDown}
                  style={{ height: 6, cursor: 'row-resize', background: 'var(--border)', flexShrink: 0, zIndex: 10 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#5865f2'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
                />

                {/* P&L Chart Container */}
                <div style={{
                  height: pnlHeight,
                  minHeight: 80,
                  position: 'relative',
                  borderBottom: greeksVisible ? '1px solid var(--border)' : 'none',
                  flexShrink: 0
                }}>
                  <div ref={pnlContainerRef} style={{ width: '100%', height: '100%' }} />

                  <PnlTooltip ref={pnlTooltipRef} strategyMargin={0} />
                </div>

                {/* Divider 2: PNL / Greeks */}
                {greeksVisible && (
                  <div
                    onMouseDown={onGreeksDividerDown}
                    style={{ height: 6, cursor: 'row-resize', background: 'var(--border)', flexShrink: 0, zIndex: 10 }}
                    onMouseEnter={e => e.currentTarget.style.background = '#5865f2'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
                  />
                )}

                {/* Greeks Chart Container */}
                <div style={{
                  height: greeksHeight,
                  minHeight: 80,
                  position: 'relative',
                  display: greeksVisible ? 'block' : 'none',
                  flexShrink: 0
                }}>
                  <div ref={greeksContainerRef} style={{ width: '100%', height: '100%' }} />

                  <GreeksTooltip ref={greeksTooltipRef} selectedGreeks={selectedGreeks} greeksLegFilter={greeksLegFilter} colors={{ delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' }} />
                </div>
              </div>

              {/* Divider 3: Charts / Positions */}
              {!chartsExpanded && (
                <div
                  onMouseDown={onPositionsDividerDown}
                  style={{ height: 6, cursor: 'row-resize', background: 'var(--border)', flexShrink: 0, zIndex: 10 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#5865f2'}
                  onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
                />
              )}

              {/* Simulated Positions Table */}
              {!chartsExpanded && (
                <div style={{ flexShrink: 0, height: positionsCollapsed ? 28 : positionsHeight, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                  <div style={{ height: 28, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: '0 12px', userSelect: 'none' }}>
                    <button
                      onClick={() => setPositionsCollapsed(v => !v)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginRight: 6, padding: 0, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14 }}
                    >
                      {positionsCollapsed ? '▲' : '▼'}
                    </button>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>Simulated Positions</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                      Strategy P&L: <span style={{ fontWeight: 700, color: evalResult.grossPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{evalResult.grossPnl >= 0 ? '+' : ''}₹{fmtPrice(evalResult.grossPnl)}</span>
                    </span>
                  </div>
                  {!positionsCollapsed && (
                    <div style={{ flex: 1, overflow: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-secondary)', zIndex: 10 }}>
                          <tr style={{ color: 'var(--text-muted)' }}>
                            {['Symbol', 'Product', 'Side', 'Qty', 'Entry Price', 'Exit Price', 'P&L', 'P&L %', 'Entry Time', 'Exit Time'].map(h => (
                              <th key={h} style={{ padding: '6px 12px', fontWeight: 500, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {evalResult.legs.map((l, i) => {
                            const side = l.side;
                            const pnl = l.pnl;
                            const pnlPct = l.entryPrice > 0 ? ((l.exitPrice - l.entryPrice) / l.entryPrice * 100 * (side === 'BUY' ? 1 : -1)) : 0;
                            const color = l.optionType === 'CALL' || l.optionType === 'CE' ? '#22c55e' : '#ef4444';
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid var(--border)/50', background: 'var(--bg-primary)', height: 28 }}>
                                <td style={{ padding: '4px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', backgroundColor: color }} />
                                    {underlying} {l.strike} {l.optionType === 'CALL' ? 'CE' : 'PE'}
                                  </span>
                                </td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>NRML</td>
                                <td style={{ padding: '4px 12px', fontWeight: 700, color: side === 'BUY' ? 'var(--green)' : 'var(--red)' }}>{side}</td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>{l.lots * lotSize}</td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>₹{l.entryPrice.toFixed(2)}</td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>₹{l.exitPrice.toFixed(2)}</td>
                                <td style={{ padding: '4px 12px', fontWeight: 600, color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                  {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                                </td>
                                <td style={{ padding: '4px 12px', color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                  {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                                </td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>{entryTime}</td>
                                <td style={{ padding: '4px 12px', color: 'var(--text-secondary)' }}>{exitTime}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Empty state - pre-configuration */}
          {!evalResult && legs.length === 0 && (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--text-muted)' }}>
              <svg viewBox="0 0 300 140" style={{ width: 280, height: 140, opacity: 0.5 }}>
                <defs>
                  <linearGradient id="nbGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity={0.3} /><stop offset="100%" stopColor="#22c55e" stopOpacity={0} /></linearGradient>
                </defs>
                <path d="M0,120 L30,100 L60,110 L90,70 L120,80 L150,40 L180,50 L210,30 L240,25 L270,20 L300,18" fill="none" stroke="#22c55e" strokeWidth="2" />
                <path d="M0,120 L30,100 L60,110 L90,70 L120,80 L150,40 L180,50 L210,30 L240,25 L270,20 L300,18 L300,140 L0,140 Z" fill="url(#nbGreen)" />
                <line x1="0" y1="90" x2="300" y2="90" stroke="#2a2d42" strokeWidth="0.5" strokeDasharray="4 4" />
              </svg>
              <div style={{ fontSize: 16, fontWeight: 700 }}>Manual Historical Backtest</div>
              <div style={{ fontSize: 12, maxWidth: 300, textAlign: 'center', lineHeight: 1.5 }}>
                Pick a date, click on CE/PE prices in the chain to add legs, then simulate to see what would have happened.
              </div>
              <div style={{ fontSize: 10, opacity: 0.7 }}>Left-click: SELL  |  Right-click: BUY</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
