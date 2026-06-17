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
  const [ltp,        setLtp]        = useState<number | undefined>();
  const [ltpChg,     setLtpChg]     = useState<number | undefined>();
  const [pos,        setPos]        = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const marginTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef     = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (ticketOpen) {
      setInstrument(ticketConfig.instrument);
      setSide(ticketConfig.side);
      setLtp(ticketConfig.ltp);
      setLtpChg(ticketConfig.ltpChg);
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
      setPos({ x: 0, y: 0 });
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
        const d = await res.json() as { total_margin?: number; message?: string; error?: string };
        if (d.error) throw new Error(d.error);
        setMargin(d.total_margin != null ? d.total_margin / 100 : null);
      } catch (e) {
        setMarginErr((e as Error).message);
        setMargin(null);
      }
    }, 400);
  }, [instrument, lots, side, orderType, price, product]);

  useEffect(() => { if (ticketOpen) fetchMargin(); }, [ticketOpen, fetchMargin]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragRef.current) return;
      setPos({ x: dragRef.current.origX + e.clientX - dragRef.current.startX, y: dragRef.current.origY + e.clientY - dragRef.current.startY });
    }
    function onUp() { dragRef.current = null; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  function onHeaderMouseDown(e: React.MouseEvent) {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  }

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
      const lbl = instrumentLabel(instrument);
      const res = await fetch('/paper/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nubraName,
          liveRefId:           instrument.ref_id,
          display_name:        lbl || nubraName,
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
  const needsPrice = orderType === 'LIMIT' || orderType === 'SL';
  const label      = instrumentLabel(instrument);

  const ltpRs  = ltp != null ? ltp / 100 : null;
  const chgRs  = ltpChg != null ? ltpChg / 100 : null;
  const chgPct = ltpRs && chgRs && (ltpRs - chgRs) !== 0 ? ((chgRs / (ltpRs - chgRs)) * 100) : null;
  const chgUp  = chgRs != null ? chgRs >= 0 : true;

  const pill = (active: boolean) =>
    active
      ? 'bg-[#2f3347] text-white border-[#444a66]'
      : 'bg-transparent text-[#888] border-[#2a2d3e] hover:text-[#ccc]';

  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) closeTicket(); }}
    >
      <div className="absolute inset-0 bg-black/60" />

      <div className="relative overflow-hidden flex flex-col max-h-[90vh]" style={{ width: 420, background: '#1c1f2e', borderRadius: 12, boxShadow: '0 25px 60px rgba(0,0,0,.5)', transform: `translate(${pos.x}px, ${pos.y}px)` }}>

        {/* ── Header ── */}
        <div className="flex items-center gap-2 px-4 py-3" onMouseDown={onHeaderMouseDown} style={{ borderBottom: '1px solid #2a2d3e', cursor: 'grab', userSelect: 'none' }}>
          <button onClick={() => setSide('BUY')}
            style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: isBuy ? '#2563eb' : '#252836', color: isBuy ? '#fff' : '#60a5fa', cursor: 'pointer', border: 'none' }}
          >B</button>
          <button onClick={() => setSide('SELL')}
            style={{ fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: !isBuy ? '#dc2626' : '#252836', color: !isBuy ? '#fff' : '#f87171', cursor: 'pointer', border: 'none' }}
          >S</button>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label || 'New Paper Order'}
          </span>
          <button onClick={closeTicket}
            style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, color: '#888', fontSize: 18, cursor: 'pointer', background: 'none', border: 'none' }}
          >×</button>
        </div>

        {/* ── LTP sub-header ── */}
        {instrument && ltpRs != null && (
          <div className="flex items-center gap-1.5 px-4 py-2" style={{ borderBottom: '1px solid #2a2d3e' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{ltpRs.toFixed(2)}</span>
            {chgRs != null && (
              <span style={{ fontSize: 12, color: chgUp ? '#4ade80' : '#f87171' }}>
                • {chgUp ? '+' : ''}{chgRs.toFixed(2)} {chgPct != null && `(${chgPct.toFixed(2)}%)`}
              </span>
            )}
            <span style={{ fontSize: 11, color: '#666', marginLeft: 4 }}>• {instrument.exchange ?? 'NSE'}</span>
          </div>
        )}

        <div className="overflow-y-auto">
          {!instrument && (
            <div className="px-4 pt-4 pb-2">
              <InstrumentSearch placeholder="Search symbol…" onSelect={setInstrument} />
            </div>
          )}

          {instrument && (
            <>
              {/* ── Delivery / Intraday pill buttons ── */}
              <div className="flex gap-2 px-4 py-3" style={{ borderBottom: '1px solid #2a2d3e' }}>
                {(['NRML', 'MIS'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setProduct(p)}
                    className={`px-5 py-1.5 rounded-md text-[13px] font-semibold border transition-colors ${pill(product === p)}`}
                  >
                    {p === 'NRML' ? 'Delivery' : 'Intraday'}
                  </button>
                ))}
              </div>

              {/* ── Qty + Price ── */}
              <div className="px-4 pt-4 pb-3">
                <div className="flex gap-3 mb-3">
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1.5">
                      <span style={{ fontSize: 11, color: '#888' }}>Qty</span>
                      <span style={{ fontSize: 11, color: '#888' }}>Lots: {lots}</span>
                    </div>
                    <div className="flex items-center h-9 rounded overflow-hidden" style={{ border: '1px solid #2a2d3e' }}>
                      <button onClick={() => setLots(l => Math.max(1, l - 1))}
                        style={{ width: 36, height: '100%', fontSize: 18, color: '#888', background: 'none', border: 'none', borderRight: '1px solid #2a2d3e', cursor: 'pointer' }}
                      >−</button>
                      <span style={{ flex: 1, textAlign: 'center', fontSize: 13, color: '#fff', fontWeight: 500 }}>{orderQty}</span>
                      <button onClick={() => setLots(l => l + 1)}
                        style={{ width: 36, height: '100%', fontSize: 18, color: '#888', background: 'none', border: 'none', borderLeft: '1px solid #2a2d3e', cursor: 'pointer' }}
                      >+</button>
                    </div>
                  </div>

                  <div className="flex-1">
                    <div className="mb-1.5"><span style={{ fontSize: 11, color: '#888' }}>Price</span></div>
                    <div className="flex gap-1 h-9">
                      {(['MKT', 'LIMIT', 'SL'] as const).map((t) => (
                        <button key={t} onClick={() => setOrderType(t)}
                          style={{
                            flex: 1, borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                            background: orderType === t ? 'rgba(59,130,246,.15)' : '#252836',
                            color: orderType === t ? '#60a5fa' : '#888',
                            border: `1px solid ${orderType === t ? 'rgba(59,130,246,.4)' : '#2a2d3e'}`,
                          }}
                        >{t}</button>
                      ))}
                    </div>
                  </div>
                </div>

                {needsPrice && (
                  <input type="number" min="0" step="0.05" value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="Enter price"
                    style={{ width: '100%', padding: '8px 12px', marginBottom: 12, background: '#252836', border: '1px solid #2a2d3e', borderRadius: 4, color: '#fff', fontSize: 13, outline: 'none' }}
                  />
                )}

                {/* At Market display */}
                <div style={{ width: '100%', padding: '10px 0', borderRadius: 6, background: '#252836', border: '1px solid #2a2d3e', textAlign: 'center', fontSize: 13, color: '#fff', fontWeight: 500, marginBottom: 4 }}>
                  At Market
                </div>
                {orderType === 'MKT' && (
                  <p style={{ fontSize: 10, color: '#666', textAlign: 'center' }}>Tick size: 0.05</p>
                )}
              </div>

              {/* ── SL / Target toggles ── */}
              <div className="px-4 pb-3 flex gap-6 pt-3" style={{ borderTop: '1px dashed #2a2d3e' }}>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="slTgt" checked={showSl && !showTgt} onChange={() => { setShowSl(true); setShowTgt(false); }} className="accent-blue-500" />
                  <span style={{ fontSize: 12, color: '#ccc' }}>Stoploss Price</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="slTgt" checked={showTgt && !showSl} onChange={() => { setShowTgt(true); setShowSl(false); }} className="accent-blue-500" />
                  <span style={{ fontSize: 12, color: '#ccc' }}>Target Price</span>
                </label>
              </div>

              {(showSl || showTgt) && (
                <div className="px-4 pb-3">
                  <input type="number" min="0" step="0.05" value={triggerPx}
                    onChange={(e) => setTriggerPx(e.target.value)}
                    placeholder={showSl ? 'Stoploss price' : 'Target price'}
                    style={{ width: '100%', padding: '8px 12px', background: '#252836', border: '1px solid #2a2d3e', borderRadius: 4, color: '#fff', fontSize: 13, outline: 'none' }}
                  />
                </div>
              )}

              {/* ── Advanced ── */}
              <div style={{ borderTop: '1px dashed #2a2d3e' }}>
                <button onClick={() => setShowAdv(v => !v)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}
                >
                  <span style={{ fontWeight: 600 }}>Advanced</span>
                  <span style={{ fontSize: 11 }}>{showAdv ? '∧' : '∨'}</span>
                </button>
                {showAdv && (
                  <div className="px-4 pb-4 flex flex-col gap-3">
                    <div className="flex gap-2">
                      {['SL-Trigger', 'Iceberg', 'Flexi'].map((opt) => (
                        <button key={opt}
                          style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: '1px solid #2a2d3e', fontSize: 11, color: '#888', background: 'none', cursor: 'pointer' }}
                        >{opt}</button>
                      ))}
                    </div>
                    <div className="flex gap-5">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="validity" checked={validity === 'DAY'} onChange={() => setValidity('DAY')} className="accent-blue-500" />
                        <span style={{ fontSize: 12, color: '#ccc' }}>Regular</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="validity" checked={validity === 'AMO'} onChange={() => setValidity('AMO')} className="accent-blue-500" />
                        <span style={{ fontSize: 12, color: '#ccc' }}>AMO</span>
                      </label>
                    </div>
                    {validity === 'AMO' && (
                      <p style={{ fontSize: 11, color: '#666', lineHeight: 1.5 }}>
                        Your order will be placed in the next trading session (AMO validity)
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Margin ── */}
              <div className="px-4 py-3" style={{ borderTop: '1px solid #2a2d3e' }}>
                {result ? (
                  <div style={{ fontSize: 12, padding: '8px 12px', borderRadius: 6, background: result.ok ? 'rgba(34,197,94,.1)' : 'rgba(239,68,68,.1)', color: result.ok ? '#4ade80' : '#f87171' }}>
                    {result.msg}
                  </div>
                ) : marginErr ? (
                  <div style={{ fontSize: 11, padding: '8px 12px', borderRadius: 6, background: 'rgba(239,68,68,.1)', color: '#f87171' }}>
                    {marginErr.slice(0, 120)}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#888' }}>Margin required</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>
                        {margin != null ? `₹${fmtPrice(margin)}` : '—'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#888' }}>Margin available</span>
                      <span style={{ fontSize: 11, color: '#4ade80' }}>Unlimited (Paper)</span>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Execute button (prominent) ── */}
              <div className="px-4 pb-3">
                <button
                  onClick={placeOrder}
                  disabled={placing}
                  style={{
                    width: '100%',
                    padding: '14px 0',
                    borderRadius: 8,
                    border: 'none',
                    fontSize: 15,
                    fontWeight: 700,
                    color: '#fff',
                    cursor: placing ? 'wait' : 'pointer',
                    opacity: placing ? 0.5 : 1,
                    background: isBuy ? '#16a34a' : '#dc2626',
                  }}
                >
                  {placing ? 'Placing…' : isBuy ? 'BUY' : 'SELL'}
                </button>
              </div>

              {/* ── Cancel ── */}
              <div className="px-4 pb-4">
                <button onClick={closeTicket}
                  style={{ width: '100%', padding: '8px 0', borderRadius: 6, border: '1px solid #2a2d3e', fontSize: 12, color: '#888', background: 'none', cursor: 'pointer' }}
                >Cancel</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
