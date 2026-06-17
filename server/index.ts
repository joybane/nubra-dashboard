import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import protobuf from 'protobufjs';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const BASE_URL = process.env.NUBRA_BASE_URL || 'https://api2.nubra.io';
const PORT     = Number(process.env.SERVER_PORT || 3000);

// ─── Server-side refdata cache ────────────────────────────────────────────────
// Avoids fetching 100k+ instrument records from Nubra on every search keystroke.
// Keyed by exchange; auto-invalidated when the calendar date rolls over.
const _refdataCache    = new Map<string, Record<string, unknown>[]>();
let   _refdataCacheDay = '';

async function getRefdata(exchange: string): Promise<Record<string, unknown>[]> {
  const today = new Date().toISOString().slice(0, 10);
  if (_refdataCacheDay !== today) {
    _refdataCache.clear();
    _refdataCacheDay = today;
  }
  const hit = _refdataCache.get(exchange);
  if (hit) return hit;
  const raw = await nubraGet(`/refdata/refdata/${today}`, { exchange });
  const arr: Record<string, unknown>[] =
    Array.isArray(raw.refdata) ? raw.refdata as Record<string, unknown>[] :
    Array.isArray(raw.data)    ? raw.data    as Record<string, unknown>[] :
    Array.isArray(raw)         ? raw          as unknown as Record<string, unknown>[] : [];
  _refdataCache.set(exchange, arr);
  console.log(`[Refdata] Cached ${arr.length} instruments for ${exchange}`);
  return arr;
}

// ─── Session persistence ──────────────────────────────────────────────────────
const SESSION_FILE = path.join(__dirname, '..', 'session.json');

function loadSavedSession(): { authToken?: string; deviceId?: string } {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    return JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  } catch { return {}; }
}

function saveSession(): void {
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
  tempToken:    null as string | null,
  authToken:    _saved.authToken || null as string | null,
  sessionToken: null as string | null,
  status:       'idle' as 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated',
};

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    'x-device-id':   authState.deviceId,
    'x-app-version': '0.4.2',
    'x-device-os':   'web',
    ...extra,
  };
}

async function nubraPost(endpoint: string, body: object, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res  = await fetch(`${BASE_URL}${endpoint}`, {
    method:  'POST',
    headers: baseHeaders(extraHeaders),
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!res.ok) {
    const msg = (data.message || data.error || `HTTP ${res.status}: ${text}`) as string;
    throw new Error(msg);
  }
  return data;
}

async function nubraGet(endpoint: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const qs  = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;
  const res = await fetch(url, {
    headers: baseHeaders({ Authorization: `Bearer ${authState.sessionToken}` }),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!res.ok) {
    const msg = (data.message || data.error || `HTTP ${res.status}: ${text}`) as string;
    throw new Error(msg);
  }
  return data;
}

// ─── Fastify setup ────────────────────────────────────────────────────────────
const httpServer = createServer();

const fastify = Fastify({
  serverFactory: (handler) => {
    httpServer.on('request', handler);
    return httpServer;
  },
  logger: { level: 'warn' },
});

await fastify.register(fastifyCors, { origin: true });

// Serve built frontend in production
const distPath = path.join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
  await fastify.register(fastifyStatic, { root: distPath });
}

// ─── Auth endpoints ───────────────────────────────────────────────────────────
fastify.post('/auth/send-otp', async (_req, reply) => {
  try {
    const phone = process.env.PHONE_NO;
    if (!phone) return reply.status(500).send({ ok: false, error: 'PHONE_NO not set in .env' });

    const data = await nubraPost('/sendphoneotp', { phone, flow: '', skip_totp: false });
    let tempToken = data.temp_token as string;
    const next    = data.next as string;

    if (!tempToken) throw new Error('temp_token missing in response');

    if (next === 'VERIFY_TOTP') {
      const data2 = await nubraPost('/sendphoneotp', { phone, flow: '', skip_totp: true }, { 'x-temp-token': tempToken });
      tempToken = data2.temp_token as string;
      if (!tempToken) throw new Error('temp_token missing in skip_totp response');
    }

    authState.tempToken = tempToken;
    authState.status    = 'awaiting_otp';
    return reply.send({ ok: true, message: 'OTP sent to registered mobile number.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ ok: false, error: msg });
  }
});

fastify.post<{ Body: { otp: string } }>('/auth/verify-otp', async (req, reply) => {
  try {
    const { otp } = req.body;
    if (!otp)                return reply.status(400).send({ ok: false, error: 'OTP required.' });
    if (!authState.tempToken) return reply.status(400).send({ ok: false, error: 'Send OTP first.' });

    const phone = process.env.PHONE_NO!;
    const data  = await nubraPost(
      '/verifyphoneotp',
      { phone, otp: String(otp) },
      { 'x-temp-token': authState.tempToken },
    );

    const authToken = data.auth_token as string;
    if (!authToken) throw new Error('auth_token missing in response');

    authState.authToken = authToken;
    authState.status    = 'awaiting_mpin';
    saveSession();
    return reply.send({ ok: true, message: 'OTP verified. Verifying MPIN…' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ ok: false, error: msg });
  }
});

fastify.post('/auth/verify-pin', async (_req, reply) => {
  try {
    const mpin = process.env.MPIN;
    if (!mpin)                return reply.status(500).send({ ok: false, error: 'MPIN not set in .env' });
    if (!authState.authToken) return reply.status(400).send({ ok: false, error: 'Verify OTP first.' });

    const data = await nubraPost('/verifypin', { pin: mpin }, { Authorization: `Bearer ${authState.authToken}` });
    const sessionToken = (data.session_token || (data.data as Record<string, unknown>)?.token) as string;
    if (!sessionToken) throw new Error('session_token missing in response');

    authState.sessionToken = sessionToken;
    authState.status       = 'authenticated';
    console.log('Authenticated. Session token acquired.');
    connectNubraWs();
    return reply.send({ ok: true, message: 'Authenticated successfully.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ ok: false, error: msg });
  }
});

fastify.get('/auth/status', async (_req, reply) => {
  return reply.send({ status: authState.status, authenticated: authState.status === 'authenticated' });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────
function requireAuth(reply: { status: (code: number) => { send: (body: unknown) => void } }): boolean {
  if (authState.status !== 'authenticated' || !authState.sessionToken) {
    reply.status(401).send({ error: 'Not authenticated. Complete login first.' });
    return false;
  }
  return true;
}

// ─── Refdata (instruments) ────────────────────────────────────────────────────
fastify.get<{ Querystring: { exchange?: string } }>('/api/refdata', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const exchange = req.query.exchange || 'NSE';
    const arr = await getRefdata(exchange);
    return reply.send({ refdata: arr });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: msg });
  }
});

// ─── Instruments search ───────────────────────────────────────────────────────
fastify.get<{ Querystring: { q?: string; exchange?: string; type?: string; limit?: string } }>(
  '/api/instruments/search',
  async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { q = '', exchange = 'NSE', type = '', limit = '20' } = req.query;
      const arr = await getRefdata(exchange);

      const q2 = q.toLowerCase();

      function typePriority(item: Record<string, unknown>): number {
        const dt = ((item.derivative_type || item.asset_type || '') as string).toUpperCase();
        if (dt === 'STOCK' || dt === 'INDEX' || dt === '') return 0;
        if (dt === 'FUT') return 1;
        return 2;
      }

      function matchScore(item: Record<string, unknown>): number {
        const name = ((item.stock_name || item.asset || '') as string).toLowerCase();
        const sym  = ((item.zanskar_name || item.nubra_name || item.symbol || '') as string).toLowerCase();
        if (name === q2 || sym === q2) return 0;
        if (name.startsWith(q2) || sym.startsWith(q2)) return 1;
        return 2;
      }

      const filtered = arr
        .filter((item) => {
          const name = ((item.stock_name || item.asset || item.symbol || '') as string).toLowerCase();
          const sym  = ((item.zanskar_name || item.nubra_name || item.symbol || item.trading_symbol || '') as string).toLowerCase();
          const tm   = !type || ((item.derivative_type || item.asset_type || '') as string).toUpperCase() === type.toUpperCase();
          return tm && (name.includes(q2) || sym.includes(q2));
        })
        .sort((a, b) => {
          const ms = matchScore(a) - matchScore(b);
          if (ms !== 0) return ms;
          return typePriority(a) - typePriority(b);
        })
        .slice(0, Number(limit));

      return reply.send({ results: filtered });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  },
);

// ─── Historical data ──────────────────────────────────────────────────────────
fastify.post('/api/historical', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const data = await nubraPost('/charts/timeseries', req.body as object, {
      Authorization: `Bearer ${authState.sessionToken!}`,
    });
    return reply.send(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: msg });
  }
});

// ─── Option chain ─────────────────────────────────────────────────────────────
fastify.get<{ Params: { instrument: string }; Querystring: { exchange?: string; expiry?: string } }>(
  '/api/optionchain/:instrument',
  async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { instrument } = req.params;
      const { exchange = 'NSE', expiry } = req.query;
      const params: Record<string, string> = { exchange };
      if (expiry) params.expiry = expiry;
      const data = await nubraGet(`/optionchains/${instrument}`, params);
      // Debug: log response shape to help diagnose field-name issues
      const chain = (data.chain || data) as Record<string, unknown>;
      const ce0 = Array.isArray(chain.ce) ? (chain.ce as unknown[])[0] : undefined;
      console.log(`[OC] ${instrument} keys=${Object.keys(chain).join(',')} exps=${(chain.all_expiries as string[]|undefined)?.slice(0,3).join(',')} ce[0]=${JSON.stringify(ce0)?.slice(0,120)}`);
      return reply.send(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  },
);

fastify.get<{ Params: { instrument: string } }>(
  '/api/optionchain/:instrument/price',
  async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const data = await nubraGet(`/optionchains/${req.params.instrument}/price`);
      return reply.send(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  },
);

// ─── Protobuf setup ───────────────────────────────────────────────────────────
let pbAny: protobuf.Type | null              = null;
let pbBatchBucket: protobuf.Type | null      = null;
let pbBatchIndex: protobuf.Type | null       = null;
let pbOptionChainUpdate: protobuf.Type | null= null;

async function loadProto(): Promise<void> {
  try {
    const root = await protobuf.load(path.join(__dirname, '..', 'nubra.proto'));
    pbAny               = root.lookupType('nubra.AnyMsg');
    pbBatchBucket       = root.lookupType('nubra.BatchWebSocketIndexBucketMessage');
    pbBatchIndex        = root.lookupType('nubra.BatchWebSocketIndexMessage');
    pbOptionChainUpdate = root.lookupType('nubra.WebSocketMsgOptionChainUpdate');
    console.log('Protobuf schema loaded.');
  } catch (err) {
    console.error('Failed to load proto:', (err as Error).message);
  }
}

function decodeBinaryMsg(rawBuffer: Buffer): { type: string; data: unknown } | null {
  if (!pbAny) return null;
  try {
    const outer   = pbAny.decode(rawBuffer);
    const outerObj = pbAny.toObject(outer, { longs: String }) as { typeUrl?: string; value: Uint8Array };
    const inner   = pbAny.decode(outerObj.value);
    const innerObj = pbAny.toObject(inner, { longs: String }) as { typeUrl?: string; value: Uint8Array };
    const typeUrl = innerObj.typeUrl || '';

    if (typeUrl.includes('IndexBucket') && pbBatchBucket) {
      const msg = pbBatchBucket.decode(innerObj.value);
      return { type: 'ohlcv', data: pbBatchBucket.toObject(msg, { longs: String, enums: String }) };
    }
    if (typeUrl.includes('BatchWebSocketIndexMessage') && pbBatchIndex) {
      const msg = pbBatchIndex.decode(innerObj.value);
      return { type: 'index_tick', data: pbBatchIndex.toObject(msg, { longs: String, enums: String }) };
    }
    if (typeUrl.includes('OptionChainUpdate') && pbOptionChainUpdate) {
      const msg = pbOptionChainUpdate.decode(innerObj.value);
      return { type: 'option_chain', data: pbOptionChainUpdate.toObject(msg, { longs: String, enums: String }) };
    }
  } catch { /* unknown message */ }
  return null;
}

// ─── WebSocket relay ──────────────────────────────────────────────────────────
let nubraWs: WebSocket | null      = null;
const browserClients               = new Set<WebSocket>();
const pendingSubs: string[]        = [];

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function connectNubraWs(): void {
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
    for (const cmd of pendingSubs) nubraWs!.send(cmd);
    pendingSubs.length = 0;
  });

  nubraWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const decoded = decodeBinaryMsg(data);
      if (decoded) {
        broadcast(decoded);
        routeTickToSim(decoded);  // feed live prices into SimBroker for fill simulation
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

  nubraWs.on('error', (err: Error) => {
    console.error('Nubra WS error:', err.message);
  });
}

function broadcast(obj: unknown): void {
  const msg = JSON.stringify(obj);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

interface WsMsg {
  action: string;
  bucket?: string;
  payload?: unknown;
  interval?: string;
  exchange?: string;
  asset?: string;
  expiry?: string;
}

wss.on('connection', (ws) => {
  browserClients.add(ws);
  ws.send(JSON.stringify({ type: 'auth_status', status: authState.status }));

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString()) as WsMsg;

      if (msg.action === 'subscribe' || msg.action === 'unsubscribe') {
        const verb     = msg.action === 'subscribe' ? 'batch_subscribe' : 'batch_unsubscribe';
        const token    = authState.sessionToken!;
        const payload  = JSON.stringify(msg.payload || { instruments: [], indexes: [] });
        const interval = msg.interval || '1m';
        const exchange = msg.exchange  || 'NSE';
        const cmd      = `${verb} ${token} index_bucket ${payload} ${interval} ${exchange}`;
        if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
          nubraWs.send(cmd);
        } else if (msg.action === 'subscribe') {
          pendingSubs.push(cmd);
          connectNubraWs();
        }
      }

      if (msg.action === 'subscribe_oc' || msg.action === 'unsubscribe_oc') {
        const verb    = msg.action === 'subscribe_oc' ? 'batch_subscribe' : 'batch_unsubscribe';
        const token   = authState.sessionToken!;
        const payload = JSON.stringify([{ exchange: msg.exchange || 'NSE', asset: msg.asset, expiry: msg.expiry }]);
        const cmd     = `${verb} ${token} option ${payload}`;
        if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
          nubraWs.send(cmd);
        } else if (msg.action === 'subscribe_oc') {
          pendingSubs.push(cmd);
          connectNubraWs();
        }
      }
    } catch (e) {
      console.error('WS msg error:', (e as Error).message);
    }
  });

  ws.on('close', () => browserClients.delete(ws));
});

setInterval(() => {
  if (authState.status === 'authenticated' && (!nubraWs || nubraWs.readyState === WebSocket.CLOSED)) {
    connectNubraWs();
  }
}, 2000);

// ─── Live Broker Simulation (SimBroker) ──────────────────────────────────────
// All paper orders are simulated locally against real-time PROD WebSocket data.
// No orders are sent to any live or UAT brokerage account.

function simSpread(ltp: number): number {
  // Half-spread per side in paise, calibrated to Indian equity/options markets
  if (ltp <= 0)      return 1;
  if (ltp < 100)     return Math.max(1,  Math.round(ltp * 0.005));
  if (ltp < 1_000)   return Math.max(2,  Math.round(ltp * 0.004));
  if (ltp < 10_000)  return Math.max(5,  Math.round(ltp * 0.003));
  return               Math.max(10, Math.round(ltp * 0.002));
}

interface SimOrder {
  order_id:            number;
  ref_id:              number;
  nubraName:           string;
  display_name:        string;
  order_type:          string;
  order_side:          string;
  order_price:         number;          // paise; 0 = market
  trigger_price:       number;          // paise; 0 = none
  order_qty:           number;
  filled_qty:          number;
  avg_filled_price:    number;          // paise
  order_status:        string;
  order_time:          number;          // nanoseconds epoch
  filled_time:         number | null;
  order_delivery_type: string;
  validity_type:       string;
  tag?:                string;
  sl_triggered:        boolean;
}

interface SimPosition {
  ref_id:              number;
  nubraName:           string;
  display_name:        string;
  qty:                 number;          // positive = long, negative = short
  avg_price:           number;          // paise
  realized_pnl:        number;          // paise
  last_traded_price:   number;          // paise, kept current by tick feed
  order_delivery_type: string;
}

class SimBroker {
  private orders    = new Map<number, SimOrder>();
  private positions = new Map<number, SimPosition>();
  private ticks     = new Map<number, number>();     // ref_id → ltp paise
  private nameMap   = new Map<string, number>();     // normalised name → ref_id
  private nextId    = 1;

  registerName(nubraName: string, refId: number): void {
    const norm = nubraName.toLowerCase().replace(/^(nse|bse)_/, '');
    this.nameMap.set(nubraName.toLowerCase(), refId);
    if (norm !== nubraName.toLowerCase()) this.nameMap.set(norm, refId);
  }

  // Called for option-chain ticks (have a direct ref_id)
  onLtp(refId: number, ltpPaise: number): void {
    if (ltpPaise <= 0) return;
    const prev = this.ticks.get(refId);
    this.ticks.set(refId, ltpPaise);
    const pos = this.positions.get(refId);
    if (pos) pos.last_traded_price = ltpPaise;
    if (prev !== ltpPaise) this.checkFills(refId, ltpPaise);
  }

  // Called for index / OHLCV ticks (identified by name string)
  onNamedLtp(rawName: string, ltpPaise: number): void {
    if (ltpPaise <= 0) return;
    const norm  = rawName.toLowerCase().replace(/^(nse|bse)_/, '');
    const refId = this.nameMap.get(norm) ?? this.nameMap.get(rawName.toLowerCase());
    if (refId !== undefined) this.onLtp(refId, ltpPaise);
  }

  private checkFills(refId: number, ltp: number): void {
    const half = simSpread(ltp);
    const bid  = ltp - half;
    const ask  = ltp + half;
    for (const order of this.orders.values()) {
      if (order.ref_id !== refId) continue;
      if (order.order_status !== 'ORDER_STATUS_OPEN') continue;
      this.tryFill(order, bid, ask);
    }
  }

  private tryFill(order: SimOrder, bid: number, ask: number): void {
    const isBuy = order.order_side === 'ORDER_SIDE_BUY';

    if (order.order_type === 'ORDER_TYPE_MARKET') {
      this.fill(order, isBuy ? ask : bid);

    } else if (order.order_type === 'ORDER_TYPE_REGULAR') {
      // Limit: buy when ask crosses down through limit; sell when bid crosses up
      if (isBuy  && ask <= order.order_price) this.fill(order, Math.min(ask, order.order_price));
      if (!isBuy && bid >= order.order_price) this.fill(order, Math.max(bid, order.order_price));

    } else if (order.order_type === 'ORDER_TYPE_STOPLOSS') {
      if (!order.sl_triggered) {
        // Trigger: BUY SL when ask rises to trigger; SELL SL when bid falls to trigger
        const hit = isBuy ? ask >= order.trigger_price : bid <= order.trigger_price;
        if (hit) {
          order.sl_triggered = true;
          if (order.order_price > 0) {
            // SL-Limit: fill only if price is within the limit after trigger
            if (isBuy  && ask <= order.order_price) this.fill(order, ask);
            if (!isBuy && bid >= order.order_price) this.fill(order, bid);
          } else {
            this.fill(order, isBuy ? ask : bid);   // SL-Market
          }
        }
      } else if (order.order_price > 0) {
        if (isBuy  && ask <= order.order_price) this.fill(order, ask);
        if (!isBuy && bid >= order.order_price) this.fill(order, bid);
      } else {
        this.fill(order, isBuy ? ask : bid);
      }
    }
  }

  private fill(order: SimOrder, fillPaise: number): void {
    order.filled_qty       = order.order_qty;
    order.avg_filled_price = Math.round(fillPaise);
    order.order_status     = 'ORDER_STATUS_FILLED';
    order.filled_time      = Date.now() * 1_000_000;

    const isBuy = order.order_side === 'ORDER_SIDE_BUY';
    const delta = isBuy ? order.order_qty : -order.order_qty;
    let pos = this.positions.get(order.ref_id);

    if (!pos) {
      pos = {
        ref_id:              order.ref_id,
        nubraName:           order.nubraName,
        display_name:        order.display_name,
        qty:                 0,
        avg_price:           0,
        realized_pnl:        0,
        last_traded_price:   this.ticks.get(order.ref_id) ?? Math.round(fillPaise),
        order_delivery_type: order.order_delivery_type,
      };
      this.positions.set(order.ref_id, pos);
    }

    const prev = pos.qty;
    const next = prev + delta;

    if (prev === 0) {
      pos.qty       = delta;
      pos.avg_price = Math.round(fillPaise);
    } else if (Math.sign(prev) === Math.sign(delta)) {
      // Same direction: weighted average price
      const totalQty = Math.abs(prev) + order.order_qty;
      pos.avg_price  = Math.round((Math.abs(pos.avg_price) * Math.abs(prev) + fillPaise * order.order_qty) / totalQty);
      pos.qty        = next;
    } else {
      // Closing / reversing: realise P&L on the closed portion
      const closedQty = Math.min(Math.abs(prev), order.order_qty);
      pos.realized_pnl += isBuy
        ? (pos.avg_price - fillPaise) * closedQty    // buying to cover a short
        : (fillPaise    - pos.avg_price) * closedQty; // selling to close a long
      pos.qty = next;
      if (next === 0) {
        pos.avg_price = 0;
      } else if (Math.sign(next) !== Math.sign(prev)) {
        pos.avg_price = Math.round(fillPaise);        // reversed into opposite direction
      }
    }

    console.log(`[SimBroker] Filled #${order.order_id}: ${order.order_side} ${order.order_qty} ${order.display_name} @ ₹${(fillPaise / 100).toFixed(2)}`);
  }

  placeOrder(p: {
    nubraName:           string;
    liveRefId:           number;
    display_name?:       string;
    order_type:          string;
    order_side:          string;
    order_qty:           number;
    order_price?:        number;
    trigger_price?:      number;
    order_delivery_type: string;
    validity_type:       string;
    tag?:                string;
  }): SimOrder {
    const id    = this.nextId++;
    const order: SimOrder = {
      order_id:            id,
      ref_id:              p.liveRefId,
      nubraName:           p.nubraName,
      display_name:        p.display_name || p.nubraName,
      order_type:          p.order_type,
      order_side:          p.order_side,
      order_price:         p.order_price   ?? 0,
      trigger_price:       p.trigger_price ?? 0,
      order_qty:           p.order_qty,
      filled_qty:          0,
      avg_filled_price:    0,
      order_status:        'ORDER_STATUS_OPEN',
      order_time:          Date.now() * 1_000_000,
      filled_time:         null,
      order_delivery_type: p.order_delivery_type,
      validity_type:       p.validity_type || 'DAY',
      tag:                 p.tag,
      sl_triggered:        false,
    };
    this.orders.set(id, order);
    this.registerName(p.nubraName, p.liveRefId);

    // Attempt immediate fill if we already have a live tick for this instrument
    const ltp = this.ticks.get(p.liveRefId);
    if (ltp) {
      const half = simSpread(ltp);
      this.tryFill(order, ltp - half, ltp + half);
    }
    return order;
  }

  cancelOrder(id: number): boolean {
    const o = this.orders.get(id);
    if (!o || o.order_status !== 'ORDER_STATUS_OPEN') return false;
    o.order_status = 'ORDER_STATUS_CANCELLED';
    return true;
  }

  modifyOrder(id: number, updates: Record<string, unknown>): boolean {
    const o = this.orders.get(id);
    if (!o || o.order_status !== 'ORDER_STATUS_OPEN') return false;
    if (typeof updates.order_price   === 'number') o.order_price   = updates.order_price;
    if (typeof updates.trigger_price === 'number') o.trigger_price = updates.trigger_price;
    if (typeof updates.order_qty     === 'number') o.order_qty     = updates.order_qty;
    return true;
  }

  getOrders(filter: 'live' | 'executed' | 'all'): SimOrder[] {
    const all = Array.from(this.orders.values()).sort((a, b) => b.order_time - a.order_time);
    if (filter === 'live')     return all.filter(o => o.order_status === 'ORDER_STATUS_OPEN');
    if (filter === 'executed') return all.filter(o => o.order_status !== 'ORDER_STATUS_OPEN');
    return all;
  }

  getPositions(): SimPosition[] {
    return Array.from(this.positions.values()).filter(p => p.qty !== 0);
  }
}

const simBroker   = new SimBroker();
const simOcSubs   = new Set<string>(); // OC keys already subscribed for SimBroker

// Subscribe instrument to the PROD live feed so SimBroker gets fills.
// For options: subscribes the option chain WebSocket stream.
// For stocks/indices: relies on the chart subscription that the browser already manages.
function subscribeForSim(nubraName: string, refId: number, derivativeType?: string, asset?: string, expiry?: string): void {
  simBroker.registerName(nubraName, refId);
  if (!authState.sessionToken || !nubraWs || nubraWs.readyState !== WebSocket.OPEN) return;
  if (derivativeType === 'OPT' && asset && expiry) {
    const key = `${asset}:${expiry}`;
    if (!simOcSubs.has(key)) {
      simOcSubs.add(key);
      const payload = JSON.stringify([{ exchange: 'NSE', asset, expiry }]);
      nubraWs.send(`batch_subscribe ${authState.sessionToken} option ${payload}`);
      console.log(`[SimBroker] Auto-subscribed option chain: ${asset} ${expiry}`);
    }
  }
}

// Route decoded PROD WebSocket ticks into SimBroker for fill evaluation.
function routeTickToSim(decoded: { type: string; data: unknown }): void {
  if (decoded.type === 'option_chain') {
    // Option chain items carry refId directly — most precise path for option fills
    const d = decoded.data as { ce?: unknown[]; pe?: unknown[] };
    for (const item of [...(d.ce ?? []), ...(d.pe ?? [])]) {
      const i = item as { refId?: string; ltp?: string };
      if (i.refId && i.ltp) simBroker.onLtp(Number(i.refId), Number(i.ltp));
    }
  } else if (decoded.type === 'index_tick') {
    // Real-time index / instrument ticks
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const tick of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const t = tick as { indexname?: string; indexValue?: string };
      if (t.indexname && t.indexValue) simBroker.onNamedLtp(t.indexname, Number(t.indexValue));
    }
  } else if (decoded.type === 'ohlcv') {
    // OHLCV candle close as a proxy LTP for chart-subscribed instruments
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const b of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const bucket = b as { indexname?: string; close?: string };
      if (bucket.indexname && bucket.close) simBroker.onNamedLtp(bucket.indexname, Number(bucket.close));
    }
  }
}

// ─── Paper Trading auth status ────────────────────────────────────────────────
fastify.get('/paper/auth/status', async (_req, reply) => {
  return reply.send({ status: authState.status, authenticated: authState.status === 'authenticated' });
});

// ─── Paper Trading routes (SimBroker — local simulation on live PROD data) ────

fastify.get<{ Querystring: { live?: string; executed?: string } }>('/paper/orders', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const filter = req.query.live ? 'live' : req.query.executed ? 'executed' : 'all';
  return reply.send(simBroker.getOrders(filter));
});

interface PaperOrderBody {
  nubraName:           string;
  liveRefId:           number;
  display_name?:       string;
  order_type:          string;
  order_qty:           number;
  order_side:          string;
  order_delivery_type: string;
  validity_type:       string;
  order_price?:        number;
  trigger_price?:      number;
  tag?:                string;
  // For auto-subscription to the live option chain feed
  asset?:              string;
  expiry?:             string;
  derivative_type?:    string;
}

fastify.post<{ Body: PaperOrderBody }>('/paper/orders', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const { nubraName, liveRefId, display_name, order_type, order_qty, order_side,
            order_delivery_type, validity_type, order_price, trigger_price, tag,
            asset, expiry, derivative_type } = req.body;
    if (!liveRefId) return reply.status(400).send({ error: 'liveRefId is required for live simulation.' });

    // Auto-subscribe option chain so fills happen against real-time prices
    subscribeForSim(nubraName, liveRefId, derivative_type, asset, expiry);

    const order = simBroker.placeOrder({
      nubraName, liveRefId, display_name,
      order_type, order_side, order_qty,
      order_price, trigger_price,
      order_delivery_type, validity_type, tag,
    });
    return reply.send({ order_id: order.order_id });
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

interface MultiOrderLeg {
  nubraName:           string;
  liveRefId:           number;
  display_name?:       string;
  order_type:          string;
  order_qty:           number;
  order_side:          string;
  order_delivery_type: string;
  validity_type:       string;
  order_price?:        number;
  trigger_price?:      number;
  asset?:              string;
  expiry?:             string;
  derivative_type?:    string;
}

fastify.post<{ Body: { orders: MultiOrderLeg[] } }>('/paper/orders/multi', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const results = req.body.orders.map((o) => {
      subscribeForSim(o.nubraName, o.liveRefId, o.derivative_type, o.asset, o.expiry);
      return simBroker.placeOrder({
        nubraName:           o.nubraName,
        liveRefId:           o.liveRefId,
        display_name:        o.display_name,
        order_type:          o.order_type,
        order_side:          o.order_side,
        order_qty:           o.order_qty,
        order_price:         o.order_price,
        trigger_price:       o.trigger_price,
        order_delivery_type: o.order_delivery_type,
        validity_type:       o.validity_type,
      });
    });
    return reply.send({ orders: results.map(o => ({ order_id: o.order_id })) });
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

fastify.post('/paper/orders/basket', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const body = req.body as Record<string, unknown>;
    const legs  = (body.orders as Array<Record<string, unknown>>);
    const results = legs.map((o) => {
      const nubraName  = o.nubraName  as string;
      const liveRefId  = o.liveRefId  as number;
      const asset      = o.asset      as string | undefined;
      const expiry     = o.expiry     as string | undefined;
      const derivType  = o.derivative_type as string | undefined;
      subscribeForSim(nubraName, liveRefId, derivType, asset, expiry);
      return simBroker.placeOrder({
        nubraName,
        liveRefId,
        display_name:        o.display_name as string | undefined,
        order_type:          o.order_type          as string,
        order_side:          o.order_side          as string,
        order_qty:           o.order_qty           as number,
        order_price:         o.order_price         as number | undefined,
        trigger_price:       o.trigger_price       as number | undefined,
        order_delivery_type: o.order_delivery_type as string,
        validity_type:       o.validity_type       as string,
        tag:                 o.tag                 as string | undefined,
      });
    });
    return reply.send({ orders: results.map(o => ({ order_id: o.order_id })) });
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/paper/orders/modify/:id', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const ok = simBroker.modifyOrder(Number(req.params.id), req.body);
  if (!ok) return reply.status(404).send({ error: 'Order not found or already filled/cancelled.' });
  return reply.send({ ok: true });
});

fastify.delete<{ Params: { id: string } }>('/paper/orders/:id', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const ok = simBroker.cancelOrder(Number(req.params.id));
  if (!ok) return reply.status(404).send({ error: 'Order not found or cannot be cancelled.' });
  return reply.send({ ok: true });
});

fastify.get('/paper/positions', async (_req, reply) => {
  if (!requireAuth(reply)) return;
  const positions = simBroker.getPositions().map((p) => {
    const ltp             = p.last_traded_price || p.avg_price;
    const isLong          = p.qty > 0;
    // p.qty is signed (negative = short), so this formula is correct for both directions:
    // Long: (ltp-avg)*qty_positive = profit when price rises ✓
    // Short: (ltp-avg)*qty_negative = loss when price rises ✓
    const unrealizedPnl   = (ltp - p.avg_price) * p.qty;
    const totalPnl        = unrealizedPnl + p.realized_pnl;
    // pnlChg as % of notional entry value — correctly signed for long/short
    const pnlChg          = p.avg_price > 0 && p.qty !== 0
      ? (unrealizedPnl / (p.avg_price * Math.abs(p.qty))) * 100
      : 0;
    return {
      ref_id:             p.ref_id,
      display_name:       p.display_name,
      order_side:         isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
      qty:                Math.abs(p.qty),
      avg_price:          p.avg_price,
      last_traded_price:  ltp,
      pnl:                Math.round(totalPnl),
      pnl_chg:            parseFloat(pnlChg.toFixed(2)),
      unrealised_pnl:     Math.round(unrealizedPnl),
      realised_pnl:       Math.round(p.realized_pnl),
      product:            p.order_delivery_type === 'ORDER_DELIVERY_TYPE_IDAY' ? 'MIS' : 'NRML',
    };
  });
  return reply.send(positions);
});

fastify.get('/paper/holdings', async (_req, reply) => {
  if (!requireAuth(reply)) return;
  // SimBroker is designed for intraday/derivative paper trading; holdings are always empty.
  return reply.send([]);
});

fastify.get('/paper/pnl', async (_req, reply) => {
  if (!requireAuth(reply)) return;
  let realised = 0, unrealised = 0;
  for (const p of simBroker.getPositions()) {
    realised += p.realized_pnl;
    const ltp = p.last_traded_price || p.avg_price;
    unrealised += (ltp - p.avg_price) * p.qty;   // signed qty — correct for long/short
  }
  return reply.send({
    realised:   Math.round(realised),
    unrealised: Math.round(unrealised),
    total:      Math.round(realised + unrealised),
  });
});

interface MarginBody {
  liveRefId: number;
  order_qty: number;
  order_side: string;
  order_type: string;
  order_price?: number;
  order_delivery_type: string;
  exchange?: string;
}

fastify.post<{ Body: MarginBody }>('/paper/margin', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const { liveRefId, order_qty, order_side, order_type, order_price, order_delivery_type, exchange = 'NSE' } = req.body;
    // Nubra API: ORDER_TYPE_MARKET is deprecated — use REGULAR + price_type
    const isMarket  = order_type === 'ORDER_TYPE_MARKET' || !order_price;
    const priceType = isMarket ? 'MARKET' : 'LIMIT';
    const order = {
      ref_id:              liveRefId,
      order_side,
      order_qty,
      order_type:          'ORDER_TYPE_REGULAR',
      price_type:          priceType,
      order_price:         order_price ?? 0,
      order_delivery_type,
      validity_type:       'IOC',
      request_type:        'ORDER_REQUEST_NEW',
    };
    const payload = { with_portfolio: true, with_legs: false, is_basket: false, order_req: { exchange, orders: [order] } };
    console.log('[margin] request:', JSON.stringify(payload));
    const data = await nubraPost(
      '/orders/v2/margin_required',
      payload,
      { Authorization: `Bearer ${authState.sessionToken!}` },
    );
    console.log('[margin] response:', JSON.stringify(data));
    return reply.send(data);
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// ─── Startup session restore ──────────────────────────────────────────────────
async function tryRestoreSession(): Promise<void> {
  if (!authState.authToken) return;
  const mpin = process.env.MPIN;
  if (!mpin) return;
  try {
    console.log('Attempting to restore session with saved token…');
    const data = await nubraPost('/verifypin', { pin: mpin }, { Authorization: `Bearer ${authState.authToken}` });
    const sessionToken = (data.session_token || (data.data as Record<string, unknown>)?.token) as string;
    if (!sessionToken) throw new Error('no session_token in response');
    authState.sessionToken = sessionToken;
    authState.status       = 'authenticated';
    console.log('Session restored — OTP not needed.');
    connectNubraWs();
  } catch (err) {
    console.log(`Saved token expired (${(err as Error).message}). Fresh OTP required.`);
    authState.authToken = null;
    authState.status    = 'idle';
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
await loadProto();
await fastify.ready();

httpServer.listen(PORT, async () => {
  console.log(`Nubra Dashboard server → http://localhost:${PORT}`);
  await tryRestoreSession();
});
