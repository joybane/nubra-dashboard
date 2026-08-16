import { useEffect, useMemo, useRef, useState } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Instrument, OhlcBar, OptionChainData, WsMessage, OptionLeg } from '../types';

// Server enriches each leg with `symbol` (stock_name) for the historical query.
type ChainLeg = OptionLeg & { symbol?: string };
type ChainResp = {
  chain?: OptionChainData & {
    lot_size?: number;
    all_expiries?: string[];
    ce?: ChainLeg[];
    pe?: ChainLeg[];
  };
};
/** `/api/historical` response: result → values → { instrumentName: { field: points[] } }. */
type HistoricalResp = {
  result?: Array<{ values?: Array<Record<string, Record<string, TsV[]>>> }>;
} | null;
/** `/api/iv-history` response, or `{ error }` when the underlying has no parquet baseline. */
type IvHistoryResp = { observations?: IvObservation[]; from?: string; to?: string; error?: string };
import { getChainAsset, getSymbol } from '../types';
import {
  IST_OFFSET,
  expiryInstantMs,
  isMarketOpenNow,
  isMarketSessionChartTime,
  strikeRs,
} from '../lib/utils';
import {
  buildIvSeries,
  buildSeries,
  withinPruneBand,
  type AggLeg,
  type Baseline,
  type ChainSnapshot,
  type GreekName,
  type IvMeasure,
  type IvPoint,
  type Method,
  type Basket,
  type Composition,
} from '../lib/greekAggregator';
import {
  createGreekPane,
  createIvPane,
  type GreekPane,
  type IvPane,
  type SeriesMode,
  type TimeMapper,
} from '../lib/greekRenderer';
import {
  blackScholes,
  forwardFromParity,
  impliedVolatility,
  mcxFutureSymbol,
  mcxUnderlyingFutureExpiry,
  RISK_FREE,
} from '../lib/GexService';
import { computeIvRank, dteFromExpiry, type IvObservation, type IvRankResult } from '../lib/ivRank';
import { sharedJson } from '../lib/sharedRequest';
import { useWs } from './useWsContext';

/**
 * Option chain for one asset (optionally one expiry), shared across overlay instances.
 * `exchange` is omitted for NSE so the request URL — and therefore the share key —
 * stays byte-identical to what it has always been.
 */
function fetchChainShared(sym: string, expiry?: string, exchange?: string): Promise<ChainResp> {
  const params = new URLSearchParams();
  if (expiry) params.set('expiry', expiry);
  if (exchange && exchange.toUpperCase() !== 'NSE') params.set('exchange', exchange.toUpperCase());
  const qs = params.toString();
  const url = `/api/optionchain/${encodeURIComponent(sym)}${qs ? `?${qs}` : ''}`;
  return sharedJson<ChainResp>(`chain:${url}`, CHAIN_TTL_MS, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`chain ${res.status}`);
    return res.json() as Promise<ChainResp>;
  });
}

/**
 * Historical daily ATM IV baseline for rank/percentile. Shared and long-TTL'd: the parquet tree
 * it reads is immutable within a session, and all three overlay instances mount at once.
 */
function fetchIvHistoryShared(sym: string, days: number): Promise<IvHistoryResp> {
  const url = `/api/iv-history?und=${encodeURIComponent(sym)}&days=${days}`;
  return sharedJson<IvHistoryResp>(`ivhist:${url}`, IV_HIST_TTL_MS, async () => {
    const res = await fetch(url);
    const body = (await res.json()) as IvHistoryResp;
    // 400 = underlying we hold no parquet for (BANKNIFTY, stocks). That is a legitimate
    // "no baseline" answer, not a failure — surface the server's message rather than throwing,
    // so a rejection is never cached against a symbol that will never have data.
    if (!res.ok) return { error: body?.error || `iv-history ${res.status}` };
    return body;
  });
}

/** One `/api/historical` POST, shared by body. Response is treated as read-only. */
function fetchHistoricalShared(body: unknown): Promise<HistoricalResp> {
  const payload = JSON.stringify(body);
  return sharedJson<HistoricalResp>(`hist:${payload}`, HIST_TTL_MS, async () => {
    const res = await fetch('/api/historical', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    if (!res.ok) throw new Error(`historical ${res.status}`);
    return res.json() as Promise<HistoricalResp>;
  });
}

// The broker timeseries does NOT store historical Greeks (delta/vega/theta are
// real-time analytics), so we reconstruct them via Black-Scholes from historical
// option price (`close`) + spot. Per-point IV inversion makes 1s reconstruction
// prohibitively expensive across a whole basket, so history is built at 1m; the
// live WS path stays true per-tick. If a future API serves Greek fields directly,
// they're used as-is (no reconstruction) — see mergeHistory.
const HIST_INTERVAL = '1m';
// `iv` is requested on the same speculative basis as delta/vega/theta: the chain endpoint
// serves it today, so if the timeseries does too we skip inversion entirely and land history
// on the same volatility footing as the live tail. Absent, mergeHistory inverts as before.
const HIST_FIELDS = ['close', 'cumulative_oi', 'delta', 'vega', 'theta', 'iv'];

type TsV = { ts: number; v: number };
// The broker `/charts/timeseries` endpoint returns ts in NANOSECONDS (the candle
// path divides by 1e9). Normalize any plausible unit (s / ms / µs / ns) to epoch
// milliseconds by magnitude so reconstructed history lands on the real timeline
// rather than astronomically far right (which also yields "Invalid Date" labels).
const normTs = (ts: number | string): number => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (n >= 1e17) return Math.round(n / 1e6); // nanoseconds  → ms
  if (n >= 1e14) return Math.round(n / 1e3); // microseconds → ms
  if (n >= 1e11) return n; // milliseconds
  return n * 1000; // seconds      → ms
};

/**
 * Years to expiry at a given epoch-ms instant. Options settle at their exchange's
 * close — 15:30 IST on NSE/BSE, 23:30 on MCX — so the instant comes from
 * `expiryInstantMs` rather than a literal here. See its doc comment for how the
 * MCX close was measured off the vendor's own vega.
 */
function yearsToExpiry(expiry: string, ms: number, exchange?: string): number {
  const exp = expiryInstantMs(expiry, exchange);
  const days = Number.isFinite(exp) ? Math.max(0, (exp - ms) / 86_400_000) : 1;
  return Math.max(days / 365, 1 / (365 * 24));
}

/** Nearest spot value to `ts` from a time-sorted series (binary search). */
function nearestSpot(spot: TsV[], ts: number): number {
  if (!spot.length) return 0;
  let lo = 0,
    hi = spot.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spot[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  const a = spot[Math.max(0, lo - 1)],
    b = spot[lo];
  return Math.abs(a.ts - ts) <= Math.abs(b.ts - ts) ? a.v : b.v;
}
const SNAP_MIN_GAP_MS = 2_000; // throttle live snapshot storage (tick-by-tick: ~2s greek points)
// Live fallback poll: the line is driven by per-tick `option_chain` WS pushes, but
// the broker pushes only on change and can stay silent for minutes (and SIM relies
// entirely on it). Like the Option Chain view, poll the REST chain on a cadence —
// but only when the WS feed has gone quiet — so the line tracks the latest candle.
const LIVE_POLL_MS = 4_000; // fallback-poll cadence
const WS_QUIET_MS = 6_000; // only poll once the WS feed has been silent this long
// Coalesces the intermediate values a typed date emits. Long enough to swallow keystrokes
// (~150-250 ms apart in a date field), short enough that using the picker feels immediate.
const DAY_FETCH_DEBOUNCE_MS = 350;
// Vega, Theta and IV are separate hook instances asking for identical data. WS subs are already
// refcounted (ocSubRegistry); these TTLs de-duplicate the REST paths. The chain TTL sits just
// under LIVE_POLL_MS so three independently-drifting 4 s poll timers still cost one request per
// cycle; history is immutable for a past window and only refetched on an explicit day change.
const CHAIN_TTL_MS = 3_500;
const HIST_TTL_MS = 15_000;
// The parquet tree behind the IV baseline only changes when new data is dropped into it, which
// does not happen mid-session — so this is effectively a session-long cache.
const IV_HIST_TTL_MS = 30 * 60_000;
// Lookback for IV rank. One year is the convention, and it is also roughly what keeps the
// 16-31 DTE band (monthlies only, ~12 run-ups a year) above MIN_SAMPLE.
const IV_RANK_DAYS = 365;
const METHOD_LABEL: Record<Method, string> = { mine: 'mine', industry: 'ind' };

/** 'iv' plots a constant-delta volatility measure instead of an aggregated Greek. */
export type OverlayKind = GreekName | 'iv';

export interface GreekOverlayApi {
  on: boolean;
  showPopup: boolean;
  expiries: string[];
  selExpiries: string[];
  method: Method | 'both';
  basket: Basket;
  baseline: Baseline;
  composition: Composition;
  seriesMode: SeriesMode;
  showCalls: boolean;
  showPuts: boolean;
  /** True when this overlay plots IV — the host can hide Greek-only controls. */
  isIv: boolean;
  ivMeasure: IvMeasure;
  ivLegend: IvPoint | null;
  /**
   * IV rank/percentile of the live ATM reading against a DTE-matched year of history.
   * Null when this overlay is not IV, the measure is not ATM, or the baseline has not loaded.
   */
  ivRank: IvRankResult | null;
  /** Why no baseline is available (e.g. underlying with no parquet history). '' when fine. */
  ivRankNote: string;
  /** Days to the nearest selected expiry — the maturity the rank is matched on. */
  ivRankDte: number;
  /** Legs dropped from history because no finite IV existed for them (A2). */
  droppedLegs: number;
  histState: 'idle' | 'loading' | 'ok' | 'nogreeks' | 'partial';
  histGranularity: string; // '1s' | '1m' | '' — which resolution backfilled
  ceColor: string; // CE/PE line colors (distinct per greek) for legend swatches
  peColor: string;
  greekDate: string; // 'YYYY-MM-DD' trading day being reconstructed
  latestDay: string; // most recent loaded trading day (date-picker max / "Latest")
  setGreekDate: (d: string) => void;
  setShowPopup: (v: boolean | ((p: boolean) => boolean)) => void;
  toggleExpiry: (exp: string, shift: boolean) => void;
  setMethod: (v: Method | 'both') => void;
  setBasket: (v: Basket) => void;
  setBaseline: (v: Baseline) => void;
  setComposition: (v: Composition) => void;
  setSeriesMode: (v: SeriesMode) => void;
  setShowCalls: (v: boolean) => void;
  setShowPuts: (v: boolean) => void;
  setIvMeasure: (v: IvMeasure) => void;
  toggle: () => void;
  openSettings: () => void;
  applySettings: () => void;
  refresh: () => void;
  /**
   * Hand this measure's price scales back to autoscale after a manual axis drag froze one.
   *
   * They are overlay scales created inside `greekRenderer` from an internal `scaleKey`, so a host
   * has no id to pass to `chart.priceScale()` — without this they cannot be recovered at all.
   */
  resetScales: () => void;
  clearForInstrumentChange: () => void;
  enabledRef: React.RefObject<boolean>;
}

interface Deps {
  greek: OverlayKind;
  chartRef: React.RefObject<IChartApi | null>;
  currentInstRef: React.RefObject<Instrument | null>;
  allBarsRef: React.RefObject<OhlcBar[]>;
  /** Render greeks inline on the price pane (Tracker) instead of a sub-pane below (Chart). */
  inline?: boolean;
  /**
   * Visible axis ('left' / 'right') for the inline totals, instead of an invisible overlay
   * scale. Only meaningful with `inline`; see `GreekPaneOpts.axisScaleId` for why a host that
   * OWNS its pane wants this and the Tracker, which does not, leaves it unset.
   *
   * Only ONE measure can hold a given axis, so a host stacking several in one pane hands 'left' to
   * whichever it wants labelled and leaves the rest on their private overlay scales. Changing this
   * after the panes exist rebuilds them: a series' `priceScaleId` is fixed at creation.
   */
  axisScaleId?: string;
  /**
   * Trailing days of history to reconstruct, ending at the selected day. Defaults to
   * GREEK_HIST_DAYS (7), which matches the Chart and Tracker candle loads.
   *
   * Hosts whose window is a single trade — a Nubra BT run, a position being reviewed — pass 1.
   * Reconstruction cost is linear in this: every day is another `/api/historical` span across
   * the whole basket, so asking for a backtest's full multi-month range would be dozens of
   * batched calls for a line the user reads one session at a time.
   */
  histDays?: number;
  /**
   * Trading day ('YYYY-MM-DD') to reconstruct first, instead of the last loaded bar's day.
   * Lets a host open straight on the day its trade happened. Ignored if it is later than the
   * last loaded bar, which is both the date picker's max and the newest day with data.
   */
  initialDay?: string;
}

// Distinct CE/PE palette per greek so overlapping Vega + Theta lines stay tellable apart.
// 'iv' is a single line, so only `ce` is used for it.
const GREEK_PALETTE: Record<OverlayKind, { ce: string; pe: string }> = {
  vega: { ce: '#22c55e', pe: '#ef4444' }, // green / red
  theta: { ce: '#a855f7', pe: '#f59e0b' }, // purple / amber
  iv: { ce: '#38bdf8', pe: '#38bdf8' }, // sky
};

const KIND_LABEL: Record<OverlayKind, string> = { vega: 'Vega', theta: 'Theta', iv: 'IV' };
// Display text only — overlay price-scale identity comes from the explicit `scaleKey` passed to
// the pane factories, so these are free to contain `Δ` and `·` without risking an id collision.
const IV_MEASURE_LABEL: Record<IvMeasure, string> = {
  atm: 'ATM IV',
  rr25: '25Δ RR',
  fly25: '25Δ Fly',
};

// Trailing window (calendar days) of greek history to reconstruct, ending at the
// selected day — matches the Tracker's 7-day candle load so greeks span the chart.
const GREEK_HIST_DAYS = 7;

// Legs outside the prune band are dropped at ingest — 84% fewer objects, 5.2x faster redraws,
// bit-identical output. See withinPruneBand in greekAggregator for why it is safe.

export function useGreekOverlay({
  greek,
  chartRef,
  currentInstRef,
  allBarsRef,
  inline,
  axisScaleId,
  histDays,
  initialDay,
}: Deps): GreekOverlayApi {
  const { subscribe, subscribeOC, unsubscribeOC } = useWs();
  const isIv = greek === 'iv';
  const greekLabel = KIND_LABEL[greek];
  const palette = GREEK_PALETTE[greek];

  // ── State ────────────────────────────────────────────────────────────────
  const [on, setOn] = useState(false);
  const [showPopup, setShowPopup] = useState(false);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selExpiries, setSelExpiries] = useState<string[]>([]);
  const [method, setMethodState] = useState<Method | 'both'>('mine');
  // Floating by default: the line should read the near-the-money basket as it actually is now,
  // re-filtered every snapshot. 'fixed' — the basket locked at t_min, drift and all — stays one
  // click away for reading a single day's cohort.
  const [basket, setBasketState] = useState<Basket>('floating');
  const [baseline, setBaselineState] = useState<Baseline>('session');
  // Chained by default: a strike crossing the delta band's top edge carries ~96% of peak vega
  // with it, so a raw sum steps for reasons that are not Greek movement. 'raw' stays one click
  // away for reading the live basket's actual level.
  const [composition, setCompositionState] = useState<Composition>('chained');
  const [seriesMode, setSeriesModeState] = useState<SeriesMode>('both');
  const [showCalls, setShowCallsState] = useState(true);
  const [showPuts, setShowPutsState] = useState(true);
  const [ivMeasure, setIvMeasureState] = useState<IvMeasure>('atm');
  const [ivLegend, setIvLegend] = useState<IvPoint | null>(null);
  const [ivObs, setIvObs] = useState<IvObservation[]>([]);
  const [ivRankNote, setIvRankNote] = useState('');
  const [droppedLegs, setDroppedLegs] = useState(0);
  const [histState, setHistState] = useState<'idle' | 'loading' | 'ok' | 'nogreeks' | 'partial'>(
    'idle',
  );
  const [histGranularity, setHistGranularity] = useState('');
  const [greekDate, setGreekDateState] = useState('');
  const [latestDay, setLatestDay] = useState('');

  // ── Refs ─────────────────────────────────────────────────────────────────
  const enabledRef = useRef(false);
  const snapshotsRef = useRef<Map<number, ChainSnapshot>>(new Map());
  const lastSnapMsRef = useRef(0);
  const lotSizeRef = useRef(1);
  const metaRef = useRef<Map<string, { sp: number; type: 'CE' | 'PE'; exp: string }>>(new Map());
  const underlyingRef = useRef<string>('');
  const minePaneRef = useRef<GreekPane | null>(null);
  const indPaneRef = useRef<GreekPane | null>(null);
  const ivPaneRef = useRef<IvPane | null>(null);
  // Multi-expiry WS state + latest live legs per expiry (merged into each snapshot).
  const wsAssetRef = useRef<string | null>(null);
  const wsExpiriesRef = useRef<Set<string>>(new Set());
  const wsExchRef = useRef('NSE');
  const liveLegsRef = useRef<Map<string, { ce: AggLeg[]; pe: AggLeg[] }>>(new Map());
  const anchorExpiryRef = useRef('');
  const greekDateRef = useRef(''); // selected reconstruction day (mirrors greekDate)
  // There is deliberately no "default day" ref here. The live guards below ask `istTodayKey()`
  // whether the chart is showing today; the last LOADED day is a different question, answered by
  // defaultGreekDay() and surfaced as `latestDay` for the date picker's max.
  // Generation token for historical loads. A boolean "is loading" flag made rapid day
  // switches drop the newer request entirely; instead every call takes a ticket and stale
  // results are discarded on arrival, so the last day requested always wins.
  const histGenRef = useRef(0);
  const dayFetchTimerRef = useRef<number | null>(null);
  const drawPendingRef = useRef(false);
  const lastDrawMsRef = useRef(0);
  const drawTimerRef = useRef<number | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const lastWsTickRef = useRef(0); // last time a live WS option_chain tick was applied
  const pollTimerRef = useRef<number | null>(null);
  const pollBusyRef = useRef(false);

  // Mirror settings into refs so the WS callback and redraw read fresh values.
  const cfgRef = useRef({
    method,
    basket,
    baseline,
    composition,
    seriesMode,
    showCalls,
    showPuts,
    ivMeasure,
  });
  cfgRef.current = {
    method,
    basket,
    baseline,
    composition,
    seriesMode,
    showCalls,
    showPuts,
    ivMeasure,
  };

  const setMethod = (v: Method | 'both') => {
    setMethodState(v);
    cfgRef.current.method = v;
    syncPanes(v);
    requestDraw();
  };
  const setBasket = (v: Basket) => {
    setBasketState(v);
    cfgRef.current.basket = v;
    requestDraw();
  };
  const setBaseline = (v: Baseline) => {
    setBaselineState(v);
    cfgRef.current.baseline = v;
    requestDraw();
  };
  const setComposition = (v: Composition) => {
    setCompositionState(v);
    cfgRef.current.composition = v;
    requestDraw();
  };
  const setSeriesMode = (v: SeriesMode) => {
    setSeriesModeState(v);
    cfgRef.current.seriesMode = v;
    requestDraw();
  };
  const setShowCalls = (v: boolean) => {
    setShowCallsState(v);
    cfgRef.current.showCalls = v;
    requestDraw();
  };
  const setShowPuts = (v: boolean) => {
    setShowPutsState(v);
    cfgRef.current.showPuts = v;
    requestDraw();
  };
  const setIvMeasure = (v: IvMeasure) => {
    setIvMeasureState(v);
    cfgRef.current.ivMeasure = v;
    syncPanes(cfgRef.current.method);
    requestDraw();
  };

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
  /**
   * Hand every scale this measure owns back to autoscale — see `GreekPane.resetScales`.
   *
   * Exposed on the api because the scales are overlay scales whose ids live inside the renderer:
   * a host cannot name them, so it cannot reach them through `chart.priceScale(id)`.
   */
  function resetScales() {
    minePaneRef.current?.resetScales();
    indPaneRef.current?.resetScales();
    ivPaneRef.current?.resetScales();
  }

  function syncPanes(m: Method | 'both') {
    const chart = chartRef.current;
    if (!chart || !enabledRef.current) return;
    const paneOpts = {
      ...(inline ? { inline: true, paneIndex: 0, axisScaleId } : {}),
      ceColor: palette.ce,
      peColor: palette.pe,
      // Resolved per draw: panes are reused across instrument switches, so this has to
      // follow the current symbol rather than whatever was showing when it was created.
      exchange: () => currentInstRef.current?.exchange,
    };

    // IV is one line and has no method/basket dimension — a single pane, retitled when the
    // measure changes so the axis tag and tooltip name the measure being shown.
    if (isIv) {
      const measure = cfgRef.current.ivMeasure;
      const title = `${greekLabel}·${IV_MEASURE_LABEL[measure]}`;
      if (ivPaneRef.current) {
        ivPaneRef.current.destroy();
        ivPaneRef.current = null;
      }
      ivPaneRef.current = createIvPane(chart, title, { ...paneOpts, scaleKey: measure });
      return;
    }

    const wantMine = m === 'mine' || m === 'both';
    const wantInd = m === 'industry' || m === 'both';
    if (wantMine && !minePaneRef.current)
      minePaneRef.current = createGreekPane(chart, `${greekLabel}·${METHOD_LABEL.mine}`, {
        ...paneOpts,
        scaleKey: `${greek}-mine`,
      });
    if (!wantMine && minePaneRef.current) {
      minePaneRef.current.destroy();
      minePaneRef.current = null;
    }
    if (wantInd && !indPaneRef.current)
      indPaneRef.current = createGreekPane(chart, `${greekLabel}·${METHOD_LABEL.industry}`, {
        ...paneOpts,
        scaleKey: `${greek}-industry`,
      });
    if (!wantInd && indPaneRef.current) {
      indPaneRef.current.destroy();
      indPaneRef.current = null;
    }
  }

  function destroyPanes() {
    minePaneRef.current?.destroy();
    minePaneRef.current = null;
    indPaneRef.current?.destroy();
    indPaneRef.current = null;
    ivPaneRef.current?.destroy();
    ivPaneRef.current = null;
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
        drawTimerRef.current = window.setTimeout(() => {
          drawTimerRef.current = null;
          runDraw();
        }, MIN_DRAW_MS - since);
      }
      return;
    }
    drawPendingRef.current = true;
    drawRafRef.current = requestAnimationFrame(runDraw);
  }

  function runDraw() {
    drawRafRef.current = null;
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
      if (!Number.isFinite(ct) || !isMarketSessionChartTime(ct, currentInstRef.current?.exchange))
        return null;
      if (!n) return ct;
      if (ct < times[0]) return null; // before chart range — don't render
      if (ct >= times[n - 1]) return times[n - 1]; // live/future → clamp to last bar
      let lo = 0,
        hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= ct) lo = mid;
        else hi = mid - 1;
      }
      return times[lo];
    };
  }

  function redraw() {
    if (!enabledRef.current) return;
    const snaps = [...snapshotsRef.current.values()];
    if (!snaps.length) return;
    const {
      method: m,
      basket: b,
      baseline: bl,
      composition: cmp,
      seriesMode: mode,
      showCalls: sc,
      showPuts: sp,
      ivMeasure: im,
    } = cfgRef.current;
    const mapTime = buildTimeMapper();

    // Checked against the discriminant rather than `isIv` so `greek` narrows to GreekName below.
    if (greek === 'iv') {
      const pts = buildIvSeries(snaps, { measure: im });
      ivPaneRef.current?.setData(pts, mapTime);
      setIvLegend(pts.length ? pts[pts.length - 1] : null);
      return;
    }

    const lotSize = lotSizeRef.current;

    const draw = (pane: GreekPane | null, mt: Method) => {
      if (!pane) return;
      const pts = buildSeries(snaps, {
        greek,
        method: mt,
        basket: b,
        baseline: bl,
        composition: cmp,
        lotSize,
      });
      pane.setData(pts, mode, sc, sp, mapTime);
    };

    if (m === 'mine' || m === 'both') draw(minePaneRef.current, 'mine');
    if (m === 'industry' || m === 'both') draw(indPaneRef.current, 'industry');
  }

  // ── Snapshot helpers ───────────────────────────────────────────────────────
  function legsFromChain(
    data: { ce?: OptionLeg[]; pe?: OptionLeg[] },
    exp: string,
  ): { ce: AggLeg[]; pe: AggLeg[] } {
    const map = (legs: OptionLeg[] | undefined): AggLeg[] =>
      (legs || []).map((l) => ({
        sp: strikeRs(l),
        delta: l.delta,
        vega: l.vega,
        theta: l.theta,
        oi: l.oi,
        iv: l.iv,
        exp,
      }));
    return { ce: map(data.ce), pe: map(data.pe) };
  }

  function mergeLegSide(prev: AggLeg[], updates: AggLeg[]): AggLeg[] {
    if (!updates.length) return prev;
    const key = (leg: AggLeg) => `${leg.exp || ''}:${leg.sp}`;
    const byStrike = new Map(prev.map((leg) => [key(leg), leg]));
    for (const leg of updates) byStrike.set(key(leg), leg);
    return [...byStrike.values()].sort((a, b) => a.sp - b.sp);
  }

  function mergeLiveLegs(exp: string, update: { ce: AggLeg[]; pe: AggLeg[] }) {
    const prev = liveLegsRef.current.get(exp);
    liveLegsRef.current.set(
      exp,
      prev
        ? { ce: mergeLegSide(prev.ce, update.ce), pe: mergeLegSide(prev.pe, update.pe) }
        : update,
    );
  }

  /** Combine the latest live legs across all selected expiries into one snapshot. */
  function storeCombinedLive(force = false) {
    const ce: AggLeg[] = [],
      pe: AggLeg[] = [];
    for (const v of liveLegsRef.current.values()) {
      ce.push(...v.ce);
      pe.push(...v.pe);
    }
    if (!ce.length && !pe.length) return;
    storeSnapshot({ ts: Date.now(), ce, pe }, force);
  }

  function storeSnapshot(snap: ChainSnapshot, force = false) {
    const ct = Math.floor(snap.ts / 1000) + IST_OFFSET;
    if (!isMarketSessionChartTime(ct, currentInstRef.current?.exchange)) return;
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
      // Live ticks only belong on today's chart; skip while inspecting any past day.
      if (greekDateRef.current && greekDateRef.current !== istTodayKey()) return;
      if (!isMarketOpenNow(currentInstRef.current?.exchange)) return;
      lastWsTickRef.current = Date.now(); // WS is alive → fallback poll stays idle
      mergeLiveLegs(exp, legsFromChain(data, exp));
      storeCombinedLive();
      requestDraw();
    });
    return unsub;
  }, [subscribe]);

  // Stop the fallback poll and any queued redraw on unmount (toggle/clear handle the
  // normal teardown paths). Without cancelDraw here, a redraw queued in the last frame
  // before the host chart unmounts lands on a removed chart.
  useEffect(
    () => () => {
      stopLivePoll();
      cancelDraw();
      cancelDayFetch();
    },
    [],
  );

  // ── Layout: the axis the totals hang off ───────────────────────────────────
  // Moving the visible axis to another measure is the one layout change that CANNOT be applied in
  // place: `priceScaleId` is fixed when a series is created, so the panes have to be rebuilt onto
  // the new scale and re-fed. Same destroy/recreate the IV-measure switch above already does, and
  // it only runs when the user toggles a measure — never on a tick.
  const firstAxisRef = useRef(true);
  useEffect(() => {
    if (firstAxisRef.current) {
      firstAxisRef.current = false; // the initial panes are built with this axis already
      return;
    }
    if (!enabledRef.current || !chartRef.current) return;
    destroyPanes();
    syncPanes(cfgRef.current.method);
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axisScaleId]);

  function subscribeWsMulti(asset: string, expiriesSel: string[], exchange: string) {
    unsubscribeWsAll();
    wsAssetRef.current = asset;
    wsExchRef.current = exchange;
    wsExpiriesRef.current = new Set(expiriesSel);
    for (const exp of expiriesSel) subscribeOC(asset, exp, exchange);
  }
  function unsubscribeWsAll() {
    if (wsAssetRef.current) {
      for (const exp of wsExpiriesRef.current)
        unsubscribeOC(wsAssetRef.current, exp, wsExchRef.current);
    }
    wsExpiriesRef.current = new Set();
    wsAssetRef.current = null;
  }

  // ── Live fallback poll ─────────────────────────────────────────────────────
  // Drives the line forward when the WS option_chain feed is silent, so greeks
  // track the latest candle instead of freezing minutes behind the price.
  function stopLivePoll() {
    if (pollTimerRef.current != null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function startLivePoll() {
    stopLivePoll();
    pollTimerRef.current = window.setInterval(() => {
      if (!enabledRef.current) return;
      if (greekDateRef.current !== istTodayKey()) return; // inspecting a past day
      if (!isMarketOpenNow(currentInstRef.current?.exchange)) return;
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
      const sym = getChainAsset(inst);
      const exps = [...wsExpiriesRef.current];
      let any = false;
      for (const exp of exps) {
        try {
          const data = await fetchChainShared(sym, exp, inst.exchange);
          if (data.chain) {
            liveLegsRef.current.set(exp, legsFromChain(data.chain, exp));
            any = true;
          }
        } catch {
          /* skip this expiry */
        }
      }
      if (any && enabledRef.current) {
        storeCombinedLive();
        requestDraw();
      }
    } finally {
      pollBusyRef.current = false;
    }
  }

  // ── Load chain (expiries, lot size, opening snapshot) ──────────────────────
  async function loadChain() {
    const inst = currentInstRef.current;
    if (!inst) return;
    const sym = getChainAsset(inst);
    try {
      const data = await fetchChainShared(sym, undefined, inst.exchange);
      if (!data.chain) return;
      const exps = data.chain.all_expiries || [];
      setExpiries(exps);
      const initial = selExpiries.length ? selExpiries : exps[0] ? [exps[0]] : [];
      setSelExpiries(initial);
      anchorExpiryRef.current = initial[0] || '';
      if (typeof data.chain.lot_size === 'number' && data.chain.lot_size > 0)
        lotSizeRef.current = data.chain.lot_size;
      await reloadAll(initial);
    } catch (e) {
      console.warn(`[${greekLabel}] loadChain failed:`, e);
    }
  }

  async function reloadAll(expiriesSel: string[]) {
    const inst = currentInstRef.current;
    if (!inst || !expiriesSel.length) return;
    // On MCX the chain is keyed by the commodity, not by the futures contract that
    // underlies it; everywhere else the two are the same string.
    const sym = getChainAsset(inst);
    try {
      const meta = new Map<string, { sp: number; type: 'CE' | 'PE'; exp: string }>();
      const liveLegs = new Map<string, { ce: AggLeg[]; pe: AggLeg[] }>();
      const open = isMarketOpenNow(currentInstRef.current?.exchange);
      let asset = '';

      for (const exp of expiriesSel) {
        const data = await fetchChainShared(sym, exp, inst.exchange);
        if (!data.chain) continue;
        if (typeof data.chain.lot_size === 'number' && data.chain.lot_size > 0)
          lotSizeRef.current = data.chain.lot_size;
        for (const l of data.chain.ce || [])
          if (l.symbol) meta.set(String(l.symbol), { sp: strikeRs(l), type: 'CE', exp });
        for (const l of data.chain.pe || [])
          if (l.symbol) meta.set(String(l.symbol), { sp: strikeRs(l), type: 'PE', exp });
        asset = (data.chain.asset || sym).toUpperCase();
        // Only seed a "now" snapshot during market hours; after close it would plot a
        // stray point at wall-clock time, far right of the day's candles.
        if (open) liveLegs.set(exp, legsFromChain(data.chain, exp));
      }
      if (!meta.size) return;

      metaRef.current = meta;
      // What `fetchSpotHistory` charts as the underlying. NSE has a spot index of
      // this name; MCX has none, so the tracked futures contract stands in.
      underlyingRef.current =
        (inst.exchange || '').toUpperCase() === 'MCX'
          ? getSymbol(inst).toUpperCase()
          : asset || sym.toUpperCase();
      liveLegsRef.current = liveLegs;

      snapshotsRef.current = new Map();
      lastSnapMsRef.current = 0;

      // Default to the latest trading day; preserve a past day the user already picked.
      const today = defaultGreekDay();
      setLatestDay(today);
      // A host may seed the day it actually cares about (the session a trade ran in) rather than
      // the last loaded bar. Clamped to `today` so a bad seed can never exceed the picker's max.
      const seeded = initialDay && initialDay <= today ? initialDay : '';
      const day = greekDateRef.current || seeded || today;
      greekDateRef.current = day;
      setGreekDateState(day);
      // Seed a "now" point only when the chart is actually showing today.
      if (liveLegs.size && day === istTodayKey()) storeCombinedLive(true);

      enabledRef.current = true;
      setOn(true);
      syncPanes(cfgRef.current.method);
      subscribeWsMulti(sym.toUpperCase(), expiriesSel, inst.exchange || 'NSE');
      lastWsTickRef.current = Date.now(); // grace period before the fallback poll kicks in
      startLivePoll();
      requestDraw();
      // Drop any debounced picker fetch — it may target a different day and would land in the
      // snapshot map we just reset, after this reload's own fetch.
      cancelDayFetch();
      fetchHistoryForDay(day);
    } catch (e) {
      console.warn(`[${greekLabel}] reload failed:`, e);
    }
  }

  // ── Historical backfill, reconstructed per trading day ─────────────────────
  /**
   * Today's IST calendar day — the only day a live tick can legitimately land on.
   *
   * Distinct from `defaultGreekDay()`, which is the last LOADED bar's day. The two coincide on
   * the Chart and Tracker, whose charts end at now, and that is why the live guards used to be
   * written against the loaded day. They diverge the moment a host charts a past window: a Nubra
   * BT run or a position review from yesterday has `defaultGreekDay() === greekDate`, so a
   * loaded-day guard would wave live chain data through and `buildTimeMapper` would clamp that
   * `Date.now()` snapshot onto the last bar of a historical session — today's greeks printed as
   * yesterday's close.
   */
  function istTodayKey(): string {
    return new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);
  }

  /** Latest loaded trading day as an IST 'YYYY-MM-DD' (bar.time has IST baked in). */
  function defaultGreekDay(): string {
    const bars = allBarsRef.current;
    const last = bars[bars.length - 1];
    if (last && typeof last.time === 'number')
      return new Date(last.time * 1000).toISOString().slice(0, 10);
    return new Date(Date.now() + IST_OFFSET * 1000).toISOString().slice(0, 10);
  }

  /**
   * Switch the reconstructed day: clear prior reconstruction and rebuild for `dateStr`.
   *
   * The picker is a native date input wired to fire on every change, so TYPING a date emits
   * several valid intermediate values — each of which would otherwise launch a full 7-day,
   * multi-batch historical fetch that nobody reads. UI state is applied immediately so the
   * field and status stay responsive; only the fetch is debounced. The generation token in
   * fetchHistoryForDay still guards correctness if a debounced call overlaps an in-flight one.
   */
  function setGreekDate(dateStr: string) {
    if (!dateStr) return;
    setGreekDateState(dateStr);
    greekDateRef.current = dateStr;
    snapshotsRef.current = new Map();
    lastSnapMsRef.current = 0;
    // Re-seed the live point only when returning to TODAY during market hours — not merely to
    // the last loaded bar's day, which on a historical host is a past session.
    if (
      dateStr === istTodayKey() &&
      liveLegsRef.current.size &&
      isMarketOpenNow(currentInstRef.current?.exchange)
    )
      storeCombinedLive(true);
    requestDraw();

    setHistState('loading'); // immediate feedback; the fetch itself lands after the debounce
    cancelDayFetch();
    dayFetchTimerRef.current = window.setTimeout(() => {
      dayFetchTimerRef.current = null;
      fetchHistoryForDay(dateStr);
    }, DAY_FETCH_DEBOUNCE_MS);
  }

  function cancelDayFetch() {
    if (dayFetchTimerRef.current != null) {
      clearTimeout(dayFetchTimerRef.current);
      dayFetchTimerRef.current = null;
    }
  }

  /** One historical pass → per-instrument field series (option price + OI [+ greeks]). */
  async function requestHistory(
    names: string[],
    type: string,
    exchange: string,
    start: Date,
    end: Date,
    fields: string[] = HIST_FIELDS,
  ) {
    const BATCH = 10;
    const chunks: string[][] = [];
    for (let i = 0; i < names.length; i += BATCH) chunks.push(names.slice(i, i + BATCH));

    const perName = new Map<string, Record<string, TsV[]>>();
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          return await fetchHistoricalShared({
            query: [
              {
                exchange,
                type,
                values: chunk,
                fields,
                startDate: start.toISOString(),
                endDate: end.toISOString(),
                interval: HIST_INTERVAL,
                intraDay: false,
                realTime: false,
              },
            ],
          });
        } catch {
          return null;
        }
      }),
    );

    for (const data of results) {
      for (const row of data?.result?.[0]?.values || []) {
        for (const [name, series] of Object.entries(row) as [string, Record<string, TsV[]>][]) {
          if (series) perName.set(name, series);
        }
      }
    }
    return perName;
  }

  /** Time-sorted spot series for the underlying (paise → rupees). */
  /**
   * MCX futures expiries for the tracked asset, cached per asset. Needed to map each
   * option expiry onto the contract it settles into — see `mcxUnderlyingFutureExpiry`.
   * Returns [] on any failure, which makes the caller fall back to the parity path.
   */
  const futExpiryCacheRef = useRef<Map<string, string[]>>(new Map());
  async function fetchMcxFutureExpiries(asset: string): Promise<string[]> {
    const cached = futExpiryCacheRef.current.get(asset);
    if (cached) return cached;
    try {
      const res = await fetch(
        `/api/instruments/search?q=${encodeURIComponent(`FUT_${asset}_`)}&exchange=MCX&type=FUT&limit=50`,
      );
      const { results } = (await res.json()) as { results?: Array<{ expiry?: number | string }> };
      const expiries = (results ?? [])
        .map((r) => String(r.expiry ?? ''))
        .filter((e) => /^\d{8}$/.test(e))
        .sort();
      futExpiryCacheRef.current.set(asset, expiries);
      return expiries;
    } catch {
      return [];
    }
  }

  /**
   * Per-expiry forward for MCX, read straight off the backing futures contract.
   *
   * Commodities have no spot, and the future a chain settles into *is* its forward, so
   * there is nothing to imply — this is exact where `buildParityForwards` is inferred.
   */
  async function fetchMcxForwards(
    asset: string,
    optionExpiries: string[],
    start: Date,
    end: Date,
  ): Promise<Map<string, Map<number, number>>> {
    const out = new Map<string, Map<number, number>>();
    const futExpiries = await fetchMcxFutureExpiries(asset);
    if (!futExpiries.length) return out;

    // Several option expiries can share one future, so fetch each contract once.
    const symbolByOptExpiry = new Map<string, string>();
    for (const exp of optionExpiries) {
      const futExp = mcxUnderlyingFutureExpiry(exp, futExpiries);
      if (futExp) symbolByOptExpiry.set(exp, mcxFutureSymbol(asset, futExp));
    }
    const symbols = [...new Set(symbolByOptExpiry.values())];
    if (!symbols.length) return out;

    const perSymbol = await requestHistory(symbols, 'FUT', 'MCX', start, end, ['close']);
    const seriesBySymbol = new Map<string, Map<number, number>>();
    for (const [name, series] of perSymbol) {
      const m = new Map<number, number>();
      for (const e of series.close || []) {
        const v = e.v / 100;
        if (v > 0) m.set(normTs(e.ts), v);
      }
      seriesBySymbol.set(name, m);
    }
    for (const [optExp, symbol] of symbolByOptExpiry) {
      const s = seriesBySymbol.get(symbol);
      if (s?.size) out.set(optExp, s);
    }
    return out;
  }

  async function fetchSpotHistory(exchange: string, start: Date, end: Date): Promise<TsV[]> {
    if (!underlyingRef.current) return [];
    try {
      const data = await fetchHistoricalShared({
        query: [
          {
            exchange,
            // MCX has no spot index — the underlying is a futures contract.
            type: exchange.toUpperCase() === 'MCX' ? 'FUT' : 'INDEX',
            values: [underlyingRef.current],
            fields: ['close'],
            startDate: start.toISOString(),
            endDate: end.toISOString(),
            interval: HIST_INTERVAL,
            intraDay: false,
            realTime: false,
          },
        ],
      });
      const out: TsV[] = [];
      for (const row of data?.result?.[0]?.values || []) {
        for (const series of Object.values(row) as Record<string, TsV[]>[]) {
          for (const e of series.close || []) out.push({ ts: normTs(e.ts), v: e.v / 100 });
        }
      }
      out.sort((a, b) => a.ts - b.ts);
      return out;
    } catch {
      return [];
    }
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
    if (!inst || !meta.size || !dateStr) return;
    // Take a ticket instead of bailing when another load is in flight: switching days twice
    // in quick succession used to clear the snapshots and then skip the refetch entirely,
    // leaving the popup reporting the previous day's status.
    const gen = ++histGenRef.current;
    setHistState('loading');

    const names = [...meta.keys()];
    const exchange = inst.exchange || 'NSE';
    // End the window at the exchange's own close, or an MCX day would be cut off at
    // 15:30 and lose its evening session.
    const endDate = new Date(expiryInstantMs(dateStr, exchange));
    // Trailing window. At the default 7 this spans the Chart/Tracker candle load; at 1 it is the
    // previous close → this close, i.e. exactly `dateStr`'s own session.
    const windowDays = histDays && histDays > 0 ? histDays : GREEK_HIST_DAYS;
    const startDate = new Date(endDate.getTime() - windowDays * 86_400_000);
    const isMcx = exchange.toUpperCase() === 'MCX';

    try {
      const [perName, spot, observedFwd] = await Promise.all([
        requestHistory(names, 'OPT', exchange, startDate, endDate),
        fetchSpotHistory(exchange, startDate, endDate),
        isMcx
          ? fetchMcxForwards(
              wsAssetRef.current || '',
              [...new Set([...meta.values()].map((m) => m.exp))],
              startDate,
              endDate,
            )
          : Promise.resolve(new Map<string, Map<number, number>>()),
      ]);

      if (gen !== histGenRef.current) return; // a newer day was requested — discard

      const { added, dropped } = mergeHistory(perName, spot, observedFwd);
      const ok = added > 0;
      setDroppedLegs(dropped);
      setHistState(ok ? (dropped > 0 ? 'partial' : 'ok') : 'nogreeks');
      setHistGranularity(ok ? HIST_INTERVAL : '');
      if (!ok) console.warn(`[${greekLabel}] no historical option/spot data for ${dateStr}.`);
      if (dropped > 0)
        console.warn(`[${greekLabel}] dropped ${dropped} unpriceable legs for ${dateStr}.`);
      requestDraw();
    } catch (e) {
      if (gen !== histGenRef.current) return;
      console.error(`[${greekLabel}] history fetch failed:`, e);
      setHistState('idle');
    }
  }

  /**
   * Pivot per-instrument field series into per-timestamp chain snapshots. Uses
   * broker-served Greeks if present; otherwise reconstructs delta/vega/theta via
   * Black-Scholes from option price (`close`) + spot at each timestamp. Each leg's
   * own expiry (from meta) drives the time-to-expiry, so multiple expiries merge
   * correctly into shared timestamp buckets. Returns # of historical snapshots added.
   */
  /**
   * Per-expiry, per-timestamp market-implied forward from put-call parity, built out of the
   * `close` series already fetched. Picks the strike nearest that timestamp's spot which has
   * BOTH a CE and a PE print. See forwardFromParity for the measurement that justifies
   * preferring this over any spot-derived forward.
   */
  function buildParityForwards(
    perName: Map<string, Record<string, TsV[]>>,
    spot: TsV[],
  ): Map<string, Map<number, number>> {
    const meta = metaRef.current;
    // exp -> ts -> strike -> { ce, pe }
    const pairs = new Map<string, Map<number, Map<number, { ce?: number; pe?: number }>>>();
    for (const [name, series] of perName) {
      const m = meta.get(name);
      if (!m) continue;
      for (const e of series.close || []) {
        const px = e.v / 100;
        if (!(px > 0)) continue;
        const ts = normTs(e.ts);
        let byTs = pairs.get(m.exp);
        if (!byTs) {
          byTs = new Map();
          pairs.set(m.exp, byTs);
        }
        let byStrike = byTs.get(ts);
        if (!byStrike) {
          byStrike = new Map();
          byTs.set(ts, byStrike);
        }
        const pair = byStrike.get(m.sp) ?? {};
        if (m.type === 'CE') pair.ce = px;
        else pair.pe = px;
        byStrike.set(m.sp, pair);
      }
    }

    const out = new Map<string, Map<number, number>>();
    for (const [exp, byTs] of pairs) {
      const fwd = new Map<number, number>();
      for (const [ts, byStrike] of byTs) {
        const S = nearestSpot(spot, ts);
        if (!(S > 0)) continue;
        let bestK = 0,
          bestGap = Infinity,
          bestCe = 0,
          bestPe = 0;
        for (const [K, pair] of byStrike) {
          if (pair.ce == null || pair.pe == null) continue;
          const gap = Math.abs(K - S);
          if (gap < bestGap) {
            bestGap = gap;
            bestK = K;
            bestCe = pair.ce;
            bestPe = pair.pe;
          }
        }
        if (bestK > 0)
          fwd.set(
            ts,
            forwardFromParity(
              bestK,
              bestCe,
              bestPe,
              RISK_FREE,
              yearsToExpiry(exp, ts, currentInstRef.current?.exchange),
            ),
          );
      }
      out.set(exp, fwd);
    }
    return out;
  }

  function mergeHistory(
    perName: Map<string, Record<string, TsV[]>>,
    spot: TsV[],
    /**
     * Observed forwards per option expiry. Supplied for MCX, where the backing future
     * *is* the forward; empty elsewhere, where it has to be implied from parity.
     */
    observedFwd: Map<string, Map<number, number>> = new Map(),
  ): { added: number; dropped: number } {
    const meta = metaRef.current;
    const exchange = currentInstRef.current?.exchange;
    const buckets = new Map<number, ChainSnapshot>();
    // Only pay for the parity solve where the forward is not already known.
    const parityFwd = observedFwd.size ? new Map() : buildParityForwards(perName, spot);
    let dropped = 0;

    /** Best available forward at `ts`: observed, else market-implied from parity, else spot. */
    const forwardAt = (exp: string, ts: number, S: number): number =>
      observedFwd.get(exp)?.get(ts) ?? parityFwd.get(exp)?.get(ts) ?? S;

    const addLeg = (ts: number, type: 'CE' | 'PE', leg: AggLeg) => {
      if (!isMarketSessionChartTime(Math.floor(ts / 1000) + IST_OFFSET, exchange)) return;
      if (!withinPruneBand(leg.delta)) return;
      let snap = buckets.get(ts);
      if (!snap) {
        snap = { ts, ce: [], pe: [] };
        buckets.set(ts, snap);
      }
      (type === 'CE' ? snap.ce : snap.pe).push(leg);
    };

    for (const [name, series] of perName) {
      const m = meta.get(name);
      if (!m) continue;
      const oiByTs = new Map<number, number>();
      for (const e of series.cumulative_oi || []) oiByTs.set(normTs(e.ts), e.v);
      const ivByTs = new Map<number, number>();
      for (const e of series.iv || []) ivByTs.set(normTs(e.ts), e.v);
      const hasGreeks = !!(series.delta?.length || series.vega?.length || series.theta?.length);

      if (hasGreeks) {
        const byTs = new Map<number, { delta?: number; vega?: number; theta?: number }>();
        const put = (f: 'delta' | 'vega' | 'theta', arr?: TsV[]) => {
          for (const { ts, v } of arr || []) {
            const k = normTs(ts);
            byTs.set(k, { ...byTs.get(k), [f]: v });
          }
        };
        put('delta', series.delta);
        put('vega', series.vega);
        put('theta', series.theta);

        // The timeseries serves historical delta/vega/theta, and `HIST_FIELDS` requests `iv`,
        // which is the one name it does NOT serve — the real fields are `iv_bid`/`iv_mid`/
        // `iv_ask` (confirmed live 2026-08-03). So `ivByTs` is empty in practice and this
        // branch derives IV by inversion from the `close` series instead. Switching
        // HIST_FIELDS to `iv_mid` would take the vendor's own series; deliberately not done,
        // see the IV section of README.md.
        //
        // Gated on `isIv`: the Vega/Theta overlays never read `iv`, and per-point inversion
        // across a whole basket is the expensive path we deliberately keep off the 1s route.
        const closeByTs = new Map<number, number>();
        if (isIv) for (const e of series.close || []) closeByTs.set(normTs(e.ts), e.v / 100);

        for (const [ts, g] of byTs) {
          let iv = ivByTs.get(ts);
          if (isIv && !(iv != null && Number.isFinite(iv) && iv > 0)) {
            const price = closeByTs.get(ts);
            const S = price != null && price > 0 ? nearestSpot(spot, ts) : 0;
            if (price != null && price > 0 && S > 0) {
              const T = yearsToExpiry(m.exp, ts, exchange);
              const solved = impliedVolatility(
                price,
                forwardAt(m.exp, ts, S),
                m.sp,
                T,
                RISK_FREE,
                m.type,
              );
              if (Number.isFinite(solved) && solved > 0) iv = solved;
            }
          }
          addLeg(ts, m.type, { sp: m.sp, exp: m.exp, ...g, oi: oiByTs.get(ts), iv });
        }
      } else {
        // Reconstruct from price + forward. Black-76 prices off the FORWARD, and passing the
        // wrong one biases CE IV up and PE IV down (or vice versa), showing as a phantom skew
        // on the CE-vs-PE spread. Prefer the market-implied parity forward; fall back to spot,
        // which measures far closer than spot·e^{rT} because NIFTY's basis is negative.
        for (const e of series.close || []) {
          const ts = normTs(e.ts);
          const price = e.v / 100;
          if (!(price > 0)) continue;
          const S = nearestSpot(spot, ts);
          if (!(S > 0)) continue;
          const T = yearsToExpiry(m.exp, ts);
          const F = forwardAt(m.exp, ts, S);
          // Prefer a broker-served IV when the timeseries carries one; only invert otherwise.
          const served = ivByTs.get(ts);
          const iv =
            served != null && Number.isFinite(served) && served > 0
              ? served
              : impliedVolatility(price, F, m.sp, T, RISK_FREE, m.type);
          // No finite IV means this print cannot be priced (sub-intrinsic, stale, past the
          // no-arb bound). Drop the leg — a visible gap beats an invented 20% vol.
          if (!Number.isFinite(iv) || iv <= 0) {
            dropped++;
            continue;
          }
          const g = blackScholes(F, m.sp, T, RISK_FREE, iv, m.type);
          addLeg(ts, m.type, {
            sp: m.sp,
            exp: m.exp,
            delta: g.delta,
            vega: g.vega,
            theta: g.theta,
            oi: oiByTs.get(ts),
            iv,
          });
        }
      }
    }

    let added = 0;
    for (const [ts, snap] of buckets)
      if (!snapshotsRef.current.has(ts)) {
        snapshotsRef.current.set(ts, snap);
        added++;
      }
    return { added, dropped };
  }

  // ── IV rank baseline ──────────────────────────────────────────────────────
  // Loaded once when the IV overlay is switched on, not at mount: it is a ~2.5 s cold
  // parquet scan on the server and the Vega/Theta overlays have no use for it. Re-enabling
  // after an instrument change re-runs this, and the shared key carries the symbol.
  useEffect(() => {
    if (!isIv || !on) return;
    const inst = currentInstRef.current;
    if (!inst) return;
    let alive = true;
    void (async () => {
      try {
        const r = await fetchIvHistoryShared(getSymbol(inst).toUpperCase(), IV_RANK_DAYS);
        if (!alive) return;
        const obs = r.error ? [] : (r.observations ?? []);
        setIvObs(obs);
        // An empty 200 is a real case — a checkout without the parquet tree, or a window with
        // no data in it. Without its own note the panel would sit on "Loading baseline…"
        // forever, which reads as a hang rather than as an answer.
        setIvRankNote(r.error ?? (obs.length ? '' : 'no historical sessions in the last year'));
      } catch (e) {
        if (alive) {
          setIvObs([]);
          setIvRankNote((e as Error).message);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // currentInstRef is a stable ref, listed to satisfy exhaustive-deps without suppressing it.
  }, [isIv, on, currentInstRef]);

  // Rank the live reading only against observations at a comparable maturity, and only for the
  // ATM measure: 25Δ RR and 25Δ Fly are skew/smile numbers, so placing either inside a range
  // built from ATM vol levels would be a category error, not just imprecise.
  const rankDte = selExpiries.length
    ? Math.min(
        ...selExpiries.map((e) => dteFromExpiry(e, Date.now(), currentInstRef.current?.exchange)),
      )
    : NaN;
  const ivRank: IvRankResult | null = useMemo(
    () =>
      isIv && ivMeasure === 'atm' && ivObs.length
        ? computeIvRank(ivObs, rankDte, ivLegend?.value ?? NaN)
        : null,
    [isIv, ivMeasure, ivObs, rankDte, ivLegend?.value],
  );

  // ── Public actions ──────────────────────────────────────────────────────
  function cancelDraw() {
    if (drawTimerRef.current != null) {
      clearTimeout(drawTimerRef.current);
      drawTimerRef.current = null;
    }
    // The rAF has to go too. It calls setData on series owned by the host chart, so
    // one landing after that chart was removed throws from inside lightweight-charts
    // on the following frame (see lib/chartLifecycle).
    if (drawRafRef.current != null) {
      cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = null;
    }
    drawPendingRef.current = false;
  }

  function toggle() {
    if (enabledRef.current) {
      enabledRef.current = false;
      setOn(false);
      setShowPopup(false);
      cancelDraw();
      cancelDayFetch();
      stopLivePoll();
      destroyPanes();
      unsubscribeWsAll();
      liveLegsRef.current = new Map();
      setIvLegend(null);
    } else if (currentInstRef.current) {
      loadChain();
    }
  }

  function openSettings() {
    setShowPopup((v) => !v);
    if (!expiries.length && currentInstRef.current) loadChain();
  }

  function applySettings() {
    setShowPopup(false);
    if (selExpiries.length) reloadAll(selExpiries);
  }

  function refresh() {
    requestDraw();
  }

  function clearForInstrumentChange() {
    enabledRef.current = false;
    setOn(false);
    cancelDraw();
    cancelDayFetch();
    stopLivePoll();
    destroyPanes();
    unsubscribeWsAll();
    liveLegsRef.current = new Map();
    snapshotsRef.current = new Map();
    metaRef.current = new Map();
    greekDateRef.current = '';
    lastSnapMsRef.current = 0;
    histGenRef.current++; // invalidate any in-flight history load
    setIvLegend(null);
    setIvObs([]); // baseline is per-underlying; refetched when re-enabled
    setIvRankNote('');
    setDroppedLegs(0);
    setGreekDateState('');
    setLatestDay('');
    setHistState('idle');
    setHistGranularity('');
  }

  return {
    on,
    showPopup,
    expiries,
    selExpiries,
    method,
    basket,
    baseline,
    composition,
    seriesMode,
    showCalls,
    showPuts,
    isIv,
    ivMeasure,
    ivLegend,
    ivRank,
    ivRankNote,
    ivRankDte: rankDte,
    droppedLegs,
    histState,
    histGranularity,
    ceColor: palette.ce,
    peColor: palette.pe,
    greekDate,
    latestDay,
    setGreekDate,
    setShowPopup,
    toggleExpiry,
    setMethod,
    setBasket,
    setBaseline,
    setComposition,
    setSeriesMode,
    setShowCalls,
    setShowPuts,
    setIvMeasure,
    toggle,
    openSettings,
    applySettings,
    refresh,
    resetScales,
    clearForInstrumentChange,
    enabledRef,
  };
}
