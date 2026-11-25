import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { blackScholes, RISK_FREE } from '../../src/lib/GexService.ts';
import {
  OPENING_STRANGLE_API,
  openingPnlAfterCost,
  openingPnlInUnit,
  openingSummaryAfterCost,
  type OpeningDates,
  type OpeningDay,
  type OpeningDayMetadata,
  type OpeningStudy,
} from '../../src/lib/openingStrangle.ts';
import { registerAnalysisRoutes } from './routes.ts';
import { emptyGrid, SESSION_BARS, type DaySeries, type DayStore } from './daySeries.ts';
import { openingYearsToExpiry, replayOpeningStrangle } from './openingStrangle.ts';

const CE = '23350';
const PE = '23150';
const EXPIRY = '2026-01-06';
const CLOSE = SESSION_BARS - 1;

function day(date = EXPIRY, source: 'nubra' | 'local' = 'nubra'): DaySeries {
  return {
    v: 1,
    underlying: 'NIFTY',
    date,
    source,
    expiry: EXPIRY,
    monthly: false,
    spot: emptyGrid().fill(23250),
    ce: { [CE]: emptyGrid().fill(25) },
    pe: { [PE]: emptyGrid().fill(20) },
  };
}

function metadata(d: DaySeries): OpeningDayMetadata {
  return {
    date: d.date,
    source: d.source,
    expiry: d.expiry,
    monthly: d.monthly,
    dte: 0,
    dteGroup: '0',
  };
}

const replay = (d: DaySeries) => replayOpeningStrangle(d, metadata(d), 'NIFTY', { detail: true });

describe('opening strangle replay', () => {
  test('marks the original strikes after spot moves, with the short sign and exact close coverage', () => {
    const d = day();
    d.spot[1] = 23400;
    d.ce['23500'] = emptyGrid().fill(5);
    d.ce[CE][1] = 35;
    d.pe[PE][1] = 12;
    d.pe[PE][2] = null;
    d.pe[PE][CLOSE] = null;
    const result = replay(d) as OpeningDay;
    expect(result.summary).toMatchObject({
      ceStrike: 23350,
      peStrike: 23150,
      entry: 0,
      touch: 'Call',
      entryCredit: 2925,
    });
    expect(result.pnl.slice(0, 3)).toEqual([0, -130, null]);
    expect(result.cePnl[1]).toBe(-650);
    expect(result.pePnl[1]).toBe(520);
    expect(result.summary.close).toBeNull();
    expect(result.summary.lastMarked).toBe(CLOSE - 1);
    expect(result.summary.drawdown).toBe(130);
    expect(result.pnl).toHaveLength(375);
    const net = openingSummaryAfterCost(result.summary, 50);
    expect(net.close).toBeNull();
    expect(net.best).toEqual({ minute: result.summary.best.minute, pnl: -50 });
    expect(net.worst).toEqual({ minute: result.summary.worst.minute, pnl: -180 });
    expect(net.drawdown).toBe(130);
    expect(net.entryCredit).toBe(2925);
    expect(result.pnl.slice(0, 3).map((mark) => openingPnlAfterCost(mark, 50))).toEqual([
      -50,
      -180,
      null,
    ]);
  });

  test('shows the actual fallback entry and can exclude it', () => {
    const d = day();
    d.ce[CE][0] = null;
    const result = replay(d) as OpeningDay;
    expect(result.summary.entry).toBe(1);
    expect(result.pnl.slice(0, 2)).toEqual([null, 0]);
    expect(replayOpeningStrangle(d, metadata(d), 'NIFTY', { onTimeOnly: true })).toMatch(
      /09:15 prices unavailable/,
    );
    d.ce[CE].fill(null, 2);
    expect(replay(d)).toMatch(/No minute after entry/);
  });

  test('uses a later complete strike pair when the opening strikes are unavailable', () => {
    const d = day();
    delete d.ce[CE];
    d.spot.fill(23300, 1);
    d.ce['23400'] = emptyGrid().fill(25);
    d.pe['23200'] = emptyGrid().fill(20);
    const result = replay(d) as OpeningDay;
    expect(result.summary).toMatchObject({ entry: 1, ceStrike: 23400, peStrike: 23200 });
    expect(result.pnl.slice(0, 2)).toEqual([null, 0]);
    expect(replayOpeningStrangle(d, metadata(d), 'NIFTY', { onTimeOnly: true })).toBe(
      '09:15 prices unavailable (first entry 09:16)',
    );
  });

  test('reprices to one minute before expiry and reconciles all model components', () => {
    const d = day();
    const sigma = 0.26;
    for (let i = 0; i < SESSION_BARS; i++) {
      const t = openingYearsToExpiry(d.date, d.expiry, i);
      const forward = 23250 + (40 * i) / CLOSE;
      d.spot[i] = forward;
      d.ce[CE][i] = blackScholes(forward, Number(CE), t, RISK_FREE, sigma, 'CE').price;
      d.pe[PE][i] = blackScholes(forward, Number(PE), t, RISK_FREE, sigma, 'PE').price;
    }
    const result = replay(d) as OpeningDay;
    const model = result.attribution[120]!;
    expect(openingYearsToExpiry(d.date, d.expiry, CLOSE) * 365 * 24 * 60).toBeCloseTo(1);
    expect(result.ceIv[120]).toBeCloseTo(26, 2);
    expect(model.forward).not.toBe(0);
    expect(model.time).toBeGreaterThan(0);
    expect(model.iv).toBeCloseTo(0, 1);
    expect(model.forward + model.time + model.iv + model.residual).toBeCloseTo(result.pnl[120]!, 8);
    d.pe[PE][120] = 0;
    const unpriceable = replay(d) as OpeningDay;
    expect(unpriceable.pnl[120]).not.toBeNull();
    expect(unpriceable.attribution[120]).toBeNull();
  });
});

test('opening routes keep the full DTE calendar, Nubra precedence, and exact close samples', async () => {
  const fri = day('2026-01-02');
  const mon = day('2026-01-05', 'local');
  const tue = day();
  tue.ce[CE][CLOSE] = null;
  mon.ce[CE][CLOSE] = 21;
  const bySource = {
    nubra: [fri, tue],
    local: [day(fri.date, 'local'), mon],
  };
  const store: DayStore = {
    read: async (_, source, date) => bySource[source].find((d) => d.date === date) ?? null,
    list: async (_, source) => bySource[source].map((d) => d.date),
    listDetailed: async (_, source) =>
      bySource[source].map((d) => ({ date: d.date, empty: false })),
    write: async () => {
      throw new Error('unexpected write');
    },
    dir: () => 'test-no-validation-file',
  };
  const app = Fastify();
  registerAnalysisRoutes({
    fastify: app,
    rootDir: 'test-no-validation-file',
    store,
    getPost: () => {
      throw new Error('unexpected broker call');
    },
  });
  try {
    const dates = await app.inject(`${OPENING_STRANGLE_API}/dates`);
    expect(dates.json<OpeningDates>().includeLocalOnly).toBe(true);
    expect(dates.json<OpeningDates>().dates).toEqual([
      { date: fri.date, source: 'nubra' },
      { date: mon.date, source: 'local' },
      { date: tue.date, source: 'nubra' },
    ]);
    const nubraOnly = await app.inject(`${OPENING_STRANGLE_API}/dates?includeLocalOnly=false`);
    expect(nubraOnly.json<OpeningDates>().dates.map(({ date }) => date)).toEqual([
      fri.date,
      tue.date,
    ]);
    const detail = await app.inject(
      `${OPENING_STRANGLE_API}/day?date=${fri.date}&includeLocalOnly=true`,
    );
    expect(detail.json<OpeningDay>().summary.dte).toBe(2);
    const nubraDetail = await app.inject(
      `${OPENING_STRANGLE_API}/day?date=${fri.date}&includeLocalOnly=false`,
    );
    expect(nubraDetail.statusCode).toBe(200);
    expect(nubraDetail.json<OpeningDay>().summary).toMatchObject({
      source: 'nubra',
      dte: 2,
      dteGroup: '2',
    });
    const excludedDetail = await app.inject(
      `${OPENING_STRANGLE_API}/day?date=${mon.date}&includeLocalOnly=false`,
    );
    expect(excludedDetail.statusCode).toBe(404);
    const nubraStudy = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { includeLocalOnly: false, includeResearch: true, to: mon.date },
    });
    expect(nubraStudy.statusCode).toBe(200);
    const nubraResult = nubraStudy.json<OpeningStudy>();
    expect(nubraResult.days).toMatchObject([
      { date: fri.date, source: 'nubra', dte: 2, dteGroup: '2' },
    ]);
    expect(nubraResult.groups[2]).toMatchObject({ dte: '2', dates: [fri.date] });
    expect(nubraResult.research?.rows).toMatchObject([{ date: fri.date, features: { dte: 2 } }]);
    const windowed = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: {
        includeLocalOnly: true,
        from: fri.date,
        to: fri.date,
        driver: 'entryCredit',
        dte: '2',
        unit: 'rupees',
      },
    });
    expect(windowed.statusCode).toBe(200);
    const result = windowed.json<OpeningStudy>();
    expect(result).not.toHaveProperty('research');
    expect(result.days[0].dte).toBe(2);
    expect(result.days[0]).not.toHaveProperty('pnl');
    expect(result.driver?.groups.map(({ n }) => n)).toEqual([1, 0, 0]);
    expect(result.groups[2].curve[CLOSE]).toEqual({ n: 1, p10: 0, median: 0, p90: 0 });
    const full = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { includeLocalOnly: true, unit: 'rupees' },
    });
    const expiry = full.json<OpeningStudy>().groups[0];
    expect(full.json<OpeningStudy>().roundTripCost).toBe(0);
    expect(expiry).toMatchObject({ n: 1, closeN: 0, medianClose: null, profitableClosePct: null });
    expect(expiry.curve[CLOSE]).toMatchObject({ n: 0, median: null });
    expect(expiry.attribution.at(-1)).toMatchObject({ n: 0, observed: 0 });
    expect(full.json<OpeningStudy>().groups[1]).toMatchObject({
      closeN: 1,
      medianClose: 260,
      profitableClosePct: 100,
    });
    const netPayload = {
      roundTripCost: 300,
      includeResearch: true,
      driver: 'entryCredit',
      dte: '1',
    };
    const net = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { ...netPayload, unit: 'rupees' },
    });
    expect(net.statusCode).toBe(200);
    const netStudy = net.json<OpeningStudy>();
    expect(netStudy.roundTripCost).toBe(300);
    expect(netStudy.days).toEqual(full.json<OpeningStudy>().days);
    expect(netStudy.research?.rows[1].pnl[0]).toBe(0);
    expect(netStudy.research?.rows[1].pnl[CLOSE]).toBe(260);
    expect(netStudy.research?.rows[2].pnl[CLOSE]).toBeNull();
    const netExpiry = netStudy.groups[1];
    expect(netExpiry).toMatchObject({
      closeN: 1,
      medianClose: -40,
      p10Close: -40,
      profitableClosePct: 0,
      medianDrawdown: full.json<OpeningStudy>().groups[1].medianDrawdown,
      attribution: full.json<OpeningStudy>().groups[1].attribution,
    });
    expect(netExpiry.curve[0]).toEqual({ n: 1, median: -300, p10: -300, p90: -300 });
    expect(netExpiry.curve[CLOSE]).toEqual({ n: 1, median: -40, p10: -40, p90: -40 });
    expect(netStudy.groups[0].curve[CLOSE]).toEqual({ n: 0, median: null, p10: null, p90: null });
    expect(netStudy.driver?.groups[0]).toMatchObject({ medianClose: -40, profitableClosePct: 0 });
    expect(netStudy.driver?.groups[0].curve[0]?.median).toBe(-300);
    const netPct = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { ...netPayload, unit: 'creditPct' },
    });
    expect(netPct.statusCode).toBe(200);
    const netPctStudy = netPct.json<OpeningStudy>();
    expect(netPctStudy.groups[1].medianClose).toBeCloseTo(-4000 / 2925);
    expect(netPctStudy.groups[1].curve[0].median).toBeCloseTo(-30000 / 2925);
    expect(netPctStudy.driver?.groups[0].medianClose).toBeCloseTo(
      openingPnlInUnit(-40, 2925, 'creditPct')!,
    );
    const invalidCost = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { roundTripCost: -1 },
    });
    expect(invalidCost.statusCode).toBe(400);
    const invalid = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { from: '2026-02-31' },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test('research preserves minute gaps and reads only earlier measurements on the full source calendar', async () => {
  const dates = Array.from({ length: 23 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10);
    const session = day(date, i === 19 ? 'local' : 'nubra');
    session.expiry = date;
    session.monthly = i >= 20;
    session.ce[CE].fill(20 + i);
    if (i === 11) session.ce[CE][0] = null;
    if (i === 19) session.spot[CLOSE] = 23000;
    if (i === 20) {
      session.spot[CLOSE] = null;
      session.ce[CE][12] = null;
    }
    if (i === 22) session.ce[CE].fill(1000);
    return session;
  });
  const store: DayStore = {
    read: async (_, source, date) =>
      dates.find((item) => item.source === source && item.date === date) ?? null,
    list: async (_, source) =>
      dates.filter((item) => item.source === source).map(({ date }) => date),
    listDetailed: async (_, source) =>
      dates.filter((item) => item.source === source).map(({ date }) => ({ date, empty: false })),
    write: async () => {
      throw new Error('unexpected write');
    },
    dir: () => 'test-no-validation-file',
  };
  const app = Fastify();
  registerAnalysisRoutes({
    fastify: app,
    rootDir: 'test-no-validation-file',
    store,
    getPost: () => {
      throw new Error('unexpected broker call');
    },
  });
  try {
    const windowed = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: {
        includeResearch: true,
        includeLocalOnly: false,
        onTimeOnly: true,
        from: dates[20].date,
        to: dates[21].date,
        contract: 'monthly',
      },
    });
    expect(windowed.statusCode).toBe(200);
    const research = windowed.json<OpeningStudy>().research!;
    expect(research.rows.map(({ date }) => date)).toEqual([dates[20].date, dates[21].date]);
    const [first, second] = research.rows;
    expect(first.pnl).toHaveLength(SESSION_BARS);
    expect(first.pnl[0]).toBe(0);
    expect(first.pnl[12]).toBeNull();
    expect(first.pnl[CLOSE]).toBe(0);
    expect(first.features).toMatchObject({ entryCredit: 60 * 65, dte: 0, monthly: 1 });
    expect(first.features.premiumImbalance).toBeCloseTo(100 / 3);
    expect(first.features.callDistancePct).toBeCloseTo(10000 / 23250);
    expect(first.features.putDistancePct).toBeCloseTo(10000 / 23250);
    expect(first.features.overnightGapPct).toBeCloseTo((100 * 250) / 23000);
    expect(first.features.creditVsRecent).toBeCloseTo((100 * 60) / 49.5);
    expect(first.features.ivVsRecent).toBeGreaterThan(0);
    expect(second.features.overnightGapPct).toBeNull();
    expect(second.features.creditVsRecent).toBeCloseTo((100 * 61) / 50.5);
    const invalid = await app.inject({
      method: 'POST',
      url: `${OPENING_STRANGLE_API}/study`,
      payload: { includeResearch: 'true' },
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});
