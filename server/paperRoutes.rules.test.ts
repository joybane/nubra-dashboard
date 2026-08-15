// End-to-end cover for the position auto-exit rule endpoints: the body the editor actually
// sends → the route's sanitizer → the rule the engine will fire on → what GET reports back.
// Kept separate from paperRoutes.test.ts because these routes write through paperDb, and this
// file stubs that store out rather than opening the real SQLite file.
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('./paperDb.ts', () => ({
  dbUpsertPositionRule: vi.fn(),
  dbLoadPositionRules: vi.fn(() => []),
  dbDeletePositionRule: vi.fn(() => true),
  dbInsertBasket: vi.fn(),
  dbLoadBaskets: vi.fn(() => []),
  dbDeleteBasket: vi.fn(() => true),
  dbUpdateBasket: vi.fn(() => true),
  dbRenameSavedBasket: vi.fn(() => true),
  dbUpsertSnapshot: vi.fn(),
  dbListSnapshots: vi.fn(() => []),
  dbGetSnapshot: vi.fn(() => null),
  dbDeleteSnapshot: vi.fn(() => true),
}));

const { registerPaperRoutes } = await import('./paperRoutes.ts');

let app: ReturnType<typeof Fastify>;
const simBroker = {
  getOrders: vi.fn(() => []),
  placeOrder: vi.fn(() => ({ order_id: 1 })),
  getPositions: vi.fn(() => []),
  getClosedPositions: vi.fn(() => []),
  modifyOrder: vi.fn(() => false),
  cancelOrder: vi.fn(() => false),
  registerName: vi.fn(),
  renameStrategy: vi.fn(() => false),
};
const fireRules = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  registerPaperRoutes({
    fastify: app,
    requireAuth: () => true,
    getAuthStatus: () => 'authenticated',
    getSessionToken: () => 'test-session-token',
    simBroker,
    subscribeForSim: vi.fn(),
    fireRules,
    buildDebugResponse: vi.fn(() => ({})),
    nubraGet: vi.fn(async () => ({})),
    nubraPostAt: vi.fn(async () => ({})),
    marginBaseUrl: 'https://margin.test',
  });
  await app.ready();
});

afterEach(async () => {
  // Leave no rule behind for the next test — they live in positionRules' module state.
  for (const scope of ['leg', 'group']) {
    await app.inject({
      method: 'DELETE',
      url: `/paper/positions/rules/${scope}?ref_id=101&basket_group_id=bg_1`,
    });
  }
  await app.inject({ method: 'DELETE', url: '/paper/positions/rules/leg?ref_id=101' });
  await app.close();
});

async function rules() {
  return (await app.inject({ method: 'GET', url: '/paper/positions/rules' })).json().rules;
}

test('a leg rule round-trips its exit time exactly as the editor sent it', async () => {
  const put = await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/leg',
    payload: {
      ref_id: 101,
      basket_group_id: '',
      stopLoss: { type: 'NONE' },
      target: { type: 'NONE' },
      trail: { type: 'NONE' },
      exitTime: '15:15',
    },
  });

  expect(put.statusCode).toBe(200);
  expect(await rules()).toEqual([
    {
      scope: 'LEG',
      ref_id: 101,
      basket_group_id: '',
      stopLoss: { type: 'NONE' },
      target: { type: 'NONE' },
      trail: { type: 'NONE' },
      exitTime: '15:15',
    },
  ]);
});

test('a group rule round-trips its exit time alongside the combined-₹ thresholds', async () => {
  await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/group',
    payload: {
      basket_group_id: 'bg_1',
      maxProfit: 4000,
      exitAllOnLegHit: true,
      exitTime: '15:20',
    },
  });

  expect(await rules()).toEqual([
    {
      scope: 'GROUP',
      basket_group_id: 'bg_1',
      maxProfit: 4000,
      exitAllOnLegHit: true,
      exitTime: '15:20',
    },
  ]);
});

test('a malformed exit time is dropped rather than stored, on either scope', async () => {
  await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/leg',
    payload: { ref_id: 101, exitTime: '25:99' },
  });
  await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/group',
    payload: { basket_group_id: 'bg_1', maxLoss: 500, exitTime: 'soon' },
  });

  for (const rule of await rules()) expect(rule.exitTime).toBeUndefined();
});

test('omitting exitTime entirely leaves an existing rule shape unchanged', async () => {
  await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/leg',
    payload: { ref_id: 101, stopLoss: { type: 'PREMIUM_PRICE', value: 90 } },
  });

  const [rule] = await rules();
  expect(rule.stopLoss).toEqual({ type: 'PREMIUM_PRICE', value: 90 });
  expect(rule.exitTime).toBeUndefined();
});

test('the immediate evaluation on save is preserved, so an already-past time acts at once', async () => {
  await app.inject({
    method: 'PUT',
    url: '/paper/positions/rules/leg',
    payload: { ref_id: 101, exitTime: '15:15' },
  });

  expect(fireRules).toHaveBeenCalledWith(101);
});
