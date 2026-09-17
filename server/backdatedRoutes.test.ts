import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const db = vi.hoisted(() => ({
  dbUpsertPositionRule: vi.fn(),
  dbLoadPositionRules: vi.fn(() => []),
  dbDeletePositionRule: vi.fn(() => true),
  dbInsertBackdatedTrade: vi.fn(),
  dbListBackdatedTrades: vi.fn((): unknown[] => []),
  dbSetBackdatedReplayed: vi.fn(),
}));
vi.mock('./paperDb.ts', () => db);

const { registerBackdatedRoutes } = await import('./backdatedRoutes.ts');
const { listPositionRules, deleteLegRule, deleteGroupRule } = await import('./positionRules.ts');

const SYMBOL = 'NIFTY2691523350CE';
/** 10:00:00 IST, Tuesday 15 Sep 2026. */
const NOW = Date.parse('2026-09-15T04:30:00Z');
const istNs = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number);
  return (
    (Date.parse('2026-09-15T00:00:00Z') - 19_800_000 + (h * 3600 + m * 60 + s) * 1000) * 1_000_000
  );
};

/** One-second bars: [time, open, high, low, close] in rupees. */
function series(bars: Array<[string, number, number, number, number]>) {
  const field = (i: number) =>
    bars.map((b) => ({ ts: String(BigInt(istNs(b[0]))), v: Math.round((b[i] as number) * 100) }));
  return {
    result: [
      {
        values: [{ [SYMBOL]: { open: field(1), high: field(2), low: field(3), close: field(4) } }],
      },
    ],
  };
}
const BARS = series([
  ['09:25:30', 84, 85, 83.9, 84.5],
  ['09:30:00', 90, 96, 89, 95],
  ['09:45:00', 95, 95, 93, 94],
]);

let app: ReturnType<typeof Fastify>;
let nextId = 1;
let positions: Array<{
  ref_id: number;
  qty: number;
  avg_price: number;
  basket_group_id?: string;
  entry_time?: number;
}> = [];
let post: ((body: object) => Promise<Record<string, unknown>>) | null;
const simBroker = {
  placeBackdated: vi.fn((_p: unknown, at: { timeNs: number; pricePaise: number }) => ({
    order_id: nextId++,
    avg_filled_price: at.pricePaise,
  })),
  closeBackdated: vi.fn(() => ({ order_id: 99 })),
  getPositions: vi.fn(() => positions),
};
const subscribeForSim = vi.fn();
const broadcastRuleEvents = vi.fn();

const legBody = (over: Record<string, unknown> = {}) => ({
  nubraName: SYMBOL,
  liveRefId: 101,
  display_name: 'NIFTY 23350 CE',
  order_qty: 65,
  order_side: 'ORDER_SIDE_SELL',
  order_delivery_type: 'ORDER_DELIVERY_TYPE_IDAY',
  asset: 'NIFTY',
  expiry: '20260915',
  exchange: 'NSE',
  derivative_type: 'OPT',
  symbol: SYMBOL,
  instrument_type: 'OPT',
  entry_time: '09:25:30',
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  nextId = 1;
  positions = [];
  post = vi.fn(async () => BARS);
  app = Fastify();
  registerBackdatedRoutes({
    fastify: app,
    requireAuth: () => true,
    simBroker,
    subscribeForSim,
    getTimeseriesPost: () => post,
    broadcastRuleEvents,
    nowMs: () => NOW,
  });
  await app.ready();
});

afterEach(async () => {
  for (const r of listPositionRules()) {
    if (r.scope === 'LEG') deleteLegRule(r.ref_id, r.basket_group_id);
    else deleteGroupRule(r.basket_group_id);
  }
  await app.close();
});

test('the price preview reads the trade at or before the second', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/paper/backdated/price?exchange=NSE&type=OPT&symbol=${SYMBOL}&time=09:27:00`,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    actual_time: '09:25:30',
    exact: false,
    open: 84,
    high: 85,
    low: 83.9,
    close: 84.5,
    vwap: null,
    vwap_fallback: true,
  });
});

test('rejects now, pre-open, malformed times and unknown price sources, placing nothing', async () => {
  for (const [over, pattern] of [
    [{ entry_time: '10:00:00' }, /earlier than now/],
    [{ entry_time: '09:14:00' }, /session/],
    [{ entry_time: '9:25' }, /HH:MM:SS/],
    [{ price_source: 'mid' }, /price_source/],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/paper/backdated/order',
      payload: legBody(over),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(pattern);
  }
  expect(simBroker.placeBackdated).not.toHaveBeenCalled();
});

test('fills at that second, at Close by default, and subscribes the live feed', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody(),
  });
  expect(res.statusCode).toBe(200);
  expect(simBroker.placeBackdated).toHaveBeenCalledWith(
    expect.objectContaining({ liveRefId: 101, order_side: 'ORDER_SIDE_SELL', order_qty: 65 }),
    { timeNs: istNs('09:25:30'), pricePaise: 8_450 },
  );
  expect(subscribeForSim).toHaveBeenCalledWith(SYMBOL, 101, 'OPT', 'NIFTY', '20260915', 'NSE');
  expect(db.dbInsertBackdatedTrade).toHaveBeenCalledWith(
    expect.objectContaining({
      order_id: 1,
      entry_label: '09:25:30',
      price_source: 'close',
      exact: 1,
    }),
  );
  expect(res.json()).toMatchObject({
    orders: [{ order_id: 1, fill_price: 8_450, exact: true, actual_time: '09:25:30' }],
    replay: { exits: [] },
  });

  const high = await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody({ price_source: 'high', liveRefId: 102 }),
  });
  expect(high.json().orders[0].fill_price).toBe(8_500);
});

test('a stop-loss history already crossed closes the position at that second and level', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody({ rules: { stopLoss: { type: 'PREMIUM_ABSOLUTE', value: 10 } } }),
  });
  expect(res.statusCode).toBe(200);
  expect(simBroker.closeBackdated).toHaveBeenCalledWith(101, '', {
    timeNs: istNs('09:30:00'),
    pricePaise: 9_450,
  });
  expect(res.json().replay.exits).toEqual([
    {
      ref_id: 101,
      basket_group_id: '',
      scope: 'LEG',
      reason: 'STOPLOSS',
      time: '09:30:00',
      price: 94.5,
    },
  ]);
  expect(broadcastRuleEvents).toHaveBeenCalledWith([
    { scope: 'LEG', reason: 'STOPLOSS', ref_ids: [101], basket_group_id: '' },
  ]);
  expect(listPositionRules()).toEqual([]);
});

test('a stop-loss history never reached stays armed for the live engine', async () => {
  await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody({ rules: { stopLoss: { type: 'PREMIUM_ABSOLUTE', value: 20 } } }),
  });
  expect(simBroker.closeBackdated).not.toHaveBeenCalled();
  expect(listPositionRules()).toHaveLength(1);
});

test('refuses without a broker session, and refuses to average into an open position', async () => {
  post = null;
  const offline = await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody(),
  });
  expect(offline.statusCode).toBe(503);

  post = vi.fn(async () => BARS);
  positions = [{ ref_id: 101, qty: -65, avg_price: 8_000, basket_group_id: '' }];
  const clash = await app.inject({
    method: 'POST',
    url: '/paper/backdated/order',
    payload: legBody(),
  });
  expect(clash.statusCode).toBe(409);
  expect(simBroker.placeBackdated).not.toHaveBeenCalled();
});

test('a basket is entered as one group and its combined stop is replayed on closes', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/paper/backdated/basket',
    payload: {
      entry_time: '09:25:30',
      strategy_name: 'Short strangle',
      orders: [legBody(), legBody({ liveRefId: 102 })],
      group_rule: { maxLoss: 1000 },
    },
  });
  expect(res.statusCode).toBe(200);
  const gid = res.json().basket_group_id as string;
  expect(gid).toMatch(/^bg_/);
  // Both short at 84.50; at 09:30:00 both close 95 → 2 × (95 − 84.5) × −65 = −1365.
  expect(simBroker.closeBackdated).toHaveBeenCalledTimes(2);
  expect(simBroker.closeBackdated).toHaveBeenCalledWith(101, gid, {
    timeNs: istNs('09:30:00'),
    pricePaise: 9_500,
  });
  expect(broadcastRuleEvents).toHaveBeenCalledWith([
    { scope: 'GROUP', reason: 'PORTFOLIO_SL', ref_ids: [101, 102], basket_group_id: gid },
  ]);
  expect(post).toHaveBeenCalledOnce(); // one fetch per distinct contract
});

test("lists today's backdated entries for the Positions badge", async () => {
  db.dbListBackdatedTrades.mockReturnValueOnce([
    {
      order_id: 3,
      ref_id: 101,
      basket_group_id: '',
      entry_time_ns: istNs('09:25:30'),
      entry_label: '09:25:30',
      price_source: 'vwap',
      exact: 0,
      fill_price: 8_450,
    },
  ]);
  const res = await app.inject({ method: 'GET', url: '/paper/backdated' });
  expect(res.json()).toEqual({
    trades: [
      {
        order_id: 3,
        ref_id: 101,
        basket_group_id: '',
        entry_time: '09:25:30',
        price_source: 'vwap',
        exact: false,
        fill_price: 8_450,
      },
    ],
  });
});
