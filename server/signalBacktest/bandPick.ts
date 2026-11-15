import type { DaySeries } from '../analysis/daySeries.ts';
import { entryPricesAt, type OhlcSource } from './trade.ts';

/**
 * The Strangle Max Loss report's price-band strike rule, shared by the report builder and the
 * Trade Explorer: per leg, the strike whose entry price is nearest the band's middle, allowed up
 * to one band width outside the band (ties go to the strike nearer spot). `maxSteps` < 0 keeps
 * only strikes in the day ladder; `otmOnly` drops in-the-money strikes.
 */
export function pickBand(
  day: DaySeries,
  ohlc: OhlcSource | null,
  e: number,
  step: number,
  lo: number,
  hi: number,
  maxSteps: number,
  otmOnly: boolean,
) {
  const spot = day.spot[e];
  if (spot == null) return null;
  const atm = Math.round(spot / step) * step,
    mid = (lo + hi) / 2,
    w = hi - lo;
  const out: Record<string, { strike: number; price: number }> = {};
  for (const kind of ['CE', 'PE'] as const) {
    let best: { strike: number; price: number; off: number; dist: number } | null = null;
    for (const p of entryPricesAt(day, kind, e, ohlc)) {
      if (maxSteps >= 0 && Math.abs(p.strike - atm) > maxSteps * step) continue;
      if (maxSteps < 0 && (kind === 'CE' ? day.ce : day.pe)[String(p.strike)] == null) continue;
      if (otmOnly && (kind === 'CE' ? p.strike < atm : p.strike > atm)) continue;
      const off = Math.abs(p.price - mid),
        dist = Math.abs(p.strike - spot);
      if (!best || off < best.off || (off === best.off && dist < best.dist))
        best = { ...p, off, dist };
    }
    if (!best || best.price < lo - w - 1e-9 || best.price > hi + w + 1e-9) return null;
    out[kind] = { strike: best.strike, price: best.price };
  }
  return out as { CE: { strike: number; price: number }; PE: { strike: number; price: number } };
}

/** The report's way of writing a band price: two significant figures, whole rupees from ₹10. */
export const bandPrice = (v: number) => (v >= 10 ? String(Math.round(v)) : v.toPrecision(2));
export const bandRange = (lo: number, hi: number) => `₹${bandPrice(lo)}–${bandPrice(hi)}`;
export const dteName = (dte: number) => (dte ? `Exp−${dte}` : 'Exp');
