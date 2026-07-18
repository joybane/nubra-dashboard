import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createChart, LineSeries, CandlestickSeries, CrosshairMode } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import SvgChart from './components/SvgChart';
import type { Instrument } from './types';
import { payoffAtExpiry } from './lib/GexService';
import { fmtPrice } from './lib/utils';

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
  // Config state
  const [underlying, setUnderlying] = useState<'NIFTY' | 'SENSEX'>('NIFTY');
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
  const [hoverPriceData, setHoverPriceData] = useState<{
    timeStr: string;
    spot: number | null;
    legs: Array<{ strike: number; optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; value: number }>;
  } | null>(null);

  const [hoverPnlData, setHoverPnlData] = useState<{
    timeStr: string;
    total: number;
    legs: Array<{ strike: number; optionType: 'CE' | 'PE'; side: 'BUY' | 'SELL'; value: number }>;
  } | null>(null);

  // Refs for lightweight-charts
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const pnlContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const pnlChartRef = useRef<IChartApi | null>(null);
  const [chartEpoch, setChartEpoch] = useState(0);

  // Layout
  const [leftWidth, setLeftWidth] = useState(480);
  const [isDragging, setIsDragging] = useState(false);

  // Lot Size State
  const [lotSize, setLotSize] = useState(65);

  // Sync lot default value when underlying changes
  useEffect(() => {
    setLotSize(DEFAULT_LOT[underlying] ?? 65);
  }, [underlying]);

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
    const sym = (instrument.symbol ?? instrument.asset ?? instrument.display_name ?? '').toUpperCase();
    if (sym.includes('SENSEX')) setUnderlying('SENSEX');
    else setUnderlying('NIFTY');
  }, [instrument]);

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

  // ── Lightweight Charts Synchronization & Lifecycle ─────────────────────────
  useEffect(() => {
    if (!evalResult || !priceContainerRef.current || !pnlContainerRef.current) return;
    const isDark = theme === 'dark';

    // 1. Create Price Chart
    const priceChart = createChart(priceContainerRef.current, chartOpts(isDark));
    priceChartRef.current = priceChart;

    // 2. Create P&L Chart
    const pnlChart = createChart(pnlContainerRef.current, chartOpts(isDark));
    pnlChartRef.current = pnlChart;

    setChartEpoch(e => e + 1);

    // ── Price Series ──
    // Index Candles (NIFTY/SENSEX spot close)
    const indexSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: '#26a69a', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });

    const indexBars = evalResult.underlyingBars || [];
    if (indexBars.length) {
      indexSeries.setData(indexBars as any);
    }

    // Option leg prices
    const legPriceSeriesList: Array<{ legIndex: number; series: ISeriesApi<'Line'> }> = [];
    if (evalResult.legPriceData) {
      evalResult.legPriceData.forEach((ld) => {
        const leg = legs[ld.legIndex];
        if (!leg) return;
        const color = LEG_COLORS[ld.legIndex % LEG_COLORS.length];
        const s = priceChart.addSeries(LineSeries, {
          color, lineWidth: 1,
          title: `${leg.side === 'BUY' ? 'B' : 'S'} ${leg.strike} ${leg.optionType}`,
          lastValueVisible: true, priceLineVisible: false,
        });
        s.setData(ld.data as any);
        legPriceSeriesList.push({ legIndex: ld.legIndex, series: s });
      });
    }

    // ── P&L Series ──
    // Total Basket P&L
    const basketSeries = pnlChart.addSeries(LineSeries, {
      color: isDark ? '#ffffff' : '#111827', lineWidth: 3,
      title: 'Total P&L', lastValueVisible: true, priceLineVisible: true,
    });
    if (evalResult.basketPnlData) {
      basketSeries.setData(evalResult.basketPnlData as any);
    }

    // Leg P&Ls
    const legPnlSeriesList: Array<{ legIndex: number; series: ISeriesApi<'Line'> }> = [];
    if (evalResult.legPnlData) {
      evalResult.legPnlData.forEach((ld) => {
        const leg = legs[ld.legIndex];
        if (!leg) return;
        const color = LEG_COLORS[ld.legIndex % LEG_COLORS.length];
        const s = pnlChart.addSeries(LineSeries, {
          color, lineWidth: 1,
          title: `${leg.side === 'BUY' ? 'B' : 'S'} ${leg.strike} ${leg.optionType}`,
          lastValueVisible: true, priceLineVisible: false,
        });
        s.setData(ld.data as any);
        legPnlSeriesList.push({ legIndex: ld.legIndex, series: s });
      });
    }

    // Fit timescale layout
    priceChart.timeScale().fitContent();
    pnlChart.timeScale().fitContent();

    // ── Resize observer ──
    const handleResize = () => {
      if (priceContainerRef.current && priceChartRef.current) {
        const { width, height } = priceContainerRef.current.getBoundingClientRect();
        priceChartRef.current.resize(width, height);
      }
      if (pnlContainerRef.current && pnlChartRef.current) {
        const { width, height } = pnlContainerRef.current.getBoundingClientRect();
        pnlChartRef.current.resize(width, height);
      }
    };
    const observer = new ResizeObserver(handleResize);
    if (priceContainerRef.current) observer.observe(priceContainerRef.current);
    if (pnlContainerRef.current) observer.observe(pnlContainerRef.current);

    // ── Crosshair hover updates (Price Chart) ──
    priceChart.subscribeCrosshairMove((param) => {
      if (param.point && param.time != null) {
        const timeVal = param.time as number;
        const timeStr = formatCrosshairTime(timeVal);

        const indexVal = param.seriesData.get(indexSeries) as { close?: number } | undefined;
        const spot = indexVal?.close ?? null;

        const legsData = legPriceSeriesList.map(({ legIndex, series }) => {
          const leg = legs[legIndex];
          const val = param.seriesData.get(series) as { value?: number } | undefined;
          return {
            strike: leg.strike,
            optionType: leg.optionType,
            side: leg.side,
            value: val?.value ?? 0
          };
        }).filter(x => x.value > 0);

        setHoverPriceData({ timeStr, spot, legs: legsData });
      } else {
        setHoverPriceData(null);
      }
    });

    // ── Crosshair hover updates (P&L Chart) ──
    pnlChart.subscribeCrosshairMove((param) => {
      if (param.point && param.time != null) {
        const timeVal = param.time as number;
        const timeStr = formatCrosshairTime(timeVal);

        const basketVal = param.seriesData.get(basketSeries) as { value?: number } | undefined;
        const total = basketVal?.value ?? 0;

        const legsData = legPnlSeriesList.map(({ legIndex, series }) => {
          const leg = legs[legIndex];
          const val = param.seriesData.get(series) as { value?: number } | undefined;
          return {
            strike: leg.strike,
            optionType: leg.optionType,
            side: leg.side,
            value: val?.value ?? 0
          };
        });

        setHoverPnlData({ timeStr, total, legs: legsData });
      } else {
        setHoverPnlData(null);
      }
    });

    // ── Sync Scroll & Zoom ──
    let syncing = false;
    const syncPriceToPnl = (range: any) => {
      if (syncing || !range) return;
      syncing = true;
      try { pnlChart.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing = false;
    };
    const syncPnlToPrice = (range: any) => {
      if (syncing || !range) return;
      syncing = true;
      try { priceChart.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing = false;
    };
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(syncPriceToPnl);
    pnlChart.timeScale().subscribeVisibleLogicalRangeChange(syncPnlToPrice);

    return () => {
      observer.disconnect();
      priceChart.remove();
      pnlChart.remove();
      priceChartRef.current = null;
      pnlChartRef.current = null;
    };
  }, [evalResult, theme]);

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', overflow: 'hidden', fontVariantNumeric: 'tabular-nums' }}>
      {/* ── Top bar: date, times, underlying, expiry ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', flexShrink: 0, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>Nubra Backtest</span>

        {/* Underlying toggle */}
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
          {(['NIFTY', 'SENSEX'] as const).map(u => (
            <button key={u} onClick={() => setUnderlying(u)}
              style={{ padding: '4px 12px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: underlying === u ? '#5865f2' : 'transparent', color: underlying === u ? '#fff' : 'var(--text-secondary)' }}>
              {u}
            </button>
          ))}
        </div>

        {/* Date picker */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Date</span>
          <input type="date" value={date} onChange={e => { setDate(e.target.value); setLegs([]); setEvalResult(null); }}
            style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
        </label>

        {/* Entry time */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Entry</span>
          <input type="time" value={entryTime} onChange={e => {
            setEntryTime(e.target.value);
            if (evalResult) resimulate(e.target.value, exitTime);
          }}
            style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
        </label>

        {/* Exit time */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>Exit</span>
          <input type="time" value={exitTime} onChange={e => {
            setExitTime(e.target.value);
            if (evalResult) resimulate(entryTime, e.target.value);
          }}
            style={{ padding: '4px 8px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 12 }} />
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

        {/* Spot */}
        {spot > 0 && (
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)', marginLeft: 'auto' }}>
            {underlying} {spot.toLocaleString('en-IN')}
          </span>
        )}
      </div>

      {/* ── Main content ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* LEFT: Legs + chain */}
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
                        <td style={{ padding: '4px 3px', textAlign: 'right', color: 'var(--text-muted)', fontSize: 10 }}>{row.ceIv > 0 ? row.ceIv.toFixed(1) : '—'}</td>
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
                        <td style={{ padding: '4px 3px', textAlign: 'left', color: 'var(--text-muted)', fontSize: 10 }}>{row.peIv > 0 ? row.peIv.toFixed(1) : '—'}</td>
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

        {/* RESIZE HANDLE */}
        <div onMouseDown={onDrag}
          style={{ width: 5, cursor: 'col-resize', background: isDragging ? '#5865f2' : 'var(--border)', flexShrink: 0, transition: isDragging ? 'none' : 'background 0.15s' }}
          onMouseEnter={e => { if (!isDragging) e.currentTarget.style.background = '#5865f2'; }}
          onMouseLeave={e => { if (!isDragging) e.currentTarget.style.background = 'var(--border)'; }}
        />

        {/* RIGHT: Payoff + Results */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Summary strip */}
          {legs.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: '12px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Max Profit</div><div style={{ fontSize: 14, fontWeight: 700, color: 'var(--green)' }}>{maxProfit > 1e6 ? 'Unlimited' : `+₹${fmtPrice(maxProfit)}`}</div></div>
              <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Max Loss</div><div style={{ fontSize: 14, fontWeight: 700, color: 'var(--red)' }}>{maxLoss < -1e6 ? 'Unlimited' : `-₹${fmtPrice(Math.abs(maxLoss))}`}</div></div>
              <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Breakeven</div><div style={{ fontSize: 12, fontWeight: 600 }}>{breakevenPoints.length ? breakevenPoints.map(bp => bp.toLocaleString('en-IN')).join(', ') : '—'}</div></div>
              <div><div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Lot Size</div><div style={{ fontSize: 12, fontWeight: 600 }}>{lotSize}</div></div>
            </div>
          )}

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
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '4px' }}>
                {/* Price Chart Container */}
                <div style={{ flex: 1, minHeight: 120, position: 'relative', borderBottom: '1px solid var(--border)' }}>
                  <div ref={priceContainerRef} style={{ width: '100%', height: '100%' }} />
                  {hoverPriceData ? (
                    <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 10, pointerEvents: 'none', fontSize: 10, fontFamily: 'monospace', background: 'rgba(13,15,17,0.85)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 6, color: 'var(--text-primary)' }}>
                      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{hoverPriceData.timeStr}</div>
                      {hoverPriceData.spot !== null && (
                        <div style={{ marginBottom: 2 }}>
                          <span style={{ color: '#fbbf24', fontWeight: 600 }}>{underlying}</span> Spot: <span style={{ fontWeight: 600 }}>{hoverPriceData.spot.toFixed(2)}</span>
                        </div>
                      )}
                      {hoverPriceData.legs.map((leg, i) => {
                        const color = LEG_COLORS[i % LEG_COLORS.length];
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: color }} />
                            <span style={{ color: 'var(--text-secondary)' }}>{leg.side === 'BUY' ? 'B' : 'S'} {leg.strike} {leg.optionType}:</span>
                            <span style={{ fontWeight: 600 }}>₹{leg.value.toFixed(2)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 10, pointerEvents: 'none', fontSize: 10, color: 'var(--text-muted)' }}>
                      Hover for price details
                    </div>
                  )}
                </div>

                {/* P&L Chart Container */}
                <div style={{ flex: 1, minHeight: 120, position: 'relative' }}>
                  <div ref={pnlContainerRef} style={{ width: '100%', height: '100%' }} />
                  {hoverPnlData ? (
                    <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 10, pointerEvents: 'none', fontSize: 10, fontFamily: 'monospace', background: 'rgba(13,15,17,0.85)', border: '1px solid var(--border)', padding: '4px 8px', borderRadius: 6, color: 'var(--text-primary)' }}>
                      <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{hoverPnlData.timeStr}</div>
                      <div style={{ marginBottom: 2 }}>
                        <span style={{ color: '#ffffff', fontWeight: 600 }}>Total P&L</span>: <span style={{ fontWeight: 700, color: hoverPnlData.total >= 0 ? 'var(--green)' : 'var(--red)' }}>{hoverPnlData.total >= 0 ? '+' : ''}₹{fmtPrice(hoverPnlData.total)}</span>
                      </div>
                      {hoverPnlData.legs.map((leg, i) => {
                        const color = LEG_COLORS[i % LEG_COLORS.length];
                        return (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: color }} />
                            <span style={{ color: 'var(--text-secondary)' }}>{leg.side === 'BUY' ? 'B' : 'S'} {leg.strike} {leg.optionType}:</span>
                            <span style={{ fontWeight: 600, color: leg.value >= 0 ? 'var(--green)' : 'var(--red)' }}>{leg.value >= 0 ? '+' : ''}₹{fmtPrice(leg.value)}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 10, pointerEvents: 'none', fontSize: 10, color: 'var(--text-muted)' }}>
                      Hover for P&L details
                    </div>
                  )}
                </div>
              </div>

              {/* Simulated Positions Table (identical to live positions tracker) */}
              <div style={{ flexShrink: 0, height: 160, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)', overflow: 'hidden' }}>
                <div style={{ height: 28, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: '0 12px' }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-primary)' }}>Simulated Positions</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
                    Strategy P&L: <span style={{ fontWeight: 700, color: evalResult.grossPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>{evalResult.grossPnl >= 0 ? '+' : ''}₹{fmtPrice(evalResult.grossPnl)}</span>
                  </span>
                </div>
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
                        const color = LEG_COLORS[i % LEG_COLORS.length];
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
              </div>
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
