import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
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
  chartFrom: number;
  chartTo: number;
  marketClose: number;
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
  const [chartData, setChartData] = useState<ChartDataCache | null>(null);
  const chartDataRef = useRef<ChartDataCache | null>(null);
  chartDataRef.current = chartData;
  const positionsRef = useRef<PaperPosition[]>([]);
  positionsRef.current = positions;
  const allPositionsRef = useRef<PaperPosition[]>([]);
  const legMetasRef = useRef<LegMeta[]>([]);

  // ── Chart display state ──
  const [pnlHeight, setPnlHeight] = useState(200);
  const [orderBookHeight, setOrderBookHeight] = useState(200);
  const [pnlVisible, setPnlVisible] = useState(true);
  const [orderBookCollapsed, setOrderBookCollapsed] = useState(false);

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
  const [legVisibility, setLegVisibility] = useState<Record<number, boolean>>({});
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
    setLegVisibility(prev => {
      const next = { ...prev };
      for (const l of legMetas) {
        if (!(l.refId in next)) next[l.refId] = true;
      }
      return next;
    });
  }, [legMetas]);

  // ── Fetch positions and orders ──
  const fetchData = useCallback(async () => {
    try {
      const [openRes, closedRes, ordersRes] = await Promise.all([
        fetch('/paper/positions'),
        fetch('/paper/positions/closed'),
        fetch('/paper/orders?executed=1'),
      ]);
      if (openRes.ok) {
        const d = await openRes.json() as { portfolio?: { stock_positions?: PaperPosition[] } } | PaperPosition[];
        const all = Array.isArray(d) ? d : (d.portfolio?.stock_positions ?? []);
        setPositions(all.filter(p => p.basket_group_id === basketGroupId));
      }
      if (closedRes.ok) {
        const d = await closedRes.json() as PaperPosition[];
        setClosedPositions((Array.isArray(d) ? d : []).filter(p => p.basket_group_id === basketGroupId));
      }
      if (ordersRes.ok) {
        const d = await ordersRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        const all = Array.isArray(d) ? d : (d.orders ?? []);
        setOrders(all.filter(o => o.basket_group_id === basketGroupId));
      }
      setDataLoaded(true);
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

  // ── 1. Create price chart ──
  useEffect(() => {
    if (!priceChartContainerRef.current) return;
    const isDark = theme === 'dark';
    const chart = createChart(priceChartContainerRef.current, chartOpts(isDark));
    priceChartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceLineVisible: true, lastValueVisible: true,
      title: underlying || 'Underlying',
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
      const bar = param.seriesData.get(candleSeries) as any;
      if (bar) {
        if (bar.open != null) setOhlc({ o: bar.open, h: bar.high, l: bar.low, c: bar.close });
        else if (bar.value != null) setOhlc({ o: bar.value, h: bar.value, l: bar.value, c: bar.value });
      }
      const legs: Array<{ name: string; color: string; value: number }> = [];
      for (const [refId, s] of seriesRef.current.legPrice) {
        const d = param.seriesData.get(s) as any;
        if (d?.value != null) {
          const meta = legMetasRef.current.find(l => l.refId === refId);
          if (meta) legs.push({ name: meta.displayName, color: meta.color, value: d.value });
        }
      }
      setLegPrices(legs);
    });

    // Restore cached data (handles theme change without re-fetch)
    const cached = chartDataRef.current;
    if (cached) {
      candleSeries.setData(cached.underlyingBars as any);
      for (const leg of legMetasRef.current) {
        const s = chart.addSeries(LineSeries, {
          color: leg.color, lineWidth: 1, priceScaleId: 'legs',
          title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
        });
        seriesRef.current.legPrice.set(leg.refId, s);
        const data = cached.legPriceData.get(leg.refId);
        if (data) s.setData(data);
      }
      try { chart.priceScale('legs').applyOptions({ scaleMargins: { top: 0.6, bottom: 0.05 } }); } catch {}
      requestAnimationFrame(() => chart.timeScale().fitContent());
    }

    return () => {
      seriesRef.current.underlying = null;
      seriesRef.current.legPrice.clear();
      chart.remove();
      priceChartRef.current = null;
    };
  }, [theme, underlying]);

  // ── 2. Create P&L chart ──
  useEffect(() => {
    if (!pnlChartContainerRef.current || !pnlVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(pnlChartContainerRef.current, chartOpts(isDark));
    pnlChartRef.current = chart;

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
    };
  }, [theme, pnlVisible]);

  // ── 3a. Fetch historical data (stores in state — decoupled from chart refs) ──
  useEffect(() => {
    console.log('[3a] ENTER: dataLoaded=', dataLoaded, 'underlying=', underlying);
    if (!dataLoaded || !underlying) return;
    const positions = allPositionsRef.current;
    const metas = legMetasRef.current;
    console.log('[3a] positions=', positions.length, 'metas=', metas.length);
    if (positions.length === 0 || metas.length === 0) return;

    const entryTimes = positions.map(p => p.entry_time || 0).filter(t => t > 0);
    const exitTimes = positions.map(p => p.exit_time || 0).filter(t => t > 0);
    console.log('[3a] entryTimes=', entryTimes.length, 'exitTimes=', exitTimes.length);
    if (entryTimes.length === 0) return;

    const earliestNs = Math.min(...entryTimes);
    const latestNs = exitTimes.length > 0 ? Math.max(...exitTimes) : 0;
    const entryDate = new Date(earliestNs / 1_000_000);
    const marketClose = Date.UTC(entryDate.getFullYear(), entryDate.getMonth(), entryDate.getDate(), 10, 0, 0) / 1000 + IST_OFFSET;
    const chartFrom = Math.floor(earliestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET;
    const chartTo = latestNs > 0
      ? Math.min(Math.ceil(latestNs / 1_000_000_000 / 60) * 60 + IST_OFFSET, marketClose)
      : marketClose;
    const startDate = new Date(earliestNs / 1_000_000 - 30 * 60 * 1000);
    const endDate = latestNs > 0 ? new Date(latestNs / 1_000_000 + 30 * 60 * 1000) : new Date();
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
      console.log('[3a] FETCHED: underlying=', underlyingRaw.length, 'legs=', legResults.map(r => `${r.leg.displayName}:${r.bars.length}`));

      const underlyingBars = underlyingRaw.filter(b => b.time >= chartFrom && b.time <= chartTo);
      const legPriceData = new Map<number, Array<{ time: any; value: number }>>();
      const legPnlData = new Map<number, Array<{ time: any; value: number }>>();
      const pnlByTime = new Map<number, Map<number, number>>();

      for (const { leg, bars } of legResults) {
        const active = bars.filter(b => b.time >= chartFrom && b.time <= chartTo);
        if (active.length === 0) continue;
        legPriceData.set(leg.refId, active.map(b => ({ time: b.time as any, value: b.close })));
        const pos = positions.find(p => p.ref_id === leg.refId);
        if (pos) {
          const side = (pos.order_side || '').includes('BUY') ? 1 : -1;
          const avgPrice = (pos.avg_price || 0) / 100;
          const qty = pos.qty || 0;
          legPnlData.set(leg.refId, active.map(b => ({
            time: b.time as any, value: side * (b.close - avgPrice) * qty,
          })));
          for (const b of active) {
            if (!pnlByTime.has(b.time)) pnlByTime.set(b.time, new Map());
            pnlByTime.get(b.time)!.set(leg.refId, side * (b.close - avgPrice) * qty);
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

      if (!cancelled) {
        console.log('[3a] SETTING chartData: UL=', underlyingBars.length, 'legPrice=', [...legPriceData.entries()].map(([k,v]) => `${k}:${v.length}`), 'legPnl=', [...legPnlData.entries()].map(([k,v]) => `${k}:${v.length}`), 'basket=', basketPnlData.length);
        setChartData({ underlyingBars, legPriceData, legPnlData, basketPnlData, chartFrom, chartTo, marketClose });
      }
    })();
    return () => { cancelled = true; };
  }, [dataLoaded, underlying]);

  // ── 3b. Apply fetched data to existing charts ──
  useEffect(() => {
    console.log('[3b] ENTER: chartData=', !!chartData, 'priceChart=', !!priceChartRef.current, 'pnlChart=', !!pnlChartRef.current);
    if (!chartData) return;

    const priceChart = priceChartRef.current;
    if (priceChart && seriesRef.current.underlying) {
      seriesRef.current.underlying.setData(chartData.underlyingBars as any);
      for (const leg of legMetasRef.current) {
        if (!seriesRef.current.legPrice.has(leg.refId)) {
          const s = priceChart.addSeries(LineSeries, {
            color: leg.color, lineWidth: 1, priceScaleId: 'legs',
            title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
          });
          seriesRef.current.legPrice.set(leg.refId, s);
        }
        const data = chartData.legPriceData.get(leg.refId);
        if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(data);
      }
      try { priceChart.priceScale('legs').applyOptions({ scaleMargins: { top: 0.6, bottom: 0.05 } }); } catch {}

      for (const p of allPositionsRef.current) {
        const series = seriesRef.current.legPrice.get(p.ref_id);
        if (!series) continue;
        const entryPrice = (p.avg_price || 0) / 100;
        if (entryPrice > 0) {
          series.createPriceLine({
            price: entryPrice,
            color: (p.order_side || '').includes('BUY') ? '#22c55e' : '#ef4444',
            lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
            title: `Entry ${(p.order_side || '').includes('BUY') ? '▲' : '▼'}`,
          });
        }
        if (p.exit_price) {
          series.createPriceLine({
            price: p.exit_price / 100,
            color: '#9ca3af', lineWidth: 1, lineStyle: 2,
            axisLabelVisible: true, title: 'Exit',
          });
        }
      }
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
    const pc = priceChartRef.current;
    const pnl = pnlChartRef.current;
    if (!pc || !pnl) return;
    let syncing = false;
    const handler1 = (range: any) => {
      if (syncing || !range) return;
      syncing = true;
      try { pnl.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing = false;
    };
    const handler2 = (range: any) => {
      if (syncing || !range) return;
      syncing = true;
      try { pc.timeScale().setVisibleLogicalRange(range); } catch {}
      syncing = false;
    };
    pc.timeScale().subscribeVisibleLogicalRangeChange(handler1);
    pnl.timeScale().subscribeVisibleLogicalRangeChange(handler2);
    return () => {
      try { pc.timeScale().unsubscribeVisibleLogicalRangeChange(handler1); } catch {}
      try { pnl.timeScale().unsubscribeVisibleLogicalRangeChange(handler2); } catch {}
    };
  }, [pnlVisible]);

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
    });
    if (priceChartContainerRef.current) ro.observe(priceChartContainerRef.current);
    if (pnlChartContainerRef.current) ro.observe(pnlChartContainerRef.current);
    return () => ro.disconnect();
  }, [pnlVisible]);

  // ── 6. Live WebSocket updates (charts) ──
  useEffect(() => {
    const unsub1 = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !underlying || !seriesRef.current.underlying) return;
      const data = msg.data as { indexes?: Array<{ indexname?: string; timestamp?: string; open?: string; high?: string; low?: string; close?: string }> };
      const idx = data.indexes?.find(i => (i.indexname || '').toUpperCase() === underlying.toUpperCase());
      if (!idx?.timestamp) return;
      const t = Number(BigInt(idx.timestamp)) / 1e9 + IST_OFFSET;
      const cached = chartDataRef.current;
      if (cached && (t < cached.chartFrom || t > cached.marketClose)) return;
      seriesRef.current.underlying.update({
        time: t as any,
        open: parseFloat(idx.open || '0') / 100,
        high: parseFloat(idx.high || '0') / 100,
        low: parseFloat(idx.low || '0') / 100,
        close: parseFloat(idx.close || '0') / 100,
      });
    });

    const processLtp = (ltpMap: Map<number, number>) => {
      const t = nowChartTime();
      const cached = chartDataRef.current;
      if (cached && (t < cached.chartFrom || t > cached.marketClose)) return;
      let totalPnl = 0;
      for (const p of positionsRef.current) {
        const ltp = ltpMap.get(p.ref_id);
        if (ltp == null) continue;
        seriesRef.current.legPrice.get(p.ref_id)?.update({ time: t as any, value: ltp / 100 });
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
  useEffect(() => { seriesRef.current.underlying?.applyOptions({ visible: visibility.underlying }); }, [visibility.underlying]);
  useEffect(() => { seriesRef.current.basketPnl?.applyOptions({ visible: visibility.basketPnl }); }, [visibility.basketPnl]);
  useEffect(() => {
    for (const leg of legMetas) {
      const vis = legVisibility[leg.refId] !== false;
      seriesRef.current.legPrice.get(leg.refId)?.applyOptions({ visible: vis });
      seriesRef.current.legPnl.get(leg.refId)?.applyOptions({ visible: vis });
    }
  }, [legVisibility, legMetas]);

  const toggleVis = useCallback((key: string) => { setVisibility(prev => ({ ...prev, [key]: !prev[key] })); }, []);
  const toggleLeg = useCallback((refId: number) => { setLegVisibility(prev => ({ ...prev, [refId]: !(prev[refId] !== false) })); }, []);

  // ── Divider drag handlers ──
  const onPnlDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY; const startH = pnlHeight;
    const onMove = (ev: MouseEvent) => { setPnlHeight(Math.max(80, startH - (ev.clientY - startY))); };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  }, [pnlHeight]);

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
  const displayPositions = posSubTab === 'open' ? positions : closedPositions;
  const effectiveObHeight = orderBookCollapsed ? 32 : orderBookHeight;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] text-[var(--text-primary)] overflow-hidden">
      {/* Header */}
      <div className="h-10 shrink-0 flex items-center px-4 border-b border-[var(--border)] bg-[var(--bg-secondary)] gap-3">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
          <span className="text-[16px]">←</span> Back
        </button>
        <div className="w-px h-5 bg-[var(--border)]" />
        <span className="text-[13px] font-semibold text-[var(--accent)]">{strategyName}</span>
        <span className="text-[11px] text-[var(--text-muted)]">({legMetas.length} legs)</span>
        {underlying && <span className="text-[11px] text-[var(--text-muted)] bg-[var(--bg-hover)] px-2 py-0.5 rounded">{underlying}</span>}
        <span className={`ml-auto text-[12px] font-semibold ${strategyPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
          P&L: {strategyPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(strategyPnl))}
        </span>
      </div>
      {/* Legend */}
      <div className="h-8 shrink-0 flex items-center px-4 gap-2 border-b border-[var(--border)] bg-[var(--bg-secondary)] overflow-x-auto">
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
          <button key={leg.refId} onClick={() => toggleLeg(leg.refId)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
              legVisibility[leg.refId] !== false ? 'border-white/20 bg-white/5 text-[var(--text-primary)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
            }`}>
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: legVisibility[leg.refId] !== false ? leg.color : 'transparent', border: `1px solid ${leg.color}` }} />
            {leg.displayName}
          </button>
        ))}
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <button onClick={() => toggleVis('basketPnl')}
          className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
            visibility.basketPnl ? 'border-white/40 bg-white/10 text-white' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] line-through'
          }`}>Total P&L</button>
        <button onClick={() => setPnlVisible(v => !v)}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
            pnlVisible ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
          }`}>P&L Chart</button>
        <button onClick={() => toggleVis('entryMarkers')}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-colors border ${
            visibility.entryMarkers ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]' : 'border-[var(--border)] bg-transparent text-[var(--text-muted)]'
          }`}>Markers</button>
      </div>

      {/* Charts + order book */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Price chart */}
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
              <div className="bg-[#1a1e24]/95 border border-[#2a2f38] rounded-lg px-3 py-2 shadow-2xl backdrop-blur-sm min-w-[200px]">
                {crosshairTimeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#2a2f38] pb-1 mb-1.5 font-mono">{crosshairTimeStr}</div>}
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

        {pnlVisible && (
          <>
            <div onMouseDown={onPnlDividerDown} className="h-1 shrink-0 bg-[var(--border)] hover:bg-[var(--accent)] cursor-row-resize transition-colors" />
            {/* P&L chart */}
            <div ref={pnlChartContainerRef} className="relative shrink-0 bg-[var(--bg-primary)]" style={{ height: pnlHeight }}>
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
                  <div className="bg-[#1a1e24]/95 border border-[#2a2f38] rounded-lg px-3 py-2 shadow-2xl backdrop-blur-sm min-w-[200px]">
                    {pnlCrosshairTimeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#2a2f38] pb-1 mb-1.5 font-mono">{pnlCrosshairTimeStr}</div>}
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
                    <div className="flex items-center justify-between gap-4 text-[11px] pt-1 mt-1 border-t border-[#2a2f38] font-semibold">
                      <span className="text-[var(--text-secondary)]">Total P&L</span>
                      <span className={pnlValues.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                        {pnlValues.total >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnlValues.total))}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        <div onMouseDown={orderBookCollapsed ? undefined : onObDividerDown}
          className={`h-1 shrink-0 bg-[var(--border)] transition-colors ${orderBookCollapsed ? '' : 'hover:bg-[var(--accent)] cursor-row-resize'}`} />

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
