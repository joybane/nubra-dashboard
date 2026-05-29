// ── Watchlist Module ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'nubra-watchlist-v2';

// ── DOM ───────────────────────────────────────────────────────────────────────
const panel       = document.getElementById('watchlist-panel');
const btnToggle   = document.getElementById('btn-wl-toggle');
const btnClose    = document.getElementById('wl-close');
const wlSearch    = document.getElementById('wl-search');
const wlDropdown  = document.getElementById('wl-search-dropdown');
const wlList      = document.getElementById('wl-list');

// ── State ─────────────────────────────────────────────────────────────────────
let items     = loadItems();   // [{symbol,exchange,instrumentType}]
let prices    = {};            // symbol → {ltp, prev, pct}
let pollTimer = null;
let searchTimer = null;
let panelOpen = false;

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  btnToggle?.addEventListener('click', toggle);
  btnClose?.addEventListener('click', close);

  // Search to add
  wlSearch?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = wlSearch.value.trim();
    if (q.length < 2) { closeDropdown(); return; }
    searchTimer = setTimeout(() => doSearch(q), 250);
  });
  wlSearch?.addEventListener('keydown', e => { if (e.key === 'Escape') closeDropdown(); });
  document.addEventListener('click', e => {
    if (!wlSearch?.contains(e.target) && !wlDropdown?.contains(e.target)) closeDropdown();
  });

  render();
}

// ── Panel toggle ──────────────────────────────────────────────────────────────
function toggle() {
  panelOpen ? close() : open();
}

function open() {
  panelOpen = true;
  panel?.classList.remove('hidden');
  document.getElementById('content-area')?.classList.add('wl-open');
  btnToggle?.classList.add('active');
  startPoll();
}

function close() {
  panelOpen = false;
  panel?.classList.add('hidden');
  document.getElementById('content-area')?.classList.remove('wl-open');
  btnToggle?.classList.remove('active');
  stopPoll();
}

// ── Search to add symbol ──────────────────────────────────────────────────────
async function doSearch(q) {
  try {
    const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=12`);
    const data = await res.json();
    renderDropdown(data.results || []);
  } catch { closeDropdown(); }
}

function renderDropdown(results) {
  if (!results.length) { closeDropdown(); return; }
  wlDropdown.innerHTML = '';
  results.forEach(item => {
    const name  = item.stock_name || item.asset || item.symbol || '—';
    const exch  = (item.exchange || 'NSE').toUpperCase();
    const dtype = (item.derivative_type || item.asset_type || 'STOCK').toUpperCase();
    const div   = document.createElement('div');
    div.className = 'wl-dd-item';
    div.innerHTML = `
      <span class="wl-dd-name">${name}</span>
      <span class="wl-dd-meta">${exch} · ${dtype}</span>
    `;
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      addItem({
        symbol:         item.nubra_name || item.stock_name || name,
        displayName:    name,
        exchange:       exch,
        instrumentType: dtype,
      });
      wlSearch.value = '';
      closeDropdown();
    });
    wlDropdown.appendChild(div);
  });
  wlDropdown.classList.add('open');
}

function closeDropdown() { wlDropdown.classList.remove('open'); wlDropdown.innerHTML = ''; }

// ── Watchlist CRUD ────────────────────────────────────────────────────────────
function addItem(item) {
  if (items.find(i => i.symbol === item.symbol && i.exchange === item.exchange)) return;
  items.push(item);
  saveItems();
  render();
  if (panelOpen) startPoll();
}

function removeItem(symbol, exchange) {
  items = items.filter(i => !(i.symbol === symbol && i.exchange === exchange));
  saveItems();
  render();
}

function loadItems() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveItems() { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }

// ── Render watchlist ──────────────────────────────────────────────────────────
function render() {
  if (!wlList) return;
  if (!items.length) {
    wlList.innerHTML = '<div class="wl-empty">Search above to add symbols to your watchlist</div>';
    return;
  }
  wlList.innerHTML = '';
  items.forEach(item => {
    const p      = prices[item.symbol];
    const ltp    = p?.ltp ?? null;
    const change = p?.change ?? null;
    const pct    = p?.pct   ?? null;
    const up     = change == null ? null : change >= 0;

    const row = document.createElement('div');
    row.className = 'wl-row';
    row.innerHTML = `
      <div class="wl-row-left">
        <div class="wl-row-name">${item.displayName || item.symbol}</div>
        <div class="wl-row-exch">${item.exchange}</div>
      </div>
      <div class="wl-row-right">
        <div class="wl-ltp ${up === null ? '' : up ? 'up' : 'down'}">
          ${ltp != null ? '₹' + ltp.toFixed(2) : '—'}
        </div>
        ${change != null
          ? `<div class="wl-chg ${up ? 'up' : 'down'}">${up?'+':''}${change.toFixed(2)} (${up?'+':''}${pct.toFixed(2)}%)</div>`
          : '<div class="wl-chg">—</div>'}
      </div>
      <div class="wl-row-actions">
        <button class="wl-btn-b" title="Buy">B</button>
        <button class="wl-btn-s" title="Sell">S</button>
        <button class="wl-btn-rm" title="Remove">✕</button>
      </div>
    `;

    // Click row → load chart
    row.addEventListener('click', e => {
      if (e.target.closest('.wl-row-actions')) return;
      document.dispatchEvent(new CustomEvent('load-chart', { detail: { instrument: {
        stock_name: item.symbol, nubra_name: item.symbol,
        exchange: item.exchange, derivative_type: item.instrumentType,
        asset_type: item.instrumentType,
      }}}));
    });

    row.querySelector('.wl-btn-b').addEventListener('click', e => {
      e.stopPropagation();
      window._tp?.openModal('BUY', item.symbol, item.exchange, item.instrumentType);
    });
    row.querySelector('.wl-btn-s').addEventListener('click', e => {
      e.stopPropagation();
      window._tp?.openModal('SELL', item.symbol, item.exchange, item.instrumentType);
    });
    row.querySelector('.wl-btn-rm').addEventListener('click', e => {
      e.stopPropagation();
      removeItem(item.symbol, item.exchange);
    });

    wlList.appendChild(row);
  });
}

// ── Live price polling ────────────────────────────────────────────────────────
function startPoll() {
  stopPoll();
  pollTimer = setInterval(fetchPrices, 2000);
  fetchPrices();
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function fetchPrices() {
  if (!items.length) return;
  const syms = items.map(i => i.symbol).join(',');
  try {
    const res  = await fetch(`/api/paper/prices?symbols=${encodeURIComponent(syms)}`);
    const data = await res.json();
    for (const item of items) {
      const newLtp = data[item.symbol];
      if (newLtp == null) continue;
      const prev = prices[item.symbol]?.ltp ?? newLtp;
      const change = newLtp - prev;
      prices[item.symbol] = { ltp: newLtp, change, pct: prev ? (change / prev) * 100 : 0 };
    }
    render();
  } catch { /* ignore */ }
}

export const WatchlistModule = { init };
