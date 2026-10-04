import Fastify from 'fastify';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SESSION_BARS, createDayStore, emptyGrid, type DayStore } from '../analysis/daySeries.ts';
import { parseTradeParams, registerSignalBacktestRoutes } from './routes.ts';
import { createWideStore } from './wideSource.ts';

let app: ReturnType<typeof Fastify>;
let dir: string;
let store: DayStore;

/** Spot flat at 23250; the reference CE decays so every day signals at 09:45. */
function day(date: string, source: 'nubra' | 'local') {
  const spot = emptyGrid();
  const ce = emptyGrid();
  const pe = emptyGrid();
  for (let i = 0; i < SESSION_BARS; i++) {
    spot[i] = 23250;
    ce[i] = 200 - i * 0.1;
    pe[i] = 50;
  }
  return {
    v: 1 as const,
    underlying: 'NIFTY',
    date,
    source,
    expiry: '2026-01-06',
    monthly: false,
    spot,
    // 23350 serves as both the reference CE (ATM + 2) and the traded OTM-2 CE.
    ce: { '23350': source === 'nubra' ? ce : ce.map((v) => (v == null ? v : v + 1)) },
    pe: { '23150': pe },
  };
}

async function run(payload: Record<string, unknown>) {
  const res = await app.inject({ method: 'POST', url: '/api/signal-backtest/run', payload });
  return { status: res.statusCode, body: res.json() };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'signal-backtest-'));
  store = createDayStore(dir);
  app = Fastify();
  registerSignalBacktestRoutes({ fastify: app, rootDir: dir, store, loadOhlc: async () => null });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('POST /api/signal-backtest/run', () => {
  test('one trade per day, entered a minute after the first case', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { status, body } = await run({
      underlying: 'NIFTY',
      tradeParams: { legs: 'CE', side: 'SELL', otmSteps: 2 },
      includeLocalOnly: false,
    });
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(1);
    const row = body.rows[0];
    expect(row).toMatchObject({ date: '2026-01-05', source: 'nubra' });
    expect(row.signal).toMatchObject({ t1: '09:15', t2: '09:45' });
    expect(row.signal.t2Index).toBeUndefined();
    expect(row.trade).toMatchObject({ entryTime: '09:46', atm: 23250, qty: 65 });
    expect(row.trade.legs[0]).toMatchObject({ strike: 23350, entryPrice: 196.9 });
    expect(body.summary).toMatchObject({ daysScanned: 1, daysWithSignal: 1, trades: 1 });
  });

  test('Nubra wins over local for the same date; local-only days follow the flag', async () => {
    for (const [date, source] of [
      ['2026-01-05', 'nubra'],
      ['2026-01-05', 'local'],
      ['2025-01-06', 'local'],
    ] as const) {
      await store.write(day(date, source));
    }
    const without = await run({ tradeParams: { legs: 'CE' }, includeLocalOnly: false });
    expect(
      without.body.rows.map((r: { date: string; source: string }) => [r.date, r.source]),
    ).toEqual([['2026-01-05', 'nubra']]);
    const withLocal = await run({ tradeParams: { legs: 'CE' }, includeLocalOnly: true });
    expect(
      withLocal.body.rows.map((r: { date: string; source: string }) => [r.date, r.source]),
    ).toEqual([
      ['2025-01-06', 'local'],
      ['2026-01-05', 'nubra'],
    ]);
  });

  test('the date range is inclusive', async () => {
    for (const date of ['2026-01-05', '2026-01-06', '2026-01-07']) {
      await store.write(day(date, 'nubra'));
    }
    const { body } = await run({ from: '2026-01-06', to: '2026-01-07', includeLocalOnly: false });
    expect(body.summary.daysScanned).toBe(2);
  });

  test('days without a trade are listed with their reason', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { body } = await run({ tradeParams: { otmSteps: 4 }, includeLocalOnly: false });
    expect(body.rows).toHaveLength(0);
    expect(body.skipped).toEqual([
      { date: '2026-01-05', source: 'nubra', reason: 'no data for 23450 CE' },
    ]);
    // The signal fired even though the trade could not be placed.
    expect(body.summary.daysWithSignal).toBe(1);
  });

  test('high/low data is only read when asked for', async () => {
    await app.close();
    const calls: string[] = [];
    app = Fastify();
    registerSignalBacktestRoutes({
      fastify: app,
      rootDir: dir,
      store,
      loadOhlc: async (_u, date) => {
        calls.push(date);
        return null;
      },
    });
    await app.ready();
    await store.write(day('2026-01-05', 'nubra'));
    const off = await run({ includeLocalOnly: false, useHighLow: false });
    expect(off.body).toMatchObject({ useHighLow: false });
    expect(calls).toEqual([]);
    const on = await run({ includeLocalOnly: false });
    expect(on.body).toMatchObject({ useHighLow: true });
    expect(calls).toEqual(['2026-01-05']);
  });

  test('bad parameters are a 400', async () => {
    expect((await run({ underlying: 'BANKNIFTY' })).status).toBe(400);
    expect((await run({ signalParams: { closeTolerance: -1 } })).status).toBe(400);
    expect((await run({ tradeParams: { otmSteps: 11 } })).status).toBe(400);
  });

  test('each row says how many trading days it is from expiry', async () => {
    // Expiry is Tuesday 2026-01-06: Monday is 1 trading day out and the Friday before it 2 (the
    // weekend does not count).
    for (const date of ['2026-01-02', '2026-01-05', '2026-01-06']) {
      await store.write(day(date, 'nubra'));
    }
    const { body } = await run({ includeLocalOnly: false, tradeParams: { legs: 'CE' } });
    expect(body.rows.map((r: { date: string; dte: number }) => [r.date, r.dte])).toEqual([
      ['2026-01-02', 2],
      ['2026-01-05', 1],
      ['2026-01-06', 0],
    ]);
  });

  test('days to expiry count along every day held, not only the From / To range', async () => {
    for (const date of ['2026-01-02', '2026-01-05', '2026-01-06']) {
      await store.write(day(date, 'nubra'));
    }
    // The range leaves out Jan 5, yet Jan 2 is still 2 trading days out, not 1.
    const { body } = await run({
      includeLocalOnly: false,
      tradeParams: { legs: 'CE' },
      from: '2026-01-02',
      to: '2026-01-02',
    });
    expect(body.rows.map((r: { dte: number }) => r.dte)).toEqual([2]);
  });

  test('each signal carries the reference legs’ greeks at t1 and t2', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { body } = await run({ includeLocalOnly: false, tradeParams: { legs: 'CE' } });
    const { greeks } = body.rows[0].signal;
    for (const moment of [greeks.t1, greeks.t2]) {
      expect(moment.CE).toMatchObject({ delta: expect.any(Number), iv: expect.any(Number) });
      expect(moment.PE).toMatchObject({ gamma: expect.any(Number), vega: expect.any(Number) });
      expect(moment.CE.delta).toBeGreaterThan(0);
      expect(moment.PE.delta).toBeLessThan(0);
    }
    // The reference CE only decays across the 30 minutes, so its vol is lower at t2.
    expect(greeks.t2.CE.iv).toBeLessThan(greeks.t1.CE.iv);
  });
});

describe('GET /api/signal-backtest/day', () => {
  const get = (query: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: `/api/signal-backtest/day?${new URLSearchParams(query).toString()}`,
    });
  const ok = {
    underlying: 'NIFTY',
    date: '2026-01-05',
    source: 'nubra',
    ceStrike: '23350',
    peStrike: '23150',
  };

  test('returns the session’s spot, reference closes and greek series', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const res = await get(ok);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      ok: true,
      expiry: '2026-01-06',
      ceStrike: 23350,
      peStrike: 23150,
    });
    expect(body.spot).toHaveLength(SESSION_BARS);
    expect(body.ce[0]).toBe(200);
    expect(body.pe[0]).toBe(50);
    expect(body.greeks.CE.delta).toHaveLength(SESSION_BARS);
    expect(body.greeks.CE.delta[30]).toBeGreaterThan(0);
    expect(body.greeks.PE.delta[30]).toBeLessThan(0);
  });

  test('matches the greeks the run reports for the same minute', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { body: run1 } = await run({ includeLocalOnly: false, tradeParams: { legs: 'CE' } });
    const t2 = run1.rows[0].signal.greeks.t2.CE;
    const idx = 30; // the fixture signals at 09:45
    const series = (await get(ok)).json().greeks.CE;
    expect(series.delta[idx]).toBe(t2.delta);
    expect(series.iv[idx]).toBe(t2.iv);
  });

  test('returns the closes of the traded legs, null for a strike nothing holds', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const good = (await get({ ...ok, legs: 'CE:23350,PE:23150' })).json();
    expect(good.legs).toHaveLength(2);
    expect(good.legs[0]).toMatchObject({ kind: 'CE', strike: 23350 });
    expect(good.legs[0].close).toHaveLength(SESSION_BARS);
    expect(good.legs[0].close[10]).toBeCloseTo(199, 5); // 200 - 10 * 0.1
    expect(good.legs[1].close[10]).toBe(50);
    const missing = (await get({ ...ok, legs: 'CE:23500' })).json();
    expect(missing.legs).toEqual([{ kind: 'CE', strike: 23500, close: null }]);
    // Without `legs` the response simply has none.
    expect((await get(ok)).json().legs).toEqual([]);
  });

  test('a strike beyond the ladder is found in the row’s wide Nubra data', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const flat = (v: number) => emptyGrid().map(() => v);
    await createWideStore(path.join(dir, '.signal-cache')).write({
      v: 1,
      underlying: 'NIFTY',
      date: '2026-01-05',
      expiry: '2026-01-06',
      monthly: false,
      ce: { '23600': { o: flat(10), h: flat(14), l: flat(8), c: flat(12) } },
      pe: {},
    });
    const without = (await get({ ...ok, legs: 'CE:23600' })).json();
    expect(without.legs[0].close).toBeNull();
    const withWide = (await get({ ...ok, legs: 'CE:23600', ohlc: 'nubra-wide' })).json();
    expect(withWide.legs[0].close[0]).toBe(12);
    expect(withWide.legs[0].close).toHaveLength(SESSION_BARS);
  });

  test('bad legs or price source are a 400', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    expect((await get({ ...ok, legs: 'CE:abc' })).statusCode).toBe(400);
    expect((await get({ ...ok, legs: 'CE:23350,CE:23400' })).statusCode).toBe(400);
    expect((await get({ ...ok, legs: 'XX:23350' })).statusCode).toBe(400);
    expect((await get({ ...ok, legs: 'CE:23350,' })).statusCode).toBe(400);
    expect((await get({ ...ok, ohlc: 'broker' })).statusCode).toBe(400);
  });

  test('bad input is a 400, a missing day or strike a 404', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    expect((await get({ ...ok, underlying: 'BANKNIFTY' })).statusCode).toBe(400);
    expect((await get({ ...ok, date: '05-01-2026' })).statusCode).toBe(400);
    expect((await get({ ...ok, source: 'both' })).statusCode).toBe(400);
    expect((await get({ ...ok, ceStrike: 'abc' })).statusCode).toBe(400);
    expect((await get({ ...ok, date: '2026-01-06' })).statusCode).toBe(404);
    expect((await get({ ...ok, source: 'local' })).statusCode).toBe(404);
    expect((await get({ ...ok, ceStrike: '23400' })).statusCode).toBe(404);
  });
});

describe('wide Nubra data', () => {
  test('a stored wide day supplies high/low and far strikes for that Nubra day', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const flat = (v: number) => emptyGrid().map(() => v);
    await createWideStore(path.join(dir, '.signal-cache')).write({
      v: 1,
      underlying: 'NIFTY',
      date: '2026-01-05',
      expiry: '2026-01-06',
      monthly: false,
      ce: { '23600': { o: flat(10), h: flat(14), l: flat(8), c: flat(12) } },
      pe: {},
    });
    const { body } = await run({
      includeLocalOnly: false,
      tradeParams: { legs: 'CE', strikeMode: 'PREMIUM', cePremiumMin: 10, cePremiumMax: 12 },
    });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].ohlcSource).toBe('nubra-wide');
    expect(body.rows[0].trade.legs[0]).toMatchObject({
      strike: 23600,
      entryPrice: 11,
      basis: 'ohlc',
    });
  });

  test('status counts coverage; a download needs a broker session', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const status = await app.inject({ method: 'GET', url: '/api/signal-backtest/wide/status' });
    expect(status.json()).toMatchObject({ nubraDays: 1, wideDays: 0, brokerSession: false });
    const sync = await app.inject({
      method: 'POST',
      url: '/api/signal-backtest/wide/sync',
      payload: { underlying: 'NIFTY' },
    });
    expect(sync.statusCode).toBe(409);
  });
});

describe('parseTradeParams', () => {
  test('merges over the defaults', () => {
    expect(parseTradeParams({ side: 'BUY' })).toMatchObject({
      side: 'BUY',
      legs: 'BOTH',
      otmSteps: 2,
      delayMinutes: 1,
      lots: 1,
      exitTime: '15:29',
    });
  });

  test('rejects out-of-range and malformed values', () => {
    expect(typeof parseTradeParams({ legs: 'XX' })).toBe('string');
    expect(typeof parseTradeParams({ lots: 0 })).toBe('string');
    expect(typeof parseTradeParams({ delayMinutes: 1.5 })).toBe('string');
    expect(typeof parseTradeParams({ exitTime: '16:00' })).toBe('string');
    expect(typeof parseTradeParams({ strikeMode: 'DELTA' })).toBe('string');
    expect(typeof parseTradeParams({ cePremiumMin: 60, cePremiumMax: 40 })).toBe('string');
  });

  test('OTM steps by distance from expiry: none by default, numbers kept, nulls dropped', () => {
    expect(parseTradeParams({})).toMatchObject({ otmStepsByDte: {} });
    expect(parseTradeParams({ otmStepsByDte: { '0': 3, '1': 3, '4': null } })).toMatchObject({
      otmStepsByDte: { '0': 3, '1': 3 },
    });
    expect(parseTradeParams({ otmStepsByDte: { '2': '1' } })).toMatchObject({
      otmStepsByDte: { '2': 1 },
    });
  });

  test('OTM steps by distance reject what cannot be one', () => {
    expect(typeof parseTradeParams({ otmStepsByDte: [1, 2] })).toBe('string'); // a list, not a map
    expect(typeof parseTradeParams({ otmStepsByDte: { '1': 11 } })).toBe('string');
    expect(typeof parseTradeParams({ otmStepsByDte: { '1': 1.5 } })).toBe('string');
    expect(typeof parseTradeParams({ otmStepsByDte: { mon: 2 } })).toBe('string');
    expect(typeof parseTradeParams({ otmStepsByDte: { '-1': 2 } })).toBe('string');
    expect(typeof parseTradeParams({ otmStepsByDte: null })).toBe('string');
  });
});

describe('premium sets and premium ranges by distance from expiry', () => {
  test('the run carries premium sets built from the same days and entry minute', async () => {
    await store.write(day('2026-01-05', 'nubra')); // a Monday, the day before the Tuesday expiry
    const { body } = await run({ includeLocalOnly: false });
    const { expiryDays } = body.premiumSets;
    expect(expiryDays).toHaveLength(1);
    expect(expiryDays[0]).toMatchObject({ dte: 1, days: 1 });
    // Entry 09:46: the OTM 2 call is ₹196.90, the OTM 2 put ₹50 — each the only strike on its side.
    expect(expiryDays[0].CE[0].median).toBe(196.9);
    expect(expiryDays[0].PE[0].median).toBe(50);
  });

  test('days at the same distance from expiry pool, whatever their weekday', async () => {
    // Mon 5th and Fri 2nd are different weekdays but, for one Tuesday expiry, 1 and 2 days out.
    for (const date of ['2026-01-02', '2026-01-05', '2026-01-06']) {
      await store.write(day(date, 'nubra'));
    }
    const { body } = await run({ includeLocalOnly: false });
    expect(body.premiumSets.expiryDays.map((d: { dte: number }) => d.dte)).toEqual([0, 1, 2]);
    expect(body.premiumSets.expiryDays.map((d: { days: number }) => d.days)).toEqual([1, 1, 1]);
  });

  test('the sets are built even on a day whose trade could not be placed', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { body } = await run({ tradeParams: { otmSteps: 4 }, includeLocalOnly: false });
    expect(body.rows).toHaveLength(0); // no 23450 CE in the fixture
    expect(body.premiumSets.expiryDays[0]).toMatchObject({ dte: 1, days: 1 });
  });

  test('a distance’s premium range decides which strike that distance sells', async () => {
    await store.write(day('2026-01-05', 'nubra')); // 1 day before expiry
    const global = { strikeMode: 'PREMIUM', legs: 'CE', cePremiumMin: 1, cePremiumMax: 2 };
    const without = await run({ tradeParams: global, includeLocalOnly: false });
    expect(without.body.rows).toHaveLength(0);
    expect(without.body.skipped[0].reason).toMatch(/no CE strike priced ₹1–2/);

    const withDayBefore = await run({
      tradeParams: { ...global, cePremiumByDte: { '1': [190, 200] } },
      includeLocalOnly: false,
    });
    expect(withDayBefore.body.rows).toHaveLength(1);
    expect(withDayBefore.body.rows[0].trade.legs[0]).toMatchObject({ strike: 23350 });
    expect(withDayBefore.body.tradeParams.cePremiumByDte['1']).toEqual([190, 200]);

    // A range chosen for another distance changes nothing here.
    const elsewhere = await run({
      tradeParams: { ...global, cePremiumByDte: { '3': [190, 200] } },
      includeLocalOnly: false,
    });
    expect(elsewhere.body.rows).toHaveLength(0);
  });

  test('an OTM override for the day’s distance changes the strike', async () => {
    await store.write(day('2026-01-05', 'nubra')); // 1 day before expiry
    const base = { legs: 'CE', otmSteps: 4 }; // 23450 is not in the fixture
    const plain = await run({ tradeParams: base, includeLocalOnly: false });
    expect(plain.body.rows).toHaveLength(0);
    const overridden = await run({
      tradeParams: { ...base, otmStepsByDte: { '1': 2 } },
      includeLocalOnly: false,
    });
    expect(overridden.body.rows[0].trade).toMatchObject({ otmSteps: 2 });
    expect(overridden.body.rows[0].trade.legs[0]).toMatchObject({ strike: 23350 });
  });
});

describe('parseTradeParams: premium ranges by distance from expiry', () => {
  test('default to no override at any distance', () => {
    expect(parseTradeParams({})).toMatchObject({ cePremiumByDte: {}, pePremiumByDte: {} });
  });

  test('keep valid ranges as numbers and drop blanks', () => {
    expect(
      parseTradeParams({ pePremiumByDte: { '0': ['9.5', 15], '1': null, '2': [20, 20] } }),
    ).toMatchObject({ pePremiumByDte: { '0': [9.5, 15], '2': [20, 20] } });
  });

  test('reject a range that cannot be one, or a list where a map belongs', () => {
    expect(typeof parseTradeParams({ cePremiumByDte: [[1, 2]] })).toBe('string');
    expect(typeof parseTradeParams({ cePremiumByDte: { '0': [5, 1] } })).toBe('string');
    expect(typeof parseTradeParams({ cePremiumByDte: { '0': [-1, 4] } })).toBe('string');
    expect(typeof parseTradeParams({ cePremiumByDte: { '0': ['x', 4] } })).toBe('string');
    expect(typeof parseTradeParams({ pePremiumByDte: { '0': 7 } })).toBe('string');
    expect(typeof parseTradeParams({ pePremiumByDte: { tue: [1, 2] } })).toBe('string');
  });
});

describe('premium mode that trades only the distances with a chosen range', () => {
  const dataOnly = { strikeMode: 'PREMIUM', legs: 'CE', premiumTiersOnly: true };

  test('with nothing chosen no day trades, the reason says why, and the sets are still built', async () => {
    await store.write(day('2026-01-05', 'nubra')); // 1 day before expiry
    const { body } = await run({ tradeParams: dataOnly, includeLocalOnly: false });
    expect(body.rows).toHaveLength(0);
    expect(body.skipped[0].reason).toBe('no CE premium range chosen for 1 day before expiry');
    // This is the first run of the flow: it has to produce the tiers the user then picks from.
    expect(body.premiumSets.expiryDays[0].CE[0].median).toBe(196.9);
  });

  test('picking a tier for that distance makes it trade', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const { body } = await run({
      tradeParams: { ...dataOnly, cePremiumByDte: { '1': [190, 200] } },
      includeLocalOnly: false,
    });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].trade.legs[0]).toMatchObject({ strike: 23350 });
  });

  test('the flag defaults off for the API and must be a boolean', () => {
    expect(parseTradeParams({})).toMatchObject({ premiumTiersOnly: false });
    expect(parseTradeParams({ premiumTiersOnly: true })).toMatchObject({
      premiumTiersOnly: true,
    });
    expect(typeof parseTradeParams({ premiumTiersOnly: 'yes' })).toBe('string');
  });
});
