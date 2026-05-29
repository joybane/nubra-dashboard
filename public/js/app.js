import { ChartModule } from './chart.js';
import { OptionChainModule } from './optionchain.js';
import { TradingModule } from './trading.js';
import { WatchlistModule } from './watchlist.js';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  currentView: 'chart',
  ws: null,
  wsReady: false,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const loginOverlay  = document.getElementById('login-overlay');
const step1         = document.getElementById('login-step-1');
const step2         = document.getElementById('login-step-2');
const step3         = document.getElementById('login-step-3');
const loginStatus   = document.getElementById('login-status');
const btnSendOtp    = document.getElementById('btn-send-otp');
const btnVerifyOtp  = document.getElementById('btn-verify-otp');
const otpInput      = document.getElementById('otp-input');
const wsDot         = document.getElementById('ws-dot');
const searchInput   = document.getElementById('search-input');
const searchDropdown= document.getElementById('search-dropdown');

// ── Show login status ─────────────────────────────────────────────────────────
function setLoginStatus(msg, type = 'info') {
  loginStatus.textContent = msg;
  loginStatus.className = `login-status ${type}`;
}

function setLoginStep(n) {
  step1.classList.toggle('active', n === 1);
  step2.classList.toggle('active', n === 2);
  step3.classList.toggle('active', n === 3);
}

// ── Auth flow ─────────────────────────────────────────────────────────────────
async function checkAuthAndInit() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (data.authenticated) {
      hideLogin();
      initApp();
    }
    // else: overlay stays visible
  } catch {
    // server may not be ready yet
  }
}

btnSendOtp.addEventListener('click', async () => {
  btnSendOtp.disabled = true;
  setLoginStatus('Sending OTP…', 'info');
  try {
    const res = await fetch('/auth/send-otp', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    setLoginStatus(data.message, 'success');
    setLoginStep(2);
    setTimeout(() => otpInput.focus(), 100);
  } catch (err) {
    setLoginStatus(err.message, 'error');
    btnSendOtp.disabled = false;
  }
});

btnVerifyOtp.addEventListener('click', async () => {
  const otp = otpInput.value.trim();
  if (!otp) { setLoginStatus('Enter the OTP first.', 'error'); return; }
  btnVerifyOtp.disabled = true;
  setLoginStatus('Verifying OTP…', 'info');
  try {
    const res = await fetch('/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otp }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    setLoginStatus('OTP verified. Verifying MPIN…', 'success');
    setLoginStep(3);
    await verifyMpin();
  } catch (err) {
    setLoginStatus(err.message, 'error');
    btnVerifyOtp.disabled = false;
  }
});

otpInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnVerifyOtp.click();
});

async function verifyMpin() {
  try {
    const res = await fetch('/auth/verify-pin', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    setLoginStatus('Authenticated!', 'success');
    setTimeout(() => { hideLogin(); initApp(); }, 600);
  } catch (err) {
    setLoginStatus(err.message, 'error');
    setLoginStep(2);
    btnVerifyOtp.disabled = false;
  }
}

function hideLogin() {
  loginOverlay.style.display = 'none';
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsReady = true;
  });

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleWsMessage(msg);
    } catch { /* ignore malformed */ }
  });

  ws.addEventListener('close', () => {
    state.wsReady = false;
    setWsDot(false);
    setTimeout(connectWs, 3000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function handleWsMessage(msg) {
  if (msg.type === 'ws_status') {
    setWsDot(msg.connected);
    return;
  }
  if (msg.type === 'auth_status') {
    return;
  }
  if (msg.type === 'ohlcv' || msg.type === 'index_tick') {
    ChartModule.onTick(msg);
    return;
  }
  if (msg.type === 'option_chain') {
    OptionChainModule.onWsTick(msg.data);
    return;
  }
  if (msg.type === 'paper_update') {
    TradingModule.onPaperUpdate();
    return;
  }
}

function setWsDot(connected) {
  wsDot.className = `ws-dot ${connected ? 'connected' : 'disconnected'}`;
  wsDot.title = `WebSocket: ${connected ? 'connected' : 'disconnected'}`;
}

export function subscribe(bucket, payload, interval, exchange = 'NSE') {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ action: 'subscribe', bucket, payload, interval, exchange }));
  }
}

export function subscribeOC(asset, expiry, exchange = 'NSE') {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ action: 'subscribe_oc', asset, expiry, exchange }));
  }
}

export function unsubscribeOC(asset, expiry, exchange = 'NSE') {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ action: 'unsubscribe_oc', asset, expiry, exchange }));
  }
}

export function unsubscribe(bucket, payload, interval, exchange = 'NSE') {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ action: 'unsubscribe', bucket, payload, interval, exchange }));
  }
}

// ── View switching ────────────────────────────────────────────────────────────
const viewChart       = document.getElementById('view-chart');
const viewOptionchain = document.getElementById('view-optionchain');

document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    state.currentView = view;

    if (view === 'chart') {
      viewChart.style.display = 'grid';
      viewOptionchain.style.display = 'none';
      searchInput.placeholder = 'Search symbol…';
    } else {
      viewChart.style.display = 'none';
      viewOptionchain.style.display = 'grid';
      searchInput.placeholder = 'Search F&O symbol…';
    }
  });
});

// ── Instrument search ─────────────────────────────────────────────────────────
let searchTimer   = null;
let allResults    = [];
let activeFilter  = 'All';

// Indices that are NOT in refdata but are fully supported by Nubra APIs
const POPULAR_INDICES = [
  { stock_name: 'NIFTY 50',     nubra_name: 'NIFTY',      exchange: 'NSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'BANKNIFTY',    nubra_name: 'BANKNIFTY',  exchange: 'NSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'FINNIFTY',     nubra_name: 'FINNIFTY',   exchange: 'NSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'MIDCPNIFTY',   nubra_name: 'MIDCPNIFTY', exchange: 'NSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'SENSEX',       nubra_name: 'SENSEX',     exchange: 'BSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'BANKEX',       nubra_name: 'BANKEX',     exchange: 'BSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
  { stock_name: 'INDIA VIX',    nubra_name: 'INDIAVIX',   exchange: 'NSE', asset_type: 'INDEX', derivative_type: 'INDEX' },
];

const FILTER_TABS = [
  { label: 'All',     types: [] },
  { label: 'Equity',  types: ['STOCK'] },
  { label: 'Indices', types: ['INDEX'] },
  { label: 'F&O',     types: ['FUT', 'OPT'] },
  { label: 'ETFs',    types: ['ETF'] },
];

function getItemType(item) {
  // Check both derivative_type and asset_type for INDEX
  const dt = (item.derivative_type || '').toUpperCase();
  const at = (item.asset_type      || '').toUpperCase();
  if (dt === 'INDEX' || at === 'INDEX') return 'INDEX';
  if (dt === 'FUT')  return 'FUT';
  if (dt === 'OPT')  return 'OPT';
  if (at === 'ETF')  return 'ETF';
  return 'STOCK';
}

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim().length < 2) showPopularDropdown();
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { showPopularDropdown(); return; }
  searchTimer = setTimeout(() => doSearch(q), 250);
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDropdown();
  if (e.key === 'ArrowDown') {
    const first = searchDropdown.querySelector('.search-item');
    if (first) first.focus();
  }
});

document.addEventListener('click', (e) => {
  if (!searchInput.contains(e.target) && !searchDropdown.contains(e.target)) closeDropdown();
});

function showPopularDropdown() {
  allResults   = POPULAR_INDICES;
  activeFilter = 'All';
  renderDropdown(true);
}

async function doSearch(q) {
  try {
    const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=50`);
    const data = await res.json();

    // Merge popular indices that match the query first
    const q2     = q.toLowerCase();
    const matched = POPULAR_INDICES.filter((p) =>
      p.stock_name.toLowerCase().includes(q2) ||
      p.nubra_name.toLowerCase().includes(q2)
    );
    allResults = [...matched, ...(data.results || [])];
    renderDropdown();
  } catch {
    closeDropdown();
  }
}

function applyFilter(results) {
  const tab = FILTER_TABS.find((t) => t.label === activeFilter);
  if (!tab || !tab.types.length) return results;
  return results.filter((item) => tab.types.includes(getItemType(item)));
}

function renderDropdown(isPopular = false) {
  const filtered = applyFilter(allResults);
  searchDropdown.innerHTML = '';

  // ── Filter tabs ──
  const tabBar = document.createElement('div');
  tabBar.className = 'search-filter-bar';
  FILTER_TABS.forEach(({ label }) => {
    const btn = document.createElement('button');
    btn.className = `search-filter-btn${label === activeFilter ? ' active' : ''}`;
    btn.textContent = label;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // don't lose focus from input
      activeFilter = label;
      renderDropdown();
    });
    tabBar.appendChild(btn);
  });
  searchDropdown.appendChild(tabBar);

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'search-empty';
    empty.textContent = 'No results';
    searchDropdown.appendChild(empty);
    searchDropdown.classList.add('open');
    return;
  }

  // ── Result rows ──
  filtered.slice(0, 15).forEach((item) => {
    const name   = item.stock_name || item.asset || item.symbol || 'Unknown';
    const nname  = item.zanskar_name || item.nubra_name || '';
    const exch   = (item.exchange || 'NSE').toUpperCase();
    const dtype  = getItemType(item);

    // Badge colour per type
    const badgeClass = {
      STOCK:  'badge-stock',
      INDEX:  'badge-index',
      FUT:    'badge-fut',
      OPT:    'badge-opt',
      ETF:    'badge-etf',
    }[dtype] || 'badge-stock';

    const div = document.createElement('div');
    div.className = 'search-item';
    div.tabIndex  = 0;
    div.innerHTML = `
      <div class="search-item-left">
        <span class="search-item-name">${name}</span>
        <span class="search-exch-badge">${exch}</span>
      </div>
      <div class="search-item-right">
        ${nname && nname !== name ? `<span class="search-item-sub">${nname}</span>` : ''}
        <span class="search-type-badge ${badgeClass}">${dtype}</span>
      </div>
    `;
    div.addEventListener('click', () => selectInstrument(item));
    div.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectInstrument(item); });
    searchDropdown.appendChild(div);
  });

  searchDropdown.classList.add('open');
}

function closeDropdown() {
  searchDropdown.classList.remove('open');
  searchDropdown.innerHTML = '';
  allResults   = [];
  activeFilter = 'All';
}

function selectInstrument(item) {
  closeDropdown();
  searchInput.value = '';

  if (state.currentView === 'chart') {
    ChartModule.loadSymbol(item);
  } else {
    OptionChainModule.loadFromInstrument(item);
  }
}

// ── Navigate from option chain → chart ───────────────────────────────────────
document.addEventListener('load-chart', (e) => {
  // Switch to Chart tab
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.nav-tab[data-view="chart"]').classList.add('active');
  viewChart.style.display       = 'grid';
  viewOptionchain.style.display = 'none';
  state.currentView = 'chart';
  ChartModule.loadSymbol(e.detail.instrument);
});

// ── Theme toggle — persisted to localStorage ──────────────────────────────────
const btnTheme   = document.getElementById('btn-theme');
let currentTheme = localStorage.getItem('nubra-theme') || 'dark';

function applyTheme(theme) {
  currentTheme = theme;
  localStorage.setItem('nubra-theme', theme);
  ChartModule.setTheme(theme);
}

btnTheme?.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// ── Init ──────────────────────────────────────────────────────────────────────
function initApp() {
  connectWs();
  ChartModule.init();
  OptionChainModule.init();
  TradingModule.init();
  WatchlistModule.init();
  applyTheme(currentTheme);

  // Preload refdata (ref_id → stock_name) for NSE + BSE immediately after auth.
  // This runs in the background so it's ready before the user opens the option chain.
  OptionChainModule.preloadRefdata().then(() => {
    console.log('[App] Refdata preloaded — option chain navigation ready.');
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
checkAuthAndInit();
