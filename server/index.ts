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
import {
  initDb, dbInsertOrder, dbUpdateOrder, dbLoadOrders,
  dbInsertFill, dbUpsertPosition, dbLoadPositions, dbLoadClosedPositions,
  dbInsertPnlTick, dbUpsertName, dbLoadNameMap,
  dbGetMeta, dbSetMeta,
  dbInsertBasket, dbLoadBaskets, dbDeleteBasket, dbUpdateBasket, dbRenameStrategy, dbRenameSavedBasket,
  dbUpsertOcSub, dbLoadOcSubs,
  dbUpsertSnapshot, dbListSnapshots, dbGetSnapshot, dbDeleteSnapshot,
} from './paperDb.ts';
import { buildBasketSnapshot, istDateString, type SnapPosition } from './snapshotBuilder.ts';
import { getMeta as btGetMeta, runBacktest, runDayDetail, validateConfig, validateSweep, runSweep, validateWalkForward, runWalkForward } from './backtest/index.ts';
import type { BacktestConfig, SweepRequest, WalkForwardRequest } from './backtest/types.ts';
import protobuf from 'protobufjs';

dotenv.config();
initDb();

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

// ─── Instrument lookup by ref_id ──────────────────────────────────────────────
fastify.get<{ Querystring: { ref_id?: string; exchange?: string } }>(
  '/api/instruments/lookup',
  async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const refId = Number(req.query.ref_id);
      if (!refId) return reply.status(400).send({ error: 'ref_id required' });
      const arr = await getRefdata(req.query.exchange || 'NSE');
      const match = arr.find((item) => (item as Record<string, unknown>).ref_id === refId);
      return reply.send({ instrument: match || null });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
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
      const chain = (data.chain || data) as Record<string, unknown>;

      // Enrich legs with stock_name from refdata so frontend can call historical timeseries
      try {
        const refdata = await getRefdata(exchange);
        const refById = new Map<number, string>();
        for (const r of refdata) {
          if (r.ref_id != null && r.stock_name) refById.set(Number(r.ref_id), String(r.stock_name));
        }
        for (const side of ['ce', 'pe'] as const) {
          const legs = chain[side];
          if (!Array.isArray(legs)) continue;
          for (const leg of legs as Record<string, unknown>[]) {
            const rid = Number(leg.ref_id);
            if (rid && refById.has(rid)) leg.symbol = refById.get(rid);
          }
        }
        let enriched = 0;
        for (const side of ['ce', 'pe'] as const) {
          const legs = chain[side];
          if (Array.isArray(legs)) enriched += (legs as Record<string, unknown>[]).filter(l => l.symbol).length;
        }
        console.log(`[OC] Enriched ${enriched} legs with symbol from refdata (${refById.size} ref entries)`);
      } catch (e) { console.warn('[OC] refdata enrichment failed:', e); }

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
    bootstrapPositionSubs().then(() => sendAllOcSubs()).catch(e => console.error('[Bootstrap]', e));
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
        const userPayload = (msg.payload || {}) as Record<string, unknown>;
        const payload  = JSON.stringify({ instruments: [], indexes: [], ...userPayload });
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
        const asset   = msg.asset || '';
        const expiry  = msg.expiry || '';
        const payload = JSON.stringify([{ exchange: msg.exchange || 'NSE', asset, expiry }]);
        const cmd     = `${verb} ${token} option ${payload}`;
        if (msg.action === 'subscribe_oc' && asset && expiry) {
          const key = `${asset}:${expiry}`;
          if (!simOcSubs.has(key)) { simOcSubs.add(key); dbUpsertOcSub(key); }
        }
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
  basket_group_id?:    string;
  strategy_name?:      string;
  margin_required?:    number;          // paise, basket-level margin snapshot
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
  basket_group_id?:    string;
  strategy_name?:      string;
  entry_time?:         number;          // nanoseconds epoch
  exit_time?:          number;          // nanoseconds epoch
  exit_price?:         number;          // paise
  margin_required?:    number;          // paise, snapshot at entry
  entry_qty?:          number;          // original entry qty (positive=long, negative=short), preserved after close
}

class SimBroker {
  private orders    = new Map<number, SimOrder>();
  private positions = new Map<string, SimPosition>();  // key: "ref_id:basket_group_id"
  private ticks     = new Map<number, number>();     // ref_id → ltp paise
  private nameMap   = new Map<string, number>();     // normalised name → ref_id
  private nextId    = 1;
  private pnlTickCounter = 0;

  private posKey(refId: number, basketGroupId?: string): string {
    return `${refId}:${basketGroupId || ''}`;
  }

  restore(): void {
    this.nameMap = dbLoadNameMap();
    const savedNextId = dbGetMeta('nextOrderId');
    if (savedNextId) this.nextId = Number(savedNextId);

    for (const row of dbLoadOrders()) {
      const o: SimOrder = {
        order_id: row.order_id as number, ref_id: row.ref_id as number,
        nubraName: row.nubra_name as string, display_name: row.display_name as string,
        order_type: row.order_type as string, order_side: row.order_side as string,
        order_price: row.order_price as number, trigger_price: row.trigger_price as number,
        order_qty: row.order_qty as number, filled_qty: row.filled_qty as number,
        avg_filled_price: row.avg_filled_price as number, order_status: row.order_status as string,
        order_time: row.order_time as number, filled_time: row.filled_time as number | null,
        order_delivery_type: row.order_delivery_type as string,
        validity_type: row.validity_type as string, tag: row.tag as string | undefined,
        sl_triggered: !!(row.sl_triggered as number),
        basket_group_id: row.basket_group_id as string | undefined,
        strategy_name: row.strategy_name as string | undefined,
      };
      this.orders.set(o.order_id, o);
      if (o.order_id >= this.nextId) this.nextId = o.order_id + 1;
    }

    for (const row of [...dbLoadPositions(), ...dbLoadClosedPositions()]) {
      const p: SimPosition = {
        ref_id: row.ref_id as number, nubraName: row.nubra_name as string,
        display_name: row.display_name as string, qty: row.qty as number,
        avg_price: row.avg_price as number, realized_pnl: row.realized_pnl as number,
        last_traded_price: row.last_traded_price as number,
        order_delivery_type: row.order_delivery_type as string,
        basket_group_id: (row.basket_group_id as string) || '',
        strategy_name: row.strategy_name as string | undefined,
        entry_time: row.entry_time as number | undefined,
        exit_time: row.exit_time as number | undefined,
        exit_price: row.exit_price as number | undefined,
        margin_required: row.margin_required as number | undefined,
      };
      this.positions.set(this.posKey(p.ref_id, p.basket_group_id), p);
      if (p.qty !== 0) this.ticks.set(p.ref_id, p.last_traded_price);
    }
    console.log(`[SimBroker] Restored ${this.orders.size} orders, ${this.positions.size} positions`);
  }

  registerName(nubraName: string, refId: number): void {
    const norm = nubraName.toLowerCase().replace(/^(nse|bse)_/, '');
    const lower = nubraName.toLowerCase();
    if (!this.nameMap.has(lower)) {
      this.nameMap.set(lower, refId);
      dbUpsertName(lower, refId);
    }
    if (norm !== lower && !this.nameMap.has(norm)) {
      this.nameMap.set(norm, refId);
      dbUpsertName(norm, refId);
    }
  }

  onLtp(refId: number, ltpPaise: number): { ref_id: number; ltp: number }[] {
    if (ltpPaise <= 0) return [];
    const prev = this.ticks.get(refId);
    this.ticks.set(refId, ltpPaise);
    const changed: { ref_id: number; ltp: number }[] = [];
    for (const pos of this.positions.values()) {
      if (pos.ref_id !== refId) continue;
      if (pos.qty !== 0 && pos.last_traded_price !== ltpPaise) {
        changed.push({ ref_id: pos.ref_id, ltp: ltpPaise });
      }
      pos.last_traded_price = ltpPaise;
      if (pos.qty !== 0 && (++this.pnlTickCounter % 5 === 0)) {
        const unrealized = (ltpPaise - pos.avg_price) * pos.qty;
        dbInsertPnlTick({
          ts: Date.now(), ref_id: refId, ltp: ltpPaise,
          qty: pos.qty, avg_price: pos.avg_price,
          unrealized_pnl: unrealized, realized_pnl: pos.realized_pnl,
          total_pnl: unrealized + pos.realized_pnl,
        });
      }
    }
    if (prev !== ltpPaise) this.checkFills(refId, ltpPaise);
    return changed;
  }

  // Called for index / OHLCV ticks (identified by name string)
  onNamedLtp(rawName: string, ltpPaise: number): { ref_id: number; ltp: number }[] {
    if (ltpPaise <= 0) return [];
    const norm  = rawName.toLowerCase().replace(/^(nse|bse)_/, '');
    const refId = this.nameMap.get(norm) ?? this.nameMap.get(rawName.toLowerCase());
    if (refId !== undefined) return this.onLtp(refId, ltpPaise);
    return [];
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
    const key = this.posKey(order.ref_id, order.basket_group_id);
    let pos = this.positions.get(key);

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
        basket_group_id:     order.basket_group_id || '',
        strategy_name:       order.strategy_name,
        margin_required:     order.margin_required,
      };
      this.positions.set(key, pos);
    }

    const prev = pos.qty;
    const next = prev + delta;

    if (prev === 0) {
      pos.qty       = delta;
      pos.avg_price = Math.round(fillPaise);
      pos.entry_time = order.filled_time ?? Date.now() * 1_000_000;
      pos.exit_time  = undefined;
      pos.exit_price = undefined;
      pos.entry_qty  = delta;
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
        pos.exit_time  = order.filled_time ?? Date.now() * 1_000_000;
        pos.exit_price = Math.round(fillPaise);
      } else if (Math.sign(next) !== Math.sign(prev)) {
        pos.avg_price = Math.round(fillPaise);        // reversed into opposite direction
      }
    }

    // Persist to SQLite
    dbUpdateOrder({
      order_id: order.order_id, filled_qty: order.filled_qty,
      avg_filled_price: order.avg_filled_price, order_status: order.order_status,
      filled_time: order.filled_time, sl_triggered: order.sl_triggered,
    });
    dbInsertFill({
      order_id: order.order_id, ref_id: order.ref_id,
      fill_price: Math.round(fillPaise), fill_qty: order.order_qty,
      fill_time: order.filled_time!, side: order.order_side,
    });
    dbUpsertPosition({
      ref_id: pos.ref_id, nubraName: pos.nubraName, display_name: pos.display_name,
      qty: pos.qty, avg_price: pos.avg_price, realized_pnl: pos.realized_pnl,
      last_traded_price: pos.last_traded_price, order_delivery_type: pos.order_delivery_type,
      basket_group_id: pos.basket_group_id, strategy_name: pos.strategy_name,
      entry_time: pos.entry_time, exit_time: pos.exit_time, exit_price: pos.exit_price,
      margin_required: pos.margin_required,
    });
    // Record P&L at fill time
    const unrealizedAtFill = (pos.last_traded_price - pos.avg_price) * pos.qty;
    dbInsertPnlTick({
      ts: Date.now(), ref_id: pos.ref_id, ltp: pos.last_traded_price,
      qty: pos.qty, avg_price: pos.avg_price,
      unrealized_pnl: unrealizedAtFill, realized_pnl: pos.realized_pnl,
      total_pnl: unrealizedAtFill + pos.realized_pnl,
    });

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
    basket_group_id?:    string;
    strategy_name?:      string;
    margin_required?:    number;
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
      basket_group_id:     p.basket_group_id,
      strategy_name:       p.strategy_name,
      margin_required:     p.margin_required,
    };
    this.orders.set(id, order);
    this.registerName(p.nubraName, p.liveRefId);
    dbInsertOrder(order);
    dbSetMeta('nextOrderId', String(this.nextId));

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
    dbUpdateOrder({ order_id: o.order_id, filled_qty: o.filled_qty, avg_filled_price: o.avg_filled_price, order_status: o.order_status, filled_time: o.filled_time, sl_triggered: o.sl_triggered });
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

  getClosedPositions(): SimPosition[] {
    return Array.from(this.positions.values()).filter(p => p.qty === 0 && p.realized_pnl !== 0);
  }

  renameStrategy(basketGroupId: string, newName: string): boolean {
    let found = false;
    for (const o of this.orders.values()) {
      if (o.basket_group_id === basketGroupId) { o.strategy_name = newName; found = true; }
    }
    for (const p of this.positions.values()) {
      if (p.basket_group_id === basketGroupId) { p.strategy_name = newName; found = true; }
    }
    if (found) dbRenameStrategy(basketGroupId, newName);
    return found;
  }
}

const simBroker   = new SimBroker();
simBroker.restore();

// ─── End-of-day auto-snapshot ────────────────────────────────────────────────
// After market close, freeze a chart snapshot for every basket that traded today and doesn't already
// have one (manual saves take precedence via dbSnapshotExists). The server holds the WS connection and
// the simulated book, so this works even with no browser open.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function simToSnapPosition(p: SimPosition): SnapPosition {
  const closed = p.qty === 0;
  if (!closed) {
    return {
      ref_id: p.ref_id, display_name: p.display_name, zanskar_name: p.nubraName,
      order_side: p.qty > 0 ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL', qty: Math.abs(p.qty),
      avg_price: p.avg_price, realised_pnl: Math.round(p.realized_pnl),
      entry_time: p.entry_time, derivative_type: 'OPT',
    };
  }
  // Closed: mirror the /paper/positions/closed mapping for qty/side.
  const entryQty = p.entry_qty ?? 0;
  const priceDiff = Math.abs((p.exit_price || 0) - p.avg_price);
  const derivedQty = entryQty !== 0 ? Math.abs(entryQty) : (priceDiff > 0 ? Math.round(Math.abs(p.realized_pnl) / priceDiff) : 0);
  const isLong = entryQty > 0 || (entryQty === 0 && p.realized_pnl > 0 && (p.exit_price || 0) > p.avg_price);
  return {
    ref_id: p.ref_id, display_name: p.display_name, zanskar_name: p.nubraName,
    order_side: isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL', qty: derivedQty,
    avg_price: p.avg_price, realised_pnl: Math.round(p.realized_pnl),
    entry_time: p.entry_time, exit_time: p.exit_time, exit_price: p.exit_price, derivative_type: 'OPT',
  };
}

async function runEodSnapshots(): Promise<void> {
  if (authState.status !== 'authenticated' || !authState.sessionToken) return;
  const byBasket = new Map<string, SimPosition[]>();
  for (const p of [...simBroker.getPositions(), ...simBroker.getClosedPositions()]) {
    if (!p.basket_group_id) continue;
    if (!byBasket.has(p.basket_group_id)) byBasket.set(p.basket_group_id, []);
    byBasket.get(p.basket_group_id)!.push(p);
  }
  const fetchTs = (body: object) => nubraPost('/charts/timeseries', body, { Authorization: `Bearer ${authState.sessionToken!}` });
  const today = istDateString(Date.now() * 1_000_000);
  let saved = 0;
  for (const [basketId, group] of byBasket) {
    const entryTimes = group.map(p => p.entry_time || 0).filter(t => t > 0);
    if (entryTimes.length === 0) continue;
    const tradeDate = istDateString(Math.min(...entryTimes));
    if (tradeDate !== today) continue;                          // only finalize today's trades
    const existing = dbGetSnapshot(`${basketId}__${tradeDate}`);
    if (existing?.source === 'manual') continue;                // preserve explicit manual saves
    const strategyName = group.find(p => p.strategy_name)?.strategy_name || null;
    try {
      const built = await buildBasketSnapshot(group.map(simToSnapPosition), fetchTs);
      if (!built) continue;
      dbUpsertSnapshot({
        snapshot_id: `${basketId}__${built.tradeDate}`, basket_group_id: basketId,
        strategy_name: strategyName, underlying: built.underlying, trade_date: built.tradeDate,
        total_pnl: built.totalPnl, leg_count: built.legCount, source: 'eod',
        data_json: JSON.stringify(built.data),
      });
      saved++;
    } catch (e) {
      console.warn(`[EOD] snapshot failed for ${basketId}:`, (e as Error).message);
    }
  }
  if (saved > 0) console.log(`[EOD] Auto-saved ${saved} strategy snapshot(s)`);
}

let _lastEodDate = '';
setInterval(() => {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const dow = ist.getUTCDay();                       // 0=Sun .. 6=Sat
  const afterClose = ist.getUTCHours() > 15 || (ist.getUTCHours() === 15 && ist.getUTCMinutes() >= 35);
  const istDate = istDateString(Date.now() * 1_000_000);
  if (afterClose && dow >= 1 && dow <= 5 && _lastEodDate !== istDate) {
    _lastEodDate = istDate;
    runEodSnapshots().catch(e => console.warn('[EOD] run failed:', (e as Error).message));
  }
}, 60_000);
const simOcSubs   = new Set<string>(dbLoadOcSubs());

// Subscribe instrument to the PROD live feed so SimBroker gets fills.
// For options: subscribes the option chain WebSocket stream.
// For stocks/indices: relies on the chart subscription that the browser already manages.
function subscribeForSim(nubraName: string, refId: number, derivativeType?: string, asset?: string, expiry?: string): void {
  simBroker.registerName(nubraName, refId);
  if (asset && expiry) {
    const key = `${asset}:${expiry}`;
    if (!simOcSubs.has(key)) {
      simOcSubs.add(key);
      dbUpsertOcSub(key);
      if (nubraWs && nubraWs.readyState === WebSocket.OPEN && authState.sessionToken) {
        const payload = JSON.stringify([{ exchange: 'NSE', asset, expiry }]);
        nubraWs.send(`batch_subscribe ${authState.sessionToken} option ${payload}`);
        console.log(`[SimBroker] Auto-subscribed option chain: ${asset} ${expiry}`);
      }
    }
  }
}

function sendAllOcSubs(): void {
  if (!nubraWs || nubraWs.readyState !== WebSocket.OPEN || !authState.sessionToken) return;
  for (const key of simOcSubs) {
    const [asset, expiry] = key.split(':');
    const payload = JSON.stringify([{ exchange: 'NSE', asset, expiry }]);
    nubraWs.send(`batch_subscribe ${authState.sessionToken} option ${payload}`);
  }
  if (simOcSubs.size > 0) console.log(`[WS] Subscribed ${simOcSubs.size} OC feeds`);
}

async function bootstrapPositionSubs(): Promise<void> {
  const positions = simBroker.getPositions();
  if (positions.length === 0) return;
  const assets = new Set<string>();
  for (const p of positions) {
    const m = p.display_name.match(/^([A-Z]+)/);
    if (m) assets.add(m[1]);
  }
  for (const asset of assets) {
    try {
      const data = await nubraGet(`/optionchains/${asset}`, { exchange: 'NSE' });
      const chain = (data.chain || data) as Record<string, unknown>;
      const allExp = (chain.all_expiries || []) as string[];
      const today  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const future = allExp.filter(e => e >= today).sort();
      const toSub  = future.slice(0, 4);
      for (const exp of toSub) {
        const key = `${asset}:${exp}`;
        if (!simOcSubs.has(key)) {
          simOcSubs.add(key);
          dbUpsertOcSub(key);
          console.log(`[Bootstrap] Added OC sub: ${key}`);
        }
      }
    } catch (err) {
      console.error(`[Bootstrap] Failed to fetch expiries for ${asset}:`, (err as Error).message);
    }
  }
  sendAllOcSubs();
}

// Route decoded PROD WebSocket ticks into SimBroker for fill evaluation.
// Broadcasts position LTP changes to browser clients for tick-by-tick P&L.
let _ocFieldLogDone = false;
let _posLtpBuffer: { ref_id: number; ltp: number }[] = [];
let _posLtpTimer: ReturnType<typeof setTimeout> | null = null;

function flushPosLtp(): void {
  _posLtpTimer = null;
  if (_posLtpBuffer.length === 0) return;
  const deduped = new Map<number, number>();
  for (const u of _posLtpBuffer) deduped.set(u.ref_id, u.ltp);
  _posLtpBuffer = [];
  broadcast({ type: 'position_ltp', data: Array.from(deduped, ([ref_id, ltp]) => ({ ref_id, ltp })) });
}

function queuePosLtp(changes: { ref_id: number; ltp: number }[]): void {
  if (changes.length === 0) return;
  _posLtpBuffer.push(...changes);
  if (!_posLtpTimer) _posLtpTimer = setTimeout(flushPosLtp, 200);
}

function routeTickToSim(decoded: { type: string; data: unknown }): void {
  if (decoded.type === 'option_chain') {
    const d = decoded.data as { ce?: unknown[]; pe?: unknown[] };
    const allItems = [...(d.ce ?? []), ...(d.pe ?? [])];
    if (!_ocFieldLogDone && allItems.length > 0) {
      const sample = allItems[0] as Record<string, unknown>;
      console.log('[SimBroker] OC item field names:', Object.keys(sample).join(', '));
      console.log('[SimBroker] OC item sample:', JSON.stringify(sample).slice(0, 200));
      _ocFieldLogDone = true;
    }
    for (const item of allItems) {
      const i = item as Record<string, unknown>;
      const refId = i.refId ?? i.ref_id;
      const ltp   = i.ltp;
      if (refId && ltp) {
        const changes = simBroker.onLtp(Number(refId), Number(ltp));
        queuePosLtp(changes);
      }
    }
  } else if (decoded.type === 'index_tick') {
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const tick of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const t = tick as Record<string, unknown>;
      const name = t.indexname as string | undefined;
      const val  = t.indexValue ?? t.index_value;
      if (name && val) queuePosLtp(simBroker.onNamedLtp(name, Number(val)));
    }
  } else if (decoded.type === 'ohlcv') {
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const b of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const bucket = b as Record<string, unknown>;
      const name  = bucket.indexname as string | undefined;
      const close = bucket.close;
      if (name && close) queuePosLtp(simBroker.onNamedLtp(name, Number(close)));
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
  basket_group_id?:    string;
  strategy_name?:      string;
}

fastify.post<{ Body: PaperOrderBody }>('/paper/orders', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const { nubraName, liveRefId, display_name, order_type, order_qty, order_side,
            order_delivery_type, validity_type, order_price, trigger_price, tag,
            asset, expiry, derivative_type, basket_group_id, strategy_name } = req.body;
    if (!liveRefId) return reply.status(400).send({ error: 'liveRefId is required for live simulation.' });

    // Auto-subscribe option chain so fills happen against real-time prices
    subscribeForSim(nubraName, liveRefId, derivative_type, asset, expiry);

    const order = simBroker.placeOrder({
      nubraName, liveRefId, display_name,
      order_type, order_side, order_qty,
      order_price, trigger_price,
      order_delivery_type, validity_type, tag,
      basket_group_id, strategy_name,
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
    if (!Array.isArray(req.body?.orders) || req.body.orders.length === 0)
      return reply.status(400).send({ error: 'orders must be a non-empty array' });
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
    if (!Array.isArray(legs) || legs.length === 0)
      return reply.status(400).send({ error: 'orders must be a non-empty array' });
    if (legs.some(l => !l.liveRefId))
      return reply.status(400).send({ error: 'every leg must have a liveRefId' });
    const strategyName = (body.strategy_name as string) || undefined;
    const marginRequired = typeof body.margin_required === 'number' ? body.margin_required : undefined;
    const basketGroupId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
        basket_group_id:     basketGroupId,
        strategy_name:       strategyName,
        margin_required:     marginRequired,
      });
    });
    return reply.send({ orders: results.map(o => ({ order_id: o.order_id })), basket_group_id: basketGroupId });
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
      zanskar_name:       p.nubraName,
      order_side:         isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
      qty:                Math.abs(p.qty),
      avg_price:          p.avg_price,
      last_traded_price:  ltp,
      pnl:                Math.round(totalPnl),
      pnl_chg:            parseFloat(pnlChg.toFixed(2)),
      unrealised_pnl:     Math.round(unrealizedPnl),
      realised_pnl:       Math.round(p.realized_pnl),
      product:            p.order_delivery_type === 'ORDER_DELIVERY_TYPE_IDAY' ? 'MIS' : 'NRML',
      basket_group_id:    p.basket_group_id || undefined,
      strategy_name:      p.strategy_name || undefined,
      entry_time:         p.entry_time || undefined,
      margin_required:    p.margin_required || undefined,
    };
  });
  return reply.send(positions);
});

fastify.get('/paper/positions/closed', async (_req, reply) => {
  if (!requireAuth(reply)) return;
  const closed = simBroker.getClosedPositions().map((p) => {
    const entryQty = p.entry_qty ?? 0;
    const priceDiff = Math.abs((p.exit_price || 0) - p.avg_price);
    const derivedQty = entryQty !== 0 ? Math.abs(entryQty) : (priceDiff > 0 ? Math.round(Math.abs(p.realized_pnl) / priceDiff) : 0);
    const isLong = entryQty > 0 || (entryQty === 0 && p.realized_pnl > 0 && (p.exit_price || 0) > p.avg_price);
    return {
      ref_id:        p.ref_id,
      display_name:  p.display_name,
      zanskar_name:  p.nubraName,
      order_side:    isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
      qty:           derivedQty,
      avg_price:     p.avg_price,
      last_traded_price: p.last_traded_price,
      pnl:           Math.round(p.realized_pnl),
      realised_pnl:  Math.round(p.realized_pnl),
      product:       p.order_delivery_type === 'ORDER_DELIVERY_TYPE_IDAY' ? 'MIS' : 'NRML',
      basket_group_id: p.basket_group_id || undefined,
      strategy_name:   p.strategy_name || undefined,
      entry_time:      p.entry_time || undefined,
      exit_time:       p.exit_time || undefined,
      exit_price:      p.exit_price || undefined,
      margin_required: p.margin_required || undefined,
    };
  });
  return reply.send(closed);
});

fastify.get('/paper/debug', async (_req, reply) => {
  const posRefIds = simBroker.getPositions().map(p => p.ref_id);
  return reply.send({
    ocSubs: [...simOcSubs],
    positionRefIds: posRefIds,
    wsConnected: nubraWs?.readyState === WebSocket.OPEN,
    ocFieldLogDone: _ocFieldLogDone,
  });
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
    unrealised += (ltp - p.avg_price) * p.qty;
  }
  for (const p of simBroker.getClosedPositions()) {
    realised += p.realized_pnl;
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

interface BasketMarginBody {
  exchange?: string;
  orders: Array<{
    ref_id: number;
    order_qty: number;
    order_side: string;
    order_type: string;
    order_price?: number;
    order_delivery_type: string;
  }>;
}

fastify.post<{ Body: BasketMarginBody }>('/paper/margin/basket', async (req, reply) => {
  if (!requireAuth(reply)) return;
  try {
    const { exchange = 'NSE', orders, multiplier = 1 } = req.body as BasketMarginBody & { multiplier?: number };

    const apiOrders = orders.map(o => ({
      ref_id:              o.ref_id,
      order_qty:           o.order_qty,
      order_side:          o.order_side,
      order_delivery_type: o.order_delivery_type,
    }));

    // Determine dominant side/delivery from first order
    const firstOrder = orders[0];
    const payload = {
      with_portfolio: true,
      with_legs: true,
      is_basket: true,
      order_req: {
        exchange,
        orders: apiOrders,
        basket_params: {
          order_side:          firstOrder?.order_side || 'ORDER_SIDE_BUY',
          order_delivery_type: firstOrder?.order_delivery_type || 'ORDER_DELIVERY_TYPE_IDAY',
          price_type:          'MARKET',
          multiplier:          multiplier,
        },
      },
    };
    console.log('[basket-margin] request:', JSON.stringify(payload));
    const data = await nubraPost(
      '/orders/v2/margin_required',
      payload,
      { Authorization: `Bearer ${authState.sessionToken!}` },
    );
    console.log('[basket-margin] response:', JSON.stringify(data));
    return reply.send(data);
  } catch (err: unknown) {
    return reply.status(500).send({ error: (err as Error).message });
  }
});

// ─── Saved Baskets CRUD ─────────────────────────────────────────────────────

fastify.get('/paper/baskets', async (_req, reply) => {
  if (!requireAuth(reply)) return;
  const baskets = dbLoadBaskets().map(b => ({
    ...b,
    legs: JSON.parse(b.legs_json),
    legs_json: undefined,
  }));
  return reply.send({ baskets });
});

fastify.post<{ Body: { name: string; symbol: string; expiry: string; legs: unknown[]; basket_group_id?: string } }>('/paper/baskets', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const { name, symbol, expiry, legs, basket_group_id } = req.body;
  const basketId = `bsk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();
  dbInsertBasket({
    basket_id: basketId, name, symbol, expiry,
    legs_json: JSON.stringify(legs),
    created_at: now, updated_at: now,
    basket_group_id: basket_group_id || undefined,
  });
  return reply.send({ basket_id: basketId });
});

fastify.delete<{ Params: { id: string } }>('/paper/baskets/:id', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const ok = dbDeleteBasket(req.params.id);
  if (!ok) return reply.status(404).send({ error: 'Basket not found' });
  return reply.send({ ok: true });
});

fastify.put<{ Params: { id: string }; Body: { name?: string; legs?: unknown[] } }>('/paper/baskets/:id', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const { name, legs } = req.body;
  if (name?.trim()) {
    const result = dbRenameSavedBasket(req.params.id, name.trim());
    if (result.basket_group_id) simBroker.renameStrategy(result.basket_group_id, name.trim());
  }
  if (legs) {
    const existing = dbLoadBaskets().find(b => b.basket_id === req.params.id);
    if (existing) dbUpdateBasket(req.params.id, existing.name, JSON.stringify(legs));
  }
  return reply.send({ ok: true });
});

fastify.put<{ Body: { basket_group_id: string; name: string } }>('/paper/strategy/rename', async (req, reply) => {
  if (!requireAuth(reply)) return;
  const { basket_group_id, name } = req.body;
  if (!basket_group_id || !name?.trim()) return reply.status(400).send({ error: 'basket_group_id and name required' });
  const ok = simBroker.renameStrategy(basket_group_id, name.trim());
  if (!ok) return reply.status(404).send({ error: 'No orders/positions found for this group' });
  return reply.send({ ok: true });
});

// ─── Strategy snapshots (frozen day-charts) ───────────────────────────────────
interface SnapshotBody {
  basket_group_id: string; trade_date: string; strategy_name?: string;
  underlying?: string; total_pnl?: number; leg_count?: number; source?: string;
  data: unknown;
}

fastify.post<{ Body: SnapshotBody }>('/paper/strategy/snapshot', async (req, reply) => {
  const b = req.body;
  if (!b?.basket_group_id || !b?.trade_date || b.data == null) {
    return reply.status(400).send({ error: 'basket_group_id, trade_date and data required' });
  }
  const snapshot_id = `${b.basket_group_id}__${b.trade_date}`;
  try {
    dbUpsertSnapshot({
      snapshot_id, basket_group_id: b.basket_group_id, strategy_name: b.strategy_name ?? null,
      underlying: b.underlying ?? null, trade_date: b.trade_date, total_pnl: b.total_pnl ?? 0,
      leg_count: b.leg_count ?? 0, source: b.source ?? 'manual', data_json: JSON.stringify(b.data),
    });
    return reply.send({ ok: true, snapshot_id });
  } catch (err: unknown) {
    return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

fastify.get('/paper/strategy/snapshots', async (_req, reply) => {
  return reply.send({ snapshots: dbListSnapshots() });
});

fastify.get<{ Params: { id: string } }>('/paper/strategy/snapshot/:id', async (req, reply) => {
  const row = dbGetSnapshot(req.params.id);
  if (!row) return reply.status(404).send({ error: 'snapshot not found' });
  let data: unknown = null;
  try { data = JSON.parse(row.data_json); } catch { /* corrupt blob → null */ }
  const { data_json: _omit, ...meta } = row;
  return reply.send({ ...meta, data });
});

fastify.delete<{ Params: { id: string } }>('/paper/strategy/snapshot/:id', async (req, reply) => {
  const ok = dbDeleteSnapshot(req.params.id);
  if (!ok) return reply.status(404).send({ error: 'snapshot not found' });
  return reply.send({ ok: true });
});

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

// ─── Backtest ─────────────────────────────────────────────────────────────────
fastify.get('/api/backtest/meta', async (_req, reply) => {
  try {
    return await btGetMeta();
  } catch (err) {
    reply.code(500);
    return { error: (err as Error).message };
  }
});

fastify.post<{ Body: BacktestConfig }>('/api/backtest/run', async (req, reply) => {
  const cfg = req.body;
  const err = validateConfig(cfg);
  if (err) { reply.code(400); return { ok: false, error: err }; }
  try {
    const t0 = Date.now();
    const res = await runBacktest(cfg);
    console.log(`Backtest ${cfg.underlying} ${cfg.from}→${cfg.to}: ${res.trades.length} trades in ${Date.now() - t0}ms`);
    return res;
  } catch (e) {
    reply.code(500);
    return { ok: false, error: (e as Error).message };
  }
});

fastify.post<{ Body: { config: BacktestConfig; date: string } }>('/api/backtest/day', async (req, reply) => {
  const { config, date } = req.body ?? {} as { config: BacktestConfig; date: string };
  const err = validateConfig(config);
  if (err) { reply.code(400); return { ok: false, error: err }; }
  try {
    return await runDayDetail(config, date);
  } catch (e) {
    reply.code(500);
    return { ok: false, error: (e as Error).message };
  }
});

fastify.post<{ Body: SweepRequest }>('/api/backtest/sweep', async (req, reply) => {
  const sw = req.body;
  const err = validateSweep(sw);
  if (err) { reply.code(400); return { ok: false, error: err }; }
  try {
    const t0 = Date.now();
    const res = await runSweep(sw);
    console.log(`Sweep ${sw.base.underlying} ${sw.param1.path} [${sw.param1.from}→${sw.param1.to}]: ${res.cells.length} cells in ${Date.now() - t0}ms`);
    return res;
  } catch (e) {
    reply.code(500);
    return { ok: false, error: (e as Error).message };
  }
});

fastify.post<{ Body: WalkForwardRequest }>('/api/backtest/walkforward', async (req, reply) => {
  const wf = req.body;
  const err = validateWalkForward(wf);
  if (err) { reply.code(400); return { ok: false, error: err }; }
  try {
    const t0 = Date.now();
    const res = await runWalkForward(wf);
    console.log(`Walk-forward ${wf.base.underlying} ${wf.windows}w ${wf.param.path}: ${res.windows.length} windows in ${Date.now() - t0}ms`);
    return res;
  } catch (e) {
    reply.code(500);
    return { ok: false, error: (e as Error).message };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
await loadProto();
await fastify.ready();

httpServer.listen(PORT, async () => {
  console.log(`Nubra Dashboard server → http://localhost:${PORT}`);
  await tryRestoreSession();
});
