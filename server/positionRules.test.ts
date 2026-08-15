import { beforeEach, describe, expect, it, vi } from 'vitest';

// positionRules persists every rule change through paperDb, which opens the real SQLite file on
// first use. The engine's behaviour is what is under test here, so the store is stubbed out.
vi.mock('./paperDb.ts', () => ({
  dbUpsertPositionRule: vi.fn(),
  dbLoadPositionRules: vi.fn(() => []),
  dbDeletePositionRule: vi.fn(() => true),
}));

import {
  upsertLegRule,
  upsertGroupRule,
  deleteLegRule,
  deleteGroupRule,
  listPositionRules,
  evaluateAndFire,
  sweepTimeExits,
  sanitizeExitTime,
  type RulePosition,
} from './positionRules.ts';

/** 15:15 IST on 14 Aug 2026 (UTC+5:30). */
const AT_1515 = new Date('2026-08-14T09:45:00Z').getTime();
const AT_1514 = new Date('2026-08-14T09:44:00Z').getTime();

function position(over: Partial<RulePosition> = {}): RulePosition {
  return {
    ref_id: 101,
    nubraName: 'NIFTY24000CE',
    display_name: 'NIFTY 24000 CE',
    qty: -65, // short a call: the premium rising is the loss
    avg_price: 8_270, // paise → ₹82.70
    last_traded_price: 8_270,
    order_delivery_type: 'IDAY',
    basket_group_id: '',
    entry_time: 1,
    ...over,
  };
}

function makeBroker(positions: RulePosition[]) {
  const placeOrder = vi.fn();
  return {
    placeOrder,
    getPositions: () => positions,
  };
}

/** Rules live in module state, so every test starts from an empty set. */
beforeEach(() => {
  for (const rule of listPositionRules()) {
    if (rule.scope === 'LEG') deleteLegRule(rule.ref_id, rule.basket_group_id);
    else deleteGroupRule(rule.basket_group_id);
  }
  expect(listPositionRules()).toHaveLength(0);
});

describe('leg time exit', () => {
  it('squares the leg off once the clock reaches it, with no price movement at all', () => {
    upsertLegRule({ scope: 'LEG', ref_id: 101, basket_group_id: '', exitTime: '15:15' });
    const broker = makeBroker([position()]);

    expect(evaluateAndFire(broker, 101, AT_1514)).toEqual([]);
    expect(broker.placeOrder).not.toHaveBeenCalled();

    const events = evaluateAndFire(broker, 101, AT_1515);

    expect(events).toEqual([
      { scope: 'LEG', reason: 'TIME_EXIT', ref_ids: [101], basket_group_id: '' },
    ]);
    expect(broker.placeOrder).toHaveBeenCalledTimes(1);
    // Short position → the exit is a BUY of the same quantity, at market.
    expect(broker.placeOrder.mock.calls[0][0]).toMatchObject({
      liveRefId: 101,
      order_side: 'ORDER_SIDE_BUY',
      order_qty: 65,
      order_type: 'ORDER_TYPE_MARKET',
    });
  });

  it('consumes the rule, so a second pass cannot double-exit', () => {
    upsertLegRule({ scope: 'LEG', ref_id: 101, basket_group_id: '', exitTime: '15:15' });
    const broker = makeBroker([position()]);

    evaluateAndFire(broker, 101, AT_1515);
    const again = evaluateAndFire(broker, 101, AT_1515);

    expect(again).toEqual([]);
    expect(broker.placeOrder).toHaveBeenCalledTimes(1);
    expect(listPositionRules()).toHaveLength(0);
  });

  it('lets a real stop-loss keep its own reason when both are true at once', () => {
    upsertLegRule({
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      stopLoss: { type: 'PREMIUM_PRICE', value: 90 },
      exitTime: '15:15',
    });
    // Short at ₹82.70, premium now ₹95 — past the ₹90 stop.
    const broker = makeBroker([position({ last_traded_price: 9_500 })]);

    expect(evaluateAndFire(broker, 101, AT_1515)[0].reason).toBe('STOPLOSS');
  });

  it('leaves a rule with no exit time exactly as it behaved before', () => {
    upsertLegRule({
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      target: { type: 'PREMIUM_PRICE', value: 60 },
    });
    const broker = makeBroker([position({ last_traded_price: 7_000 })]);

    // ₹70 has not reached the ₹60 target, and there is no clock to fall back on.
    expect(evaluateAndFire(broker, 101, AT_1515)).toEqual([]);
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });
});

describe('group time exit', () => {
  it('squares every leg in the basket off', () => {
    upsertGroupRule({ scope: 'GROUP', basket_group_id: 'bg_1', exitTime: '15:15' });
    const legs = [
      position({ ref_id: 101, basket_group_id: 'bg_1' }),
      position({ ref_id: 102, basket_group_id: 'bg_1', qty: 65 }),
    ];
    const broker = makeBroker(legs);

    expect(evaluateAndFire(broker, 101, AT_1514)).toEqual([]);
    const events = evaluateAndFire(broker, 101, AT_1515);

    expect(events).toEqual([
      { scope: 'GROUP', reason: 'TIME_EXIT', ref_ids: [101, 102], basket_group_id: 'bg_1' },
    ]);
    expect(broker.placeOrder).toHaveBeenCalledTimes(2);
    expect(listPositionRules()).toHaveLength(0);
  });

  it('lets a combined-₹ target keep its own reason when both are true at once', () => {
    upsertGroupRule({
      scope: 'GROUP',
      basket_group_id: 'bg_1',
      maxProfit: 1_000,
      exitTime: '15:15',
    });
    // Short 65 @ ₹82.70, now ₹60.00 → +₹1,475.50 combined.
    const broker = makeBroker([position({ basket_group_id: 'bg_1', last_traded_price: 6_000 })]);

    expect(evaluateAndFire(broker, 101, AT_1515)[0].reason).toBe('PORTFOLIO_TP');
  });
});

describe('sweepTimeExits', () => {
  it('reaches every open position, which is what gives a clock trigger something to ride on', () => {
    upsertLegRule({ scope: 'LEG', ref_id: 101, basket_group_id: '', exitTime: '15:15' });
    upsertLegRule({ scope: 'LEG', ref_id: 102, basket_group_id: '', exitTime: '15:15' });
    const broker = makeBroker([position({ ref_id: 101 }), position({ ref_id: 102 })]);

    const events = sweepTimeExits(broker, AT_1515);

    expect(events.map((e) => e.ref_ids)).toEqual([[101], [102]]);
    expect(broker.placeOrder).toHaveBeenCalledTimes(2);
  });

  it('returns immediately when no rules are armed', () => {
    const broker = makeBroker([position()]);
    expect(sweepTimeExits(broker, AT_1515)).toEqual([]);
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  // The point of the narrowed sweep: a price level must still wait for a real tick, so a cached
  // LTP hours old (server restart, dead option-chain feed) can never square a position off.
  it('never fires a price level, however far past it the cached LTP sits', () => {
    upsertLegRule({
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      stopLoss: { type: 'PREMIUM_PRICE', value: 90 },
    });
    upsertGroupRule({ scope: 'GROUP', basket_group_id: 'bg_1', maxLoss: 100 });
    const broker = makeBroker([
      position({ last_traded_price: 40_000 }), // ₹400 on a short from ₹82.70 — far past the stop
      position({ ref_id: 102, basket_group_id: 'bg_1', last_traded_price: 40_000 }),
    ]);

    expect(sweepTimeExits(broker, AT_1515)).toEqual([]);
    expect(broker.placeOrder).not.toHaveBeenCalled();

    // The same state on a real tick still fires, so nothing was disarmed — only deferred.
    expect(evaluateAndFire(broker, 101, AT_1515)[0].reason).toBe('STOPLOSS');
  });

  it('still fires a time exit on a leg whose price rules it is ignoring', () => {
    upsertLegRule({
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      stopLoss: { type: 'PREMIUM_PRICE', value: 90 },
      exitTime: '15:15',
    });
    const broker = makeBroker([position({ last_traded_price: 40_000 })]);

    expect(sweepTimeExits(broker, AT_1515)).toEqual([
      { scope: 'LEG', reason: 'TIME_EXIT', ref_ids: [101], basket_group_id: '' },
    ]);
  });
});

describe('sanitizeExitTime at the API boundary', () => {
  it('keeps a valid HH:MM and drops anything else', () => {
    expect(sanitizeExitTime('15:15')).toBe('15:15');
    expect(sanitizeExitTime('25:00')).toBeUndefined();
    expect(sanitizeExitTime(undefined)).toBeUndefined();
  });

  it('a rejected value stores no rule that could fire at an unpredictable time', () => {
    upsertLegRule({
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      exitTime: sanitizeExitTime('tea time'),
    });
    const broker = makeBroker([position()]);

    expect(evaluateAndFire(broker, 101, AT_1515)).toEqual([]);
  });
});
