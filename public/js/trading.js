// ── Paper Trading Module ──────────────────────────────────────────────────────
// Handles order placement, positions, orders, holdings panel + live P&L.

// ── DOM ───────────────────────────────────────────────────────────────────────
const btnChartBuy   = document.getElementById('btn-chart-buy');
const btnChartSell  = document.getElementById('btn-chart-sell');

// Order modal
const orderModal    = document.getElementById('order-modal');
const omSymbol      = document.getElementById('om-symbol');
const omExchange    = document.getElementById('om-exchange');
const omLtp         = document.getElementById('om-ltp');
const omBuyBtn      = document.getElementById('om-buy');
const omSellBtn     = document.getElementById('om-sell');
const omClose       = document.getElementById('om-close');
const omQty         = document.getElementById('om-qty');
const omPrice       = document.getElementById('om-price');
const omTrigger     = document.getElementById('om-trigger');
const omPriceWrap   = document.getElementById('om-price-wrap');
const omTriggerWrap = document.getElementById('om-trigger-wrap');
const omSubmit      = document.getElementById('om-submit');
const omError       = document.getElementById('om-error');
const omInfo        = document.getElementById('om-info');

// Trading panel
const tpToggle       = document.getElementById('tp-toggle');
const tpBody         = document.getElementById('tp-body');
const tpPnl          = document.getElementById('tp-pnl');
const tpPanel        = document.getElementById('trading-panel');
const tpResizeHandle = document.getElementById('tp-resize-handle');
const tpCash     = document.getElementById('tp-cash');
const btnReset   = document.getElementById('btn-paper-reset');
const posTbody   = document.getElementById('pos-tbody');
const ordTbody   = document.getElementById('ord-tbody');

// ── State ─────────────────────────────────────────────────────────────────────
let orderSide    = 'BUY';
let orderType    = 'MKT';
let currentSym   = '';
let currentExch  = 'NSE';
let currentIType = 'STOCK';
let panelOpen    = true;
let refreshTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  // Buy/Sell toolbar buttons
  btnChartBuy?.addEventListener('click', () => openModal('BUY'));
  btnChartSell?.addEventListener('click', () => openModal('SELL'));

  // Modal side toggle
  omBuyBtn?.addEventListener('click', () => setSide('BUY'));
  omSellBtn?.addEventListener('click', () => setSide('SELL'));

  // Order type buttons
  document.querySelectorAll('.otype-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.otype-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setOrderType(btn.dataset.otype);
    });
  });

  // Close modal
  omClose?.addEventListener('click', closeModal);
  orderModal?.addEventListener('click', (e) => {
    if (e.target === orderModal) closeModal();
  });

  // Submit order
  omSubmit?.addEventListener('click', submitOrder);

  // Trading panel tab switching
  document.querySelectorAll('.tp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tp-content').forEach(c => c.classList.add('hidden'));
      const id = `tp-${tab.dataset.tp}`;
      document.getElementById(id)?.classList.remove('hidden');
      if (tab.dataset.tp === 'orders') loadOrders();
    });
  });

  // Panel collapse
  tpToggle?.addEventListener('click', () => {
    panelOpen = !panelOpen;
    tpBody?.classList.toggle('hidden', !panelOpen);
    tpToggle.textContent = panelOpen ? '▼' : '▲';
  });

  // Reset
  btnReset?.addEventListener('click', async () => {
    if (!confirm('Reset paper trading account? All orders and positions will be cleared.')) return;
    await fetch('/api/paper/reset', { method: 'PUT' });
    loadPositions();
    loadOrders();
  });

  // Resize handle drag
  let resizing = false, resizeStartY = 0, resizeStartH = 0;
  const PANEL_MIN = 36, PANEL_MAX = 500;
  const savedH = Number(localStorage.getItem('tp-height')) || 220;
  if (tpPanel) { tpPanel.style.height = `${savedH}px`; tpPanel.style.maxHeight = `${savedH}px`; }

  tpResizeHandle?.addEventListener('mousedown', e => {
    resizing = true;
    resizeStartY = e.clientY;
    resizeStartH = tpPanel?.offsetHeight || 220;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing || !tpPanel) return;
    const dy  = resizeStartY - e.clientY;
    const newH = Math.max(PANEL_MIN, Math.min(PANEL_MAX, resizeStartH + dy));
    tpPanel.style.height    = `${newH}px`;
    tpPanel.style.maxHeight = `${newH}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('tp-height', tpPanel?.offsetHeight || 220);
  });

  // Initial load
  loadPositions();
  loadOrders();

  // Auto-refresh positions every 3s for live P&L
  refreshTimer = setInterval(loadPositions, 3000);
}

// ── Called from chart when symbol loads ───────────────────────────────────────
function setChartSymbol(symbol, exchange, instrumentType) {
  currentSym   = symbol;
  currentExch  = exchange || 'NSE';
  currentIType = instrumentType || 'STOCK';
}

// ── Order modal ───────────────────────────────────────────────────────────────
function openModal(side, symbol, exchange, instrumentType) {
  const sym  = symbol   || currentSym;
  const exch = exchange || currentExch;
  const itype= instrumentType || currentIType;

  if (!sym) { alert('Open a chart first to set the symbol.'); return; }

  omSymbol.textContent  = sym;
  omExchange.textContent= exch;
  currentSym   = sym;
  currentExch  = exch;
  currentIType = itype;

  setSide(side || 'BUY');
  setOrderType('MKT');
  omQty.value = '1';
  omPrice.value = '';
  omTrigger.value = '';
  hideError();

  // Show live price if available
  fetch(`/api/paper/price/${encodeURIComponent(sym)}`)
    .then(r => r.json())
    .then(d => { omLtp.textContent = d.price ? `₹${Number(d.price).toFixed(2)}` : '₹—'; })
    .catch(() => {});

  document.querySelectorAll('.otype-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.otype-btn[data-otype="MKT"]').classList.add('active');

  orderModal.classList.remove('hidden');
  omQty.focus();
}

function closeModal() {
  orderModal.classList.add('hidden');
}

function setSide(side) {
  orderSide = side;
  omBuyBtn.classList.toggle('active', side === 'BUY');
  omSellBtn.classList.toggle('active', side === 'SELL');
  omSubmit.textContent = `Place ${side === 'BUY' ? 'Buy' : 'Sell'} Order`;
  omSubmit.className = `order-submit ${side === 'BUY' ? 'buy' : 'sell'}`;
}

function setOrderType(type) {
  orderType = type;
  omPriceWrap.classList.toggle('hidden', type === 'MKT');
  omTriggerWrap.classList.toggle('hidden', type !== 'SL');
  const info = type === 'MKT' ? 'Market order executes at live price instantly'
    : type === 'LMT' ? 'Limit order executes when price reaches your target'
    : 'Stop-loss order triggers at the specified price';
  omInfo.textContent = info;
}

async function submitOrder() {
  hideError();
  const qty   = Number(omQty.value);
  const price = orderType !== 'MKT' ? Number(omPrice.value) : 0;
  const trigger = orderType === 'SL' ? Number(omTrigger.value) : 0;

  if (!qty || qty <= 0)                       return showError('Enter a valid quantity.');
  if (orderType === 'LMT' && !price)          return showError('Enter limit price.');
  if (orderType === 'SL'  && !trigger)        return showError('Enter trigger price.');

  omSubmit.disabled = true;
  omSubmit.textContent = 'Placing…';

  try {
    const res  = await fetch('/api/paper/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: currentSym, exchange: currentExch, instrumentType: currentIType,
        side: orderSide, orderType, qty, price, triggerPrice: trigger,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    closeModal();
    loadPositions();
    loadOrders();
  } catch (err) {
    showError(err.message);
  } finally {
    omSubmit.disabled = false;
    setSide(orderSide);
  }
}

function showError(msg) { omError.textContent = msg; omError.classList.remove('hidden'); }
function hideError()    { omError.classList.add('hidden'); }

// ── Positions ──────────────────────────────────────────────────────────────────
async function loadPositions() {
  try {
    const res  = await fetch('/api/paper/positions');
    const data = await res.json();
    renderPositions(data.positions || []);
    renderCash(data.cash);
  } catch { /* ignore refresh failures */ }
}

function renderPositions(positions) {
  if (!positions.length) {
    posTbody.innerHTML = '<tr class="tp-empty"><td colspan="8">No open positions</td></tr>';
    tpPnl.textContent  = '₹0.00';
    tpPnl.className    = 'tp-pnl-val';
    return;
  }

  const totalPnl = positions.reduce((s, p) => s + p.totalPnl, 0);
  tpPnl.textContent  = `${totalPnl >= 0 ? '+' : ''}₹${Math.abs(totalPnl).toFixed(2)}`;
  tpPnl.className    = `tp-pnl-val ${totalPnl >= 0 ? 'up' : 'down'}`;

  posTbody.innerHTML = positions.map(p => {
    const upR = p.realizedPnl >= 0, upU = p.unrealizedPnl >= 0, upT = p.totalPnl >= 0;
    return `<tr>
      <td class="sym-cell" title="Click to view chart" data-sym="${p.symbol}" data-exch="${p.exchange}" style="cursor:pointer">${p.symbol}</td>
      <td>${p.exchange}</td>
      <td class="${p.netQty >= 0 ? 'up' : 'down'}">${p.netQty}</td>
      <td>₹${fmtP(p.avgBuyPrice)}</td>
      <td>₹${fmtP(p.ltp)}</td>
      <td class="${upU ? 'up' : 'down'}">${upU?'+':''}₹${fmtP(Math.abs(p.unrealizedPnl))}</td>
      <td class="${upR ? 'up' : 'down'}">${upR?'+':''}₹${fmtP(Math.abs(p.realizedPnl))}</td>
      <td>
        <button class="tp-action-btn" onclick="window._tp.openModal('BUY','${p.symbol}','${p.exchange}')">B</button>
        <button class="tp-action-btn sell" onclick="window._tp.openModal('SELL','${p.symbol}','${p.exchange}')">S</button>
      </td>
    </tr>`;
  }).join('');

  // Click symbol → view chart
  posTbody.querySelectorAll('.sym-cell').forEach(td => {
    td.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('load-chart', { detail: { instrument: {
        stock_name: td.dataset.sym, nubra_name: td.dataset.sym,
        exchange: td.dataset.exch, asset_type: 'STOCK',
      }}}));
    });
  });
}

function renderCash(cash) {
  if (cash == null) return;
  tpCash.textContent = `₹${Number(cash).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function loadOrders() {
  try {
    const res  = await fetch('/api/paper/orders');
    const data = await res.json();
    renderOrders(data.orders || []);
  } catch { }
}

function renderOrders(orders) {
  if (!orders.length) {
    ordTbody.innerHTML = '<tr class="tp-empty"><td colspan="9">No orders placed</td></tr>';
    return;
  }
  ordTbody.innerHTML = orders.map(o => {
    const statusCls = o.status === 'EXECUTED' ? 'status-exec'
      : o.status === 'CANCELLED' ? 'status-cancel' : 'status-pending';
    const canCancel = o.status === 'PENDING';
    const timeStr   = new Date(o.createdAt).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    return `<tr>
      <td>${o.symbol}</td>
      <td class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side}</td>
      <td>${o.qty}</td>
      <td>${o.orderType}</td>
      <td>${o.price ? '₹'+fmtP(o.price) : 'MKT'}</td>
      <td>${o.executedPrice ? '₹'+fmtP(o.executedPrice) : '—'}</td>
      <td class="${statusCls}">${o.status}</td>
      <td>${timeStr}</td>
      <td>${canCancel
        ? `<button class="tp-action-btn sell" onclick="window._tp.cancelOrder('${o.id}')">Cancel</button>`
        : '—'}</td>
    </tr>`;
  }).join('');
}

async function cancelOrder(id) {
  if (!confirm('Cancel this order?')) return;
  await fetch(`/api/paper/order/${id}`, { method: 'DELETE' });
  loadOrders();
  loadPositions();
}

// ── WebSocket live updates ─────────────────────────────────────────────────────
function onPaperUpdate() {
  loadPositions();
  loadOrders();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtP(v) { return Number(v || 0).toFixed(2); }

// Expose actions to inline onclick handlers (can't use modules there)
window._tp = { openModal, cancelOrder };

export const TradingModule = { init, setChartSymbol, openModal, onPaperUpdate };
