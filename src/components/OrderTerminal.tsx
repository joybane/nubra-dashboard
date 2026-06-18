import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, PaperHolding, PaperOrder, PaperPosition, WsMessage, OptionChainData, OptionLeg } from '../types';
import { fmtPrice } from '../lib/utils';
import { usePaperTrading } from '../hooks/usePaperTrading';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { useWs } from '../hooks/useWsContext';

// ─── helpers ─────────────────────────────────────────────────────────────────
function paise(v: number | undefined | null): string {
  if (v == null) return '—';
  return fmtPrice(v / 100);
}

function fmtTime(ns: number | undefined | null): string {
  if (!ns) return '—';
  const ms = ns / 1_000_000;
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function productLabel(d: string | undefined): string {
  if (!d) return '—';
  return d.includes('IDAY') ? 'MIS' : 'NRML';
}

function displayName(o: PaperOrder): string {
  return o.display_name || o.ref_data?.stock_name || String(o.ref_id);
}

const STATUS_STYLE: Record<string, string> = {
  ORDER_STATUS_PENDING:   'bg-yellow-500/15 text-yellow-400',
  ORDER_STATUS_OPEN:      'bg-blue-500/15 text-blue-400',
  ORDER_STATUS_FILLED:    'bg-green-500/15 text-[var(--green)]',
  ORDER_STATUS_CANCELLED: 'bg-[var(--bg-hover)] text-[var(--text-muted)]',
  ORDER_STATUS_REJECTED:  'bg-red-500/15 text-[var(--red)]',
};

const STATUS_LABEL: Record<string, string> = {
  ORDER_STATUS_PENDING:   'PENDING',
  ORDER_STATUS_OPEN:      'OPEN',
  ORDER_STATUS_FILLED:    'COMPLETE',
  ORDER_STATUS_CANCELLED: 'CANCELLED',
  ORDER_STATUS_REJECTED:  'REJECTED',
};

const MIN_H     = 120;
const DEFAULT_H = 220;
const HEADER_H  = 40;   // collapsed height = just header bar

// ─── Orders table ─────────────────────────────────────────────────────────────
function OrdersTab({ uatAuth }: { uatAuth: boolean }) {
  const [openOrders,   setOpenOrders]   = useState<PaperOrder[]>([]);
  const [closedOrders, setClosedOrders] = useState<PaperOrder[]>([]);
  const [subTab,       setSubTab]       = useState<'open' | 'closed'>('open');
  const [loading,      setLoading]      = useState(false);
  const [cancelling,   setCancelling]   = useState<number | null>(null);
  const [dayPnl,       setDayPnl]       = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchOrders = useCallback(async () => {
    if (!uatAuth) return;
    try {
      const [liveRes, doneRes, pnlRes] = await Promise.all([
        fetch('/paper/orders?live=1'),
        fetch('/paper/orders?executed=1'),
        fetch('/paper/pnl'),
      ]);
      if (liveRes.ok) {
        const d = await liveRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        setOpenOrders(Array.isArray(d) ? d : (d.orders ?? []));
      }
      if (doneRes.ok) {
        const d = await doneRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        setClosedOrders(Array.isArray(d) ? d : (d.orders ?? []));
      }
      if (pnlRes.ok) {
        const d = await pnlRes.json() as { total?: number };
        setDayPnl(d.total ?? null);
      }
    } catch { /* ignore */ }
  }, [uatAuth]);

  useEffect(() => {
    if (!uatAuth) return;
    setLoading(true);
    fetchOrders().finally(() => setLoading(false));
    timerRef.current = setInterval(fetchOrders, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [uatAuth, fetchOrders]);

  async function cancelOrder(id: number) {
    setCancelling(id);
    try {
      await fetch(`/paper/orders/${id}`, { method: 'DELETE' });
      await fetchOrders();
    } catch { /* ignore */ }
    finally { setCancelling(null); }
  }

  const rows = subTab === 'open' ? openOrders : closedOrders;
  // dayPnl is fetched from /paper/pnl (realised + unrealised across all positions).
  // The old approach of summing signed order cash flows was wrong: a BUY-only position
  // would show a large negative "P&L" equal to the cash outflow, not the actual profit.
  const pnlPaise = dayPnl ?? 0;
  const pnlRs    = pnlPaise / 100;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* sub-tab row */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        {(['open', 'closed'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-3 py-0.5 rounded text-[11px] font-semibold transition-all ${
              subTab === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t === 'open' ? `Open ${openOrders.length}` : `Closed ${closedOrders.length}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
          Day P&L: <span className={pnlRs >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{pnlRs >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnlRs))}</span>
        </span>
        {loading && <span className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin ml-2" />}
      </div>

      {/* table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
            <tr className="text-[var(--text-muted)] font-medium">
              {['Symbol', 'Status', 'Time', 'Product', 'Side', 'Qty', 'Price', 'Trigger', 'Avg Price', ''].map((h) => (
                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-8 text-[var(--text-muted)]">
                  {subTab === 'open' ? 'No open orders' : 'No closed orders'}
                </td>
              </tr>
            )}
            {rows.map((o) => {
              const isBuy   = o.order_side === 'ORDER_SIDE_BUY';
              const canCancel = o.order_status === 'ORDER_STATUS_PENDING' || o.order_status === 'ORDER_STATUS_OPEN';
              return (
                <tr key={o.order_id} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                  <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)] whitespace-nowrap">{displayName(o)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLE[o.order_status] || ''}`}>
                      {STATUS_LABEL[o.order_status] || o.order_status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(o.order_time)}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{productLabel(o.order_delivery_type)}</td>
                  <td className={`px-3 py-1.5 font-semibold ${isBuy ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {isBuy ? 'BUY' : 'SELL'}
                  </td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{o.filled_qty}/{o.order_qty}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(o.order_price)}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{o.trigger_price ? paise(o.trigger_price) : '—'}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{o.avg_filled_price ? paise(o.avg_filled_price) : '—'}</td>
                  <td className="px-3 py-1.5">
                    {canCancel && (
                      <button
                        onClick={() => cancelOrder(o.order_id)}
                        disabled={cancelling === o.order_id}
                        className="w-5 h-5 rounded flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--red)] hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                        title="Cancel order"
                      >
                        {cancelling === o.order_id ? '…' : '×'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Positions tab ────────────────────────────────────────────────────────────
interface PositionsTabProps {
  uatAuth: boolean;
  onViewChart?: (inst: Instrument) => void;
  onExit?: (p: PaperPosition, side: 'BUY' | 'SELL') => void;
}

function PositionsTab({ uatAuth, onViewChart, onExit }: PositionsTabProps) {
  const [positions,       setPositions]       = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [subTab,          setSubTab]          = useState<'open' | 'closed'>('open');
  const [loading,   setLoading]   = useState(false);
  const [exiting,   setExiting]   = useState<Set<number>>(new Set());
  const { subscribe } = useWs();

  const fetch_ = useCallback(async () => {
    if (!uatAuth) return;
    try {
      const [openRes, closedRes] = await Promise.all([
        fetch('/paper/positions'),
        fetch('/paper/positions/closed'),
      ]);
      if (openRes.ok) {
        const d = await openRes.json() as { portfolio?: { stock_positions?: PaperPosition[] } } | PaperPosition[];
        if (Array.isArray(d)) setPositions(d);
        else setPositions((d.portfolio?.stock_positions) ?? []);
      }
      if (closedRes.ok) {
        const d = await closedRes.json() as PaperPosition[];
        setClosedPositions(Array.isArray(d) ? d : []);
      }
    } catch { /* ignore */ }
  }, [uatAuth]);

  useEffect(() => {
    if (!uatAuth) return;
    setLoading(true);
    fetch_().finally(() => setLoading(false));
    const t = setInterval(fetch_, 2000);
    return () => clearInterval(t);
  }, [uatAuth, fetch_]);

  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const ltpMap = new Map<number, number>();
      for (const item of [...(data.ce || []), ...(data.pe || [])]) {
        const leg = item as OptionLeg & Record<string, unknown>;
        const refId = Number(leg.ref_id ?? leg.refId ?? 0);
        const ltp   = Number(leg.ltp ?? 0);
        if (refId && ltp > 0) ltpMap.set(refId, ltp);
      }
      if (ltpMap.size === 0) return;
      setPositions(prev => {
        let changed = false;
        const next = prev.map(p => {
          const newLtp = ltpMap.get(p.ref_id);
          if (newLtp != null && newLtp !== p.last_traded_price) {
            changed = true;
            return { ...p, last_traded_price: newLtp };
          }
          return p;
        });
        return changed ? next : prev;
      });
    });
    return unsub;
  }, [subscribe]);

  const exitDirect = useCallback(async (p: PaperPosition) => {
    if (exiting.has(p.ref_id)) return;
    setExiting(prev => new Set(prev).add(p.ref_id));
    const exitSide = (p.order_side || '').includes('BUY') ? 'ORDER_SIDE_SELL' : 'ORDER_SIDE_BUY';
    try {
      let nubraName = p.zanskar_name || '';
      if (!nubraName && p.ref_id) {
        const res = await fetch(`/api/instruments/lookup?ref_id=${p.ref_id}`);
        const d = await res.json() as { instrument: Record<string, unknown> | null };
        if (d.instrument) nubraName = (d.instrument.zanskar_name || d.instrument.nubra_name || '') as string;
      }
      if (!nubraName) { setExiting(prev => { const s = new Set(prev); s.delete(p.ref_id); return s; }); return; }
      await fetch('/paper/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nubraName,
          liveRefId: p.ref_id,
          display_name: p.display_name || nubraName,
          order_type: 'ORDER_TYPE_MARKET',
          order_qty: p.qty,
          order_side: exitSide,
          order_delivery_type: p.product === 'MIS' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
          validity_type: 'DAY',
        }),
      });
      setTimeout(fetch_, 500);
    } catch { /* ignore */ }
  }, [exiting, fetch_]);

  const exitAll = useCallback(async () => {
    for (const p of positions) {
      if (!exiting.has(p.ref_id)) exitDirect(p);
    }
  }, [positions, exiting, exitDirect]);

  const totalPnl = positions.reduce((s, p) => {
    const side = (p.order_side || '').includes('BUY') ? 1 : -1;
    return s + side * ((p.last_traded_price || 0) - (p.avg_price || 0)) * (p.qty || 0);
  }, 0);

  const rows = subTab === 'open' ? positions : closedPositions;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* sub-tab row */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        {(['open', 'closed'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-3 py-0.5 rounded text-[11px] font-semibold transition-all ${
              subTab === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            {t === 'open' ? `Open ${positions.length}` : `Closed ${closedPositions.length}`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
          Day P&L: <span className={totalPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{totalPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPnl / 100))}</span>
        </span>
        {subTab === 'open' && positions.length > 0 && (
          <button
            onClick={exitAll}
            disabled={positions.every(p => exiting.has(p.ref_id))}
            className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30 transition-colors"
          >
            Exit All
          </button>
        )}
        {loading && <span className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin ml-2" />}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
            <tr className="text-[var(--text-muted)]">
              {(subTab === 'open'
                ? ['Symbol', 'Product', 'Side', 'Qty', 'Avg Price', 'LTP', 'P&L', 'P&L %', '']
                : ['Symbol', 'Product', 'P&L']
              ).map((h) => (
                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-8 text-[var(--text-muted)]">{subTab === 'open' ? 'No open positions' : 'No closed positions'}</td></tr>
            )}
            {subTab === 'open' && positions.map((p) => {
              const side = (p.order_side || '').includes('BUY') ? 'BUY' : 'SELL';
              const sign = side === 'BUY' ? 1 : -1;
              const pnl  = sign * ((p.last_traded_price || 0) - (p.avg_price || 0)) * (p.qty || 0) / 100;
              return (
                <tr key={p.ref_id} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                  <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)]">{p.display_name || p.zanskar_name || p.ref_id}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.product || 'NRML'}</td>
                  <td className={`px-3 py-1.5 font-semibold ${side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{side}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.qty}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.avg_price)}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.last_traded_price)}</td>
                  <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                  </td>
                  <td className={`px-3 py-1.5 ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {pnl >= 0 ? '+' : ''}{((p.avg_price || 0) > 0 ? (((p.last_traded_price || 0) - (p.avg_price || 0)) / (p.avg_price || 1) * 100 * (side === 'BUY' ? 1 : -1)) : 0).toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-1">
                      {onViewChart && (
                        <button
                          onClick={() => onViewChart({
                            stock_name: p.display_name || p.zanskar_name || String(p.ref_id),
                            ref_id: p.ref_id,
                            exchange: 'NSE',
                            derivative_type: p.derivative_type,
                            option_type: p.option_type,
                            strike_price: p.strike_price,
                            expiry: p.expiry,
                          })}
                          className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors"
                          title="View chart"
                        >
                          Chart
                        </button>
                      )}
                      {(
                        <button
                          onClick={() => exitDirect(p)}
                          disabled={exiting.has(p.ref_id)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${exiting.has(p.ref_id) ? 'text-[var(--text-muted)] bg-[var(--bg-hover)] border border-[var(--border)] cursor-not-allowed' : 'text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30'}`}
                          title={exiting.has(p.ref_id) ? 'Exit order placed' : 'Exit position'}
                        >
                          Exit
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {subTab === 'closed' && closedPositions.map((p) => {
              const pnl = (p.realised_pnl || p.pnl || 0) / 100;
              return (
                <tr key={p.ref_id} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                  <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)]">{p.display_name || p.zanskar_name || p.ref_id}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.product || 'NRML'}</td>
                  <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Holdings tab ─────────────────────────────────────────────────────────────
function HoldingsTab({ uatAuth }: { uatAuth: boolean }) {
  const [holdings, setHoldings] = useState<PaperHolding[]>([]);
  const [loading,  setLoading]  = useState(false);

  const fetch_ = useCallback(async () => {
    if (!uatAuth) return;
    try {
      const res = await fetch('/paper/holdings');
      if (!res.ok) return;
      const d = await res.json() as { portfolio?: { holdings?: PaperHolding[] } } | PaperHolding[];
      if (Array.isArray(d)) setHoldings(d);
      else setHoldings(d.portfolio?.holdings ?? []);
    } catch { /* ignore */ }
  }, [uatAuth]);

  useEffect(() => {
    if (!uatAuth) return;
    setLoading(true);
    fetch_().finally(() => setLoading(false));
  }, [uatAuth, fetch_]);

  const totalPnl = holdings.reduce((s, h) => s + (h.net_pnl || 0), 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="h-8 shrink-0 flex items-center gap-2 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        <span className="text-[11px] text-[var(--text-muted)]">
          Net P&L: <span className={totalPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{totalPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPnl / 100))}</span>
        </span>
        {loading && <span className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin ml-auto" />}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
            <tr className="text-[var(--text-muted)]">
              {['Symbol', 'Qty', 'Avg Price', 'LTP', 'Net P&L', 'P&L %', 'Day P&L'].map((h) => (
                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {holdings.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[var(--text-muted)]">No holdings</td></tr>
            )}
            {holdings.map((h) => {
              const pnl = (h.net_pnl || 0) / 100;
              return (
                <tr key={h.ref_id} className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)]">
                  <td className="px-3 py-1.5 font-semibold text-[var(--text-primary)]">{h.display_name || h.nubra_name || h.symbol || h.ref_id}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{h.quantity}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(h.avg_price)}</td>
                  <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(h.last_traded_price)}</td>
                  <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                  </td>
                  <td className={`px-3 py-1.5 ${(h.net_pnl_chg || 0) >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {(h.net_pnl_chg || 0) >= 0 ? '+' : ''}{(h.net_pnl_chg || 0).toFixed(2)}%
                  </td>
                  <td className={`px-3 py-1.5 ${(h.day_pnl || 0) >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {(h.day_pnl || 0) >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs((h.day_pnl || 0) / 100))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── OrderTerminal ────────────────────────────────────────────────────────────
export default function OrderTerminal() {
  const { authenticated: uatAuth, refreshAuthStatus, openTicket } = usePaperTrading();
  const { state: wsState, setPaneView, setActivePane, loadInstrumentInActivePane } = useWorkspaceState();
  const [tab,        setTab]        = useState<'orders' | 'positions' | 'holdings'>('orders');
  const [height,     setHeight]     = useState(DEFAULT_H);
  const [collapsed,  setCollapsed]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [preFullH,   setPreFullH]   = useState(DEFAULT_H);
  const dragRef  = useRef<{ startY: number; startH: number } | null>(null);

  // ── resize drag ──────────────────────────────────────────────────────────
  function onHandleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: height };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragRef.current) return;
    const delta  = dragRef.current.startY - e.clientY;
    const newH   = Math.max(MIN_H, dragRef.current.startH + delta);
    setHeight(newH);
  }

  function onMouseUp() {
    dragRef.current = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup',   onMouseUp);
  }

  function toggleCollapse() {
    if (collapsed) {
      setCollapsed(false);
      setHeight(fullscreen ? window.innerHeight * 0.7 : DEFAULT_H);
    } else {
      setFullscreen(false);
      setCollapsed(true);
    }
  }

  function toggleFullscreen() {
    if (fullscreen) {
      setFullscreen(false);
      setHeight(preFullH);
    } else {
      setPreFullH(height);
      setFullscreen(true);
      setCollapsed(false);
      setHeight(window.innerHeight * 0.7);
    }
  }

  const handleViewChart = useCallback((inst: Instrument) => {
    const paneId = wsState.activePane || wsState.panes[0]?.id;
    if (paneId) {
      setActivePane(paneId);
      setPaneView(paneId, 'chart');
    }
    loadInstrumentInActivePane(inst);
  }, [wsState, setActivePane, setPaneView, loadInstrumentInActivePane]);

  const handleExit = useCallback((p: PaperPosition, exitSide: 'BUY' | 'SELL') => {
    const lotSize = p.lot_size || 1;
    const lots    = lotSize > 1 ? Math.ceil(p.qty / lotSize) : p.qty;
    openTicket({
      instrument: {
        stock_name:      p.display_name || p.zanskar_name || String(p.ref_id),
        zanskar_name:    p.zanskar_name,
        ref_id:          p.ref_id,
        exchange:        'NSE',
        derivative_type: p.derivative_type,
        option_type:     p.option_type,
        strike_price:    p.strike_price,
        expiry:          p.expiry,
        lot_size:        p.lot_size,
      },
      qty: lots,
      side: exitSide,
      ltp:  p.last_traded_price,
    });
  }, [openTicket]);

  const effectiveH = collapsed ? HEADER_H : height;

  const TAB_STYLE = (t: string) =>
    `px-4 py-0 h-full flex items-center text-[12px] font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
      tab === t
        ? 'border-[var(--accent)] text-[var(--text-primary)]'
        : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
    }`;

  const iconBtn = 'w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-[14px] transition-colors';

  return (
    <div
      className="flex flex-col bg-[var(--bg-primary)] border-t border-[var(--border)] shrink-0 transition-[height] duration-200"
      style={{ height: effectiveH }}
    >
      {/* drag handle — hidden when collapsed */}
      {!collapsed && (
        <div
          onMouseDown={onHandleMouseDown}
          className="h-1 bg-[var(--border)] hover:bg-[var(--accent)] cursor-row-resize shrink-0 transition-colors"
        />
      )}

      {/* header bar */}
      <div className="h-9 shrink-0 flex items-center border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 gap-1">
        <button onClick={() => setTab('orders')}    className={TAB_STYLE('orders')}>Regular Orders</button>
        <button onClick={() => setTab('positions')} className={TAB_STYLE('positions')}>Positions</button>
        <button onClick={() => setTab('holdings')}  className={TAB_STYLE('holdings')}>Holdings</button>

        <div className="ml-auto flex items-center gap-2 pr-1">
          <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            uatAuth ? 'bg-green-500/15 text-[var(--green)]' : 'bg-[var(--bg-hover)] text-[var(--text-muted)]'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${uatAuth ? 'bg-green-400' : 'bg-[var(--text-muted)]'}`} />
            SIM
          </span>

          {uatAuth && (
            <button
              onClick={() => openTicket()}
              className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[11px] font-semibold hover:bg-[var(--accent-dim)] transition-colors"
            >
              + New Order
            </button>
          )}

          <button onClick={refreshAuthStatus} title="Refresh" className={iconBtn}>↻</button>

          <span className="w-px h-4 bg-[var(--border)]" />

          <button onClick={toggleCollapse} title={collapsed ? 'Expand' : 'Collapse'} className={iconBtn}>
            {collapsed ? '▲' : '▼'}
          </button>
          <button onClick={toggleFullscreen} title={fullscreen ? 'Restore' : 'Full screen'} className={iconBtn}>
            {fullscreen ? '⤡' : '⤢'}
          </button>
        </div>
      </div>

      {/* body */}
      <div className="flex-1 overflow-hidden">
        {!uatAuth ? (
          <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">
            Login to Nubra to use paper trading.
          </div>
        ) : (
          <>
            {tab === 'orders'    && <OrdersTab    uatAuth={uatAuth} />}
            {tab === 'positions' && <PositionsTab uatAuth={uatAuth} onViewChart={handleViewChart} onExit={handleExit} />}
            {tab === 'holdings'  && <HoldingsTab  uatAuth={uatAuth} />}
          </>
        )}
      </div>
    </div>
  );
}
