import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument } from '../types';
import { fmtPrice } from '../lib/utils';
import { getSymbol } from '../types';
import { usePaperTrading } from '../hooks/usePaperTrading';
import InstrumentSearch from './InstrumentSearch';

type Side         = 'BUY' | 'SELL';
type ProductUI    = 'NRML' | 'MIS' | 'CNC';
type OrderTypeUI  = 'MKT' | 'LIMIT' | 'SL' | 'SL-M';

function productToApi(p: ProductUI): string {
  return p === 'MIS' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC';
}

function orderTypeToApi(t: OrderTypeUI): string {
  if (t === 'MKT')  return 'ORDER_TYPE_MARKET';
  if (t === 'LIMIT') return 'ORDER_TYPE_REGULAR';
  return 'ORDER_TYPE_STOPLOSS';
}

function instrumentLabel(inst: Instrument | null): string {
  if (!inst) return '';
  const name  = inst.stock_name || inst.asset || inst.symbol || '';
  const ot    = inst.option_type ? ` ${inst.option_type}` : '';
  const sp    = inst.strike_price ? ` ${(inst.strike_price > 10000 ? inst.strike_price / 100 : inst.strike_price).toLocaleString('en-IN')}` : '';
  return `${name}${sp}${ot}`.trim() || getSymbol(inst);
}

export default function OrderTicket() {
  const { ticketOpen, ticketConfig, closeTicket } = usePaperTrading();

  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [side,       setSide]       = useState<Side>('BUY');
  const [product,    setProduct]    = useState<ProductUI>('NRML');
  const [orderType,  setOrderType]  = useState<OrderTypeUI>('MKT');
  const [qty,        setQty]        = useState('1');
  const [price,      setPrice]      = useState('');
  const [trigger,    setTrigger]    = useState('');
  const [margin,     setMargin]     = useState<number | null>(null);
  const [marginErr,  setMarginErr]  = useState('');
  const [placing,    setPlacing]    = useState(false);
  const [result,     setResult]     = useState<{ ok: boolean; msg: string } | null>(null);
  const marginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync config when ticket opens
  useEffect(() => {
    if (ticketOpen) {
      setInstrument(ticketConfig.instrument);
      setSide(ticketConfig.side);
      setResult(null);
      setMargin(null);
      setMarginErr('');
    }
  }, [ticketOpen, ticketConfig]);

  // Fetch margin (debounced)
  const fetchMargin = useCallback(() => {
    if (marginTimer.current) clearTimeout(marginTimer.current);
    marginTimer.current = setTimeout(async () => {
      if (!instrument?.ref_id) { setMargin(null); return; }
      const q = Number(qty);
      if (!q || q <= 0) { setMargin(null); return; }
      try {
        setMarginErr('');
        const p = orderType !== 'MKT' && price ? Math.round(Number(price) * 100) : undefined;
        const res = await fetch('/paper/margin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            liveRefId:          instrument.ref_id,
            order_qty:          q,
            order_side:         side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
            order_type:         orderTypeToApi(orderType),
            order_price:        p,
            order_delivery_type: productToApi(product),
          }),
        });
        const d = await res.json() as { margin_required?: number; total_margin?: number; error?: string };
        if (d.error) throw new Error(d.error);
        const m = d.margin_required ?? d.total_margin;
        setMargin(m != null ? m / 100 : null);
      } catch (e) {
        setMarginErr((e as Error).message);
        setMargin(null);
      }
    }, 400);
  }, [instrument, qty, side, orderType, price, product]);

  useEffect(() => { if (ticketOpen) fetchMargin(); }, [ticketOpen, fetchMargin]);

  async function placeOrder() {
    if (!instrument) { setResult({ ok: false, msg: 'Select an instrument first.' }); return; }
    const nubraName = instrument.zanskar_name || instrument.nubra_name;
    if (!nubraName) { setResult({ ok: false, msg: 'Instrument has no canonical name. Re-search and select.' }); return; }
    const q = Number(qty);
    if (!q || q <= 0) { setResult({ ok: false, msg: 'Enter a valid quantity.' }); return; }

    const apiPrice   = orderType !== 'MKT' && price   ? Math.round(Number(price) * 100)   : undefined;
    const apiTrigger = (orderType === 'SL' || orderType === 'SL-M') && trigger ? Math.round(Number(trigger) * 100) : undefined;

    if ((orderType === 'SL' || orderType === 'SL-M') && !apiTrigger) {
      setResult({ ok: false, msg: 'Enter a trigger price for SL orders.' }); return;
    }
    if (orderType === 'LIMIT' && !apiPrice) {
      setResult({ ok: false, msg: 'Enter a limit price.' }); return;
    }

    setPlacing(true);
    setResult(null);
    try {
      const res = await fetch('/paper/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nubraName,
          liveRefId:           instrument.ref_id,
          order_type:          orderTypeToApi(orderType),
          order_qty:           q,
          order_side:          side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: productToApi(product),
          validity_type:       'DAY',
          order_price:         apiPrice,
          trigger_price:       apiTrigger,
        }),
      });
      const d = await res.json() as { order_id?: number; error?: string };
      if (!res.ok || d.error) throw new Error(d.error || 'Order failed');
      setResult({ ok: true, msg: `Order placed! ID: ${d.order_id}` });
      setTimeout(closeTicket, 1800);
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setPlacing(false);
    }
  }

  if (!ticketOpen) return null;

  const needsPrice   = orderType === 'LIMIT' || orderType === 'SL';
  const needsTrigger = orderType === 'SL' || orderType === 'SL-M';
  const label        = instrumentLabel(instrument);
  const lotSize      = instrument?.lot_size ?? 1;
  const qtyNum       = Number(qty) || 0;

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) closeTicket(); }}
    >
      {/* backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* card */}
      <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl w-[380px] overflow-hidden">
        {/* title bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-secondary)]">
          <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate max-w-[260px]">
            {label || 'New Paper Order'}
          </span>
          <button
            onClick={closeTicket}
            className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-lg"
          >×</button>
        </div>

        <div className="p-4 flex flex-col gap-3">
          {/* instrument search (if none pre-filled) */}
          {!instrument && (
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Instrument</label>
              <InstrumentSearch placeholder="Search symbol…" onSelect={setInstrument} />
            </div>
          )}

          {/* if instrument is set, show a clear button */}
          {instrument && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-[var(--bg-secondary)] rounded border border-[var(--border)]">
              <span className="text-[12px] text-[var(--text-primary)] flex-1 truncate">{label}</span>
              <button
                onClick={() => { setInstrument(null); setMargin(null); }}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-[13px]"
              >×</button>
            </div>
          )}

          {/* BUY / SELL */}
          <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
            {(['BUY', 'SELL'] as const).map((s) => (
              <button
                key={s}
                onClick={() => { setSide(s); fetchMargin(); }}
                className={`flex-1 py-2 text-[13px] font-bold transition-colors ${
                  side === s
                    ? s === 'BUY' ? 'bg-green-500 text-white' : 'bg-red-500 text-white'
                    : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/* Product */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Product</label>
            <div className="flex gap-1">
              {(['NRML', 'MIS', 'CNC'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => { setProduct(p); fetchMargin(); }}
                  className={`flex-1 py-1 rounded text-[12px] font-semibold transition-colors ${
                    product === p ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border)]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Order type */}
          <div>
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Order Type</label>
            <div className="flex gap-1">
              {(['MKT', 'LIMIT', 'SL', 'SL-M'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => { setOrderType(t); fetchMargin(); }}
                  className={`flex-1 py-1 rounded text-[12px] font-semibold transition-colors ${
                    orderType === t ? 'bg-[var(--accent)]/20 text-[var(--accent)] border border-[var(--accent)]/40' : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-[var(--border)]'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Qty + Lots */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Qty</label>
              <input
                type="number" min="1" value={qty}
                onChange={(e) => { setQty(e.target.value); fetchMargin(); }}
                className="w-full px-2.5 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
              />
              {lotSize > 1 && qtyNum > 0 && (
                <span className="text-[10px] text-[var(--text-muted)] mt-0.5 block">{qtyNum / lotSize} lot{qtyNum / lotSize !== 1 ? 's' : ''} × {lotSize}</span>
              )}
            </div>

            {needsPrice && (
              <div className="flex-1">
                <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Price (₹)</label>
                <input
                  type="number" min="0" step="0.05" value={price}
                  onChange={(e) => { setPrice(e.target.value); fetchMargin(); }}
                  placeholder="0.00"
                  className="w-full px-2.5 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            )}
          </div>

          {/* Trigger price */}
          {needsTrigger && (
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Trigger Price (₹)</label>
              <input
                type="number" min="0" step="0.05" value={trigger}
                onChange={(e) => setTrigger(e.target.value)}
                placeholder="0.00"
                className="w-full px-2.5 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
          )}

          {/* Margin */}
          <div className="flex items-center justify-between text-[11px] px-1">
            <span className="text-[var(--text-muted)]">Margin Required</span>
            <span className="font-semibold text-[var(--text-primary)]">
              {marginErr
                ? <span className="text-red-400 text-[10px]">{marginErr.slice(0, 40)}</span>
                : margin != null
                  ? `₹${fmtPrice(margin)}`
                  : <span className="text-[var(--text-muted)]">—</span>
              }
            </span>
          </div>

          {/* Result */}
          {result && (
            <div className={`text-[12px] px-3 py-2 rounded ${result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
              {result.msg}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={placeOrder}
              disabled={placing}
              className={`flex-1 py-2.5 rounded-lg font-bold text-[13px] text-white transition-colors disabled:opacity-50 ${
                side === 'BUY' ? 'bg-green-500 hover:bg-green-600' : 'bg-red-500 hover:bg-red-600'
              }`}
            >
              {placing ? 'Placing…' : `Place ${side} Order`}
            </button>
            <button
              onClick={closeTicket}
              className="px-4 py-2.5 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)] text-[13px] font-semibold hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
