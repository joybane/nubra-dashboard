import { subscribe, unsubscribe } from './app.js';
import { TradingModule } from './trading.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const INTRADAY    = new Set(['1m','2m','3m','5m','10m','15m','30m','1h']);
const IST_OFFSET  = 5.5 * 60 * 60; // seconds

function isIntraday(iv) { return INTRADAY.has(iv); }

// Initial load — small for fast startup; lazy-load fills history on scroll
function historyDays(iv) {
  return {'1m':3,'2m':5,'3m':5,'5m':7,'10m':10,'15m':15,'30m':20,'1h':45,'1d':365,'1w':730,'1mt':1825}[iv] || 30;
}

// Each lazy-load chunk
function chunkDays(iv) {
  return {'1m':3,'2m':5,'3m':7,'5m':10,'10m':15,'15m':20,'30m':30,'1h':60,'1d':180,'1w':365,'1mt':730}[iv] || 30;
}

// Interval string → Nubra proto Interval enum (for matching incoming OHLCV ticks)
const INTERVAL_TO_PROTO = {
  '1m':3,'2m':4,'3m':5,'5m':6,'10m':7,'15m':8,'30m':9,
  '1h':10,'1d':13,'1w':14,'1mt':15,
};

// Nubra ns timestamp → TradingView time value in IST
// Uses BigInt division to avoid precision loss (ns timestamps exceed JS safe integer range)
function toChartTime(tsNs, iv) {
  const utcSec = Number(BigInt(tsNs) / 1_000_000_000n); // exact integer division
  if (isIntraday(iv)) return utcSec + IST_OFFSET;
  const d = new Date((utcSec + IST_OFFSET) * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// Snap utcSec to the start of the current candle boundary in IST
function snapToCandle(utcSec, iv) {
  const intSec  = intervalToSeconds(iv);
  const istSec  = utcSec + IST_OFFSET;
  const snapped = Math.floor(istSec / intSec) * intSec;
  if (isIntraday(iv)) return snapped;
  const d = new Date(snapped * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function sortKey(t) {
  return typeof t === 'object' ? t.year * 10000 + t.month * 100 + t.day : t;
}

function nubraType(item) {
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type     || '').toUpperCase();
  if (dt === 'FUT'   || at === 'FUT')   return 'FUT';
  if (dt === 'OPT'   || at === 'OPT')   return 'OPT';
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  return 'STOCK';
}

function getBucket(item) {
  const t = nubraType(item);
  if (t === 'INDEX') return 'index_bucket';
  if (t === 'FUT')   return 'fut_bucket';
  if (t === 'OPT')   return 'opt_bucket';
  return 'stock_bucket';
}

function buildPayload(item) {
  const sym = item.nubra_name || item.stock_name || item.asset;
  const b   = getBucket(item);
  if (b === 'index_bucket') return { indexes: [sym] };
  if (b === 'fut_bucket')   return { futures: [sym] };
  if (b === 'opt_bucket')   return { options: [sym] };
  return { stocks: [sym] };
}

function intervalToSeconds(iv) {
  return {'1m':60,'2m':120,'3m':180,'5m':300,'10m':600,'15m':900,'30m':1800,'1h':3600,'1d':86400,'1w':604800,'1mt':2592000}[iv] || 300;
}

function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e7)  return (v/1e7).toFixed(2) + ' Cr';
  if (v >= 1e5)  return (v/1e5).toFixed(2) + ' L';
  if (v >= 1000) return (v/1000).toFixed(1) + 'K';
  return String(v);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const container      = document.getElementById('chart-container');
const loadingEl      = document.getElementById('chart-loading');
const loadMoreEl     = document.getElementById('chart-loadmore');
const ohlcEl         = document.getElementById('chart-ohlc');
const ohlcO          = document.getElementById('ohlc-o');
const ohlcH          = document.getElementById('ohlc-h');
const ohlcL          = document.getElementById('ohlc-l');
const ohlcC          = document.getElementById('ohlc-c');
const ohlcChg        = document.getElementById('ohlc-chg');
const ohlcVol        = document.getElementById('ohlc-vol');
const symbolEl       = document.getElementById('chart-symbol');
const priceEl        = document.getElementById('chart-price');
const changeEl       = document.getElementById('chart-change');
const intervalGroup  = document.getElementById('interval-group');
const btnIndicators  = document.getElementById('btn-indicators');
const indDropdown    = document.getElementById('indicator-dropdown');
const indVolCheck    = document.getElementById('ind-volume');
const btnOiProfile   = document.getElementById('btn-oi-profile');
const oiProfilePopup = document.getElementById('oi-profile-popup');
const oiExpiryChecks = document.getElementById('oi-expiry-checks');
const oiShowCalls    = document.getElementById('oi-show-calls');
const oiShowPuts     = document.getElementById('oi-show-puts');
const btnOiApply     = document.getElementById('btn-oi-apply');
const btnOiCancel    = document.getElementById('btn-oi-cancel');
const oiCanvas       = document.getElementById('oi-canvas');
const oiCtx          = oiCanvas ? oiCanvas.getContext('2d') : null;
const countdownEl    = document.getElementById('candle-countdown');

// ── Chart state ───────────────────────────────────────────────────────────────
let tvChart          = null;
let candleSeries     = null;
let volSeries        = null;
let currentInstrument= null;
let currentInterval  = '5m';
let allBars          = [];
let allVolBars       = [];
let earliestStart    = null;   // JS Date — how far back we've loaded
let isLoadingMore    = false;
let currentTheme     = 'dark';

// OI Profile state
let oiEnabled        = false;
let oiChainData      = null;
let oiSelectedExpiry = null;
let oiPendingExpiry  = null;
let countdownTimer   = null;
let oiLoopFrame      = null;
let oiWidthScale     = 1.0; // draggable OI bar width multiplier
let oiDragging       = false;
let oiDragStartX     = 0;
let oiDragStartScale = 1.0;
let lastBar          = null;
let dayOpenPrice     = null;
const partialCandle  = {};

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  tvChart = LightweightCharts.createChart(container, {
    layout: {
      background:  { color: '#0d0f11' },
      textColor:   '#c9d1d9',
      fontSize:    14,
      fontFamily:  "'Inter', 'Segoe UI', sans-serif",
    },
    grid: {
      vertLines: { color: '#1a1d21' },
      horzLines: { color: '#1a1d21' },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: '#22262b' },
      horzLine: { color: '#4b5563', width: 1, style: 0, labelBackgroundColor: '#3b82f6' },
    },
    rightPriceScale: {
      borderColor:    '#2a2d32',
      minimumWidth:   72,
    },
    timeScale: {
      borderColor:               '#2a2d32',
      timeVisible:               true,
      secondsVisible:            false,
      shiftVisibleRangeOnNewBar: true,
      tickMarkMaxCharacterLength: 8,
      // Show only date (no time) for session-boundary ticks
      tickMarkFormatter: (time, tickMarkType) => {
        const d = new Date(time * 1000);
        const h  = d.getUTCHours();
        const m  = d.getUTCMinutes();
        const hStr = h.toString().padStart(2,'0');
        const mStr = m.toString().padStart(2,'0');
        // Session boundary: only show date when it's near midnight (gap period)
        if (h < 9 || h >= 16) {
          // Non-trading time — show date
          return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', timeZone:'UTC' });
        }
        return `${hStr}:${mStr}`;
      },
    },
    handleScroll: true,
    handleScale:  true,
  });

  // Candlestick series
  candleSeries = tvChart.addCandlestickSeries({
    upColor:          '#22c55e',
    downColor:        '#ef4444',
    borderUpColor:    '#22c55e',
    borderDownColor:  '#ef4444',
    wickUpColor:      '#22c55e',
    wickDownColor:    '#ef4444',
    priceLineVisible: true,
    lastValueVisible: true,
  });

  // Volume histogram — hidden by default, toggled via Indicators
  volSeries = tvChart.addHistogramSeries({
    priceFormat:    { type: 'volume' },
    priceScaleId:   'vol',
    lastValueVisible: false,
    priceLineVisible: false,
    visible: false,
  });
  volSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  // OHLC overlay on crosshair move + reposition countdown
  tvChart.subscribeCrosshairMove((param) => {
    updateCountdownPosition();
    if (oiEnabled) requestAnimationFrame(drawOIProfile);
    const bar  = param.seriesData?.get(candleSeries);
    const vBar = param.seriesData?.get(volSeries);
    if (bar) {
      renderOhlc(bar, vBar?.value);
    } else if (lastBar) {
      renderOhlc(lastBar);
    }
  });

  // Lazy load when user scrolls near the left edge + redraw OI
  tvChart.timeScale().subscribeVisibleLogicalRangeChange(async (range) => {
    if (oiEnabled) requestAnimationFrame(drawOIProfile);
    if (!range || isLoadingMore || !currentInstrument || !earliestStart) return;
    if (range.from > 10) return; // still far from left edge
    await loadMoreHistory();
  });

  // Resize observer
  new ResizeObserver(() => {
    tvChart.resize(container.clientWidth, container.clientHeight);
  }).observe(container);

  // Indicators dropdown toggle
  btnIndicators?.addEventListener('click', (e) => {
    e.stopPropagation();
    indDropdown?.classList.toggle('open');
  });
  document.addEventListener('click', () => indDropdown?.classList.remove('open'));

  indVolCheck?.addEventListener('change', () => {
    const show = indVolCheck.checked;
    volSeries.applyOptions({ visible: show });
    // Adjust candle area when volume visible/hidden
    if (show) {
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
    } else {
      candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
    }
  });

  // OI Profile — prevent popup closing on internal clicks
  oiProfilePopup?.addEventListener('click', (e) => e.stopPropagation());

  btnOiProfile?.addEventListener('click', (e) => {
    e.stopPropagation();
    oiProfilePopup?.classList.toggle('open');
    if (oiProfilePopup?.classList.contains('open') && !oiChainData && currentInstrument) {
      loadOIChain();
    }
  });

  btnOiApply?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Apply any pending expiry change then close
    if (oiPendingExpiry && oiPendingExpiry !== oiSelectedExpiry) {
      oiSelectedExpiry = oiPendingExpiry;
      reloadOIExpiry();
    } else {
      drawOIProfile();
    }
    oiEnabled = true;
    oiCanvas?.classList.remove('hidden');
    startOILoop();
    oiProfilePopup?.classList.remove('open');
  });

  btnOiCancel?.addEventListener('click', (e) => {
    e.stopPropagation();
    oiProfilePopup?.classList.remove('open');
  });

  document.addEventListener('click', () => oiProfilePopup?.classList.remove('open'));

  oiShowCalls?.addEventListener('change', drawOIProfile);
  oiShowPuts?.addEventListener('change', drawOIProfile);

  // OI redraws on every mouse/wheel interaction (price scale zoom)
  // OI drag-to-resize handle
  container.addEventListener('mousedown', (e) => {
    if (!oiEnabled || !oiCanvas) return;
    const rect  = container.getBoundingClientRect();
    const x     = e.clientX - rect.left;
    const priceScaleW = 72;
    const maxBarW = (container.clientWidth - priceScaleW) * 0.35 * oiWidthScale;
    const handleX = container.clientWidth - priceScaleW - maxBarW;
    if (Math.abs(x - handleX) <= 10) {
      oiDragging      = true;
      oiDragStartX    = x;
      oiDragStartScale= oiWidthScale;
      container.style.cursor = 'ew-resize';
      e.preventDefault();
    }
  });

  container.addEventListener('mousemove', (e) => {
    if (!oiEnabled) return;
    const rect    = container.getBoundingClientRect();
    const x       = e.clientX - rect.left;
    const priceScaleW = 72;

    if (oiDragging) {
      // Dragging left increases width, right decreases
      const dx       = oiDragStartX - x;
      const baseW    = (container.clientWidth - priceScaleW) * 0.35;
      oiWidthScale   = Math.max(0.2, Math.min(3.0, oiDragStartScale + dx / baseW));
      drawOIProfile();
    } else {
      // Change cursor when hovering over drag handle
      const baseW2  = (container.clientWidth - priceScaleW) * 0.35;
      const handleX = container.clientWidth - priceScaleW - (baseW2 * oiWidthScale);
      container.style.cursor = (Math.abs(x - handleX) <= 10) ? 'ew-resize' : '';
      drawOIProfile();
    }
  });

  container.addEventListener('mouseup', () => {
    if (oiDragging) { oiDragging = false; container.style.cursor = ''; }
    if (oiEnabled) requestAnimationFrame(drawOIProfile);
  });

  container.addEventListener('wheel',    () => { if (oiEnabled) requestAnimationFrame(drawOIProfile); }, { passive: true });
  container.addEventListener('touchend', () => { if (oiEnabled) requestAnimationFrame(drawOIProfile); });

  // Subscribe to visible range change
  // (done via subscription after chart creation below)

  // Interval buttons
  intervalGroup.querySelectorAll('.interval-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      intervalGroup.querySelectorAll('.interval-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentInterval = btn.dataset.interval;
      if (currentInstrument) loadSymbol(currentInstrument);
    });
  });
}

// ── OHLC overlay ──────────────────────────────────────────────────────────────
function renderOhlc(bar, vol) {
  if (!ohlcEl) return;
  const f = n => n != null ? n.toFixed(2) : '—';
  ohlcO.textContent = f(bar.open);
  ohlcH.textContent = f(bar.high);
  ohlcL.textContent = f(bar.low);
  ohlcC.textContent = f(bar.close);
  if (ohlcVol) ohlcVol.textContent = fmtVol(vol);

  const diff = bar.close - (dayOpenPrice || bar.open);
  const pct  = dayOpenPrice ? ((diff / dayOpenPrice) * 100).toFixed(2) : '0.00';
  const up   = diff >= 0;
  ohlcChg.textContent = `${up?'+':''}${diff.toFixed(2)} (${up?'+':''}${pct}%)`;
  ohlcChg.className   = `ohlc-chg ${up ? 'up' : 'down'}`;
  ohlcEl.classList.remove('hidden');
}

// ── Load symbol ───────────────────────────────────────────────────────────────
async function loadSymbol(instrument) {
  // Unsubscribe old
  if (currentInstrument) {
    const oldSym = currentInstrument.nubra_name || currentInstrument.stock_name || currentInstrument.asset;
    unsubscribe('index_bucket', { instruments: [], indexes: [oldSym] }, currentInterval, currentInstrument.exchange || 'NSE');
  }

  currentInstrument = instrument;
  allBars       = [];
  allVolBars    = [];
  earliestStart = null;
  lastBar       = null;
  dayOpenPrice  = null;
  Object.keys(partialCandle).forEach(k => delete partialCandle[k]);
  stopCountdown();

  const sym = instrument.nubra_name || instrument.stock_name || instrument.asset;
  symbolEl.textContent = sym;
  priceEl.textContent  = '';
  changeEl.textContent = '';
  if (ohlcEl) ohlcEl.classList.add('hidden');

  showLoading('Loading historical data…');

  try {
    const endDate   = new Date();
    const startDate = new Date(endDate.getTime() - historyDays(currentInterval) * 86400000);
    const { bars, volBars } = await fetchRange(instrument, currentInterval, startDate, endDate);

    if (!bars.length) { showLoading('No historical data available.'); return; }

    allBars      = bars;
    allVolBars   = volBars;
    earliestStart= startDate;
    lastBar      = bars[bars.length - 1];
    dayOpenPrice = bars[0].open;

    candleSeries.setData(allBars);
    volSeries.setData(allVolBars);

    // Show last ~200 bars at readable width
    const len = allBars.length;
    tvChart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, len - 200),
      to:   len + 5,
    });

    // Auto-scale price axis to current price region (not entire history)
    candleSeries.priceScale().applyOptions({ autoScale: true });

    hideLoading();

    // Start candle countdown
    startCountdown();

    renderOhlc(lastBar);
    updatePriceDisplay(lastBar.close, dayOpenPrice);

    const sym2 = instrument.nubra_name || instrument.stock_name || instrument.asset;
    subscribe('index_bucket', { instruments: [], indexes: [sym2] }, currentInterval, instrument.exchange || 'NSE');

    // Notify paper trading module so Buy/Sell buttons know current symbol
    TradingModule.setChartSymbol(sym2, instrument.exchange || 'NSE', nubraType(instrument));
  } catch (err) {
    showLoading(`Error: ${err.message}`);
    console.error('loadSymbol error:', err);
  }
}

// ── Lazy load more history ────────────────────────────────────────────────────
async function loadMoreHistory() {
  if (isLoadingMore || !earliestStart || !currentInstrument) return;
  isLoadingMore = true;
  loadMoreEl?.classList.remove('hidden');

  try {
    const endDate   = new Date(earliestStart.getTime() - 60000); // just before earliest
    const startDate = new Date(endDate.getTime() - chunkDays(currentInterval) * 86400000);

    const { bars, volBars } = await fetchRange(currentInstrument, currentInterval, startDate, endDate);
    if (bars.length) {
      allBars      = [...bars,    ...allBars];
      allVolBars   = [...volBars, ...allVolBars];
      earliestStart = startDate;
      dayOpenPrice  = allBars[0].open;
      candleSeries.setData(allBars);
      volSeries.setData(allVolBars);
    }
  } catch (e) {
    console.warn('loadMoreHistory failed:', e.message);
  }

  isLoadingMore = false;
  loadMoreEl?.classList.add('hidden');
}

// ── Fetch from API ────────────────────────────────────────────────────────────
async function fetchRange(instrument, interval, startDate, endDate) {
  const type   = nubraType(instrument);
  const symbol = instrument.nubra_name || instrument.stock_name || instrument.asset;
  const exch   = instrument.exchange || 'NSE';

  const body = {
    query: [{
      exchange: exch, type,
      values:   [symbol],
      fields:   ['open', 'high', 'low', 'close', 'cumulative_volume'],
      startDate: startDate.toISOString(),
      endDate:   endDate.toISOString(),
      interval,
      intraDay:  false,
      realTime:  false,
    }],
  };

  const res  = await fetch('/api/historical', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const bars = [], volBars = [];

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
          const tsNs = opens[i].ts ?? opens[i].timestamp;
          if (tsNs == null) continue;
          const t = toChartTime(BigInt(tsNs), interval);
          const o = opens[i].v / 100, h = highs[i].v / 100,
                l = lows[i].v  / 100, c = closes[i].v / 100;
          bars.push({ time: t, open: o, high: h, low: l, close: c });
          if (vols[i]?.v) {
            const up = c >= o;
            volBars.push({
              time:  t,
              value: vols[i].v,
              color: up ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)',
            });
          }
        }
      }
    }
  }

  bars.sort((a, b)    => sortKey(a.time) - sortKey(b.time));
  volBars.sort((a, b) => sortKey(a.time) - sortKey(b.time));
  return { bars, volBars };
}

// ── Live tick (decoded protobuf from server) ──────────────────────────────────
function onTick(msg) {
  if (!currentInstrument) return;

  if (msg.type === 'ohlcv') {
    const { data } = msg;
    const sym = (currentInstrument.nubra_name || currentInstrument.stock_name || currentInstrument.asset || '').toUpperCase();
    const buckets = [...(data.indexes || []), ...(data.instruments || [])];
    for (const b of buckets) {
      const bname = (b.indexname || '').toUpperCase();
      // Exact match OR starts-with match (options symbol prefix)
      if (bname === sym || sym.startsWith(bname) || bname.startsWith(sym)) {
        applyOhlcvBucket(b);
        break;
      }
    }
  }
}

function applyOhlcvBucket(b) {
  try {
    // Prefer bucket_timestamp (candle start) over timestamp (tick time)
    const tsStr = (b.bucket_timestamp && b.bucket_timestamp !== '0')
      ? b.bucket_timestamp
      : b.timestamp;
    if (!tsStr || tsStr === '0') return;

    // BigInt division for exact ns→s conversion (avoids float precision loss)
    const utcSec = Number(BigInt(tsStr) / 1_000_000_000n);

    // Always snap to candle boundary — ensures all ticks in the same period
    // map to the SAME time value so candleSeries.update() updates, not appends
    const barTime = snapToCandle(utcSec, currentInterval);

    const candle = {
      time:  barTime,
      open:  Number(b.open)  / 100,
      high:  Number(b.high)  / 100,
      low:   Number(b.low)   / 100,
      close: Number(b.close) / 100,
    };
    if (!candle.open || !candle.close) return;

    candleSeries.update(candle);
    lastBar = candle;
    updatePriceDisplay(candle.close, dayOpenPrice || candle.open);
    renderOhlc(candle, Number(b.cumulative_volume) || undefined);
    updateCountdownPosition(); // reposition countdown to match new price coord
  } catch (err) {
    console.error('applyOhlcvBucket error:', err.message);
  }
}

// ── Price toolbar ─────────────────────────────────────────────────────────────
function updatePriceDisplay(price, open) {
  const diff = price - (open || price);
  const pct  = open ? ((diff / open) * 100).toFixed(2) : '0.00';
  const up   = diff >= 0;
  priceEl.textContent = `₹${price.toFixed(2)}`;
  priceEl.className   = `chart-price ${up ? 'up' : 'down'}`;
  changeEl.textContent= `${up?'+':''}${diff.toFixed(2)} (${up?'+':''}${pct}%)`;
  changeEl.className  = `chart-change ${up ? 'up' : 'down'}`;
}

function showLoading(msg) {
  loadingEl.textContent = msg;
  loadingEl.style.display = 'flex';
}
function hideLoading() {
  loadingEl.style.display = 'none';
}

// ── Market hours check (IST 9:15 AM – 3:30 PM, Mon–Fri) ──────────────────────
function isMarketOpen() {
  const nowUtcMs = Date.now();
  const istMs    = nowUtcMs + IST_OFFSET * 1000;
  const ist      = new Date(istMs);
  const day      = ist.getUTCDay(); // 0=Sun,6=Sat
  if (day === 0 || day === 6) return false;
  const totalMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return totalMin >= 555 && totalMin < 930; // 9:15 = 555, 15:30 = 930
}

// ── Candle countdown — positioned on the price axis below current price ───────
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tickCountdown, 1000);
  tickCountdown();
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (countdownEl) countdownEl.classList.add('hidden');
}

function tickCountdown() {
  if (!currentInterval || !currentInstrument || !isMarketOpen()) {
    stopCountdown();
    return;
  }
  const intSec    = intervalToSeconds(currentInterval);
  const nowUtc    = Math.floor(Date.now() / 1000);
  const elapsed   = (nowUtc + IST_OFFSET) % intSec;
  const remaining = intSec - elapsed;
  const mm = Math.floor(remaining / 60).toString().padStart(2, '0');
  const ss = (remaining % 60).toString().padStart(2, '0');
  if (countdownEl) {
    countdownEl.textContent = `${mm}:${ss}`;
    countdownEl.classList.remove('hidden');
    updateCountdownPosition();
  }
}

function updateCountdownPosition() {
  if (!countdownEl || !lastBar || !candleSeries) return;
  const y = candleSeries.priceToCoordinate(lastBar.close);
  if (y == null) return;
  // Position just below the current price label (which is ~18px tall)
  countdownEl.style.top = `${Math.round(y) + 20}px`;
}

// ── OI redraw loop (keeps bars in sync on price-scale zoom) ───────────────────
function startOILoop() {
  if (oiLoopFrame) return;
  function loop() {
    if (!oiEnabled) { oiLoopFrame = null; return; }
    drawOIProfile();
    // Throttle to ~10 fps
    setTimeout(() => { oiLoopFrame = requestAnimationFrame(loop); }, 100);
  }
  oiLoopFrame = requestAnimationFrame(loop);
}

function stopOILoop() {
  if (oiLoopFrame) { cancelAnimationFrame(oiLoopFrame); oiLoopFrame = null; }
}

// ── OI Profile ────────────────────────────────────────────────────────────────
async function loadOIChain() {
  if (!currentInstrument) return;
  const sym = currentInstrument.nubra_name || currentInstrument.stock_name || currentInstrument.asset;
  try {
    const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}`);
    const data = await res.json();
    oiChainData = data.chain || null;
    if (!oiChainData) return;

    // Populate expiry checkboxes — clicking stages the change, Apply applies it
    const expiries = oiChainData.all_expiries || [];
    oiPendingExpiry  = expiries[0] || null;
    if (oiExpiryChecks) {
      oiExpiryChecks.innerHTML = '';
      expiries.forEach((exp, i) => {
        const label = document.createElement('label');
        label.className = 'oi-expiry-row';
        const isW = expiries.length > 5; // guess weekly vs monthly
        label.innerHTML = `
          <input type="checkbox" data-expiry="${exp}" ${i < 5 ? 'checked' : ''}/>
          ${formatExpiry(exp)} <span class="oi-expiry-tag">${isW ? 'W' : 'M'}</span>
        `;
        label.querySelector('input').addEventListener('change', function() {
          // Just stage the first checked expiry — popup stays open
          const checked = oiExpiryChecks.querySelectorAll('input:checked');
          if (checked.length) oiPendingExpiry = checked[0].dataset.expiry;
        });
        oiExpiryChecks.appendChild(label);
      });
    }

    oiSelectedExpiry = expiries[0] || null;
    oiEnabled = true;
    oiCanvas?.classList.remove('hidden');
    startOILoop();
    drawOIProfile();
  } catch (err) {
    console.error('OI load error:', err.message);
  }
}

async function reloadOIExpiry() {
  if (!currentInstrument || !oiSelectedExpiry) return;
  const sym = currentInstrument.nubra_name || currentInstrument.stock_name || currentInstrument.asset;
  try {
    const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?expiry=${oiSelectedExpiry}`);
    const data = await res.json();
    oiChainData = data.chain || null;
    drawOIProfile();
  } catch { /* ignore */ }
}

function drawOIProfile() {
  if (!oiCanvas || !oiCtx || !oiChainData || !candleSeries) return;

  const dpr = window.devicePixelRatio || 1;
  const w   = container.clientWidth;
  const h   = container.clientHeight;

  // Resize canvas with DPR support so bars are crisp on high-DPI screens
  if (oiCanvas.width !== w * dpr || oiCanvas.height !== h * dpr) {
    oiCanvas.width        = w * dpr;
    oiCanvas.height       = h * dpr;
    oiCanvas.style.width  = `${w}px`;
    oiCanvas.style.height = `${h}px`;
    oiCtx.scale(dpr, dpr);
  }

  oiCtx.clearRect(0, 0, w, h);
  if (!oiEnabled) return;

  const showCalls = oiShowCalls?.checked !== false;
  const showPuts  = oiShowPuts?.checked  !== false;

  const ceList = oiChainData.ce || [];
  const peList = oiChainData.pe || [];

  // Build strike → OI map
  const map = {};
  for (const ce of ceList) {
    const sp = ce.sp ? ce.sp / 100 : 0;
    if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
    map[sp].ceOi = ce.oi || 0;
  }
  for (const pe of peList) {
    const sp = pe.sp ? pe.sp / 100 : 0;
    if (!map[sp]) map[sp] = { ceOi: 0, peOi: 0 };
    map[sp].peOi = pe.oi || 0;
  }

  // Use median-ish OI for scale so most bars are visible (not squished by ATM outlier)
  const allOi   = Object.values(map).flatMap(v => [v.ceOi, v.peOi])
                    .filter(v => v > 0).sort((a, b) => b - a);
  const maxOi   = allOi[Math.floor(allOi.length * 0.15)] || allOi[0] || 1;

  // Reserve ~72px for price scale; bars occupy up to 35% × scale of remaining width
  const priceScaleW = 72;
  const maxBarW     = (w - priceScaleW) * 0.35 * oiWidthScale;
  const barH        = 20; // each strike: 10px CE on top + 10px PE below

  for (const [strikeStr, { ceOi, peOi }] of Object.entries(map)) {
    const strike = Number(strikeStr);
    const y      = candleSeries.priceToCoordinate(strike);
    if (y == null || y < 2 || y > h - 2) continue;

    const right  = w - priceScaleW;

    if (showCalls && ceOi > 0) {
      const bw = Math.max(3, Math.min((ceOi / maxOi) * maxBarW, maxBarW));
      oiCtx.globalAlpha = 0.80;
      oiCtx.fillStyle   = '#26a69a';
      oiCtx.fillRect(right - bw, y - barH / 2, bw, barH / 2);
    }
    if (showPuts && peOi > 0) {
      const bw = Math.max(3, Math.min((peOi / maxOi) * maxBarW, maxBarW));
      oiCtx.globalAlpha = 0.80;
      oiCtx.fillStyle   = '#ef5350';
      oiCtx.fillRect(right - bw, y, bw, barH / 2);
    }
  }
  oiCtx.globalAlpha = 1;

  // Draw drag handle — thin vertical line at the left edge of OI bars
  const handleX = w - priceScaleW - maxBarW;
  oiCtx.strokeStyle = 'rgba(150,150,180,0.5)';
  oiCtx.lineWidth   = 2;
  oiCtx.setLineDash([4, 4]);
  oiCtx.beginPath();
  oiCtx.moveTo(handleX, 20);
  oiCtx.lineTo(handleX, h - 40);
  oiCtx.stroke();
  oiCtx.setLineDash([]);
}

function formatExpiry(exp) {
  if (/^\d{8}$/.test(String(exp))) {
    const s = String(exp);
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
    if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' });
  }
  return String(exp);
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  const isDark = theme === 'dark';
  if (tvChart) {
    tvChart.applyOptions({
      layout: {
        background: { color: isDark ? '#0d0f11' : '#ffffff' },
        textColor:  isDark ? '#c9d1d9' : '#131722',
        fontSize:   13,
        fontFamily: "'Inter', 'Segoe UI', sans-serif",
      },
      grid: {
        vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
        horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      },
      crosshair: {
        vertLine: { labelBackgroundColor: isDark ? '#22262b' : '#e8ecf5' },
        horzLine: { labelBackgroundColor: '#2962ff' },
      },
      rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
      timeScale:        { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
    });
  }
  const iconEl = document.getElementById('theme-icon');
  if (iconEl) iconEl.textContent = isDark ? '☀' : '☾';
}

export const ChartModule = { init, loadSymbol, onTick, setTheme, loadOIChain, drawOIProfile, stopCountdown, stopOILoop };
