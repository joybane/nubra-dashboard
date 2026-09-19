import { useEffect, useRef, useState } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { Instrument, OhlcBar, OptionChainData, WsMessage } from '../types';
import { getChainAsset } from '../types';
import { IST_OFFSET, isMarketOpenNow, marketSession, toChartTime } from '../lib/utils';
import {
  drawOI as renderOI,
  hitTestOIBar,
  normalizeStrike,
  type OiLeg,
  type OiSnap,
} from '../lib/oiRenderer';
import { useWs } from './useWsContext';

export interface OIProfileApi {
  // state
  oiOn: boolean;
  showOiPopup: boolean;
  oiExpiries: string[];
  selExpiries: string[];
  oiMode: 'oi' | 'oi_change';
  showStrikeProfile: boolean;
  showTotalOi: boolean;
  showCalls: boolean;
  showPuts: boolean;
  oiFromTime: string;
  oiToTime: string;
  oiHover: { x: number; y: number; strike: number; ceOi: number; peOi: number } | null;
  // setters
  setShowOiPopup: (v: boolean | ((p: boolean) => boolean)) => void;
  setSelExpiries: (v: string[] | ((p: string[]) => string[])) => void;
  setOiMode: (v: 'oi' | 'oi_change') => void;
  setShowStrikeProfile: (v: boolean) => void;
  setShowTotalOi: (v: boolean) => void;
  setShowCalls: (v: boolean) => void;
  setShowPuts: (v: boolean) => void;
  setOiFromTime: (v: string) => void;
  setOiToTime: (v: string) => void;
  setOiHover: (
    v: { x: number; y: number; strike: number; ceOi: number; peOi: number } | null,
  ) => void;
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
  handleSliderChange: (fromMin: number, toMin: number, sliderMax: number) => void;
  resetTimeRange: () => void;
  clearForInstrumentChange: () => void;
  // refs exposed for chart init listeners
  oiEnabledRef: React.RefObject<boolean>;
  drawOIRef: React.RefObject<() => void>;
  oiDrawPendingRef: React.RefObject<boolean>;
  /** Mirrors showTotalOi for use inside listeners registered once at chart-init time
   * (e.g. subscribeCrosshairMove) — those closures never see a later render's state. */
  showTotalOiRef: React.RefObject<boolean>;
  /** Per-minute call/put totals behind the Total histogram, keyed by chart-time. */
  oiTotalDetailRef: React.RefObject<Map<number, { ce: number; pe: number }>>;
}

interface Deps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  candleRef: React.RefObject<ISeriesApi<'Candlestick'> | null>;
  currentInstRef: React.RefObject<Instrument | null>;
  allBarsRef: React.RefObject<OhlcBar[]>;
  /** Net (total CE − total PE) OI histogram, drawn as a native series instead of on the canvas. */
  oiTotalSeriesRef: React.RefObject<ISeriesApi<'Histogram'> | null>;
  interval: string;
}

export function useOIProfile({
  containerRef,
  canvasRef,
  candleRef,
  currentInstRef,
  allBarsRef,
  oiTotalSeriesRef,
  interval,
}: Deps): OIProfileApi {
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
  const oiSymbolMapRef = useRef<{ ce: Map<number, string>; pe: Map<number, string> }>({
    ce: new Map(),
    pe: new Map(),
  });
  // Per-minute call/put totals behind the net histogram, keyed by the same chart-time
  // the series points use — lets the hover box break the net figure back into its two legs.
  const oiTotalDetailRef = useRef<Map<number, { ce: number; pe: number }>>(new Map());
  const oiDrawPendingRef = useRef(false);
  const oiHistDateRef = useRef<string>('');
  const oiHistFailedRef = useRef(false);

  // ── State ────────────────────────────────────────────────────────────────
  const [oiOn, setOiOn] = useState(false);
  const [showOiPopup, setShowOiPopup] = useState(false);
  const [oiExpiries, setOiExpiries] = useState<string[]>([]);
  const [selExpiries, setSelExpiries] = useState<string[]>([]);
  const [oiMode, setOiMode] = useState<'oi' | 'oi_change'>('oi');
  const [showStrikeProfile, setShowStrikeProfile] = useState(true);
  const [showTotalOi, setShowTotalOi] = useState(false);
  const [showCalls, setShowCalls] = useState(true);
  const [showPuts, setShowPuts] = useState(true);
  const [oiFromTime, setOiFromTime] = useState('');
  const [oiToTime, setOiToTime] = useState('');
  const [oiHover, setOiHover] = useState<{
    x: number;
    y: number;
    strike: number;
    ceOi: number;
    peOi: number;
  } | null>(null);

  const oiModeRef = useRef(oiMode);
  oiModeRef.current = oiMode;
  // Mirrored for the WS-tick handler below, whose closure is only rebuilt when
  // `subscribe` changes — not on every render — so it can't see fresh state directly.
  const showTotalOiRef = useRef(showTotalOi);
  showTotalOiRef.current = showTotalOi;
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

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

      const ceOiMap: Record<number, { oi: number; prevOi: number }> = {};
      const peOiMap: Record<number, { oi: number; prevOi: number }> = {};
      for (const leg of data.ce || []) {
        const sp = normalizeStrike(Number(leg.sp));
        const oi = Number(leg.oi ?? (leg as { open_interest?: number }).open_interest) || 0;
        const prevOi =
          Number(
            (leg as { prevOi?: number; prev_oi?: number }).prevOi ??
              (leg as { prevOi?: number; prev_oi?: number }).prev_oi,
          ) || 0;
        if (sp > 0 && oi > 0) ceOiMap[sp] = { oi, prevOi };
      }
      for (const leg of data.pe || []) {
        const sp = normalizeStrike(Number(leg.sp));
        const oi = Number(leg.oi ?? (leg as { open_interest?: number }).open_interest) || 0;
        const prevOi =
          Number(
            (leg as { prevOi?: number; prev_oi?: number }).prevOi ??
              (leg as { prevOi?: number; prev_oi?: number }).prev_oi,
          ) || 0;
        if (sp > 0 && oi > 0) peOiMap[sp] = { oi, prevOi };
      }
      if (!Object.keys(ceOiMap).length && !Object.keys(peOiMap).length) return;

      oiChainRef.current = {
        ce: oiChainRef.current.ce.map((leg) => {
          const spRs = normalizeStrike(Number(leg.sp));
          return spRs in ceOiMap
            ? { ...leg, oi: ceOiMap[spRs].oi, prevOi: ceOiMap[spRs].prevOi }
            : leg;
        }),
        pe: oiChainRef.current.pe.map((leg) => {
          const spRs = normalizeStrike(Number(leg.sp));
          return spRs in peOiMap
            ? { ...leg, oi: peOiMap[spRs].oi, prevOi: peOiMap[spRs].prevOi }
            : leg;
        }),
      };
      requestDraw();
      updateLiveTotalPoint();
    });
    return unsub;
    // Deliberately narrow: re-subscribing to the WS channel on every render (which
    // including updateLiveTotalPoint here would cause, since it's a plain function
    // recreated each render) would thrash the subscription. It only touches refs
    // internally, so the stale closure this effect keeps across renders is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  // Release the OI snapshot interval and server-side OI subscription on unmount —
  // otherwise an enabled overlay leaks a 30s timer and a live feed after the host
  // chart is gone (both stop functions are ref-based, so the mount-time closure is safe).
  useEffect(
    () => () => {
      stopSnapshotTimer();
      unsubscribeOiWs();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function safePriceToCoordinate(s: ISeriesApi<'Candlestick'> | null, p: number): number | null {
    if (!s) return null;
    try {
      const y = s.priceToCoordinate(p);
      return typeof y === 'number' && !isNaN(y) ? y : null;
    } catch {
      return null;
    }
  }

  function safeCoordinateToPrice(s: ISeriesApi<'Candlestick'> | null, py: number): number | null {
    if (!s) return null;
    try {
      const p = s.coordinateToPrice(py);
      return typeof p === 'number' && !isNaN(p) ? p : null;
    } catch {
      return null;
    }
  }

  // ── Core draw ────────────────────────────────────────────────────────────
  function drawOI() {
    try {
      const canvas = canvasRef.current;
      const cont = containerRef.current;
      const series = candleRef.current;
      if (!canvas || !cont || !series || !oiChainRef.current) return;

      const today = new Date().toISOString().slice(0, 10);
      const sameCalendarDay = !oiHistDateRef.current || oiHistDateRef.current === today;
      // "to at the right edge" reads the live WS snapshot instead of the fetched
      // 1m history so the bar stays fresh while the session is running. Once the
      // session has closed that snapshot can keep moving (late prints/settlement)
      // while the history table is already final — so past close, fall back to the
      // history series for both ends of the range, or "9:20→15:30" silently turns
      // into "9:20→whatever the live feed says right now" instead of the close print.
      const isToday = sameCalendarDay && isMarketOpenNow(currentInstRef.current?.exchange);

      renderOI({
        canvas,
        containerW: cont.clientWidth,
        containerH: cont.clientHeight,
        priceToCoordinate: (p) => safePriceToCoordinate(series, p),
        oiChain: oiChainRef.current,
        enabled: oiEnabledRef.current && showStrikeProfile,
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
        isToday,
      });
    } catch (e) {
      console.warn('[OI] Draw error:', e);
    }
  }
  drawOIRef.current = drawOI;

  function requestDraw() {
    if (!oiEnabledRef.current || oiDrawPendingRef.current) return;
    oiDrawPendingRef.current = true;
    requestAnimationFrame(() => {
      drawOIRef.current();
      oiDrawPendingRef.current = false;
    });
  }

  /**
   * `&exchange=…` for the chain endpoint, empty on NSE so the request URL stays
   * exactly what it has always been.
   */
  function ocExchangeQuery(joiner = '?'): string {
    const ex = (currentInstRef.current?.exchange || 'NSE').toUpperCase();
    return ex === 'NSE' ? '' : `${joiner}exchange=${ex}`;
  }

  // ── Fetch / reload ──────────────────────────────────────────────────────
  async function loadOIChain() {
    if (!currentInstRef.current) return;
    const sym = getChainAsset(currentInstRef.current);
    try {
      const res = await fetch(`/api/optionchain/${encodeURIComponent(sym)}${ocExchangeQuery()}`);
      const data = (await res.json()) as {
        chain?: { all_expiries?: string[]; ce?: OiLeg[]; pe?: OiLeg[] };
      };
      if (!data.chain) return;
      const expiries = data.chain.all_expiries || [];
      setOiExpiries(expiries);
      const first = expiries.slice(0, 1);
      setSelExpiries(first);
      await reloadOIExpiries(first);
    } catch (e) {
      console.warn('[OI] loadOIChain failed:', e);
    }
  }

  async function reloadOIExpiries(expiries: string[]) {
    if (!currentInstRef.current || expiries.length === 0) return;
    const sym = getChainAsset(currentInstRef.current);
    const ceMap: Record<number, number> = {};
    const peMap: Record<number, number> = {};
    const cePrevMap: Record<number, number> = {};
    const pePrevMap: Record<number, number> = {};
    const ceSymMap = new Map<number, string>();
    const peSymMap = new Map<number, string>();

    const results = await Promise.all(
      expiries.map(async (exp) => {
        try {
          const res = await fetch(
            `/api/optionchain/${encodeURIComponent(sym)}?expiry=${encodeURIComponent(exp)}${ocExchangeQuery('&')}`,
          );
          return (await res.json()) as { chain?: { ce?: OiLeg[]; pe?: OiLeg[] } };
        } catch (e) {
          console.warn('[OI] Expiry fetch failed:', exp, e);
          return null;
        }
      }),
    );

    for (const data of results) {
      if (!data?.chain) continue;
      for (const ce of data.chain.ce || []) {
        const sp = normalizeStrike(Number(ce.sp));
        const oi = Number(ce.oi ?? ce.open_interest) || 0;
        ceMap[sp] = (ceMap[sp] || 0) + oi;
        cePrevMap[sp] = (cePrevMap[sp] || 0) + (Number(ce.prev_oi) || 0);
        if (ce.symbol && !ceSymMap.has(Number(ce.sp)))
          ceSymMap.set(Number(ce.sp), String(ce.symbol));
      }
      for (const pe of data.chain.pe || []) {
        const sp = normalizeStrike(Number(pe.sp));
        const oi = Number(pe.oi ?? pe.open_interest) || 0;
        peMap[sp] = (peMap[sp] || 0) + oi;
        pePrevMap[sp] = (pePrevMap[sp] || 0) + (Number(pe.prev_oi) || 0);
        if (pe.symbol && !peSymMap.has(Number(pe.sp)))
          peSymMap.set(Number(pe.sp), String(pe.symbol));
      }
    }
    oiSymbolMapRef.current = { ce: ceSymMap, pe: peSymMap };
    const hasData =
      Object.values(ceMap).some((v) => v > 0) || Object.values(peMap).some((v) => v > 0);
    if (hasData) {
      oiChainRef.current = {
        ce: Object.entries(ceMap).map(([sp, oi]) => ({
          sp: Number(sp) * 100,
          oi,
          prevOi: cePrevMap[Number(sp)] || 0,
        })),
        pe: Object.entries(peMap).map(([sp, oi]) => ({
          sp: Number(sp) * 100,
          oi,
          prevOi: pePrevMap[Number(sp)] || 0,
        })),
      };
    }
    oiHistoricalRef.current = new Map();
    oiHistFetchedRef.current = false;
    oiHistFailedRef.current = false;
    oiEnabledRef.current = true;
    setOiOn(true);
    if (expiries.length === 1 && currentInstRef.current) {
      subscribeOiWs(
        getChainAsset(currentInstRef.current).toUpperCase(),
        expiries[0],
        currentInstRef.current.exchange || 'NSE',
      );
    } else {
      unsubscribeOiWs();
    }
    startSnapshotTimer();
    requestDraw();
    // Expiry selection changed — the per-symbol history above was just invalidated,
    // so the net-OI series needs a fresh fetch too, not just the per-strike bars.
    if (showTotalOiRef.current) fetchOIHistory();
  }

  function getChartDate(): Date {
    const bars = allBarsRef.current;
    if (bars.length) {
      const last = bars[bars.length - 1];
      if (typeof last.time === 'number') {
        return new Date((last.time - IST_OFFSET) * 1000);
      }
      const t = last.time as { year: number; month: number; day: number };
      return new Date(Date.UTC(t.year, t.month - 1, t.day));
    }
    return new Date();
  }

  async function fetchOIHistory() {
    if (!oiChainRef.current || !currentInstRef.current || oiHistLoadingRef.current) return;
    const symMap = oiSymbolMapRef.current;
    if (!symMap.ce.size) return;
    oiHistLoadingRef.current = true;
    oiHistFailedRef.current = false;

    const values: string[] = [];
    const seen = new Set<string>();
    for (const [sp, ceSym] of symMap.ce.entries()) {
      const peSym = symMap.pe.get(sp);
      if (ceSym && !seen.has(ceSym)) {
        seen.add(ceSym);
        values.push(ceSym);
      }
      if (peSym && !seen.has(peSym)) {
        seen.add(peSym);
        values.push(peSym);
      }
    }

    try {
      const chartDate = getChartDate();
      const exchange = currentInstRef.current.exchange || 'NSE';
      // Span the instrument's own session. These used to be 03:45/10:00 UTC — the NSE
      // 09:15–15:30 window — which on MCX would stop at 15:30 and lose the evening.
      // IST minutes-of-day converted to UTC. For NSE this reproduces the previous
      // literals exactly: 555−330 = 03:45 UTC open, 930−330 = 10:00 UTC close.
      const { openMin, closeMin } = marketSession(exchange);
      const istMinToUtc = (min: number) => min - IST_OFFSET / 60;
      const startDate = new Date(chartDate);
      startDate.setUTCHours(0, istMinToUtc(openMin), 0, 0);
      const endDate = new Date(chartDate);
      endDate.setUTCHours(0, istMinToUtc(closeMin), 0, 0);

      const BATCH = 10;
      const chunks: string[][] = [];
      for (let i = 0; i < values.length; i += BATCH) chunks.push(values.slice(i, i + BATCH));

      console.log(`[OI] Fetching ${values.length} instruments in ${chunks.length} batches`);

      const map = new Map<string, { ts: number; v: number }[]>();
      const results = await Promise.all(
        chunks.map(async (chunk) => {
          const res = await fetch('/api/historical', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: [
                {
                  exchange,
                  type: 'OPT',
                  values: chunk,
                  fields: ['cumulative_oi'],
                  startDate: startDate.toISOString(),
                  endDate: endDate.toISOString(),
                  interval: '1m',
                  intraDay: true,
                  realTime: false,
                },
              ],
            }),
          });
          if (!res.ok) return null;
          return res.json();
        }),
      );

      for (const data of results) {
        if (!data?.result?.[0]?.values) continue;
        for (const row of data.result[0].values) {
          for (const [name, series] of Object.entries(row) as [
            string,
            { cumulative_oi?: { ts: number; v: number }[] },
          ][]) {
            if (series?.cumulative_oi?.length) map.set(name, series.cumulative_oi);
          }
        }
      }

      console.log(`[OI] Fetched ${map.size}/${values.length} instruments`);
      oiHistoricalRef.current = map;
      oiHistFetchedRef.current = true;
      oiHistDateRef.current = chartDate.toISOString().slice(0, 10);
      requestDraw();
      computeTotalSeries();
    } catch (e) {
      console.error('[OI] Historical fetch failed:', e);
      oiHistFailedRef.current = true;
    } finally {
      oiHistLoadingRef.current = false;
    }
  }

  // ── Total view (net CE − PE OI, summed across every strike) ────────────────
  /**
   * Builds the whole-session net-OI histogram from the already-fetched 1m history:
   * one point per minute bucket, value = (sum of every included CE strike's OI) minus
   * (sum of every included PE strike's OI) at that minute. Strikes don't all report on
   * identical minute grids, so each strike is forward-filled to the union of timestamps
   * rather than assuming they line up.
   */
  function computeTotalSeries() {
    const seriesApi = oiTotalSeriesRef.current;
    if (!seriesApi) return;
    const symMap = oiSymbolMapRef.current;
    const hist = oiHistoricalRef.current;
    const ceSeriesList = Array.from(symMap.ce.values())
      .map((sym) => hist.get(sym))
      .filter((s): s is { ts: number; v: number }[] => !!s?.length);
    const peSeriesList = Array.from(symMap.pe.values())
      .map((sym) => hist.get(sym))
      .filter((s): s is { ts: number; v: number }[] => !!s?.length);
    if (!ceSeriesList.length && !peSeriesList.length) {
      oiTotalDetailRef.current = new Map();
      seriesApi.setData([]);
      return;
    }

    const tsSet = new Set<number>();
    for (const s of ceSeriesList) for (const pt of s) tsSet.add(pt.ts);
    for (const s of peSeriesList) for (const pt of s) tsSet.add(pt.ts);
    const allTs = Array.from(tsSet).sort((a, b) => a - b);

    const cePtrs = new Array(ceSeriesList.length).fill(0);
    const pePtrs = new Array(peSeriesList.length).fill(0);
    const iv = intervalRef.current;
    const points: { time: number; value: number; color: string }[] = [];
    const detail = new Map<number, { ce: number; pe: number }>();
    for (const ts of allTs) {
      let sumCe = 0;
      for (let i = 0; i < ceSeriesList.length; i++) {
        const s = ceSeriesList[i];
        while (cePtrs[i] + 1 < s.length && s[cePtrs[i] + 1].ts <= ts) cePtrs[i]++;
        if (s[cePtrs[i]].ts <= ts) sumCe += s[cePtrs[i]].v;
      }
      let sumPe = 0;
      for (let i = 0; i < peSeriesList.length; i++) {
        const s = peSeriesList[i];
        while (pePtrs[i] + 1 < s.length && s[pePtrs[i] + 1].ts <= ts) pePtrs[i]++;
        if (s[pePtrs[i]].ts <= ts) sumPe += s[pePtrs[i]].v;
      }
      const net = sumCe - sumPe;
      const chartTime = toChartTime(ts, iv) as number;
      points.push({ time: chartTime, value: net, color: net >= 0 ? '#22c55e' : '#ef4444' });
      detail.set(chartTime, { ce: sumCe, pe: sumPe });
    }
    oiTotalDetailRef.current = detail;
    seriesApi.setData(points as Parameters<typeof seriesApi.setData>[0]);
  }

  /**
   * Keeps the histogram's last (current-minute) bar live between history refetches —
   * the 1m history is only pulled on demand, but the WS chain feed already updates
   * `oiChainRef` every tick, so the running total can track it without re-fetching.
   */
  function updateLiveTotalPoint() {
    const seriesApi = oiTotalSeriesRef.current;
    if (!seriesApi || !oiChainRef.current || !showTotalOiRef.current) return;
    let sumCe = 0;
    for (const leg of oiChainRef.current.ce) sumCe += Number(leg.oi) || 0;
    let sumPe = 0;
    for (const leg of oiChainRef.current.pe) sumPe += Number(leg.oi) || 0;
    const net = sumCe - sumPe;
    // Snapped to the minute so live ticks update the forming bar in place instead of
    // spawning a new one-per-tick bar next to the minute-granularity historical bars.
    const chartTimeSec = Math.floor(Date.now() / 1000) + IST_OFFSET;
    const bucket = Math.floor(chartTimeSec / 60) * 60;
    oiTotalDetailRef.current.set(bucket, { ce: sumCe, pe: sumPe });
    seriesApi.update({
      time: bucket,
      value: net,
      color: net >= 0 ? '#22c55e' : '#ef4444',
    } as Parameters<typeof seriesApi.update>[0]);
  }

  /** Shows/hides the Total histogram to match whether OI is on and whether it's checked. */
  function syncTotalVisibility() {
    oiTotalSeriesRef.current?.applyOptions({
      visible: oiEnabledRef.current && showTotalOiRef.current,
    });
  }

  // Strike Profile and Total are independent toggles (both, either, or neither can be
  // on at once) — this only reacts to Total specifically: fetch history the first time
  // it's checked, otherwise just re-show the already-computed series; unchecking hides it.
  useEffect(() => {
    syncTotalVisibility();
    if (!showTotalOi) return;
    if (oiHistFetchedRef.current) {
      computeTotalSeries();
    } else if (!oiHistLoadingRef.current && !oiHistFailedRef.current && oiChainRef.current) {
      fetchOIHistory();
    }
    requestDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTotalOi]);

  // Strike Profile's canvas bars don't redraw themselves purely from a state change —
  // they're only repainted on the next crosshair move / pan / WS tick. Force one here so
  // toggling the checkbox (or Calls/Puts) reflects immediately instead of on next mouse move.
  useEffect(() => {
    requestDraw();
  }, [showStrikeProfile, showCalls, showPuts]);

  // ── Snapshot timer (replaces the old 10fps OI loop) ──────────────────────
  function startSnapshotTimer() {
    if (oiLoopRef.current) return;
    function storeSnap() {
      if (!oiChainRef.current || !oiEnabledRef.current) return;
      const now = Date.now();
      if (now - lastOiSnapTimeRef.current > 30000) {
        oiSnapshotsRef.current.set(now, {
          ce: [...oiChainRef.current.ce],
          pe: [...oiChainRef.current.pe],
        });
        lastOiSnapTimeRef.current = now;
        const cutoff = now - 8 * 3_600_000;
        for (const [ts] of oiSnapshotsRef.current) {
          if (ts < cutoff) oiSnapshotsRef.current.delete(ts);
        }
      }
    }
    storeSnap();
    oiLoopRef.current = window.setInterval(storeSnap, 30000) as unknown as number;
  }

  function stopSnapshotTimer() {
    if (oiLoopRef.current) {
      clearInterval(oiLoopRef.current);
      oiLoopRef.current = null;
    }
  }

  // ── Mouse handlers ──────────────────────────────────────────────────────
  function handleMouseDown(e: React.MouseEvent) {
    if (!oiEnabledRef.current || !containerRef.current || !showStrikeProfile) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const priceScaleW = 72;
    const maxBarW =
      (containerRef.current.clientWidth - priceScaleW) * 0.35 * oiWidthScaleRef.current;
    const handleX = containerRef.current.clientWidth - priceScaleW - maxBarW;
    if (Math.abs(x - handleX) > 15) return;

    oiDragRef.current = { dragging: true, startX: x, startScale: oiWidthScaleRef.current };
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rx = ev.clientX - containerRef.current.getBoundingClientRect().left;
      const dx = oiDragRef.current.startX - rx;
      const base = (containerRef.current.clientWidth - 72) * 0.35;
      oiWidthScaleRef.current = Math.max(
        0.2,
        Math.min(3.0, oiDragRef.current.startScale + dx / base),
      );
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

    if (oiEnabledRef.current && showStrikeProfile) {
      containerRef.current.style.cursor = Math.abs(x - handleX) <= 15 ? 'ew-resize' : '';
    }

    if (
      oiEnabledRef.current &&
      showStrikeProfile &&
      oiChainRef.current &&
      candleRef.current &&
      x >= handleX - 5
    ) {
      const hit = hitTestOIBar({
        x,
        y,
        containerW: w,
        widthScale: oiWidthScaleRef.current,
        oiChain: oiChainRef.current,
        priceToCoordinate: (p) => safePriceToCoordinate(candleRef.current, p),
        coordinateToPrice: (py) => safeCoordinateToPrice(candleRef.current, py),
        mode: oiModeRef.current,
        histFetched: oiHistFetchedRef.current,
        deltas: oiDeltasRef.current,
      });
      if (hit) {
        setOiHover({ x, y, ...hit });
        return;
      }
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
    const d = getChartDate();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  function minToTimeStr(min: number): string {
    const totalMin = min + 9 * 60 + 15;
    return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
  }

  function handleSliderChange(fromMin: number, toMin: number, sliderMax: number) {
    const atStart = fromMin <= 0;
    const atEnd = toMin >= sliderMax;

    const fromTime = minToTimeStr(fromMin);
    const toTime = minToTimeStr(toMin);
    setOiFromTime(fromTime);
    setOiToTime(toTime);

    setOiMode('oi_change');
    oiModeRef.current = 'oi_change';
    oiFromMsRef.current = atStart ? null : timeToMs(fromTime);
    oiToMsRef.current = atEnd ? null : timeToMs(toTime);

    if (!oiHistFetchedRef.current && !oiHistLoadingRef.current && !oiHistFailedRef.current) {
      console.log('[OI] Slider triggered fetch, from:', fromTime, 'to:', toTime);
      fetchOIHistory();
    }
    drawOIRef.current();
  }

  function resetTimeRange() {
    setOiFromTime('');
    setOiToTime('');
    setOiMode('oi');
    oiModeRef.current = 'oi';
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
      stopSnapshotTimer();
      unsubscribeOiWs();
      drawOI();
      syncTotalVisibility();
    } else if (oiChainRef.current) {
      oiEnabledRef.current = true;
      setOiOn(true);
      startSnapshotTimer();
      requestDraw();
      syncTotalVisibility();
      if (showTotalOiRef.current) {
        if (oiHistFetchedRef.current) computeTotalSeries();
        else if (!oiHistLoadingRef.current && !oiHistFailedRef.current) fetchOIHistory();
      }
    } else if (currentInstRef.current) {
      loadOIChain();
    }
  }

  function openSettings() {
    setShowOiPopup((v) => !v);
    if (!oiExpiries.length && currentInstRef.current) loadOIChain();
  }

  function applyExpiries() {
    reloadOIExpiries(selExpiries);
    setShowOiPopup(false);
  }

  function clearForInstrumentChange() {
    if (oiEnabledRef.current) {
      oiEnabledRef.current = false;
      setOiOn(false);
    }
    stopSnapshotTimer();
    oiChainRef.current = null;
    oiHistoricalRef.current = new Map();
    oiHistFetchedRef.current = false;
    oiHistFailedRef.current = false;
    oiHistDateRef.current = '';
    oiSnapshotsRef.current = new Map();
    oiBaselineRef.current = null;
    oiToSnapRef.current = null;
    unsubscribeOiWs();
    setShowStrikeProfile(true);
    setShowTotalOi(false);
    showTotalOiRef.current = false;
    oiTotalDetailRef.current = new Map();
    oiTotalSeriesRef.current?.setData([]);
    oiTotalSeriesRef.current?.applyOptions({ visible: false });
  }

  return {
    oiOn,
    showOiPopup,
    oiExpiries,
    selExpiries,
    oiMode,
    showStrikeProfile,
    showTotalOi,
    showCalls,
    showPuts,
    oiFromTime,
    oiToTime,
    oiHover,
    setShowOiPopup,
    setSelExpiries,
    setOiMode,
    setShowStrikeProfile,
    setShowTotalOi,
    setShowCalls,
    setShowPuts,
    setOiFromTime,
    setOiToTime,
    setOiHover,
    toggleOI,
    openSettings,
    applyExpiries,
    fetchOIHistory,
    drawOI,
    requestDraw,
    handleMouseDown,
    handleMouseMove,
    handleMouseLeave,
    handleSliderChange,
    resetTimeRange,
    clearForInstrumentChange,
    oiEnabledRef,
    drawOIRef,
    oiDrawPendingRef,
    showTotalOiRef,
    oiTotalDetailRef,
  };
}
