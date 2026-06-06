// Option Chain — live feed via WebSocket + REST fallback
import { subscribeOC, unsubscribeOC } from './app.js';

// ── DOM ──────────────────────────────────────────────────────────────────────
const symbolInput  = document.getElementById('oc-symbol-input');
const exchangeSel  = document.getElementById('oc-exchange');
const expirySel    = document.getElementById('oc-expiry');
const btnLoad      = document.getElementById('btn-load-oc');
const tbody        = document.getElementById('oc-tbody');
const spotEl       = document.getElementById('oc-spot');
const suggestionsEl= document.getElementById('oc-suggestions');

let currentSymbol   = '';
let currentExchange = 'NSE';
let currentExpiry   = '';
let maxCeOi = 1, maxPeOi = 1;

// ref_id → nubra_name: built once from refdata when chain loads
const refIdMap = new Map();

// Cell map for incremental live updates: "23950-ce-ltp" → TD element
const cellMap  = new Map();
let pollTimer  = null;

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  btnLoad.addEventListener('click', doLoad);

  expirySel.addEventListener('change', () => {
    currentExpiry = expirySel.value;
    if (currentSymbol) loadChain(currentExpiry);
  });

  symbolInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLoad();
    if (e.key === 'Escape') hideSuggestions();
  });

  // Search suggestions while typing
  let sugTimer = null;
  symbolInput.addEventListener('input', () => {
    clearTimeout(sugTimer);
    const q = symbolInput.value.trim();
    if (q.length < 1) { hideSuggestions(); return; }
    sugTimer = setTimeout(() => fetchSuggestions(q), 200);
  });

  symbolInput.addEventListener('focus', () => {
    const q = symbolInput.value.trim();
    if (q.length >= 1) fetchSuggestions(q);
  });

  document.addEventListener('click', (e) => {
    if (!symbolInput.contains(e.target) && !suggestionsEl?.contains(e.target)) hideSuggestions();
  });

  // Quick-pick buttons
  document.querySelectorAll('.oc-quick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.oc-quick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSymbol   = btn.dataset.sym;
      currentExchange = btn.dataset.exch;
      currentExpiry   = '';
      symbolInput.value  = currentSymbol;
      exchangeSel.value  = currentExchange;
      doLoad();
    });
  });
}

function doLoad() {
  const sym = symbolInput.value.trim().toUpperCase();
  if (!sym) return;
  currentSymbol   = sym;
  currentExchange = exchangeSel.value;
  currentExpiry   = '';
  hideSuggestions();
  loadExpiryThenChain();
}

// ── Search suggestions ────────────────────────────────────────────────────────
async function fetchSuggestions(q) {
  try {
    const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=10`);
    const data = await res.json();
    // Show only underlyings (not individual option contracts)
    const items = (data.results || []).filter((item) => {
      const dt = (item.derivative_type || '').toUpperCase();
      return dt !== 'OPT'; // skip option contracts, show stocks/indices/futures
    }).slice(0, 8);
    renderSuggestions(items);
  } catch { hideSuggestions(); }
}

function renderSuggestions(items) {
  if (!suggestionsEl) return;
  if (!items.length) { hideSuggestions(); return; }
  suggestionsEl.innerHTML = '';
  items.forEach((item) => {
    const name = item.stock_name || item.asset || item.nubra_name || '';
    const exch = (item.exchange || 'NSE').toUpperCase();
    const div  = document.createElement('div');
    div.className = 'oc-sug-item';
    div.innerHTML = `<span class="oc-sug-name">${name}</span><span class="oc-sug-exch">${exch}</span>`;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault();
      symbolInput.value  = name.toUpperCase();
      exchangeSel.value  = exch;
      currentSymbol   = name.toUpperCase();
      currentExchange = exch;
      hideSuggestions();
      doLoad();
    });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.classList.add('open');
}

function hideSuggestions() {
  suggestionsEl?.classList.remove('open');
}

// ── Load from search ──────────────────────────────────────────────────────────
function loadFromInstrument(item) {
  const sym = item.nubra_name || item.stock_name || item.asset || '';
  symbolInput.value  = sym.toUpperCase();
  exchangeSel.value  = item.exchange || 'NSE';
  currentSymbol   = sym.toUpperCase();
  currentExchange = item.exchange || 'NSE';
  currentExpiry   = '';
  loadExpiryThenChain();
}

// ── Refdata ref_id → nubra_name map ──────────────────────────────────────────
// Loaded once per session (or per exchange change). Gives us exact instrument
// names so we never have to guess weekly vs monthly naming conventions.
let refdataLoaded = false;

// Preload both NSE and BSE refdata so ref_id → stock_name map is ready before any clicks.
// stock_name is the trading symbol (e.g. "NIFTY26JUN0223600CE") that the historical API accepts.
// nubra_name/zanskar_name is the internal DB id (e.g. "OPT_NIFTY_20260602_CE_2360000") — NOT usable for charts.
async function ensureRefdata(exchange) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res   = await fetch(`/api/refdata/${today}?exchange=${exchange}`);
    const data  = await res.json();
    const rows  = Array.isArray(data.refdata) ? data.refdata :
                  Array.isArray(data.data)    ? data.data    :
                  Array.isArray(data)         ? data         : [];

    let count = 0;
    for (const row of rows) {
      const id        = row.ref_id ?? row.zanskar_id;
      // Use stock_name (trading symbol) — NOT zanskar_name/nubra_name (internal id)
      const stockName = row.stock_name;
      if (id != null && stockName) {
        refIdMap.set(Number(id), stockName);
        count++;
      }
    }
    console.log(`[Refdata ${exchange}] ${count} instruments mapped`);
  } catch (err) {
    console.warn(`[Refdata ${exchange}] load failed:`, err.message);
  }
}

// Call this at app startup to preload refdata for both exchanges
export async function preloadRefdata() {
  refdataLoaded = true; // mark before awaiting so concurrent calls don't double-load
  await Promise.all([ensureRefdata('NSE'), ensureRefdata('BSE')]);
}

// ── Live feed management ──────────────────────────────────────────────────────
function startLiveFeed() {
  stopLiveFeed();
  // Subscribe via WS
  if (currentSymbol && currentExpiry) {
    subscribeOC(currentSymbol, currentExpiry, currentExchange);
  }
  // Fallback polling every 3s in case WS doesn't deliver
  pollTimer = setInterval(async () => {
    if (!currentSymbol || !currentExpiry) return;
    try {
      const data  = await fetchChainApi(currentSymbol, currentExchange, currentExpiry);
      updateChainCells(data.chain || {});
    } catch { /* ignore poll errors */ }
  }, 3000);
}

function stopLiveFeed() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (currentSymbol && currentExpiry) {
    unsubscribeOC(currentSymbol, currentExpiry, currentExchange);
  }
}

// Called by app.js when WS delivers a live option chain update
function onWsTick(data) {
  if (!data) return;
  const asset  = (data.asset  || '').toUpperCase();
  const expiry = data.expiry  || '';
  if (asset !== currentSymbol || expiry !== currentExpiry) return;
  updateChainCells(data);
}

// ── Incremental cell update (no full re-render = no flicker) ─────────────────
function updateChainCells(chain) {
  const ceList = chain.ce || [];
  const peList = chain.pe || [];
  const cpPaise = chain.cp ?? chain.currentprice ?? null;
  if (cpPaise != null) {
    spotEl.innerHTML = `Spot: <span>₹${fmtPrice(Number(cpPaise) / 100)}</span>`;
  }

  const peByStrike = {};
  for (const pe of peList) peByStrike[strikRs(pe)] = pe;

  for (const ce of ceList) {
    const sp  = strikRs(ce);
    const ceIv = g(ce,'iv');
    const peIv = g(peByStrike[sp], 'iv');
    updateCell(`${sp}-ce-ltp`,    fmtLtpCell(ce, 'ce'));
    updateCell(`${sp}-ce-oi`,     fmtLakhVal(g(ce,'oi')));
    updateCell(`${sp}-ce-vol`,    fmtLakhVal(g(ce,'volume')));
    updateCell(`${sp}-ce-iv`,     fmtIvVal(ceIv ?? peIv));
    updateCell(`${sp}-ce-delta`,  fmtDecVal(g(ce,'delta'), 4));
    updateCell(`${sp}-ce-gamma`,  fmtDecVal(g(ce,'gamma'), 4));
    updateCell(`${sp}-ce-theta`,  fmtDecVal(g(ce,'theta'), 2));
    updateCell(`${sp}-ce-vega`,   fmtDecVal(g(ce,'vega'), 4));
  }
  for (const pe of peList) {
    const sp = strikRs(pe);
    updateCell(`${sp}-pe-ltp`,    fmtLtpCell(pe, 'pe'));
    updateCell(`${sp}-pe-oi`,     fmtLakhVal(g(pe,'oi')));
    updateCell(`${sp}-pe-vol`,    fmtLakhVal(g(pe,'volume')));
    updateCell(`${sp}-pe-delta`,  fmtDecVal(g(pe,'delta'), 4));
    updateCell(`${sp}-pe-gamma`,  fmtDecVal(g(pe,'gamma'), 4));
    updateCell(`${sp}-pe-theta`,  fmtDecVal(g(pe,'theta'), 2));
    updateCell(`${sp}-pe-vega`,   fmtDecVal(g(pe,'vega'), 4));
  }
}

function fmtLtpCell(row, side) {
  const ltp = g(row,'ltp');
  if (ltp == null) return '—';
  const price = Number(ltp) / 100;
  const chg   = g(row,'ltpchg');
  const up    = chg == null ? true : Number(chg) >= 0;
  const pct   = chg != null ? `<div class="ltp-chg ${up?'up':'down'}">${up?'+':''}${Number(chg).toFixed(2)}%</div>` : '';
  return `₹${fmtPrice(price)}${pct}`;
}

function fmtLakhVal(v)     { return v == null ? '—' : fmtLakh(Number(v)); }
function fmtDecVal(v, dp)  { return v == null ? '—' : Number(v).toFixed(dp); }
function fmtIvVal(v)       { return v == null ? '—' : (Number(v) * 100).toFixed(2); }

function updateCell(key, html) {
  const td = cellMap.get(key);
  if (td && td.innerHTML !== html) td.innerHTML = html;
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function loadExpiryThenChain() {
  stopLiveFeed();
  cellMap.clear();
  setMessage('Loading…');
  spotEl.innerHTML = '';

  try {
    // First call with no expiry to get all_expiries list
    const data  = await fetchChainApi(currentSymbol, currentExchange, '');
    const chain = data.chain || {};
    const expiries = chain.all_expiries || [];

    expirySel.innerHTML = '';
    expiries.forEach((exp) => {
      const opt = document.createElement('option');
      opt.value = exp;
      opt.textContent = formatExpiry(exp);
      expirySel.appendChild(opt);
    });
    if (expiries.length) {
      currentExpiry = expiries[0];
      expirySel.value = currentExpiry;
    }

    // Second call with explicit expiry so table data matches dropdown
    const data2 = await fetchChainApi(currentSymbol, currentExchange, currentExpiry);
    renderChain(data2.chain || {});
    startLiveFeed();
  } catch (err) {
    setMessage(`Error: ${err.message}`);
    console.error(err);
  }
}

async function loadChain(expiry) {
  stopLiveFeed();
  cellMap.clear();
  setMessage('Loading…');
  try {
    const data = await fetchChainApi(currentSymbol, currentExchange, expiry);
    renderChain(data.chain || {});
    startLiveFeed();
  } catch (err) {
    setMessage(`Error: ${err.message}`);
  }
}

async function fetchChainApi(symbol, exchange, expiry) {
  const params = new URLSearchParams({ exchange });
  if (expiry) params.set('expiry', expiry);
  const res  = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${params}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderChain(chain) {
  const ceList = chain.ce || [];
  const peList = chain.pe || [];
  if (!ceList.length && !peList.length) { setMessage('No data for this expiry.'); return; }

  const atmPaise = chain.atm ?? chain.at_the_money_strike ?? null;
  const cpPaise  = chain.cp  ?? chain.current_price       ?? null;
  const atmRs    = atmPaise != null ? atmPaise / 100 : null;
  const cpRs     = cpPaise  != null ? cpPaise  / 100 : null;
  const refPrice = cpRs ?? atmRs;

  if (cpRs != null) {
    spotEl.innerHTML = `Spot: <span>₹${fmtPrice(cpRs)}</span>`;
  }

  // Build strike map
  const map = {};
  for (const ce of ceList) {
    const sp = strikRs(ce);
    if (!map[sp]) map[sp] = { ce: null, pe: null };
    map[sp].ce = ce;
  }
  for (const pe of peList) {
    const sp = strikRs(pe);
    if (!map[sp]) map[sp] = { ce: null, pe: null };
    map[sp].pe = pe;
  }

  const strikes = Object.keys(map).map(Number).sort((a, b) => a - b);

  // ATM strike
  const atm = refPrice != null
    ? strikes.reduce((b, s) => Math.abs(s - refPrice) < Math.abs(b - refPrice) ? s : b, strikes[0])
    : (atmRs ? strikes.reduce((b, s) => Math.abs(s - atmRs) < Math.abs(b - atmRs) ? s : b, strikes[0]) : null);

  // Max OI for progress bars
  maxCeOi = Math.max(1, ...ceList.map(c => g(c, 'oi') || 0));
  maxPeOi = Math.max(1, ...peList.map(p => g(p, 'oi') || 0));

  const fragment = document.createDocumentFragment();
  strikes.forEach((strike) => {
    const { ce, pe } = map[strike];
    const isAtm = strike === atm;
    const tr = document.createElement('tr');
    tr.className = isAtm ? 'atm-row' : '';
    tr.setAttribute('data-strike', strike);
    // Store ref_ids so the click handler can look up exact nubra_name
    if (ce?.ref_id) tr.setAttribute('data-ce-refid', ce.ref_id);
    if (pe?.ref_id) tr.setAttribute('data-pe-refid', pe.ref_id);

    tr.innerHTML =
      ceGreek(g(ce,'vega'),  4)   +
      ceGreek(g(ce,'gamma'), 4)   +
      ceGreek(g(ce,'theta'), 2)   +
      ceGreek(g(ce,'delta'), 4)   +
      ceOiVol(g(ce,'oi'),    maxCeOi, 'ce') +
      ceOiVol(g(ce,'volume'), 0,  'ce-vol') +
      ceLtp(ce) +
      `<td class="strike-cell">${isAtm ? `<div class="atm-label">ATM</div>` : ''}${fmtNum(strike)}</td>` +
      `<td class="iv-cell">${(() => { const iv = g(ce,'iv') ?? g(pe,'iv'); return iv != null ? (Number(iv) * 100).toFixed(2) : '—'; })()}</td>` +
      peLtp(pe) +
      peOiVol(g(pe,'volume'), 0,  'pe-vol') +
      peOiVol(g(pe,'oi'),    maxPeOi, 'pe') +
      peGreek(g(pe,'delta'), 4)   +
      peGreek(g(pe,'theta'), 2)   +
      peGreek(g(pe,'gamma'), 4)   +
      peGreek(g(pe,'vega'),  4);

    // Register live-update cells in cellMap
    const tds = tr.querySelectorAll('td');
    // Column order: vega gamma theta delta oi vol ltp | strike iv | ltp vol oi delta theta gamma vega
    const colKeys = [
      `${strike}-ce-vega`,`${strike}-ce-gamma`,`${strike}-ce-theta`,`${strike}-ce-delta`,
      `${strike}-ce-oi`,`${strike}-ce-vol`,`${strike}-ce-ltp`,
      null, `${strike}-ce-iv`, // strike + iv
      `${strike}-pe-ltp`,`${strike}-pe-vol`,`${strike}-pe-oi`,
      `${strike}-pe-delta`,`${strike}-pe-theta`,`${strike}-pe-gamma`,`${strike}-pe-vega`,
    ];
    tds.forEach((td, i) => { if (colKeys[i]) cellMap.set(colKeys[i], td); });

    tr.addEventListener('click', (e) => {
      // B/S buttons in LTP cells open order modal with the LTP pre-filled
      const ocBtn = e.target.closest('.oc-ob');
      if (ocBtn) {
        e.stopPropagation();
        const refId  = Number(ocBtn.dataset.refid);
        const price  = Number(ocBtn.dataset.price);
        const side   = ocBtn.dataset.side;
        const optType= ocBtn.closest('td')?.classList.contains('ce-side') ? 'CE' : 'PE';
        const sym = refIdMap.has(refId) ? refIdMap.get(refId)
          : `${currentSymbol}${optType}${strike}`;
        window._tp?.openModal(side, sym, currentExchange, 'OPT', undefined, price);
        return;
      }

      const td  = e.target.closest('td');
      if (!td) return;
      const tds = [...tr.querySelectorAll('td')];
      const idx = tds.indexOf(td);
      if (idx < 7) {
        const ceRefId = Number(tr.getAttribute('data-ce-refid'));
        navigateToOptionChart(currentSymbol, strike, 'CE', ceRefId);
      } else if (idx > 8) {
        const peRefId = Number(tr.getAttribute('data-pe-refid'));
        navigateToOptionChart(currentSymbol, strike, 'PE', peRefId);
      }
    });

    fragment.appendChild(tr);
  });

  tbody.innerHTML = '';
  tbody.appendChild(fragment);

  // Scroll ATM into view
  if (atm) {
    setTimeout(() => {
      const atmRow = tbody.querySelector('.atm-row');
      if (atmRow) atmRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 100);
  }
}

// ── Navigate to chart for an option ──────────────────────────────────────────
// Uses ref_id → refdata map (loaded at chain load time) for exact nubra_name.
// This correctly handles weekly vs monthly naming conventions.
function navigateToOptionChart(underlying, strikeRs, optType, refId) {
  const strike = Math.round(strikeRs);

  // 1. Best: exact lookup from refdata map via ref_id
  if (refId && refIdMap.has(refId)) {
    const nubraName = refIdMap.get(refId);
    console.log('[OC→chart refId]', refId, '→', nubraName);
    dispatch(nubraName);
    return;
  }

  // 2. Refdata still loading — wait then retry
  if (refId && !refdataLoaded) {
    console.log('[OC→chart] Waiting for refdata…');
    ensureRefdata(currentExchange).then(() => {
      navigateToOptionChart(underlying, strikeRs, optType, refId);
    });
    return;
  }

  // 3. Last resort: construct name (correct for monthly, may be wrong for weekly)
  const expStr = currentExpiry || '';
  const yr  = expStr.slice(2, 4);
  const mo  = expStr.length >= 6 ? MONTHS[parseInt(expStr.slice(4, 6)) - 1] : '';
  const nubraName = `${underlying}${yr}${mo}${strike}${optType}`;
  console.warn('[OC→chart fallback]', nubraName, '— ref_id not in refdata');
  dispatch(nubraName);

  function dispatch(name) {
    // Use stock_name for both fields — chart.js picks nubra_name first for the query
    // stock_name IS the correct query value (e.g. "NIFTY26JUN0223600CE")
    document.dispatchEvent(new CustomEvent('load-chart', { detail: { instrument: {
      stock_name:      name,
      nubra_name:      name,
      asset:           currentSymbol,
      exchange:        currentExchange,
      derivative_type: 'OPT',
      asset_type:      'OPT',
    }}}));
  }
}

// ── Cell builders ─────────────────────────────────────────────────────────────
function ceLtp(row) {
  if (!row) return '<td class="ce-side ltp-cell">—</td>';
  const ltp = g(row,'ltp');
  const chg = g(row,'ltpchg');
  if (ltp == null) return '<td class="ce-side ltp-cell">—</td>';
  const price = ltp / 100;
  const up    = chg == null ? true : chg >= 0;
  const pct   = chg != null ? `<div class="ltp-chg ${up?'up':'down'}">${up?'+':''}${Number(chg).toFixed(2)}%</div>` : '';
  const refid = row.ref_id || '';
  return `<td class="ce-side ltp-cell ${up?'up':'down'}" title="Click to chart | B/S to order">
    <div class="ltp-val">₹${fmtPrice(price)}${pct}</div>
    <div class="oc-order-btns">
      <button class="oc-ob buy" data-refid="${refid}" data-price="${price}" data-side="BUY">B</button>
      <button class="oc-ob sell" data-refid="${refid}" data-price="${price}" data-side="SELL">S</button>
    </div>
  </td>`;
}

function peLtp(row) {
  if (!row) return '<td class="pe-side ltp-cell">—</td>';
  const ltp = g(row,'ltp');
  const chg = g(row,'ltpchg');
  if (ltp == null) return '<td class="pe-side ltp-cell">—</td>';
  const price = ltp / 100;
  const up    = chg == null ? true : chg >= 0;
  const pct   = chg != null ? `<div class="ltp-chg ${up?'up':'down'}">${up?'+':''}${Number(chg).toFixed(2)}%</div>` : '';
  const refid = row.ref_id || '';
  return `<td class="pe-side ltp-cell ${up?'up':'down'}" title="Click to chart | B/S to order">
    <div class="ltp-val">₹${fmtPrice(price)}${pct}</div>
    <div class="oc-order-btns">
      <button class="oc-ob buy" data-refid="${refid}" data-price="${price}" data-side="BUY">B</button>
      <button class="oc-ob sell" data-refid="${refid}" data-price="${price}" data-side="SELL">S</button>
    </div>
  </td>`;
}

function ceOiVol(val, maxVal, cls) {
  if (val == null) return `<td class="ce-side">—</td>`;
  const pct  = maxVal > 0 ? Math.min(100, (val / maxVal) * 100) : 0;
  const bar  = cls === 'ce-vol' ? '' :
    `<div class="oi-bar-wrap"><div class="oi-bar oi-bar-ce" style="width:${pct.toFixed(0)}%"></div></div>`;
  return `<td class="ce-side">${fmtLakh(val)}${bar}</td>`;
}

function peOiVol(val, maxVal, cls) {
  if (val == null) return `<td class="pe-side">—</td>`;
  const pct  = maxVal > 0 ? Math.min(100, (val / maxVal) * 100) : 0;
  const bar  = cls === 'pe-vol' ? '' :
    `<div class="oi-bar-wrap"><div class="oi-bar oi-bar-pe" style="width:${pct.toFixed(0)}%"></div></div>`;
  return `<td class="pe-side">${fmtLakh(val)}${bar}</td>`;
}

function ceGreek(val, dp) {
  if (val == null) return '<td class="ce-side">—</td>';
  return `<td class="ce-side">${Number(val).toFixed(dp)}</td>`;
}

function peGreek(val, dp) {
  if (val == null) return '<td class="pe-side">—</td>';
  return `<td class="pe-side">${Number(val).toFixed(dp)}</td>`;
}

// ── Field helpers ─────────────────────────────────────────────────────────────
function g(row, field) {
  if (!row) return null;
  const aliases = {
    ltp:    ['ltp','last_traded_price'],
    ltpchg: ['ltpchg','last_traded_price_change'],
    oi:     ['oi','open_interest'],
    prev_oi:['prev_oi','previous_open_interest'],
    volume: ['volume'],
    iv:     ['iv'],
    delta:  ['delta'], gamma: ['gamma'],
    theta:  ['theta'], vega:  ['vega'],
  };
  for (const k of (aliases[field] || [field])) {
    if (row[k] !== undefined && row[k] !== null) return row[k];
  }
  return null;
}

function strikRs(row) {
  const raw = row.sp ?? row.strike_price;
  if (raw == null) return 0;
  return raw > 10000 ? raw / 100 : raw;
}

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtPrice(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-IN');
}

function fmtLakh(v) {
  if (v == null || v === 0) return '—';
  const n = Number(v);
  if (n >= 1e7)  return (n/1e7).toFixed(2) + 'Cr';
  if (n >= 1e5)  return (n/1e5).toFixed(2) + 'L';
  if (n >= 1000) return (n/1000).toFixed(1) + 'K';
  return n.toString();
}

function formatExpiry(exp) {
  if (/^\d{8}$/.test(String(exp))) {
    const s = String(exp);
    const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`);
    if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' });
  }
  try { const d = new Date(exp); if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' }); } catch {}
  return String(exp);
}

function setMessage(msg) {
  tbody.innerHTML = `<tr><td colspan="16" class="center" style="color:var(--text-muted);padding:32px;font-size:14px">${msg}</td></tr>`;
}

export const OptionChainModule = { init, loadFromInstrument, onWsTick, preloadRefdata };
