import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MismatchVersionRow } from './paperDb.ts';

vi.mock('./paperDb.ts', () => ({
  dbInsertMismatchVersion: vi.fn(),
  dbListMismatchTrackers: vi.fn(() => []),
  dbListMismatchVersions: vi.fn(() => []),
  dbSetMismatchTracker: vi.fn(),
  dbGetMismatchCoverage: vi.fn(() => null),
  dbSetMismatchCoverage: vi.fn(),
  dbPruneMismatchVersions: vi.fn(),
}));

const { registerMismatchRoutes, casesFromRows, parseMinuteCloses, planMismatchCleanup } =
  await import('./mismatchRoutes.ts');

const DATE = '2026-09-16';
const istMs = (hms: string) => {
  const [h, m, s = 0] = hms.split(':').map(Number);
  return Date.parse(`${DATE}T00:00:00Z`) - 19_800_000 + (h * 3600 + m * 60 + s) * 1000;
};
const tsNs = (hms: string) => String(BigInt(istMs(hms)) * 1_000_000n);

const CE = 'NIFTY2692223350CE';
const PE = 'NIFTY2692223150PE';

/** Broker 1m closes: NIFTY 23,226 only at 10:00, CE 120 and PE 110 all day (paise on the wire). */
function brokerResponse() {
  const minutes: string[] = [];
  for (let m = 9 * 60 + 15; m < 12 * 60; m++) {
    minutes.push(
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
    );
  }
  const series = (v: (hhmm: string) => number) => ({
    close: minutes.map((hhmm) => ({ ts: tsNs(hhmm), v: Math.round(v(hhmm) * 100) })),
  });
  return {
    result: [
      { values: [{ NIFTY: series((t) => (t === '10:00' ? 23226 : 23300)) }] },
      { values: [{ [CE]: series(() => 120) }] },
      { values: [{ [PE]: series(() => 110) }] },
    ],
  };
}

let app: ReturnType<typeof Fastify>;
let now = istMs('11:49:23');
let positions: Array<{
  ref_id: number;
  nubraName: string;
  qty: number;
  basket_group_id?: string;
  entry_time?: number;
}> = [];
let post: ((body: object) => Promise<Record<string, unknown>>) | null;
let rows: MismatchVersionRow[] = [];
let trackersRows: Array<{ basket_group_id: string; enabled: number }> = [];
const coverage = new Map<string, number>();
const broadcast = vi.fn();
let service: ReturnType<typeof registerMismatchRoutes>;

const store = {
  setTracker: vi.fn((gid: string, on: boolean) => {
    trackersRows = trackersRows.filter((t) => t.basket_group_id !== gid);
    trackersRows.push({ basket_group_id: gid, enabled: on ? 1 : 0 });
  }),
  listTrackers: () => trackersRows,
  insertVersion: vi.fn((row: MismatchVersionRow) => {
    rows.push(row);
  }),
  listVersions: (gid?: string) => rows.filter((r) => !gid || r.basket_group_id === gid),
  getCoverage: (gid: string) => coverage.get(gid) ?? null,
  setCoverage: (gid: string, ms: number) => {
    coverage.set(gid, Math.max(coverage.get(gid) ?? 0, ms));
  },
};

/** Most tests drive the toggle by hand; the auto-enable tests opt in. */
function build(autoEnable = false) {
  app = Fastify();
  service = registerMismatchRoutes({
    fastify: app,
    requireAuth: () => true,
    simBroker: { getPositions: () => positions },
    getTimeseriesPost: () => post,
    broadcast,
    store,
    nowMs: () => now,
    backfillEveryMs: null,
    autoEnable,
  });
}

async function rebuild(autoEnable: boolean) {
  service.stop();
  await app.close();
  build(autoEnable);
}

beforeEach(() => {
  now = istMs('11:49:23');
  positions = [
    {
      ref_id: 1,
      nubraName: CE,
      qty: -65,
      basket_group_id: 'bg_1',
      entry_time: istMs('09:15') * 1e6,
    },
    {
      ref_id: 2,
      nubraName: PE,
      qty: -65,
      basket_group_id: 'bg_1',
      entry_time: istMs('09:15') * 1e6,
    },
    { ref_id: 3, nubraName: 'NIFTY2692223400CE', qty: 65, basket_group_id: 'bg_2' },
  ];
  post = vi.fn(async () => brokerResponse());
  rows = [];
  trackersRows = [];
  coverage.clear();
  broadcast.mockReset();
  store.setTracker.mockClear();
  store.insertVersion.mockClear();
  build();
});

afterEach(async () => {
  service.stop();
  await app.close();
});

const chain = (spot: number, ce: number, pe: number) => ({
  asset: 'NIFTY',
  expiry: '20260922',
  exchange: 'NSE',
  currentprice: String(Math.round(spot * 100)),
  ce: [{ refId: 1, ltp: String(Math.round(ce * 100)) }],
  pe: [{ refId: 2, ltp: String(Math.round(pe * 100)) }],
});

test('parseMinuteCloses keeps each symbol apart, in rupees and IST minutes', () => {
  const closes = parseMinuteCloses(brokerResponse(), DATE);
  expect(closes.get('NIFTY')?.find((c) => c.minute === 600)?.close).toBe(23226);
  expect(closes.get(CE)?.[0]).toEqual({ minute: 555, close: 120 });
  expect(closes.get(PE)?.length).toBe(closes.get(CE)?.length);
});

test('enabling is refused for a strategy that is not one CE + one PE, or with no broker session', async () => {
  let res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_2', enabled: true },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error).toMatch(/one CE and one PE/);

  post = null;
  res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  expect(res.statusCode).toBe(503);
  expect(store.setTracker).not.toHaveBeenCalled();
});

test('nothing is tracked until enabled: ticks are ignored', async () => {
  service.onChain(chain(23226.5, 103.3, 116.25));
  expect(store.insertVersion).not.toHaveBeenCalled();
  const list = await app.inject({ method: 'GET', url: '/paper/mismatch/trackers' });
  expect(list.json().trackers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ basket_group_id: 'bg_1', enabled: false, eligible: true }),
      expect.objectContaining({ basket_group_id: 'bg_2', enabled: false, eligible: false }),
    ]),
  );
});

test('enabled: backfills closes, finds the live case, stores and broadcasts every version', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ enabled: true, tracking: true });
  await service.backfill();
  expect(post).toHaveBeenCalled();

  service.onChain(chain(23226.5, 103.3, 116.25));
  expect(store.insertVersion).toHaveBeenCalledTimes(1);
  expect(rows[0]).toMatchObject({ basket_group_id: 'bg_1', case_no: 1, color_idx: 0 });
  expect(broadcast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'mismatch_case',
      data: expect.objectContaining({ basket_group_id: 'bg_1' }),
    }),
  );

  // A wider gap seconds later: a second version of the same case.
  now = istMs('11:49:30');
  service.onChain(chain(23226.2, 100, 118));
  expect(rows.map((r) => r.case_no)).toEqual([1, 1]);

  const cases = await app.inject({
    method: 'GET',
    url: '/paper/mismatch/cases?basket_group_id=bg_1',
  });
  const [c] = cases.json().cases;
  expect(c.versions).toHaveLength(2);
  expect(c.versions[1].gap).toBeGreaterThan(c.versions[0].gap);
});

test('enabling well after entry still finds a match that happened before it was turned on', async () => {
  // Spot revisits its 09:20 close at 09:55 (35 min later); CE moves, PE doesn't — a real case.
  // Flat everywhere else so no other pair of minutes can accidentally qualify.
  const minutes: string[] = [];
  for (let m = 9 * 60 + 15; m < 12 * 60; m++) {
    minutes.push(
      `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`,
    );
  }
  const spotAt = (t: string) => (t === '09:20' ? 23226 : t === '09:55' ? 23226.3 : 23300);
  const ceAt = (t: string) => (t === '09:55' ? 100 : 120);
  const peAt = () => 110;
  const closes = (v: (hhmm: string) => number) => ({
    close: minutes.map((hhmm) => ({ ts: tsNs(hhmm), v: Math.round(v(hhmm) * 100) })),
  });
  const valueFnFor = (symbol: string) =>
    symbol === 'NIFTY' ? spotAt : symbol === CE ? ceAt : peAt;
  // `backfill` sends one combined 1m query (all three symbols); the replay's `fetchTodaySeconds`
  // sends one 1s query per symbol. Route each to the matching shape so both legs of the fix —
  // the reference-minute closes and the second-level replay — see the same underlying data.
  post = vi.fn(async (body: object) => {
    const query = (body as { query: Array<{ interval: string; values: string[] }> }).query;
    if (query.length === 1) {
      const symbol = query[0].values[0];
      return { result: [{ values: [{ [symbol]: closes(valueFnFor(symbol)) }] }] };
    }
    return {
      result: [
        { values: [{ NIFTY: closes(spotAt) }] },
        { values: [{ [CE]: closes(ceAt) }] },
        { values: [{ [PE]: closes(peAt) }] },
      ],
    };
  });

  // Both the 09:20 reference minute and the 09:55 match are well before this — no live tick
  // will ever revisit that pair, so only a backfill replay can surface it.
  now = istMs('10:30:00');
  const res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  expect(res.statusCode).toBe(200);
  await service.backfill();

  expect(store.insertVersion).toHaveBeenCalledTimes(1);
  expect(rows[0]).toMatchObject({ basket_group_id: 'bg_1', case_no: 1 });
  expect(rows[0].spot1).toBeCloseTo(23226, 1);
  expect(rows[0].spot2).toBeCloseTo(23226.3, 1);

  // Idempotent: re-running the catch-up (e.g. the periodic backfill) finds nothing new.
  await service.backfill();
  expect(store.insertVersion).toHaveBeenCalledTimes(1);
});

test('a feed for another expiry or underlying never moves a tracked strategy', async () => {
  await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  await service.backfill();
  service.onChain(chain(23226.5, 120, 110)); // learns the feed; no mismatch yet
  service.onChain({
    asset: 'BANKNIFTY',
    expiry: '20260929',
    exchange: 'NSE',
    currentprice: '5100000',
    ce: [],
    pe: [],
  });
  service.onChain({ ...chain(23226.5, 120, 110), ce: [], pe: [], currentprice: '2322650' });
  now = istMs('11:49:40');
  service.onChain({ ...chain(23226.5, 120, 110), ce: [{ refId: 1, ltp: '10000' }], pe: [] });
  // CE 120 → 100 with PE flat: a case, spot read from the NIFTY feed, not BANKNIFTY's 51,000.
  expect(rows).toHaveLength(1);
  expect(rows[0].spot2).toBeCloseTo(23226.5, 2);
});

test('a strategy that loses a leg stops tracking, and its cases stay readable', async () => {
  await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  await service.backfill();
  service.onChain(chain(23226.5, 103.3, 116.25));
  positions = positions.filter((p) => p.ref_id !== 2);
  service.sync();
  now = istMs('11:49:50');
  service.onChain(chain(23226.5, 90, 120));
  expect(rows).toHaveLength(1);
  const cases = await app.inject({
    method: 'GET',
    url: '/paper/mismatch/cases?basket_group_id=bg_1',
  });
  expect(cases.json().cases).toHaveLength(1);
});

test('enabled trackers and their cases survive a restart', async () => {
  await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  await service.backfill();
  service.onChain(chain(23226.5, 103.3, 116.25));
  service.stop();
  await app.close();

  build();
  await service.backfill();
  now = istMs('11:49:40');
  service.onChain(chain(23226.2, 100, 118));
  // Same case, second version: numbering carried over from the stored rows.
  expect(rows.map((r) => r.case_no)).toEqual([1, 1]);
});

test('after a restart the catch-up replay only fills time the live feed did not already score', async () => {
  await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: true },
  });
  await service.backfill();
  service.onChain(chain(23226.5, 103.3, 116.25)); // live case at 11:49:23
  expect(rows).toHaveLength(1);
  service.stop(); // flushes how far the live feed got
  await app.close();
  expect(coverage.get('bg_1')).toBe(now);

  // Per-second history for the restart: NIFTY back at 23,226.2 twice with the legs far apart —
  // once at 11:40 (already scored live, before the restart) and once at 11:55 (after it).
  const seconds = ['11:40:00', '11:55:00'];
  const series = (v: number) => ({
    close: seconds.map((hms) => ({ ts: tsNs(hms), v: v * 100 })),
  });
  post = vi.fn(async (body: object) => {
    const query = (body as { query: Array<{ values: string[] }> }).query;
    if (query.length > 1) return brokerResponse();
    const symbol = query[0].values[0];
    const v = symbol === 'NIFTY' ? 23226.2 : symbol === CE ? 90 : 125;
    return { result: [{ values: [{ [symbol]: series(v) }] }] };
  });
  now = istMs('11:56:00');
  build();
  await service.backfill();

  const t2s = rows.map((r) =>
    new Date(Number(r.t2_ns) / 1e6 + 19_800_000).toISOString().slice(11, 19),
  );
  expect(t2s).not.toContain('11:40:00');
  expect(t2s).toContain('11:55:00');
});

test('cleanup drops replayed duplicate cases and identical re-added readings, then renumbers', () => {
  const T = (hms: string) => istMs(hms) * 1_000_000;
  const row = (
    id: number,
    case_no: number,
    t1: string,
    t2: string,
    gap: number,
    insertedAt: string,
  ): MismatchVersionRow => ({
    id,
    basket_group_id: 'bg_1',
    case_no,
    color_idx: case_no - 1,
    t1_ns: T(t1),
    t2_ns: T(t2),
    spot1: 1,
    spot2: 1,
    ce1: 1,
    ce2: 1,
    pe1: 1,
    pe2: 1,
    ce_delta: 1,
    pe_delta: 1,
    gap,
    created_at: istMs(insertedAt),
  });
  const plan = planMismatchCleanup([
    row(1, 1, '09:47', '10:19:52', 299, '10:19:52'),
    row(2, 1, '09:49', '11:01:17', 689, '11:01:17'),
    row(3, 2, '11:57', '12:28:35', 705.25, '14:26:15'),
    row(4, 2, '11:57', '12:28:35', 705.25, '14:46:44'), // the same reading, re-added
    row(5, 3, '09:47', '10:19:51', 299, '14:26:15'), // replayed copy of case 1's start
    row(6, 4, '10:22', '12:19:55', 357.5, '14:26:15'), // replayed, but nothing like it exists
    row(7, 5, '14:00', '14:32:12', 429, '14:32:12'),
  ]);
  expect(plan.deleteIds).toEqual([4, 5]);
  expect(plan.renumber).toEqual([
    [1, 1],
    [2, 2],
    [4, 3],
    [5, 4],
  ]);
});

test('MCX: backfills the future the options are written on, and tracks in the evening', async () => {
  service.stop();
  await app.close();
  const FUT = 'FUT_CRUDEOIL_20260921';
  const PEc = 'OPT_CRUDEOIL_20260917_PE_860000';
  const CEc = 'OPT_CRUDEOIL_20260917_CE_880000';
  positions = [
    { ref_id: 11, nubraName: PEc, qty: -100, basket_group_id: 'bg_c', entry_time: 1 },
    { ref_id: 12, nubraName: CEc, qty: -100, basket_group_id: 'bg_c', entry_time: 1 },
  ];
  const queries: Array<Array<{ exchange: string; type: string; values: string[] }>> = [];
  post = vi.fn(async (body: object) => {
    queries.push((body as { query: (typeof queries)[number] }).query);
    const minutes = Array.from({ length: 60 }, (_, i) => 21 * 60 + i);
    const series = (v: number) => ({
      close: minutes.map((m) => ({
        ts: String(BigInt(istMs('00:00') + m * 60_000) * 1_000_000n),
        v: v * 100,
      })),
    });
    return {
      result: [
        { values: [{ [FUT]: series(9815) }] },
        { values: [{ [CEc]: series(120) }] },
        { values: [{ [PEc]: series(110) }] },
      ],
    };
  });
  const getMcxFuture = vi.fn(async () => FUT);
  now = istMs('22:40:00');
  app = Fastify();
  service = registerMismatchRoutes({
    fastify: app,
    requireAuth: () => true,
    simBroker: { getPositions: () => positions },
    getTimeseriesPost: () => post,
    broadcast,
    getMcxFuture,
    store,
    nowMs: () => now,
    backfillEveryMs: null,
    autoEnable: false,
  });
  const res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_c', enabled: true },
  });
  expect(res.statusCode).toBe(200);
  await service.backfill();
  expect(getMcxFuture).toHaveBeenCalledWith('CRUDEOIL', '20260917');
  // One query for the 1m backfill's reference closes, plus one 1s query per symbol for the
  // replay — all reading the future, not the option chain's own (nonexistent) spot.
  expect(queries.flat()).toContainEqual(
    expect.objectContaining({ exchange: 'MCX', type: 'FUT', values: [FUT] }),
  );

  service.onChain({
    asset: 'CRUDEOIL',
    expiry: '20260917',
    exchange: 'MCX',
    currentprice: '981550',
    ce: [{ refId: 12, ltp: '10000' }],
    pe: [{ refId: 11, ltp: '11800' }],
  });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]).toMatchObject({ basket_group_id: 'bg_c', spot2: 9815.5 });
});

test('auto-enable: every eligible strategy is tracked without a click, and finds cases', async () => {
  await rebuild(true);
  expect(store.setTracker).toHaveBeenCalledWith('bg_1', true);
  expect(store.setTracker).not.toHaveBeenCalledWith('bg_2', true);
  const list = await app.inject({ method: 'GET', url: '/paper/mismatch/trackers' });
  expect(list.json().trackers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ basket_group_id: 'bg_1', enabled: true, tracking: true }),
      expect.objectContaining({ basket_group_id: 'bg_2', enabled: false }),
    ]),
  );
  await service.backfill();
  service.onChain(chain(23226.5, 103.3, 116.25));
  expect(rows[0]).toMatchObject({ basket_group_id: 'bg_1', case_no: 1 });
});

test('auto-enable: a manual off sticks, across syncs and restarts', async () => {
  await rebuild(true);
  await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_1', enabled: false },
  });
  service.sync();
  await rebuild(true);
  const list = await app.inject({ method: 'GET', url: '/paper/mismatch/trackers' });
  expect(list.json().trackers).toContainEqual(
    expect.objectContaining({ basket_group_id: 'bg_1', enabled: false, tracking: false }),
  );
});

test('auto-enable: waits for a broker session, and for the second leg to fill', async () => {
  post = null;
  positions = positions.filter((p) => p.ref_id !== 2);
  await rebuild(true);
  service.sync();
  expect(store.setTracker).not.toHaveBeenCalled();

  post = vi.fn(async () => brokerResponse());
  service.sync();
  expect(store.setTracker).not.toHaveBeenCalled(); // bg_1 is still CE only

  positions.push({ ref_id: 2, nubraName: PE, qty: -65, basket_group_id: 'bg_1', entry_time: 1 });
  service.sync();
  expect(store.setTracker).toHaveBeenCalledWith('bg_1', true);
});

test('casesFromRows groups versions by case, oldest first', () => {
  const row = (case_no: number, t2: number, gap: number): MismatchVersionRow => ({
    basket_group_id: 'bg_1',
    case_no,
    color_idx: case_no - 1,
    t1_ns: 1,
    t2_ns: t2,
    spot1: 1,
    spot2: 1,
    ce1: 1,
    ce2: 1,
    pe1: 1,
    pe2: 1,
    ce_delta: 1,
    pe_delta: 1,
    gap,
  });
  const cases = casesFromRows([row(1, 10, 5), row(2, 11, 3), row(1, 12, 9)]);
  expect(cases.map((c) => [c.caseNo, c.versions.map((v) => v.gap)])).toEqual([
    [1, [5, 9]],
    [2, [3]],
  ]);
});
