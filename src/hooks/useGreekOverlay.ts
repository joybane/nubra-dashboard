import { useEffect, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Instrument, OhlcBar, OptionChainData, WsMessage, OptionLeg } from '../types';

// Server enriches each leg with `symbol` (stock_name) for the historical query.
type ChainLeg = OptionLeg & { symbol?: string };
type ChainResp = { chain?: OptionChainData & { lot_size?: number; all_expiries?: string[]; ce?: ChainLeg[]; pe?: ChainLeg[] } };
import { getSymbol } from '../types';
import { IST_OFFSET } from '../lib/utils';
import {
  buildSeries, type AggLeg, type ChainSnapshot, type GreekName, type Method, type Basket, type SeriesPoint,
} from '../lib/greekAggregator';
import { createGreekPane, type GreekPane, type SeriesMode, type TimeMapper } from '../lib/greekRenderer';
import { blackScholes, impliedVolatility } from '../lib/GexService';
import { useWs } from './useWsContext';

// The broker timeseries does NOT store historical Greeks (delta/vega/theta are
// real-time analytics), so we reconstruct them via Black-Scholes from historical
// option price (`close`) + spot. Per-point IV inversion makes 1s reconstruction
// prohibitively expensive across a whole basket, so history is built at 1m; the
// live WS path stays true per-tick. If a future API serves Greek fields directly,
// they're used as-is (no reconstruction) — see mergeHistory.
const HIST_INTERVAL = '1m';
const RISK_FREE = 0.07;
const HIST_FIELDS = ['close', 'cumulative_oi', 'delta', 'vega', 'theta'];

type TsV = { ts: number; v: number };
// The broker `/charts/timeseries` endpoint returns ts in NANOSECONDS (the candle
// path divides by 1e9). Normalize any plausible unit (s / ms / µs / ns) to epoch
// milliseconds by magnitude so reconstructed history lands on the real timeline
// rather than astronomically far right (which also yields "Invalid Date" labels).
const normTs = (ts: number | string): number => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (n >= 1e17) return Math.round(n / 1e6);   // nanoseconds  → ms
  if (n >= 1e14) return Math.round(n / 1e3);   // microseconds → ms
  if (n >= 1e11) return n;                      // milliseconds
  return n * 1000;                              // seconds      → ms
};

/** IST time-of-day market-hours check (09:15–15:30), used to avoid stray points. */
function isMarketOpenNow(): boolean {
  const istMin = ((Math.floor(Date.now() / 1000) + 5.5 * 3600) % 86400) / 60;
  return istMin >= 9 * 60 + 15 && istMin <= 15 * 60 + 30;
}

/** Years to expiry at a given epoch-ms instant (expiry assumed 15:30 IST = 10:00 UTC). */
function yearsToExpiry(expiry: string, ms: number): number {
  const iso = /^\d{8}$/.test(expiry) ? expiry.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') : expiry;
  const exp = new Date(`${iso}T10:00:00Z`).getTime();
  const days = Number.isFinite(exp) ? Math.max(0, (exp - ms) / 86_400_000) : 1;
  return Math.max(days / 365, 1 / (365 * 24));
}

/** Nearest spot value to `ts` from a time-sorted series (binary search). */
function nearestSpot(spot: TsV[], ts: number): number {
  if (!spot.length) return 0;
  let lo = 0, hi = spot.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spot[mid].ts < ts) lo = mid + 1; else hi = mid;
  }
  const a = spot[Math.max(0, lo - 1)], b = spot[lo];
  return (Math.abs(a.ts - ts) <= Math.abs(b.ts - ts) ? a.v : b.v);
}
const SNAP_MIN_GAP_MS = 2_000;        // throttle live snapshot storage (tick-by-tick: ~2s greek points)
// Live fallback poll: the line is driven by per-tick `option_chain` WS pushes, but
// the broker pushes only on change and can stay silent for minutes (and SIM relies
// entirely on it). Like the Option Chain view, poll the REST chain on a cadence —
// but only when the WS feed has gone quiet — so the line tracks the latest candle.
const LIVE_POLL_MS = 4_000;           // fallback-poll cadence
const WS_QUIET_MS  = 6_000;           // only poll once the WS feed has been silent this long
const METHOD_LABEL: Record<Method, string> = { mine: 'mine', industry: 'ind' };

export interface GreekLegend { method: Method; point: SeriesPoint }

export interface GreekOverlayApi {
  on:         boolean;
  showPopup:  boolean;
  expiries:   string[];
  selExpiries: string[];
  method:     Method | 'both';
  basket:     Basket;
  seriesMode: SeriesMode;
  showCalls:  boolean;
  showPuts:   boolean;
  legend:     GreekLegend[];
  histState:  'idle' | 'loading' | 'ok' | 'nogreeks';
  histGranularity: string;   // '1s' | '1m' | '' — which resolution backfilled
  ceColor:    string;        // CE/PE line colors (distinct per greek) for legend swatches
  peColor:    string;
  greekDate:  string;        // 'YYYY-MM-DD' trading day being reconstructed
  latestDay:  string;        // most recent loaded trading day (date-picker max / "Latest")
  setGreekDate:  (d: string) => void;
  setShowPopup:  (v: boolean | ((p: boolean) => boolean)) => void;
  toggleExpiry:  (exp: string, shift: boolean) => void;
  setMethod:     (v: Method | 'both') => void;
  setBasket:     (v: Basket) => void;
  setSeriesMode: (v: SeriesMode) => void;
  setShowCalls:  (v: boolean) => void;
  setShowPuts:   (v: boolean) => void;
  toggle:        () => void;
  openSettings:  () => void;
  applySettings: () => void;
  clearForInstrumentChange: () => void;
  enabledRef:    React.RefObject<boolean>;
}

interface Deps {
  greek:          GreekName;
  chartRef:       React.RefObject<IChartApi | null>;
  currentInstRef: React.RefObject<Instrument | null>;
  allBarsRef:     React.RefObject<OhlcBar[]>;
  /** Render greeks inline on the price pane (Tracker) instead of a sub-pane below (Chart). */
  inline?:        boolean;
}

// Distinct CE/PE palette per greek so overlapping Vega + Theta lines stay tellable apart.
const GREEK_PALETTE: Record<GreekName, { ce: string; pe: string }> = {
  vega:  { ce: '#22c55e', pe: '#ef4444' },   // green / red
  theta: { ce: '#a855f7', pe: '#f59e0b' },   // purple / amber
};

// Trailing window (calendar days) of greek history to reconstruct, ending at the
// selected day — matches the Tracker's 7-day candle load so greeks span the chart.
const GREEK_HIST_DAYS = 7;

export function useGreekOverlay({ greek, chartRef, currentInstRef, allBarsRef, inline }: Deps): GreekOverlayApi {
  const { subscribe, subscribeOC, unsubscribeOC } = useWs();
  const greekLabel = greek === 'vega' ? 'Vega' : 'Theta';
  const palette = GREEK_PALETTE[greek];

  // ── State ────────────────────────────────────────────────────────────────
  const [on, setOn]                 = useState(false);
  const [showPopup, setShowPopup]   = useState(false);
  const [expiries, setExpiries]     = useState<string[]>([]);
  const [selExpiries, setSelExpiries] = useState<string[]>([]);
  const [method, setMethodState]    = useState<Method | 'both'>('mine');
  const [basket, setBasketState]    = useState<Basket>('fixed');
  const [seriesMode, setSeriesModeState] = useState<SeriesMode>('both');
  const [showCalls, setShowCallsState]   = useState(true);
  const [showPuts, setShowPutsState]     = useState(true);
  const [legend, setLegend]         = useState<GreekLegend[]>([]);
  const [histState, setHistState]   = useState<'idle' | 'loading' | 'ok' | 'nogreeks'>('idle');
  const [histGranularity, setHistGranularity] = useState('');
  const [greekDate, setGreekDateState] = useState('');
  const [latestDay, setLatestDay]   = useState('');

  // ── Refs ─────────────────────────────────────────────────────────────────
  const enabledRef     = useRef(false);
  const snapshotsRef   = useRef<Map<number, ChainSnapshot>>(new Map());
  const lastSnapMsRef  = useRef(0);
  const lotSizeRef     = useRef(1);
  const metaRef        = useRef<Map<string, { sp: number; type: 'CE' | 'PE'; exp: string }>>(new Map());
  const underlyingRef  = useRef<string>('');
  const minePaneRef    = useRef<GreekPane | null>(null);
  const indPaneRef     = useRef<GreekPane | null>(null);
  // Multi-expiry WS state + latest live legs per expiry (merged into each snapshot).
  const wsAssetRef     = useRef<string | null>(null);
  const wsExpiriesRef  = useRef<Set<string>>(new Set());
  const wsExchRef      = useRef('NSE');
  const liveLegsRef    = useRef<Map<string, { ce: AggLeg[]; pe: AggLeg[] }>>(new Map());
  const anchorExpiryRef = useRef('');
  const greekDateRef   = useRef('');      // selected reconstruction day (mirrors greekDate)
  const defaultDayRef  = useRef('');      // latest trading day loaded (today / last bar)
  const histLoadingRef = useRef(false);
  const drawPendingRef = useRef(false);
  const lastDrawMsRef  = useRef(0);
  const drawTimerRef   = useRef<number | null>(null);
  const lastWsTickRef  = useRef(0);       // last time a live WS option_chain tick was applied
  const pollTimerRef   = useRef<number | null>(null);
  const pollBusyRef    = useRef(false);

  // Mirror settings into refs so the WS callback and redraw read fresh values.
  const cfgRef = useRef({ method, basket, seriesMode, showCalls, showPuts });
  cfgRef.current = { method, basket, seriesMode, showCalls, showPuts };

  const setMethod     = (v: Method | 'both') => { setMethodState(v); cfgRef.current.method = v; syncPanes(v); requestDraw(); };
  const setBasket     = (v: Basket)     => { setBasketState(v); cfgRef.current.basket = v; requestDraw(); };
  const setSeriesMode = (v: SeriesMode) => { setSeriesModeState(v); cfgRef.current.seriesMode = v; requestDraw(); };
  const setShowCalls  = (v: boolean)    => { setShowCallsState(v); cfgRef.current.showCalls = v; requestDraw(); };
  const setShowPuts   = (v: boolean)    => { setShowPutsState(v); cfgRef.current.showPuts = v; requestDraw(); };

  // Plain click selects a single expiry; shift-click extends a range from the anchor.
  function toggleExpiry(exp: string, shift: boolean) {
    setSelExpiries(() => {
      if (shift && anchorExpiryRef.current) {
        const a = expiries.indexOf(anchorExpiryRef.current);
        const b = expiries.indexOf(exp);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          return expiries.slice(lo, hi + 1);
        }
      }
      anchorExpiryRef.current = exp;
      return [exp];
    });
  }

  // ── Pane lifecycle ─────────────────────────────────────────────────────────
  function syncPanes(m: Method | 'both') {
    const chart = chartRef.current;
    if (!chart || !enabledRef.current) return;
    const wantMine = m === 'mine' || m === 'both';
    const wantInd  = m === 'industry' || m === 'both';
    const paneOpts = { ...(inline ? { inline: true, paneIndex: 0 } : {}), ceColor: palette.ce, peColor: palette.pe };
    if (wantMine && !minePaneRef.current) minePaneRef.current = createGreekPane(chart, `${greekLabel}·${METHOD_LABEL.mine}`, paneOpts);
    if (!wantMine && minePaneRef.current) { minePaneRef.current.destroy(); minePaneRef.current = null; }
    if (wantInd && !indPaneRef.current)  indPaneRef.current = createGreekPane(chart, `${greekLabel}·${METHOD_LABEL.industry}`, paneOpts);
    if (!wantInd && indPaneRef.current)  { indPaneRef.current.destroy(); indPaneRef.current = null; }
  }

  function destroyPanes() {
    minePaneRef.current?.destroy(); minePaneRef.current = null;
    indPaneRef.current?.destroy();  indPaneRef.current = null;
  }

  // ── Redraw: recompute series from snapshots and push to panes ───────────────
  // Each redraw rebuilds the full series over every snapshot (can be ~22.5k points
  // at 1s granularity), so coalesce via rAF and throttle to MIN_DRAW_MS — live
  // ticks don't need sub-second refresh of an intraday line.
  const MIN_DRAW_MS = 750;
  function requestDraw() {
    if (!enabledRef.current || drawPendingRef.current) return;
    const since = Date.now() - lastDrawMsRef.current;
    if (since < MIN_DRAW_MS) {
      if (drawTimerRef.current == null) {
        drawTimerRef.current = window.setTimeout(() => { drawTimerRef.current = null; runDraw(); }, MIN_DRAW_MS - since);
      }
      return;
    }
    drawPendingRef.current = true;
    requestAnimationFrame(runDraw);
  }

  function runDraw() {
    drawPendingRef.current = false;
    lastDrawMsRef.current = Date.now();
    redraw();
  }

  /**
   * Snap a greek epoch-ms timestamp onto the loaded candle grid so greek points
   * coincide with candles (no off-grid columns, no stretch past the last candle).
   * Floor-snaps to the bar containing the timestamp; clamps live/future ticks to
   * the last bar; drops points before the chart's first bar.
   */
  function buildTimeMapper(): TimeMapper {
    const bars = allBarsRef.current || [];
    const times: number[] = [];
    for (const b of bars) if (typeof b.time === 'number') times.push(b.time);
    times.sort((a, b) => a - b);
    const n = times.length;
    return (ms: number): number | null => {
      const ct = Math.floor(ms / 1000) + IST_OFFSET;
      if (!Number.isFinite(ct)) return null;
      if (!n) return ct;
      if (ct < times[0]) return null;            // before chart range — don't render
      if (ct >= times[n - 1]) return times[n - 1]; // live/future → clamp to last bar
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= ct) lo = mid; else hi = mid - 1; }
      return times[lo];
    };
  }

  function redraw() {
    if (!enabledRef.current) return;
    const snaps = [...snapshotsRef.current.values()];
    if (!snaps.length) return;
    const { method: m, basket: b, seriesMode: mode, showCalls: sc, showPuts: sp } = cfgRef.current;
    const lotSize = lotSizeRef.current;
    const mapTime = buildTimeMapper();
    const nextLegend: GreekLegend[] = [];

    const draw = (pane: GreekPane | null, mt: Method) => {
      if (!pane) return;
      const pts = buildSeries(snaps, { greek, method: mt, basket: b, lotSize });
      pane.setData(pts, mode, sc, sp, mapTime);
      if (pts.length) nextLegend.push({ method: mt, point: pts[pts.length - 1] });
    };

    if (m === 'mine' || m === 'both') draw(minePaneRef.current, 'mine');
    if (m === 'industry' || m === 'both') draw(indPaneRef.current, 'industry');
    setLegend(nextLegend);
  }

  // ── Snapshot helpers ───────────────────────────────────────────────────────
  function legsFromChain(data: { ce?: OptionLeg[]; pe?: OptionLeg[] }, exp: string): { ce: AggLeg[]; pe: AggLeg[] } {
    const map = (legs: OptionLeg[] | undefined): AggLeg[] =>
      (legs || []).map(l => ({ sp: Number(l.sp), delta: l.delta, vega: l.vega, theta: l.theta, oi: l.oi, exp }));
    return { ce: map(data.ce), pe: map(data.pe) };
  }

  /** Combine the latest live legs across all selected expiries into one snapshot. */
  function storeCombinedLive(force = false) {
    const ce: AggLeg[] = [], pe: AggLeg[] = [];
    for (const v of liveLegsRef.current.values()) { ce.push(...v.ce); pe.push(...v.pe); }
    if (!ce.length && !pe.length) return;
    storeSnapshot({ ts: Date.now(), ce, pe }, force);
  }

  function storeSnapshot(snap: ChainSnapshot, force = false) {
    if (!force && snap.ts - lastSnapMsRef.current < SNAP_MIN_GAP_MS) {
      // overwrite the live tail without adding a new bucket
      snapshotsRef.current.set(lastSnapMsRef.current, { ...snap, ts: lastSnapMsRef.current });
      return;
    }
    snapshotsRef.current.set(snap.ts, snap);
    lastSnapMsRef.current = snap.ts;
  }

  // ── Live WS updates ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain' || !enabledRef.current) return;
      const data = msg.data as OptionChainData;
      if ((data.asset || '').toUpperCase() !== wsAssetRef.current) return;
      const exp = data.expiry || '';
      if (!wsExpiriesRef.current.has(exp)) return;
      // Live ticks only belong on the latest day; skip while inspecting a past day.
      if (greekDateRef.current && greekDateRef.current !== defaultDayRef.current) return;
      lastWsTickRef.current = Date.now();   // WS is alive → fallback poll stays idle
      liveLegsRef.current.set(exp, legsFromChain(data, exp));
      storeCombinedLive();
      requestDraw();
    });
    return unsub;
  }, [subscribe]);

  // Stop the fallback poll on unmount (toggle/clear handle the normal teardown paths).
  useEffect(() => () => stopLivePoll(), []);

  function subscribeWsMulti(asset: string, expiriesSel: string[], exchange: string) {
    unsubscribeWsAll();
    wsAssetRef.current = asset; wsExchRef.current = exchange;
    wsExpiriesRef.current = new Set(expiriesSel);
    for (const exp of expiriesSel) subscribeOC(asset, exp, exchange);
  }
  function unsubscribeWsAll() {
    if (wsAssetRef.current) {
      for (const exp of wsExpiriesRef.current) unsubscribeOC(wsAssetRef.current, exp, wsExchRef.current);
    }
    wsExpiriesRef.current = new Set();
    wsAssetRef.current = null;
  }

  // ── Live fallback poll ─────────────────────────────────────────────────────
  // Drives the line forward when the WS option_chain feed is silent, so greeks
  // track the latest candle instead of freezing minutes behind the price.
  function stopLivePoll() {
    if (pollTimerRef.current != null) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
  }

  function startLivePoll() {
    stopLivePoll();
    pollTimerRef.current = window.setInterval(() => {
      if (!enabledRef.current) return;
      if (greekDateRef.current !== defaultDayRef.current) return;   // inspecting a past day
      if (!isMarketOpenNow()) return;
      if (Date.now() - lastWsTickRef.current < WS_QUIET_MS) return; // WS feed is live — leave it
      void pollLiveOnce();
    }, LIVE_POLL_MS);
  }

  /** One REST chain pull → refresh live legs + store a fresh snapshot (fallback path). */
  async function pollLiveOnce() {
    const inst = currentInstRef.current;
    if (!inst || pollBusyRef.current) return;
    pollBusyRef.current = true;
    try {
      const sym  = getSymbol(inst);
      const exps = [...wsExpiriesRef.current];
      let any = false;
      for (const exp of exps) {
        try {
          const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${encodeURIComponent(exp)}`);
          const data = await res.json() as ChainResp;
          if (data.chain) { liveLegsRef.current.set(exp, legsFromChain(data.chain, exp)); any = true; }
        } catch { /* skip this expiry */ }
      }
      if (any && enabledRef.current) { storeCombinedLive(); requestDraw(); }
    } finally { pollBusyRef.current = false; }
  }

  // ── Load chain (expiries, lot size, opening snapshot) ──────────────────────
  async function loadChain() {
    const inst = currentInstRef.current;
    if (!inst) return;
    const sym = getSymbol(inst);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}`);
      const data = await res.json() as ChainResp;
      if (!data.chain) return;
      const exps = data.chain.all_expiries || [];
      setExpiries(exps);
      const initial = selExpiries.length ? selExpiries : (exps[0] ? [exps[0]] : []);
      setSelExpiries(initial);
      anchorExpiryRef.current = initial[0] || '';
      if (typeof data.chain.lot_size === 'number' && data.chain.lot_size > 0) lotSizeRef.current = data.chain.lot_size;
      await reloadAll(initial);
    } catch (e) { console.warn(`[${greekLabel}] loadChain failed:`, e); }
  }

  async function reloadAll(expiriesSel: string[]) {
    const inst = currentInstRef.current;
    if (!inst || !expiriesSel.length) return;
    const sym = getSymbol(inst);
    try {
      const meta = new Map<string, { sp: number; type: 'CE' | 'PE'; exp: string }>();
      const liveLegs = new Map<string, { ce: AggLeg[]; pe: AggLeg[] }>();
      const open = isMarketOpenNow();
      let asset = '';

      for (const exp of expiriesSel) {
        const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${encodeURIComponent(exp)}`);
        const data = await res.json() as ChainResp;
        if (!data.chain) continue;
        if (typeof data.chain.lot_size === 'number' && data.chain.lot_size > 0) lotSizeRef.current = data.chain.lot_size;
        for (const l of (data.chain.ce || [])) if (l.symbol) meta.set(String(l.symbol), { sp: Number(l.sp), type: 'CE', exp });
        for (const l of (data.chain.pe || [])) if (l.symbol) meta.set(String(l.symbol), { sp: Number(l.sp), type: 'PE', exp });
        asset = (data.chain.asset || sym).toUpperCase();
        // Only seed a "now" snapshot during market hours; after close it would plot a
        // stray point at wall-clock time, far right of the day's candles.
        if (open) liveLegs.set(exp, legsFromChain(data.chain, exp));
      }
      if (!meta.size) return;

      metaRef.current = meta;
      underlyingRef.current = asset || sym.toUpperCase();
      liveLegsRef.current = liveLegs;

      snapshotsRef.current = new Map();
      lastSnapMsRef.current = 0;

      // Default to the latest trading day; preserve a past day the user already picked.
      const today = defaultGreekDay();
      defaultDayRef.current = today;
      setLatestDay(today);
      const day = greekDateRef.current || today;
      greekDateRef.current = day;
      setGreekDateState(day);
      if (liveLegs.size && day === today) storeCombinedLive(true);

      enabledRef.current = true;
      setOn(true);
      syncPanes(cfgRef.current.method);
      subscribeWsMulti(sym.toUpperCase(), expiriesSel, inst.exchange || 'NSE');
      lastWsTickRef.current = Date.now();   // grace period before the fallback poll kicks in
      startLivePoll();
      requestDraw();
      fetchHistoryForDay(day);
    } catch (e) { console.warn(`[${greekLabel}] reload failed:`, e); }
  }

  // ── Historical backfill, reconstructed per trading day ─────────────────────
  /** Latest loaded trading day as an IST 'YYYY-MM-DD' (bar.time has IST baked in). */
  function defaultGreekDay(): string {
    const bars = allBarsRef.current;
    const last = bars[bars.length - 1];
    if (last && typeof last.time === 'number') return new Date(last.time * 1000).toISOString().slice(0, 10);
    return new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);
  }

  /** Switch the reconstructed day: clear prior reconstruction and rebuild for `dateStr`. */
  function setGreekDate(dateStr: string) {
    if (!dateStr) return;
    setGreekDateState(dateStr);
    greekDateRef.current = dateStr;
    snapshotsRef.current = new Map();
    lastSnapMsRef.current = 0;
    // Re-seed the live point only when returning to the latest day during market hours.
    if (dateStr === defaultDayRef.current && liveLegsRef.current.size) storeCombinedLive(true);
    requestDraw();
    fetchHistoryForDay(dateStr);
  }

  /** One historical pass → per-instrument field series (option price + OI [+ greeks]). */
  async function requestHistory(names: string[], type: string, exchange: string, start: Date, end: Date) {
    const BATCH = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < names.length; i += BATCH) chunks.push(names.slice(i, i + BATCH));

    const perName = new Map<string, Record<string, TsV[]>>();
    const results = await Promise.all(chunks.map(async (chunk) => {
      const res = await fetch('/api/historical', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ exchange, type, values: chunk, fields: HIST_FIELDS, startDate: start.toISOString(), endDate: end.toISOString(), interval: HIST_INTERVAL, intraDay: false, realTime: false }] }),
      });
      return res.ok ? res.json() : null;
    }));

    for (const data of results) {
      for (const row of (data?.result?.[0]?.values || [])) {
        for (const [name, series] of Object.entries(row) as [string, Record<string, TsV[]>][]) {
          if (series) perName.set(name, series);
        }
      }
    }
    return perName;
  }

  /** Time-sorted spot series for the underlying (paise → rupees). */
  async function fetchSpotHistory(exchange: string, start: Date, end: Date): Promise<TsV[]> {
    if (!underlyingRef.current) return [];
    try {
      const res = await fetch('/api/historical', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: [{ exchange, type: 'INDEX', values: [underlyingRef.current], fields: ['close'], startDate: start.toISOString(), endDate: end.toISOString(), interval: HIST_INTERVAL, intraDay: false, realTime: false }] }),
      });
      const data = res.ok ? await res.json() : null;
      const out: TsV[] = [];
      for (const row of (data?.result?.[0]?.values || [])) {
        for (const series of Object.values(row) as Record<string, TsV[]>[]) {
          for (const e of (series.close || [])) out.push({ ts: normTs(e.ts), v: e.v / 100 });
        }
      }
      out.sort((a, b) => a.ts - b.ts);
      return out;
    } catch { return []; }
  }

  /**
   * Reconstruct the basket's greeks for a trailing window of IST trading days ending
   * at `dateStr` (so the line spans the same range as the candle chart, not just one
   * day). Uses `intraDay:false` — the broker ignores the date range for `intraDay:true`
   * and always returns the current day, which is why earlier history never went back.
   */
  async function fetchHistoryForDay(dateStr: string) {
    const inst = currentInstRef.current;
    const meta = metaRef.current;
    if (!inst || !meta.size || !dateStr || histLoadingRef.current) return;
    histLoadingRef.current = true;
    setHistState('loading');

    const names = [...meta.keys()];
    const endDate   = new Date(`${dateStr}T10:00:00Z`);  // 15:30 IST of the selected day
    const startDate = new Date(endDate.getTime() - GREEK_HIST_DAYS * 86_400_000);  // trailing window
    const exchange = inst.exchange || 'NSE';

    try {
      const [perName, spot] = await Promise.all([
        requestHistory(names, 'OPT', exchange, startDate, endDate),
        fetchSpotHistory(exchange, startDate, endDate),
      ]);

      const added = mergeHistory(perName, spot);
      const ok = added > 0;
      setHistState(ok ? 'ok' : 'nogreeks');
      setHistGranularity(ok ? HIST_INTERVAL : '');
      if (!ok) console.warn(`[${greekLabel}] no historical option/spot data for ${dateStr}.`);
      requestDraw();
    } catch (e) {
      console.error(`[${greekLabel}] history fetch failed:`, e);
      setHistState('idle');
    } finally { histLoadingRef.current = false; }
  }

  /**
   * Pivot per-instrument field series into per-timestamp chain snapshots. Uses
   * broker-served Greeks if present; otherwise reconstructs delta/vega/theta via
   * Black-Scholes from option price (`close`) + spot at each timestamp. Each leg's
   * own expiry (from meta) drives the time-to-expiry, so multiple expiries merge
   * correctly into shared timestamp buckets. Returns # of historical snapshots added.
   */
  function mergeHistory(perName: Map<string, Record<string, TsV[]>>, spot: TsV[]): number {
    const meta = metaRef.current;
    const buckets = new Map<number, ChainSnapshot>();

    const addLeg = (ts: number, type: 'CE' | 'PE', leg: AggLeg) => {
      let snap = buckets.get(ts);
      if (!snap) { snap = { ts, ce: [], pe: [] }; buckets.set(ts, snap); }
      (type === 'CE' ? snap.ce : snap.pe).push(leg);
    };

    for (const [name, series] of perName) {
      const m = meta.get(name);
      if (!m) continue;
      const oiByTs = new Map<number, number>();
      for (const e of (series.cumulative_oi || [])) oiByTs.set(normTs(e.ts), e.v);
      const hasGreeks = !!(series.delta?.length || series.vega?.length || series.theta?.length);

      if (hasGreeks) {
        const byTs = new Map<number, { delta?: number; vega?: number; theta?: number }>();
        const put = (f: 'delta' | 'vega' | 'theta', arr?: TsV[]) => {
          for (const { ts, v } of (arr || [])) { const k = normTs(ts); byTs.set(k, { ...byTs.get(k), [f]: v }); }
        };
        put('delta', series.delta); put('vega', series.vega); put('theta', series.theta);
        for (const [ts, g] of byTs) addLeg(ts, m.type, { sp: m.sp, exp: m.exp, ...g, oi: oiByTs.get(ts) });
      } else {
        // Reconstruct from price + spot via Black-Scholes.
        for (const e of (series.close || [])) {
          const ts = normTs(e.ts);
          const price = e.v / 100;
          if (!(price > 0)) continue;
          const S = nearestSpot(spot, ts);
          if (!(S > 0)) continue;
          const T = yearsToExpiry(m.exp, ts);
          let iv = impliedVolatility(price, S, m.sp, T, RISK_FREE, m.type);
          if (!(iv > 0) || !Number.isFinite(iv)) iv = 0.2;
          const g = blackScholes(S, m.sp, T, RISK_FREE, iv, m.type);
          addLeg(ts, m.type, { sp: m.sp, exp: m.exp, delta: g.delta, vega: g.vega, theta: g.theta, oi: oiByTs.get(ts) });
        }
      }
    }

    let added = 0;
    for (const [ts, snap] of buckets) if (!snapshotsRef.current.has(ts)) { snapshotsRef.current.set(ts, snap); added++; }
    return added;
  }

  // ── Public actions ──────────────────────────────────────────────────────
  function cancelDraw() {
    if (drawTimerRef.current != null) { clearTimeout(drawTimerRef.current); drawTimerRef.current = null; }
    drawPendingRef.current = false;
  }

  function toggle() {
    if (enabledRef.current) {
      enabledRef.current = false;
      setOn(false);
      setShowPopup(false);
      cancelDraw();
      stopLivePoll();
      destroyPanes();
      unsubscribeWsAll();
      liveLegsRef.current = new Map();
      setLegend([]);
    } else if (currentInstRef.current) {
      loadChain();
    }
  }

  function openSettings() {
    setShowPopup(v => !v);
    if (!expiries.length && currentInstRef.current) loadChain();
  }

  function applySettings() {
    setShowPopup(false);
    if (selExpiries.length) reloadAll(selExpiries);
  }

  function clearForInstrumentChange() {
    enabledRef.current = false;
    setOn(false);
    cancelDraw();
    stopLivePoll();
    destroyPanes();
    unsubscribeWsAll();
    liveLegsRef.current = new Map();
    snapshotsRef.current = new Map();
    metaRef.current = new Map();
    greekDateRef.current = '';
    defaultDayRef.current = '';
    lastSnapMsRef.current = 0;
    setLegend([]);
    setGreekDateState('');
    setLatestDay('');
    setHistState('idle');
    setHistGranularity('');
  }

  return {
    on, showPopup, expiries, selExpiries, method, basket, seriesMode, showCalls, showPuts, legend, histState, histGranularity,
    ceColor: palette.ce, peColor: palette.pe,
    greekDate, latestDay, setGreekDate,
    setShowPopup, toggleExpiry, setMethod, setBasket, setSeriesMode, setShowCalls, setShowPuts,
    toggle, openSettings, applySettings, clearForInstrumentChange, enabledRef,
  };
}
