import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument } from '../types';
import { fmtPrice, formatExpiry } from '../lib/utils';
import { getSymbol } from '../types';
import { usePaperTrading } from '../hooks/usePaperTrading';
import InstrumentSearch from './InstrumentSearch';

type Side        = 'BUY' | 'SELL';
type ProductUI   = 'NRML' | 'MIS';
type OrderTypeUI = 'MKT' | 'LIMIT' | 'SL';
type Validity    = 'DAY' | 'AMO';

function productToApi(p: ProductUI): string {
  return p === 'MIS' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC';
}

function orderTypeToApi(t: OrderTypeUI): string {
  if (t === 'MKT')   return 'ORDER_TYPE_MARKET';
  if (t === 'LIMIT') return 'ORDER_TYPE_REGULAR';
  return 'ORDER_TYPE_STOPLOSS';
}

function instrumentLabel(inst: Instrument | null): string {
  if (!inst) return '';
  const name = inst.stock_name || inst.asset || '';
  const exp  = inst.expiry ? ` ${formatExpiry(inst.expiry).toUpperCase()}` : '';
  const sp   = inst.strike_price
    ? ` ${(inst.strike_price > 10000 ? inst.strike_price / 100 : inst.strike_price).toLocaleString('en-IN')}`
    : '';
  const ot   = inst.option_type ? ` ${inst.option_type}` : '';
  return (`${name}${exp}${sp}${ot}`).trim() || getSymbol(inst);
}

export default function OrderTicket() {
  const { ticketOpen, ticketConfig, closeTicket } = usePaperTrading();

  const [instrument, setInstrument] = useState<Instrument | null>(null);
  const [side,       setSide]       = useState<Side>('BUY');
  const [product,    setProduct]    = useState<ProductUI>('NRML');
  const [orderType,  setOrderType]  = useState<OrderTypeUI>('MKT');
  const [lots,       setLots]       = useState(1);
  const [price,      setPrice]      = useState('');
  const [triggerPx,  setTriggerPx]  = useState('');
  const [showSl,     setShowSl]     = useState(false);
  const [showTgt,    setShowTgt]    = useState(false);
  const [showAdv,    setShowAdv]    = useState(false);
  const [validity,   setValidity]   = useState<Validity>('DAY');
  const [margin,     setMargin]     = useState<number | null>(null);
  const [marginErr,  setMarginErr]  = useState('');
  const [placing,    setPlacing]    = useState(false);
  const [result,     setResult]     = useState<{ ok: boolean; msg: string } | null>(null);
  const marginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (ticketOpen) {
      setInstrument(ticketConfig.instrument);
      setSide(ticketConfig.side);
      setLots(1);
      setPrice('');
      setTriggerPx('');
      setShowSl(false);
      setShowTgt(false);
      setShowAdv(false);
      setValidity('DAY');
      setResult(null);
      setMargin(null);
      setMarginErr('');
    }
  }, [ticketOpen, ticketConfig]);

  const lotSize  = instrument?.lot_size ?? 1;
  const orderQty = lots * lotSize;

  const fetchMargin = useCallback(() => {
    if (marginTimer.current) clearTimeout(marginTimer.current);
    marginTimer.current = setTimeout(async () => {
      if (!instrument?.ref_id) { setMargin(null); return; }
      const q = lots * (instrument.lot_size ?? 1);
      if (!q || q <= 0) { setMargin(null); return; }
      try {
        setMarginErr('');
        const p = orderType !== 'MKT' && price ? Math.round(Number(price) * 100) : undefined;
        const res = await fetch('/paper/margin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            liveRefId:           instrument.ref_id,
            order_qty:           q,
            order_side:          side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
            order_type:          orderTypeToApi(orderType),
            order_price:         p,
            order_delivery_type: productToApi(product),
            exchange:            instrument.exchange ?? 'NSE',
          }),
        });
        const d = await res.json() as { total_margin?: number; error?: string };
        if (d.error) throw new Error(d.error);
        setMargin(d.total_margin != null ? d.total_margin / 100 : null);
      } catch (e) {
        setMarginErr((e as Error).message);
        setMargin(null);
      }
    }, 400);
  }, [instrument, lots, side, orderType, price, product]);

  useEffect(() => { if (ticketOpen) fetchMargin(); }, [ticketOpen, fetchMargin]);

  async function placeOrder() {
    if (!instrument) { setResult({ ok: false, msg: 'Select an instrument first.' }); return; }
    const nubraName = instrument.zanskar_name || instrument.nubra_name;
    if (!nubraName) { setResult({ ok: false, msg: 'Instrument has no canonical name. Re-search and select.' }); return; }
    if (lots < 1) { setResult({ ok: false, msg: 'Enter a valid quantity.' }); return; }

    const apiPrice   = orderType !== 'MKT' && price     ? Math.round(Number(price) * 100)     : undefined;
    const apiTrigger = orderType === 'SL'  && triggerPx ? Math.round(Number(triggerPx) * 100) : undefined;
    if (orderType === 'SL' && !apiTrigger)  { setResult({ ok: false, msg: 'Enter a trigger price.' }); return; }
    if (orderType === 'LIMIT' && !apiPrice) { setResult({ ok: false, msg: 'Enter a limit price.' }); return; }

    setPlacing(true);
    setResult(null);
    try {
      const label = instrumentLabel(instrument);
      const res = await fetch('/paper/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nubraName,
          liveRefId:           instrument.ref_id,
          display_name:        label || nubraName,
          order_type:          orderTypeToApi(orderType),
          order_qty:           orderQty,
          order_side:          side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: productToApi(product),
          validity_type:       validity,
          order_price:         apiPrice,
          trigger_price:       apiTrigger,
          asset:               instrument.asset,
          expiry:              instrument.expiry,
          derivative_type:     instrument.derivative_type,
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

  const isBuy      = side === 'BUY';
  const accentCls  = isBuy ? 'text-green-400' : 'text-red-400';
  const accentBg   = isBuy ? 'bg-green-500'   : 'bg-red-500';
  const needsPrice = orderType === 'LIMIT' || orderType === 'SL';
  const label      = instrumentLabel(instrument);

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) closeTicket(); }}
    >
      <div className="absolute inset-0 bg-black/60" />

      <div className="relative bg-[var(--bg-card)] rounded-xl shadow-2xl w-[420px] overflow-hidden flex flex-col max-h-[90vh]">

        {/* ── Header (B/S toggle + instrument name) ── */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <button
            onClick={() => setSide('BUY')}
            className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
              isBuy ? 'bg-green-500 text-white' : 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
            }`}
          >B</button>
          <button
            onClick={() => setSide('SELL')}
            className={`text-[10px] font-bold px-2 py-1 rounded transition-colors ${
              !isBuy ? 'bg-red-500 text-white' : 'bg-red-500/10 text-red-600 hover:bg-red-500/20'
            }`}
          >S</button>
          <span className="flex-1 text-[13px] font-semibold text-[var(--text-primary)] truncate">
            {label || 'New Paper Order'}
          </span>
          <button
            onClick={closeTicket}
            className="w-6 h-6 flex items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] text-lg leading-none"
          >×</button>
        </div>

        <div className="overflow-y-auto">
          {/* if no instrument pre-filled, show search */}
          {!instrument && (
            <div className="px-4 pt-4 pb-2">
              <InstrumentSearch placeholder="Search symbol…" onSelect={setInstrument} />
            </div>
          )}

          {instrument && (
            <>
              {/* ── Delivery / Intraday tabs ── */}
              <div className="flex border-b border-[var(--border)]">
                {(['NRML', 'MIS'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProduct(p)}
                    className={`flex-1 py-2.5 text-[13px] font-semibold transition-colors relative ${
                      product === p ? accentCls : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {p === 'NRML' ? 'Delivery' : 'Intraday'}
                    {product === p && (
                      <span className={`absolute bottom-0 left-0 right-0 h-0.5 ${accentBg}`} />
                    )}
                  </button>
                ))}
              </div>

              {/* ── Qty + Price type ── */}
              <div className="px-4 pt-4 pb-3">
                <div className="flex gap-3 mb-3">
                  {/* Qty stepper */}
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] text-[var(--text-muted)]">Qty</span>
                      <span className="text-[11px] text-[var(--text-muted)]">Lots: {lots}</span>
                    </div>
                    <div className="flex items-center border border-[var(--border)] rounded overflow-hidden h-9">
                      <button
                        onClick={() => setLots(l => Math.max(1, l - 1))}
                        className="w-9 flex-shrink-0 flex items-center justify-center text-[18px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border-r border-[var(--border)] h-full leading-none select-none"
                      >−</button>
                      <span className="flex-1 text-center text-[13px] text-[var(--text-primary)] select-none">{orderQty}</span>
                      <button
                        onClick={() => setLots(l => l + 1)}
                        className="w-9 flex-shrink-0 flex items-center justify-center text-[18px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border-l border-[var(--border)] h-full leading-none select-none"
                      >+</button>
                    </div>
                  </div>

                  {/* Price type */}
                  <div className="flex-1">
                    <div className="mb-1.5">
                      <span className="text-[11px] text-[var(--text-muted)]">Price</span>
                    </div>
                    <div className="flex gap-1 h-9">
                      {(['MKT', 'LIMIT', 'SL'] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => setOrderType(t)}
                          className={`flex-1 rounded text-[11px] font-semibold transition-colors border ${
                            orderType === t
                              ? isBuy
                                ? 'bg-green-500/15 text-green-400 border-green-500/30'
                                : 'bg-red-500/15 text-red-400 border-red-500/30'
                              : 'bg-[var(--bg-secondary)] text-[var(--text-muted)] border-[var(--border)] hover:text-[var(--text-primary)]'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Limit / SL price input */}
                {needsPrice && (
                  <input
                    type="number" min="0" step="0.05" value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="Enter price"
                    className="w-full px-3 py-2 mb-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
                  />
                )}

                {/* At Market / Place button */}
                <button
                  onClick={placeOrder}
                  disabled={placing}
                  className={`w-full py-2.5 rounded font-semibold text-[13px] text-white transition-colors disabled:opacity-50 mb-1 ${
                    isBuy ? 'bg-green-600 hover:bg-green-500' : 'bg-red-600 hover:bg-red-500'
                  }`}
                >
                  {placing ? 'Placing…' : orderType === 'MKT' ? 'At Market' : `Place ${side} Order`}
                </button>
                {orderType === 'MKT' && (
                  <p className="text-[10px] text-[var(--text-muted)] text-center">Tick size: 0.05</p>
                )}
              </div>

              {/* ── SL / Target toggles ── */}
              <div className="px-4 pb-3 flex gap-6 border-t border-[var(--border)] pt-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio" name="slTgt"
                    checked={showSl && !showTgt}
                    onChange={() => { setShowSl(true); setShowTgt(false); }}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-secondary)]">Stoploss Price</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio" name="slTgt"
                    checked={showTgt && !showSl}
                    onChange={() => { setShowTgt(true); setShowSl(false); }}
                    className="accent-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-secondary)]">Target Price</span>
                </label>
              </div>

              {(showSl || showTgt) && (
                <div className="px-4 pb-3">
                  <input
                    type="number" min="0" step="0.05" value={triggerPx}
                    onChange={(e) => setTriggerPx(e.target.value)}
                    placeholder={showSl ? 'Stoploss price' : 'Target price'}
                    className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              )}

              {/* ── Advanced (collapsible) ── */}
              <div className="border-t border-[var(--border)]">
                <button
                  onClick={() => setShowAdv(v => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <span className="font-semibold">Advanced</span>
                  <span className="text-[11px]">{showAdv ? '∧' : '∨'}</span>
                </button>

                {showAdv && (
                  <div className="px-4 pb-4 flex flex-col gap-3">
                    <div className="flex gap-2">
                      {['SL-Trigger', 'Iceberg', 'Flexi'].map((opt) => (
                        <button
                          key={opt}
                          className="flex-1 py-1.5 rounded border border-[var(--border)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors"
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                    <div className="flex gap-5">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="validity" checked={validity === 'DAY'} onChange={() => setValidity('DAY')} className="accent-[var(--accent)]" />
                        <span className="text-[12px] text-[var(--text-secondary)]">Regular</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="validity" checked={validity === 'AMO'} onChange={() => setValidity('AMO')} className="accent-[var(--accent)]" />
                        <span className="text-[12px] text-[var(--text-secondary)]">AMO</span>
                      </label>
                    </div>
                    {validity === 'AMO' && (
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                        Your order will be placed in the next trading session (AMO validity)
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Result / Margin ── */}
              <div className="border-t border-[var(--border)] px-4 py-3">
                {result ? (
                  <div className={`text-[12px] px-3 py-2 rounded ${result.ok ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}>
                    {result.msg}
                  </div>
                ) : marginErr ? (
                  <div className="bg-red-500/10 border border-red-500/20 rounded px-3 py-2.5">
                    <p className="text-[11px] text-red-400">{marginErr.slice(0, 120)}</p>
                  </div>
                ) : margin != null ? (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[12px] font-semibold text-[var(--text-primary)]">
                        Margin required: ₹{fmtPrice(margin)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[var(--text-muted)]">Margin Required</span>
                    <span className="text-[11px] text-[var(--text-muted)]">—</span>
                  </div>
                )}
              </div>

              {/* ── Cancel ── */}
              <div className="px-4 pb-4">
                <button
                  onClick={closeTicket}
                  className="w-full py-2 rounded text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] border border-[var(--border)] transition-colors"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
