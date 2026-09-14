import Fastify from 'fastify';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { SESSION_BARS, createDayStore, emptyGrid, type DayStore } from './daySeries.ts';
import { parseFinderParams, registerAnalysisRoutes } from './routes.ts';
import type { AnalysisSync } from './sync.ts';

let app: ReturnType<typeof Fastify>;
let dir: string;
let store: DayStore;

const idleSync = {
  getState: () => ({ running: false, phase: 'idle' }),
  start: () => true,
  whenIdle: () => Promise.resolve(),
} as unknown as AnalysisSync;

/** Spot flat at 23250 all day; CE decays, PE flat — every same-spot pair is a SELL gain. */
function day(date: string, source: 'nubra' | 'local', ceSlope = 0.1) {
  const spot = emptyGrid();
  const ce = emptyGrid();
  const pe = emptyGrid();
  for (let i = 0; i < SESSION_BARS; i++) {
    spot[i] = 23250;
    ce[i] = 200 - i * ceSlope;
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
    ce: { '23350': ce },
    pe: { '23150': pe },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-routes-'));
  store = createDayStore(dir);
  app = Fastify();
  registerAnalysisRoutes({
    fastify: app,
    rootDir: dir,
    getPost: () => null,
    store,
    sync: idleSync,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('parseFinderParams', () => {
  test('fills defaults and rejects out-of-range values', () => {
    expect(parseFinderParams({})).toMatchObject({ entryTime: '09:15', closeTolerance: 1 });
    expect(parseFinderParams({ spotTolerance: 5 })).not.toHaveProperty('spotTolerance');
    expect(parseFinderParams({ strikeTolerance: 2 })).not.toHaveProperty('strikeTolerance');
    expect(parseFinderParams({ entryTime: '08:00' })).toMatch(/entryTime/);
    expect(parseFinderParams({ entryTime: '12:00', exitTime: '11:00' })).toMatch(/after/);
    expect(parseFinderParams({ maxCasesPerDay: 0 })).toMatch(/maxCasesPerDay/);
    expect(parseFinderParams({ side: 'HOLD' as never })).toMatch(/side/);
  });
});

describe('analysis routes', () => {
  test('status counts data and empty days per source from file names', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    await store.write({
      v: 1,
      underlying: 'NIFTY',
      date: '2026-01-26',
      source: 'nubra',
      empty: true,
      reason: 'no-index-bars',
    });
    await store.write(day('2024-01-05', 'local'));
    await store.write(day('2026-01-05', 'local'));

    const res = await app.inject({ method: 'GET', url: '/api/analysis/status?underlying=NIFTY' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.coverage.nubra).toMatchObject({ days: 1, empty: 1 });
    expect(body.coverage.local).toMatchObject({ days: 2, empty: 0 });
    expect(body.coverage.localOnly).toMatchObject({ days: 1, from: '2024-01-05' });
    expect(body.brokerSession).toBe(false);
  });

  test('scan prefers Nubra, falls back to local, and honours includeLocalOnly', async () => {
    await store.write(day('2026-01-05', 'nubra', 0.1));
    await store.write(day('2026-01-05', 'local', 0.3)); // must be ignored: Nubra has this date
    await store.write(day('2024-01-05', 'local', 0.1));

    const all = await app.inject({ method: 'POST', url: '/api/analysis/scan', payload: {} });
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.days.map((d: { date: string; source: string }) => [d.date, d.source])).toEqual([
      ['2024-01-05', 'local'],
      ['2026-01-05', 'nubra'],
    ]);
    expect(body.days[1].legs).toMatchObject({ ceStrike: 23350, peStrike: 23150 });
    // Nubra's slope, not local's: the largest pair is ~its whole span × 0.1 × 65.
    expect(body.days[1].cases[0].ceDelta).toBeLessThan(375 * 0.1 * 65 + 1);

    const nubraOnly = await app.inject({
      method: 'POST',
      url: '/api/analysis/scan',
      payload: { includeLocalOnly: false },
    });
    expect(nubraOnly.json().days).toHaveLength(1);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/analysis/scan',
      payload: { params: { closeTolerance: -1 } },
    });
    expect(bad.statusCode).toBe(400);
  });

  test('day returns the entry legs and their grids', async () => {
    await store.write(day('2026-01-05', 'nubra'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/analysis/day?underlying=NIFTY&date=2026-01-05',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('nubra');
    expect(body.legs).toMatchObject({ ceStrike: 23350, peStrike: 23150, entryTime: '09:15' });
    expect(body.minutes).toHaveLength(SESSION_BARS);
    expect(body.ce[0]).toBe(200);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/analysis/day?underlying=NIFTY&date=2026-02-02',
    });
    expect(missing.statusCode).toBe(404);
  });
});
