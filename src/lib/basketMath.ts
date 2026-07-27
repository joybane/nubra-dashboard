import type { BasketLeg } from '../hooks/useBasketContext';

/**
 * Basket aggregates shared by the Option Chain drawer and the Basket tab builder.
 * Both surfaces render the same basket, so the numbers have to come from here —
 * they used to be duplicated (and had drifted apart on qty handling).
 */

type MathLeg = Pick<BasketLeg, 'side' | 'lots' | 'lotSize' | 'ltp' | 'entryLtp'>;
type GreekLeg = MathLeg & Pick<BasketLeg, 'delta' | 'gamma' | 'theta' | 'vega'>;

export function legQty(leg: Pick<BasketLeg, 'lots' | 'lotSize'>): number {
  return leg.lots * leg.lotSize;
}

/** Sum of per-lot prices — BUY positive, SELL negative. */
export function totalPrice(legs: MathLeg[]): number {
  return legs.reduce((acc, l) => acc + (l.side === 'BUY' ? 1 : -1) * l.ltp, 0);
}

/** Net cashflow of the basket: positive = credit received, negative = debit paid. */
export function netPremium(legs: MathLeg[]): number {
  return legs.reduce((acc, l) => acc + (l.side === 'BUY' ? -1 : 1) * l.ltp * legQty(l), 0);
}

/** Mark-to-market of one leg: entry price vs current LTP. */
export function legMtm(leg: MathLeg): number {
  return (leg.ltp - leg.entryLtp) * legQty(leg) * (leg.side === 'BUY' ? 1 : -1);
}

export function totalMtm(legs: MathLeg[]): number {
  return legs.reduce((acc, l) => acc + legMtm(l), 0);
}

export interface NetGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega:  number;
}

/** Position greeks — per-share greeks scaled by signed quantity. */
export function netGreeks(legs: GreekLeg[]): NetGreeks {
  return legs.reduce<NetGreeks>((acc, l) => {
    const sign = l.side === 'BUY' ? 1 : -1;
    const qty  = legQty(l) * sign;
    return {
      delta: acc.delta + (l.delta ?? 0) * qty,
      gamma: acc.gamma + (l.gamma ?? 0) * qty,
      theta: acc.theta + (l.theta ?? 0) * qty,
      vega:  acc.vega  + (l.vega  ?? 0) * qty,
    };
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 });
}
