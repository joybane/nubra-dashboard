import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtPrice } from '../lib/utils';

export interface MarginData {
  span?: number;
  exposure?: number;
  total: number;
  premium?: number;
  benefit?: number;
  estimated?: boolean;
  message?: string;
}

interface Leg {
  refId: number | null;
  strike: number;
  lots: number;
  lotSize: number;
  ltp?: number;
  expiry?: string;
  symbol?: string;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  deliveryType: 'IDAY' | 'CNC';
}

export interface MarginCalcApi {
  margin: MarginData | null;
  loading: boolean;
  error: string;
}

export function useMarginCalc(legs: Leg[], exch: string, multiplier: number, onLegsResolved?: (resolved: any[]) => void): MarginCalcApi {
  const [margin, setMargin] = useState<MarginData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchMargin = useCallback(async () => {
    if (!legs.length) { setMargin(null); setLoading(false); setError(''); return; }
    const validLegs = legs.filter(l => l.strike > 0 && l.lots > 0 && l.lotSize > 0 && (l.optionType === 'CE' || l.optionType === 'PE'));
    if (!validLegs.length) { setMargin(null); setLoading(false); setError(''); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/paper/margin/basket', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exchange: exch, multiplier, orders: validLegs.map(l => ({
          ref_id: l.refId, order_qty: l.lots * l.lotSize,
          strike: l.strike, option_type: l.optionType, ltp: l.ltp, lot_size: l.lotSize, expiry: l.expiry, symbol: l.symbol,
          order_side: l.side === 'BUY' ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
          order_delivery_type: l.deliveryType === 'IDAY' ? 'ORDER_DELIVERY_TYPE_IDAY' : 'ORDER_DELIVERY_TYPE_CNC',
        })) }) });
      const data = await res.json() as Record<string, unknown>;
      if (!res.ok || data.error) {
        setMargin(null);
        setError(String(data.error || data.message || `HTTP ${res.status}`));
        return;
      }
      if (Array.isArray(data.resolved_legs) && onLegsResolved) {
        onLegsResolved(data.resolved_legs);
      }
      const total = Number(data.total_margin ?? 0) / 100;
      if (!(total > 0)) {
        setMargin(null);
        setError('Margin API returned no total_margin.');
        return;
      }
      const span = Number(data.span ?? 0) / 100;
      const exposure = Number(data.exposure ?? 0) / 100;
      const premium = Number(data.opt_prem ?? 0) / 100;
      const estimated = Boolean(data.estimated);
      const directBenefit = Number(data.margin_benefit ?? 0) / 100;
      const individualSum = span + exposure + premium;
      const benefit = directBenefit > 0 ? directBenefit : individualSum > total && total > 0 ? individualSum - total : 0;
      setMargin({ total, benefit: benefit > 0 ? benefit : undefined, span: span > 0 ? span : undefined,
        exposure: exposure > 0 ? exposure : undefined, premium: premium > 0 ? premium : undefined,
        estimated, message: typeof data.message === 'string' ? data.message : undefined });
    } catch (e) {
      setMargin(null);
      setError((e as Error).message || 'Margin calculation failed.');
    } finally {
      setLoading(false);
    }
  }, [legs, exch, multiplier, onLegsResolved]);

  useEffect(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(fetchMargin, 400);
    return () => clearTimeout(timerRef.current);
  }, [fetchMargin]);

  return { margin, loading, error };
}
