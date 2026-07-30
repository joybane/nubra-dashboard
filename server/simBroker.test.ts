import { beforeEach, expect, test, vi } from 'vitest';

const db = vi.hoisted(() => ({
  dbInsertOrder: vi.fn(),
  dbUpdateOrder: vi.fn(),
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
