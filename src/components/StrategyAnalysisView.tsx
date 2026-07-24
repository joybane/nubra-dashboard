import React, { useCallback, useEffect, useMemo, useRef, useState, memo, forwardRef, useImperativeHandle } from 'react';
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
  // When set, render a frozen saved snapshot instead of fetching/streaming live data.
  snapshotId?: string;
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
  const s = Math.floor(Date.now() / 1000) + IST_OFFSET;
  return Math.floor(s / 60) * 60;
}

// Append/replace the trailing cache point, mirroring lightweight-charts' series.update() (same time →
// overwrite, newer → append, older → ignore). Keeps the chartData cache complete with live ticks so a
// snapshot saved mid-session captures everything on screen, not just the initial historical backfill.
function upsertPoint(arr: Array<{ time: any; value: number }>, time: number, value: number): void {
  const last = arr[arr.length - 1];
  if (last && last.time === time) last.value = value;
  else if (!last || time > last.time) arr.push({ time, value });
}
function upsertGreekPoint(
  arr: Array<{ time: number; delta: number; gamma: number; theta: number; vega: number }>,
  point: { time: number; delta: number; gamma: number; theta: number; vega: number },
): void {
  const last = arr[arr.length - 1];
  if (last && last.time === point.time) Object.assign(last, point);
  else if (!last || point.time > last.time) arr.push(point);
}
function upsertBar(arr: HistBar[], bar: HistBar): void {
  const last = arr[arr.length - 1];
  if (last && last.time === bar.time) { last.open = bar.open; last.high = bar.high; last.low = bar.low; last.close = bar.close; }
  else if (!last || bar.time > last.time) arr.push(bar);
}

// Fill a P&L data series over the full underlying time grid (09:15 to session close).
// P&L before entry time defaults to 0, and holds its value for un-ticked minutes so lightweight-charts
// creates a 1-to-1 matching bar index array starting at 09:15 for 100% perfect multi-pane alignment.
function fillPnlToGrid(
  grid: number[],
  data: Array<{ time: any; value: number }>,
): Array<{ time: any; value: number }> {
  if (grid.length === 0) return data;
  if (data.length === 0) return grid.map(t => ({ time: t as any, value: 0 }));

  const valMap = new Map<number, number>();
  for (const d of data) {
    if (d && d.time != null) valMap.set(Number(d.time), d.value);
  }

  const firstTime = Number(data[0].time ?? 0);
  const result: Array<{ time: any; value: number }> = [];
  let currentVal = 0;

  for (const t of grid) {
    if (valMap.has(t)) {
      currentVal = valMap.get(t)!;
      result.push({ time: t as any, value: currentVal });
    } else if (t < firstTime) {
      result.push({ time: t as any } as any);
    } else {
      result.push({ time: t as any, value: currentVal });
    }
  }
  return result;
}

// Fill a Greek series over the full underlying time grid (09:15 to session close).
// Forward-fills the initial value to 09:15 and holds across un-ticked minutes so lightweight-charts
// creates an identical 1-to-1 bar index mapping (index 0 = 09:15) matching the candlestick chart.
function fillGreeksToGrid(
  grid: number[],
  byTime: Map<number, { delta: number; gamma: number; theta: number; vega: number }>,
  greekKey: 'delta' | 'gamma' | 'theta' | 'vega',
  factor: { mid: number; half: number },
): Array<{ time: any; value: number }> {
  if (grid.length === 0) return [];
  const times = [...byTime.keys()].sort((a, b) => a - b);
  if (times.length === 0) return grid.map(t => ({ time: t as any, value: 0 }));

  const firstTime = times[0];
  const firstVal = (byTime.get(firstTime)![greekKey] - factor.mid) / factor.half;
  const result: Array<{ time: any; value: number }> = [];
  let currentVal = firstVal;

  for (const t of grid) {
    const pt = byTime.get(t);
    if (pt != null && pt[greekKey] != null) {
      currentVal = (pt[greekKey] - factor.mid) / factor.half;
      result.push({ time: t as any, value: currentVal });
    } else if (t < firstTime) {
      result.push({ time: t as any } as any);
    } else {
      result.push({ time: t as any, value: currentVal });
    }
  }
  return result;
}

function safeSetVisibleLogicalRange(chart: IChartApi | null | undefined, range: any): void {
  if (!chart || !range) return;
  try {
    chart.timeScale().setVisibleLogicalRange(range);
  } catch (e) {
    // Ignore disposed chart calls safely
  }
}

const LEG_COLORS = ['#22c55e', '#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const CALL_LEG_COLOR = '#22c55e';
const PUT_LEG_COLOR = '#ef4444';

function optionTypeForColor(p: PaperPosition): string {
  const explicit = String(p.option_type || '').toUpperCase();
  if (explicit === 'CE' || explicit === 'PE') return explicit;
  const text = `${p.display_name || ''} ${p.zanskar_name || ''}`.toUpperCase();
  const m = text.match(/\b(CE|PE)\b|(\d+)(CE|PE)$/);
  return (m?.[1] || m?.[3] || '').toUpperCase();
}

function legColor(p: PaperPosition, fallbackIndex: number): string {
  const optType = optionTypeForColor(p);
  if (optType === 'CE') return CALL_LEG_COLOR;
  if (optType === 'PE') return PUT_LEG_COLOR;
  return LEG_COLORS[fallbackIndex % LEG_COLORS.length];
}

function positionGreekSource(p: PaperPosition): 'CE' | 'PE' | null {
  const optType = optionTypeForColor(p);
  return optType === 'CE' || optType === 'PE' ? optType : null;
}

function parsePositionOption(p: PaperPosition): { symbol?: string; strike?: number; optionType?: 'CE' | 'PE' } {
  const explicitType = String(p.option_type || '').toUpperCase();
  const text = `${p.display_name || ''} ${p.zanskar_name || ''}`.toUpperCase();
  const optMatch = text.match(/\b(CE|PE)\b|(\d+)(CE|PE)$/);
  const optionType = explicitType === 'CE' || explicitType === 'PE'
    ? explicitType
    : ((optMatch?.[1] || optMatch?.[3]) as 'CE' | 'PE' | undefined);
  const strike = Number(p.strike_price || (text.match(/(\d+(?:\.\d+)?)\s*(?:CE|PE)\b/)?.[1] ?? 0));
  const symbol = String(p.display_name || p.zanskar_name || '')
    .trim()
    .split(/\s+/)[0]
    ?.replace(/\d.*$/, '')
    .toUpperCase();
  return { symbol: symbol || undefined, strike: strike > 0 ? strike : undefined, optionType };
}

async function fetchStrategyMarginPaise(positions: PaperPosition[]): Promise<number> {
  const orders = positions
    .filter(p => p.ref_id && p.qty)
    .map(p => {
      const opt = parsePositionOption(p);
      return {
        ref_id: p.ref_id,
        order_qty: Math.abs(p.qty),
        strike: opt.strike,
        option_type: opt.optionType,
        ltp: (p.last_traded_price || p.avg_price || 0) / 100,
        lot_size: p.lot_size,
        expiry: p.expiry,
        symbol: opt.symbol,
        order_side: (p.order_side || '').includes('BUY') ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
        order_delivery_type: p.product === 'MIS' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
      };
    });
  if (!orders.length) return 0;
  const res = await fetch('/paper/margin/basket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange: 'NSE', multiplier: 1, orders }),
  });
  if (!res.ok) return 0;
  const data = await res.json() as Record<string, unknown>;
  return Number(data.total_margin ?? 0);
}

const DEFAULT_LOT_SIZES: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120, SENSEX: 20 };
const MONTH_CODES: Record<string, string> = { '1':'01','2':'02','3':'03','4':'04','5':'05','6':'06','7':'07','8':'08','9':'09','O':'10','N':'11','D':'12' };
const GREEK_SOURCES = ['net', 'CE', 'PE'] as const;
type GreekSource = typeof GREEK_SOURCES[number];
type GreekKey = 'delta' | 'gamma' | 'theta' | 'vega';
const GREEK_LINE_STYLES: Record<string, number> = { net: 0, CE: 2, PE: 1 };
const GREEK_LINE_WIDTHS: Record<string, 1 | 2> = { net: 2, CE: 1, PE: 1 };

function activeGreekSource(filter: Set<string>): GreekSource {
  for (const src of GREEK_SOURCES) if (filter.has(src)) return src;
  return 'net';
}


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
            const tsNs = opens[i]?.ts;
            if (tsNs == null) continue;
            const oVal = opens[i]?.v, hVal = highs[i]?.v, lVal = lows[i]?.v, cVal = closes[i]?.v;
            if (oVal == null || hVal == null || lVal == null || cVal == null) continue;
            const o = Number(oVal) / 100, h = Number(hVal) / 100, l = Number(lVal) / 100, c = Number(cVal) / 100;
            if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c) || o <= 0 || c <= 0) continue;
            const t = toChartTime(BigInt(tsNs), interval) as number;
            bars.push({ time: t, open: o, high: Math.max(h, o, l, c), low: Math.min(l, o, h, c), close: c });
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

function chartOpts(isDark: boolean, hideTimeScale: boolean = false, showLeftScale: boolean = false) {
  return {
    autoSize: true,
    devicePixelRatio: Math.max(window.devicePixelRatio, 2),
    layout: {
      background: { color: isDark ? '#0d0f11' : '#ffffff' },
      textColor: isDark ? '#c9d1d9' : '#131722',
      fontSize: 11,
      fontFamily: "'Inter', 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif",
    },
    grid: {
      vertLines: { color: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)', style: 1 as const },
      horzLines: { color: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.04)', style: 1 as const },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: isDark ? '#4b5563' : '#9ca3af', width: 1 as const, style: 2 as const, labelBackgroundColor: isDark ? '#22262b' : '#e8ecf5' },
      horzLine: { color: isDark ? '#3b82f6' : '#2563eb', width: 1 as const, style: 2 as const, labelBackgroundColor: '#2563eb' },
    },
    leftPriceScale: {
      visible: showLeftScale,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 60,
    },
    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 75,
    },
    timeScale: {
      visible: !hideTimeScale,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      timeVisible: !hideTimeScale,
      secondsVisible: false,
    },
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

// Serializable snapshot payload (Maps → entries arrays). Must match server/snapshotBuilder.ts.
interface SnapshotData {
  version: 1;
  underlying: string | null;
  positions: PaperPosition[];
  closedPositions: PaperPosition[];
  chart: {
    underlyingBars: HistBar[];
    legPriceData: Array<[number, Array<{ time: number; value: number }>]>;
    legPnlData: Array<[number, Array<{ time: number; value: number }>]>;
    basketPnlData: Array<{ time: number; value: number }>;
    legGreeksHist: Array<[number, Array<{ time: number; delta: number; gamma: number; theta: number; vega: number }>]>;
    pnlFrom: number; pnlTo: number; sessionOpen: number; sessionClose: number;
  };
}

// IST calendar date (YYYY-MM-DD) of an epoch-ns timestamp — must match server istDateString().
function istDateFromNs(ns: number): string {
  const d = new Date(ns / 1_000_000 + IST_OFFSET * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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
import { PriceTooltip, PnlTooltip, GreeksTooltip, PriceTooltipRef, PnlTooltipRef, GreeksTooltipRef } from './ChartTooltips';

export default function StrategyAnalysisView({ basketGroupId, strategyName, theme, onBack, snapshotId }: StrategyAnalysisViewProps) {
  const { subscribe, subscribeChart, unsubscribeChart, subscribeOC, unsubscribeOC } = useWs();
  const isSnapshot = !!snapshotId;

  // ── Position / order state ──
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const [posSubTab, setPosSubTab] = useState<'open' | 'closed'>('open');
  const [dataLoaded, setDataLoaded] = useState(false);

  // ── Chart refs (grouped) ──
  const priceChartContainerRef = useRef<HTMLDivElement>(null);
  const pnlChartContainerRef = useRef<HTMLDivElement>(null);
  const chartsWrapperRef = useRef<HTMLDivElement>(null);
  const priceChartRef = useRef<IChartApi | null>(null);
  const pnlChartRef = useRef<IChartApi | null>(null);
  // Tracks which pane the OS cursor is actually over. Live data updates (series.update())
  // make lightweight-charts internally re-fire crosshairMove on any pane holding a saved
  // crosshair position (including the synthetic one we push onto the other two panes) —
  // this ref lets onCrosshairMove tell a real hover from that spurious self-echo.
  const hoveredChartRef = useRef<IChartApi | null>(null);
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
  const hasInitialFittedRef = useRef(false);
  useEffect(() => {
    hasInitialFittedRef.current = false;
  }, [basketGroupId, snapshotId]);
  // Bumped whenever any chart is created/destroyed, so the scroll-sync effect re-runs once all
  // currently-visible charts actually exist (chart creation effects run after the sync effect).
  const [chartEpoch, setChartEpoch] = useState(0);
  const positionsRef = useRef<PaperPosition[]>([]);
  positionsRef.current = positions;
  const closedPositionsRef = useRef<PaperPosition[]>([]);
  closedPositionsRef.current = closedPositions;
  const allPositionsRef = useRef<PaperPosition[]>([]);
  const expiryCacheRef = useRef<Map<string, string>>(new Map());
  const legMetasRef = useRef<LegMeta[]>([]);
  const markersRef = useRef<Array<{ detach: () => void }>>([]);
  // Latest live LTP (paise) per leg ref_id. A tick batch usually carries only the leg(s)
  // that just moved, so the basket total must sum ALL legs from their last-known LTP — not
  // just the batch — or the live tip spikes to a single leg's P&L.
  const lastLtpRef = useRef<Map<number, number>>(new Map());

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
  const greeksTooltipRef = useRef<GreeksTooltipRef>(null);
  const [currentGreeksBySource, setCurrentGreeksBySource] = useState<Record<GreekSource, Record<GreekKey, number>>>({
    net: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    CE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    PE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
  });


  // ── Chart display state ──
  const [pnlHeight, setPnlHeight] = useState(200);
  const [orderBookHeight, setOrderBookHeight] = useState(200);

  const positionsPaneRef = useRef<HTMLDivElement>(null);
  const [priceVisible, setPriceVisible] = useState(true);
  const [pnlVisible, setPnlVisible] = useState(true);
  const [orderBookCollapsed, setOrderBookCollapsed] = useState(false);
  const [chartsPopupOpen, setChartsPopupOpen] = useState(false);
  const [pnlPopupOpen, setPnlPopupOpen] = useState(false);

  const [strategyMarginPaise, setStrategyMarginPaise] = useState(0);

  const priceTooltipRef = useRef<PriceTooltipRef>(null);
  const pnlTooltipRef = useRef<PnlTooltipRef>(null);

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
        color: legColor(p, result.length),
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
        
        // Dynamically resolve missing expiries from the backend so Option Chain live WS works
        const missing = openPos.filter(p => !p.expiry && p.zanskar_name && /CE|PE$/.test(p.zanskar_name) && !expiryCacheRef.current.has(p.zanskar_name));
        if (missing.length > 0) {
          await Promise.all(missing.map(async p => {
            try {
              const res = await fetch(`/api/instruments/search?q=${encodeURIComponent(p.zanskar_name!)}&limit=1`);
              const searchData = await res.json() as { results: any[] };
              const match = searchData.results?.[0];
              if (match?.expiry) expiryCacheRef.current.set(p.zanskar_name!, match.expiry);
            } catch (e) {}
          }));
        }
        for (const p of openPos) {
          if (!p.expiry && p.zanskar_name && expiryCacheRef.current.has(p.zanskar_name)) {
            p.expiry = expiryCacheRef.current.get(p.zanskar_name);
          }
        }
        
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
        const parsedInfo = new Map<number, { expiry: string; strike: number; optType: string }>();
        const expiries = new Set<string>();
        for (const p of allPos) {
          if (p.expiry) { expiries.add(String(p.expiry)); continue; }
          const m = (p.zanskar_name || '').match(/^[A-Z]+(\d{2})([0-9OND])(\d{2})(\d+)(CE|PE)$/i);
          if (m) {
            const mm = MONTH_CODES[m[2].toUpperCase()] || '01';
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
    if (isSnapshot) return;            // frozen snapshot → no live polling
    fetchData();
    const t = setInterval(fetchData, 3000);
    return () => clearInterval(t);
  }, [fetchData, isSnapshot]);

  // ── Subscribe for live underlying ticks ──
  useEffect(() => {
    if (isSnapshot || !underlying) return;
    subscribeChart({ indexes: [underlying] }, '1m', 'NSE');
    return () => { unsubscribeChart({ indexes: [underlying] }, '1m', 'NSE'); };
  }, [underlying, subscribeChart, unsubscribeChart, isSnapshot]);

  // ── Subscribe option chain for strategy legs (ensures live ticks flow) ──
  useEffect(() => {
    if (isSnapshot || !underlying || positions.length === 0) return;
    const keys = new Set<string>();
    for (const p of positions) {
      const expiry = p.expiry;
      if (expiry) keys.add(`${underlying}:${expiry}`);
    }
    if (keys.size === 0) return;
    for (const key of keys) {
      const [asset, expiry] = key.split(':');
      subscribeOC(asset, expiry, 'NSE');
    }
    return () => {
      for (const key of keys) {
        const [asset, expiry] = key.split(':');
        unsubscribeOC(asset, expiry, 'NSE');
      }
    };
  }, [underlying, positions, subscribeOC, unsubscribeOC, isSnapshot]);

  // ════════════════════════════════════════════════════════════════════════════
  // CHART SECTION — rebuilt from scratch
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. Create price chart ──
  useEffect(() => {
    if (!priceChartContainerRef.current || !priceVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(priceChartContainerRef.current, chartOpts(isDark, false, true));
    priceChartRef.current = chart;
    setChartEpoch(e => e + 1);

    // NIFTY candles on primary right axis; option leg lines share left axis in ₹ (rupees).
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceLineVisible: true, lastValueVisible: true,
      title: underlying || 'Underlying',
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    } as Partial<CandlestickSeriesOptions>);
    seriesRef.current.underlying = candleSeries;

    // Crosshair '+' tooltip is driven centrally by the crosshair-sync effect (section 4).

    // Draw horizontal strike price lines on NIFTY candlestick chart
    for (const leg of legMetasRef.current) {
      const pos = allPositionsRef.current.find(p => p.ref_id === leg.refId);
      if (pos) {
        const opt = parsePositionOption(pos);
        if (opt.strike && opt.strike > 0) {
          try {
            candleSeries.createPriceLine({
              price: opt.strike,
              color: leg.color,
              lineWidth: 1,
              lineStyle: 2, // Dashed
              axisLabelVisible: true,
              title: `${opt.optionType || 'Leg'} ${opt.strike}`,
            });
          } catch {}
        }
      }
    }

    // Restore cached data
    const cached = chartDataRef.current;
    if (cached) {
      candleSeries.setData(cached.underlyingBars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })) as any);
      for (const leg of legMetasRef.current) {
        const s = chart.addSeries(LineSeries, {
          color: leg.color, lineWidth: 2, priceScaleId: 'left',
          title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
          priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
        });
        seriesRef.current.legPrice.set(leg.refId, s);
        const data = cached.legPriceData.get(leg.refId);
        if (data) s.setData(data.map(d => ({ time: d.time, value: d.value })));
      }
      try { chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } }); } catch {}
      try { chart.priceScale('left').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } }); } catch {}
      requestAnimationFrame(() => chart.timeScale().fitContent());
    }

    return () => {
      seriesRef.current.underlying = null;
      seriesRef.current.legPrice.clear();
      priceChartRef.current = null;
      try { chart.remove(); } catch {}
      setChartEpoch(e => e + 1);
    };
  }, [theme, underlying, priceVisible]);

  // ── 2. Create P&L chart ──
  useEffect(() => {
    if (!pnlChartContainerRef.current || !pnlVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(pnlChartContainerRef.current, chartOpts(isDark, false, true));
    pnlChartRef.current = chart;
    setChartEpoch(e => e + 1);

    const basketSeries = chart.addSeries(LineSeries, {
      color: '#ffffff', lineWidth: 3,
      title: 'Total P&L', lastValueVisible: true, priceLineVisible: true,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    seriesRef.current.basketPnl = basketSeries;

    // Create all leg P&L series
    for (const leg of legMetasRef.current) {
      const s = chart.addSeries(LineSeries, {
        color: leg.color, lineWidth: 2,
        title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
        priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
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

    // Crosshair '+' tooltip is driven centrally by the crosshair-sync effect (section 4).

    return () => {
      seriesRef.current.legPnl.clear();
      seriesRef.current.basketPnl = null;
      pnlChartRef.current = null;
      try { chart.remove(); } catch {}
      setChartEpoch(e => e + 1);
    };
  }, [theme, pnlVisible]);

  // ── 3a. Fetch historical data (stores in state — decoupled from chart refs) ──
  useEffect(() => {

    if (isSnapshot || !dataLoaded || !underlying) return;
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
                    const rawTs = dArr[i].ts;
                    let t = 0;
                    if (typeof rawTs === 'string' && rawTs.includes('T')) {
                      t = Math.floor(Date.parse(rawTs) / 1000) + IST_OFFSET;
                    } else {
                      t = toChartTime(BigInt(String(rawTs)), '1m') as number;
                    }
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
  }, [dataLoaded, underlying, isSnapshot]);

  // ── 3a-snapshot. Load a frozen saved snapshot ──
  useEffect(() => {
    if (!snapshotId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/paper/strategy/snapshot/${snapshotId}`);
        if (!res.ok) return;
        const snap = await res.json() as { data?: SnapshotData };
        const d = snap?.data;
        if (cancelled || !d?.chart) return;
        setPositions(d.positions || []);
        setClosedPositions(d.closedPositions || []);
        const c = d.chart;
        const cache: ChartDataCache = {
          underlyingBars: c.underlyingBars || [],
          legPriceData: new Map(c.legPriceData || []),
          legPnlData: new Map(c.legPnlData || []),
          basketPnlData: c.basketPnlData || [],
          legGreeksHist: new Map(c.legGreeksHist || []),
          pnlFrom: c.pnlFrom, pnlTo: c.pnlTo, sessionOpen: c.sessionOpen, sessionClose: c.sessionClose,
        };
        const g = new Map<number, { delta: number; gamma: number; theta: number; vega: number; iv: number }>();
        for (const [refId, pts] of cache.legGreeksHist) {
          const last = pts[pts.length - 1];
          if (last) g.set(refId, { delta: last.delta, gamma: last.gamma, theta: last.theta, vega: last.vega, iv: 0 });
        }
        if (g.size > 0) setLegGreeks(g);
        greeksFetchedRef.current = true;
        setDataLoaded(true);
        setChartData(cache);
      } catch (e) { console.warn('[StrategyAnalysis] snapshot load failed:', e); }
    })();
    return () => { cancelled = true; };
  }, [snapshotId]);

  // ── 3b. Apply fetched data to existing charts ──
  useEffect(() => {
    if (!chartData) return;

    const priceChart = priceChartRef.current;
    if (priceChart && seriesRef.current.underlying) {
      let savedRange: any = null;
      try { savedRange = priceChart.timeScale().getVisibleLogicalRange(); } catch {}

      seriesRef.current.underlying.setData(chartData.underlyingBars.map(b => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })) as any);
      for (const leg of legMetasRef.current) {
        if (!seriesRef.current.legPrice.has(leg.refId)) {
          const s = priceChart.addSeries(LineSeries, {
            color: leg.color, lineWidth: 2, priceScaleId: 'left',
            title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
            priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
          });
          seriesRef.current.legPrice.set(leg.refId, s);
        }
        const data = chartData.legPriceData.get(leg.refId);
        if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(data.map(d => ({ time: d.time, value: d.value })));
      }
      try { priceChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } }); } catch {}
      try { priceChart.priceScale('left').applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } }); } catch {}

      if (savedRange) {
        try { priceChart.timeScale().setVisibleLogicalRange(savedRange); } catch {}
      } else if (!hasInitialFittedRef.current) {
        requestAnimationFrame(() => priceChart.timeScale().fitContent());
      }
    }

    // Shared full-session grid
    const grid = chartData.underlyingBars.map(b => b.time as number);

    const pnlChart = pnlChartRef.current;
    if (pnlChart) {
      for (const leg of legMetasRef.current) {
        if (!seriesRef.current.legPnl.has(leg.refId)) {
          const s = pnlChart.addSeries(LineSeries, {
            color: leg.color, lineWidth: 2,
            title: leg.displayName, lastValueVisible: true, priceLineVisible: false,
            priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
          });
          seriesRef.current.legPnl.set(leg.refId, s);
        }
        const data = chartData.legPnlData.get(leg.refId);
        if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(fillPnlToGrid(grid, data) as any);
      }
      if (chartData.basketPnlData.length > 0) {
        seriesRef.current.basketPnl?.setData(fillPnlToGrid(grid, chartData.basketPnlData) as any);
      }
      const pc = priceChartRef.current;
      if (pc) {
        try {
          const r = pc.timeScale().getVisibleLogicalRange();
          if (r) safeSetVisibleLogicalRange(pnlChartRef.current, r);
        } catch (e) {}
      }
    }
  }, [chartData]);

  // ── 4. Chart scroll & crosshair sync ──
  useEffect(() => {
    const pc = priceChartRef.current;
    const nc = pnlChartRef.current;
    const gc = greeksChartRef.current;
    const charts = [pc, nc, gc].filter(Boolean) as IChartApi[];
    if (charts.length === 0) return;

    // Native hover tracking (see hoveredChartRef declaration) — independent of the
    // library's own event stream, which can misreport the active pane during live updates.
    const hoverTargets: Array<[HTMLDivElement | null, IChartApi]> = [
      [priceChartContainerRef.current, pc as IChartApi],
      [pnlChartContainerRef.current, nc as IChartApi],
      [greeksChartContainerRef.current, gc as IChartApi],
    ];
    const hoverCleanups: Array<() => void> = [];
    for (const [el, chart] of hoverTargets) {
      if (!el || !chart) continue;
      const onEnter = () => { hoveredChartRef.current = chart; };
      const onLeave = () => { if (hoveredChartRef.current === chart) hoveredChartRef.current = null; };
      el.addEventListener('mouseenter', onEnter);
      el.addEventListener('mouseleave', onLeave);
      hoverCleanups.push(() => {
        el.removeEventListener('mouseenter', onEnter);
        el.removeEventListener('mouseleave', onLeave);
      });
    }

    const master = pc || charts[0];
    if (master) {
      try {
        const masterRange = master.timeScale().getVisibleLogicalRange();
        if (masterRange) {
          for (const c of charts) {
            if (c !== master) safeSetVisibleLogicalRange(c, masterRange);
          }
        }
      } catch (e) {}
    }

    const unsubs: (() => void)[] = [];
    let isSyncingRange = false;

    for (const c of charts) {
      const onRangeChange = (range: any) => {
        if (isSyncingRange || !range) return;
        isSyncingRange = true;
        try {
          for (const target of charts) {
            if (target !== c) safeSetVisibleLogicalRange(target, range);
          }
        } catch (e) {} finally {
          isSyncingRange = false;
        }
      };
      try {
        c.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
        unsubs.push(() => { try { c.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch (e) {} });
      } catch (e) {}
    }

    // Single-owner crosshair sync (mirrors NubraBacktest): the hovered pane drives all
    // three tooltips (data + position + visibility) and pushes the crosshair onto the
    // other panes with real in-range values. No shared re-entrancy flag — programmatic
    // crosshair echoes are recognised by the (point === undefined, time !== undefined) branch.
    const findLatest = <T extends { time: any }>(arr: T[] | undefined, targetTime: number): T | undefined => {
      if (!arr || arr.length === 0) return undefined;
      let l = 0, r = arr.length - 1;
      let res: T | undefined = undefined;
      while (l <= r) {
        const m = (l + r) >> 1;
        const time = arr[m].time as number;
        if (time <= targetTime) { res = arr[m]; l = m + 1; } else { r = m - 1; }
      }
      return res;
    };

    const activeGreekSeries = (): ISeriesApi<any> | null => {
      const g = greeksSeriesRef.current;
      if (g['net_delta']) return g['net_delta'];
      const k = Object.keys(g).find(kk => g[kk]);
      return k ? g[k] : null;
    };

    // Places a tooltip so it is never under the cursor: offset horizontally by GAP,
    // flipping to the left of the cursor once past the pane's horizontal midpoint.
    // lightweight-charts reports crosshair x relative to the PLOT area, excluding any
    // visible left price scale — but the tooltip is positioned relative to the whole
    // pane div (which includes that left-scale gutter), so we fold the scale's actual
    // rendered width back in before doing the midpoint/flip math.
    const GAP = 24;
    const place = (
      tip: PriceTooltipRef | PnlTooltipRef | GreeksTooltipRef | null,
      chart: IChartApi | null, containerW: number, containerH: number, x: number, activeY: number | null, isActive: boolean,
    ) => {
      if (!tip) return;
      let xAdj = x;
      try { xAdj = x + (chart?.priceScale('left').width() ?? 0); } catch {}
      const alignLeft = xAdj > containerW * 0.5;
      const y = isActive ? Math.max(8, Math.min((activeY ?? 40) - 80, containerH - 100)) : 8;
      tip.setPosition(alignLeft ? xAdj - GAP : xAdj + GAP, y, alignLeft);
      tip.setVisibility(true);
    };

    const updateAllTooltips = (t: number | null, x: number | null, activeY: number | null, activeChart: IChartApi | null) => {
      if (t == null || x == null) {
        priceTooltipRef.current?.setVisibility(false);
        pnlTooltipRef.current?.setVisibility(false);
        greeksTooltipRef.current?.setVisibility(false);
        return null;
      }
      const cd = chartDataRef.current;
      const tStr = fmtChartTime(t);
      let spot = 0, totalPnl = 0, greekNorm = 0;

      if (pc) {
        let newOhlc = null;
        const legs: Array<{ name: string; color: string; value: number }> = [];
        if (cd) {
          const b = findLatest(cd.underlyingBars, t);
          if (b) { spot = b.close; newOhlc = { o: b.open, h: b.high, l: b.low, c: b.close }; }
          for (const leg of legMetasRef.current) {
            const d = findLatest(cd.legPriceData.get(leg.refId), t);
            if (d) legs.push({ name: leg.displayName, color: leg.color, value: d.value });
          }
        }
        priceTooltipRef.current?.setData(tStr, newOhlc, legs, underlying || '');
        place(priceTooltipRef.current, pc, priceChartContainerRef.current?.clientWidth ?? 800, priceChartContainerRef.current?.clientHeight ?? 400, x, activeY, activeChart === pc);
      }

      if (nc) {
        const legs: Array<{ name: string; color: string; value: number }> = [];
        if (cd) {
          const p = findLatest(cd.basketPnlData, t);
          if (p) totalPnl = p.value;
          for (const leg of legMetasRef.current) {
            const d = findLatest(cd.legPnlData.get(leg.refId), t);
            if (d) legs.push({ name: leg.displayName, color: leg.color, value: d.value });
          }
        }
        pnlTooltipRef.current?.setData(tStr, { legs, total: totalPnl });
        place(pnlTooltipRef.current, nc, pnlChartContainerRef.current?.clientWidth ?? 800, pnlChartContainerRef.current?.clientHeight ?? 400, x, activeY, activeChart === nc);
      }

      if (gc) {
        const tv: Record<string, Record<string, number>> = {};
        for (const src of ['net', 'CE', 'PE'] as const) tv[src] = { delta: 0, gamma: 0, theta: 0, vega: 0 };
        if (cd) {
          for (const leg of legMetasRef.current) {
            const pt = findLatest(cd.legGreeksHist.get(leg.refId), t);
            if (!pt) continue;
            const mult = lotSizeOverride || 1;
            const pos = allPositionsRef.current.find(p => p.ref_id === leg.refId);
            const side = pos ? (pos.order_side?.includes('BUY') ? 1 : -1) : 0;
            const qty = pos ? (pos.qty || 0) : 0;
            const weight = greeksMode === 'lot' ? qty : side * mult;
            const src = positionGreekSource(pos || {} as any);
            tv.net.delta += pt.delta * weight; tv.net.gamma += pt.gamma * weight;
            tv.net.theta += pt.theta * weight; tv.net.vega += pt.vega * weight;
            if (src) {
              tv[src].delta += pt.delta * weight; tv[src].gamma += pt.gamma * weight;
              tv[src].theta += pt.theta * weight; tv[src].vega += pt.vega * weight;
            }
          }
        }
        greeksTooltipRef.current?.setData(tStr, tv);
        const f = greekFactorsRef.current['delta'] || { mid: 0, half: 1 };
        greekNorm = f.half ? (tv.net.delta - f.mid) / f.half : 0;
        place(greeksTooltipRef.current, gc, greeksChartContainerRef.current?.clientWidth ?? 800, greeksChartContainerRef.current?.clientHeight ?? 400, x, activeY, activeChart === gc);
      }

      return { spot, totalPnl, greekNorm };
    };

    for (const sourceChart of charts) {
      const onCrosshairMove = (param: any) => {
        if (param.point && param.time != null) {
          // Live data updates (series.update()) make lightweight-charts internally
          // re-fire crosshairMove on whichever pane last held a crosshair position —
          // including panes we only positioned synthetically via setCrosshairPosition.
          // Ignore any such event that didn't originate from the pane the cursor is
          // actually over, or tooltips jitter/relocate on every tick with no mouse motion.
          if (sourceChart !== hoveredChartRef.current) return;
          const t = param.time as number;
          const res = updateAllTooltips(t, param.point.x, param.point.y, sourceChart);
          if (res) {
            for (const c of charts) {
              if (c === sourceChart) continue;
              try {
                if (c === pc && seriesRef.current.underlying) c.setCrosshairPosition(res.spot, t as any, seriesRef.current.underlying);
                else if (c === nc && seriesRef.current.basketPnl) c.setCrosshairPosition(res.totalPnl, t as any, seriesRef.current.basketPnl);
                else if (c === gc) { const gs = activeGreekSeries(); if (gs) c.setCrosshairPosition(res.greekNorm, t as any, gs); }
              } catch {}
            }
          }
        } else if (param.point === undefined && param.time !== undefined) {
          // Programmatic crosshair echo from setCrosshairPosition — ignore.
        } else {
          updateAllTooltips(null, null, null, null);
          for (const c of charts) {
            if (c !== sourceChart) { try { c.clearCrosshairPosition(); } catch {} }
          }
        }
      };

      try {
        sourceChart.subscribeCrosshairMove(onCrosshairMove);
        unsubs.push(() => { try { sourceChart.unsubscribeCrosshairMove(onCrosshairMove); } catch {} });
      } catch (e) {}
    }

    return () => { unsubs.forEach(u => u()); hoverCleanups.forEach(u => u()); hoveredChartRef.current = null; };
  }, [priceVisible, pnlVisible, greeksVisible, chartEpoch]);

  // ── 5. Resize observer & persistent layout range sync ──
  useEffect(() => {
    const syncAll = () => {
      try {
        const pc = priceChartRef.current;
        if (!pc) return;
        const r = pc.timeScale().getVisibleLogicalRange();
        if (!r) return;
        safeSetVisibleLogicalRange(pnlChartRef.current, r);
        safeSetVisibleLogicalRange(greeksChartRef.current, r);
      } catch (e) {}
    };

    const ro = new ResizeObserver(() => {
      try {
        syncAll();
      } catch (e) {}
    });

    if (priceChartContainerRef.current) ro.observe(priceChartContainerRef.current);
    if (pnlChartContainerRef.current) ro.observe(pnlChartContainerRef.current);
    if (greeksChartContainerRef.current) ro.observe(greeksChartContainerRef.current);

    let count = 0;
    const pollTimer = setInterval(() => {
      syncAll();
      count++;
      if (count > 10) clearInterval(pollTimer);
    }, 30);

    return () => {
      clearInterval(pollTimer);
      ro.disconnect();
    };
  }, [priceVisible, pnlVisible, greeksVisible, chartEpoch]);

  // ── 6. Live WebSocket updates ──
  useEffect(() => {
    if (isSnapshot) return;
    const unsub1 = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !underlying || !seriesRef.current.underlying) return;
      const data = msg.data as { indexes?: Array<{ indexname?: string; timestamp?: string; open?: string; high?: string; low?: string; close?: string }> };
      const idx = data.indexes?.find(i => (i.indexname || '').toUpperCase() === underlying.toUpperCase());
      if (!idx?.timestamp) return;
      const t = Math.floor((Number(BigInt(idx.timestamp)) / 1e9 + IST_OFFSET) / 60) * 60;
      const cached = chartDataRef.current;
      if (cached && (t < cached.sessionOpen || t > cached.sessionClose)) return;
      const o = parseFloat(idx.open || '0') / 100, h = parseFloat(idx.high || '0') / 100;
      const l = parseFloat(idx.low || '0') / 100, c = parseFloat(idx.close || '0') / 100;
      seriesRef.current.underlying.update({ time: t as any, open: o, high: h, low: l, close: c });
      if (cached) upsertBar(cached.underlyingBars, { time: t, open: o, high: h, low: l, close: c });
    });

    const processLtp = (ltpMap: Map<number, number>) => {
      let t = nowChartTime();
      const cached = chartDataRef.current;
      if (cached) {
        if (t < cached.sessionOpen || t > cached.sessionClose) return;
        if (cached.underlyingBars.length > 0) {
          const lastBarTime = cached.underlyingBars[cached.underlyingBars.length - 1].time as number;
          if (t < lastBarTime) t = lastBarTime;
        }
      }

      for (const [refId, ltp] of ltpMap) if (ltp > 0) lastLtpRef.current.set(refId, ltp);

      for (const p of positionsRef.current) {
        const ltp = ltpMap.get(p.ref_id);
        if (ltp == null || ltp <= 0) continue;
        seriesRef.current.legPrice.get(p.ref_id)?.update({ time: t as any, value: ltp / 100 });
        const side = (p.order_side || '').includes('BUY') ? 1 : -1;
        const pnl = side * (ltp - (p.avg_price || 0)) * (p.qty || 0) / 100;
        seriesRef.current.legPnl.get(p.ref_id)?.update({ time: t as any, value: pnl });
        if (cached) {
          let pa = cached.legPriceData.get(p.ref_id); if (!pa) { pa = []; cached.legPriceData.set(p.ref_id, pa); }
          upsertPoint(pa, t, ltp / 100);
          let na = cached.legPnlData.get(p.ref_id); if (!na) { na = []; cached.legPnlData.set(p.ref_id, na); }
          upsertPoint(na, t, pnl);
        }
      }

      let totalPnl = 0;
      for (const p of closedPositionsRef.current) {
        const side = (p.order_side || '').includes('BUY') ? 1 : -1;
        if (p.exit_price != null) totalPnl += side * (p.exit_price - (p.avg_price || 0)) * (p.qty || 0) / 100;
      }
      for (const p of positionsRef.current) {
        const ltp = lastLtpRef.current.get(p.ref_id) ?? p.last_traded_price;
        if (ltp == null || ltp <= 0) continue;
        const side = (p.order_side || '').includes('BUY') ? 1 : -1;
        totalPnl += side * (ltp - (p.avg_price || 0)) * (p.qty || 0) / 100;
      }
      if (positionsRef.current.length > 0 && seriesRef.current.basketPnl) {
        seriesRef.current.basketPnl.update({ time: t as any, value: totalPnl });
        if (cached) upsertPoint(cached.basketPnlData, t, totalPnl);
      }
    };

    const unsub2 = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data as { ref_id: number; ltp: number }[];
      if (!updates?.length) return;
      const ids = new Set(positionsRef.current.map(p => p.ref_id));
      const ltpMap = new Map<number, number>();
      for (const u of updates) { if (ids.has(u.ref_id) && u.ltp > 0) ltpMap.set(u.ref_id, u.ltp); }
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
  }, [subscribe, underlying, isSnapshot]);

  // ── 6b. Polling fallback ──
  useEffect(() => {
    if (isSnapshot || positions.length === 0) return;
    let t = nowChartTime();
    const cached = chartDataRef.current;
    if (cached) {
      if (t < cached.sessionOpen || t > cached.sessionClose) return;
      if (cached.underlyingBars.length > 0) {
        const lastBarTime = cached.underlyingBars[cached.underlyingBars.length - 1].time as number;
        if (t < lastBarTime) t = lastBarTime;
      }
    }

    for (const p of positions) {
      const ltp = p.last_traded_price;
      if (!ltp || ltp <= 0) continue;
      lastLtpRef.current.set(p.ref_id, ltp);

      seriesRef.current.legPrice.get(p.ref_id)?.update({ time: t as any, value: ltp / 100 });

      const side = (p.order_side || '').includes('BUY') ? 1 : -1;
      const pnl = side * (ltp - (p.avg_price || 0)) * (p.qty || 0) / 100;
      seriesRef.current.legPnl.get(p.ref_id)?.update({ time: t as any, value: pnl });

      if (cached) {
        let pa = cached.legPriceData.get(p.ref_id); if (!pa) { pa = []; cached.legPriceData.set(p.ref_id, pa); }
        upsertPoint(pa, t, ltp / 100);
        let na = cached.legPnlData.get(p.ref_id); if (!na) { na = []; cached.legPnlData.set(p.ref_id, na); }
        upsertPoint(na, t, pnl);
      }
    }

    let totalPnl = 0;
    for (const p of closedPositions) {
      const side = (p.order_side || '').includes('BUY') ? 1 : -1;
      if (p.exit_price != null) totalPnl += side * (p.exit_price - (p.avg_price || 0)) * (p.qty || 0) / 100;
    }
    for (const p of positions) {
      const ltp = lastLtpRef.current.get(p.ref_id) ?? p.last_traded_price;
      if (!ltp || ltp <= 0) continue;
      const side = (p.order_side || '').includes('BUY') ? 1 : -1;
      totalPnl += side * (ltp - (p.avg_price || 0)) * (p.qty || 0) / 100;
    }
    if (seriesRef.current.basketPnl) {
      seriesRef.current.basketPnl.update({ time: t as any, value: totalPnl });
      if (cached) upsertPoint(cached.basketPnlData, t, totalPnl);
    }
  }, [positions, closedPositions, isSnapshot]);

  // ── 7. Live LTP for position table ──
  useEffect(() => {
    if (isSnapshot) return;
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
  }, [subscribe, isSnapshot]);

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

  // ── 9. Live Greeks ──
  useEffect(() => {
    if (isSnapshot) return;
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
        const t = nowChartTime();
        const cached = chartDataRef.current;
        if (cached && t >= cached.sessionOpen && t <= cached.sessionClose) {
          for (const [refId, g] of updates) {
            let hist = cached.legGreeksHist.get(refId);
            if (!hist) { hist = []; cached.legGreeksHist.set(refId, hist); }
            upsertGreekPoint(hist, { time: t, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });
          }
          setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });
        }
        setLegGreeks(prev => {
          const next = new Map(prev);
          for (const [k, v] of updates) next.set(k, v);
          return next;
        });
      }
    });
    return () => unsub();
  }, [subscribe, isSnapshot]);

  // ── 10. Greeks chart ──
  useEffect(() => {
    if (!greeksChartContainerRef.current || !greeksVisible) return;
    const isDark = theme === 'dark';
    const chart = createChart(greeksChartContainerRef.current, chartOpts(isDark, false, true));
    greeksChartRef.current = chart;
    setChartEpoch(e => e + 1);
    const greekKeys = ['delta', 'gamma', 'theta', 'vega'] as const;
    greeksSeriesRef.current = {};
    // All 4 greeks are min-max normalized to a shared [-1,1] range before setData (see the
    // "Apply Greeks data" effect below), so they can plot together on one visible axis. That
    // axis's tick labels take the format of whichever series on it has the lowest z-order —
    // this invisible, dataless anchor series claims that slot with plain numbers, so the axis
    // reads as a generic reference scale instead of being denormalized into one greek's units.
    // The colored last-value badges are unaffected — those use each series' own priceFormat.
    chart.addSeries(LineSeries, {
      priceScaleId: 'right', lastValueVisible: false, priceLineVisible: false, visible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    }).setData([]);
    for (const src of GREEK_SOURCES) {
      for (const k of greekKeys) {
        const key = `${src}_${k}`;
        const s = chart.addSeries(LineSeries, {
          color: GREEK_COLORS[k], lineWidth: Math.max(2, GREEK_LINE_WIDTHS[src]) as any, lineStyle: GREEK_LINE_STYLES[src],
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
    // Crosshair '+' tooltip is driven centrally by the crosshair-sync effect (section 4).
    if (!hasInitialFittedRef.current) {
      requestAnimationFrame(() => chart.timeScale().fitContent());
    }
    return () => { greeksSeriesRef.current = {}; greeksChartRef.current = null; try { chart.remove(); } catch {} setChartEpoch(e => e + 1); };
  }, [theme, greeksVisible, greeksLegFilter]);

  // ── 10b. Apply Greeks data ──
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
    const cePositions = allPos.filter(p => positionGreekSource(p) === 'CE');
    const pePositions = allPos.filter(p => positionGreekSource(p) === 'PE');
    const sourceData: Record<string, Map<number, { delta: number; gamma: number; theta: number; vega: number }>> = {
      net: computeByTime(allPos),
      CE: computeByTime(cePositions),
      PE: computeByTime(pePositions),
    };

    setLegGreeks(prev => {
      const next = new Map(prev);
      for (const p of allPos) {
        const hist = chartData.legGreeksHist.get(p.ref_id);
        if (!hist?.length) continue;
        const latest = hist[hist.length - 1];
        const prior = next.get(p.ref_id);
        next.set(p.ref_id, {
          delta: latest.delta,
          gamma: latest.gamma,
          theta: latest.theta,
          vega: latest.vega,
          iv: prior?.iv ?? 0,
        });
      }
      return next;
    });

    const latestBySource: Record<GreekSource, Record<GreekKey, number>> = {
      net: { delta: 0, gamma: 0, theta: 0, vega: 0 },
      CE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
      PE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
    };
    for (const src of GREEK_SOURCES) {
      const times = [...sourceData[src].keys()].sort((a, b) => a - b);
      const latest = times.length ? sourceData[src].get(times[times.length - 1]) : null;
      if (latest) latestBySource[src] = { ...latest };
    }
    setCurrentGreeksBySource(latestBySource);

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

    // Same full-session grid as the P&L pane so greeks time-align with the other charts (whitespace pad).
    const grid = chartData.underlyingBars.map(b => b.time as number);

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
          s.setData(fillGreeksToGrid(grid, byTime, k, f) as any);
          s.applyOptions({ visible: true });
        } else {
          s.setData([]);
          s.applyOptions({ visible: false });
        }
      }
    }

    const pc = priceChartRef.current;
    if (pc) {
      const r = pc.timeScale().getVisibleLogicalRange();
      if (r) {
        try { greeksChartRef.current?.timeScale().setVisibleLogicalRange(r); } catch {}
      } else {
        requestAnimationFrame(() => greeksChartRef.current?.timeScale().fitContent());
      }
    } else {
      requestAnimationFrame(() => greeksChartRef.current?.timeScale().fitContent());
    }
  }, [chartData, greeksMode, lotSizeOverride, selectedGreeks, greeksVisible, underlying, greeksLegFilter]);

  const toggleVis = useCallback((key: string) => { setVisibility(prev => ({ ...prev, [key]: !prev[key] })); }, []);
  const toggleLegPrice = useCallback((refId: number) => { setLegPriceVisibility(prev => ({ ...prev, [refId]: !(prev[refId] !== false) })); }, []);
  const toggleLegPnl = useCallback((refId: number) => { setLegPnlVisibility(prev => ({ ...prev, [refId]: !(prev[refId] !== false) })); }, []);

  // ── Snapshot save (freeze this day's chart so it survives the historical API rolling off) ──
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const buildSnapshotPayload = useCallback((source: 'manual' | 'auto') => {
    const cd = chartDataRef.current;
    if (!cd) return null;
    // Nothing reconstructable (e.g. API already rolled the contracts off) → don't overwrite a good snapshot.
    if (cd.underlyingBars.length === 0 && cd.legPriceData.size === 0) return null;
    const open = positionsRef.current, closed = closedPositionsRef.current;
    const entryTimes = [...open, ...closed].map(p => p.entry_time || 0).filter(t => t > 0);
    if (entryTimes.length === 0) return null;
    const tradeDate = istDateFromNs(Math.min(...entryTimes));
    const lastBasket = cd.basketPnlData.length > 0 ? cd.basketPnlData[cd.basketPnlData.length - 1].value : 0;
    return {
      basket_group_id: basketGroupId, trade_date: tradeDate, strategy_name: strategyName,
      underlying, total_pnl: Math.round(lastBasket * 100), leg_count: legMetasRef.current.length, source,
      data: {
        version: 1, underlying, positions: open, closedPositions: closed,
        chart: {
          underlyingBars: cd.underlyingBars,
          legPriceData: [...cd.legPriceData.entries()],
          legPnlData: [...cd.legPnlData.entries()],
          basketPnlData: cd.basketPnlData,
          legGreeksHist: [...cd.legGreeksHist.entries()],
          pnlFrom: cd.pnlFrom, pnlTo: cd.pnlTo, sessionOpen: cd.sessionOpen, sessionClose: cd.sessionClose,
        },
      },
    };
  }, [basketGroupId, strategyName, underlying]);

  const saveSnapshot = useCallback(async (source: 'manual' | 'auto') => {
    const payload = buildSnapshotPayload(source);
    if (!payload) { if (source === 'manual') setSaveState('error'); return false; }
    if (source === 'manual') setSaveState('saving');
    try {
      const res = await fetch('/paper/strategy/snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (source === 'manual') { setSaveState(res.ok ? 'saved' : 'error'); setTimeout(() => setSaveState('idle'), 2500); }
      return res.ok;
    } catch { if (source === 'manual') { setSaveState('error'); setTimeout(() => setSaveState('idle'), 2500); } return false; }
  }, [buildSnapshotPayload]);

  // Auto-upsert once when a live (non-snapshot) chart finishes building, so viewing a strategy persists it.
  const autoSavedRef = useRef(false);
  useEffect(() => {
    if (isSnapshot || !chartData || autoSavedRef.current) return;
    autoSavedRef.current = true;
    saveSnapshot('auto');
  }, [chartData, isSnapshot, saveSnapshot]);

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
    const startY = e.clientY;
    const startH = pnlHeight;
    const totalH = chartsWrapperRef.current?.clientHeight ?? 600;
    const dividersH = greeksVisible ? 12 : 6;
    const maxCombined = totalH - 8 - dividersH - 80;
    const maxPnl = greeksVisible ? Math.max(40, maxCombined - greeksChartHeight) : maxCombined;

    let newH = startH;
    const onMove = (ev: MouseEvent) => {
      newH = Math.max(40, Math.min(maxPnl, startH - (ev.clientY - startY)));
      if (pnlChartContainerRef.current) pnlChartContainerRef.current.style.height = `${newH}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setPnlHeight(newH);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pnlHeight, greeksChartHeight, greeksVisible]);

  const onGreeksDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = greeksChartHeight;
    const totalH = chartsWrapperRef.current?.clientHeight ?? 600;
    const dividersH = greeksVisible ? 12 : 6;
    const maxCombined = totalH - 8 - dividersH - 80;
    const maxGreeks = Math.max(40, maxCombined - pnlHeight);

    let newH = startH;
    const onMove = (ev: MouseEvent) => {
      newH = Math.max(40, Math.min(maxGreeks, startH - (ev.clientY - startY)));
      if (greeksChartContainerRef.current) greeksChartContainerRef.current.style.height = `${newH}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setGreeksChartHeight(newH);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [greeksChartHeight, pnlHeight, greeksVisible]);

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
    if (strategyMarginPaise > 0) return strategyMarginPaise / 100;
    const first = allPositions.find(p => p.margin_required && p.margin_required > 0);
    return first ? first.margin_required! / 100 : 0;
  }, [allPositions, strategyMarginPaise]);

  useEffect(() => {
    if (isSnapshot) return;
    const marginPositions = positions.length ? positions : allPositions;
    if (!marginPositions.length) { setStrategyMarginPaise(0); return; }
    let cancelled = false;
    fetchStrategyMarginPaise(marginPositions)
      .then(total => { if (!cancelled && total > 0) setStrategyMarginPaise(total); })
      .catch(e => console.warn('[StrategyAnalysis] margin recalculation failed:', e));
    return () => { cancelled = true; };
  }, [positions, allPositions, isSnapshot]);
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
            const netGreeks = currentGreeksBySource.net;
            const fmtG = (v: number, key: string) => key === 'gamma' ? v.toFixed(4) : v.toFixed(2);
            const cePositions = allPositions.filter(p => positionGreekSource(p) === 'CE');
            const pePositions = allPositions.filter(p => positionGreekSource(p) === 'PE');
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

        <div className="ml-auto flex items-center gap-3">
          {isSnapshot ? (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[#3b82f6]/15 text-[#3b82f6] border border-[#3b82f6]/40">
              Saved snapshot
            </span>
          ) : (
            <button
              onClick={() => saveSnapshot('manual')}
              disabled={saveState === 'saving'}
              title="Freeze this day's chart so it stays viewable after the historical data rolls off"
              className={`flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-semibold border transition-colors ${
                saveState === 'saved' ? 'border-[var(--green)]/50 bg-[var(--green)]/15 text-[var(--green)]'
                  : saveState === 'error' ? 'border-[var(--red)]/50 bg-[var(--red)]/15 text-[var(--red)]'
                  : 'border-[var(--border)] bg-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}>
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Save failed' : '⭳ Save'}
            </button>
          )}
          <span className={`text-[12px] font-semibold ${strategyPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
            P&L: {strategyPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(strategyPnl))}
          </span>
        </div>
      </div>

      {/* Charts + order book */}
      <div ref={chartsWrapperRef} className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Price chart */}
        {priceVisible && (
        <div ref={priceChartContainerRef} className="relative flex-1 min-h-[120px] bg-[var(--bg-primary)]">
          <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px]">
            {/* fallback removed */}
          </div>
          <PriceTooltip ref={priceTooltipRef} />
        </div>
        )}

        {pnlVisible && (
          <>
            {priceVisible && (
            <div onMouseDown={onPnlDividerDown} className="group h-2 shrink-0 flex items-center justify-center bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/20 cursor-row-resize transition-colors z-20 relative">
              <div className="w-10 h-0.5 rounded-full bg-[var(--border)] group-hover:bg-[var(--accent)]" />
            </div>
            )}
            <div ref={pnlChartContainerRef} style={{ height: pnlHeight, minHeight: 40, position: 'relative', borderBottom: greeksVisible ? '1px solid var(--border)' : 'none', flexShrink: 0, display: pnlVisible ? 'block' : 'none' }}>
              <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px]">
              </div>
              <PnlTooltip ref={pnlTooltipRef} strategyMargin={strategyMargin > 0 ? strategyMargin : 0} />
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
            <div ref={greeksChartContainerRef} style={{ height: greeksChartHeight, minHeight: 40, position: 'relative', display: greeksVisible ? 'block' : 'none', flexShrink: 0 }}>
              <div className="absolute top-1 left-2 z-10 pointer-events-none text-[11px]">
              </div>
              <GreeksTooltip ref={greeksTooltipRef} selectedGreeks={selectedGreeks} greeksLegFilter={greeksLegFilter} colors={GREEK_COLORS} />
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
                        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{strategyMargin > 0 ? `₹${fmtPrice(strategyMargin)}` : '—'}</td>
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
