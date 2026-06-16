import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickSeriesOptions,
  type HistogramSeriesOptions,
} from 'lightweight-charts';
import { useWs } from './hooks/useWsContext';
import type { Instrument, OhlcBar, OhlcvData, VolBar, WsMessage } from './types';
import { getSymbol } from './types';
import {
  toChartTime, snapToCandle, sortKey, historyDays, chunkDays,
  intervalToSeconds, isIntradayInterval, IST_OFFSET, fmtVol, fmtPrice, formatExpiry, fmtOI,
} from './lib/utils';

const INTERVALS = ['1m','2m','3m','5m','10m','15m','30m','1h','1d','1w','1mt'] as const;
type Interval = typeof INTERVALS[number];

interface Props {
  instrument: Instrument | null;
  theme: 'dark' | 'light';
}

export default function CandleChart({ instrument, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef       = useRef<ISeriesApi<'Histogram'> | null>(null);

  const allBarsRef      = useRef<OhlcBar[]>([]);
  const allVolBarsRef   = useRef<VolBar[]>([]);
  const earliestRef     = useRef<Date | null>(null);
  const lastBarRef      = useRef<OhlcBar | null>(null);
  const dayOpenRef      = useRef<number | null>(null);
  const currentInstRef  = useRef<Instrument | null>(null);
  const isLoadingRef    = useRef(false);
  const countdownRef    = useRef<number | null>(null);
  const oiLoopRef       = useRef<number | null>(null);
  const oiChainRef      = useRef<{ ce: Record<string,unknown>[]; pe: Record<string,unknown>[] } | null>(null);
  const oiEnabledRef    = useRef(false);
  const oiWidthScaleRef = useRef(1.0);
  const oiDragRef       = useRef({ dragging: false, startX: 0, startScale: 1 });
  const drawOIRef       = useRef<() => void>(() => {});
  type OiSnap = { ce: Record<string,unknown>[]; pe: Record<string,unknown>[] };
  const oiSnapshotsRef   = useRef<Map<number, OiSnap>>(new Map());
  const oiBaselineRef    = useRef<OiSnap | null>(null);
  const oiToSnapRef      = useRef<OiSnap | null>(null);
  const lastOiSnapTimeRef= useRef(0);
  const oiWsAssetRef     = useRef<string | null>(null);
  const oiWsExpiryRef    = useRef<string | null>(null);
  const oiWsExchRef      = useRef<string>('NSE');

  const [interval,   setInterval]   = useState<Interval>('5m');
  const [loading,    setLoading]    = useState<string | null>('Select a symbol to begin');
  const [showVol,    setShowVol]    = useState(false);
  const [showOiPopup,setShowOiPopup]= useState(false);
  const [oiExpiries,  setOiExpiries]  = useState<string[]>([]);
  const [selExpiries, setSelExpiries] = useState<string[]>([]);
  const [oiMode,      setOiMode]      = useState<'oi'|'oi_change'>('oi');
  const [showCalls,   setShowCalls]   = useState(true);
  const [showPuts,    setShowPuts]    = useState(true);
  const [oiOn,        setOiOn]        = useState(false);
  const [oiFromTime,  setOiFromTime]  = useState('');
  const [oiToTime,    setOiToTime]    = useState('');
  const [ohlc, setOhlc] = useState<{ o:number;h:number;l:number;c:number;vol?:number;chg?:number } | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);
  const [countdownY, setCountdownY] = useState(0);
  const [priceDisplay, setPriceDisplay] = useState<{ price:number; diff:number; pct:string; up:boolean } | null>(null);
  const [loadMore, setLoadMore] = useState(false);
  const [oiHover, setOiHover] = useState<{ x: number; y: number; strike: number; ceOi: number; peOi: number } | null>(null);

  const { subscribe, subscribeOC, unsubscribeOC, subscribeChart, unsubscribeChart } = useWs();
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  // ── Chart initialization ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const isDark = theme === 'dark';

    const chart = createChart(containerRef.current, {
      layout: {
        background:  { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor:   isDark ? '#c9d1d9' : '#131722',
        fontSize:    13,
        fontFamily:  "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: isDark ? '#22262b' : '#e8ecf5' },
        horzLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: '#2962ff' },
      },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb', minimumWidth: 72 },
      timeScale: {
        borderColor:  isDark ? '#2a2d32' : '#e0e3eb',
        timeVisible:  true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: true,
      },
      handleScroll: true,
      handleScale:  true,
    });
    chartRef.current = chart;

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444',
      borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
      priceLineVisible: true, lastValueVisible: true,
    } as Partial<CandlestickSeriesOptions>);
    candleRef.current = candle;

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false,
      priceLineVisible: false,
      visible: false,
    } as Partial<HistogramSeriesOptions>);
    volRef.current = vol;
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      updateCountdownPosition();
      if (oiEnabledRef.current) requestAnimationFrame(drawOI);
      const bar  = param.seriesData?.get(candle) as OhlcBar | undefined;
      const vBar = param.seriesData?.get(vol) as { value: number } | undefined;
      if (bar) {
        setOhlc({ o: bar.open, h: bar.high, l: bar.low, c: bar.close, vol: vBar?.value });
      } else if (lastBarRef.current) {
        setOhlc({ o: lastBarRef.current.open, h: lastBarRef.current.high, l: lastBarRef.current.low, c: lastBarRef.current.close });
      }
    });

    chart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
      if (oiEnabledRef.current) requestAnimationFrame(drawOI);
      if (!range || isLoadingRef.current || !currentInstRef.current || !earliestRef.current) return;
      if (range.from > 10) return;
      await loadMoreHistory();
    });

    const observer = new ResizeObserver(() => {
      chart.resize(containerRef.current!.clientWidth, containerRef.current!.clientHeight);
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Theme sync ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const isDark = theme === 'dark';
    chartRef.current.applyOptions({
      layout: { background: { color: isDark ? '#0d0f11' : '#ffffff' }, textColor: isDark ? '#c9d1d9' : '#131722' },
      grid: { vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' }, horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' } },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
      timeScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
    });
  }, [theme]);

  // ── Volume toggle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!volRef.current || !candleRef.current) return;
    volRef.current.applyOptions({ visible: showVol });
    if (showVol) {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
    } else {
      candleRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
    }
  }, [showVol]);

  // ── OI WebSocket helpers ──────────────────────────────────────────────────
  function subscribeOiWs(asset: string, expiry: string, exchange: string) {
    if (oiWsAssetRef.current === asset && oiWsExpiryRef.current === expiry) return;
    if (oiWsAssetRef.current && oiWsExpiryRef.current) {
      unsubscribeOC(oiWsAssetRef.current, oiWsExpiryRef.current, oiWsExchRef.current);
    }
    oiWsAssetRef.current  = asset;
    oiWsExpiryRef.current = expiry;
    oiWsExchRef.current   = exchange;
    subscribeOC(asset, expiry, exchange);
  }

  function unsubscribeOiWs() {
    if (oiWsAssetRef.current && oiWsExpiryRef.current) {
      unsubscribeOC(oiWsAssetRef.current, oiWsExpiryRef.current, oiWsExchRef.current);
    }
    oiWsAssetRef.current  = null;
    oiWsExpiryRef.current = null;
  }

  // ── Live OI updates from WebSocket ───────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain' || !oiEnabledRef.current || !oiChainRef.current) return;
      const data = msg.data as OptionChainData;
      if ((data.asset || '').toUpperCase() !== oiWsAssetRef.current) return;
      if ((data.expiry || '') !== oiWsExpiryRef.current) return;

      // Build strike(rupees) → oi lookup from WS tick
      const ceOiMap: Record<number, number> = {};
      const peOiMap: Record<number, number> = {};
      for (const leg of (data.ce || [])) {
        const raw = Number(leg.sp);
        const sp  = raw > 10000 ? raw / 100 : raw;
        const oi  = Number((leg as Record<string,unknown>).oi ?? (leg as Record<string,unknown>).open_interest) || 0;
        if (sp > 0 && oi > 0) ceOiMap[sp] = oi;
      }
      for (const leg of (data.pe || [])) {
        const raw = Number(leg.sp);
        const sp  = raw > 10000 ? raw / 100 : raw;
        const oi  = Number((leg as Record<string,unknown>).oi ?? (leg as Record<string,unknown>).open_interest) || 0;
        if (sp > 0 && oi > 0) peOiMap[sp] = oi;
      }
      if (!Object.keys(ceOiMap).length && !Object.keys(peOiMap).length) return;

      // Patch OI values in the existing structure — preserves the sp format
      // established by reloadOIExpiries so drawOI coordinates stay correct.
      oiChainRef.current = {
        ce: oiChainRef.current.ce.map(leg => {
          const raw = Number(leg.sp); const spRs = raw > 10000 ? raw / 100 : raw;
          return spRs in ceOiMap ? { ...leg, oi: ceOiMap[spRs] } : leg;
        }),
        pe: oiChainRef.current.pe.map(leg => {
          const raw = Number(leg.sp); const spRs = raw > 10000 ? raw / 100 : raw;
          return spRs in peOiMap ? { ...leg, oi: peOiMap[spRs] } : leg;
        }),
      };
    });
    return unsub;
  }, [subscribe]);

  // ── WebSocket ticks ───────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = subscribe('ohlcv', (msg: WsMessage) => {
      if (msg.type !== 'ohlcv' || !currentInstRef.current) return;
      const data = msg.data as OhlcvData;
      const sym = getSymbol(currentInstRef.current).toUpperCase();
      const buckets = [...(data.indexes || []), ...(data.instruments || [])];
      for (const b of buckets) {
        const bname = (b.indexname || '').toUpperCase();
        if (bname === sym || sym.startsWith(bname) || bname.startsWith(sym)) {
          applyBucket(b as Record<string,string>);
          break;
        }
      }
    });
    return unsub;
  }, [subscribe]);

  function applyBucket(b: Record<string,string>) {
    try {
      const tsStr = (b.bucket_timestamp && b.bucket_timestamp !== '0') ? b.bucket_timestamp : b.timestamp;
      if (!tsStr || tsStr === '0') return;
      const utcSec  = Number(BigInt(tsStr) / 1_000_000_000n);
      const barTime = snapToCandle(utcSec, intervalRef.current);
      const candle  = { time: barTime, open: Number(b.open)/100, high: Number(b.high)/100, low: Number(b.low)/100, close: Number(b.close)/100 };
      if (!candle.open || !candle.close) return;
      candleRef.current?.update(candle as Parameters<typeof candleRef.current.update>[0]);
      lastBarRef.current = candle;
      updatePriceDisplay(candle.close, dayOpenRef.current || candle.open);
      setOhlc({ o: candle.open, h: candle.high, l: candle.low, c: candle.close, vol: Number(b.cumulative_volume) || undefined });
      updateCountdownPosition();
    } catch { /* ignore */ }
  }

  // ── Load instrument ───────────────────────────────────────────────────────
  const loadInstrument = useCallback(async (inst: Instrument, iv: Interval) => {
    if (!candleRef.current || !volRef.current || !chartRef.current) return;

    if (currentInstRef.current) {
      const oldSym = getSymbol(currentInstRef.current);
      unsubscribeChart({ indexes: [oldSym] }, iv, currentInstRef.current.exchange || 'NSE');
    }
    unsubscribeOiWs();

    currentInstRef.current = inst;
    allBarsRef.current    = [];
    allVolBarsRef.current = [];
    earliestRef.current   = null;
    lastBarRef.current    = null;
    dayOpenRef.current    = null;
    stopCountdown();
    setLoading('Loading historical data…');
    setPriceDisplay(null);
    setOhlc(null);

    try {
      const end   = new Date();
      const start = new Date(end.getTime() - historyDays(iv) * 86400000);
      const { bars, volBars } = await fetchRange(inst, iv, start, end);
      if (!bars.length) { setLoading('No historical data available.'); return; }

      allBarsRef.current    = bars;
      allVolBarsRef.current = volBars;
      earliestRef.current   = start;
      lastBarRef.current    = bars[bars.length - 1];
      dayOpenRef.current    = bars[0].open;

      candleRef.current.setData(bars as Parameters<typeof candleRef.current.setData>[0]);
      volRef.current.setData(volBars as Parameters<typeof volRef.current.setData>[0]);

      const len = bars.length;
      chartRef.current.timeScale().setVisibleLogicalRange({ from: Math.max(0, len - 200), to: len + 5 });
      setLoading(null);
      startCountdown();
      updatePriceDisplay(lastBarRef.current.close, dayOpenRef.current);
      setOhlc({ o: lastBarRef.current.open, h: lastBarRef.current.high, l: lastBarRef.current.low, c: lastBarRef.current.close });

      subscribeChart({ indexes: [getSymbol(inst)] }, iv, inst.exchange || 'NSE');
    } catch (err: unknown) {
      setLoading(`Error: ${(err as Error).message}`);
    }
  }, [unsubscribeChart, subscribeChart]);

  useEffect(() => {
    if (!instrument) return;
    loadInstrument(instrument, interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  useEffect(() => {
    if (!instrument) return;
    loadInstrument(instrument, interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval]);

  async function loadMoreHistory() {
    if (isLoadingRef.current || !earliestRef.current || !currentInstRef.current) return;
    isLoadingRef.current = true;
    setLoadMore(true);
    try {
      const end   = new Date(earliestRef.current.getTime() - 60000);
      const start = new Date(end.getTime() - chunkDays(intervalRef.current) * 86400000);
      const { bars, volBars } = await fetchRange(currentInstRef.current, intervalRef.current, start, end);
      if (bars.length) {
        allBarsRef.current    = [...bars, ...allBarsRef.current];
        allVolBarsRef.current = [...volBars, ...allVolBarsRef.current];
        earliestRef.current   = start;
        dayOpenRef.current    = allBarsRef.current[0].open;
        candleRef.current?.setData(allBarsRef.current as Parameters<typeof candleRef.current.setData>[0]);
        volRef.current?.setData(allVolBarsRef.current as Parameters<typeof volRef.current.setData>[0]);
      }
    } catch { /* ignore */ }
    isLoadingRef.current = false;
    setLoadMore(false);
  }

  // ── Countdown ─────────────────────────────────────────────────────────────
  function startCountdown() {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = window.setInterval(tickCountdown, 1000);
    tickCountdown();
  }
  function stopCountdown() {
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    setCountdown(null);
  }
  function tickCountdown() {
    if (!intervalRef.current || !currentInstRef.current) { stopCountdown(); return; }
    const nowUtc = Math.floor(Date.now() / 1000);
    const istSec = (nowUtc + IST_OFFSET) % 86400; // seconds since midnight IST
    // Hide outside NSE market hours (9:15 AM – 3:30 PM IST)
    if (istSec < 9 * 3600 + 15 * 60 || istSec > 15 * 3600 + 30 * 60) {
      setCountdown(null);
      return;
    }
    const intSec    = intervalToSeconds(intervalRef.current);
    const elapsed   = (nowUtc + IST_OFFSET) % intSec;
    const remaining = intSec - elapsed;
    const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
    const ss = (remaining % 60).toString().padStart(2, '0');
    setCountdown(`${mm}:${ss}`);
    updateCountdownPosition();
  }
  function updateCountdownPosition() {
    if (!lastBarRef.current || !candleRef.current) return;
    const y = candleRef.current.priceToCoordinate(lastBarRef.current.close);
    if (y != null) setCountdownY(Math.round(y) + 13);
  }

  // ── Price display ─────────────────────────────────────────────────────────
  function updatePriceDisplay(price: number, open: number) {
    const diff = price - (open || price);
    const pct  = open ? ((diff / open) * 100).toFixed(2) : '0.00';
    const up   = diff >= 0;
    setPriceDisplay({ price, diff, pct, up });
  }

  // ── OI Profile ────────────────────────────────────────────────────────────
  async function loadOIChain() {
    if (!currentInstRef.current) return;
    const sym = getSymbol(currentInstRef.current);
    try {
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: Record<string,unknown>[]; pe?: Record<string,unknown>[] } };
      const chain = data.chain;
      if (!chain) return;
      const expiries = chain.all_expiries || [];
      setOiExpiries(expiries);
      const first = expiries.slice(0, 1);
      setSelExpiries(first);
      // Fetch with the specific nearest expiry so we get correct single-expiry OI,
      // not the multi-expiry dump returned by the no-expiry endpoint.
      await reloadOIExpiries(first);
    } catch { /* ignore */ }
  }

  async function reloadOIExpiries(expiries: string[]) {
    if (!currentInstRef.current || expiries.length === 0) return;
    const sym = getSymbol(currentInstRef.current);
    const ceMap: Record<number, number> = {};
    const peMap: Record<number, number> = {};
    for (const exp of expiries) {
      try {
        const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${encodeURIComponent(exp)}`);
        const data = await res.json() as { chain?: { ce?: Record<string,unknown>[]; pe?: Record<string,unknown>[] } };
        if (!data.chain) continue;
        for (const ce of (data.chain.ce || [])) {
          const sp = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
          const oi = Number(ce.oi ?? ce.open_interest) || 0;
          ceMap[sp] = (ceMap[sp] || 0) + oi;
        }
        for (const pe of (data.chain.pe || [])) {
          const sp = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
          const oi = Number(pe.oi ?? pe.open_interest) || 0;
          peMap[sp] = (peMap[sp] || 0) + oi;
        }
      } catch { /* ignore */ }
    }
    const hasData = Object.values(ceMap).some(v => v > 0) || Object.values(peMap).some(v => v > 0);
    if (hasData) {
      oiChainRef.current = {
        ce: Object.entries(ceMap).map(([sp, oi]) => ({ sp: Number(sp) * 100, oi })),
        pe: Object.entries(peMap).map(([sp, oi]) => ({ sp: Number(sp) * 100, oi })),
      };
    }
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

  function startOILoop() {
    if (oiLoopRef.current) return;
    const storeSnap = () => {
      if (!oiChainRef.current) return;
      const now = Date.now();
      if (now - lastOiSnapTimeRef.current > 30000) {
        oiSnapshotsRef.current.set(now, { ce: [...oiChainRef.current.ce], pe: [...oiChainRef.current.pe] });
        lastOiSnapTimeRef.current = now;
      }
    };
    storeSnap(); // initial snapshot when loop starts
    function loop() {
      if (!oiEnabledRef.current) { oiLoopRef.current = null; return; }
      storeSnap();
      drawOI();
      oiLoopRef.current = requestAnimationFrame(() => setTimeout(loop, 100));
    }
    oiLoopRef.current = requestAnimationFrame(loop);
  }

  function drawOI() {
    const canvas = canvasRef.current;
    const cont   = containerRef.current;
    const series = candleRef.current;
    if (!canvas || !cont || !series || !oiChainRef.current) return;

    const dpr  = window.devicePixelRatio || 1;
    const w    = cont.clientWidth;
    const h    = cont.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width  = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!oiEnabledRef.current) return;

    // Apply "to" snapshot or baseline (from) for time-range OI view
    let ceList = oiToSnapRef.current ? oiToSnapRef.current.ce : oiChainRef.current.ce;
    let peList = oiToSnapRef.current ? oiToSnapRef.current.pe : oiChainRef.current.pe;
    const baseline = oiBaselineRef.current;
    if (baseline) {
      const ceBase: Record<number, number> = {};
      const peBase: Record<number, number> = {};
      for (const c of baseline.ce) ceBase[Number(c.sp)] = Number(c.oi) || 0;
      for (const p of baseline.pe) peBase[Number(p.sp)] = Number(p.oi) || 0;
      ceList = ceList.map(c => ({ ...c, oi: Math.max(0, (Number(c.oi) || 0) - (ceBase[Number(c.sp)] || 0)) }));
      peList = peList.map(p => ({ ...p, oi: Math.max(0, (Number(p.oi) || 0) - (peBase[Number(p.sp)] || 0)) }));
    }

    const map: Record<number, { ceOi: number; peOi: number }> = {};
    for (const ce of ceList) {
      const sp = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
      if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
      map[sp].ceOi += Number(ce.oi ?? ce.open_interest) || 0;
    }
    for (const pe of peList) {
      const sp = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
      if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
      map[sp].peOi += Number(pe.oi ?? pe.open_interest) || 0;
    }

    const allOi = Object.values(map).flatMap((v) => [v.ceOi, v.peOi]).filter((v) => v > 0).sort((a, b) => b - a);
    const maxOi = allOi[0] || 1;

    const priceScaleW = 72;
    const maxBarW     = (w - priceScaleW) * 0.35 * oiWidthScaleRef.current;
    const barH        = 20;

    for (const [strikeStr, { ceOi, peOi }] of Object.entries(map)) {
      const strike = Number(strikeStr);
      const y      = series.priceToCoordinate(strike);
      if (y == null || y < 2 || y > h - 2) continue;
      const right = w - priceScaleW;

      if (showCalls && ceOi > 0) {
        const bw = Math.max(3, Math.min((ceOi / maxOi) * maxBarW, maxBarW));
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = '#22c55e';
        ctx.fillRect(right - bw, y - barH / 2, bw, barH / 2);
      }
      if (showPuts && peOi > 0) {
        const bw = Math.max(3, Math.min((peOi / maxOi) * maxBarW, maxBarW));
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = '#ef4444';
        ctx.fillRect(right - bw, y, bw, barH / 2);
      }
    }
    ctx.globalAlpha = 1;
  }
  drawOIRef.current = drawOI;

  // OI canvas drag-to-resize — uses document-level listeners so drag survives moving over chart canvas
  function handleMouseDown(e: React.MouseEvent) {
    if (!oiEnabledRef.current || !containerRef.current) return;
    const rect       = containerRef.current.getBoundingClientRect();
    const x          = e.clientX - rect.left;
    const priceScaleW= 72;
    const maxBarW    = (containerRef.current.clientWidth - priceScaleW) * 0.35 * oiWidthScaleRef.current;
    const handleX    = containerRef.current.clientWidth - priceScaleW - maxBarW;
    if (Math.abs(x - handleX) > 15) return;

    oiDragRef.current = { dragging: true, startX: x, startScale: oiWidthScaleRef.current };
    e.preventDefault();

    const onMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const rx   = ev.clientX - containerRef.current.getBoundingClientRect().left;
      const dx   = oiDragRef.current.startX - rx;
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

    // OI bar hover tooltip — only when cursor is physically over a rendered bar
    if (oiEnabledRef.current && oiChainRef.current && candleRef.current && x >= handleX - 5) {
      const price = candleRef.current.coordinateToPrice(y);
      if (price != null && price > 0) {
        const strikeMap: Record<number, { ceOi: number; peOi: number }> = {};
        for (const ce of oiChainRef.current.ce) {
          const sp = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
          if (!strikeMap[sp]) strikeMap[sp] = { ceOi: 0, peOi: 0 };
          strikeMap[sp].ceOi += Number(ce.oi) || 0;
        }
        for (const pe of oiChainRef.current.pe) {
          const sp = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
          if (!strikeMap[sp]) strikeMap[sp] = { ceOi: 0, peOi: 0 };
          strikeMap[sp].peOi += Number(pe.oi) || 0;
        }
        const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b);
        if (strikes.length > 1) {
          const nearest = strikes.reduce((prev, curr) =>
            Math.abs(curr - price) < Math.abs(prev - price) ? curr : prev, strikes[0]);
          const interval = strikes[1] - strikes[0];
          if (Math.abs(nearest - price) <= interval * 0.65) {
            const d = strikeMap[nearest];
            const yStrike = candleRef.current.priceToCoordinate(nearest);
            if (yStrike != null) {
              const barH = 20;
              const right = w - priceScaleW;
              const allOiVals = Object.values(strikeMap).flatMap(v => [v.ceOi, v.peOi]).filter(v => v > 0).sort((a, b) => b - a);
              const maxOi = allOiVals[0] || 1;
              const bwCe = Math.max(3, Math.min((d.ceOi / maxOi) * maxBarW, maxBarW));
              const bwPe = Math.max(3, Math.min((d.peOi / maxOi) * maxBarW, maxBarW));
              const overCe = d.ceOi > 0 && y >= yStrike - barH / 2 && y <= yStrike     && x >= right - bwCe;
              const overPe = d.peOi > 0 && y >= yStrike              && y <= yStrike + barH / 2 && x >= right - bwPe;
              if (overCe || overPe) {
                setOiHover({ x, y, strike: nearest, ceOi: d.ceOi, peOi: d.peOi });
                return;
              }
            }
          }
        }
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

  // ── Toolbar ───────────────────────────────────────────────────────────────
  const sym = instrument ? getSymbol(instrument) : '—';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="text-base font-bold text-[var(--text-primary)]">{sym}</span>
        {priceDisplay && (
          <>
            <span className={`text-[17px] font-bold ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              ₹{fmtPrice(priceDisplay.price)}
            </span>
            <span className={`text-[13px] font-medium ${priceDisplay.up ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {priceDisplay.up ? '+' : ''}{priceDisplay.diff.toFixed(2)} ({priceDisplay.up ? '+' : ''}{priceDisplay.pct}%)
            </span>
          </>
        )}

        {/* Indicators dropdown */}
        <div className="relative ml-1">
          <button
            onClick={() => setShowVol((v) => !v)}
            className={`px-2.5 py-1 rounded text-xs font-medium border transition-all ${
              showVol ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            Vol
          </button>
        </div>

        {/* OI Profile — left=toggle, right=settings caret (Upstox style) */}
        <div className="relative flex items-stretch">
          {/* Toggle on/off */}
          <button
            onClick={() => {
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
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-l text-xs font-medium border border-r-0 transition-all ${
              oiOn ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            <span className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${oiOn ? 'bg-white/30 border-white/60' : 'border-current opacity-60'}`}>
              {oiOn && <span className="text-[8px] font-bold leading-none">✓</span>}
            </span>
            OI Profile
          </button>
          {/* Settings dropdown caret */}
          <button
            onClick={() => {
              setShowOiPopup(v => !v);
              if (!oiExpiries.length && currentInstRef.current) loadOIChain();
            }}
            className={`px-1.5 py-1 rounded-r text-xs font-medium border border-l-0 transition-all ${
              oiOn ? 'bg-[var(--accent)] border-[var(--accent)] text-white hover:opacity-80' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
            }`}
          >
            ▾
          </button>

          {showOiPopup && (
            <div className="absolute top-full left-0 mt-1 z-50 w-[290px] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">OI Profile Settings</span>
                <button onClick={() => setShowOiPopup(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none">×</button>
              </div>

              {/* Mode tabs */}
              <div className="flex border-b border-[var(--border)]">
                {(['oi', 'oi_change'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setOiMode(mode)}
                    className={`flex-1 py-2.5 text-[12px] font-medium transition-all border-b-2 -mb-px ${oiMode === mode ? 'border-[var(--accent)] text-[var(--accent)]' : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                  >
                    {mode === 'oi' ? 'Open Interest' : 'Change in OI'}
                  </button>
                ))}
              </div>

              <div className="px-4 py-3 flex flex-col gap-4">
                {/* EXPIRES INCLUDED */}
                {oiExpiries.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">EXPIRES INCLUDED</div>
                    <div className="flex flex-col gap-1.5">
                      {oiExpiries.map((exp) => (
                        <label key={exp} className="flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={selExpiries.includes(exp)}
                            onChange={(e) => setSelExpiries((prev) => e.target.checked ? [...prev, exp] : prev.filter((x) => x !== exp))}
                            className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                          />
                          <span className="text-[12px] text-[var(--text-primary)]">{formatExpiry(exp)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* VISUAL SETTINGS */}
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-2">VISUAL SETTINGS</div>
                  <label className="flex items-center gap-2 cursor-pointer select-none mb-2">
                    <input type="checkbox" checked={showCalls} onChange={(e) => setShowCalls(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">CALLS</span>
                    <span className="w-4 h-4 rounded-sm shrink-0" style={{ backgroundColor: '#22c55e' }} />
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={showPuts} onChange={(e) => setShowPuts(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                    <span className="text-[12px] text-[var(--text-primary)] flex-1">PUTS</span>
                    <span className="w-4 h-4 rounded-sm shrink-0" style={{ backgroundColor: '#ef4444' }} />
                  </label>
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border)]">
                <button onClick={() => setShowOiPopup(false)} className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Cancel</button>
                <button
                  onClick={() => { reloadOIExpiries(selExpiries); setShowOiPopup(false); }}
                  className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-dim)] transition-colors"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Interval buttons */}
        <div className="flex gap-0.5 ml-auto">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              onClick={() => setInterval(iv)}
              className={`px-2 py-1 rounded text-[12px] font-medium transition-all ${
                interval === iv
                  ? 'bg-[var(--accent)] text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      {/* Chart container */}
      <div
        ref={containerRef}
        className="relative flex-1 bg-[var(--bg-primary)]"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onWheel={() => { if (oiEnabledRef.current) requestAnimationFrame(drawOI); }}
      >
        {/* OI canvas overlay */}
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-[5]" />

        {/* OI time range — floating above OI bars, top-right of chart */}
        {oiOn && (
          <div className="absolute top-2 right-[80px] z-10 flex items-center gap-1.5 bg-[var(--bg-secondary)]/90 backdrop-blur-sm border border-[var(--border)] rounded-lg px-2.5 py-1 pointer-events-auto">
            <span className="text-[10px] text-[var(--text-muted)] shrink-0">From</span>
            <input
              type="time"
              value={oiFromTime}
              onChange={(e) => {
                const v = e.target.value;
                setOiFromTime(v);
                const toMs = (t: string) => { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
                const snaps = Array.from(oiSnapshotsRef.current.entries()).sort((a, b) => a[0] - b[0]);
                if (v && snaps.length) { const ms = toMs(v); const s = snaps.find(([ts]) => ts >= ms) ?? snaps[0]; oiBaselineRef.current = s[1]; }
                else oiBaselineRef.current = null;
                drawOIRef.current();
              }}
              className="text-[11px] bg-transparent text-[var(--text-primary)] border-none outline-none w-[62px] [color-scheme:dark]"
            />
            <span className="text-[10px] text-[var(--text-muted)] shrink-0">To</span>
            <input
              type="time"
              value={oiToTime}
              onChange={(e) => {
                const v = e.target.value;
                setOiToTime(v);
                const toMs = (t: string) => { const [h, m] = t.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
                const snaps = Array.from(oiSnapshotsRef.current.entries()).sort((a, b) => a[0] - b[0]);
                if (v && snaps.length) { const ms = toMs(v); const candidates = snaps.filter(([ts]) => ts <= ms); const s = candidates[candidates.length - 1] ?? snaps[0]; oiToSnapRef.current = s[1]; }
                else oiToSnapRef.current = null;
                drawOIRef.current();
              }}
              className="text-[11px] bg-transparent text-[var(--text-primary)] border-none outline-none w-[62px] [color-scheme:dark]"
            />
            {(oiFromTime || oiToTime) && (
              <button
                onClick={() => { setOiFromTime(''); setOiToTime(''); oiBaselineRef.current = null; oiToSnapRef.current = null; drawOIRef.current(); }}
                className="text-[12px] text-[var(--text-muted)] hover:text-[var(--red)] leading-none ml-0.5"
                title="Reset time range"
              >
                ×
              </button>
            )}
          </div>
        )}

        {/* OHLC overlay */}
        {ohlc && (
          <div className="absolute top-2 left-3 z-10 pointer-events-none">
            <div className="flex items-center gap-1 text-[12px]">
              <span className="text-[var(--text-muted)] text-[11px]">O</span><span className="text-[var(--text-primary)] font-medium">{ohlc.o.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">H</span><span className="text-[var(--green)] font-medium">{ohlc.h.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">L</span><span className="text-[var(--red)] font-medium">{ohlc.l.toFixed(2)}</span>
              <span className="text-[var(--text-muted)] text-[11px]">C</span><span className="text-[var(--text-primary)] font-medium">{ohlc.c.toFixed(2)}</span>
              {ohlc.vol && <><span className="text-[var(--text-muted)] text-[11px] ml-1">Vol</span><span className="text-[var(--text-primary)] font-medium">{fmtVol(ohlc.vol)}</span></>}
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-secondary)] text-[14px] z-10">
            {loading}
          </div>
        )}

        {/* Load-more indicator */}
        {loadMore && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 bg-[rgba(30,33,38,0.8)] text-[var(--text-secondary)] text-[11px] px-2.5 py-1 rounded z-10 pointer-events-none">
            Loading…
          </div>
        )}

        {/* OI bar hover tooltip */}
        {oiHover && oiOn && (
          <div
            className="absolute z-20 pointer-events-none"
            style={{
              left: Math.max(4, oiHover.x - 210),
              top: Math.max(4, Math.min(oiHover.y - 58, (containerRef.current?.clientHeight ?? 400) - 120)),
            }}
          >
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl px-4 py-3 min-w-[178px]">
              <div className="text-[14px] font-semibold text-[var(--text-primary)] mb-2 pb-1.5 border-b border-[var(--border)]">
                Strike {oiHover.strike.toLocaleString('en-IN')}
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px] mb-1">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#22c55e] shrink-0" />
                  <span className="text-[var(--text-muted)]">Call</span>
                </div>
                <span className="text-[var(--text-primary)] font-medium tabular-nums">{fmtOI(oiHover.ceOi)}</span>
              </div>
              <div className="flex items-center justify-between gap-4 text-[13px]">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-[2px] bg-[#ef4444] shrink-0" />
                  <span className="text-[var(--text-muted)]">Put</span>
                </div>
                <span className="text-[var(--text-primary)] font-medium tabular-nums">{fmtOI(oiHover.peOi)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Candle countdown */}
        {countdown && (
          <div
            className="absolute right-0 w-[72px] text-center text-white text-[11px] font-semibold py-0.5 z-20 pointer-events-none font-mono"
            style={{
              top: countdownY,
              backgroundColor: priceDisplay ? (priceDisplay.up ? '#22c55e' : '#ef4444') : '#2962ff',
            }}
          >
            {countdown}
          </div>
        )}
      </div>
    </div>
  );
}

// ── API fetch ─────────────────────────────────────────────────────────────────
function nubraType(item: Instrument): string {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type      || '').toUpperCase();
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

async function fetchRange(
  instrument: Instrument,
  interval: string,
  startDate: Date,
  endDate: Date,
): Promise<{ bars: OhlcBar[]; volBars: VolBar[] }> {
  const type   = nubraType(instrument);
  const symbol = getSymbol(instrument);
  const exch   = instrument.exchange || 'NSE';

  const body = {
    query: [{
      exchange: exch, type,
      values:   [symbol],
      fields:   ['open', 'high', 'low', 'close', 'cumulative_volume'],
      startDate: startDate.toISOString(),
      endDate:   endDate.toISOString(),
      interval, intraDay: false, realTime: false,
    }],
  };

  const res  = await fetch('/api/historical', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json() as { result?: Array<{ values: Array<Record<string, { open?: Array<{ts?:string;v:number}>; high?: Array<{v:number}>; low?: Array<{v:number}>; close?: Array<{v:number}>; cumulative_volume?: Array<{v:number}> }>> }>; error?: string };
  if (data.error) throw new Error(data.error);

  const bars: OhlcBar[] = [], volBars: VolBar[] = [];

  for (const group of data.result || []) {
    for (const symbolMap of group.values || []) {
      for (const chart of Object.values(symbolMap)) {
        const opens  = chart.open              || [];
        const highs  = chart.high              || [];
        const lows   = chart.low               || [];
        const closes = chart.close             || [];
        const vols   = chart.cumulative_volume || [];
        const len = Math.min(opens.length, highs.length, lows.length, closes.length);

        for (let i = 0; i < len; i++) {
          const tsNs = opens[i].ts;
          if (tsNs == null) continue;
          const t = toChartTime(BigInt(tsNs), interval);
          const o = opens[i].v / 100, h = highs[i].v / 100, l = lows[i].v / 100, c = closes[i].v / 100;
          bars.push({ time: t, open: o, high: h, low: l, close: c });
          if (vols[i]?.v) {
            volBars.push({ time: t, value: vols[i].v, color: c >= o ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' });
          }
        }
      }
    }
  }

  bars.sort((a, b)    => sortKey(a.time) - sortKey(b.time));
  volBars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return { bars, volBars };
}
