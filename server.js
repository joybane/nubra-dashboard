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
    res.status(500).json({ ok: false, error: err.message });
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
      if (decoded) broadcast(decoded);
    } else {
      // Text: subscription acks, errors
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
        const interval= msg.interval || '1m';
        const exchange= msg.exchange  || 'NSE';
        const cmd     = `${verb} ${token} index_bucket ${payload} ${interval} ${exchange}`;
        if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
          nubraWs.send(cmd);
          console.log('[WS cmd]', cmd.slice(0, 80));
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
