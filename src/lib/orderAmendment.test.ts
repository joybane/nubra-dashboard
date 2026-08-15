import { describe, expect, test } from 'vitest';
import type { PaperOrder } from '../types';
import { buildOrderPatch, draftFromOrder, editableFields } from './orderAmendment';

function order(overrides: Partial<PaperOrder> = {}): PaperOrder {
  return {
    order_id: 1,
    ref_id: 101,
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_BUY',
    order_status: 'ORDER_STATUS_OPEN',
    order_qty: 65,
    filled_qty: 0,
    order_price: 900_000,
    trigger_price: 0,
    avg_filled_price: 0,
    order_time: 0,
    ...overrides,
  } as PaperOrder;
}

describe('draftFromOrder', () => {
  test('renders paise as rupees and leaves unset fields blank', () => {
    expect(draftFromOrder(order())).toEqual({ qty: '65', price: '9000.00', trigger: '' });
    expect(draftFromOrder(order({ order_price: 0, trigger_price: 12_345 }))).toEqual({
      qty: '65',
      price: '',
      trigger: '123.45',
    });
  });
});

describe('editableFields', () => {
  test('offers only the fields the order type actually has', () => {
    expect(editableFields(order({ order_type: 'ORDER_TYPE_REGULAR' }))).toEqual({
      price: true,
      trigger: false,
    });
    expect(editableFields(order({ order_type: 'ORDER_TYPE_MARKET' }))).toEqual({
      price: false,
      trigger: false,
    });
    expect(editableFields(order({ order_type: 'ORDER_TYPE_STOPLOSS' }))).toEqual({
      price: true,
      trigger: true,
    });
  });
});

describe('buildOrderPatch', () => {
  test('sends only what changed, converted to paise', () => {
    expect(buildOrderPatch(order(), { qty: '65', price: '9500', trigger: '' })).toEqual({
      patch: { order_price: 950_000 },
    });
    expect(buildOrderPatch(order(), { qty: '130', price: '9000.00', trigger: '' })).toEqual({
      patch: { order_qty: 130 },
    });
    expect(buildOrderPatch(order(), { qty: '130', price: '9500.50', trigger: '' })).toEqual({
      patch: { order_qty: 130, order_price: 950_050 },
    });
  });

  test('refuses an unchanged draft rather than sending an empty patch', () => {
    expect(buildOrderPatch(order(), { qty: '65', price: '9000.00', trigger: '' })).toEqual({
      error: 'Nothing changed',
    });
  });

  test('rejects a quantity that is not a whole number above zero', () => {
    for (const qty of ['', '0', '-5', '2.5', 'abc']) {
      expect(buildOrderPatch(order(), { qty, price: '9500', trigger: '' })).toEqual({
        error: 'Quantity must be a whole number above 0',
      });
    }
  });

  test('rejects a negative or non-numeric price and names the field', () => {
    expect(buildOrderPatch(order(), { qty: '65', price: '-1', trigger: '' })).toEqual({
      error: 'Price must be 0 or more',
    });
    expect(buildOrderPatch(order(), { qty: '65', price: 'cheap', trigger: '' })).toEqual({
      error: 'Price must be 0 or more',
    });
    const sl = order({ order_type: 'ORDER_TYPE_STOPLOSS', trigger_price: 880_000 });
    expect(buildOrderPatch(sl, { qty: '65', price: '9000.00', trigger: '-2' })).toEqual({
      error: 'Trigger must be 0 or more',
    });
  });

  test('ignores fields the order type does not have, however the draft was left', () => {
    // A market order's price box is not rendered, but the draft still carries whatever was in it
    // from a previous row — it must not leak into the patch.
    const market = order({ order_type: 'ORDER_TYPE_MARKET', order_price: 0 });
    expect(buildOrderPatch(market, { qty: '130', price: '9999', trigger: '5555' })).toEqual({
      patch: { order_qty: 130 },
    });
    // A plain limit has no trigger.
    expect(buildOrderPatch(order(), { qty: '65', price: '9500', trigger: '8800' })).toEqual({
      patch: { order_price: 950_000 },
    });
  });

  // A sell limit of 0 means "any bid will do", so the engine fills it at the market on the next
  // tick. Clearing the price box must not quietly turn a resting limit into that.
  test('refuses to strip the price off a limit order', () => {
    expect(buildOrderPatch(order(), { qty: '65', price: '', trigger: '' })).toEqual({
      error: 'A limit order needs a price',
    });
    expect(buildOrderPatch(order(), { qty: '65', price: '0', trigger: '' })).toEqual({
      error: 'A limit order needs a price above 0',
    });
  });

  // On a stop-loss, price 0 is a real and meaningful choice: it is SL-Market.
  test('allows a stop-loss limit to be cleared back to SL-Market', () => {
    const sl = order({
      order_type: 'ORDER_TYPE_STOPLOSS',
      order_price: 880_000,
      trigger_price: 890_000,
    });
    expect(buildOrderPatch(sl, { qty: '65', price: '', trigger: '8900' })).toEqual({
      patch: { order_price: 0 },
    });
  });

  test('amends both legs of a stop-loss limit', () => {
    const sl = order({
      order_type: 'ORDER_TYPE_STOPLOSS',
      order_price: 880_000,
      trigger_price: 890_000,
    });
    expect(buildOrderPatch(sl, { qty: '65', price: '8700', trigger: '8750' })).toEqual({
      patch: { order_price: 870_000, trigger_price: 875_000 },
    });
  });
});
