import Fastify from 'fastify';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PANE_GREEKS, mergeGreeks, type BrokerDay } from './brokerGreeks.ts';
import { SESSION_BARS, createDayStore, emptyGrid, type DayStore } from './daySeries.ts';
import { dayGreekSeries } from './greeks.ts';
import { nseOptionSymbol } from './optionNames.ts';
import type { PostTimeseries } from './nubraSource.ts';
import { registerAnalysisRoutes } from './routes.ts';
import type { AnalysisSync } from './sync.ts';

let app: ReturnType<typeof Fastify>;
let dir: string;
let store: DayStore;

const idleSync = {
  getState: () => ({ running: false, phase: 'idle' }),
  start: () => true,
  whenIdle: () => Promise.resolve(),
} as unknown as AnalysisSync;

const DATE = '2026-01-05';
const EXPIRY = '2026-01-06';
const CE_NAME = nseOptionSymbol('NIFTY', EXPIRY, 23350, 'CE', false);
const PE_NAME = nseOptionSymbol('NIFTY', EXPIRY, 23150, 'PE', false);

/** Flat spot with a CE/PE pair at every strike, so the parity forward exists; priced off ~1 DTE. */
function day(source: 'nubra' | 'local', date = DATE) {
  const spot = emptyGrid();
  const ce = emptyGrid();
  const pe = emptyGrid();
  for (let i = 0; i < SESSION_BARS; i++) {
    spot[i] = 23250;
    ce[i] = 120 - i * 0.05;
    pe[i] = 110 - i * 0.05;
  }
  return {
    v: 1 as const,
    underlying: 'NIFTY',
    date,
    source,
    expiry: EXPIRY,
    monthly: false,
    spot,
    ce: { '23150': ce, '23250': ce, '23350': ce },
    pe: { '23150': pe, '23250': pe, '23350': pe },
  };
}

/** Broker points for minutes [0, upTo) of DATE: epoch-nanosecond timestamps, as the broker sends. */
function points(value: number, upTo: number) {
  const start = Date.UTC(2026, 0, 5, 9, 15) - 19_800_000;
  return Array.from({ length: upTo }, (_, i) => ({
    ts: String(BigInt(start + i * 60_000) * 1_000_000n),
    v: value,
  }));
}

function brokerReply(sym: string, upTo: number, base: number) {
  return {
    [sym]: {
      delta: points(base, upTo),
      gamma: points(base / 1000, upTo),
      theta: points(-base, upTo),
      vega: points(base * 10, upTo),
    },
  };
}

async function boot(getPost: () => PostTimeseries | null) {
  app = Fastify();
  registerAnalysisRoutes({
    fastify: app,
    rootDir: dir,
    getPost,
    store,
    sync: idleSync,
    greekPaceMs: 0,
  });
  await app.ready();
}

const get = (query: Record<string, string>) =>
  app.inject({
    method: 'GET',
    url: `/api/analysis/greeks?${new URLSearchParams(query).toString()}`,
  });
const ok = {
  underlying: 'NIFTY',
  date: DATE,
  source: 'nubra',
  ceStrike: '23350',
  peStrike: '23150',
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-greeks-'));
  store = createDayStore(dir);
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('GET /api/analysis/greeks', () => {
  test('without a broker session the whole day is rebuilt from the cache', async () => {
    await store.write(day('nubra'));
    await boot(() => null);
    const body = (await get(ok)).json();
    expect(body).toMatchObject({
      ok: true,
      expiry: EXPIRY,
      greekSource: { CE: 'parity', PE: 'parity' },
    });
    expect(body.brokerNote).toMatch(/no broker session/);
    expect(body.CE.delta).toHaveLength(SESSION_BARS);
    expect(body.CE.delta[30]).toBeGreaterThan(0);
    expect(body.PE.delta[30]).toBeLessThan(0);
  });

  test('a local-source day never asks the broker', async () => {
    await store.write(day('local'));
    let calls = 0;
    await boot(() => async () => {
      calls++;
      return {};
    });
    const body = (await get({ ...ok, source: 'local' })).json();
    expect(calls).toBe(0);
    expect(body.greekSource).toEqual({ CE: 'parity', PE: 'parity' });
    expect(body.brokerNote).toMatch(/local-source/);
  });

  test('the broker wins where it has a minute; the rest is rebuilt and marked mixed', async () => {
    await store.write(day('nubra'));
    const asked: unknown[] = [];
    await boot(() => async (b) => {
      asked.push(b);
      return {
        result: [
          { values: [brokerReply(CE_NAME, 100, 0.5), brokerReply(PE_NAME, SESSION_BARS, -0.4)] },
        ],
      };
    });
    const body = (await get(ok)).json();
    // One request for both contracts, asking for the four pane greeks, by the real symbol names.
    expect(asked).toHaveLength(1);
    const q = (asked[0] as { query: Array<{ values: string[]; fields: string[] }> }).query;
    expect(q.map((x) => x.values[0])).toEqual([CE_NAME, PE_NAME]);
    expect(q[0].fields).toEqual([...PANE_GREEKS]);

    expect(body.CE.delta[0]).toBe(0.5);
    expect(body.CE.delta[99]).toBe(0.5);
    expect(body.CE.delta[100]).not.toBe(0.5); // past the broker's last point: rebuilt
    expect(body.CE.delta[100]).toBeGreaterThan(0);
    expect(body.CE.gamma[0]).toBe(0.0005);
    expect(body.CE.theta[0]).toBe(-0.5);
    expect(body.greekSource).toEqual({ CE: 'mixed', PE: 'broker' });
    expect(body.PE.delta[300]).toBe(-0.4);
  });

  test('a broker failure falls back to the rebuilt greeks instead of erroring', async () => {
    await store.write(day('nubra'));
    await boot(() => async () => {
      throw new Error('unexpected status 500');
    });
    const res = await get(ok);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.greekSource).toEqual({ CE: 'parity', PE: 'parity' });
    expect(body.brokerNote).toMatch(/broker request failed/);
    expect(body.CE.delta[30]).toBeGreaterThan(0);
  });

  test('one unlisted contract does not blank the other side', async () => {
    await store.write(day('nubra'));
    await boot(() => async (b) => {
      const names = (b as { query: Array<{ values: string[] }> }).query.map((x) => x.values[0]);
      if (names.includes(PE_NAME)) throw new Error('unexpected status 404');
      return { result: [{ values: [brokerReply(CE_NAME, SESSION_BARS, 0.3)] }] };
    });
    const body = (await get(ok)).json();
    expect(body.greekSource).toEqual({ CE: 'broker', PE: 'parity' });
    expect(body.CE.delta[10]).toBe(0.3);
    expect(body.PE.delta[10]).toBeLessThan(0);
  });

  test('a past day is asked for once, then remembered', async () => {
    await store.write(day('nubra'));
    let calls = 0;
    await boot(() => async () => {
      calls++;
      return { result: [{ values: [brokerReply(CE_NAME, SESSION_BARS, 0.5)] }] };
    });
    await get(ok);
    await get(ok);
    expect(calls).toBe(1);
  });

  test('a broker that holds nothing for the day is reported, and the day is rebuilt', async () => {
    await store.write(day('nubra'));
    await boot(() => async () => ({ result: [{ values: [] }] }));
    const body = (await get(ok)).json();
    expect(body.greekSource).toEqual({ CE: 'parity', PE: 'parity' });
    expect(body.brokerNote).toMatch(/holds no greeks/);
  });

  test('bad input is a 400, a missing day or strike a 404', async () => {
    await store.write(day('nubra'));
    await boot(() => null);
    expect((await get({ ...ok, underlying: 'BANKNIFTY' })).statusCode).toBe(400);
    expect((await get({ ...ok, date: '05-01-2026' })).statusCode).toBe(400);
    expect((await get({ ...ok, source: 'both' })).statusCode).toBe(400);
    expect((await get({ ...ok, ceStrike: 'abc' })).statusCode).toBe(400);
    expect((await get({ ...ok, date: '2026-01-06' })).statusCode).toBe(404);
    expect((await get({ ...ok, source: 'local' })).statusCode).toBe(404);
    expect((await get({ ...ok, ceStrike: '23400' })).statusCode).toBe(404);
  });
});

describe('mergeGreeks', () => {
  const side = (v: number | null, n = SESSION_BARS) => {
    const g = emptyGrid();
    for (let i = 0; i < n; i++) g[i] = v;
    return { delta: g, gamma: g, theta: g, vega: g };
  };
  const rebuilt = () => {
    const one = side(0.1);
    const full = { iv: emptyGrid(), ...one };
    return { CE: full, PE: full, forward: emptyGrid() };
  };

  test('classifies each side by where its numbers came from', () => {
    const broker: BrokerDay = { CE: side(0.9), PE: side(0.9, 10) };
    const m = mergeGreeks(rebuilt(), broker);
    expect(m.source).toEqual({ CE: 'broker', PE: 'mixed' });
    expect(mergeGreeks(rebuilt(), null).source).toEqual({ CE: 'parity', PE: 'parity' });
    expect(mergeGreeks(rebuilt(), { CE: null, PE: null }).source).toEqual({
      CE: 'parity',
      PE: 'parity',
    });
  });

  test('a broker zero is a value, not a gap', () => {
    const m = mergeGreeks(rebuilt(), { CE: side(0), PE: null });
    expect(m.CE.gamma[5]).toBe(0);
    expect(m.PE.gamma[5]).toBe(0.1);
  });

  test('a minute neither source can price stays null', () => {
    const r = rebuilt();
    r.CE.delta[7] = null;
    const broker: BrokerDay = { CE: side(0.9), PE: null };
    broker.CE!.delta[7] = null;
    const m = mergeGreeks(r, broker);
    expect(m.CE.delta[7]).toBeNull();
    expect(m.CE.delta[8]).toBe(0.9);
  });

  test('is consistent with the rebuilt series it is given', () => {
    const d = day('nubra');
    const rb = dayGreekSeries(d, { ceStrike: 23350, peStrike: 23150 });
    const m = mergeGreeks(rb, null);
    expect(m.CE.delta).toEqual(rb.CE.delta);
    expect(m.PE.vega).toEqual(rb.PE.vega);
  });
});
