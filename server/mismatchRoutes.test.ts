import Fastify from 'fastify';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MismatchVersionRow } from './paperDb.ts';

vi.mock('./paperDb.ts', () => ({
  dbInsertMismatchVersion: vi.fn(),
  dbListMismatchTrackers: vi.fn(() => []),
  dbListMismatchVersions: vi.fn(() => []),
  dbSetMismatchTracker: vi.fn(),
}));

const { registerMismatchRoutes, casesFromRows, parseMinuteCloses } =
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
};

function build() {
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
  });
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
  });
  const res = await app.inject({
    method: 'POST',
    url: '/paper/mismatch/trackers',
    payload: { basket_group_id: 'bg_c', enabled: true },
  });
  expect(res.statusCode).toBe(200);
  await service.backfill();
  expect(getMcxFuture).toHaveBeenCalledWith('CRUDEOIL', '20260917');
  expect(queries.at(-1)?.[0]).toMatchObject({ exchange: 'MCX', type: 'FUT', values: [FUT] });

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
