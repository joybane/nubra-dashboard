import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Instrument, PaperHolding, PaperOrder, PaperPosition, WsMessage, OptionChainData, OptionLeg } from '../types';
import { fmtPrice } from '../lib/utils';
import { usePaperTrading } from '../hooks/usePaperTrading';
import { useWorkspaceState } from '../workspace/useWorkspaceState';
import { useWs } from '../hooks/useWsContext';
import SavedStrategiesTab from './SavedStrategiesTab';

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

function isToday(ns: number | undefined | null): boolean {
  if (!ns) return true;
  const d = new Date(ns / 1_000_000);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function fmtDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayStr(): string { return fmtDateStr(new Date()); }

function shiftDateStr(s: string, days: number): string {
  const d = new Date(s + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return fmtDateStr(d);
}

function matchesDateRange(ns: number | undefined | null, from: string, to: string): boolean {
  if (!ns) return true;
  const dayStr = fmtDateStr(new Date(ns / 1_000_000));
  return dayStr >= from && dayStr <= to;
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

// ─── Grouping helpers ─────────────────────────────────────────────────────────
interface OrderGroup {
  basket_group_id: string;
  strategy_name: string;
  orders: PaperOrder[];
}

function groupOrders(orders: PaperOrder[]): (PaperOrder | OrderGroup)[] {
  const groups = new Map<string, PaperOrder[]>();
  const ungrouped: PaperOrder[] = [];
  for (const o of orders) {
    if (o.basket_group_id) {
      const arr = groups.get(o.basket_group_id) || [];
      arr.push(o);
      groups.set(o.basket_group_id, arr);
    } else {
      ungrouped.push(o);
    }
  }
  const result: (PaperOrder | OrderGroup)[] = [];
  for (const [gid, gOrders] of groups) {
    result.push({ basket_group_id: gid, strategy_name: gOrders[0].strategy_name || 'Basket', orders: gOrders });
  }
  result.push(...ungrouped);
  return result;
}

function isOrderGroup(item: PaperOrder | OrderGroup): item is OrderGroup {
  return 'orders' in item && Array.isArray((item as OrderGroup).orders);
}

function groupStatus(orders: PaperOrder[]): string {
  if (orders.every(o => o.order_status === 'ORDER_STATUS_FILLED')) return 'ORDER_STATUS_FILLED';
  if (orders.some(o => o.order_status === 'ORDER_STATUS_OPEN')) return 'ORDER_STATUS_OPEN';
  if (orders.some(o => o.order_status === 'ORDER_STATUS_PENDING')) return 'ORDER_STATUS_PENDING';
  if (orders.every(o => o.order_status === 'ORDER_STATUS_CANCELLED')) return 'ORDER_STATUS_CANCELLED';
  return orders[0].order_status;
}

// ─── Orders table ─────────────────────────────────────────────────────────────
function OrdersTab({ uatAuth, onOpenStrategyChart }: { uatAuth: boolean; onOpenStrategyChart?: (basketGroupId: string, strategyName: string) => void }) {
  const [openOrders,   setOpenOrders]   = useState<PaperOrder[]>([]);
  const [closedOrders, setClosedOrders] = useState<PaperOrder[]>([]);
  const [subTab,       setSubTab]       = useState<'open' | 'closed'>('open');
  const [loading,      setLoading]      = useState(false);
  const [cancelling,   setCancelling]   = useState<number | null>(null);
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingName,  setEditingName]  = useState('');
  const [showHistory,  setShowHistory]  = useState(false);
  const [histFrom,     setHistFrom]     = useState('');
  const [histTo,       setHistTo]       = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toggleExpand = useCallback((gid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  }, []);

  const fetchOrders = useCallback(async () => {
    if (!uatAuth) return;
    try {
      const [liveRes, doneRes] = await Promise.all([
        fetch('/paper/orders?live=1'),
        fetch('/paper/orders?executed=1'),
      ]);
      if (liveRes.ok) {
        const d = await liveRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        setOpenOrders(Array.isArray(d) ? d : (d.orders ?? []));
      }
      if (doneRes.ok) {
        const d = await doneRes.json() as PaperOrder[] | { orders?: PaperOrder[] };
        setClosedOrders(Array.isArray(d) ? d : (d.orders ?? []));
      }
    } catch (e) { console.warn('[Orders] fetchOrders failed:', e); }
  }, [uatAuth]);

  useEffect(() => {
    if (!uatAuth) return;
    setLoading(true);
    fetchOrders().finally(() => setLoading(false));
    timerRef.current = setInterval(fetchOrders, 5000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [uatAuth, fetchOrders]);

  const commitRename = useCallback(async (basketGroupId: string) => {
    const name = editingName.trim();
    setEditingGroup(null);
    if (!name) return;
    try {
      await fetch('/paper/strategy/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basket_group_id: basketGroupId, name }) });
      fetchOrders();
    } catch (e) { console.warn('[Orders] commitRename failed:', e); }
  }, [editingName, fetchOrders]);

  async function cancelOrder(id: number) {
    setCancelling(id);
    try {
      await fetch(`/paper/orders/${id}`, { method: 'DELETE' });
      await fetchOrders();
    } catch (e) { console.warn('[Orders] cancelOrder failed:', e); }
    finally { setCancelling(null); }
  }

  const filteredOpen   = openOrders.filter(o => isToday(o.order_time));
  const filteredClosed = closedOrders.filter(o => isToday(o.order_time));
  const historyOrders  = showHistory
    ? [...openOrders, ...closedOrders]
        .filter(o => matchesDateRange(o.order_time, histFrom, histTo))
        .sort((a, b) => b.order_time - a.order_time)
    : [];
  const rows = showHistory ? historyOrders : (subTab === 'open' ? filteredOpen : filteredClosed);
  const grouped = groupOrders(rows);

  function renderOrderRow(o: PaperOrder, indent = false) {
    const isBuy    = o.order_side === 'ORDER_SIDE_BUY';
    const canCancel = o.order_status === 'ORDER_STATUS_PENDING' || o.order_status === 'ORDER_STATUS_OPEN';
    return (
      <tr key={o.order_id} className={`border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] ${indent ? 'bg-[var(--bg-primary)]/50' : ''}`}>
        <td className={`px-3 py-1.5 font-semibold text-[var(--text-primary)] whitespace-nowrap ${indent ? 'pl-8' : ''}`}>{displayName(o)}</td>
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
  }

  const tdy = todayStr();
  const openHistory = () => { const y = shiftDateStr(tdy, -1); setHistFrom(y); setHistTo(y); setShowHistory(true); };
  const closeHistory = () => setShowHistory(false);
  const shiftDates = (days: number) => {
    setHistFrom(f => { const n = shiftDateStr(f, days); return n > tdy ? f : n; });
    setHistTo(t => { const n = shiftDateStr(t, days); return n > tdy ? tdy : n; });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* sub-tab row OR history bar */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        {showHistory ? (<>
          <button onClick={() => shiftDates(-1)} className="w-5 h-5 rounded flex items-center justify-center text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors" title="Previous day">◀</button>
          <input type="date" value={histFrom} max={tdy} onChange={e => { const v = e.target.value; if (v) { setHistFrom(v); setHistTo(t => t < v ? v : t); } }}
            className="bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]" />
          <button onClick={() => shiftDates(1)} disabled={histTo >= tdy} className="w-5 h-5 rounded flex items-center justify-center text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30" title="Next day">▶</button>
          <span className="text-[10px] text-[var(--text-muted)] mx-1">to</span>
          <input type="date" value={histTo} min={histFrom} max={tdy} onChange={e => { const v = e.target.value; if (v) setHistTo(v); }}
            className="bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]" />
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">{historyOrders.length} orders</span>
          <button onClick={closeHistory} className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 transition-colors" title="Back to today">Today</button>
        </>) : (<>
          {(['open', 'closed'] as const).map((t) => (
            <button key={t} onClick={() => setSubTab(t)}
              className={`px-3 py-0.5 rounded text-[11px] font-semibold transition-all ${
                subTab === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t === 'open' ? `Open ${filteredOpen.length}` : `Closed ${filteredClosed.length}`}
            </button>
          ))}
          <button onClick={openHistory}
            className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
            title="View past orders"
          >
            History
          </button>
        </>)}
        {loading && <span className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin ml-2" />}
      </div>

      {/* table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse tabular-nums">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
            <tr className="text-[var(--text-muted)] font-medium">
              {['Symbol', 'Status', 'Time', 'Product', 'Side', 'Qty', 'Price', 'Trigger', 'Avg Price', ''].map((h) => (
                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-8 text-[var(--text-muted)]">
                  {showHistory ? 'No orders for this period' : subTab === 'open' ? 'No open orders' : 'No closed orders'}
                </td>
              </tr>
            )}
            {grouped.map((item) => {
              if (!isOrderGroup(item)) return renderOrderRow(item);
              const g = item;
              const isOpen = expanded.has(g.basket_group_id);
              const status = groupStatus(g.orders);
              const totalQty = g.orders.reduce((s, o) => s + o.order_qty, 0);
              const filledQty = g.orders.reduce((s, o) => s + o.filled_qty, 0);
              return (
                <React.Fragment key={g.basket_group_id}>
                  <tr
                    className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer bg-[var(--accent)]/[0.03]"
                    onClick={() => toggleExpand(g.basket_group_id)}
                  >
                    <td className="px-3 py-1.5 font-semibold text-[var(--accent)] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] text-[var(--text-muted)] w-3 inline-block">{isOpen ? '▾' : '▸'}</span>
                        {editingGroup === g.basket_group_id ? (
                          <input
                            type="text" value={editingName} autoFocus
                            onClick={e => e.stopPropagation()}
                            onChange={e => setEditingName(e.target.value)}
                            onBlur={() => commitRename(g.basket_group_id)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(g.basket_group_id); if (e.key === 'Escape') setEditingGroup(null); }}
                            className="bg-[var(--bg-primary)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text-primary)] outline-none"
                            style={{ width: Math.max(80, editingName.length * 7 + 20) }}
                          />
                        ) : (
                          <>
                            {g.strategy_name}
                            <button
                              onClick={e => { e.stopPropagation(); setEditingGroup(g.basket_group_id); setEditingName(g.strategy_name); }}
                              className="w-3.5 h-3.5 rounded flex items-center justify-center text-[8px] font-semibold text-[var(--text-primary)] bg-white/10 hover:bg-white/20 border border-white/30 transition-colors ml-1"
                              title="Rename strategy"
                            >R</button>
                            {onOpenStrategyChart && (
                              <button
                                onClick={e => { e.stopPropagation(); onOpenStrategyChart(g.basket_group_id, g.strategy_name); }}
                                className="p-0.5 rounded text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors ml-1"
                                title="Strategy P&L chart"
                              >📈</button>
                            )}
                          </>
                        )}
                        <span className="text-[10px] text-[var(--text-muted)] font-normal">({g.orders.length} legs)</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${STATUS_STYLE[status] || ''}`}>
                        {STATUS_LABEL[status] || status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(g.orders[0].order_time)}</td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{productLabel(g.orders[0].order_delivery_type)}</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{filledQty}/{totalQty}</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5" />
                  </tr>
                  {isOpen && g.orders.map(o => renderOrderRow(o, true))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Position grouping ───────────────────────────────────────────────────────
interface PositionGroup {
  basket_group_id: string;
  strategy_name: string;
  positions: PaperPosition[];
}

function groupPositions(positions: PaperPosition[]): (PaperPosition | PositionGroup)[] {
  const groups = new Map<string, PaperPosition[]>();
  const ungrouped: PaperPosition[] = [];
  for (const p of positions) {
    if (p.basket_group_id) {
      const arr = groups.get(p.basket_group_id) || [];
      arr.push(p);
      groups.set(p.basket_group_id, arr);
    } else {
      ungrouped.push(p);
    }
  }
  const result: (PaperPosition | PositionGroup)[] = [];
  for (const [gid, gPos] of groups) {
    result.push({ basket_group_id: gid, strategy_name: gPos[0].strategy_name || 'Basket', positions: gPos });
  }
  result.push(...ungrouped);
  return result;
}

function isPositionGroup(item: PaperPosition | PositionGroup): item is PositionGroup {
  return 'positions' in item && Array.isArray((item as PositionGroup).positions);
}

function groupMarginPaise(positions: PaperPosition[]): number {
  const withMargin = positions.find(p => typeof p.margin_required === 'number' && p.margin_required > 0);
  return withMargin?.margin_required ?? 0;
}

function groupMarginKey(strategyName: string, positions: PaperPosition[]): string {
  const product = positions[0]?.product || '';
  return `${strategyName.trim().toLowerCase()}|${positions.length}|${product}`;
}

function parsePositionOption(p: PaperPosition): { symbol?: string; strike?: number; optionType?: 'CE' | 'PE' } {
  const explicitType = String(p.option_type || '').toUpperCase();
  const optionType = explicitType === 'CE' || explicitType === 'PE'
    ? explicitType
    : ((`${p.display_name || ''} ${p.zanskar_name || ''}`.toUpperCase().match(/\b(CE|PE)\b|(\d+)(CE|PE)$/)?.[1]
      || `${p.display_name || ''} ${p.zanskar_name || ''}`.toUpperCase().match(/\b(CE|PE)\b|(\d+)(CE|PE)$/)?.[3]) as 'CE' | 'PE' | undefined);
  const strike = Number(p.strike_price || (`${p.display_name || ''} ${p.zanskar_name || ''}`.match(/(\d+(?:\.\d+)?)\s*(?:CE|PE)\b/i)?.[1] ?? 0));
  const symbol = String(p.display_name || p.zanskar_name || '')
    .trim()
    .split(/\s+/)[0]
    ?.replace(/\d.*$/, '')
    .toUpperCase();
  return { symbol: symbol || undefined, strike: strike > 0 ? strike : undefined, optionType };
}

async function fetchPositionGroupMarginPaise(positions: PaperPosition[]): Promise<number> {
  const orders = positions
    .filter(p => p.ref_id && p.qty)
    .map(p => {
      const opt = parsePositionOption(p);
      return {
        ref_id: p.ref_id,
        order_qty: Math.abs(p.qty),
        strike: opt.strike,
        option_type: opt.optionType,
        ltp: (p.last_traded_price || p.avg_price || 0) / 100,
        lot_size: p.lot_size,
        expiry: p.expiry,
        symbol: opt.symbol,
        order_side: (p.order_side || '').includes('BUY') ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
        order_delivery_type: p.product === 'MIS' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
      };
    });
  if (!orders.length) return 0;

  const res = await fetch('/paper/margin/basket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange: 'NSE', multiplier: 1, orders }),
  });
  if (!res.ok) return 0;
  const data = await res.json() as Record<string, unknown>;
  return Number(data.total_margin ?? 0);
}

// ─── Positions tab ────────────────────────────────────────────────────────────
interface PositionsTabProps {
  uatAuth: boolean;
  onViewChart?: (inst: Instrument) => void;
  onExit?: (p: PaperPosition, side: 'BUY' | 'SELL') => void;
  onOpenStrategyChart?: (basketGroupId: string, strategyName: string) => void;
}

function PositionsTab({ uatAuth, onViewChart, onExit, onOpenStrategyChart }: PositionsTabProps) {
  const [positions,       setPositions]       = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
  const [subTab,          setSubTab]          = useState<'open' | 'closed'>('open');
  const [loading,   setLoading]   = useState(false);
  const [exiting,   setExiting]   = useState<Set<string>>(new Set());
  const [expanded,  setExpanded]  = useState<Set<string>>(new Set());
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [editingName,  setEditingName]  = useState('');
  const [showHistory,  setShowHistory]  = useState(false);
  const [histFrom,     setHistFrom]     = useState('');
  const [histTo,       setHistTo]       = useState('');
  const [detailPos,    setDetailPos]    = useState<PaperPosition | null>(null);
  const [groupMargins, setGroupMargins] = useState<Record<string, number>>({});
  const groupMarginsRef = useRef<Record<string, number>>({});
  const marginRequestsRef = useRef<Set<string>>(new Set());
  const { subscribe } = useWs();

  const posExitKey = (p: PaperPosition) => `${p.ref_id}:${p.basket_group_id || ''}`;

  const toggleExpand = useCallback((gid: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid); else next.add(gid);
      return next;
    });
  }, []);

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
    } catch (e) { console.warn('[Positions] fetch failed:', e); }
  }, [uatAuth]);

  const commitRename = useCallback(async (basketGroupId: string) => {
    const name = editingName.trim();
    setEditingGroup(null);
    if (!name) return;
    try {
      await fetch('/paper/strategy/rename', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basket_group_id: basketGroupId, name }) });
      fetch_();
    } catch (e) { console.warn('[Positions] commitRename failed:', e); }
  }, [editingName, fetch_]);

  useEffect(() => {
    if (!uatAuth) return;
    setLoading(true);
    fetch_().finally(() => setLoading(false));
    const t = setInterval(fetch_, 2000);
    return () => clearInterval(t);
  }, [uatAuth, fetch_]);

  useEffect(() => {
    const unsub1 = subscribe('option_chain', (msg: WsMessage) => {
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

    const unsub2 = subscribe('position_ltp', (msg: WsMessage) => {
      if (msg.type !== 'position_ltp') return;
      const updates = msg.data as { ref_id: number; ltp: number }[];
      if (!updates || updates.length === 0) return;
      const ltpMap = new Map<number, number>();
      for (const u of updates) ltpMap.set(u.ref_id, u.ltp);
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

    return () => { unsub1(); unsub2(); };
  }, [subscribe]);

  const exitDirect = useCallback(async (p: PaperPosition) => {
    const ek = posExitKey(p);
    if (exiting.has(ek)) return;
    setExiting(prev => new Set(prev).add(ek));
    const exitSide = (p.order_side || '').includes('BUY') ? 'ORDER_SIDE_SELL' : 'ORDER_SIDE_BUY';
    try {
      let nubraName = p.zanskar_name || '';
      if (!nubraName && p.ref_id) {
        const res = await fetch(`/api/instruments/lookup?ref_id=${p.ref_id}`);
        const d = await res.json() as { instrument: Record<string, unknown> | null };
        if (d.instrument) nubraName = (d.instrument.zanskar_name || d.instrument.nubra_name || '') as string;
      }
      if (!nubraName) { setExiting(prev => { const s = new Set(prev); s.delete(ek); return s; }); return; }
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
          basket_group_id: p.basket_group_id || undefined,
          strategy_name: p.strategy_name || undefined,
        }),
      });
      setTimeout(fetch_, 500);
    } catch (e) { console.warn('[Positions] exitDirect failed:', e); }
  }, [exiting, fetch_]);

  const exitAllInGroup = useCallback(async (gPositions: PaperPosition[]) => {
    for (const p of gPositions) {
      if (!exiting.has(posExitKey(p))) exitDirect(p);
    }
  }, [exiting, exitDirect]);

  const exitAll = useCallback(async () => {
    for (const p of positions) {
      if (!exiting.has(posExitKey(p))) exitDirect(p);
    }
  }, [positions, exiting, exitDirect]);

  const openPnl = positions.reduce((s, p) => {
    const side = (p.order_side || '').includes('BUY') ? 1 : -1;
    return s + side * ((p.last_traded_price || 0) - (p.avg_price || 0)) * (p.qty || 0);
  }, 0);
  const closedPnl = closedPositions
    .filter(p => isToday(p.exit_time) || isToday(p.entry_time))
    .reduce((s, p) => s + (p.realised_pnl || p.pnl || 0), 0);
  const totalPnl = openPnl + closedPnl;

  const filteredOpen   = positions.filter(p => isToday(p.entry_time));
  const filteredClosed = closedPositions.filter(p => isToday(p.exit_time) || isToday(p.entry_time));
  const historyPositions = showHistory
    ? closedPositions.filter(p => matchesDateRange(p.exit_time || p.entry_time, histFrom, histTo))
    : [];
  const groupedOpen    = groupPositions(filteredOpen);
  const groupedClosed  = groupPositions(filteredClosed);
  const groupedHistory = groupPositions(historyPositions);

  const knownGroupMargins = useMemo(() => {
    const out: Record<string, number> = {};
    for (const item of groupPositions(closedPositions)) {
      if (!isPositionGroup(item)) continue;
      const margin = groupMarginPaise(item.positions);
      if (margin > 0) out[groupMarginKey(item.strategy_name, item.positions)] = margin;
    }
    return out;
  }, [closedPositions]);

  function resolvedGroupMarginPaise(g: PositionGroup): number {
    return groupMargins[g.basket_group_id]
      || groupMarginPaise(g.positions)
      || knownGroupMargins[groupMarginKey(g.strategy_name, g.positions)]
      || 0;
  }

  useEffect(() => { groupMarginsRef.current = groupMargins; }, [groupMargins]);

  useEffect(() => {
    if (!uatAuth) return;
    const groups = groupPositions(positions).filter(isPositionGroup);
    for (const g of groups) {
      if (groupMarginsRef.current[g.basket_group_id] != null) continue;
      if (marginRequestsRef.current.has(g.basket_group_id)) continue;
      marginRequestsRef.current.add(g.basket_group_id);
      fetchPositionGroupMarginPaise(g.positions)
        .then(total => {
          if (total > 0) setGroupMargins(prev => ({ ...prev, [g.basket_group_id]: total }));
        })
        .catch(e => console.warn('[Positions] group margin fallback failed:', e))
        .finally(() => marginRequestsRef.current.delete(g.basket_group_id));
    }
  }, [positions, uatAuth]);

  function calcPnl(p: PaperPosition): number {
    const side = (p.order_side || '').includes('BUY') ? 1 : -1;
    return side * ((p.last_traded_price || 0) - (p.avg_price || 0)) * (p.qty || 0) / 100;
  }

  function renderPositionRow(p: PaperPosition, indent = false) {
    const side = (p.order_side || '').includes('BUY') ? 'BUY' : 'SELL';
    const pnl  = calcPnl(p);
    const ek   = posExitKey(p);
    return (
      <tr key={ek} className={`border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer ${indent ? 'bg-[var(--bg-primary)]/50' : ''}`} onClick={() => setDetailPos(p)}>
        <td className={`px-3 py-1.5 font-semibold text-[var(--text-primary)] ${indent ? 'pl-8' : ''}`}>{p.display_name || p.zanskar_name || p.ref_id}</td>
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
        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.entry_time)}</td>
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1">
            {onViewChart && (
              <button
                onClick={() => onViewChart({
                  stock_name: p.display_name || p.zanskar_name || String(p.ref_id),
                  ref_id: p.ref_id, exchange: 'NSE',
                  derivative_type: p.derivative_type, option_type: p.option_type,
                  strike_price: p.strike_price, expiry: p.expiry,
                })}
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-[var(--text-primary)] bg-white/10 hover:bg-white/20 border border-white/30 transition-colors"
                title="View chart"
              >
                Chart
              </button>
            )}
            <button
              onClick={() => exitDirect(p)}
              disabled={exiting.has(ek)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${exiting.has(ek) ? 'text-[var(--text-muted)] bg-[var(--bg-hover)] border border-[var(--border)] cursor-not-allowed' : 'text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30'}`}
              title={exiting.has(ek) ? 'Exit order placed' : 'Exit position'}
            >
              Exit
            </button>
          </div>
        </td>
      </tr>
    );
  }

  function renderClosedPositionRow(p: PaperPosition, indent = false) {
    const pnl = (p.realised_pnl || p.pnl || 0) / 100;
    const ek = posExitKey(p);
    return (
      <tr key={ek} className={`border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer ${indent ? 'bg-[var(--bg-primary)]/50' : ''}`} onClick={() => setDetailPos(p)}>
        <td className={`px-3 py-1.5 font-semibold text-[var(--text-primary)] ${indent ? 'pl-8' : ''}`}>{p.display_name || p.zanskar_name || p.ref_id}</td>
        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.product || 'NRML'}</td>
        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{paise(p.avg_price)}</td>
        <td className="px-3 py-1.5 text-[var(--text-secondary)]">{p.exit_price ? paise(p.exit_price) : '—'}</td>
        <td className={`px-3 py-1.5 font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
          {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
        </td>
        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.entry_time)}</td>
        <td className="px-3 py-1.5 text-[var(--text-secondary)] whitespace-nowrap">{fmtTime(p.exit_time)}</td>
      </tr>
    );
  }

  const tdy = todayStr();
  const openHistory = () => { const y = shiftDateStr(tdy, -1); setHistFrom(y); setHistTo(y); setShowHistory(true); };
  const closeHistory = () => setShowHistory(false);
  const shiftDates = (days: number) => {
    setHistFrom(f => { const n = shiftDateStr(f, days); return n > tdy ? f : n; });
    setHistTo(t => { const n = shiftDateStr(t, days); return n > tdy ? tdy : n; });
  };

  const histHeaders = ['Symbol', 'Product', 'Entry Price', 'Exit Price', 'P&L', 'Entry Time', 'Exit Time'];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* sub-tab row OR history bar */}
      <div className="h-8 shrink-0 flex items-center gap-1 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
        {showHistory ? (<>
          <button onClick={() => shiftDates(-1)} className="w-5 h-5 rounded flex items-center justify-center text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors" title="Previous day">◀</button>
          <input type="date" value={histFrom} max={tdy} onChange={e => { const v = e.target.value; if (v) { setHistFrom(v); setHistTo(t => t < v ? v : t); } }}
            className="bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]" />
          <button onClick={() => shiftDates(1)} disabled={histTo >= tdy} className="w-5 h-5 rounded flex items-center justify-center text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30" title="Next day">▶</button>
          <span className="text-[10px] text-[var(--text-muted)] mx-1">to</span>
          <input type="date" value={histTo} min={histFrom} max={tdy} onChange={e => { const v = e.target.value; if (v) setHistTo(v); }}
            className="bg-[var(--bg-primary)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] [color-scheme:dark]" />
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">{historyPositions.length} positions</span>
          <button onClick={closeHistory} className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/20 transition-colors" title="Back to today">Today</button>
        </>) : (<>
          {(['open', 'closed'] as const).map((t) => (
            <button key={t} onClick={() => setSubTab(t)}
              className={`px-3 py-0.5 rounded text-[11px] font-semibold transition-all ${
                subTab === t ? 'bg-[var(--accent)]/15 text-[var(--accent)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t === 'open' ? `Open ${filteredOpen.length}` : `Closed ${filteredClosed.length}`}
            </button>
          ))}
          <button onClick={openHistory}
            className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all"
            title="View past positions"
          >
            History
          </button>
          <span className="ml-auto text-[11px] text-[var(--text-muted)]">
            Day P&L: <span className={totalPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{totalPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(totalPnl / 100))}</span>
          </span>
          {subTab === 'open' && filteredOpen.length > 0 && (
            <button
              onClick={exitAll}
              disabled={positions.every(p => exiting.has(posExitKey(p)))}
              className="px-2 py-0.5 rounded text-[10px] font-semibold text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30 transition-colors"
            >
              Exit All
            </button>
          )}
        </>)}
        {loading && <span className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin ml-2" />}
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse tabular-nums">
          <thead className="sticky top-0 bg-[var(--bg-secondary)] z-10">
            <tr className="text-[var(--text-muted)]">
              {(showHistory
                ? histHeaders
                : subTab === 'open'
                  ? ['Symbol', 'Product', 'Side', 'Qty', 'Entry Price', 'LTP', 'P&L', 'P&L %', 'Entry Time', '']
                  : ['Symbol', 'Product', 'Entry Price', 'Exit Price', 'P&L', 'Entry Time', 'Exit Time']
              ).map((h) => (
                <th key={h} className="px-3 py-1.5 text-left font-medium whitespace-nowrap border-b border-[var(--border)]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {showHistory && groupedHistory.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[var(--text-muted)]">No positions for this period</td></tr>
            )}
            {showHistory && groupedHistory.map((item) => {
              if (!isPositionGroup(item)) return renderClosedPositionRow(item);
              const g = item;
              const isExp = expanded.has(g.basket_group_id);
              const groupPnl = g.positions.reduce((s, p) => s + (p.realised_pnl || p.pnl || 0) / 100, 0);
              const gMargin = resolvedGroupMarginPaise(g);
              const gMarginRs = gMargin / 100;
              const gRoi = gMarginRs > 0 ? (groupPnl / gMarginRs) * 100 : 0;
              return (
                <React.Fragment key={g.basket_group_id}>
                  <tr className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer bg-[var(--accent)]/[0.03]" onClick={() => toggleExpand(g.basket_group_id)}>
                    <td className="px-3 py-1.5 font-semibold text-[var(--accent)] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] text-[var(--text-muted)] w-3 inline-block">{isExp ? '▾' : '▸'}</span>
                        {g.strategy_name}
                        {onOpenStrategyChart && (
                          <button
                            onClick={e => { e.stopPropagation(); onOpenStrategyChart(g.basket_group_id, g.strategy_name); }}
                            className="p-0.5 rounded text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors ml-1"
                            title="Strategy P&L chart"
                          >📈</button>
                        )}
                        <span className="text-[10px] text-[var(--text-muted)] font-normal">({g.positions.length} legs)</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{g.positions[0].product || 'NRML'}</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" colSpan={3}>
                      <span className={`font-semibold ${groupPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        {groupPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(groupPnl))}
                      </span>
                      {gMarginRs > 0 && (<>
                        <span className="text-[var(--text-muted)] ml-3 text-[11px]">Margin ₹{fmtPrice(gMarginRs)}</span>
                        <span className={`ml-2 text-[11px] font-semibold ${gRoi >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>ROI {gRoi >= 0 ? '+' : ''}{gRoi.toFixed(1)}%</span>
                      </>)}
                    </td>
                  </tr>
                  {isExp && g.positions.map(p => renderClosedPositionRow(p, true))}
                </React.Fragment>
              );
            })}
            {!showHistory && subTab === 'open' && groupedOpen.length === 0 && (
              <tr><td colSpan={10} className="text-center py-8 text-[var(--text-muted)]">No open positions</td></tr>
            )}
            {!showHistory && subTab === 'open' && groupedOpen.map((item) => {
              if (!isPositionGroup(item)) return renderPositionRow(item);
              const g = item;
              const isOpen = expanded.has(g.basket_group_id);
              const groupPnl = g.positions.reduce((s, p) => s + calcPnl(p), 0);
              const allExiting = g.positions.every(p => exiting.has(posExitKey(p)));
              const gMargin = resolvedGroupMarginPaise(g);
              const gMarginRs = gMargin / 100;
              const gRoi = gMarginRs > 0 ? (groupPnl / gMarginRs) * 100 : 0;
              return (
                <React.Fragment key={g.basket_group_id}>
                  <tr
                    className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer bg-[var(--accent)]/[0.03]"
                    onClick={() => toggleExpand(g.basket_group_id)}
                  >
                    <td className="px-3 py-1.5 font-semibold text-[var(--accent)] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] text-[var(--text-muted)] w-3 inline-block">{isOpen ? '▾' : '▸'}</span>
                        {editingGroup === g.basket_group_id ? (
                          <input
                            type="text" value={editingName} autoFocus
                            onClick={e => e.stopPropagation()}
                            onChange={e => setEditingName(e.target.value)}
                            onBlur={() => commitRename(g.basket_group_id)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(g.basket_group_id); if (e.key === 'Escape') setEditingGroup(null); }}
                            className="bg-[var(--bg-primary)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text-primary)] outline-none"
                            style={{ width: Math.max(80, editingName.length * 7 + 20) }}
                          />
                        ) : (
                          <>
                            {g.strategy_name}
                            <button
                              onClick={e => { e.stopPropagation(); setEditingGroup(g.basket_group_id); setEditingName(g.strategy_name); }}
                              className="w-3.5 h-3.5 rounded flex items-center justify-center text-[8px] font-semibold text-[var(--text-primary)] bg-white/10 hover:bg-white/20 border border-white/30 transition-colors ml-1"
                              title="Rename strategy"
                            >R</button>
                            {onOpenStrategyChart && (
                              <button
                                onClick={e => { e.stopPropagation(); onOpenStrategyChart(g.basket_group_id, g.strategy_name); }}
                                className="p-0.5 rounded text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors ml-1"
                                title="Strategy P&L chart"
                              >📈</button>
                            )}
                          </>
                        )}
                        <span className="text-[10px] text-[var(--text-muted)] font-normal">({g.positions.length} legs)</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{g.positions[0].product || 'NRML'}</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" colSpan={3}>
                      <span className={`font-semibold ${groupPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        {groupPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(groupPnl))}
                      </span>
                      {gMarginRs > 0 && (<>
                        <span className="text-[var(--text-muted)] ml-3 text-[11px]">Margin ₹{fmtPrice(gMarginRs)}</span>
                        <span className={`ml-2 text-[11px] font-semibold ${gRoi >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>ROI {gRoi >= 0 ? '+' : ''}{gRoi.toFixed(1)}%</span>
                      </>)}
                    </td>
                    <td className="px-3 py-1.5" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => exitAllInGroup(g.positions)}
                        disabled={allExiting}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${allExiting ? 'text-[var(--text-muted)] bg-[var(--bg-hover)] border border-[var(--border)] cursor-not-allowed' : 'text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30'}`}
                        title="Exit all legs"
                      >
                        Exit All
                      </button>
                    </td>
                  </tr>
                  {isOpen && g.positions.map(p => renderPositionRow(p, true))}
                </React.Fragment>
              );
            })}
            {!showHistory && subTab === 'closed' && groupedClosed.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-[var(--text-muted)]">No closed positions</td></tr>
            )}
            {!showHistory && subTab === 'closed' && groupedClosed.map((item) => {
              if (!isPositionGroup(item)) return renderClosedPositionRow(item);
              const g = item;
              const isOpen = expanded.has(g.basket_group_id);
              const groupPnl = g.positions.reduce((s, p) => s + (p.realised_pnl || p.pnl || 0) / 100, 0);
              const gMargin = resolvedGroupMarginPaise(g);
              const gMarginRs = gMargin / 100;
              const gRoi = gMarginRs > 0 ? (groupPnl / gMarginRs) * 100 : 0;
              return (
                <React.Fragment key={g.basket_group_id}>
                  <tr
                    className="border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] cursor-pointer bg-[var(--accent)]/[0.03]"
                    onClick={() => toggleExpand(g.basket_group_id)}
                  >
                    <td className="px-3 py-1.5 font-semibold text-[var(--accent)] whitespace-nowrap">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[10px] text-[var(--text-muted)] w-3 inline-block">{isOpen ? '▾' : '▸'}</span>
                        {editingGroup === g.basket_group_id ? (
                          <input
                            type="text" value={editingName} autoFocus
                            onClick={e => e.stopPropagation()}
                            onChange={e => setEditingName(e.target.value)}
                            onBlur={() => commitRename(g.basket_group_id)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(g.basket_group_id); if (e.key === 'Escape') setEditingGroup(null); }}
                            className="bg-[var(--bg-primary)] border border-[var(--accent)] rounded px-1.5 py-0.5 text-[11px] font-semibold text-[var(--text-primary)] outline-none"
                            style={{ width: Math.max(80, editingName.length * 7 + 20) }}
                          />
                        ) : (
                          <>
                            {g.strategy_name}
                            <button
                              onClick={e => { e.stopPropagation(); setEditingGroup(g.basket_group_id); setEditingName(g.strategy_name); }}
                              className="w-3.5 h-3.5 rounded flex items-center justify-center text-[8px] font-semibold text-[var(--text-primary)] bg-white/10 hover:bg-white/20 border border-white/30 transition-colors ml-1"
                              title="Rename strategy"
                            >R</button>
                            {onOpenStrategyChart && (
                              <button
                                onClick={e => { e.stopPropagation(); onOpenStrategyChart(g.basket_group_id, g.strategy_name); }}
                                className="p-0.5 rounded text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors ml-1"
                                title="Strategy P&L chart"
                              >📈</button>
                            )}
                          </>
                        )}
                        <span className="text-[10px] text-[var(--text-muted)] font-normal">({g.positions.length} legs)</span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[var(--text-secondary)]">{g.positions[0].product || 'NRML'}</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 text-[var(--text-muted)]">—</td>
                    <td className="px-3 py-1.5 whitespace-nowrap" colSpan={3}>
                      <span className={`font-semibold ${groupPnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                        {groupPnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(groupPnl))}
                      </span>
                      {gMarginRs > 0 && (<>
                        <span className="text-[var(--text-muted)] ml-3 text-[11px]">Margin ₹{fmtPrice(gMarginRs)}</span>
                        <span className={`ml-2 text-[11px] font-semibold ${gRoi >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>ROI {gRoi >= 0 ? '+' : ''}{gRoi.toFixed(1)}%</span>
                      </>)}
                    </td>
                  </tr>
                  {isOpen && g.positions.map(p => renderClosedPositionRow(p, true))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Detail panel modal */}
      {detailPos && (() => {
        const dp = detailPos;
        const isOpen = (dp.qty || 0) > 0;
        const side = (dp.order_side || '').includes('BUY') ? 'BUY' : 'SELL';
        const pnl = isOpen ? calcPnl(dp) : (dp.realised_pnl || dp.pnl || 0) / 100;
        const marginRs = dp.margin_required ? dp.margin_required / 100 : 0;
        const roi = marginRs > 0 ? (pnl / marginRs) * 100 : 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setDetailPos(null)}>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl w-80 p-4" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[13px] font-semibold text-[var(--text-primary)]">{dp.display_name || dp.zanskar_name || dp.ref_id}</span>
                <button onClick={() => setDetailPos(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none">&times;</button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <div className="text-[var(--text-muted)]">Side</div>
                  <div className={`font-semibold ${side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>{side}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Qty</div>
                  <div className="text-[var(--text-primary)] font-semibold">{dp.qty || '—'}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Entry Price</div>
                  <div className="text-[var(--text-primary)]">{paise(dp.avg_price)}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">{isOpen ? 'LTP' : 'Exit Price'}</div>
                  <div className="text-[var(--text-primary)]">{isOpen ? paise(dp.last_traded_price) : paise(dp.exit_price)}</div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">P&L</div>
                  <div className={`font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--text-muted)]">Product</div>
                  <div className="text-[var(--text-primary)]">{dp.product || 'NRML'}</div>
                </div>
              </div>
              {marginRs > 0 && (
                <div className="mt-3 pt-3 border-t border-[var(--border)] flex items-center gap-4 text-[11px]">
                  <div>
                    <div className="text-[var(--text-muted)]">Margin Required</div>
                    <div className="text-[var(--text-primary)] font-semibold">₹{fmtPrice(marginRs)}</div>
                  </div>
                  <div>
                    <div className="text-[var(--text-muted)]">Return on Margin</div>
                    <div className={`font-semibold ${roi >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                      {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
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
    } catch (e) { console.warn('[Holdings] fetch failed:', e); }
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
        <table className="w-full text-[11px] border-collapse tabular-nums">
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
export default function OrderTerminal({ onOpenStrategyChart }: { onOpenStrategyChart?: (basketGroupId: string, strategyName: string, snapshotId?: string) => void }) {
  const { authenticated: uatAuth, refreshAuthStatus, openTicket } = usePaperTrading();
  const { state: wsState, setPaneView, setActivePane, loadInstrumentInActivePane } = useWorkspaceState();
  const [tab,        setTab]        = useState<'orders' | 'positions' | 'holdings' | 'saved'>('orders');
  const [height,     setHeight]     = useState(DEFAULT_H);
  const [collapsed,  setCollapsed]  = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [preFullH,   setPreFullH]   = useState(DEFAULT_H);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── resize drag (direct DOM for smoothness, sync state on mouseup) ────
  function onHandleMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const el = containerRef.current;
    if (!el) return;
    const startH = el.getBoundingClientRect().height;
    el.style.transition = 'none';

    const onMove = (ev: MouseEvent) => {
      const newH = Math.max(MIN_H, startH + (startY - ev.clientY));
      el.style.height = `${newH}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const final = parseInt(el.style.height, 10);
      el.style.transition = '';
      if (!isNaN(final)) setHeight(final);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
      ref={containerRef}
      className="flex flex-col bg-[var(--bg-primary)] border-t border-[var(--border)] shrink-0 transition-[height] duration-200"
      style={{ height: effectiveH }}
    >
      {/* drag handle — hidden when collapsed */}
      {!collapsed && (
        <div
          onMouseDown={onHandleMouseDown}
          className="h-1.5 bg-[var(--border)] hover:bg-[var(--accent)] cursor-row-resize shrink-0 transition-colors"
        />
      )}

      {/* header bar */}
      <div className="h-9 shrink-0 flex items-center border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 gap-1">
        <button onClick={() => setTab('orders')}    className={TAB_STYLE('orders')}>Regular Orders</button>
        <button onClick={() => setTab('positions')} className={TAB_STYLE('positions')}>Positions</button>
        <button onClick={() => setTab('holdings')}  className={TAB_STYLE('holdings')}>Holdings</button>
        <button onClick={() => setTab('saved')}     className={TAB_STYLE('saved')}>Saved</button>

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
          <div className="flex flex-col h-full items-center justify-center gap-2 text-[var(--text-muted)]">
            <span className="text-[28px] opacity-50">🔒</span>
            <span className="text-[12px]">Login to Nubra to use paper trading.</span>
          </div>
        ) : (
          <>
            {tab === 'orders'    && <OrdersTab    uatAuth={uatAuth} onOpenStrategyChart={onOpenStrategyChart} />}
            {tab === 'positions' && <PositionsTab uatAuth={uatAuth} onViewChart={handleViewChart} onExit={handleExit} onOpenStrategyChart={onOpenStrategyChart} />}
            {tab === 'holdings'  && <HoldingsTab  uatAuth={uatAuth} />}
            {tab === 'saved'     && <SavedStrategiesTab onOpen={(bg, name, id) => onOpenStrategyChart?.(bg, name, id)} />}
          </>
        )}
      </div>
    </div>
  );
}
