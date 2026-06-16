import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { WsMessage } from '../types';

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
  const [wsReady, setWsReady] = useState(false);

  const dispatch = useCallback((msg: WsMessage) => {
    const typed = listeners.current.get(msg.type);
    if (typed) for (const cb of typed) cb(msg);
    const all = listeners.current.get('*');
    if (all) for (const cb of all) cb(msg);
  }, []);

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;

    ws.addEventListener('open', () => setWsReady(true));

    ws.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMessage;
        dispatch(msg);
      } catch { /* ignore malformed */ }
    });

    ws.addEventListener('close', () => {
      setWsReady(false);
      setTimeout(connect, 3000);
    });

    ws.addEventListener('error', () => ws.close());
  }, [dispatch]);

  useEffect(() => {
    connect();
    return () => wsRef.current?.close();
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
    send({ action: 'subscribe_oc', asset, expiry, exchange });
  }, [send]);

  const unsubscribeOC = useCallback((asset: string, expiry: string, exchange = 'NSE') => {
    send({ action: 'unsubscribe_oc', asset, expiry, exchange });
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
