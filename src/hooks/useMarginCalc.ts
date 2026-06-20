import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtPrice } from '../lib/utils';

export interface MarginData {
  span?: number;
  exposure?: number;
  total: number;
  premium?: number;
  benefit?: number;
}

interface Leg {
  refId: number | null;
  strike: number;
  lots: number;
  lotSize: number;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  deliveryType: 'IDAY' | 'CNC';
}

export interface MarginCalcApi {
  margin: MarginData | null;
}

export function useMarginCalc(legs: Leg[], exch: string, multiplier: number): MarginCalcApi {
  const [margin, setMargin] = useState<MarginData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchMargin = useCallback(async () => {
    if (!legs.length) { setMargin(null); return; }
    const validLegs = legs.filter(l => l.refId && l.strike > 0 && l.lots > 0 && l.lotSize > 0 && (l.optionType === 'CE' || l.optionType === 'PE'));
    if (!validLegs.length) { setMargin(null); return; }
    try {
      const res = await fetch('/paper/margin/basket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: exch, multiplier, orders: validLegs.map(l => ({
          ref_id: l.refId, order_qty: l.lots * l.lotSize,
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
        })) }) });
      if (!res.ok) { setMargin(null); return; }
      const data = await res.json() as Record<string, unknown>;
      const total = Number(data.total_margin ?? 0) / 100;
      const span = Number(data.span ?? 0) / 100;
      const exposure = Number(data.exposure ?? 0) / 100;
      const premium = Number(data.opt_prem ?? 0) / 100;
      const individualSum = span + exposure + premium;
      const benefit = individualSum > total && total > 0 ? individualSum - total : 0;
      setMargin({ total, benefit: benefit > 0 ? benefit : undefined, span: span > 0 ? span : undefined,
        exposure: exposure > 0 ? exposure : undefined, premium: premium > 0 ? premium : undefined });
    } catch { setMargin(null); }
  }, [legs, exch, multiplier]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetchMargin, 400);
    return () => clearTimeout(timerRef.current);
  }, [fetchMargin]);

  return { margin };
}
