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

import { SimBroker } from './simBroker.ts';

/** 09:25:30 IST on 15 Sep 2026. */
const ENTRY_NS = Date.parse('2026-09-15T03:55:30Z') * 1_000_000;
const LEG = {
  nubraName: 'NIFTY_TEST_CE',
  liveRefId: 101,
  display_name: 'NIFTY TEST CE',
  order_side: 'ORDER_SIDE_SELL',
  order_qty: 65,
  order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
};

function broker(): SimBroker {
  const b = new SimBroker();
  b.restore();
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
});

test('fills at exactly the chosen price and second, with no spread, even with a live tick cached', () => {
  const b = broker();
  b.onLtp(101, 9_000);
  const order = b.placeBackdated(LEG, { timeNs: ENTRY_NS, pricePaise: 8_450 });

  expect(order).toMatchObject({
    order_type: 'ORDER_TYPE_MARKET',
    order_status: 'ORDER_STATUS_FILLED',
    avg_filled_price: 8_450,
    order_time: ENTRY_NS,
    filled_time: ENTRY_NS,
  });
  expect(b.getPositions()[0]).toMatchObject({
    ref_id: 101,
    qty: -65,
    avg_price: 8_450,
    entry_time: ENTRY_NS,
    last_traded_price: 9_000,
  });
  expect(db.dbInsertOrder).toHaveBeenCalledOnce();
  expect(db.dbInsertFill.mock.calls[0][0]).toMatchObject({
    fill_price: 8_450,
    fill_time: ENTRY_NS,
  });
  expect(db.dbUpsertPosition.mock.calls[0][0]).toMatchObject({
    entry_time: ENTRY_NS,
    avg_price: 8_450,
  });
});

test('later live ticks move the P&L but never re-price the entry', () => {
  const b = broker();
  b.placeBackdated(LEG, { timeNs: ENTRY_NS, pricePaise: 8_450 });
  b.onLtp(101, 9_100);
  expect(b.getPositions()[0]).toMatchObject({ avg_price: 8_450, last_traded_price: 9_100 });
  expect(db.dbInsertFill).toHaveBeenCalledOnce();
});

test('closeBackdated squares off at the past second and price, realising the P&L', () => {
  const b = broker();
  b.placeBackdated(LEG, { timeNs: ENTRY_NS, pricePaise: 8_450 });
  const exitNs = ENTRY_NS + 600 * 1_000_000_000;
  const exit = b.closeBackdated(101, undefined, { timeNs: exitNs, pricePaise: 9_450 });

  expect(exit).toMatchObject({ order_side: 'ORDER_SIDE_BUY', order_qty: 65, filled_time: exitNs });
  expect(b.getPositions()).toHaveLength(0);
  expect(b.getClosedPositions()[0]).toMatchObject({
    qty: 0,
    realized_pnl: (8_450 - 9_450) * 65,
    exit_time: exitNs,
    exit_price: 9_450,
    entry_time: ENTRY_NS,
  });
  expect(b.closeBackdated(101, undefined, { timeNs: exitNs, pricePaise: 1 })).toBeNull();
});

test('a live market order still fills at the simulated spread, stamped now', () => {
  const b = broker();
  const before = Date.now() * 1_000_000;
  b.placeOrder({
    nubraName: 'NIFTY_LIVE_CE',
    liveRefId: 202,
    order_type: 'ORDER_TYPE_MARKET',
    order_side: 'ORDER_SIDE_BUY',
    order_qty: 65,
    order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
    validity_type: 'DAY',
  });
  b.onLtp(202, 10_000);
  const [filled] = b.getOrders('executed');
  expect(filled).toMatchObject({ avg_filled_price: 10_020, order_status: 'ORDER_STATUS_FILLED' });
  expect(filled.filled_time!).toBeGreaterThanOrEqual(before);
});
