// ─── Amending an open paper order ────────────────────────────────────────────
// `POST /paper/orders/modify/:id` has existed (and been documented) for as long as the paper book
// has, but nothing ever called it: an unfilled limit could only be cancelled and re-placed, which
// throws away its order id and its place in the book. This module is the client half of that
// route — the draft shape the Orders tab edits, and the rules for turning it into a patch.
//
// The one conversion that matters: the user types **rupees**, the wire is **paise**.
import type { PaperOrder } from '../types';

/** Raw strings as typed, so a half-entered value round-trips instead of snapping to a number. */
export interface OrderDraft {
  qty: string;
  price: string;
  trigger: string;
}

export const EMPTY_DRAFT: OrderDraft = { qty: '', price: '', trigger: '' };

export function draftFromOrder(o: PaperOrder): OrderDraft {
  return {
    qty: String(o.order_qty ?? ''),
    price: o.order_price ? (o.order_price / 100).toFixed(2) : '',
    trigger: o.trigger_price ? (o.trigger_price / 100).toFixed(2) : '',
  };
}

/** A market order has no limit price to amend, and only a stop-loss carries a trigger. */
export function editableFields(o: PaperOrder): { price: boolean; trigger: boolean } {
  return {
    price: o.order_type !== 'ORDER_TYPE_MARKET',
    trigger: o.order_type === 'ORDER_TYPE_STOPLOSS',
  };
}

export type OrderPatchResult = { patch: Record<string, number> } | { error: string };

/**
 * Turn a draft into the paise payload the route expects, or into the first thing wrong with it.
 *
 * Only *changed* fields are sent. That is what keeps a quantity amendment from silently
 * restating a price the user never touched — the round trip through `toFixed(2)` and back is
 * lossless for real prices but the intent still belongs to the field the user actually edited.
 * An unchanged draft yields "Nothing changed" rather than an empty patch, which the route
 * rejects anyway.
 */
export function buildOrderPatch(o: PaperOrder, draft: OrderDraft): OrderPatchResult {
  const patch: Record<string, number> = {};

  const qty = Number(draft.qty);
  if (draft.qty.trim() === '' || !Number.isInteger(qty) || qty <= 0)
    return { error: 'Quantity must be a whole number above 0' };
  if (qty !== o.order_qty) patch.order_qty = qty;

  const { price: canPrice, trigger: canTrigger } = editableFields(o);
  const fields = [
    {
      key: 'order_price',
      label: 'Price',
      raw: draft.price,
      allowed: canPrice,
      current: o.order_price ?? 0,
    },
    {
      key: 'trigger_price',
      label: 'Trigger',
      raw: draft.trigger,
      allowed: canTrigger,
      current: o.trigger_price ?? 0,
    },
  ] as const;

  for (const { key, label, raw, allowed, current } of fields) {
    if (!allowed) continue;
    // Zero is how the server spells "no limit" / "no trigger", and for a stop-loss that is a real
    // choice — order_price 0 is SL-Market. For a plain limit it is not: the engine reads a sell
    // limit of 0 as "any bid will do" and fills it at the market on the next tick, which is not
    // what clearing a price box means. So a limit order must keep a price.
    const blank = raw.trim() === '';
    if (blank && key === 'order_price' && o.order_type === 'ORDER_TYPE_REGULAR')
      return { error: 'A limit order needs a price' };
    const rupees = blank ? 0 : Number(raw);
    if (!Number.isFinite(rupees) || rupees < 0) return { error: `${label} must be 0 or more` };
    if (rupees === 0 && key === 'order_price' && o.order_type === 'ORDER_TYPE_REGULAR')
      return { error: 'A limit order needs a price above 0' };
    const paiseValue = Math.round(rupees * 100);
    if (paiseValue !== current) patch[key] = paiseValue;
  }

  if (Object.keys(patch).length === 0) return { error: 'Nothing changed' };
  return { patch };
}
