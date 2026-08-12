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
  initDb,
  dbUpsertOcSub,
  dbLoadOcSubs,
  dbDeleteOcSub,
  dbUpsertSnapshot,
  dbGetSnapshot,
} from './paperDb.ts';
import { buildBasketSnapshot, istDateString, type SnapPosition } from './snapshotBuilder.ts';
import { registerBacktestRoutes } from './backtest/routes.ts';
import { registerNubraBacktestRoutes } from './nubraBacktestRoutes.ts';
import { registerMarketDataRoutes } from './marketDataRoutes.ts';
import { registerAuthRoutes } from './authRoutes.ts';
import { registerPaperRoutes } from './paperRoutes.ts';
import { SimBroker, type SimPosition } from './simBroker.ts';
import {
  feedKey,
  parseFeedKey,
  parseDisplayName,
  requiredFeedKeys,
  staleRequiredFeeds,
  isMarketHours,
  pruneOcSubKeys,
  istToday,
  type FeedIndex,
} from './ocFeedGuard.ts';
import { loadPositionRules, evaluateAndFire } from './positionRules.ts';
import { createRefdataCache } from './refdataCache.ts';
import { describeUpstreamError, isTransportError, upstreamTimeoutMs } from './upstreamError.ts';
import { chartSubscriptionKey, type ChartSubscription } from '../src/lib/chartSubRegistry.ts';
import protobuf from 'protobufjs';

dotenv.config();
initDb();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = process.env.NUBRA_BASE_URL || 'https://api2.nubra.io';
const MARGIN_BASE_URL = process.env.NUBRA_MARGIN_BASE_URL || BASE_URL;
const PORT = Number(process.env.SERVER_PORT || 3000);

// ─── Server-side refdata cache ────────────────────────────────────────────────
// Avoids fetching 100k+ instrument records from Nubra on every search keystroke.
// See refdataCache.ts for why this single-flights and evicts empty/failed results.
const { getRefdata, peekRefdata } = createRefdataCache({ nubraGet: (e, p) => nubraGet(e, p) });

import crypto from 'crypto';

const CRYPTO_ALGORITHM = 'aes-256-cbc';

function getCryptoKey(salt: string): Buffer {
  return crypto.scryptSync(salt || 'nubra-default-salt-key', 'salt', 32);
}

function encrypt(text: string, salt: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CRYPTO_ALGORITHM, getCryptoKey(salt), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string, salt: string): string {
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts.shift()!, 'hex');
    const encryptedText = Buffer.from(parts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(CRYPTO_ALGORITHM, getCryptoKey(salt), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
}

// ─── Session persistence ──────────────────────────────────────────────────────
const SESSION_FILE = path.join(__dirname, '..', 'session.json');

interface SavedSession {
  deviceId?: string;
  salt?: string;
  phone?: string;
  authToken?: string;
  sessionToken?: string;
  mpin?: string;
}

function loadSavedSession(): SavedSession {
  try {
    if (!existsSync(SESSION_FILE)) return {};
    const raw = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as SavedSession;
    if (!raw.salt) return raw; // Legacy compatibility
    return {
      deviceId: raw.deviceId,
      salt: raw.salt,
      phone: raw.phone,
      authToken: raw.authToken ? decrypt(raw.authToken, raw.salt) : undefined,
      sessionToken: raw.sessionToken ? decrypt(raw.sessionToken, raw.salt) : undefined,
      mpin: raw.mpin ? decrypt(raw.mpin, raw.salt) : undefined,
    };
  } catch {
    return {};
  }
}

function saveSession(): void {
  try {
    const salt = authState.salt || crypto.randomBytes(16).toString('hex');
    authState.salt = salt;
    const payload: SavedSession = {
      deviceId: authState.deviceId,
      salt,
      phone: authState.phone || undefined,
      authToken: authState.authToken ? encrypt(authState.authToken, salt) : undefined,
      sessionToken: authState.sessionToken ? encrypt(authState.sessionToken, salt) : undefined,
      mpin: authState.mpin ? encrypt(authState.mpin, salt) : undefined,
    };
    writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* non-critical */
  }
}

// ─── Auth state ───────────────────────────────────────────────────────────────
const _saved = loadSavedSession();
const authState = {
  deviceId: _saved.deviceId || randomUUID() + '-node',
  tempToken: null as string | null,
  authToken: _saved.authToken || (null as string | null),
  sessionToken: _saved.sessionToken || (null as string | null),
  mpin: _saved.mpin || (null as string | null),
  phone: _saved.phone || (null as string | null),
  salt: _saved.salt || (null as string | null),
  status: (_saved.sessionToken ? 'authenticated' : _saved.authToken ? 'awaiting_mpin' : 'idle') as
    'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated',
};

// When the broker rejects a request (401/403) we DON'T immediately force a login:
// the dashboard fans out many broker calls (option chains, historical greeks across
// strikes/expiries), and a single resource-level 403 or a transient stale-token blip
// shouldn't log the user out while the live session is otherwise fine. Instead we try
// to silently re-mint the session from the persisted auth token + MPIN, and only fall
// back to prompting for a fresh login if that self-heal genuinely fails.
let reauthing = false; // guards verifypin from re-triggering itself
let reauthInFlight: Promise<boolean> | null = null;
let lastReauthMs = 0;
const REAUTH_COOLDOWN_MS = 30_000; // a burst of 403s triggers at most one attempt

function onBrokerAuthFailure(): void {
  // Only meaningful once we believe we're logged in; ignore during the login handshake
  // and while a re-auth (its own verifypin call) is in progress.
  if (reauthing || authState.status !== 'authenticated') return;
  void reauthSilently();
}

async function reauthSilently(): Promise<boolean> {
  if (reauthInFlight) return reauthInFlight;
  if (Date.now() - lastReauthMs < REAUTH_COOLDOWN_MS) return false;
  const mpin = authState.mpin || process.env.MPIN;
  if (!authState.authToken || !mpin) {
    forceLogin();
    return false;
  }
  lastReauthMs = Date.now();
  reauthInFlight = (async () => {
    reauthing = true;
    try {
      const data = await nubraPost(
        '/verifypin',
        { pin: mpin },
        { Authorization: `Bearer ${authState.authToken}` },
      );
      const sessionToken = (data.session_token ||
        (data.data as Record<string, unknown>)?.token) as string;
      if (!sessionToken) throw new Error('no session_token in response');
      authState.sessionToken = sessionToken;
      authState.status = 'authenticated';
      console.log('[auth] Session silently refreshed — no login needed.');
      saveSession();
      connectNubraWs();
      try {
        broadcast({ type: 'auth_status', status: 'authenticated' });
      } catch {
        /* ws not ready */
      }
      return true;
    } catch (err) {
      console.warn(`[auth] Silent re-auth failed (${(err as Error).message}) — login required.`);
      forceLogin();
      return false;
    } finally {
      reauthing = false;
      reauthInFlight = null;
    }
  })();
  return reauthInFlight;
}

// Drop to a logged-out state and tell browser clients to show the login overlay.
function forceLogin(): void {
  authState.sessionToken = null;
  authState.authToken = null;
  authState.status = 'idle';
  try {
    broadcast({ type: 'auth_status', status: authState.status });
  } catch {
    /* ws not ready */
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-device-id': authState.deviceId,
    'x-app-version': '0.4.2',
    'x-device-os': 'web',
    ...extra,
  };
}

async function nubraPost(
  endpoint: string,
  body: object,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  return nubraPostAt(BASE_URL, endpoint, body, extraHeaders);
}

// ─── Upstream HTTP ────────────────────────────────────────────────────────────
// Every call out to Nubra funnels through these two functions. Neither used to carry a timeout,
// so a stalled broker socket parked the request handler for undici's defaults — minutes — before
// finally surfacing as an opaque `fetch failed`. Both now run under a per-endpoint budget and log
// their duration; see upstreamError.ts for the budget table.

/** Log every upstream call, not just the slow ones. Useful when hunting a stall. */
const LOG_ALL_UPSTREAM = process.env.NUBRA_HTTP_LOG === '1';
const SLOW_UPSTREAM_MS = 1_500;

function logUpstream(method: string, endpoint: string, ms: number, outcome: string): void {
  const failed = outcome.startsWith('FAIL');
  if (!failed && !LOG_ALL_UPSTREAM && ms < SLOW_UPSTREAM_MS) return;
  const line = `[upstream] ${method} ${endpoint} ${ms}ms ${outcome}`;
  // Slow-but-successful is worth seeing, but it is not an error — keep it off stderr.
  if (failed) console.warn(line);
  else console.log(line);
}

/**
 * Turns an AbortSignal.timeout rejection into a message that names the budget it blew.
 *
 * The wording must not contain the substring "option chain" — isOptionChainUnavailableError in
 * src/OptionChain.tsx matches on that and would navigate the user's pane away to the chart view.
 */
function asTimeoutError(err: unknown, method: string, endpoint: string, ms: number): unknown {
  const kind = describeUpstreamError(err).kind;
  if (kind !== 'timeout') return err;
  return new Error(`upstream timeout after ${ms}ms: ${method} ${endpoint}`, { cause: err });
}

/** Shared response handling: parse, surface auth failures, throw on non-2xx. */
function parseUpstream(res: Response, text: string): Record<string, unknown> {
  let data: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) onBrokerAuthFailure();
    const msg = (data.message || data.error || `HTTP ${res.status}: ${text}`) as string;
    throw new Error(msg);
  }
  return data;
}

async function nubraPostAt(
  baseUrl: string,
  endpoint: string,
  body: object,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = upstreamTimeoutMs(endpoint);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: baseHeaders(extraHeaders),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The same signal bounds the body read, which was previously unbounded on its own.
    const text = await res.text();
    const data = parseUpstream(res, text);
    logUpstream('POST', endpoint, Date.now() - startedAt, `ok ${text.length}B`);
    return data;
  } catch (err: unknown) {
    const wrapped = asTimeoutError(err, 'POST', endpoint, timeoutMs);
    logUpstream(
      'POST',
      endpoint,
      Date.now() - startedAt,
      `FAIL ${describeUpstreamError(wrapped).detail}`,
    );
    // Deliberately never retried: a re-sent /sendphoneotp means a second SMS to the user.
    throw wrapped;
  }
}

async function nubraGet(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const url = `${BASE_URL}${endpoint}${qs ? '?' + qs : ''}`;
  const timeoutMs = upstreamTimeoutMs(endpoint);

  // Retry once, and only for transport-level failures. Node's connection pool hands out idle
  // keep-alive sockets that the broker (or an intermediate NAT) may have silently dropped; the
  // request then fails immediately and a retry gets a fresh socket. That is the per-request
  // version of restarting the server, which was previously the only cure.
  //
  // Explicitly NOT retried: our own timeouts (retrying doubles the wall clock back into a hang)
  // and HTTP statuses (a 401/403 has already fired onBrokerAuthFailure, and re-firing it would
  // hammer the re-auth path).
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: baseHeaders({ Authorization: `Bearer ${authState.sessionToken}` }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      const data = parseUpstream(res, text);
      logUpstream('GET', endpoint, Date.now() - startedAt, `ok ${text.length}B`);
      return data;
    } catch (err: unknown) {
      const wrapped = asTimeoutError(err, 'GET', endpoint, timeoutMs);
      const failure = describeUpstreamError(wrapped);
      logUpstream('GET', endpoint, Date.now() - startedAt, `FAIL ${failure.detail}`);
      if (attempt >= 1 || !isTransportError(wrapped)) throw wrapped;
      console.warn(`[upstream] retrying GET ${endpoint} after ${failure.detail}`);
    }
  }
}

// ─── Fastify setup ────────────────────────────────────────────────────────────
const httpServer = createServer();

// Fastify's own connectionTimeout/requestTimeout options are bypassed when a serverFactory is
// used, so set them on the underlying server. These bound how long we wait to RECEIVE a request,
// not how long a handler may take to answer — a long backtest response is unaffected.
httpServer.requestTimeout = 60_000;
httpServer.headersTimeout = 65_000;

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
  await fastify.register(fastifyStatic, {
    root: distPath,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0');
      }
    },
  });
}

function performLogout(): void {
  authState.sessionToken = null;
  authState.authToken = null;
  authState.mpin = null;
  authState.phone = null;
  authState.status = 'idle';

  try {
    if (existsSync(SESSION_FILE)) {
      const payload: SavedSession = {
        deviceId: authState.deviceId,
        salt: authState.salt || undefined,
      };
      writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), 'utf8');
    }
  } catch {}

  if (nubraWs) {
    try {
      nubraWs.close();
    } catch {}
    nubraWs = null;
  }

  try {
    broadcast({ type: 'auth_status', status: 'idle' });
  } catch {}
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
registerAuthRoutes({
  fastify,
  authState,
  nubraPost,
  saveSession,
  connectNubraWs,
  broadcast,
  performLogout,
  getDefaultPhone: () => process.env.PHONE_NO,
  getDefaultMpin: () => process.env.MPIN,
});

// ─── Auth guard ───────────────────────────────────────────────────────────────
function requireAuth(reply: {
  status: (code: number) => { send: (body: unknown) => void };
}): boolean {
  if (authState.status !== 'authenticated' || !authState.sessionToken) {
    reply.status(401).send({ error: 'Not authenticated. Complete login first.' });
    return false;
  }
  return true;
}

// ─── Market data routes ───────────────────────────────────────────────────────
registerMarketDataRoutes({
  fastify,
  getRefdata,
  peekRefdata,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken: () => authState.sessionToken,
});

// ─── Protobuf setup ───────────────────────────────────────────────────────────
let pbAny: protobuf.Type | null = null;
let pbBatchBucket: protobuf.Type | null = null;
let pbBatchIndex: protobuf.Type | null = null;
let pbOptionChainUpdate: protobuf.Type | null = null;

async function loadProto(): Promise<void> {
  try {
    const root = await protobuf.load(path.join(__dirname, '..', 'nubra.proto'));
    pbAny = root.lookupType('nubra.AnyMsg');
    pbBatchBucket = root.lookupType('nubra.BatchWebSocketIndexBucketMessage');
    pbBatchIndex = root.lookupType('nubra.BatchWebSocketIndexMessage');
    pbOptionChainUpdate = root.lookupType('nubra.WebSocketMsgOptionChainUpdate');
    console.log('Protobuf schema loaded.');
  } catch (err) {
    console.error('Failed to load proto:', (err as Error).message);
  }
}

// Per-leg last-seen tick timestamp for the option-chain WS feed. Nubra occasionally
// delivers a slightly-stale re-sync item right after a fresher per-leg tick for the
// same strike; without this guard the UI flashes the newer price and then reverts to
// the older one for a moment. Keyed by ref_id when present (stable across resubscribes),
// falling back to asset|expiry|exchange|side|strike.
const ocLastTs = new Map<string, number>();

function ocItemKey(
  asset: string,
  expiry: string,
  exchange: string,
  side: 'ce' | 'pe',
  item: { refId?: string; sp?: string },
): string {
  // protobufjs .toObject() camelCases proto field names (ref_id → refId) by default.
  const refId = Number(item.refId);
  if (refId) return `r:${refId}`;
  return `${asset}|${expiry}|${exchange}|${side}|${item.sp}`;
}

function dropStaleOcItems(data: Record<string, unknown>): void {
  const asset = String(data.asset || '').toUpperCase();
  const expiry = String(data.expiry || '');
  const exchange = String(data.exchange || 'NSE');
  for (const side of ['ce', 'pe'] as const) {
    const list = Array.isArray(data[side]) ? (data[side] as Record<string, unknown>[]) : [];
    data[side] = list.filter((item) => {
      const ts = Number(item.ts);
      if (!(ts > 0)) return true; // no usable timestamp — pass through unfiltered
      const key = ocItemKey(asset, expiry, exchange, side, item as { refId?: string; sp?: string });
      const last = ocLastTs.get(key);
      if (last != null && ts < last) return false; // older than what we already showed — drop
      ocLastTs.set(key, ts);
      return true;
    });
  }
}

// Reset the strike-keyed (non-ref_id) staleness guard when a client (re)subscribes,
// so switching away and back to an asset/expiry can't wrongly reject its first ticks.
function clearOcTsGuard(asset: string, expiry: string, exchange: string): void {
  const prefix = `${asset.toUpperCase()}|${expiry}|${exchange}|`;
  for (const key of ocLastTs.keys()) if (key.startsWith(prefix)) ocLastTs.delete(key);
}

function decodeBinaryMsg(rawBuffer: Buffer): { type: string; data: unknown } | null {
  if (!pbAny) return null;
  try {
    const outer = pbAny.decode(rawBuffer);
    const outerObj = pbAny.toObject(outer, { longs: String }) as {
      typeUrl?: string;
      value: Uint8Array;
    };
    const inner = pbAny.decode(outerObj.value);
    const innerObj = pbAny.toObject(inner, { longs: String }) as {
      typeUrl?: string;
      value: Uint8Array;
    };
    const typeUrl = innerObj.typeUrl || '';

    if (typeUrl.includes('IndexBucket') && pbBatchBucket) {
      const msg = pbBatchBucket.decode(innerObj.value);
      return { type: 'ohlcv', data: pbBatchBucket.toObject(msg, { longs: String, enums: String }) };
    }
    if (typeUrl.includes('BatchWebSocketIndexMessage') && pbBatchIndex) {
      const msg = pbBatchIndex.decode(innerObj.value);
      return {
        type: 'index_tick',
        data: pbBatchIndex.toObject(msg, { longs: String, enums: String }),
      };
    }
    if (typeUrl.includes('OptionChainUpdate') && pbOptionChainUpdate) {
      const msg = pbOptionChainUpdate.decode(innerObj.value);
      const data = pbOptionChainUpdate.toObject(msg, {
        longs: String,
        enums: String,
        defaults: true,
      }) as Record<string, unknown>;
      dropStaleOcItems(data);
      return { type: 'option_chain', data };
    }
  } catch {
    /* unknown message */
  }
  return null;
}

// ─── WebSocket relay ──────────────────────────────────────────────────────────
let nubraWs: WebSocket | null = null;
const browserClients = new Set<WebSocket>();
const pendingSubs: string[] = [];

// Chart subscriptions must survive a reconnect of the server's upstream Nubra
// socket. Browser sockets remain connected during that outage, so they do not
// naturally re-send their subscriptions the way they do after a browser reconnect.
const browserChartSubs = new Map<string, { count: number; subscription: ChartSubscription }>();
const clientChartSubs = new Map<WebSocket, Map<string, number>>();
const chartLastTick = new Map<string, number>();

function acquireBrowserChart(ws: WebSocket, subscription: ChartSubscription): boolean {
  const key = chartSubscriptionKey(subscription);
  let own = clientChartSubs.get(ws);
  if (!own) {
    own = new Map();
    clientChartSubs.set(ws, own);
  }
  own.set(key, (own.get(key) ?? 0) + 1);
  const current = browserChartSubs.get(key);
  if (current) {
    current.count += 1;
    return false;
  }
  browserChartSubs.set(key, { count: 1, subscription });
  return true;
}

function releaseBrowserChart(ws: WebSocket, subscription: ChartSubscription): boolean {
  const key = chartSubscriptionKey(subscription);
  const own = clientChartSubs.get(ws);
  const held = own?.get(key) ?? 0;
  if (held <= 0) return false;
  if (held === 1) own!.delete(key);
  else own!.set(key, held - 1);
  const current = browserChartSubs.get(key);
  if (!current) return false;
  if (current.count === 1) {
    browserChartSubs.delete(key);
    return true;
  }
  current.count -= 1;
  return false;
}

function releaseAllBrowserCharts(ws: WebSocket): ChartSubscription[] {
  const own = clientChartSubs.get(ws);
  clientChartSubs.delete(ws);
  if (!own) return [];
  const freed: ChartSubscription[] = [];
  for (const [key, count] of own) {
    const current = browserChartSubs.get(key);
    if (!current) continue;
    current.count -= count;
    if (current.count <= 0) {
      browserChartSubs.delete(key);
      freed.push(current.subscription);
    }
  }
  return freed;
}

function sendChartCmd(
  verb: 'batch_subscribe' | 'batch_unsubscribe',
  subscription: ChartSubscription,
): void {
  const token = authState.sessionToken;
  if (!token) return;
  const payload = JSON.stringify({ instruments: [], indexes: [], ...subscription.payload });
  const cmd = `${verb} ${token} index_bucket ${payload} ${subscription.interval} ${subscription.exchange}`;
  if (nubraWs?.readyState === WebSocket.OPEN) nubraWs.send(cmd);
  else if (verb === 'batch_subscribe') connectNubraWs();
}

// Browser option-chain interest, reference counted here rather than written into
// the persisted `simOcSubs`. Panes refcount within a tab (src/lib/ocSubRegistry),
// but two tabs used to fight — one closing a chain unsubscribed it from under the
// other — and every chain ever opened was persisted forever. This is transient by
// design: a reconnecting browser replays its own subscriptions.
const browserOcSubs = new Map<string, number>(); // key → total holders
const clientOcSubs = new Map<WebSocket, Map<string, number>>(); // per client, to release on close

/** @returns true on the 0 → 1 transition, i.e. the caller should subscribe upstream. */
function acquireBrowserOc(ws: WebSocket, key: string): boolean {
  let own = clientOcSubs.get(ws);
  if (!own) {
    own = new Map();
    clientOcSubs.set(ws, own);
  }
  own.set(key, (own.get(key) ?? 0) + 1);
  const total = (browserOcSubs.get(key) ?? 0) + 1;
  browserOcSubs.set(key, total);
  return total === 1;
}

/** @returns true on the 1 → 0 transition. Unbalanced releases are ignored. */
function releaseBrowserOc(ws: WebSocket, key: string): boolean {
  const own = clientOcSubs.get(ws);
  const held = own?.get(key) ?? 0;
  if (held <= 0) return false;
  if (held === 1) own!.delete(key);
  else own!.set(key, held - 1);
  const total = (browserOcSubs.get(key) ?? 0) - 1;
  if (total <= 0) {
    browserOcSubs.delete(key);
    return true;
  }
  browserOcSubs.set(key, total);
  return false;
}

/** Release everything a disconnecting client held. @returns keys that reached 0. */
function releaseAllBrowserOc(ws: WebSocket): string[] {
  const own = clientOcSubs.get(ws);
  clientOcSubs.delete(ws);
  if (!own) return [];
  const freed: string[] = [];
  for (const [key, n] of own) {
    const total = (browserOcSubs.get(key) ?? 0) - n;
    if (total <= 0) {
      browserOcSubs.delete(key);
      freed.push(key);
    } else browserOcSubs.set(key, total);
  }
  return freed;
}

function sendOcCmd(
  verb: 'batch_subscribe' | 'batch_unsubscribe',
  asset: string,
  expiry: string,
  exchange = 'NSE',
): void {
  const token = authState.sessionToken;
  if (!token) return;
  const cmd = `${verb} ${token} option ${JSON.stringify([{ exchange, asset, expiry }])}`;
  if (nubraWs && nubraWs.readyState === WebSocket.OPEN) {
    nubraWs.send(cmd);
  } else if (verb === 'batch_subscribe') {
    pendingSubs.push(cmd);
    connectNubraWs();
  }
}

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function connectNubraWs(): void {
  if (authState.status !== 'authenticated') return;
  if (
    nubraWs &&
    (nubraWs.readyState === WebSocket.OPEN || nubraWs.readyState === WebSocket.CONNECTING)
  )
    return;

  console.log('Connecting to Nubra WebSocket…');
  nubraWs = new WebSocket('wss://api.nubra.io/apibatch/ws', {
    headers: {
      Authorization: `Bearer ${authState.sessionToken}`,
      'x-device-id': authState.deviceId,
      'x-app-version': '0.4.2',
      'x-device-os': 'web',
    },
  });

  nubraWs.on('open', () => {
    console.log('Nubra WS connected.');
    broadcast({ type: 'ws_status', connected: true });
    for (const cmd of pendingSubs) nubraWs!.send(cmd);
    pendingSubs.length = 0;
    for (const { subscription } of browserChartSubs.values()) {
      sendChartCmd('batch_subscribe', subscription);
    }
    bootstrapPositionSubs()
      .then(() => sendAllOcSubs())
      .catch((e) => console.error('[Bootstrap]', e));
  });

  nubraWs.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const decoded = decodeBinaryMsg(data);
      if (decoded) {
        noteOcTick(decoded);
        if (decoded.type === 'ohlcv') {
          const buckets = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
          for (const raw of [...(buckets.indexes ?? []), ...(buckets.instruments ?? [])]) {
            const name = String((raw as Record<string, unknown>).indexname || '').toUpperCase();
            if (name) chartLastTick.set(name, Date.now());
          }
        }
        broadcast(decoded);
        routeTickToSim(decoded); // feed live prices into SimBroker for fill simulation
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

// Last time a tick actually arrived for each asset:expiry. `simOcSubs` records what
// we *asked* for; this records what is *arriving*. The two diverging (subscribed but
// silent) is what left the option chain rendering load-time prices, and it was
// invisible until this was exposed on /paper/debug.
const ocLastTick = new Map<string, number>();

// ref_id → the "ASSET:EXPIRY" feed that actually delivers its price, learned from
// the ticks themselves (see ocFeedGuard — an instrument name like
// NIFTY26JUL23850PE does not carry the weekly expiry it trades on). Held in
// memory only: `bootstrapPositionSubs` re-subscribes every open position's
// candidate expiries on each Nubra connect, so it is relearned within a second.
const posFeedIndex: FeedIndex = new Map();

/** Feeds at least one open position depends on for P&L and rule evaluation. */
function requiredOcFeeds(): Set<string> {
  return requiredFeedKeys(
    posFeedIndex,
    simBroker.getPositions().map((p) => p.ref_id),
  );
}

function noteOcTick(decoded: { type: string; data: unknown }): void {
  if (decoded.type !== 'option_chain') return;
  const d = decoded.data as { asset?: string; expiry?: string; exchange?: string };
  if (!d.asset || !d.expiry) return;
  ocLastTick.set(feedKey(String(d.asset), d.expiry, d.exchange), Date.now());
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
        const userPayload = (msg.payload || {}) as Record<string, unknown>;
        const subscription: ChartSubscription = {
          payload: userPayload,
          interval: msg.interval || '1m',
          exchange: (msg.exchange || 'NSE').toUpperCase(),
        };
        if (msg.action === 'subscribe') {
          if (acquireBrowserChart(ws, subscription)) {
            sendChartCmd('batch_subscribe', subscription);
          }
        } else if (releaseBrowserChart(ws, subscription)) {
          sendChartCmd('batch_unsubscribe', subscription);
        }
      }

      if (msg.action === 'subscribe_oc' || msg.action === 'unsubscribe_oc') {
        const asset = msg.asset || '';
        const expiry = msg.expiry || '';
        if (!asset || !expiry) return;
        const key = feedKey(asset, expiry, msg.exchange);

        if (msg.action === 'subscribe_oc') {
          clearOcTsGuard(asset, expiry, msg.exchange || 'NSE');
          // Always relay: the feed may have lapsed upstream even while another
          // client still holds a reference, and a duplicate batch_subscribe is
          // harmless. Only the bookkeeping is conditional.
          acquireBrowserOc(ws, key);
          sendOcCmd('batch_subscribe', asset, expiry, msg.exchange);
        } else {
          const lastHolder = releaseBrowserOc(ws, key);
          if (!lastHolder) return;
          // The server has its own stake in these feeds: `routeTickToSim` turns
          // option_chain ticks into `position_ltp` and into SL/target evaluation.
          // Relaying the last pane's unsubscribe used to kill both for every open
          // position on that expiry — frozen P&L and, worse, stop-losses that
          // quietly stopped firing.
          if (requiredOcFeeds().has(key) || simOcSubs.has(key)) {
            console.log(`[OC] Keeping ${key} — the simulator needs it`);
            return;
          }
          sendOcCmd('batch_unsubscribe', asset, expiry, msg.exchange);
        }
      }
    } catch (e) {
      console.error('WS msg error:', (e as Error).message);
    }
  });

  ws.on('close', () => {
    browserClients.delete(ws);
    for (const subscription of releaseAllBrowserCharts(ws)) {
      sendChartCmd('batch_unsubscribe', subscription);
    }
    // A tab that closes without unsubscribing must not leak its holds, or the
    // refcount never returns to zero and the feed is held for the session.
    for (const key of releaseAllBrowserOc(ws)) {
      if (requiredOcFeeds().has(key) || simOcSubs.has(key)) continue;
      const { asset, expiry, exchange } = parseFeedKey(key);
      sendOcCmd('batch_unsubscribe', asset, expiry, exchange);
    }
  });
});

setInterval(() => {
  if (
    authState.status === 'authenticated' &&
    (!nubraWs || nubraWs.readyState === WebSocket.CLOSED)
  ) {
    connectNubraWs();
  }
}, 2000);

// ─── Live Broker Simulation (SimBroker) ──────────────────────────────────────

const simBroker = new SimBroker();
simBroker.restore();
loadPositionRules();

// ─── End-of-day auto-snapshot ────────────────────────────────────────────────
// After market close, freeze a chart snapshot for every basket that traded today and doesn't already
// have one (manual saves take precedence via dbSnapshotExists). The server holds the WS connection and
// the simulated book, so this works even with no browser open.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function simToSnapPosition(p: SimPosition): SnapPosition {
  const closed = p.qty === 0;
  if (!closed) {
    return {
      ref_id: p.ref_id,
      display_name: p.display_name,
      zanskar_name: p.nubraName,
      order_side: p.qty > 0 ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
      qty: Math.abs(p.qty),
      avg_price: p.avg_price,
      realised_pnl: Math.round(p.realized_pnl),
      entry_time: p.entry_time,
      derivative_type: 'OPT',
    };
  }
  // Closed: mirror the /paper/positions/closed mapping for qty/side.
  const entryQty = p.entry_qty ?? 0;
  const priceDiff = Math.abs((p.exit_price || 0) - p.avg_price);
  const derivedQty =
    entryQty !== 0
      ? Math.abs(entryQty)
      : priceDiff > 0
        ? Math.round(Math.abs(p.realized_pnl) / priceDiff)
        : 0;
  const isLong =
    entryQty > 0 || (entryQty === 0 && p.realized_pnl > 0 && (p.exit_price || 0) > p.avg_price);
  return {
    ref_id: p.ref_id,
    display_name: p.display_name,
    zanskar_name: p.nubraName,
    order_side: isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
    qty: derivedQty,
    avg_price: p.avg_price,
    realised_pnl: Math.round(p.realized_pnl),
    entry_time: p.entry_time,
    exit_time: p.exit_time,
    exit_price: p.exit_price,
    derivative_type: 'OPT',
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
  const fetchTs = (body: object) =>
    nubraPost('/charts/timeseries', body, { Authorization: `Bearer ${authState.sessionToken!}` });
  const today = istDateString(Date.now() * 1_000_000);
  let saved = 0;
  for (const [basketId, group] of byBasket) {
    const entryTimes = group.map((p) => p.entry_time || 0).filter((t) => t > 0);
    if (entryTimes.length === 0) continue;
    const tradeDate = istDateString(Math.min(...entryTimes));
    if (tradeDate !== today) continue; // only finalize today's trades
    const existing = dbGetSnapshot(`${basketId}__${tradeDate}`);
    if (existing?.source === 'manual') continue; // preserve explicit manual saves
    const strategyName = group.find((p) => p.strategy_name)?.strategy_name || null;
    try {
      const built = await buildBasketSnapshot(group.map(simToSnapPosition), fetchTs);
      if (!built) continue;
      dbUpsertSnapshot({
        snapshot_id: `${basketId}__${built.tradeDate}`,
        basket_group_id: basketId,
        strategy_name: strategyName,
        underlying: built.underlying,
        trade_date: built.tradeDate,
        total_pnl: built.totalPnl,
        leg_count: built.legCount,
        source: 'eod',
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
  const dow = ist.getUTCDay(); // 0=Sun .. 6=Sat
  const afterClose =
    ist.getUTCHours() > 15 || (ist.getUTCHours() === 15 && ist.getUTCMinutes() >= 35);
  const istDate = istDateString(Date.now() * 1_000_000);
  if (afterClose && dow >= 1 && dow <= 5 && _lastEodDate !== istDate) {
    _lastEodDate = istDate;
    runEodSnapshots().catch((e) => console.warn('[EOD] run failed:', (e as Error).message));
  }
}, 60_000);
const simOcSubs = new Set<string>(dbLoadOcSubs());

// Subscribe instrument to the PROD live feed so SimBroker gets fills.
// For options: subscribes the option chain WebSocket stream.
// For stocks/indices: relies on the chart subscription that the browser already manages.
function subscribeForSim(
  nubraName: string,
  refId: number,
  derivativeType?: string,
  asset?: string,
  expiry?: string,
  exchange = 'NSE',
): void {
  simBroker.registerName(nubraName, refId);
  if (asset && expiry) {
    const key = feedKey(asset, expiry, exchange);
    if (!simOcSubs.has(key)) {
      simOcSubs.add(key);
      dbUpsertOcSub(key);
      if (nubraWs && nubraWs.readyState === WebSocket.OPEN && authState.sessionToken) {
        const payload = JSON.stringify([{ exchange, asset, expiry }]);
        nubraWs.send(`batch_subscribe ${authState.sessionToken} option ${payload}`);
        console.log(`[SimBroker] Auto-subscribed option chain: ${exchange} ${asset} ${expiry}`);
      }
    }
  }
}

// Replay both the simulator's own feeds and whatever browsers currently hold.
// Browser subscriptions are no longer persisted into `simOcSubs`, so upstream
// reconnects have to restore them from the live refcounts instead — a browser
// only replays when *its* socket reconnects, which is a different event.
function sendAllOcSubs(): void {
  if (!nubraWs || nubraWs.readyState !== WebSocket.OPEN || !authState.sessionToken) return;
  const keys = new Set([...simOcSubs, ...browserOcSubs.keys()]);
  for (const key of keys) {
    const { asset, expiry, exchange } = parseFeedKey(key);
    sendOcCmd('batch_subscribe', asset, expiry, exchange);
  }
  if (keys.size > 0)
    console.log(
      `[WS] Subscribed ${keys.size} OC feeds (${simOcSubs.size} simulator, ${browserOcSubs.size} browser)`,
    );
}

// Drop persisted feeds nothing needs any more: expired, malformed, or belonging
// to an asset with no open position and no live order. Without this the set only
// grew — every chain ever opened stayed in it, and `sendAllOcSubs` re-subscribed
// all of them on every reconnect.
function reconcileOcSubs(): void {
  const liveAssets = new Set<string>();
  const addAsset = (displayName: string) => {
    const { asset } = parseDisplayName(displayName);
    if (asset) liveAssets.add(asset);
  };
  for (const p of simBroker.getPositions()) addAsset(p.display_name);
  for (const o of simBroker.getOrders('live')) addAsset(o.display_name);

  const { drop } = pruneOcSubKeys(simOcSubs, {
    liveAssets,
    todayIst: istToday(Date.now()),
    pinned: requiredOcFeeds(),
  });
  if (drop.length === 0) return;
  for (const { key } of drop) {
    simOcSubs.delete(key);
    dbDeleteOcSub(key);
  }
  console.log(
    `[OC] Pruned ${drop.length} stale OC sub(s): ${drop.map((d) => `${d.key} (${d.reason})`).join(', ')}`,
  );
}

async function bootstrapPositionSubs(): Promise<void> {
  reconcileOcSubs();
  const positions = simBroker.getPositions();
  if (positions.length === 0) {
    sendAllOcSubs();
    return;
  }
  // Asset alone is not enough to address a chain — the same name could exist on
  // two exchanges, and MCX chains must be fetched with exchange=MCX or the
  // lookup 404s.
  const assets = new Map<string, { asset: string; exchange: string }>();
  for (const p of positions) {
    const { asset, exchange } = parseDisplayName(p.display_name);
    if (asset) assets.set(`${asset}:${exchange}`, { asset, exchange });
  }
  for (const { asset, exchange } of assets.values()) {
    try {
      const data = await nubraGet(`/optionchains/${asset}`, { exchange });
      const chain = (data.chain || data) as Record<string, unknown>;
      const allExp = (chain.all_expiries || []) as string[];
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const future = allExp.filter((e) => e >= today).sort();
      const toSub = future.slice(0, 4);
      for (const exp of toSub) {
        const key = feedKey(asset, exp, exchange);
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

// Watchdog: re-arm any feed an open position depends on that has gone silent.
// `simOcSubs` only records what we asked for — upstream can stop delivering a
// feed (or a relayed unsubscribe from an older build can have killed it) with no
// close, no error, and no way to tell from inside the process except that the
// ticks stop. Without this, P&L and stop-losses stay dead until someone happens
// to open a pane on that expiry.
const _ocResubCount = new Map<string, number>();

// Hourly, so expiry rollover and closed positions release their feeds without a
// restart. `bootstrapPositionSubs` also runs it on every upstream reconnect.
setInterval(reconcileOcSubs, 60 * 60 * 1000);

setInterval(() => {
  if (!nubraWs || nubraWs.readyState !== WebSocket.OPEN || !authState.sessionToken) return;
  const now = Date.now();

  const stale = staleRequiredFeeds(requiredOcFeeds(), ocLastTick, now);
  for (const key of _ocResubCount.keys()) if (!stale.includes(key)) _ocResubCount.delete(key);

  for (const key of stale) {
    const { asset, expiry, exchange } = parseFeedKey(key);
    // Outside its own session a silent feed is expected, not broken — and the
    // session depends on the exchange, since MCX trades until 23:30.
    if (!isMarketHours(now, exchange)) continue;
    const payload = JSON.stringify([{ exchange, asset, expiry }]);
    nubraWs.send(`batch_subscribe ${authState.sessionToken} option ${payload}`);
    const n = (_ocResubCount.get(key) ?? 0) + 1;
    _ocResubCount.set(key, n);
    const last = ocLastTick.get(key);
    const age = last ? `${Math.round((now - last) / 1000)}s` : 'never';
    console.warn(
      `[OC] Feed ${key} silent (${age}) but needed by an open position — re-subscribed (attempt ${n})`,
    );
  }
}, 20_000);

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
  broadcast({
    type: 'position_ltp',
    data: Array.from(deduped, ([ref_id, ltp]) => ({ ref_id, ltp })),
  });
}

function queuePosLtp(changes: { ref_id: number; ltp: number }[]): void {
  if (changes.length === 0) return;
  _posLtpBuffer.push(...changes);
  if (!_posLtpTimer) _posLtpTimer = setTimeout(flushPosLtp, 200);
}

// Evaluate SL/target/trailing rules for a position whose LTP just changed, and
// broadcast anything that fired so the browser can refresh without waiting on
// the 2s position poll.
function fireRules(refId: number): void {
  const events = evaluateAndFire(simBroker, refId);
  if (events.length) broadcast({ type: 'position_rule_fired', data: events });
}

function routeTickToSim(decoded: { type: string; data: unknown }): void {
  if (decoded.type === 'option_chain') {
    const d = decoded.data as {
      asset?: string;
      expiry?: string;
      exchange?: string;
      ce?: unknown[];
      pe?: unknown[];
    };
    const allItems = [...(d.ce ?? []), ...(d.pe ?? [])];
    // Record which feed serves each open position, so the unsubscribe guard and
    // the staleness watchdog below know which feeds are load bearing.
    const key = d.asset && d.expiry ? feedKey(String(d.asset), d.expiry, d.exchange) : null;
    const openIds = key ? new Set(simBroker.getPositions().map((p) => p.ref_id)) : null;
    if (!_ocFieldLogDone && allItems.length > 0) {
      const sample = allItems[0] as Record<string, unknown>;
      console.log('[SimBroker] OC item field names:', Object.keys(sample).join(', '));
      console.log('[SimBroker] OC item sample:', JSON.stringify(sample).slice(0, 200));
      _ocFieldLogDone = true;
    }
    for (const item of allItems) {
      const i = item as Record<string, unknown>;
      const refId = i.refId ?? i.ref_id;
      const ltp = i.ltp;
      if (refId && ltp) {
        if (key && openIds?.has(Number(refId))) posFeedIndex.set(Number(refId), key);
        const changes = simBroker.onLtp(Number(refId), Number(ltp));
        queuePosLtp(changes);
        if (changes.length) fireRules(Number(refId));
      }
    }
  } else if (decoded.type === 'index_tick') {
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const tick of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const t = tick as Record<string, unknown>;
      const name = t.indexname as string | undefined;
      const val = t.indexValue ?? t.index_value;
      if (name && val) {
        const changes = simBroker.onNamedLtp(name, Number(val));
        queuePosLtp(changes);
        if (changes.length) fireRules(changes[0].ref_id);
      }
    }
  } else if (decoded.type === 'ohlcv') {
    const d = decoded.data as { indexes?: unknown[]; instruments?: unknown[] };
    for (const b of [...(d.indexes ?? []), ...(d.instruments ?? [])]) {
      const bucket = b as Record<string, unknown>;
      const name = bucket.indexname as string | undefined;
      const close = bucket.close;
      if (name && close) {
        const changes = simBroker.onNamedLtp(name, Number(close));
        queuePosLtp(changes);
        if (changes.length) fireRules(changes[0].ref_id);
      }
    }
  }
}

function buildPaperDebugResponse(): Record<string, unknown> {
  const posRefIds = simBroker.getPositions().map((p) => p.ref_id);
  const now = Date.now();
  // A key in ocSubs with no ocFeeds entry (or a large ageSec) means we believe we
  // are subscribed but nothing is coming — the feed needs re-subscribing.
  const required = requiredOcFeeds();
  const ocFeeds = [...new Set([...simOcSubs, ...browserOcSubs.keys(), ...ocLastTick.keys()])]
    .map((key) => ({
      key,
      subscribed: simOcSubs.has(key),
      // `required` feeds are the ones open positions need for live P&L and for
      // SL/target evaluation. A required feed with a large ageSec is an outage,
      // not idleness — the watchdog re-subscribes those every 20s in session.
      required: required.has(key),
      browserHolds: browserOcSubs.get(key) ?? 0,
      ageSec: ocLastTick.has(key) ? Math.round((now - ocLastTick.get(key)!) / 1000) : null,
    }))
    .sort((a, b) => (a.ageSec ?? Infinity) - (b.ageSec ?? Infinity));
  return {
    ocSubs: [...simOcSubs],
    ocFeeds,
    chartFeeds: [...browserChartSubs.values()].map(({ count, subscription }) => ({
      ...subscription,
      browserHolds: count,
      symbols: Object.values(subscription.payload as Record<string, unknown>).flat(),
      ageSec: Math.min(
        ...Object.values(subscription.payload as Record<string, unknown>)
          .flat()
          .map((symbol) =>
            chartLastTick.has(String(symbol).toUpperCase())
              ? Math.round((now - chartLastTick.get(String(symbol).toUpperCase())!) / 1000)
              : Infinity,
          ),
      ),
    })),
    posFeedIndex: Object.fromEntries(posFeedIndex),
    marketHours: isMarketHours(now),
    positionRefIds: posRefIds,
    wsConnected: nubraWs?.readyState === WebSocket.OPEN,
    ocFieldLogDone: _ocFieldLogDone,
  };
}

// ─── Paper trading routes ─────────────────────────────────────────────────────
registerPaperRoutes({
  fastify,
  requireAuth,
  getAuthStatus: () => authState.status,
  getSessionToken: () => authState.sessionToken,
  simBroker,
  subscribeForSim,
  fireRules,
  buildDebugResponse: buildPaperDebugResponse,
  nubraGet,
  nubraPostAt,
  marginBaseUrl: MARGIN_BASE_URL,
});

/**
 * Pre-download the instrument master for the exchanges the UI actually uses.
 *
 * Only NSE was ever warmed, so the first MCX or BSE option chain of the day paid a
 * multi-megabyte download inside the request. Fire-and-forget: the single-flight cache
 * de-duplicates against any request that races us, and a failure just leaves the cache cold.
 */
function warmRefdata(): void {
  for (const exchange of ['NSE', 'BSE', 'MCX']) {
    void getRefdata(exchange).catch((e: unknown) => {
      console.warn(`[Refdata] warm failed for ${exchange}:`, describeUpstreamError(e).detail);
    });
  }
}

// ─── Startup session restore ──────────────────────────────────────────────────
async function tryRestoreSession(): Promise<void> {
  if (authState.sessionToken) {
    try {
      console.log('Testing saved session token...');
      // Doubles as the session-token probe: a 401 here rejects and drops us to the PIN path.
      await getRefdata('NSE');

      authState.status = 'authenticated';
      console.log('[auth] Saved session token is valid. Zero-prompt bypass successful!');
      warmRefdata();
      connectNubraWs();
      try {
        broadcast({ type: 'auth_status', status: 'authenticated' });
      } catch {
        /* ws not ready */
      }
      return;
    } catch (e: any) {
      console.log(
        '[auth] Saved session token is invalid or expired. Falling back to PIN/OTP.',
        e.message,
      );
      authState.sessionToken = null;
    }
  }

  const mpin = authState.mpin || process.env.MPIN;
  if (authState.authToken && mpin) {
    try {
      console.log('Attempting to restore session with saved token + MPIN…');
      const data = await nubraPost(
        '/verifypin',
        { pin: mpin },
        { Authorization: `Bearer ${authState.authToken}` },
      );
      const sessionToken = (data.session_token ||
        (data.data as Record<string, unknown>)?.token) as string;
      if (!sessionToken) throw new Error('no session_token in response');
      authState.sessionToken = sessionToken;
      authState.status = 'authenticated';
      console.log('Session restored — OTP not needed.');
      saveSession();
      warmRefdata();
      connectNubraWs();
      try {
        broadcast({ type: 'auth_status', status: 'authenticated' });
      } catch {
        /* ws not ready */
      }
      return;
    } catch (err: any) {
      console.log(`Saved token expired (${err.message}). Fresh OTP required.`);
      authState.authToken = null;
      authState.status = 'idle';
      saveSession();
    }
  } else {
    authState.status = 'idle';
  }
}

// ─── Backtest ─────────────────────────────────────────────────────────────────
registerBacktestRoutes(fastify);

// ─── Nubra Backtest ──────────────────────────────────────────────────────────
registerNubraBacktestRoutes({
  fastify,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken: () => authState.sessionToken,
});

// ─── Start ────────────────────────────────────────────────────────────────────
await loadProto();
await fastify.ready();

httpServer.listen(PORT, async () => {
  console.log(`Nubra Dashboard server → http://localhost:${PORT}`);
  await tryRestoreSession();
});
