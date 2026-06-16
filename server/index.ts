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
    const today = new Date().toISOString().slice(0, 10);
    const data  = await nubraGet(`/refdata/refdata/${today}`, { exchange });
    return reply.send(data);
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
      const today = new Date().toISOString().slice(0, 10);
      const data  = await nubraGet(`/refdata/refdata/${today}`, { exchange });

      const arr: Record<string, unknown>[] = Array.isArray(data.refdata) ? data.refdata as Record<string, unknown>[] :
                  Array.isArray(data.data)    ? data.data as Record<string, unknown>[]    :
                  Array.isArray(data)         ? data as unknown as Record<string, unknown>[] : [];

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
      if (decoded) broadcast(decoded);
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
