/**
 * Live mismatch tracker: routes, tick routing, broker backfill and persistence around the pure
 * engine in server/mismatchTracker.ts.
 *
 * Additive only. It reads open positions, reads option-chain ticks it is handed by index.ts, and
 * writes its own two tables. It never places, modifies or closes anything.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  dbInsertMismatchVersion,
  dbListMismatchTrackers,
  dbListMismatchVersions,
  dbSetMismatchTracker,
  type MismatchVersionRow,
} from './paperDb.ts';
import type { TimeseriesPost } from './intradayBars.ts';
import {
  StrategyMismatchTracker,
  istDate,
  istMinute,
  strategyLegs,
  type MismatchCase,
  type MismatchVersion,
  type StrategyLegs,
} from './mismatchTracker.ts';

export interface MismatchPosition {
  ref_id: number;
  nubraName: string;
  qty: number;
  basket_group_id?: string;
  entry_time?: number;
}

export interface MismatchStore {
  setTracker(basketGroupId: string, enabled: boolean): void;
  listTrackers(): Array<{ basket_group_id: string; enabled: number }>;
  insertVersion(row: MismatchVersionRow): void;
  listVersions(basketGroupId?: string): MismatchVersionRow[];
}

const dbStore: MismatchStore = {
  setTracker: dbSetMismatchTracker,
  listTrackers: dbListMismatchTrackers,
  insertVersion: dbInsertMismatchVersion,
  listVersions: dbListMismatchVersions,
};

export interface MismatchRouteDeps {
  fastify: FastifyInstance;
  requireAuth: (reply: FastifyReply) => boolean;
  simBroker: { getPositions(): MismatchPosition[] };
  /** Null while no broker session is connected. */
  getTimeseriesPost: () => TimeseriesPost | null;
  broadcast: (msg: unknown) => void;
  /**
   * The future an MCX option series is written on (`FUT_CRUDEOIL_20260921`): the first futures
   * expiry on or after the option's. Null when the instrument master has none.
   */
  getMcxFuture?: (asset: string, optionExpiry: string) => Promise<string | null>;
  store?: MismatchStore;
  nowMs?: () => number;
  /** Background minute-close refresh. Off in tests. */
  backfillEveryMs?: number | null;
}

export interface MismatchCaseDto {
  case_no: number;
  color_idx: number;
  /** Oldest first; the last is the strongest. */
  versions: Array<{
    t1_ns: number;
    t2_ns: number;
    spot1: number;
    spot2: number;
    ce1: number;
    ce2: number;
    pe1: number;
    pe2: number;
    ce_delta: number;
    pe_delta: number;
    gap: number;
  }>;
}

function versionDto(v: MismatchVersion): MismatchCaseDto['versions'][number] {
  return {
    t1_ns: v.t1Ns,
    t2_ns: v.t2Ns,
    spot1: v.spot1,
    spot2: v.spot2,
    ce1: v.ce1,
    ce2: v.ce2,
    pe1: v.pe1,
    pe2: v.pe2,
    ce_delta: v.ceDelta,
    pe_delta: v.peDelta,
    gap: v.gap,
  };
}

function caseDto(c: MismatchCase): MismatchCaseDto {
  return { case_no: c.caseNo, color_idx: c.colorIdx, versions: c.versions.map(versionDto) };
}

/** Rebuild one strategy's cases from its stored versions. */
export function casesFromRows(rows: MismatchVersionRow[]): MismatchCase[] {
  const byNo = new Map<number, MismatchCase>();
  for (const r of rows) {
    let c = byNo.get(r.case_no);
    if (!c) {
      c = { caseNo: r.case_no, colorIdx: r.color_idx, versions: [] };
      byNo.set(r.case_no, c);
    }
    c.versions.push({
      t1Ns: Number(r.t1_ns),
      t2Ns: Number(r.t2_ns),
      spot1: r.spot1,
      spot2: r.spot2,
      ce1: r.ce1,
      ce2: r.ce2,
      pe1: r.pe1,
      pe2: r.pe2,
      ceDelta: r.ce_delta,
      peDelta: r.pe_delta,
      gap: r.gap,
    });
  }
  return [...byNo.values()].sort((a, b) => a.caseNo - b.caseNo);
}

interface Point {
  ts?: string | number;
  v: number;
}

/** 1m closes per symbol for one IST date, as `{minute, close}` in rupees. */
export function parseMinuteCloses(
  res: Record<string, unknown>,
  date: string,
): Map<string, Array<{ minute: number; close: number }>> {
  const out = new Map<string, Array<{ minute: number; close: number }>>();
  const groups = (res as { result?: Array<{ values?: Array<Record<string, unknown>> }> }).result;
  for (const group of groups ?? []) {
    for (const symbolMap of group.values ?? []) {
      for (const [sym, data] of Object.entries(symbolMap)) {
        const list = out.get(sym) ?? [];
        for (const p of ((data ?? {}) as Record<string, Point[]>).close ?? []) {
          if (p.ts == null || !Number.isFinite(p.v) || p.v <= 0) continue;
          let ms: number;
          try {
            ms = Number(BigInt(String(p.ts)) / 1_000_000n);
          } catch {
            continue;
          }
          if (istDate(ms) !== date) continue;
          list.push({ minute: istMinute(ms), close: p.v / 100 });
        }
        out.set(sym, list);
      }
    }
  }
  return out;
}

export function registerMismatchRoutes({
  fastify,
  requireAuth,
  simBroker,
  getTimeseriesPost,
  broadcast,
  getMcxFuture,
  store = dbStore,
  nowMs = () => Date.now(),
  backfillEveryMs = 60_000,
}: MismatchRouteDeps) {
  const enabled = new Set(
    store
      .listTrackers()
      .filter((t) => t.enabled)
      .map((t) => t.basket_group_id),
  );
  const trackers = new Map<string, StrategyMismatchTracker>();
  /** Which option-chain feed each tracker's legs arrive on, learned from the first tick. */
  const feedOf = new Map<string, string>();

  const sameLegs = (a: StrategyLegs, b: StrategyLegs) =>
    a.ce.refId === b.ce.refId &&
    a.pe.refId === b.pe.refId &&
    a.ce.qty === b.ce.qty &&
    a.pe.qty === b.pe.qty &&
    a.entryNs === b.entryNs;

  /** Bring the live trackers in line with the enabled set and the open book. */
  function sync(): void {
    const positions = simBroker.getPositions();
    for (const gid of [...trackers.keys()]) {
      if (!enabled.has(gid)) {
        trackers.delete(gid);
        feedOf.delete(gid);
      }
    }
    for (const gid of enabled) {
      const found = strategyLegs(positions, gid, istDate(nowMs()));
      const current = trackers.get(gid);
      if (!found.ok) {
        // A leg was exited or the strategy closed: stop tracking; its cases stay stored.
        if (current) {
          trackers.delete(gid);
          feedOf.delete(gid);
        }
        continue;
      }
      if (current && sameLegs(current.legs, found.legs)) continue;
      const t = new StrategyMismatchTracker(found.legs, casesFromRows(store.listVersions(gid)));
      trackers.set(gid, t);
      feedOf.delete(gid);
      void backfill(t);
    }
  }

  async function backfill(t: StrategyMismatchTracker): Promise<void> {
    const post = getTimeseriesPost();
    if (!post) return;
    const date = istDate(nowMs());
    const { legs } = t;
    let underlying = legs.asset;
    if (legs.exchange === 'MCX') {
      const fut =
        legs.optionExpiry && getMcxFuture
          ? await getMcxFuture(legs.asset, legs.optionExpiry).catch(() => null)
          : null;
      if (!fut) {
        console.warn(`[Mismatch] no ${legs.asset} future for ${legs.optionExpiry}; ticks only`);
        return;
      }
      underlying = fut;
    }
    const query = [
      { exchange: legs.exchange, type: legs.underlyingType, symbol: underlying },
      { exchange: legs.exchange, type: 'OPT', symbol: legs.ce.nubraName },
      { exchange: legs.exchange, type: 'OPT', symbol: legs.pe.nubraName },
    ].map((q) => ({
      exchange: q.exchange,
      type: q.type,
      values: [q.symbol],
      fields: ['close'],
      startDate: `${date}T00:00:00.000Z`,
      endDate: `${date}T23:59:59.000Z`,
      interval: '1m',
      intraDay: true,
      realTime: false,
    }));
    try {
      const closes = parseMinuteCloses(await post({ query }), date);
      if (trackers.get(legs.basketGroupId) !== t) return;
      t.setBrokerCloses(date, 'spot', closes.get(underlying) ?? []);
      t.setBrokerCloses(date, 'ce', closes.get(legs.ce.nubraName) ?? []);
      t.setBrokerCloses(date, 'pe', closes.get(legs.pe.nubraName) ?? []);
    } catch (e) {
      console.warn(`[Mismatch] backfill ${legs.basketGroupId} failed: ${(e as Error).message}`);
    }
  }

  function record(gid: string, changed: MismatchCase[]): void {
    for (const c of changed) {
      const v = c.versions[c.versions.length - 1];
      store.insertVersion({
        basket_group_id: gid,
        case_no: c.caseNo,
        color_idx: c.colorIdx,
        t1_ns: v.t1Ns,
        t2_ns: v.t2Ns,
        spot1: v.spot1,
        spot2: v.spot2,
        ce1: v.ce1,
        ce2: v.ce2,
        pe1: v.pe1,
        pe2: v.pe2,
        ce_delta: v.ceDelta,
        pe_delta: v.peDelta,
        gap: v.gap,
      });
      broadcast({ type: 'mismatch_case', data: { basket_group_id: gid, case: caseDto(c) } });
    }
  }

  /**
   * One decoded option_chain message. Returns at once when nothing is tracked, so the tick path
   * costs a single size check for everyone not using the feature.
   */
  function onChain(d: {
    asset?: string;
    expiry?: string;
    exchange?: string;
    currentprice?: unknown;
    ce?: unknown[];
    pe?: unknown[];
  }): void {
    if (enabled.size === 0) return;
    if (trackers.size === 0) return;
    const key = `${d.asset}|${d.expiry}|${d.exchange || 'NSE'}`;
    const ltps = new Map<number, number>();
    for (const item of [...(d.ce ?? []), ...(d.pe ?? [])]) {
      const i = item as Record<string, unknown>;
      const refId = Number(i.refId ?? i.ref_id);
      const ltp = Number(i.ltp);
      if (refId && ltp > 0) ltps.set(refId, ltp / 100);
    }
    const spotPaise = Number(d.currentprice);
    const now = nowMs();
    for (const [gid, t] of trackers) {
      const { ce, pe } = t.legs;
      if (ltps.has(ce.refId) || ltps.has(pe.refId)) feedOf.set(gid, key);
      if (feedOf.get(gid) !== key) continue;
      const changed = t.onTick(
        {
          spot: spotPaise > 0 ? spotPaise / 100 : undefined,
          ce: ltps.get(ce.refId),
          pe: ltps.get(pe.refId),
        },
        now,
      );
      if (changed.length) record(gid, changed);
    }
  }

  sync();
  const syncTimer = setInterval(sync, 5_000);
  syncTimer.unref?.();
  let backfillTimer: ReturnType<typeof setInterval> | null = null;
  if (backfillEveryMs) {
    backfillTimer = setInterval(() => {
      for (const t of trackers.values()) void backfill(t);
    }, backfillEveryMs);
    backfillTimer.unref?.();
  }

  fastify.get('/paper/mismatch/trackers', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    const positions = simBroker.getPositions();
    const groups = new Set(
      positions.map((p) => p.basket_group_id || '').filter((gid) => gid !== ''),
    );
    for (const gid of enabled) groups.add(gid);
    const counts = new Map<string, number>();
    for (const r of store.listVersions()) {
      const seen = counts.get(r.basket_group_id) ?? 0;
      counts.set(r.basket_group_id, Math.max(seen, r.case_no));
    }
    return {
      trackers: [...groups].map((gid) => {
        const found = strategyLegs(positions, gid, istDate(nowMs()));
        return {
          basket_group_id: gid,
          enabled: enabled.has(gid),
          eligible: found.ok,
          reason: found.ok ? undefined : found.reason,
          tracking: trackers.has(gid),
          case_count: counts.get(gid) ?? 0,
        };
      }),
    };
  });

  fastify.post<{ Body: { basket_group_id?: string; enabled?: boolean } }>(
    '/paper/mismatch/trackers',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const gid = String(req.body?.basket_group_id ?? '');
      const on = req.body?.enabled === true;
      if (!gid) return reply.status(400).send({ error: 'basket_group_id is required' });
      if (on) {
        const found = strategyLegs(simBroker.getPositions(), gid, istDate(nowMs()));
        if (!found.ok) return reply.status(422).send({ error: found.reason });
        if (!getTimeseriesPost()) {
          return reply
            .status(503)
            .send({ error: "Broker session is not connected, so today's prices can't be read" });
        }
        enabled.add(gid);
      } else {
        enabled.delete(gid);
      }
      store.setTracker(gid, on);
      sync();
      return { basket_group_id: gid, enabled: on, tracking: trackers.has(gid) };
    },
  );

  fastify.get<{ Querystring: { basket_group_id?: string } }>(
    '/paper/mismatch/cases',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const gid = String(req.query.basket_group_id ?? '');
      if (!gid) return reply.status(400).send({ error: 'basket_group_id is required' });
      const live = trackers.get(gid);
      const cases = live ? live.cases : casesFromRows(store.listVersions(gid));
      return { basket_group_id: gid, enabled: enabled.has(gid), cases: cases.map(caseDto) };
    },
  );

  return {
    onChain,
    sync,
    backfill: () => Promise.all([...trackers.values()].map(backfill)),
    stop: () => {
      clearInterval(syncTimer);
      if (backfillTimer) clearInterval(backfillTimer);
    },
  };
}
