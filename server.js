import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import protobuf from 'protobufjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// PROD base URL from SDK source: https://api2.nubra.io
const BASE_URL = process.env.NUBRA_BASE_URL || 'https://api2.nubra.io';
const PORT     = Number(process.env.PORT || 3000);

const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Session persistence ───────────────────────────────────────────────────────
const SESSION_FILE = path.join(__dirname, 'session.json');

function loadSavedSession() {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch { return {}; }
}

function saveSession() {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify({
      authToken: authState.authToken,
      deviceId:  authState.deviceId,
    }), 'utf8');
  } catch { /* non-critical */ }
}

// ─── Auth state ───────────────────────────────────────────────────────────────
const _saved = loadSavedSession();
const authState = {
  deviceId:     _saved.deviceId  || randomUUID() + '-node',
  tempToken:    null,
  authToken:    _saved.authToken || null,
  sessionToken: null,
  status:       'idle', // idle | awaiting_otp | authenticated
};

// ─── HTTP helpers ──────────────────────────────────────────────────────────────
function baseHeaders(extra = {}) {
  return {
    'Content-Type':  'application/json',
    'x-device-id':   authState.deviceId,
    'x-app-version': '0.4.2',
    'x-device-os':   'web',
    ...extra,
  };
}

async function nubraPost(endpoint, body, extraHeaders = {}) {
  const res  = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers: baseHeaders(extraHeaders),
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}: ${text}`);
  return data;
}

async function nubraGet(endpoint, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: baseHeaders({ Authorization: `Bearer ${authState.sessionToken}` }),
  });
  const text = await res.text();
  let data = {};
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}: ${text}`);
  return data;
}

// ─── Auth endpoints ────────────────────────────────────────────────────────────

// Step 1: POST /sendphoneotp — send OTP, handle VERIFY_MOBILE vs VERIFY_TOTP
app.post('/auth/send-otp', async (req, res) => {
  try {
    const phone = process.env.PHONE_NO;
    if (!phone) return res.status(500).json({ ok: false, error: 'PHONE_NO not set in .env' });

    // First call — get temp_token and next step
    const data = await nubraPost('/sendphoneotp', { phone, flow: '', skip_totp: false });
    console.log('sendphoneotp response:', JSON.stringify(data));

    let tempToken = data.temp_token;
    const next    = data.next;

    if (!tempToken) throw new Error('temp_token missing in response');

    if (next === 'VERIFY_TOTP') {
      // Second call with skip_totp=true to get OTP instead
      const data2 = await nubraPost(
        '/sendphoneotp',
        { phone, flow: '', skip_totp: true },
        { 'x-temp-token': tempToken }
      );
      console.log('sendphoneotp (skip_totp) response:', JSON.stringify(data2));
      tempToken = data2.temp_token;
      if (!tempToken) throw new Error('temp_token missing in skip_totp response');
    }

    authState.tempToken = tempToken;
    authState.status    = 'awaiting_otp';
    res.json({ ok: true, message: 'OTP sent to registered mobile number.' });
  } catch (err) {
    console.error('send-otp error:', err.message);
    const friendly = err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')
      ? 'Cannot reach Nubra servers. Check your internet connection and try again.'
      : err.message;
    res.status(500).json({ ok: false, error: friendly });
  }
});

// Step 2: POST /verifyphoneotp — verify OTP, get auth_token
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { otp } = req.body;
    if (!otp)                return res.status(400).json({ ok: false, error: 'OTP required.' });
    if (!authState.tempToken) return res.status(400).json({ ok: false, error: 'Send OTP first.' });

    const phone = process.env.PHONE_NO;
    const data  = await nubraPost(
      '/verifyphoneotp',
      { phone, otp: String(otp) },
      { 'x-temp-token': authState.tempToken }
    );
    console.log('verifyphoneotp response:', JSON.stringify(data));

    const authToken = data.auth_token;
    if (!authToken) throw new Error('auth_token missing in response');

    authState.authToken = authToken;
    authState.status    = 'awaiting_mpin';
    saveSession(); // persist so next restart skips OTP
    res.json({ ok: true, message: 'OTP verified. Verifying MPIN…' });
  } catch (err) {
    console.error('verify-otp error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Step 3: POST /verifypin — verify MPIN, get session_token
app.post('/auth/verify-pin', async (req, res) => {
  try {
    const mpin = process.env.MPIN;
    if (!mpin)                 return res.status(500).json({ ok: false, error: 'MPIN not set in .env' });
    if (!authState.authToken)  return res.status(400).json({ ok: false, error: 'Verify OTP first.' });

    const data = await nubraPost(
      '/verifypin',
      { pin: mpin },
      { Authorization: `Bearer ${authState.authToken}` }
    );
    console.log('verifypin response keys:', Object.keys(data));

    const sessionToken = data.session_token || data.data?.token;
    if (!sessionToken) throw new Error('session_token missing in response');

    authState.sessionToken = sessionToken;
    authState.status       = 'authenticated';
    console.log('Authenticated. Session token acquired.');
    res.json({ ok: true, message: 'Authenticated successfully.' });
  } catch (err) {
    console.error('verify-pin error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Auth status
app.get('/auth/status', (req, res) => {
  res.json({ status: authState.status, authenticated: authState.status === 'authenticated' });
});

// ─── Auth guard ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (authState.status !== 'authenticated' || !authState.sessionToken) {
    return res.status(401).json({ error: 'Not authenticated. Complete login first.' });
  }
  next();
}

// ─── Raw refdata (full instrument list for ref_id → nubra_name mapping) ───────
app.get('/api/refdata/:date', requireAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const { exchange = 'NSE' } = req.query;
    const data = await nubraGet(`/refdata/refdata/${date}`, { exchange });
    res.json(data);
  } catch (err) {
    console.error('refdata error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Instruments search ───────────────────────────────────────────────────────
app.get('/api/instruments/search', requireAuth, async (req, res) => {
  try {
    const { q = '', exchange = 'NSE', type = '', limit = '20' } = req.query;
    const today = new Date().toISOString().slice(0, 10);
    const data  = await nubraGet(`/refdata/refdata/${today}`, { exchange });

    const arr = Array.isArray(data.refdata) ? data.refdata :
                Array.isArray(data.data)    ? data.data    :
                Array.isArray(data)         ? data         : [];

    const q2 = q.toLowerCase();

    // Type priority: STOCK/INDEX first, FUT second, OPT last
    function typePriority(item) {
      const dt = (item.derivative_type || item.asset_type || '').toUpperCase();
      if (dt === 'STOCK' || dt === 'INDEX' || dt === '') return 0;
      if (dt === 'FUT') return 1;
      return 2; // OPT
    }

    // Match score: exact=0, starts-with=1, contains=2
    function matchScore(item) {
      const name = (item.stock_name || item.asset || '').toLowerCase();
      const sym  = (item.zanskar_name || item.nubra_name || item.symbol || '').toLowerCase();
      if (name === q2 || sym === q2) return 0;
      if (name.startsWith(q2) || sym.startsWith(q2)) return 1;
      return 2;
    }

    const filtered = arr
      .filter((item) => {
        const name = (item.stock_name || item.asset || item.symbol || '').toLowerCase();
        const sym  = (item.zanskar_name || item.nubra_name || item.symbol || item.trading_symbol || '').toLowerCase();
        const tm   = !type || (item.derivative_type || item.asset_type || '').toUpperCase() === type.toUpperCase();
        return tm && (name.includes(q2) || sym.includes(q2));
      })
      .sort((a, b) => {
        const ms = matchScore(a) - matchScore(b);
        if (ms !== 0) return ms;
        return typePriority(a) - typePriority(b);
      })
      .slice(0, Number(limit));

    res.json({ results: filtered });
  } catch (err) {
    console.error('instruments search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Historical data ──────────────────────────────────────────────────────────
app.post('/api/historical', requireAuth, async (req, res) => {
  try {
    const data = await nubraPost('/charts/timeseries', req.body, {
      Authorization: `Bearer ${authState.sessionToken}`,
    });

    // Cache the last candle close in paperPrices so Market orders work
    // even when no live WS tick has arrived yet (e.g. after market hours).
    // Only fills the gap — live WS prices take precedence.
    try {
      for (const group of data.result || []) {
        for (const symbolMap of group.values || []) {
          for (const [sym, chart] of Object.entries(symbolMap)) {
            const closes = chart.close || [];
            if (closes.length && !paperPrices[sym]) {
              const last = closes[closes.length - 1];
              if (last?.v != null) paperPrices[sym] = Number(last.v) / 100;
            }
          }
        }
      }
    } catch { /* non-critical */ }

    res.json(data);
  } catch (err) {
    console.error('historical error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Option chain ──────────────────────────────────────────────────────────────
app.get('/api/optionchain/:instrument', requireAuth, async (req, res) => {
  try {
    const { instrument } = req.params;
    const { exchange = 'NSE', expiry } = req.query;
    const params = { exchange };
    if (expiry) params.expiry = expiry;
    const data = await nubraGet(`/optionchains/${instrument}`, params);
    res.json(data);
  } catch (err) {
    console.error('optionchain error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/optionchain/:instrument/price', requireAuth, async (req, res) => {
  try {
    const data = await nubraGet(`/optionchains/${req.params.instrument}/price`);
    res.json(data);
  } catch (err) {
    console.error('price error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Protobuf setup ────────────────────────────────────────────────────────────
let pbAny, pbBatchBucket, pbBatchIndex, pbOptionChainUpdate;

async function loadProto() {
  try {
    const root = await protobuf.load(path.join(__dirname, 'nubra.proto'));
    pbAny              = root.lookupType('nubra.AnyMsg');
    pbBatchBucket      = root.lookupType('nubra.BatchWebSocketIndexBucketMessage');
    pbBatchIndex       = root.lookupType('nubra.BatchWebSocketIndexMessage');
    pbOptionChainUpdate= root.lookupType('nubra.WebSocketMsgOptionChainUpdate');
    console.log('Protobuf schema loaded.');
  } catch (err) {
    console.error('Failed to load proto:', err.message);
  }
}
loadProto();

function decodeBinaryMsg(rawBuffer) {
  if (!pbAny) return null;
  try {
    const outer = pbAny.decode(rawBuffer);
    const inner = pbAny.decode(outer.value);
    const typeUrl = inner.typeUrl || '';

    if (typeUrl.includes('IndexBucket')) {
      const msg = pbBatchBucket.decode(inner.value);
      return { type: 'ohlcv', data: pbBatchBucket.toObject(msg, { longs: String, enums: String }) };
    }
    if (typeUrl.includes('BatchWebSocketIndexMessage')) {
      const msg = pbBatchIndex.decode(inner.value);
      return { type: 'index_tick', data: pbBatchIndex.toObject(msg, { longs: String, enums: String }) };
    }
    if (typeUrl.includes('OptionChainUpdate') && pbOptionChainUpdate) {
      const msg = pbOptionChainUpdate.decode(inner.value);
      return { type: 'option_chain', data: pbOptionChainUpdate.toObject(msg, { longs: String, enums: String }) };
    }
  } catch { /* unknown message type */ }
  return null;
}

// ─── WebSocket relay ───────────────────────────────────────────────────────────
let nubraWs          = null;
const browserClients = new Set();
const pendingSubs    = [];

function connectNubraWs() {
  if (authState.status !== 'authenticated') return;
  if (nubraWs && (nubraWs.readyState === WebSocket.OPEN || nubraWs.readyState === WebSocket.CONNECTING)) return;

  console.log('Connecting to Nubra WebSocket…');
  nubraWs = new WebSocket('wss://api.nubra.io/apibatch/ws', {
    headers: {
      Authorization:   `Bearer ${authState.sessionToken}`,
      'x-device-id':   authState.deviceId,
      'x-app-version': '0.4.2',
      'x-device-os':   'web',
    },
  });

  nubraWs.on('open', () => {
    console.log('Nubra WS connected.');
    broadcast({ type: 'ws_status', connected: true });
    for (const cmd of pendingSubs) nubraWs.send(cmd);
    pendingSubs.length = 0;
  });

  nubraWs.on('message', (data, isBinary) => {
    if (isBinary) {
      const decoded = decodeBinaryMsg(data);
      if (decoded) {
        // Update live prices for paper trading
        if (decoded.type === 'ohlcv' && decoded.data) {
          const all = [...(decoded.data.indexes || []), ...(decoded.data.instruments || [])];
          for (const b of all) {
            if (b.indexname && b.close) {
              const pr = Number(b.close) / 100;
              paperUpdatePrice(b.indexname, pr);
              recordTick(b.indexname, pr);
            }
          }
        }
        // Also update prices from live index tick (index subscription)
        if (decoded.type === 'index_tick' && decoded.data) {
          const all2 = [...(decoded.data.indexes || []), ...(decoded.data.instruments || [])];
          for (const b of all2) {
            if (b.indexname && b.index_value) {
              const pr2 = Number(b.index_value) / 100;
              paperUpdatePrice(b.indexname, pr2);
              recordTick(b.indexname, pr2);
            }
          }
        }
        broadcast(decoded);
      }
    } else {
      const text = data.toString().trim();
      if (text) console.log('[Nubra WS]', text);
    }
  });

  nubraWs.on('close', () => {
    console.log('Nubra WS closed. Reconnecting in 3s…');
    broadcast({ type: 'ws_status', connected: false });
    setTimeout(connectNubraWs, 3000);
  });

  nubraWs.on('error', (err) => {
    console.error('Nubra WS error:', err.message);
  });
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  browserClients.add(ws);
  ws.send(JSON.stringify({ type: 'auth_status', status: authState.status }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'subscribe' || msg.action === 'unsubscribe') {
        const verb    = msg.action === 'subscribe' ? 'batch_subscribe' : 'batch_unsubscribe';
        const token   = authState.sessionToken;
        const payload = JSON.stringify(msg.payload || { instruments: [], indexes: [] });
        const exchange= msg.exchange || 'NSE';
        const bucket  = msg.bucket   || 'index_bucket';
        // 'index' type has no interval; 'index_bucket' needs one
        const cmd = bucket === 'index'
          ? `${verb} ${token} index ${payload} ${exchange}`
          : `${verb} ${token} index_bucket ${payload} ${msg.interval || '1m'} ${exchange}`;
        if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
          nubraWs.send(cmd);
          console.log('[WS cmd]', cmd.slice(0, 90));
        } else if (msg.action === 'subscribe') {
          pendingSubs.push(cmd);
          connectNubraWs();
        }
      }

      // Option chain subscription: {action:'subscribe_oc', asset, expiry, exchange}
      if (msg.action === 'subscribe_oc' || msg.action === 'unsubscribe_oc') {
        const verb    = msg.action === 'subscribe_oc' ? 'batch_subscribe' : 'batch_unsubscribe';
        const token   = authState.sessionToken;
        const payload = JSON.stringify([{ exchange: msg.exchange || 'NSE', asset: msg.asset, expiry: msg.expiry }]);
        const cmd     = `${verb} ${token} option ${payload}`;
        if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
          nubraWs.send(cmd);
          console.log('[OC cmd]', cmd.slice(0, 100));
        } else if (msg.action === 'subscribe_oc') {
          pendingSubs.push(cmd);
          connectNubraWs();
        }
      }
    } catch (e) {
      console.error('WS msg error:', e.message);
    }
  });

  ws.on('close', () => browserClients.delete(ws));
});

setInterval(() => {
  if (authState.status === 'authenticated' &&
      (!nubraWs || nubraWs.readyState === WebSocket.CLOSED)) {
    connectNubraWs();
  }
}, 2000);

// ─── Paper trading ────────────────────────────────────────────────────────────
const PAPER_FILE  = path.join(__dirname, 'paper_trading.json');
const paperPrices = {}; // symbol → latest price in ₹ (updated from WS)
const PAPER_CASH_DEFAULT = 100_000_000; // ₹10 crore — effectively unlimited for paper trading

function loadPaperData() {
  try {
    if (existsSync(PAPER_FILE)) return JSON.parse(readFileSync(PAPER_FILE, 'utf8'));
  } catch { }
  return { orders: [], cash: PAPER_CASH_DEFAULT };
}
function savePaperData() {
  try { writeFileSync(PAPER_FILE, JSON.stringify({ orders: paperOrders, cash: paperCash, strategies: paperStrategies }), 'utf8'); }
  catch { }
}

const paperData       = loadPaperData();
let paperOrders      = paperData.orders     || [];
let paperCash        = paperData.cash       ?? PAPER_CASH_DEFAULT;
let paperStrategies  = paperData.strategies || [{ id: 'default', name: 'Default Strategy', createdAt: Date.now() }];

// Tick history per symbol — ring buffer, last 2000 ticks
const tickHistory = {}; // symbol → [{ts, price}]
const TICK_MAX    = 2000;

function recordTick(symbol, priceRs) {
  if (!tickHistory[symbol]) tickHistory[symbol] = [];
  tickHistory[symbol].push({ ts: Date.now(), price: priceRs });
  if (tickHistory[symbol].length > TICK_MAX) tickHistory[symbol].shift();
}

function computePositions() {
  const pos = {};
  for (const o of paperOrders) {
    if (o.status !== 'EXECUTED') continue;
    const sid = o.strategyId || 'default';
    // Key = symbol + strategy so each strategy tracks its own P&L independently
    const key = `${o.symbol}::${sid}`;
    if (!pos[key]) pos[key] = {
      symbol: o.symbol, exchange: o.exchange,
      instrumentType: o.instrumentType, strategyId: sid,
      netQty: 0, buyQty: 0, sellQty: 0,
      avgBuyPrice: 0, avgSellPrice: 0, realizedPnl: 0,
      executedAt: o.executedAt || o.createdAt,
    };
    const p = pos[key];
    // Track earliest entry time for P&L chart
    if ((o.executedAt || o.createdAt) < p.executedAt) p.executedAt = o.executedAt || o.createdAt;
    if (o.side === 'BUY') {
      const tot = p.buyQty + o.qty;
      p.avgBuyPrice  = (p.avgBuyPrice * p.buyQty + o.executedPrice * o.qty) / tot;
      p.buyQty = tot;
    } else {
      const tot = p.sellQty + o.qty;
      p.avgSellPrice = (p.avgSellPrice * p.sellQty + o.executedPrice * o.qty) / tot;
      p.sellQty = tot;
      p.realizedPnl += (o.executedPrice - p.avgBuyPrice) * o.qty;
    }
    p.netQty = p.buyQty - p.sellQty;
  }
  return Object.values(pos).map(p => {
    const ltp = paperPrices[p.symbol] || 0;
    const unrealized = p.netQty > 0
      ? (ltp - p.avgBuyPrice) * p.netQty
      : p.netQty < 0 ? (p.avgSellPrice - ltp) * Math.abs(p.netQty) : 0;
    return { ...p, ltp, unrealizedPnl: unrealized, totalPnl: p.realizedPnl + unrealized };
  });
}

function paperUpdatePrice(symbol, priceRs) {
  paperPrices[symbol] = priceRs;
  // Execute pending limit/SL orders
  for (const o of paperOrders) {
    if (o.status !== 'PENDING' || o.symbol !== symbol) continue;
    let fire = false;
    if (o.orderType === 'LMT') {
      fire = o.side === 'BUY' ? priceRs <= o.price : priceRs >= o.price;
    } else if (o.orderType === 'SL') {
      fire = o.side === 'BUY' ? priceRs >= o.triggerPrice : priceRs <= o.triggerPrice;
    }
    if (fire) {
      o.status = 'EXECUTED'; o.executedPrice = priceRs; o.executedAt = Date.now();
      if (o.side === 'BUY') paperCash -= priceRs * o.qty;
      else                  paperCash += priceRs * o.qty;
      savePaperData();
      broadcast({ type: 'paper_update' });
    }
  }
}

// GET positions
app.get('/api/paper/positions', requireAuth, (req, res) => {
  res.json({ positions: computePositions(), cash: paperCash });
});

// GET orders (newest first)
app.get('/api/paper/orders', requireAuth, (req, res) => {
  res.json({ orders: [...paperOrders].reverse() });
});

// POST place order
app.post('/api/paper/order', requireAuth, (req, res) => {
  try {
    const { symbol, exchange, side, orderType, qty, price, triggerPrice, instrumentType, strategyId, knownPrice } = req.body;
    if (!symbol || !side || !qty || qty <= 0) {
      return res.status(400).json({ error: 'symbol, side, qty required' });
    }
    const order = {
      id: randomUUID(), symbol, exchange: exchange || 'NSE',
      side: side.toUpperCase(), orderType: (orderType || 'MKT').toUpperCase(),
      instrumentType: instrumentType || 'STOCK',
      strategyId: strategyId || 'default',
      qty: Number(qty), price: price ? Number(price) : 0,
      triggerPrice: triggerPrice ? Number(triggerPrice) : 0,
      status: 'PENDING', executedPrice: 0,
      createdAt: Date.now(), executedAt: null,
    };
    if (order.orderType === 'MKT') {
      // Use WS price → knownPrice (from UI) → reject
      const cur = paperPrices[symbol] || (knownPrice ? Number(knownPrice) : 0);
      if (!cur) return res.status(400).json({ error: `No live price for ${symbol}. Add it to the watchlist or load its chart to get live data.` });
      order.status = 'EXECUTED'; order.executedPrice = cur; order.executedAt = Date.now();
      if (order.side === 'BUY') paperCash -= cur * order.qty;
      else                      paperCash += cur * order.qty;
    }
    paperOrders.push(order);
    savePaperData();
    broadcast({ type: 'paper_update' });
    res.json({ ok: true, order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE cancel order
app.delete('/api/paper/order/:id', requireAuth, (req, res) => {
  const o = paperOrders.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'PENDING') return res.status(400).json({ error: 'Can only cancel PENDING orders' });
  o.status = 'CANCELLED'; savePaperData(); broadcast({ type: 'paper_update' });
  res.json({ ok: true });
});

// PUT reset paper account
app.put('/api/paper/reset', requireAuth, (req, res) => {
  paperOrders = []; paperCash = PAPER_CASH_DEFAULT;
  savePaperData(); broadcast({ type: 'paper_update' });
  res.json({ ok: true });
});

// GET current tracked price for a symbol.
// Falls back to the last daily candle from Nubra if no live WS price is cached.
app.get('/api/paper/price/:symbol', requireAuth, async (req, res) => {
  const sym = req.params.symbol;
  const cached = paperPrices[sym];
  if (cached) return res.json({ price: cached });

  const exchange = (req.query.exchange || 'NSE').toUpperCase();
  const type     = (req.query.type     || 'STOCK').toUpperCase();
  try {
    const now  = new Date();
    const from = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const data = await nubraPost('/charts/timeseries', {
      query: [{
        exchange, type, values: [sym],
        fields: ['close'],
        startDate: from.toISOString(),
        endDate:   now.toISOString(),
        interval: '1d', intraDay: false, realTime: false,
      }],
    }, { Authorization: `Bearer ${authState.sessionToken}` });

    for (const group of data.result || []) {
      for (const symbolMap of group.values || []) {
        for (const chart of Object.values(symbolMap)) {
          const closes = chart.close || [];
          if (closes.length) {
            const last = closes[closes.length - 1];
            if (last?.v != null) {
              const price = Number(last.v) / 100;
              paperPrices[sym] = price;
              return res.json({ price });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[price fallback]', sym, err.message);
  }

  res.json({ price: null });
});

// POST estimate margin for a potential order
app.post('/api/paper/margin', requireAuth, (req, res) => {
  const { symbol, side, qty, price, instrumentType, lotSize } = req.body;
  const q = Number(qty) || 0;
  const ltp = Number(price) || 0;
  const ls  = Number(lotSize) || 1;
  const lots = ls > 1 ? q / ls : q;
  const premiumTotal = ltp * q;

  if (!side || !q || !ltp) return res.json({ required: 0, label: 'Cost' });

  if (side.toUpperCase() === 'BUY') {
    return res.json({ required: premiumTotal, label: 'Cost (Premium)' });
  }

  const itype = (instrumentType || '').toUpperCase();

  if (itype === 'OPT') {
    // Parse underlying symbol from e.g. "NIFTY2660223350CE" → "NIFTY"
    const m = symbol.match(/^([A-Z]+)\d/);
    const underlying = m ? m[1] : null;
    const uPrice = underlying ? (paperPrices[underlying] || 0) : 0;

    let span;
    if (uPrice && ls > 1) {
      // Index/stock option: SPAN ≈ 7% of notional + 2% exposure
      span = uPrice * ls * lots * 0.09;
    } else {
      // Fallback when no underlying price: 8× premium received
      span = premiumTotal * 8;
    }

    // Hedge benefit: deduct value of existing long positions on same underlying
    if (underlying) {
      const positions = computePositions();
      for (const p of positions) {
        const isLong = p.netQty > 0;
        const sameUnderlying = p.symbol.startsWith(underlying);
        const isOpt = (p.instrumentType || '').toUpperCase() === 'OPT';
        if (isLong && sameUnderlying && isOpt && p.ltp) {
          const hedgeCredit = p.ltp * Math.abs(p.netQty);
          span = Math.max(0, span - hedgeCredit);
        }
      }
    }
    return res.json({ required: Math.round(span), label: 'SPAN + Exposure (est.)' });
  }

  if (itype === 'FUT') {
    return res.json({ required: Math.round(ltp * q * 0.12), label: 'SPAN Margin (est.)' });
  }

  // Stocks / delivery
  return res.json({ required: Math.round(premiumTotal), label: 'Required Capital' });
});

// ── Strategies CRUD ───────────────────────────────────────────────────────────
app.get('/api/paper/strategies', requireAuth, (req, res) => {
  res.json({ strategies: paperStrategies });
});

app.post('/api/paper/strategies', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const s = { id: randomUUID(), name: name.trim(), createdAt: Date.now() };
  paperStrategies.push(s);
  savePaperData();
  res.json({ ok: true, strategy: s });
});

app.put('/api/paper/strategies/:id', requireAuth, (req, res) => {
  const s = paperStrategies.find(x => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Strategy not found' });
  s.name = (req.body.name || s.name).trim();
  savePaperData();
  res.json({ ok: true, strategy: s });
});

app.delete('/api/paper/strategies/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default strategy' });
  // Move orders to default
  paperOrders.forEach(o => { if (o.strategyId === id) o.strategyId = 'default'; });
  paperStrategies = paperStrategies.filter(s => s.id !== id);
  savePaperData();
  broadcast({ type: 'paper_update' });
  res.json({ ok: true });
});

// GET tick history for a symbol from a given timestamp
app.get('/api/paper/ticks/:symbol', requireAuth, (req, res) => {
  const { symbol } = req.params;
  const from   = Number(req.query.from) || 0;
  const ticks  = (tickHistory[symbol] || []).filter(t => t.ts >= from);
  res.json({ ticks, symbol });
});

// GET bulk prices for watchlist (comma-separated symbols)
app.get('/api/paper/prices', requireAuth, (req, res) => {
  const syms = (req.query.symbols || '').split(',').filter(Boolean);
  const result = {};
  for (const s of syms) result[s] = paperPrices[s] || null;
  res.json(result);
});

// ─── Startup session restore ───────────────────────────────────────────────────
async function tryRestoreSession() {
  if (!authState.authToken) return;
  const mpin = process.env.MPIN;
  if (!mpin) return;
  try {
    console.log('Attempting to restore session with saved token…');
    const data = await nubraPost(
      '/verifypin',
      { pin: mpin },
      { Authorization: `Bearer ${authState.authToken}` }
    );
    const sessionToken = data.session_token || data.data?.token;
    if (!sessionToken) throw new Error('no session_token in response');
    authState.sessionToken = sessionToken;
    authState.status       = 'authenticated';
    console.log('Session restored — OTP not needed.');
    connectNubraWs();
  } catch (err) {
    console.log(`Saved token expired (${err.message}). Fresh OTP required.`);
    authState.authToken = null;
    authState.status    = 'idle';
  }
}

// ─── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, async () => {
  console.log(`Nubra Dashboard → http://localhost:${PORT}`);
  await tryRestoreSession();
});
