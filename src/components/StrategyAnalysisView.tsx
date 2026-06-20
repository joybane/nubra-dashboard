import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  CandlestickSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
} from 'lightweight-charts';
import type { PaperPosition, PaperOrder, WsMessage, OptionChainData, OptionLeg } from '../types';
import { fmtPrice, IST_OFFSET, toChartTime } from '../lib/utils';
import { useWs } from '../hooks/useWsContext';
import { blackScholes, impliedVolatility } from '../lib/GexService';

interface StrategyAnalysisViewProps {
  basketGroupId: string;
  strategyName: string;
  theme: 'dark' | 'light';
  onBack: () => void;
}

interface LegMeta {
  refId: number;
  displayName: string;
  zanskarName: string;
  side: string;
  color: string;
  derivativeType: string;
  optionType: string;
}

function paise(v: number | undefined | null): string {
  if (v == null) return '—';
  return fmtPrice(v / 100);
}

function fmtTime(ns: number | undefined | null): string {
  if (!ns) return '—';
  const ms = ns / 1_000_000;
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function fmtChartTime(chartTime: number): string {
  const d = new Date(chartTime * 1000);
  const h = d.getUTCHours().toString().padStart(2, '0');
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function nowChartTime(): number {
  return Math.floor(Date.now() / 1000) + IST_OFFSET;
}

const LEG_COLORS = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

function deriveUnderlying(positions: PaperPosition[]): string | null {
  for (const p of positions) {
    const name = p.display_name || p.zanskar_name || '';
    const match = name.match(/^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY)/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

interface HistBar { time: number; open: number; high: number; low: number; close: number }

async function fetchHistorical(symbol: string, type: string, interval: string, startDate: Date, endDate: Date): Promise<HistBar[]> {
  const body = {
    query: [{
      exchange: 'NSE', type,
      values: [symbol],
      fields: ['open', 'high', 'low', 'close'],
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      interval, intraDay: false, realTime: false,
    }],
  };
  try {
    const res = await fetch('/api/historical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json() as { result?: Array<{ values: Array<Record<string, { open?: Array<{ts?: string; v: number}>; high?: Array<{v: number}>; low?: Array<{v: number}>; close?: Array<{v: number}> }>> }> };
    const bars: HistBar[] = [];
    for (const group of data.result || []) {
      for (const symbolMap of group.values || []) {
        for (const chart of Object.values(symbolMap)) {
          const opens = chart.open || [], highs = chart.high || [], lows = chart.low || [], closes = chart.close || [];
          const len = Math.min(opens.length, highs.length, lows.length, closes.length);
          for (let i = 0; i < len; i++) {
            const tsNs = opens[i].ts;
            if (tsNs == null) continue;
            const t = toChartTime(BigInt(tsNs), interval) as number;
            bars.push({ time: t, open: opens[i].v / 100, high: highs[i].v / 100, low: lows[i].v / 100, close: closes[i].v / 100 });
          }
        }
      }
    }
    return bars;
  } catch (e) {
    console.warn('[StrategyAnalysis] fetchHistorical failed:', e);
    return [];
  }
}

function chartOpts(isDark: boolean) {
  return {
    layout: {
      background: { color: isDark ? '#0d0f11' : '#ffffff' },
      textColor: isDark ? '#c9d1d9' : '#131722',
      fontSize: 11,
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

// ─── Cached chart data (survives chart recreation on toggle/theme change) ────
interface ChartDataCache {
  underlyingBars: HistBar[];
  legPriceData: Map<number, Array<{ time: any; value: number }>>;
  legPnlData: Map<number, Array<{ time: any; value: number }>>;
  basketPnlData: Array<{ time: any; value: number }>;
  legGreeksHist: Map<number, Array<{ time: number; delta: number; gamma: number; theta: number; vega: number }>>;
  pnlFrom: number;
  pnlTo: number;
  sessionOpen: number;
  sessionClose: number;
}

const GREEK_COLORS: Record<string, string> = { delta: '#3b82f6', gamma: '#a78bfa', theta: '#22c55e', vega: '#f59e0b' };

// Min-max normalization factor: maps a series' [min,max] to [-1,1]. True value = plotted × half + mid.
function minMaxFactor(values: number[]): { mid: number; half: number } {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (min === Infinity) return { mid: 0, half: 1 };
  const mid = (max + min) / 2, half = (max - min) / 2;
  return { mid, half: half > 0 ? half : 1 };
}

export default function StrategyAnalysisView({ basketGroupId, strategyName, theme, onBack }: StrategyAnalysisViewProps) {
  const { subscribe, subscribeChart, unsubscribeChart } = useWs();

  // ── Position / order state ──
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [posSubTab, setPosSubTab] = useState<'open' | 'closed'>('open');
  const [dataLoaded, setDataLoaded] = useState(false);

  // ── Chart refs (grouped) ──
  const priceChartContainerRef = useRef<HTMLDivElement>(null);
  const pnlChartContainerRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const pnlChartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<{
    underlying: ISeriesApi<'Candlestick'> | null;
    legPrice: Map<number, ISeriesApi<'Line'>>;
    legPnl: Map<number, ISeriesApi<'Line'>>;
    basketPnl: ISeriesApi<'Line'> | null;
  }>({ underlying: null, legPrice: new Map(), legPnl: new Map(), basketPnl: null });
  // Price-panel min-max normalization (same idea as Greeks): NIFTY and each option leg are mapped to
  // [-1,1] over their own range so they share one draggable axis and zoom together. Badges/tooltip
  // de-normalize via {mid,half}: true value = plotted × half + mid.
  const priceFactorsRef = useRef<{ underlying: { mid: number; half: number }; legs: Map<number, { mid: number; half: number }> }>({
    underlying: { mid: 0, half: 1 }, legs: new Map(),
  });
  const [chartData, setChartData] = useState<ChartDataCache | null>(null);
  const chartDataRef = useRef<ChartDataCache | null>(null);
  chartDataRef.current = chartData;
  // Bumped whenever any chart is created/destroyed, so the scroll-sync effect re-runs once all
  // currently-visible charts actually exist (chart creation effects run after the sync effect).
  const [chartEpoch, setChartEpoch] = useState(0);
  const positionsRef = useRef<PaperPosition[]>([]);
  positionsRef.current = positions;
  const closedPositionsRef = useRef<PaperPosition[]>([]);
  closedPositionsRef.current = closedPositions;
  const allPositionsRef = useRef<PaperPosition[]>([]);
  const legMetasRef = useRef<LegMeta[]>([]);
  const markersRef = useRef<Array<{ detach: () => void }>>([]);

  // ── Greeks state ──
  const [greeksVisible, setGreeksVisible] = useState(false);
  const [greeksMode, setGreeksMode] = useState<'unit' | 'lot'>('unit');
  const [greeksExpanded, setGreeksExpanded] = useState(false);
  const [greeksPopupOpen, setGreeksPopupOpen] = useState(false);
  const [legGreeks, setLegGreeks] = useState<Map<number, { delta: number; gamma: number; theta: number; vega: number; iv: number }>>(new Map());
  const [selectedGreeks, setSelectedGreeks] = useState<Set<string>>(new Set(['delta', 'gamma', 'theta', 'vega']));
  const [greeksLegFilter, setGreeksLegFilter] = useState<Set<string>>(new Set(['net']));
  const [lotSizeOverride, setLotSizeOverride] = useState<number | null>(null);
  const [editingLotSize, setEditingLotSize] = useState(false);

  const DEFAULT_LOT_SIZES: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };

  // ── Greeks chart refs ──
  const greeksChartContainerRef = useRef<HTMLDivElement>(null);
  const greeksChartRef = useRef<IChartApi | null>(null);
  const greeksSeriesRef = useRef<Record<string, ISeriesApi<'Line'> | null>>({});
  // Per-greek min-max normalization (true value = plotted × half + mid). Each greek is mapped to
  // [-1,1] over its own data range so every greek spans the full height regardless of magnitude;
  // all 4 share one draggable axis (zoom scales them together) while badges/tooltip show true values.
  const greekFactorsRef = useRef<Record<string, { mid: number; half: number }>>({
    delta: { mid: 0, half: 1 }, gamma: { mid: 0, half: 1 }, theta: { mid: 0, half: 1 }, vega: { mid: 0, half: 1 },
  });
  const [greeksChartHeight, setGreeksChartHeight] = useState(150);
  const [greeksTooltipPos, setGreeksTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [greeksTooltipValues, setGreeksTooltipValues] = useState<Record<string, number> | null>(null);
  const [greeksCrosshairTime, setGreeksCrosshairTime] = useState('');

  // ── Chart display state ──
  const [pnlHeight, setPnlHeight] = useState(200);
  const [orderBookHeight, setOrderBookHeight] = useState(200);
  const [priceVisible, setPriceVisible] = useState(true);
  const [pnlVisible, setPnlVisible] = useState(true);
  const [orderBookCollapsed, setOrderBookCollapsed] = useState(false);
  const [chartsPopupOpen, setChartsPopupOpen] = useState(false);
  const [pnlPopupOpen, setPnlPopupOpen] = useState(false);

  const [ohlc, setOhlc] = useState<{ o: number; h: number; l: number; c: number } | null>(null);
  const [legPrices, setLegPrices] = useState<Array<{ name: string; color: string; value: number }>>([]);
  const [pnlValues, setPnlValues] = useState<{ legs: Array<{ name: string; color: string; value: number }>; total: number } | null>(null);

  const [priceTooltipPos, setPriceTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [pnlTooltipPos, setPnlTooltipPos] = useState<{ x: number; y: number } | null>(null);
  const [crosshairTimeStr, setCrosshairTimeStr] = useState('');
  const [pnlCrosshairTimeStr, setPnlCrosshairTimeStr] = useState('');

  const [visibility, setVisibility] = useState<Record<string, boolean>>({
    underlying: true,
    basketPnl: true,
    entryMarkers: true,
  });
  // Independent per-leg visibility for the price panel vs the P&L panel.
  const [legPriceVisibility, setLegPriceVisibility] = useState<Record<number, boolean>>({});
  const [legPnlVisibility, setLegPnlVisibility] = useState<Record<number, boolean>>({});
  // ── Derived data ──
  const allPositions = useMemo(() => [...positions, ...closedPositions], [positions, closedPositions]);
  allPositionsRef.current = allPositions;
  const underlying = useMemo(() => deriveUnderlying(allPositions), [allPositions]);

  const legMetas: LegMeta[] = useMemo(() => {
    const seen = new Set<number>();
    const result: LegMeta[] = [];
    for (const p of allPositions) {
      if (seen.has(p.ref_id)) continue;
      seen.add(p.ref_id);
      result.push({
        refId: p.ref_id,
        displayName: p.display_name || p.zanskar_name || String(p.ref_id),
        zanskarName: p.zanskar_name || '',
        side: (p.order_side || '').includes('BUY') ? 'BUY' : 'SELL',
        color: LEG_COLORS[result.length % LEG_COLORS.length],
        derivativeType: p.derivative_type || 'OPT',
        optionType: p.option_type || '',
      });
    }
    return result;
  }, [allPositions]);
  legMetasRef.current = legMetas;

  useEffect(() => {
    const seed = (prev: Record<number, boolean>) => {
      const next = { ...prev };
      for (const l of legMetas) {
        if (!(l.refId in next)) next[l.refId] = true;
      }
      return next;
    };
    setLegPriceVisibility(seed);
    setLegPnlVisibility(seed);
  }, [legMetas]);

  // ── Fetch positions, orders, and Greeks in one batch ──
  const greeksFetchedRef = useRef(false);
  const fetchData = useCallback(async () => {
    try {
      const [openRes, closedRes, ordersRes] = await Promise.all([
        fetch('/paper/positions'),
        fetch('/paper/positions/closed'),
        fetch('/paper/orders?executed=1'),
      ]);
      let openPos: PaperPosition[] = [];
      let closedPos: PaperPosition[] = [];
      if (openRes.ok) {
        const d = await openRes.json() as { portfolio?: { stock_positions?: PaperPosition[] } } | PaperPosition[];
        const all = Array.isArray(d) ? d : (d.portfolio?.stock_positions ?? []);
        openPos = all.filter(p => p.basket_group_id === basketGroupId);
        setPositions(openPos);
      }
      if (closedRes.ok) {
        const d = await closedRes.json() as PaperPosition[];
        closedPos = (Array.isArray(d) ? d : []).filter(p => p.basket_group_id === basketGroupId);
        setClosedPositions(closedPos);
      }
      if (ordersRes.ok) {
        const d = await ordersRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        const all = Array.isArray(d) ? d : (d.orders ?? []);
        setOrders(all.filter(o => o.basket_group_id === basketGroupId));
      }
      setDataLoaded(true);

      // Fetch Greeks once alongside position data
      const allPos = [...openPos, ...closedPos];
      if (allPos.length > 0 && !greeksFetchedRef.current) {
        greeksFetchedRef.current = true;
        const ul = deriveUnderlying(allPos);
        if (!ul) return;

        // Parse expiry/strike/optType from zanskar_name: {UL}{YY}{M}{DD}{STRIKE}{CE|PE}
        const monthCodes: Record<string, string> = { '1':'01','2':'02','3':'03','4':'04','5':'05','6':'06','7':'07','8':'08','9':'09','O':'10','N':'11','D':'12' };
        const parsedInfo = new Map<number, { expiry: string; strike: number; optType: string }>();
        const expiries = new Set<string>();
        for (const p of allPos) {
          if (p.expiry) { expiries.add(String(p.expiry)); continue; }
          const m = (p.zanskar_name || '').match(/^[A-Z]+(\d{2})([0-9OND])(\d{2})(\d+)(CE|PE)$/i);
          if (m) {
            const mm = monthCodes[m[2].toUpperCase()] || '01';
            const expiry = `20${m[1]}${mm}${m[3]}`;
            expiries.add(expiry);
            parsedInfo.set(p.ref_id, { expiry, strike: Number(m[4]), optType: m[5].toUpperCase() });
          }
        }
        const refIds = new Set(allPos.map(p => p.ref_id));
        const greekUpdates = new Map<number, { delta: number; gamma: number; theta: number; vega: number; iv: number }>();

        let chainSpotPrice = 0;
        const ocFetches = [...expiries].map(expiry =>
          fetch(`/api/optionchain/${ul}?expiry=${expiry}`).then(r => r.ok ? r.json() : null).catch(() => null)
        );
        const ocResults = await Promise.all(ocFetches);
        for (const data of ocResults) {
          if (!data) continue;
          const chain = (data as any).chain || data;
          const cp = Number(chain.cp ?? chain.currentprice ?? 0);
          if (cp > 0 && chainSpotPrice === 0) chainSpotPrice = cp / 100;
          for (const item of [...(chain.ce || []), ...(chain.pe || [])]) {
            const refId = Number(item.ref_id ?? 0);
            if (!refId || !refIds.has(refId)) continue;
            greekUpdates.set(refId, {
              delta: Number(item.delta ?? 0), gamma: Number(item.gamma ?? 0),
              theta: Number(item.theta ?? 0), vega: Number(item.vega ?? 0), iv: Number(item.iv ?? 0),
            });
          }
        }

        // Fallback: Black-Scholes for positions not in the option chain
        if (greekUpdates.size < refIds.size) {
          let spotPrice = chainSpotPrice;
          if (spotPrice <= 0) {
            try {
              const priceRes = await fetch(`/api/optionchain/${ul}/price`);
              if (priceRes.ok) {
                const priceData = await priceRes.json() as Record<string, unknown>;
                spotPrice = Number(priceData.ltp ?? priceData.last_traded_price ?? priceData.currentprice ?? priceData.cp ?? 0) / 100;
              }
            } catch {}
          }
          if (spotPrice > 0) {
            for (const p of allPos) {
              if (greekUpdates.has(p.ref_id)) continue;
              const parsed = parsedInfo.get(p.ref_id);
              let strike = parsed?.strike || 0;
              let optType = parsed?.optType || '';
              if (!strike || (optType !== 'CE' && optType !== 'PE')) {
                const dm = (p.display_name || '').match(/(\d+)\s*(CE|PE)/i);
                if (dm) { strike = strike || Number(dm[1]); optType = optType || dm[2].toUpperCase(); }
              }
              if (!strike || (optType !== 'CE' && optType !== 'PE')) continue;
              const expiryStr = parsed?.expiry;
              const daysToExpiry = expiryStr
                ? Math.max(0, (new Date(expiryStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')).getTime() - Date.now()) / (1000 * 86400))
                : 1;
              const T = Math.max(daysToExpiry / 365, 1 / (365 * 24));
              const ltp = (p.last_traded_price || p.avg_price || 0) / 100;
              let iv = ltp > 0 ? impliedVolatility(ltp, spotPrice, strike, T, 0.07, optType as 'CE' | 'PE') : 0;
              if (iv <= 0 || !isFinite(iv)) iv = 0.2;
              const g = blackScholes(spotPrice, strike, T, 0.07, iv, optType as 'CE' | 'PE');
              greekUpdates.set(p.ref_id, { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, iv });
            }
          }
        }

        if (greekUpdates.size > 0) {
          setLegGreeks(prev => {
            const next = new Map(prev);
            for (const [k, v] of greekUpdates) next.set(k, v);
            return next;
          });
        }
      }
    } catch (e) { console.warn('[StrategyAnalysis] fetch failed:', e); }
  }, [basketGroupId]);

  useEffect(() => {
    fetchData();
    const t = setInterval(fetchData, 3000);
    return () => clearInterval(t);
  }, [fetchData]);

  // ── Subscribe for live underlying ticks ──
  useEffect(() => {
    if (!underlying) return;
    subscribeChart({ indexes: [underlying] }, '1m', 'NSE');
    return () => { unsubscribeChart({ indexes: [underlying] }, '1m', 'NSE'); };
  }, [underlying, subscribeChart, unsubscribeChart]);

  // ════════════════════════════════════════════════════════════════════════════
  // CHART SECTION — rebuilt from scratch
  // ════════════════════════════════════════════════════════════════════════════

  // Recompute price-panel normalization factors from cached data (NIFTY OHLC + each leg's prices).
  const computePriceFactors = useCallback((cache: ChartDataCache) => {
    const uvals: number[] = [];
    for (const b of cache.underlyingBars) { uvals.push(b.high, b.low); }
    const legs = new Map<number, { mid: number; half: number }>();
    for (const [refId, data] of cache.legPriceData) legs.set(refId, minMaxFactor(data.map(d => d.value)));
    priceFactorsRef.current = { underlying: minMaxFactor(uvals), legs };
  }, []);
  const normU = useCallback((v: number) => { const f = priceFactorsRef.current.underlying; return (v - f.mid) / f.half; }, []);
  const normLeg = useCallback((refId: number, v: number) => { const f = priceFactorsRef.current.legs.get(refId) || { mid: 0, half: 1 }; return (v - f.mid) / f.half; }, []);
  const denormLeg = useCallback((refId: number, v: number) => { const f = priceFactorsRef.current.legs.get(refId) || { mid: 0, half: 1 }; return v * f.half + f.mid; }, []);

  // ── 1. Create price chart ──
  useEffect(() => {
    if (!priceChartContainerRef.current || !priceVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(priceChartContainerRef.current, chartOpts(isDark));
    priceChartRef.current = chart;
    setChartEpoch(e => e + 1);

    // NIFTY candles + option legs all share the single 'right' axis, each min-max normalized to [-1,1]
    // (like the Greeks panel) so dragging the axis scales everything together. Formatters de-normalize.
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceLineVisible: true, lastValueVisible: true,
      title: underlying || 'Underlying',
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (p: number) => { const f = priceFactorsRef.current.underlying; return (p * f.half + f.mid).toFixed(2); } },
    } as Partial<CandlestickSeriesOptions>);
    seriesRef.current.underlying = candleSeries;

    // Crosshair → tooltip state
    chart.subscribeCrosshairMove((param) => {
      if (param.point) {
        setPriceTooltipPos({ x: param.point.x, y: param.point.y });
        if (param.time != null) setCrosshairTimeStr(fmtChartTime(param.time as number));
      } else {
        setPriceTooltipPos(null);
      }
      if (!param.seriesData) return;
      const uf = priceFactorsRef.current.underlying;
      const dn = (v: number) => v * uf.half + uf.mid;
      const bar = param.seriesData.get(candleSeries) as any;
      if (bar) {
        if (bar.open != null) setOhlc({ o: dn(bar.open), h: dn(bar.high), l: dn(bar.low), c: dn(bar.close) });
        else if (bar.value != null) setOhlc({ o: dn(bar.value), h: dn(bar.value), l: dn(bar.value), c: dn(bar.value) });
      }
      const legs: Array<{ name: string; color: string; value: number }> = [];
      for (const [refId, s] of seriesRef.current.legPrice) {
        const d = param.seriesData.get(s) as any;
        if (d?.value != null) {
          const meta = legMetasRef.current.find(l => l.refId === refId);
          if (meta) legs.push({ name: meta.displayName, color: meta.color, value: denormLeg(refId, d.value) });
        }
      }
      setLegPrices(legs);
    });

    // Restore cached data (handles theme change without re-fetch)
    const cached = chartDataRef.current;
    if (cached) {
      computePriceFactors(cached);
      candleSeries.setData(cached.underlyingBars.map(b => ({ time: b.time, open: normU(b.open), high: normU(b.high), low: normU(b.low), close: normU(b.close) })) as any);
      for (const leg of legMetasRef.current) {
        const s = chart.addSeries(LineSeries, {
          color: leg.color, lineWidth: 1, priceScaleId: 'right',
          title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
          priceFormat: { type: 'custom', minMove: 0.01, formatter: (p: number) => { const f = priceFactorsRef.current.legs.get(leg.refId) || { mid: 0, half: 1 }; return (p * f.half + f.mid).toFixed(2); } },
        });
        seriesRef.current.legPrice.set(leg.refId, s);
        const data = cached.legPriceData.get(leg.refId);
        if (data) s.setData(data.map(d => ({ time: d.time, value: normLeg(leg.refId, d.value) })));
      }
      try { chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } }); } catch {}
      requestAnimationFrame(() => chart.timeScale().fitContent());
    }

    return () => {
      seriesRef.current.underlying = null;
      seriesRef.current.legPrice.clear();
      chart.remove();
      priceChartRef.current = null;
      setChartEpoch(e => e + 1);
    };
  }, [theme, underlying, priceVisible]);

  // ── 2. Create P&L chart ──
  useEffect(() => {
    if (!pnlChartContainerRef.current || !pnlVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(pnlChartContainerRef.current, chartOpts(isDark));
    pnlChartRef.current = chart;
    setChartEpoch(e => e + 1);

    const basketSeries = chart.addSeries(LineSeries, {
      color: '#ffffff', lineWidth: 3,
      title: 'Total P&L', lastValueVisible: true, priceLineVisible: true,
    });
    seriesRef.current.basketPnl = basketSeries;

    // Create all leg P&L series
    for (const leg of legMetasRef.current) {
      const s = chart.addSeries(LineSeries, {
        color: leg.color, lineWidth: 1,
        title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
      });
      seriesRef.current.legPnl.set(leg.refId, s);
    }

    // Restore cached data (handles toggle off→on and theme change)
    const cached = chartDataRef.current;
    if (cached) {
      for (const leg of legMetasRef.current) {
        const data = cached.legPnlData.get(leg.refId);
        if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(data);
      }
      if (cached.basketPnlData.length > 0) basketSeries.setData(cached.basketPnlData);
      requestAnimationFrame(() => chart.timeScale().fitContent());
    }

    // Crosshair → tooltip state
    chart.subscribeCrosshairMove((param) => {
      if (param.point) {
        setPnlTooltipPos({ x: param.point.x, y: param.point.y });
        if (param.time != null) setPnlCrosshairTimeStr(fmtChartTime(param.time as number));
      } else {
        setPnlTooltipPos(null);
      }
      const basketD = param.seriesData?.get(basketSeries) as any;
      const total = basketD?.value ?? 0;
      const legs: Array<{ name: string; color: string; value: number }> = [];
      for (const [refId, s] of seriesRef.current.legPnl) {
        const d = param.seriesData?.get(s) as any;
        if (d?.value != null) {
          const meta = legMetasRef.current.find(l => l.refId === refId);
          if (meta) legs.push({ name: meta.displayName, color: meta.color, value: d.value });
        }
      }
      setPnlValues({ legs, total });
    });

    return () => {
      seriesRef.current.legPnl.clear();
      seriesRef.current.basketPnl = null;
      chart.remove();
      pnlChartRef.current = null;
      setChartEpoch(e => e + 1);
    };
  }, [theme, pnlVisible]);

  // ── 3a. Fetch historical data (stores in state — decoupled from chart refs) ──
  useEffect(() => {

    if (!dataLoaded || !underlying) return;
    const positions = allPositionsRef.current;
    const metas = legMetasRef.current;

    if (positions.length === 0 || metas.length === 0) return;

    const entryTimes = positions.map(p => p.entry_time || 0).filter(t => t > 0);
    const exitTimes = positions.map(p => p.exit_time || 0).filter(t => t > 0);

    if (entryTimes.length === 0) return;

    const earliestNs = Math.min(...entryTimes);
    const latestNs = exitTimes.length > 0 ? Math.max(...exitTimes) : 0;
    const entryDate = new Date(earliestNs / 1_000_000);
    const sessionOpen = Date.UTC(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate(), 3, 45, 0) / 1000 + IST_OFFSET;
    const sessionClose = Date.UTC(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate(), 10, 0, 0) / 1000 + IST_OFFSET;
    const pnlFrom = Math.floor(earliestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET;
    const pnlTo = latestNs > 0
      ? Math.min(Math.ceil(latestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET, sessionClose)
      : sessionClose;
    const startDate = new Date(Date.UTC(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate(), 3, 45, 0));
    const endDate = new Date(Date.UTC(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate(), 10, 0, 0));
    const ul = underlying;

    let cancelled = false;
    (async () => {
      const legFetches = metas.filter(l => l.zanskarName).map(leg => {
        const type = leg.derivativeType === 'OPT' ? 'OPT' : leg.derivativeType === 'FUT' ? 'FUT' : 'STOCK';
        return fetchHistorical(leg.zanskarName, type, '1m', startDate, endDate).then(bars => ({ leg, bars }));
      });
      const [underlyingRaw, ...legResults] = await Promise.all([
        fetchHistorical(ul, 'INDEX', '1m', startDate, endDate),
        ...legFetches,
      ]);
      if (cancelled) return;


      const underlyingBars = underlyingRaw.filter(b => b.time >= sessionOpen && b.time <= sessionClose);
      const legPriceData = new Map<number, Array<{ time: any; value: number }>>();
      const legPnlData = new Map<number, Array<{ time: any; value: number }>>();
      const pnlByTime = new Map<number, Map<number, number>>();

      for (const { leg, bars } of legResults) {
        const sessionBars = bars.filter(b => b.time >= sessionOpen && b.time <= sessionClose);
        if (sessionBars.length === 0) continue;
        legPriceData.set(leg.refId, sessionBars.map(b => ({ time: b.time as any, value: b.close })));
        const pos = positions.find(p => p.ref_id === leg.refId);
        if (pos) {
          const side = (pos.order_side || '').includes('BUY') ? 1 : -1;
          const avgPrice = (pos.avg_price || 0) / 100;
          const qty = pos.qty || 0;
          // For a leg closed during the session, freeze P&L at its realized value after exit instead of
          // continuing to mark it to market (keeps the curve + basket total consistent with the live tip).
          const exitChartTime = pos.exit_time ? Math.floor(pos.exit_time / 1_000_000_000 / 60) * 60 + IST_OFFSET : 0;
          const realizedPnl = pos.exit_price != null ? side * (pos.exit_price / 100 - avgPrice) * qty : 0;
          const pnlBars = sessionBars.filter(b => b.time >= pnlFrom && b.time <= pnlTo);
          const legPnlPoints = pnlBars.map(b => ({
            time: b.time as any,
            value: exitChartTime > 0 && b.time > exitChartTime ? realizedPnl : side * (b.close - avgPrice) * qty,
          }));
          legPnlData.set(leg.refId, legPnlPoints);
          for (const pt of legPnlPoints) {
            if (!pnlByTime.has(pt.time)) pnlByTime.set(pt.time, new Map());
            pnlByTime.get(pt.time)!.set(leg.refId, pt.value);
          }
        }
      }

      const basketPnlData: Array<{ time: any; value: number }> = [];
      if (pnlByTime.size > 0) {
        const times = [...pnlByTime.keys()].sort((a, b) => a - b);
        for (const t of times) {
          let total = 0;
          for (const v of pnlByTime.get(t)!.values()) total += v;
          basketPnlData.push({ time: t as any, value: total });
        }
      }

      // Fetch historical Greeks for each leg
      const legGreeksHist = new Map<number, Array<{ time: number; delta: number; gamma: number; theta: number; vega: number }>>();
      const greekSymbols = metas.filter(l => l.zanskarName && l.derivativeType === 'OPT').map(l => l.zanskarName);
      if (greekSymbols.length > 0) {
        try {
          const gRes = await fetch('/api/historical', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: [{ exchange: 'NSE', type: 'OPT', values: greekSymbols, fields: ['delta', 'gamma', 'theta', 'vega'], startDate: startDate.toISOString(), endDate: endDate.toISOString(), interval: '1m', intraDay: false, realTime: false }] }),
          });
          if (gRes.ok) {
            const gData = await gRes.json() as { result?: Array<{ values: Array<Record<string, Record<string, Array<{ ts: number | string; v: number }>>>> }> };
            for (const group of gData.result || []) {
              for (const symbolMap of group.values || []) {
                for (const [symName, fields] of Object.entries(symbolMap)) {
                  const meta = metas.find(l => l.zanskarName === symName);
                  if (!meta || !fields.delta?.length) continue;
                  const points: Array<{ time: number; delta: number; gamma: number; theta: number; vega: number }> = [];
                  const dArr = fields.delta || [], gArr = fields.gamma || [], tArr = fields.theta || [], vArr = fields.vega || [];
                  for (let i = 0; i < dArr.length; i++) {
                    const t = toChartTime(BigInt(String(dArr[i].ts)), '1m') as number;
                    if (t < sessionOpen || t > sessionClose) continue;
                    points.push({ time: t, delta: dArr[i].v, gamma: gArr[i]?.v || 0, theta: tArr[i]?.v || 0, vega: vArr[i]?.v || 0 });
                  }
                  if (points.length > 0) legGreeksHist.set(meta.refId, points);
                }
              }
            }
          }
        } catch (e) { console.warn('[StrategyAnalysis] Greeks historical fetch failed:', e); }
      }

      if (!cancelled) {
        setChartData({ underlyingBars, legPriceData, legPnlData, basketPnlData, legGreeksHist, pnlFrom, pnlTo, sessionOpen, sessionClose });
      }
    })();
    return () => { cancelled = true; };
  }, [dataLoaded, underlying]);

  // ── 3b. Apply fetched data to existing charts ──
  useEffect(() => {

    if (!chartData) return;

    const priceChart = priceChartRef.current;
    if (priceChart && seriesRef.current.underlying) {
      computePriceFactors(chartData);
      seriesRef.current.underlying.setData(chartData.underlyingBars.map(b => ({ time: b.time, open: normU(b.open), high: normU(b.high), low: normU(b.low), close: normU(b.close) })) as any);
      for (const leg of legMetasRef.current) {
        if (!seriesRef.current.legPrice.has(leg.refId)) {
          const s = priceChart.addSeries(LineSeries, {
            color: leg.color, lineWidth: 1, priceScaleId: 'right',
            title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
            priceFormat: { type: 'custom', minMove: 0.01, formatter: (p: number) => { const f = priceFactorsRef.current.legs.get(leg.refId) || { mid: 0, half: 1 }; return (p * f.half + f.mid).toFixed(2); } },
          });
          seriesRef.current.legPrice.set(leg.refId, s);
        }
        const data = chartData.legPriceData.get(leg.refId);
        if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(data.map(d => ({ time: d.time, value: normLeg(leg.refId, d.value) })));
      }
      try { priceChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } }); } catch {}

      requestAnimationFrame(() => priceChart.timeScale().fitContent());
    }

    const pnlChart = pnlChartRef.current;
    if (pnlChart) {
      for (const leg of legMetasRef.current) {
        if (!seriesRef.current.legPnl.has(leg.refId)) {
          const s = pnlChart.addSeries(LineSeries, {
            color: leg.color, lineWidth: 1,
            title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
          });
          seriesRef.current.legPnl.set(leg.refId, s);
        }
        const data = chartData.legPnlData.get(leg.refId);
        if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(data);
      }
      if (chartData.basketPnlData.length > 0) {
        seriesRef.current.basketPnl?.setData(chartData.basketPnlData);
      }
      requestAnimationFrame(() => pnlChart.timeScale().fitContent());
    }
  }, [chartData]);

  // ── 4. Chart scroll sync (logical range) ──
  useEffect(() => {
    const charts = [priceChartRef.current, pnlChartRef.current, greeksChartRef.current].filter(Boolean) as IChartApi[];
    if (charts.length < 2) return;
    const unsubs: (() => void)[] = [];
    for (let i = 0; i < charts.length; i++) {
      for (let j = i + 1; j < charts.length; j++) {
        const a = charts[i], b = charts[j];
        let syncing = false;
        const h1 = (range: any) => { if (syncing || !range) return; syncing = true; try { b.timeScale().setVisibleLogicalRange(range); } catch {} syncing = false; };
        const h2 = (range: any) => { if (syncing || !range) return; syncing = true; try { a.timeScale().setVisibleLogicalRange(range); } catch {} syncing = false; };
        a.timeScale().subscribeVisibleLogicalRangeChange(h1);
        b.timeScale().subscribeVisibleLogicalRangeChange(h2);
        unsubs.push(() => { try { a.timeScale().unsubscribeVisibleLogicalRangeChange(h1); } catch {} try { b.timeScale().unsubscribeVisibleLogicalRangeChange(h2); } catch {} });
      }
    }
    return () => unsubs.forEach(u => u());
  }, [priceVisible, pnlVisible, greeksVisible, chartEpoch]);

  // ── 5. Resize observer ──
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (priceChartContainerRef.current && priceChartRef.current) {
        const { width, height } = priceChartContainerRef.current.getBoundingClientRect();
        priceChartRef.current.resize(width, height);
      }
      if (pnlChartContainerRef.current && pnlChartRef.current) {
        const { width, height } = pnlChartContainerRef.current.getBoundingClientRect();
        pnlChartRef.current.resize(width, height);
      }
      if (greeksChartContainerRef.current && greeksChartRef.current) {
        const { width, height } = greeksChartContainerRef.current.getBoundingClientRect();
        greeksChartRef.current.resize(width, height);
      }
    });
    if (priceChartContainerRef.current) ro.observe(priceChartContainerRef.current);
    if (pnlChartContainerRef.current) ro.observe(pnlChartContainerRef.current);
    if (greeksChartContainerRef.current) ro.observe(greeksChartContainerRef.current);
    return () => ro.disconnect();
  }, [priceVisible, pnlVisible, greeksVisible, chartEpoch]);

  // ── 6. Live WebSocket updates (charts) ──
  useEffect(() => {
    const unsub1 = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !underlying || !seriesRef.current.underlying) return;
      const data = msg.data as { indexes?: Array<{ indexname?: string; timestamp?: string; open?: string; high?: string; low?: string; close?: string }> };
      const idx = data.indexes?.find(i => (i.indexname || '').toUpperCase() === underlying.toUpperCase());
      if (!idx?.timestamp) return;
      const t = Number(BigInt(idx.timestamp)) / 1e9 + IST_OFFSET;
      const cached = chartDataRef.current;
      if (cached && (t < cached.sessionOpen || t > cached.sessionClose)) return;
      seriesRef.current.underlying.update({
        time: t as any,
        open: normU(parseFloat(idx.open || '0') / 100),
        high: normU(parseFloat(idx.high || '0') / 100),
        low: normU(parseFloat(idx.low || '0') / 100),
        close: normU(parseFloat(idx.close || '0') / 100),
      });
    });

    const processLtp = (ltpMap: Map<number, number>) => {
      const t = nowChartTime();
      const cached = chartDataRef.current;
      if (cached && (t < cached.sessionOpen || t > cached.sessionClose)) return;
      // Seed the live total with realized P&L of legs already closed this session, so the basket tip =
      // realized (closed) + unrealized (open) — matching the frozen historical curve at the handoff.
      let totalPnl = 0;
      for (const p of closedPositionsRef.current) {
        const side = (p.order_side || '').includes('BUY') ? 1 : -1;
        if (p.exit_price != null) totalPnl += side * (p.exit_price - (p.avg_price || 0)) * (p.qty || 0) / 100;
      }
      for (const p of positionsRef.current) {
        const ltp = ltpMap.get(p.ref_id);
        if (ltp == null) continue;
        seriesRef.current.legPrice.get(p.ref_id)?.update({ time: t as any, value: normLeg(p.ref_id, ltp / 100) });
        const side = (p.order_side || '').includes('BUY') ? 1 : -1;
        const pnl = side * (ltp - (p.avg_price || 0)) * (p.qty || 0) / 100;
        seriesRef.current.legPnl.get(p.ref_id)?.update({ time: t as any, value: pnl });
        totalPnl += pnl;
      }
      if (positionsRef.current.length > 0 && seriesRef.current.basketPnl) {
        seriesRef.current.basketPnl.update({ time: t as any, value: totalPnl });
      }
    };

    const unsub2 = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data as { ref_id: number; ltp: number }[];
      if (!updates?.length) return;
      const ids = new Set(positionsRef.current.map(p => p.ref_id));
      const ltpMap = new Map<number, number>();
      for (const u of updates) { if (ids.has(u.ref_id)) ltpMap.set(u.ref_id, u.ltp); }
      if (ltpMap.size > 0) processLtp(ltpMap);
    });

    const unsub3 = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = (msg as any).data as { ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>> };
      const ids = new Set(positionsRef.current.map(p => p.ref_id));
      const ltpMap = new Map<number, number>();
      for (const item of [...(data.ce || []), ...(data.pe || [])]) {
        const refId = Number(item.ref_id ?? item.refId ?? 0);
        const ltp = Number(item.ltp ?? 0);
        if (refId && ltp > 0 && ids.has(refId)) ltpMap.set(refId, ltp);
      }
      if (ltpMap.size > 0) processLtp(ltpMap);
    });

    return () => { unsub1(); unsub2(); unsub3(); };
  }, [subscribe, underlying]);

  // ── 7. Live LTP for position table (unchanged) ──
  useEffect(() => {
    const unsub1 = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data as { ref_id: number; ltp: number }[];
      if (!updates?.length) return;
      const ltpMap = new Map<number, number>();
      for (const u of updates) ltpMap.set(u.ref_id, u.ltp);
      setPositions(prev => {
        let changed = false;
        const next = prev.map(p => {
          const v = ltpMap.get(p.ref_id);
          if (v != null && v !== p.last_traded_price) { changed = true; return { ...p, last_traded_price: v }; }
          return p;
        });
        return changed ? next : prev;
      });
    });
    const unsub2 = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const ltpMap = new Map<number, number>();
      for (const item of [...(data.ce || []), ...(data.pe || [])]) {
        const leg = item as OptionLeg & Record<string, unknown>;
        const refId = Number(leg.ref_id ?? leg.refId ?? 0);
        const ltp = Number(leg.ltp ?? 0);
        if (refId && ltp > 0) ltpMap.set(refId, ltp);
      }
      if (ltpMap.size === 0) return;
      setPositions(prev => {
        let changed = false;
        const next = prev.map(p => {
          const v = ltpMap.get(p.ref_id);
          if (v != null && v !== p.last_traded_price) { changed = true; return { ...p, last_traded_price: v }; }
          return p;
        });
        return changed ? next : prev;
      });
    });
    return () => { unsub1(); unsub2(); };
  }, [subscribe]);

  // ── 8. Visibility toggles ──
  useEffect(() => { seriesRef.current.underlying?.applyOptions({ visible: visibility.underlying }); }, [visibility.underlying, priceVisible]);
  useEffect(() => { seriesRef.current.basketPnl?.applyOptions({ visible: visibility.basketPnl }); }, [visibility.basketPnl, pnlVisible]);
  useEffect(() => {
    markersRef.current.forEach(m => { try { m.detach(); } catch {} });
    markersRef.current = [];
    if (!chartData || !visibility.entryMarkers) return;
    for (const p of allPositionsRef.current) {
      const series = seriesRef.current.legPrice.get(p.ref_id);
      if (!series) continue;
      const markers: Array<{ time: any; position: 'aboveBar' | 'belowBar'; color: string; shape: 'circle'; text: string; size: number }> = [];
      const entryPrice = (p.avg_price || 0) / 100;
      const entryTime = p.entry_time ? Math.floor(p.entry_time / 1_000_000_000 / 60) * 60 + IST_OFFSET : 0;
      const isBuy = (p.order_side || '').includes('BUY');
      if (entryPrice > 0 && entryTime > 0) {
        markers.push({ time: entryTime, position: 'aboveBar', color: isBuy ? '#22c55e' : '#ef4444', shape: 'circle', text: 'e', size: 1 });
      }
      if (p.exit_price && p.exit_time) {
        const exitTime = Math.floor(p.exit_time / 1_000_000_000 / 60) * 60 + IST_OFFSET;
        markers.push({ time: exitTime, position: 'belowBar', color: '#9ca3af', shape: 'circle', text: 'x', size: 1 });
      }
      if (markers.length > 0) {
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        markersRef.current.push(createSeriesMarkers(series, markers as any));
      }
    }
  }, [chartData, theme, visibility.entryMarkers, priceVisible]);
  useEffect(() => {
    for (const leg of legMetas) {
      seriesRef.current.legPrice.get(leg.refId)?.applyOptions({ visible: legPriceVisibility[leg.refId] !== false });
    }
  }, [legPriceVisibility, legMetas, priceVisible]);
  useEffect(() => {
    for (const leg of legMetas) {
      seriesRef.current.legPnl.get(leg.refId)?.applyOptions({ visible: legPnlVisibility[leg.refId] !== false });
    }
  }, [legPnlVisibility, legMetas, pnlVisible]);

  // ── 9. Live Greeks from option_chain WS ──
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = (msg as any).data as { ce?: Array<Record<string, unknown>>; pe?: Array<Record<string, unknown>> };
      const ids = new Set(allPositionsRef.current.map(p => p.ref_id));
      const updates = new Map<number, { delta: number; gamma: number; theta: number; vega: number; iv: number }>();
      for (const item of [...(data.ce || []), ...(data.pe || [])]) {
        const refId = Number(item.ref_id ?? item.refId ?? 0);
        if (!refId || !ids.has(refId)) continue;
        const delta = Number(item.delta ?? 0);
        const gamma = Number(item.gamma ?? 0);
        const theta = Number(item.theta ?? 0);
        const vega = Number(item.vega ?? 0);
        const iv = Number(item.iv ?? 0);
        if (delta !== 0 || gamma !== 0 || theta !== 0 || vega !== 0) {
          updates.set(refId, { delta, gamma, theta, vega, iv });
        }
      }
      if (updates.size > 0) {
        setLegGreeks(prev => {
          const next = new Map(prev);
          for (const [k, v] of updates) next.set(k, v);
          return next;
        });
      }
    });
    return () => unsub();
  }, [subscribe]);

  // ── 10. Greeks chart ──
  const GREEK_SOURCES = ['net', 'CE', 'PE'] as const;
  const GREEK_LINE_STYLES: Record<string, number> = { net: 0, CE: 2, PE: 1 };
  const GREEK_LINE_WIDTHS: Record<string, 1 | 2> = { net: 2, CE: 1, PE: 1 };
  // All greeks share one draggable 'right' axis. Plotted values are normalized (true value / factor)
  // so different magnitudes are comparable; a custom formatter de-normalizes so badges/tooltip show true values.

  useEffect(() => {
    if (!greeksChartContainerRef.current || !greeksVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(greeksChartContainerRef.current, chartOpts(isDark));
    greeksChartRef.current = chart;
    setChartEpoch(e => e + 1);
    const greekKeys = ['delta', 'gamma', 'theta', 'vega'] as const;
    greeksSeriesRef.current = {};
    for (const src of GREEK_SOURCES) {
      for (const k of greekKeys) {
        const key = `${src}_${k}`;
        const s = chart.addSeries(LineSeries, {
          color: GREEK_COLORS[k], lineWidth: GREEK_LINE_WIDTHS[src], lineStyle: GREEK_LINE_STYLES[src],
          priceScaleId: 'right', title: src === 'net' ? k.charAt(0).toUpperCase() + k.slice(1) : `${src} ${k.charAt(0).toUpperCase() + k.slice(1)}`,
          lastValueVisible: true, priceLineVisible: false, visible: false,
          priceFormat: { type: 'custom', minMove: 0.00001, formatter: (price: number) => {
            const f = greekFactorsRef.current[k] || { mid: 0, half: 1 };
            const v = price * f.half + f.mid;
            return k === 'gamma' ? v.toFixed(4) : v.toFixed(2);
          } },
        });
        greeksSeriesRef.current[key] = s;
      }
    }
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.12, bottom: 0.12 } });
    chart.subscribeCrosshairMove((param) => {
      if (param.point) {
        setGreeksTooltipPos({ x: param.point.x, y: param.point.y });
        if (param.time != null) setGreeksCrosshairTime(fmtChartTime(param.time as number));
      } else { setGreeksTooltipPos(null); }
      const vals: Record<string, number> = {};
      for (const k of greekKeys) {
        const s = greeksSeriesRef.current[`net_${k}`];
        if (!s) continue;
        const d = param.seriesData?.get(s) as any;
        if (d?.value != null) { const f = greekFactorsRef.current[k] || { mid: 0, half: 1 }; vals[k] = d.value * f.half + f.mid; } // de-normalize to true value
      }
      setGreeksTooltipValues(Object.keys(vals).length > 0 ? vals : null);
    });
    requestAnimationFrame(() => chart.timeScale().fitContent());
    return () => { greeksSeriesRef.current = {}; chart.remove(); greeksChartRef.current = null; setChartEpoch(e => e + 1); };
  }, [theme, greeksVisible]);

  // ── 10b. Apply Greeks data / recompute on mode, selection, or leg filter change ──
  useEffect(() => {
    if (!chartData || !greeksChartRef.current || !greeksVisible) return;
    const greekKeys = ['delta', 'gamma', 'theta', 'vega'] as const;
    const activeLotSize = lotSizeOverride ?? (underlying ? DEFAULT_LOT_SIZES[underlying] ?? 65 : 65);
    const multiplier = greeksMode === 'lot' ? activeLotSize : 1;

    const computeByTime = (positions: PaperPosition[]) => {
      const byTime = new Map<number, { delta: number; gamma: number; theta: number; vega: number }>();
      for (const p of positions) {
        const data = chartData.legGreeksHist.get(p.ref_id);
        if (!data) continue;
        const sign = (p.order_side || '').includes('BUY') ? 1 : -1;
        for (const pt of data) {
          const ex = byTime.get(pt.time) || { delta: 0, gamma: 0, theta: 0, vega: 0 };
          ex.delta += pt.delta * sign * multiplier; ex.gamma += pt.gamma * sign * multiplier;
          ex.theta += pt.theta * sign * multiplier; ex.vega += pt.vega * sign * multiplier;
          byTime.set(pt.time, ex);
        }
      }
      return byTime;
    };

    const allPos = allPositionsRef.current;
    const cePositions = allPos.filter(p => (p.zanskar_name || '').toUpperCase().endsWith('CE'));
    const pePositions = allPos.filter(p => (p.zanskar_name || '').toUpperCase().endsWith('PE'));
    const sourceData: Record<string, Map<number, { delta: number; gamma: number; theta: number; vega: number }>> = {
      net: computeByTime(allPos),
      CE: computeByTime(cePositions),
      PE: computeByTime(pePositions),
    };

    // Min-max normalization per greek: map each greek's [min,max] over the active sources to [-1,1]
    // so every greek spans the full height regardless of magnitude. Only selected greeks count toward
    // the range (so hiding one rescales the rest). Stored as {mid,half} for the de-normalizing formatter.
    const factors: Record<string, { mid: number; half: number }> = {
      delta: { mid: 0, half: 1 }, gamma: { mid: 0, half: 1 }, theta: { mid: 0, half: 1 }, vega: { mid: 0, half: 1 },
    };
    for (const k of greekKeys) {
      let min = Infinity, max = -Infinity;
      for (const src of GREEK_SOURCES) {
        if (!greeksLegFilter.has(src)) continue;
        for (const v of sourceData[src].values()) {
          if (v[k] < min) min = v[k];
          if (v[k] > max) max = v[k];
        }
      }
      if (min === Infinity) continue;
      const mid = (max + min) / 2;
      const half = (max - min) / 2;
      factors[k] = { mid, half: half > 0 ? half : 1 };
    }
    greekFactorsRef.current = factors;

    for (const src of GREEK_SOURCES) {
      const byTime = sourceData[src];
      const times = [...byTime.keys()].sort((a, b) => a - b);
      const isActive = greeksLegFilter.has(src);
      for (const k of greekKeys) {
        const key = `${src}_${k}`;
        const s = greeksSeriesRef.current[key];
        if (!s) continue;
        if (isActive && selectedGreeks.has(k) && times.length > 0) {
          const f = factors[k];
          s.setData(times.map(t => ({ time: t as any, value: (byTime.get(t)![k] - f.mid) / f.half })));
          s.applyOptions({ visible: true });
        } else {
          s.setData([]);
          s.applyOptions({ visible: false });
        }
      }
    }

    requestAnimationFrame(() => greeksChartRef.current?.timeScale().fitContent());
  }, [chartData, greeksMode, lotSizeOverride, selectedGreeks, greeksVisible, underlying, greeksLegFilter]);

  const toggleVis = useCallback((key: string) => { setVisibility(prev => ({ ...prev, [key]: !prev[key] })); }, []);
  const toggleLegPrice = useCallback((refId: number) => { setLegPriceVisibility(prev => ({ ...prev, [refId]: !(prev[refId] !== false) })); }, []);
  const toggleLegPnl = useCallback((refId: number) => { setLegPnlVisibility(prev => ({ ...prev, [refId]: !(prev[refId] !== false) })); }, []);

  // ── Close panel-toggle popups on outside click ──
  const chartsPopupRef = useRef<HTMLDivElement>(null);
  const pnlPopupRef = useRef<HTMLDivElement>(null);
  const greeksPopupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chartsPopupOpen && !pnlPopupOpen && !greeksPopupOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (chartsPopupRef.current && !chartsPopupRef.current.contains(t)) setChartsPopupOpen(false);
      if (pnlPopupRef.current && !pnlPopupRef.current.contains(t)) setPnlPopupOpen(false);
      if (greeksPopupRef.current && !greeksPopupRef.current.contains(t)) setGreeksPopupOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [chartsPopupOpen, pnlPopupOpen, greeksPopupOpen]);

  // ── Divider drag handlers ──
  const onPnlDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = pnlHeight;
    const onMove = (ev: MouseEvent) => { setPnlHeight(Math.max(80, startH - (ev.clientY - startY))); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [pnlHeight]);

  const onGreeksDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = greeksChartHeight;
    const onMove = (ev: MouseEvent) => { setGreeksChartHeight(Math.max(80, startH - (ev.clientY - startY))); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [greeksChartHeight]);

  const onObDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = orderBookHeight;
    const onMove = (ev: MouseEvent) => { setOrderBookHeight(Math.max(40, startH - (ev.clientY - startY))); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [orderBookHeight]);

  // ── P&L calculations ──
  function calcPnl(p: PaperPosition): number {
    const side = (p.order_side || '').includes('BUY') ? 1 : -1;
    return side * ((p.last_traded_price || 0) - (p.avg_price || 0)) * (p.qty || 0) / 100;
  }

  const openPnl = positions.reduce((s, p) => s + calcPnl(p), 0);
  const closedPnl = closedPositions.reduce((s, p) => s + (p.realised_pnl || p.pnl || 0) / 100, 0);
  const strategyPnl = openPnl + closedPnl;
  const strategyMargin = useMemo(() => {
    const first = allPositions.find(p => p.margin_required && p.margin_required > 0);
    return first ? first.margin_required! / 100 : 0;
  }, [allPositions]);
  const displayPositions = posSubTab === 'open' ? positions : closedPositions;
  const effectiveObHeight = orderBookCollapsed ? 32 : orderBookHeight;
  // The first visible chart panel flexes to fill remaining space; the rest keep their fixed heights.
  const primaryPanel = (priceVisible && 'price') || (pnlVisible && 'pnl') || (greeksVisible && 'greeks') || null;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden">
      {/* Consolidated ribbon: strategy info + 3 panel-toggle rectangles + total P&L */}
      <div className="h-10 shrink-0 flex items-center px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <span className="text-[16px]">←</span> Back
        </button>
        <div className="w-px h-5 bg-[var(--border)]" />
        <span className="text-[13px] font-semibold text-[var(--accent)]">{strategyName}</span>
        <span className="text-[11px] text-[var(--text-muted)]">({legMetas.length} legs)</span>
        {underlying && <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">{underlying}</span>}
        <div className="w-px h-5 bg-[var(--border)]" />

        {/* ── Rectangle 1: Charts (underlying + legs) ── */}
        <div ref={chartsPopupRef} className="relative flex items-stretch">
          <button onClick={() => setPriceVisible(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-l text-[11px] font-semibold border border-r-0 transition-colors ${
              priceVisible ? 'bg-[#fbbf24]/15 border-[#fbbf24]/40 text-[#fbbf24]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
            }`}>Charts</button>
          <button onClick={() => setChartsPopupOpen(v => !v)}
            className={`px-1 py-0.5 rounded-r text-[11px] font-semibold border border-l-0 transition-colors ${
              priceVisible ? 'bg-[#fbbf24]/15 border-[#fbbf24]/40 text-[#fbbf24] hover:bg-[#fbbf24]/25' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}>▾</button>
          {chartsPopupOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[220px] bg-[var(--bg-card,var(--bg-secondary))] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">Chart Layers</span>
                <button onClick={() => setChartsPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none">×</button>
              </div>
              <div className="px-3 py-2 flex flex-wrap gap-1.5">
                {underlying && (
                  <button onClick={() => toggleVis('underlying')}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                      visibility.underlying ? 'border-[#fbbf24]/40 bg-[#fbbf24]/10 text-[#fbbf24]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                    }`}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: visibility.underlying ? '#fbbf24' : 'transparent', border: '1px solid #fbbf24' }} />
                    {underlying}
                  </button>
                )}
                {legMetas.map(leg => (
                  <button key={leg.refId} onClick={() => toggleLegPrice(leg.refId)}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                      legPriceVisibility[leg.refId] !== false ? 'border-white/20 bg-white/5 text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                    }`}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: legPriceVisibility[leg.refId] !== false ? leg.color : 'transparent', border: `1px solid ${leg.color}` }} />
                    {leg.displayName}
                  </button>
                ))}
                <button onClick={() => toggleVis('entryMarkers')}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                    visibility.entryMarkers ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
                  }`}>Markers (e/x)</button>
              </div>
            </div>
          )}
        </div>

        {/* ── Rectangle 2: P&L ── */}
        <div ref={pnlPopupRef} className="relative flex items-stretch">
          <button onClick={() => setPnlVisible(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-l text-[11px] font-semibold border border-r-0 transition-colors ${
              pnlVisible ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
            }`}>P&amp;L</button>
          <button onClick={() => setPnlPopupOpen(v => !v)}
            className={`px-1 py-0.5 rounded-r text-[11px] font-semibold border border-l-0 transition-colors ${
              pnlVisible ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)] hover:bg-[var(--accent)]/25' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}>▾</button>
          {pnlPopupOpen && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[220px] bg-[var(--bg-card,var(--bg-secondary))] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">P&amp;L Layers</span>
                <button onClick={() => setPnlPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none">×</button>
              </div>
              <div className="px-3 py-2 flex flex-wrap gap-1.5">
                <button onClick={() => toggleVis('basketPnl')}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                    visibility.basketPnl ? 'border-white/40 bg-white/10 text-white' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                  }`}>
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: visibility.basketPnl ? '#ffffff' : 'transparent', border: '1px solid #ffffff' }} />
                  Total P&amp;L
                </button>
                {legMetas.map(leg => (
                  <button key={leg.refId} onClick={() => toggleLegPnl(leg.refId)}
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                      legPnlVisibility[leg.refId] !== false ? 'border-white/20 bg-white/5 text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
                    }`}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: legPnlVisibility[leg.refId] !== false ? leg.color : 'transparent', border: `1px solid ${leg.color}` }} />
                    {leg.displayName}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ── Rectangle 3: Greeks ── */}
        <div ref={greeksPopupRef} className="relative flex items-stretch">
          <button onClick={() => setGreeksVisible(v => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-l text-[11px] font-semibold border border-r-0 transition-colors ${
              greeksVisible ? 'bg-[#a78bfa]/15 border-[#a78bfa]/40 text-[#a78bfa]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
            }`}>Greeks</button>
          <button onClick={() => setGreeksPopupOpen(v => !v)}
            className={`px-1 py-0.5 rounded-r text-[11px] font-semibold border border-l-0 transition-colors ${
              greeksVisible ? 'bg-[#a78bfa]/15 border-[#a78bfa]/40 text-[#a78bfa] hover:bg-[#a78bfa]/25' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}>▾</button>
          {greeksPopupOpen && (() => {
            const activeLotSize = lotSizeOverride ?? (underlying ? DEFAULT_LOT_SIZES[underlying] ?? 65 : 65);
            const multiplier = greeksMode === 'lot' ? activeLotSize : 1;
            const greekKeys = ['delta', 'gamma', 'theta', 'vega'] as const;
            const activeGreeks = greekKeys.filter(k => selectedGreeks.has(k));
            const netGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
            for (const p of allPositions) {
              const g = legGreeks.get(p.ref_id);
              if (!g) continue;
              const sign = (p.order_side || '').includes('BUY') ? 1 : -1;
              netGreeks.delta += g.delta * sign * multiplier;
              netGreeks.gamma += g.gamma * sign * multiplier;
              netGreeks.theta += g.theta * sign * multiplier;
              netGreeks.vega += g.vega * sign * multiplier;
            }
            const fmtG = (v: number, key: string) => key === 'gamma' ? v.toFixed(4) : v.toFixed(2);
            const cePositions = allPositions.filter(p => (p.zanskar_name || '').toUpperCase().endsWith('CE'));
            const pePositions = allPositions.filter(p => (p.zanskar_name || '').toUpperCase().endsWith('PE'));
            return (
              <div className="absolute top-full right-0 mt-1 z-50 w-[280px] bg-[var(--bg-card,var(--bg-secondary))] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
                  <span className="text-[11px] font-semibold text-[var(--text-primary)]">Greeks Settings</span>
                  <button onClick={() => setGreeksPopupOpen(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none">×</button>
                </div>
                {/* Unit / Lot toggle */}
                <div className="px-3 py-2 flex items-center gap-2 border-b border-[var(--border)]">
                  <div className="flex items-center bg-[var(--bg-primary)] rounded overflow-hidden border border-[var(--border)]">
                    <button onClick={() => setGreeksMode('unit')}
                      className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${greeksMode === 'unit' ? 'bg-[#a78bfa]/20 text-[#a78bfa]' : 'text-[var(--text-muted)]'}`}>1 Unit</button>
                    <button onClick={() => setGreeksMode('lot')}
                      className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${greeksMode === 'lot' ? 'bg-[#a78bfa]/20 text-[#a78bfa]' : 'text-[var(--text-muted)]'}`}>1 Lot</button>
                  </div>
                  {greeksMode === 'lot' && (
                    <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                      <span>Lot:</span>
                      {editingLotSize ? (
                        <input type="number" autoFocus defaultValue={activeLotSize}
                          className="w-12 bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1 py-0 text-[10px] text-[var(--text-primary)] outline-none focus:border-[#a78bfa]"
                          onBlur={(e) => { const v = parseInt(e.target.value); if (v > 0) setLotSizeOverride(v); setEditingLotSize(false); }}
                          onKeyDown={(e) => { if (e.key === 'Enter') { const v = parseInt((e.target as HTMLInputElement).value); if (v > 0) setLotSizeOverride(v); setEditingLotSize(false); } if (e.key === 'Escape') setEditingLotSize(false); }}
                        />
                      ) : (
                        <button onClick={() => setEditingLotSize(true)} className="text-[var(--text-primary)] hover:text-[#a78bfa] transition-colors underline decoration-dotted">{activeLotSize}</button>
                      )}
                    </div>
                  )}
                </div>
                {/* Greek selectors */}
                <div className="px-3 py-2 border-b border-[var(--border)]">
                  <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1.5">GREEKS</div>
                  <div className="flex items-center gap-1">
                    {greekKeys.map(k => (
                      <button key={k} onClick={() => setSelectedGreeks(prev => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n; })}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                          selectedGreeks.has(k) ? `border-transparent text-white` : 'border-[var(--border)] text-[var(--text-muted)]'
                        }`}
                        style={selectedGreeks.has(k) ? { backgroundColor: GREEK_COLORS[k] + '33', color: GREEK_COLORS[k], borderColor: GREEK_COLORS[k] + '55' } : undefined}
                      >{k.charAt(0).toUpperCase() + k.slice(1)}</button>
                    ))}
                  </div>
                </div>
                {/* Source filter: Net / CE / PE */}
                <div className="px-3 py-2 border-b border-[var(--border)]">
                  <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1.5">SHOW IN CHART</div>
                  <div className="flex items-center gap-1">
                    {(['net', ...((cePositions.length > 0) ? ['CE'] : []), ...((pePositions.length > 0) ? ['PE'] : [])] as string[]).map(src => (
                      <button key={src} onClick={() => setGreeksLegFilter(prev => { const n = new Set(prev); if (n.has(src)) n.delete(src); else n.add(src); return n; })}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
                          greeksLegFilter.has(src) ? 'border-[#a78bfa]/40 bg-[#a78bfa]/15 text-[#a78bfa]' : 'border-[var(--border)] text-[var(--text-muted)]'
                        }`}>
                        {src === 'net' ? 'Net' : `${src} Leg`}
                        {src !== 'net' && <span className="ml-1 text-[8px] text-[var(--text-muted)]">{src === 'CE' ? '━━' : '╌╌'}</span>}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Net Greeks values */}
                <div className="px-3 py-2 border-b border-[var(--border)]">
                  <div className="text-[9px] text-[var(--text-muted)] font-semibold mb-1">NET GREEKS</div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]">
                    {activeGreeks.map(k => (
                      <div key={k} className="flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: GREEK_COLORS[k] }} />
                        <span className="text-[var(--text-muted)] text-[10px]">{k.charAt(0).toUpperCase() + k.slice(1)}</span>
                        <span className={`font-semibold tabular-nums ${netGreeks[k] >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{netGreeks[k] >= 0 ? '+' : ''}{fmtG(netGreeks[k], k)}</span>
                      </div>
                    ))}
                    {legGreeks.size === 0 && <span className="text-[var(--text-muted)] text-[10px] italic">Waiting for data...</span>}
                  </div>
                </div>
                {/* Leg breakdown */}
                <div className="px-3 py-1.5">
                  <button onClick={() => setGreeksExpanded(v => !v)} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1">
                    <span className="text-[8px]">{greeksExpanded ? '▾' : '▸'}</span> Leg breakdown
                  </button>
                  {greeksExpanded && (
                    <div className="mt-1.5 grid gap-0 text-[10px]" style={{ gridTemplateColumns: `20px 1fr ${activeGreeks.map(() => '58px').join(' ')} 40px` }}>
                      <span className="text-[var(--text-muted)] font-semibold py-0.5">B/S</span>
                      <span className="text-[var(--text-muted)] font-semibold py-0.5">Instrument</span>
                      {activeGreeks.map(k => <span key={k} className="text-[var(--text-muted)] font-semibold py-0.5 text-right">{k.charAt(0).toUpperCase() + k.slice(1)}</span>)}
                      <span className="text-[var(--text-muted)] font-semibold py-0.5 text-right">IV%</span>
                      {allPositions.map(p => {
                        const g = legGreeks.get(p.ref_id);
                        const side = (p.order_side || '').includes('BUY') ? 'BUY' : 'SELL';
                        const sign = side === 'BUY' ? 1 : -1;
                        const meta = legMetas.find(l => l.refId === p.ref_id);
                        return (
                          <React.Fragment key={p.ref_id}>
                            <span className={`py-0.5 font-bold text-[9px] ${side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{side === 'BUY' ? 'B' : 'S'}</span>
                            <span className="py-0.5 text-[var(--text-primary)] flex items-center gap-1 truncate">
                              {meta && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: meta.color }} />}
                              {p.display_name || p.zanskar_name || p.ref_id}
                            </span>
                            {activeGreeks.map(k => {
                              const raw = g ? g[k] : 0;
                              const val = raw * sign * multiplier;
                              return <span key={k} className={`py-0.5 text-right tabular-nums font-medium ${val >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{val >= 0 ? '+' : ''}{fmtG(val, k)}</span>;
                            })}
                            <span className="py-0.5 text-right tabular-nums text-[var(--text-secondary)]">{g?.iv ? (g.iv * 100).toFixed(1) : '—'}</span>
                          </React.Fragment>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </div>

        <span className={`ml-auto text-[12px] font-semibold ${strategyPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
          P&L: {strategyPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(strategyPnl))}
        </span>
      </div>

      {/* Charts + order book */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Price chart */}
        {priceVisible && (
        <div ref={priceChartContainerRef} className="relative flex-1 min-h-[120px] bg-[var(--bg-primary)]">
          <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px] text-[var(--text-muted)]">
            {ohlc
              ? <span><span className="text-[#fbbf24] font-semibold mr-1">{underlying}</span> O <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.o)}</span> H <span className="text-[var(--green)]">{fmtPrice(ohlc.h)}</span> L <span className="text-[var(--red)]">{fmtPrice(ohlc.l)}</span> C <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.c)}</span>
                  {legPrices.map(l => <span key={l.name} className="ml-2"><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: l.color }} />{l.name} <span className="text-[var(--text-primary)] font-medium">₹{fmtPrice(l.value)}</span></span>)}
                </span>
              : <span className="text-[var(--text-muted)]">Hover over chart for details</span>
            }
          </div>
          {priceTooltipPos && (ohlc || legPrices.length > 0) && (
            <div
              className="absolute z-50 pointer-events-none"
              style={{
                left: priceTooltipPos.x > (priceChartContainerRef.current?.clientWidth ?? 800) * 0.6
                  ? priceTooltipPos.x - 230
                  : priceTooltipPos.x + 20,
                top: Math.max(20, Math.min(priceTooltipPos.y - 30, (priceChartContainerRef.current?.clientHeight ?? 400) - 140)),
              }}
            >
              <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]">
                {crosshairTimeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">{crosshairTimeStr}</div>}
                {ohlc && (
                  <div className="text-[11px] mb-1">
                    <span className="text-[#fbbf24] font-semibold mr-2">{underlying}</span>
                    <span className="text-[var(--text-muted)]">O</span> <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.o)}</span>
                    {' '}<span className="text-[var(--text-muted)]">H</span> <span className="text-[var(--green)]">{fmtPrice(ohlc.h)}</span>
                    {' '}<span className="text-[var(--text-muted)]">L</span> <span className="text-[var(--red)]">{fmtPrice(ohlc.l)}</span>
                    {' '}<span className="text-[var(--text-muted)]">C</span> <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.c)}</span>
                  </div>
                )}
                {legPrices.map(l => (
                  <div key={l.name} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
                    <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                      <span className="truncate max-w-[120px]">{l.name}</span>
                    </span>
                    <span className="text-[var(--text-primary)] font-medium tabular-nums">₹{fmtPrice(l.value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        )}

        {pnlVisible && (
          <>
            {priceVisible && (
            <div onMouseDown={onPnlDividerDown} className="group h-2 shrink-0 flex items-center justify-center bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/20 cursor-row-resize transition-colors z-20 relative">
              <div className="w-10 h-0.5 rounded-full bg-[var(--border)] group-hover:bg-[var(--accent)]" />
            </div>
            )}
            {/* P&L chart */}
            <div ref={pnlChartContainerRef} className={`relative bg-[var(--bg-primary)] ${primaryPanel === 'pnl' ? 'flex-1 min-h-[80px]' : 'shrink-0'}`} style={primaryPanel === 'pnl' ? undefined : { height: pnlHeight }}>
              <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px]">
                {pnlValues
                  ? <span>
                      {pnlValues.legs.map(l => <span key={l.name} className="mr-2"><span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: l.color }} />{l.name}: <span className={l.value >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{l.value >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(l.value))}</span></span>)}
                      <span className="font-semibold ml-1">Total: <span className={pnlValues.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{pnlValues.total >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnlValues.total))}</span></span>
                    </span>
                  : <span className="text-[var(--text-muted)]">P&L details on hover</span>
                }
              </div>
              {pnlTooltipPos && pnlValues && (pnlValues.legs.length > 0 || pnlValues.total !== 0) && (
                <div
                  className="absolute z-50 pointer-events-none"
                  style={{
                    left: pnlTooltipPos.x > (pnlChartContainerRef.current?.clientWidth ?? 800) * 0.6
                      ? pnlTooltipPos.x - 230
                      : pnlTooltipPos.x + 20,
                    top: Math.max(8, Math.min(pnlTooltipPos.y - 30, pnlHeight - 110)),
                  }}
                >
                  <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]">
                    {pnlCrosshairTimeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">{pnlCrosshairTimeStr}</div>}
                    {pnlValues.legs.map(l => (
                      <div key={l.name} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
                        <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                          <span className="truncate max-w-[120px]">{l.name}</span>
                        </span>
                        <span className={`font-medium tabular-nums ${l.value >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {l.value >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(l.value))}
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-4 text-[11px] pt-1 mt-1 border-t border-[#ffffff0a] font-semibold">
                      <span className="text-[var(--text-secondary)]">Total P&L</span>
                      <span className={pnlValues.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                        {pnlValues.total >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnlValues.total))}
                      </span>
                    </div>
                    {strategyMargin > 0 && (
                      <>
                        <div className="flex items-center justify-between gap-4 text-[11px] pt-0.5">
                          <span className="text-[var(--text-muted)]">Margin</span>
                          <span className="text-[var(--text-secondary)] tabular-nums">₹{fmtPrice(strategyMargin)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-4 text-[11px] pt-0.5">
                          <span className="text-[var(--text-muted)]">ROI</span>
                          <span className={`font-medium tabular-nums ${pnlValues.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                            {(pnlValues.total / strategyMargin * 100).toFixed(2)}%
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {greeksVisible && (
          <>
            {(priceVisible || pnlVisible) && (
            <div onMouseDown={onGreeksDividerDown} className="group h-2 shrink-0 flex items-center justify-center bg-[var(--bg-secondary)] hover:bg-[#a78bfa]/20 cursor-row-resize transition-colors z-20 relative">
              <div className="w-10 h-0.5 rounded-full bg-[var(--border)] group-hover:bg-[#a78bfa]" />
            </div>
            )}
            <div ref={greeksChartContainerRef} className={`relative bg-[var(--bg-primary)] ${primaryPanel === 'greeks' ? 'flex-1 min-h-[80px]' : 'shrink-0'}`} style={primaryPanel === 'greeks' ? undefined : { height: greeksChartHeight }}>
              <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px]">
                {greeksTooltipValues
                  ? <span>{(['delta', 'gamma', 'theta', 'vega'] as const).filter(k => selectedGreeks.has(k) && greeksTooltipValues[k] != null).map(k => (
                      <span key={k} className="mr-3">
                        <span className="inline-block w-2 h-2 rounded-full align-middle mr-1" style={{ backgroundColor: GREEK_COLORS[k] }} />
                        <span className="text-[var(--text-muted)]">{k.charAt(0).toUpperCase() + k.slice(1)}</span>{' '}
                        <span className={`font-medium ${(greeksTooltipValues[k] ?? 0) >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {(greeksTooltipValues[k] ?? 0) >= 0 ? '+' : ''}{k === 'gamma' ? (greeksTooltipValues[k] ?? 0).toFixed(4) : (greeksTooltipValues[k] ?? 0).toFixed(2)}
                        </span>
                      </span>
                    ))}</span>
                  : <span className="text-[var(--text-muted)]">Greeks over time</span>
                }
              </div>
              {greeksTooltipPos && greeksTooltipValues && (
                <div className="absolute z-50 pointer-events-none"
                  style={{
                    left: greeksTooltipPos.x > (greeksChartContainerRef.current?.clientWidth ?? 800) * 0.6 ? greeksTooltipPos.x - 200 : greeksTooltipPos.x + 20,
                    top: Math.max(8, Math.min(greeksTooltipPos.y - 30, greeksChartHeight - 100)),
                  }}>
                  <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[150px]">
                    {greeksCrosshairTime && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">{greeksCrosshairTime}</div>}
                    {(['delta', 'gamma', 'theta', 'vega'] as const).filter(k => selectedGreeks.has(k) && greeksTooltipValues[k] != null).map(k => (
                      <div key={k} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
                        <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: GREEK_COLORS[k] }} />
                          {k.charAt(0).toUpperCase() + k.slice(1)}
                        </span>
                        <span className={`font-medium tabular-nums ${(greeksTooltipValues[k] ?? 0) >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                          {(greeksTooltipValues[k] ?? 0) >= 0 ? '+' : ''}{k === 'gamma' ? (greeksTooltipValues[k] ?? 0).toFixed(4) : (greeksTooltipValues[k] ?? 0).toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        <div onMouseDown={orderBookCollapsed ? undefined : onObDividerDown}
          className={`group h-2 shrink-0 flex items-center justify-center bg-[var(--bg-secondary)] transition-colors z-20 relative ${orderBookCollapsed ? '' : 'hover:bg-[var(--accent)]/20 cursor-row-resize'}`}>
          {!orderBookCollapsed && <div className="w-10 h-0.5 rounded-full bg-[var(--border)] group-hover:bg-[var(--accent)]" />}
        </div>

        <div style={{ height: effectiveObHeight }} className="shrink-0 flex flex-col overflow-hidden bg-[var(--bg-primary)] border-t border-[var(--border)]">
          <div className="h-8 shrink-0 flex items-center px-3 gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
            {(['open', 'closed'] as const).map(t => (
              <button key={t} onClick={() => setPosSubTab(t)}
                className={`px-3 py-0.5 rounded text-[11px] font-semibold transition-all ${
                  posSubTab === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}>
                {t === 'open' ? `Open ${positions.length}` : `Closed ${closedPositions.length}`}
              </button>
            ))}
            <span className="ml-auto text-[11px] text-[var(--text-muted)]">
              Strategy P&L: <span className={strategyPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{strategyPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(strategyPnl))}</span>
            </span>
            <button onClick={() => setOrderBookCollapsed(v => !v)}
              className="w-5 h-5 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-[12px] transition-colors"
              title={orderBookCollapsed ? 'Expand' : 'Collapse'}>
              {orderBookCollapsed ? '▲' : '▼'}
            </button>
          </div>

          {!orderBookCollapsed && (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
                  <tr className="text-[var(--text-muted)]">
                    {(posSubTab === 'open'
                      ? ['Symbol', 'Product', 'Side', 'Qty', 'Entry Price', 'LTP', 'P&L', 'P&L %', 'Entry Time', 'Margin']
                      : ['Symbol', 'Product', 'Entry Price', 'Exit Price', 'P&L', 'Entry Time', 'Exit Time']
                    ).map(h => (
                      <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {displayPositions.length === 0 && (
                    <tr><td colSpan={10} className="text-center py-6 text-[var(--text-muted)]">No {posSubTab} positions for this strategy</td></tr>
                  )}
                  {posSubTab === 'open' && positions.map(p => {
                    const side = (p.order_side || '').includes('BUY') ? 'BUY' : 'SELL';
                    const pnl = calcPnl(p);
                    const pnlPct = (p.avg_price || 0) > 0 ? ((p.last_traded_price || 0) - (p.avg_price || 0)) / (p.avg_price || 1) * 100 * (side === 'BUY' ? 1 : -1) : 0;
                    const legMeta = legMetas.find(l => l.refId === p.ref_id);
                    return (
                      <tr key={p.ref_id} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                        <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)] whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {legMeta && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: legMeta.color }} />}
                            {p.display_name || p.zanskar_name || p.ref_id}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.product || 'NRML'}</td>
                        <td className={`px-3 py-1.5 font-semibold ${side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{side}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.qty}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.avg_price)}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.last_traded_price)}</td>
                        <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}</td>
                        <td className={`px-3 py-1.5 ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.entry_time)}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.margin_required ? `₹${fmtPrice(p.margin_required / 100)}` : '—'}</td>
                      </tr>
                    );
                  })}
                  {posSubTab === 'closed' && closedPositions.map(p => {
                    const pnl = (p.realised_pnl || p.pnl || 0) / 100;
                    const legMeta = legMetas.find(l => l.refId === p.ref_id);
                    return (
                      <tr key={`${p.ref_id}-closed`} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                        <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)] whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            {legMeta && <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: legMeta.color }} />}
                            {p.display_name || p.zanskar_name || p.ref_id}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.product || 'NRML'}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.avg_price)}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.exit_price ? paise(p.exit_price) : '—'}</td>
                        <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.entry_time)}</td>
                        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.exit_time)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
