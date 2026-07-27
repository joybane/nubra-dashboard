import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { WsMessage } from '../types';
import { createOcSubRegistry, ocKey } from '../lib/ocSubRegistry';

// ─── Types ────────────────────────────────────────────────────────────────────
type Listener = (msg: WsMessage) => void;

interface WsContextValue {
  wsReady:     boolean;
  subscribe:   (type: WsMessage['type'] | '*', cb: Listener) => () => void;
  send:        (msg: object) => void;
  subscribeOC: (asset: string, expiry: string, exchange?: string) => void;
  unsubscribeOC:(asset: string, expiry: string, exchange?: string) => void;
  subscribeChart:(payload: object, interval: string, exchange?: string) => void;
  unsubscribeChart:(payload: object, interval: string, exchange?: string) => void;
}

const WsContext = createContext<WsContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────
export function WsProvider({ children }: { children: React.ReactNode }) {
  const wsRef     = useRef<WebSocket | null>(null);
  const listeners = useRef(new Map<string, Set<Listener>>());
  // Reconnect bookkeeping: `reconnectRef` holds the pending retry timer so we can
  // cancel it, and `stoppedRef` marks intentional teardown so a `close` event
  // triggered by *us* (unmount) does not schedule a resurrecting reconnect.
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef   = useRef(false);
  // Option-chain subscriptions are shared by many consumers, so they are
  // reference counted here rather than sent per caller — see lib/ocSubRegistry.
  const ocSubs       = useRef(createOcSubRegistry());
  const [wsReady, setWsReady] = useState(false);

  const dispatch = useCallback((msg: WsMessage) => {
    // Every listener is isolated. A single consumer throwing used to abort the loop,
    // so every listener registered after it stopped receiving that message type for
    // the rest of the session — and the caller's try/catch around JSON.parse
    // swallowed the error, so it failed silently. Live prices would just stop.
    const notify = (cb: Listener) => {
      try { cb(msg); }
      catch (err) { console.error(`[ws] listener for "${msg.type}" threw:`, err); }
    };
    const typed = listeners.current.get(msg.type);
    if (typed) for (const cb of typed) notify(cb);
    const all = listeners.current.get('*');
    if (all) for (const cb of all) notify(cb);
  }, []);

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      setWsReady(true);
      // Replay every option-chain feed a consumer still wants. This covers both a
      // reconnect (the server only replays its own position-derived subs) and the
      // cold start, where a chain can finish loading and subscribe before the
      // socket is OPEN — `send` drops those silently, leaving the chain on its
      // 5s REST poll for the rest of the session.
      for (const key of ocSubs.current.active()) {
        const [asset, expiry, exchange] = key.split('|');
        ws.send(JSON.stringify({ action: 'subscribe_oc', asset, expiry, exchange }));
      }
    });

    ws.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMessage;
        dispatch(msg);
      } catch { /* ignore malformed */ }
    });

    ws.addEventListener('close', () => {
      // Ignore a stale socket's close (a newer connection already replaced it —
      // e.g. StrictMode's dev remount, or an overlapping reconnect).
      if (wsRef.current !== ws) return;
      setWsReady(false);
      // Only auto-reconnect after an *unexpected* drop, never after teardown.
      if (stoppedRef.current) return;
      reconnectRef.current = setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => ws.close());
  }, [dispatch]);

  useEffect(() => {
    stoppedRef.current = false;
    connect();
    return () => {
      stoppedRef.current = true;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [connect]);

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((type: WsMessage['type'] | '*', cb: Listener) => {
    if (!listeners.current.has(type)) listeners.current.set(type, new Set());
    listeners.current.get(type)!.add(cb);
    return () => listeners.current.get(type)?.delete(cb);
  }, []);

  const subscribeChart = useCallback((payload: object, interval: string, exchange = 'NSE') => {
    send({ action: 'subscribe', bucket: 'index_bucket', payload, interval, exchange });
  }, [send]);

  const unsubscribeChart = useCallback((payload: object, interval: string, exchange = 'NSE') => {
    send({ action: 'unsubscribe', bucket: 'index_bucket', payload, interval, exchange });
  }, [send]);

  const subscribeOC = useCallback((asset: string, expiry: string, exchange = 'NSE') => {
    if (!asset || !expiry) return;
    if (ocSubs.current.acquire(ocKey(asset, expiry, exchange))) {
      send({ action: 'subscribe_oc', asset, expiry, exchange });
    }
  }, [send]);

  const unsubscribeOC = useCallback((asset: string, expiry: string, exchange = 'NSE') => {
    if (!asset || !expiry) return;
    // Only the last holder tears the feed down; everyone else just drops their claim.
    if (ocSubs.current.release(ocKey(asset, expiry, exchange))) {
      send({ action: 'unsubscribe_oc', asset, expiry, exchange });
    }
  }, [send]);

  return (
    <WsContext.Provider value={{ wsReady, subscribe, send, subscribeOC, unsubscribeOC, subscribeChart, unsubscribeChart }}>
      {children}
    </WsContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useWs(): WsContextValue {
  const ctx = useContext(WsContext);
  if (!ctx) throw new Error('useWs must be used within WsProvider');
  return ctx;
}
