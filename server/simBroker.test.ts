import { beforeEach, expect, test, vi } from 'vitest';

const db = vi.hoisted(() => ({
  dbInsertOrder: vi.fn(),
  dbUpdateOrder: vi.fn(),
  dbModifyOrder: vi.fn(),
  dbSetOrderSlTriggered: vi.fn(),
  dbLoadOrders: vi.fn(() => []),
  dbInsertFill: vi.fn(),
  dbUpsertPosition: vi.fn(),
  dbLoadPositions: vi.fn(() => []),
  dbLoadClosedPositions: vi.fn(() => []),
  dbInsertPnlTick: vi.fn(),
  dbUpsertName: vi.fn(),
  dbLoadNameMap: vi.fn(() => new Map<string, number>()),
  dbGetMeta: vi.fn(() => undefined),
  dbSetMeta: vi.fn(),
  dbRenameStrategy: vi.fn(),
}));

vi.mock('./paperDb.ts', () => db);

import { SimBroker, simSpread } from './simBroker.ts';

beforeEach(() => {
  vi.clearAllMocks();
  db.dbLoadOrders.mockReturnValue([]);
  db.dbLoadPositions.mockReturnValue([]);
  db.dbLoadClosedPositions.mockReturnValue([]);
  db.dbLoadNameMap.mockReturnValue(new Map());
  db.dbGetMeta.mockReturnValue(undefined);
});

test('preserves the calibrated half-spread schedule', () => {
  expect(simSpread(0)).toBe(1);
  expect(simSpread(50)).toBe(1);
  expect(simSpread(500)).toBe(2);
  expect(simSpread(5_000)).toBe(15);
  expect(simSpread(10_000)).toBe(20);
});

test('preserves market-order fills at the simulated ask', () => {
  const broker = new SimBroker();
  broker.restore();
  const order = broker.placeOrder({
    nubraName: 'NIFTY_TEST_CE',
    liveRefId: 101,
    order_type: 'ORDER_TYPE_MARKET',
    order_side: 'ORDER_SIDE_BUY',
    order_qty: 65,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });

  broker.onLtp(101, 10_000);

  const executed = broker.getOrders('executed');
  expect(executed).toHaveLength(1);
  expect(executed[0]).toMatchObject({
    order_id: order.order_id,
    order_status: 'ORDER_STATUS_FILLED',
    avg_filled_price: 10_020,
  });
  expect(broker.getPositions()[0]).toMatchObject({
    ref_id: 101,
    qty: 65,
    avg_price: 10_020,
  });
  expect(db.dbInsertFill).toHaveBeenCalledOnce();
  expect(db.dbUpsertPosition).toHaveBeenCalledOnce();
});

test('preserves limit crossing and cancellation behavior', () => {
  const broker = new SimBroker();
  broker.restore();
  const limit = broker.placeOrder({
    nubraName: 'NIFTY_TEST_PE',
    liveRefId: 202,
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_BUY',
    order_qty: 65,
    order_price: 9_900,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });
  const cancellable = broker.placeOrder({
    nubraName: 'NIFTY_OTHER_PE',
    liveRefId: 303,
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_SELL',
    order_qty: 65,
    order_price: 12_000,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });

  broker.onLtp(202, 10_000);
  expect(broker.getOrders('live').some((order) => order.order_id === limit.order_id)).toBe(true);

  broker.onLtp(202, 9_800);
  expect(
    broker.getOrders('executed').find((order) => order.order_id === limit.order_id),
  ).toMatchObject({
    order_status: 'ORDER_STATUS_FILLED',
    avg_filled_price: 9_829,
  });

  expect(broker.cancelOrder(cancellable.order_id)).toBe(true);
  expect(broker.cancelOrder(cancellable.order_id)).toBe(false);
  expect(
    broker.getOrders('executed').find((order) => order.order_id === cancellable.order_id),
  ).toMatchObject({
    order_status: 'ORDER_STATUS_CANCELLED',
  });
});

// An SL-Limit can trigger without filling — the market gapped straight past the limit. Only
// `fill()` used to write to SQLite, so that armed state lived in memory alone: a restart
// un-triggered the order and it then waited for a second crossing of a level the market had
// already gone through, which on a gap never comes.
test('persists the stop-loss trigger latch even when the order does not fill', () => {
  const broker = new SimBroker();
  broker.restore();
  const slLimit = broker.placeOrder({
    nubraName: 'NIFTY_TEST_CE',
    liveRefId: 404,
    order_type: 'ORDER_TYPE_STOPLOSS',
    order_side: 'ORDER_SIDE_SELL',
    order_qty: 65,
    trigger_price: 9_000, // SELL SL triggers when bid falls to 9000
    order_price: 8_950, // …but only fills at 8950 or better
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });

  // Gap straight through both levels: the trigger is hit, the limit is not reachable.
  broker.onLtp(404, 8_000);

  const live = broker.getOrders('live').find((o) => o.order_id === slLimit.order_id);
  expect(live).toBeDefined(); // still open — it did not fill
  expect(live).toMatchObject({ sl_triggered: true });
  expect(db.dbSetOrderSlTriggered).toHaveBeenCalledWith(slLimit.order_id, true);
  // The narrow write is the point: dbUpdateOrder rewrites the fill block and would have
  // blanked filled_qty / order_status on an order that is still open.
  expect(db.dbUpdateOrder).not.toHaveBeenCalled();
});

// ── Order amendment ──────────────────────────────────────────────────────────
// modifyOrder used to mutate the in-memory order and stop there, so a restart silently reverted
// the amendment to the price the order was placed at.

function openLimit(broker: SimBroker, refId: number) {
  return broker.placeOrder({
    nubraName: 'NIFTY_TEST_CE',
    liveRefId: refId,
    order_type: 'ORDER_TYPE_REGULAR',
    order_side: 'ORDER_SIDE_BUY',
    order_qty: 65,
    order_price: 9_000,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });
}

test('persists an order amendment so it survives a restart', () => {
  const broker = new SimBroker();
  broker.restore();
  const order = openLimit(broker, 606);

  expect(broker.modifyOrder(order.order_id, { order_price: 9_500, order_qty: 130 })).toBe(true);

  expect(db.dbModifyOrder).toHaveBeenCalledWith({
    order_id: order.order_id,
    order_price: 9_500,
    trigger_price: 0,
    order_qty: 130,
  });
  expect(broker.getOrders('live')[0]).toMatchObject({ order_price: 9_500, order_qty: 130 });
  // The narrow write matters for the same reason it does for the SL latch: dbUpdateOrder
  // rewrites the fill block and would blank an open order's status.
  expect(db.dbUpdateOrder).not.toHaveBeenCalled();
});

test('an amendment that crosses the standing market fills immediately', () => {
  const broker = new SimBroker();
  broker.restore();
  const order = openLimit(broker, 707);

  broker.onLtp(707, 10_000); // ask 10_020 — well above the 9_000 limit, so no fill
  expect(broker.getOrders('live')).toHaveLength(1);

  // Raise the limit above the standing ask. No new tick arrives, so without re-evaluating on
  // amendment this would have sat unfilled until the price happened to move.
  broker.modifyOrder(order.order_id, { order_price: 10_100 });

  expect(broker.getOrders('executed')[0]).toMatchObject({
    order_status: 'ORDER_STATUS_FILLED',
    avg_filled_price: 10_020,
  });
});

test('rejects amendments that are not usable numbers, without partially applying them', () => {
  const broker = new SimBroker();
  broker.restore();
  const order = openLimit(broker, 808);

  for (const bad of [
    { order_qty: 0 },
    { order_qty: -5 },
    { order_price: -1 },
    { order_price: Number.NaN },
    { order_price: '9500' as unknown as number },
    // A valid field alongside an invalid one must not be written either.
    { order_price: 9_500, order_qty: -1 },
  ]) {
    expect(broker.modifyOrder(order.order_id, bad)).toBe(false);
  }

  expect(db.dbModifyOrder).not.toHaveBeenCalled();
  expect(broker.getOrders('live')[0]).toMatchObject({ order_price: 9_000, order_qty: 65 });
});

test('refuses to amend an order that is no longer open', () => {
  const broker = new SimBroker();
  broker.restore();
  const order = openLimit(broker, 909);
  broker.cancelOrder(order.order_id);

  expect(broker.modifyOrder(order.order_id, { order_price: 9_500 })).toBe(false);
  expect(broker.modifyOrder(123_456, { order_price: 9_500 })).toBe(false);
  expect(db.dbModifyOrder).not.toHaveBeenCalled();
});

// ── entry_qty ────────────────────────────────────────────────────────────────
// entry_qty was computed at fill time and never written, so a restart left every closed
// position reconstructing its own size from realized_pnl / price move.

test('writes the signed entry quantity through to the position row', () => {
  const broker = new SimBroker();
  broker.restore();
  broker.placeOrder({
    nubraName: 'NIFTY_TEST_PE',
    liveRefId: 111,
    order_type: 'ORDER_TYPE_MARKET',
    order_side: 'ORDER_SIDE_SELL',
    order_qty: 75,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });
  broker.onLtp(111, 10_000);

  expect(db.dbUpsertPosition).toHaveBeenCalledWith(expect.objectContaining({ entry_qty: -75 }));
});

test('restores a closed position entry quantity instead of re-deriving it', () => {
  db.dbLoadClosedPositions.mockReturnValue([
    {
      ref_id: 222,
      nubra_name: 'NIFTY_TEST_CE',
      display_name: 'NIFTY_TEST_CE',
      qty: 0,
      avg_price: 10_000,
      realized_pnl: 6_500,
      last_traded_price: 10_100,
      order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
      basket_group_id: '',
      entry_qty: 65,
      exit_price: 10_100,
    },
  ]);
  const broker = new SimBroker();
  broker.restore();

  expect(broker.getClosedPositions()[0]).toMatchObject({ entry_qty: 65 });
});

test('a stop-loss that triggers and fills still writes through the normal fill path', () => {
  const broker = new SimBroker();
  broker.restore();
  const slMarket = broker.placeOrder({
    nubraName: 'NIFTY_TEST_CE',
    liveRefId: 505,
    order_type: 'ORDER_TYPE_STOPLOSS',
    order_side: 'ORDER_SIDE_SELL',
    order_qty: 65,
    trigger_price: 9_000,
    order_price: 0, // SL-Market
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });

  broker.onLtp(505, 8_900);

  expect(broker.getOrders('executed').find((o) => o.order_id === slMarket.order_id)).toMatchObject({
    order_status: 'ORDER_STATUS_FILLED',
    sl_triggered: true,
  });
  expect(db.dbUpdateOrder).toHaveBeenCalled();
  // No redundant second write — fill() already persisted sl_triggered.
  expect(db.dbSetOrderSlTriggered).not.toHaveBeenCalled();
});
