// ── Paper Trading Module — with strategies + P&L tick chart ──────────────────

// ── DOM ───────────────────────────────────────────────────────────────────────
const btnChartBuy    = document.getElementById('btn-chart-buy');
const btnChartSell   = document.getElementById('btn-chart-sell');

// Order modal
const orderModal     = document.getElementById('order-modal');
const omHeader       = document.getElementById('om-header');
const omSymbol       = document.getElementById('om-symbol');
const omExchange     = document.getElementById('om-exchange');
const omLtp          = document.getElementById('om-ltp');
const omLtpChg       = document.getElementById('om-ltp-chg');
const omBuyBtn       = document.getElementById('om-buy');
const omSellBtn      = document.getElementById('om-sell');
const omClose        = document.getElementById('om-close');
const omQty          = document.getElementById('om-qty');
const omQtyLabel     = document.getElementById('om-qty-label');
const omLotInfo      = document.getElementById('om-lot-info');
const omPrice        = document.getElementById('om-price');
const omTrigger      = document.getElementById('om-trigger');
const omPriceWrap    = document.getElementById('om-price-wrap');
const omTriggerWrap  = document.getElementById('om-trigger-wrap');
const omSubmit       = document.getElementById('om-submit');
const omError        = document.getElementById('om-error');
const omInfo         = document.getElementById('om-info');
const omStrategyEl   = document.getElementById('om-strategy');
const omNewStrategy  = document.getElementById('om-new-strategy');
const omMarginLabel  = document.getElementById('om-margin-label');
const omMarginReq    = document.getElementById('om-margin-req');
const omMarginAvail  = document.getElementById('om-margin-avail');

// Trading panel
const tpToggle       = document.getElementById('tp-toggle');
const tpBody         = document.getElementById('tp-body');
const tpPnl          = document.getElementById('tp-pnl');
const tpCash         = document.getElementById('tp-cash');
const btnReset       = document.getElementById('btn-paper-reset');
const ordTbody       = document.getElementById('ord-tbody');
const tpPanel        = document.getElementById('trading-panel');
const tpResizeHandle = document.getElementById('tp-resize-handle');
const stratList      = document.getElementById('strat-list');
const btnNewStrategy = document.getElementById('btn-new-strategy');

// P&L chart modal
const pnlModal       = document.getElementById('pnl-modal');
const pnlClose       = document.getElementById('pnl-close');
const pnlSym         = document.getElementById('pnl-sym');
const pnlSideBadge   = document.getElementById('pnl-side-badge');
const pnlMeta        = document.getElementById('pnl-meta');
const pnlEntry       = document.getElementById('pnl-entry');
const pnlLtp         = document.getElementById('pnl-ltp');
const pnlTotal       = document.getElementById('pnl-total');
const pnlChartEl     = document.getElementById('pnl-chart-container');
const pnlFooter      = document.getElementById('pnl-footer');

// ── State ─────────────────────────────────────────────────────────────────────
let orderSide     = 'BUY';
let orderType     = 'MKT';
let orderProduct  = 'INTRADAY';
let currentSym    = '';
let currentExch   = 'NSE';
let currentIType  = 'STOCK';
let currentLotSize = 1;
let panelOpen     = true;
let refreshTimer  = null;
let strategies    = [];
let expandedStrats= new Set(); // strategy ids currently expanded
let pnlChart      = null;      // TradingView chart instance for P&L

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  btnChartBuy?.addEventListener('click', () => openModal('BUY'));
  btnChartSell?.addEventListener('click', () => openModal('SELL'));

  omBuyBtn?.addEventListener('click', () => setSide('BUY'));
  omSellBtn?.addEventListener('click', () => setSide('SELL'));

  document.querySelectorAll('.otype-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.otype-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setOrderType(btn.dataset.otype);
    });
  });

  document.querySelectorAll('.oprod-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.oprod-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      orderProduct = btn.dataset.prod;
    });
  });

  omQty?.addEventListener('input', () => updateLotInfo());

  omClose?.addEventListener('click', closeModal);
  orderModal?.addEventListener('click', e => { if (e.target === orderModal) closeModal(); });
  omSubmit?.addEventListener('click', submitOrder);
  omNewStrategy?.addEventListener('click', promptNewStrategy);

  // Trading panel tab switching
  document.querySelectorAll('.tp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tp-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tp-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tp-${tab.dataset.tp}`)?.classList.remove('hidden');
      if (tab.dataset.tp === 'orders') loadOrders();
    });
  });

  tpToggle?.addEventListener('click', () => {
    panelOpen = !panelOpen;
    tpBody?.classList.toggle('hidden', !panelOpen);
    tpToggle.textContent = panelOpen ? '▼' : '▲';
  });

  btnReset?.addEventListener('click', async () => {
    if (!confirm('Reset paper trading account? All orders and positions will be cleared.')) return;
    await fetch('/api/paper/reset', { method: 'PUT' });
    loadPositions(); loadOrders();
  });

  btnNewStrategy?.addEventListener('click', promptNewStrategy);

  // Resize handle
  let resizing = false, resizeStartY = 0, resizeStartH = 0;
  const PANEL_MIN = 36, PANEL_MAX = 500;
  const savedH = Number(localStorage.getItem('tp-height')) || 220;
  if (tpPanel) { tpPanel.style.height = `${savedH}px`; tpPanel.style.maxHeight = `${savedH}px`; }

  tpResizeHandle?.addEventListener('mousedown', e => {
    resizing = true; resizeStartY = e.clientY; resizeStartH = tpPanel?.offsetHeight || 220;
    document.body.style.cursor = 'ns-resize'; document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing || !tpPanel) return;
    const newH = Math.max(PANEL_MIN, Math.min(PANEL_MAX, resizeStartH + (resizeStartY - e.clientY)));
    tpPanel.style.height = tpPanel.style.maxHeight = `${newH}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!resizing) return; resizing = false;
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    localStorage.setItem('tp-height', tpPanel?.offsetHeight || 220);
  });

  // P&L modal close
  pnlClose?.addEventListener('click', closePnlModal);
  pnlModal?.addEventListener('click', e => { if (e.target === pnlModal) closePnlModal(); });

  loadStrategies();
  loadPositions();
  loadOrders();
  refreshTimer = setInterval(loadPositions, 3000);
}

// ── Symbol tracking ───────────────────────────────────────────────────────────
function setChartSymbol(symbol, exchange, instrumentType) {
  currentSym   = symbol;
  currentExch  = exchange || 'NSE';
  currentIType = instrumentType || 'STOCK';
}

// ── Strategies ────────────────────────────────────────────────────────────────
async function loadStrategies() {
  try {
    const res  = await fetch('/api/paper/strategies');
    const data = await res.json();
    strategies = data.strategies || [];
    populateStrategyDropdown();
    renderStrategies();
  } catch { }
}

function populateStrategyDropdown() {
  if (!omStrategyEl) return;
  const cur = omStrategyEl.value;
  omStrategyEl.innerHTML = strategies.map(s =>
    `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${s.name}</option>`
  ).join('');
}

async function promptNewStrategy() {
  const name = prompt('Strategy name:');
  if (!name?.trim()) return;
  const res  = await fetch('/api/paper/strategies', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  const data = await res.json();
  if (data.ok) { strategies.push(data.strategy); populateStrategyDropdown(); renderStrategies(); }
}

async function deleteStrategy(id) {
  if (!confirm('Delete this strategy? Orders will move to Default.')) return;
  await fetch(`/api/paper/strategies/${id}`, { method: 'DELETE' });
  strategies = strategies.filter(s => s.id !== id);
  expandedStrats.delete(id);
  loadPositions();
}

// ── Order modal ───────────────────────────────────────────────────────────────
let knownModalPrice = 0; // price passed in from option chain / watchlist

function openModal(side, symbol, exchange, instrumentType, strategyId, ltpHint, lotSize) {
  const sym  = symbol || currentSym;
  if (!sym) { alert('Load a chart or add a symbol to watchlist first.'); return; }

  omSymbol.textContent   = sym;
  omExchange.textContent = exchange || currentExch;
  currentSym    = sym;
  currentExch   = exchange || currentExch;
  currentIType  = instrumentType || currentIType;
  currentLotSize = Number(lotSize) || 1;
  knownModalPrice = ltpHint ? Number(ltpHint) : 0;

  setSide(side || 'BUY');
  setOrderType('MKT');
  omQty.value = '1'; omPrice.value = ''; omTrigger.value = ''; hideError();
  document.querySelectorAll('.otype-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.otype-btn[data-otype="MKT"]').classList.add('active');
  document.querySelectorAll('.oprod-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.oprod-btn[data-prod="INTRADAY"]').classList.add('active');
  orderProduct = 'INTRADAY';

  if (strategyId && omStrategyEl) omStrategyEl.value = strategyId;

  updateLotInfo();

  // Show price: WS cache first, then hint from caller, then fetch (with REST fallback)
  const priceUrl = `/api/paper/price/${encodeURIComponent(sym)}?exchange=${currentExch}&type=${currentIType}`;
  fetch(priceUrl)
    .then(r => r.json())
    .then(d => {
      const p = d.price || knownModalPrice;
      omLtp.textContent = p ? `₹${Number(p).toFixed(2)}` : '—';
      if (p) { knownModalPrice = p; updateMarginDisplay(); }
    })
    .catch(() => {
      if (knownModalPrice) omLtp.textContent = `₹${knownModalPrice.toFixed(2)}`;
    });

  // Show available capital
  fetch('/api/paper/positions')
    .then(r => r.json())
    .then(d => {
      if (omMarginAvail && d.cash != null)
        omMarginAvail.textContent = `₹${Number(d.cash).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    }).catch(() => {});

  orderModal.classList.remove('hidden');
  omQty.focus();
}

function updateLotInfo() {
  const isFnO = ['OPT','FUT'].includes((currentIType || '').toUpperCase());
  if (omQtyLabel) omQtyLabel.textContent = isFnO && currentLotSize > 1 ? 'Lots' : 'Qty';
  if (omLotInfo) {
    omLotInfo.textContent = isFnO && currentLotSize > 1
      ? `× ${currentLotSize} = ${(Number(omQty?.value) || 1) * currentLotSize} shares`
      : '';
  }
  updateMarginDisplay();
}

function updateMarginDisplay() {
  if (!omMarginReq || !knownModalPrice) return;
  const lots = Number(omQty?.value) || 1;
  const qty  = currentLotSize > 1 ? lots * currentLotSize : lots;
  fetch('/api/paper/margin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: currentSym, side: orderSide, qty, price: knownModalPrice,
      instrumentType: currentIType, lotSize: currentLotSize,
    }),
  })
    .then(r => r.json())
    .then(d => {
      if (omMarginLabel) omMarginLabel.textContent = d.label || 'Required Margin';
      if (omMarginReq)   omMarginReq.textContent   = `₹${Number(d.required).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    }).catch(() => {});
}

function closeModal() { orderModal.classList.add('hidden'); }

function setSide(side) {
  orderSide = side;
  const isBuy = side === 'BUY';
  omBuyBtn.classList.toggle('active', isBuy);
  omSellBtn.classList.toggle('active', !isBuy);
  if (omHeader) omHeader.className = `om-header ${isBuy ? 'buy' : 'sell'}`;
  omSubmit.textContent = isBuy ? '▲ Place Buy Order' : '▼ Place Sell Order';
  omSubmit.className   = `om-submit-btn ${isBuy ? 'buy' : 'sell'}`;
  updateMarginDisplay();
}

function setOrderType(type) {
  orderType = type;
  // For new layout: price-wrap row is always shown for LMT/SL
  if (omPriceWrap) omPriceWrap.classList.toggle('hidden', type === 'MKT');
  if (omTriggerWrap) omTriggerWrap.classList.toggle('hidden', type !== 'SL');
  if (omInfo) omInfo.textContent = type === 'MKT' ? 'Executes immediately at live price'
    : type === 'LMT' ? 'Executes when price reaches your target'
    : 'Stop-loss: trigger price activates the order';
}

async function submitOrder() {
  hideError();
  const lotsOrQty = Number(omQty.value);
  const qty     = currentLotSize > 1 ? lotsOrQty * currentLotSize : lotsOrQty;
  const price   = orderType !== 'MKT' ? Number(omPrice.value)   : 0;
  const trigger = orderType === 'SL'  ? Number(omTrigger.value) : 0;
  if (!lotsOrQty || lotsOrQty <= 0)  return showError('Enter a valid quantity.');
  if (orderType === 'LMT' && !price) return showError('Enter limit price.');
  if (orderType === 'SL'  && !trigger) return showError('Enter trigger price.');

  // For MARKET orders: verify we have a price (WS cache or knownPrice from caller)
  if (orderType === 'MKT' && !knownModalPrice) {
    // Try server cache one more time
    try {
      const r = await fetch(`/api/paper/price/${encodeURIComponent(currentSym)}?exchange=${currentExch}&type=${currentIType}`);
      const d = await r.json();
      if (d.price) {
        knownModalPrice = d.price;
        omLtp.textContent = `₹${d.price.toFixed(2)}`;
      }
    } catch { /* ignore */ }
  }

  // Still no price? Switch to Limit so user can enter it manually
  if (orderType === 'MKT' && !knownModalPrice) {
    document.querySelectorAll('.otype-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.otype-btn[data-otype="LMT"]').classList.add('active');
    setOrderType('LMT');
    showError('Live price not available. Enter the price you see on screen and place a Limit order.');
    omPrice.focus();
    return;
  }

  omSubmit.disabled = true; omSubmit.textContent = 'Placing…';
  try {
    const res  = await fetch('/api/paper/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: currentSym, exchange: currentExch, instrumentType: currentIType,
        side: orderSide, orderType, qty, price, triggerPrice: trigger,
        strategyId: omStrategyEl?.value || 'default',
        knownPrice: knownModalPrice || undefined, // fallback if WS not yet subscribed
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    closeModal(); loadPositions(); loadOrders();
  } catch (err) { showError(err.message); }
  finally { omSubmit.disabled = false; setSide(orderSide); }
}

function showError(msg) { if (omError) { omError.textContent = msg; omError.classList.remove('hidden'); } }
function hideError()    { omError?.classList.add('hidden'); }

// ── Positions grouped by strategy ────────────────────────────────────────────
async function loadPositions() {
  try {
    const [posRes, cashRes] = await Promise.all([
      fetch('/api/paper/positions'), fetch('/api/paper/positions'),
    ]);
    const data = await posRes.json();
    renderStrategiesWithPositions(data.positions || []);
    renderCash(data.cash);
  } catch { }
}

function renderStrategiesWithPositions(positions) {
  if (!stratList) return;

  // Total P&L across all strategies
  const total = positions.reduce((s, p) => s + p.totalPnl, 0);
  if (tpPnl) {
    tpPnl.textContent = `${total >= 0 ? '+' : ''}₹${Math.abs(total).toFixed(2)}`;
    tpPnl.className   = `tp-pnl-val ${total >= 0 ? 'up' : 'down'}`;
  }

  // Group positions by strategy
  const grouped = {};
  for (const strat of strategies) grouped[strat.id] = { strat, positions: [] };
  for (const pos of positions) {
    const sid = pos.strategyId || 'default';
    if (!grouped[sid]) grouped[sid] = { strat: { id: sid, name: 'Unknown' }, positions: [] };
    grouped[sid].positions.push(pos);
  }

  stratList.innerHTML = '';

  if (!positions.length && strategies.length <= 1) {
    stratList.innerHTML = '<div class="strat-empty">No positions yet. Use Buy/Sell to start paper trading.</div>';
    return;
  }

  for (const strat of strategies) {
    const g   = grouped[strat.id] || { strat, positions: [] };
    const pnl = g.positions.reduce((s, p) => s + p.totalPnl, 0);
    const exp = expandedStrats.has(strat.id);

    const block = document.createElement('div');
    block.className = 'strat-block';

    // Strategy header row
    const hdr = document.createElement('div');
    hdr.className = 'strat-header';
    hdr.innerHTML = `
      <button class="strat-expand">${exp ? '▼' : '▶'}</button>
      <span class="strat-name" title="Rename" data-id="${strat.id}">${strat.name}</span>
      <span class="strat-count">${g.positions.length} pos</span>
      <span class="strat-pnl ${pnl >= 0 ? 'up' : 'down'}">${pnl >= 0?'+':''}₹${Math.abs(pnl).toFixed(2)}</span>
      <button class="strat-add-btn" data-stratid="${strat.id}" title="New order in this strategy">+Order</button>
      ${strat.id !== 'default' ? `<button class="strat-del-btn" data-id="${strat.id}" title="Delete strategy">✕</button>` : ''}
    `;

    hdr.querySelector('.strat-expand').addEventListener('click', () => {
      exp ? expandedStrats.delete(strat.id) : expandedStrats.add(strat.id);
      renderStrategiesWithPositions(positions);
    });

    hdr.querySelector('.strat-name').addEventListener('dblclick', async () => {
      const n = prompt('Rename strategy:', strat.name);
      if (!n?.trim()) return;
      await fetch(`/api/paper/strategies/${strat.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n.trim() }),
      });
      strat.name = n.trim(); populateStrategyDropdown();
      renderStrategiesWithPositions(positions);
    });

    hdr.querySelector('.strat-add-btn').addEventListener('click', () => {
      openModal('BUY', currentSym || '', currentExch, currentIType, strat.id);
    });

    hdr.querySelector('.strat-del-btn')?.addEventListener('click', () => deleteStrategy(strat.id));

    block.appendChild(hdr);

    // Expanded position rows
    if (exp && g.positions.length) {
      const posTable = document.createElement('table');
      posTable.className = 'strat-pos-table';
      posTable.innerHTML = `
        <thead><tr>
          <th>Symbol</th><th>Side</th><th>Qty</th>
          <th>Avg Entry</th><th>LTP</th>
          <th>Unrealised P&L</th><th>Realised P&L</th><th></th>
        </tr></thead>
        <tbody>${g.positions.map(p => {
          const upU = p.unrealizedPnl >= 0, upR = p.realizedPnl >= 0;
          return `<tr class="strat-pos-row" data-sym="${p.symbol}" data-entry="${p.avgBuyPrice}" data-qty="${p.netQty}" data-side="${p.netQty >= 0 ? 'BUY' : 'SELL'}" data-from="${p.executedAt || 0}">
            <td class="pos-sym-cell" style="cursor:pointer">${p.symbol}</td>
            <td class="${p.netQty >= 0 ? 'up' : 'down'}">${p.netQty >= 0 ? 'LONG' : 'SHORT'}</td>
            <td>${Math.abs(p.netQty)}</td>
            <td>₹${fmtP(p.avgBuyPrice)}</td>
            <td>₹${fmtP(p.ltp)}</td>
            <td class="${upU ? 'up' : 'down'}">${upU?'+':''}₹${fmtP(Math.abs(p.unrealizedPnl))}</td>
            <td class="${upR ? 'up' : 'down'}">${upR?'+':''}₹${fmtP(Math.abs(p.realizedPnl))}</td>
            <td>
              <button class="tp-action-btn pos-pnl-btn" title="View P&L chart">📈</button>
              <button class="tp-action-btn" onclick="window._tp.openModal('BUY','${p.symbol}','${p.exchange}','${p.instrumentType}',undefined,${p.ltp||0})">B</button>
              <button class="tp-action-btn sell" onclick="window._tp.openModal('SELL','${p.symbol}','${p.exchange}','${p.instrumentType}',undefined,${p.ltp||0})">S</button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      `;

      // Click symbol → chart; click 📈 → P&L chart
      posTable.querySelectorAll('.strat-pos-row').forEach(row => {
        row.querySelector('.pos-sym-cell').addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('load-chart', { detail: { instrument: {
            stock_name: row.dataset.sym, nubra_name: row.dataset.sym,
            exchange: 'NSE', asset_type: 'STOCK',
          }}}));
        });
        row.querySelector('.pos-pnl-btn').addEventListener('click', () => {
          openPnlChart(row.dataset.sym, Number(row.dataset.entry), Number(row.dataset.qty), row.dataset.side, Number(row.dataset.from));
        });
      });

      block.appendChild(posTable);
    } else if (exp && !g.positions.length) {
      const msg = document.createElement('div');
      msg.className = 'strat-no-pos'; msg.textContent = 'No positions in this strategy.';
      block.appendChild(msg);
    }

    stratList.appendChild(block);
  }
}

function renderCash(cash) {
  if (cash == null || !tpCash) return;
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
  if (!ordTbody) return;
  if (!orders.length) { ordTbody.innerHTML = '<tr class="tp-empty"><td colspan="9">No orders placed</td></tr>'; return; }
  ordTbody.innerHTML = orders.map(o => {
    const s   = strategies.find(x => x.id === o.strategyId);
    const sc  = o.status === 'EXECUTED' ? 'status-exec' : o.status === 'CANCELLED' ? 'status-cancel' : 'status-pending';
    const ts  = new Date(o.createdAt).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    return `<tr>
      <td>${o.symbol}</td>
      <td class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side}</td>
      <td>${o.qty}</td>
      <td>${o.orderType}</td>
      <td>${o.price ? '₹'+fmtP(o.price) : 'MKT'}</td>
      <td>${o.executedPrice ? '₹'+fmtP(o.executedPrice) : '—'}</td>
      <td class="${sc}">${o.status}</td>
      <td style="font-size:10px;color:var(--text-muted)">${s?.name || '—'}</td>
      <td>${ts}</td>
      <td>${o.status === 'PENDING' ? `<button class="tp-action-btn sell" onclick="window._tp.cancelOrder('${o.id}')">Cancel</button>` : '—'}</td>
    </tr>`;
  }).join('');
}

async function cancelOrder(id) {
  if (!confirm('Cancel this order?')) return;
  await fetch(`/api/paper/order/${id}`, { method: 'DELETE' });
  loadOrders(); loadPositions();
}

// ── P&L tick-by-tick chart ────────────────────────────────────────────────────
async function openPnlChart(symbol, entryPrice, qty, side, fromTs) {
  pnlSym.textContent       = symbol;
  pnlSideBadge.textContent = side;
  pnlSideBadge.className   = `pnl-side ${side === 'BUY' ? 'buy' : 'sell'}`;
  pnlMeta.textContent      = `${qty} units @ ₹${entryPrice.toFixed(2)}`;
  pnlEntry.textContent     = `₹${entryPrice.toFixed(2)}`;
  pnlLtp.textContent       = '—';
  pnlTotal.textContent     = '—';
  pnlFooter.textContent    = 'Loading ticks…';
  pnlModal.classList.remove('hidden');

  // Build a TradingView line chart for P&L
  if (pnlChart) { pnlChart.remove(); pnlChart = null; }
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  pnlChart = LightweightCharts.createChart(pnlChartEl, {
    layout: {
      background: { color: isDark ? '#0d0f11' : '#ffffff' },
      textColor:  isDark ? '#c9d1d9' : '#131722',
      fontSize: 12, fontFamily: "'Inter', sans-serif",
    },
    grid: {
      vertLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
      horzLines: { color: isDark ? '#1a1d21' : '#f0f3fa' },
    },
    rightPriceScale: { borderColor: isDark ? '#2a2d32' : '#e0e3eb' },
    timeScale:       { borderColor: isDark ? '#2a2d32' : '#e0e3eb', timeVisible: true, secondsVisible: true },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    handleScroll: true, handleScale: true,
  });

  const lineSeries = pnlChart.addLineSeries({
    color:          '#3b82f6',
    lineWidth:      2,
    priceLineVisible: true,
    lastValueVisible: true,
    priceFormat:    { type: 'price', precision: 2, minMove: 0.01 },
  });

  // Zero line
  lineSeries.createPriceLine({ price: 0, color: '#4b5563', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });

  try {
    const from = fromTs || 0;
    const res  = await fetch(`/api/paper/ticks/${encodeURIComponent(symbol)}?from=${from}`);
    const data = await res.json();
    const ticks = data.ticks || [];

    if (!ticks.length) { pnlFooter.textContent = 'No tick data yet. Open the chart to subscribe to live prices.'; return; }

    const mult = side === 'BUY' ? 1 : -1;
    const points = ticks.map(t => ({
      time: Math.floor(t.ts / 1000), // seconds
      value: (t.price - entryPrice) * qty * mult,
    })).sort((a, b) => a.time - b.time);

    lineSeries.setData(points);
    pnlChart.timeScale().fitContent();

    const last = points[points.length - 1];
    pnlLtp.textContent   = `₹${(last.value / (qty * mult) + entryPrice).toFixed(2)}`;
    pnlTotal.textContent = `${last.value >= 0 ? '+' : ''}₹${Math.abs(last.value).toFixed(2)}`;
    pnlTotal.className   = last.value >= 0 ? 'up' : 'down';
    pnlFooter.textContent= `${ticks.length} ticks from entry`;

    // Colour the series by overall profit/loss
    lineSeries.applyOptions({ color: last.value >= 0 ? '#22c55e' : '#ef4444' });

  } catch (err) {
    pnlFooter.textContent = `Error: ${err.message}`;
  }

  new ResizeObserver(() => pnlChart?.resize(pnlChartEl.clientWidth, pnlChartEl.clientHeight)).observe(pnlChartEl);
}

function closePnlModal() {
  pnlModal.classList.add('hidden');
  if (pnlChart) { pnlChart.remove(); pnlChart = null; }
}

// ── WS live update ────────────────────────────────────────────────────────────
function onPaperUpdate() { loadPositions(); loadOrders(); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function renderStrategies() { loadPositions(); }
function fmtP(v) { return Number(v || 0).toFixed(2); }

window._tp = { openModal, cancelOrder };
export const TradingModule = { init, setChartSymbol, openModal, onPaperUpdate };
