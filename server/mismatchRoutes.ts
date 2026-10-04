/**
 * Live mismatch tracker: routes, tick routing, broker backfill and persistence around the pure
 * engine in server/mismatchTracker.ts.
 *
 * Additive only. It reads open positions, reads option-chain ticks it is handed by index.ts, and
 * writes its own two tables. It never places, modifies or closes anything.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  dbGetMismatchCoverage,
  dbInsertMismatchVersion,
  dbListMismatchTrackers,
  dbListMismatchVersions,
  dbPruneMismatchVersions,
  dbSetMismatchCoverage,
  dbSetMismatchTracker,
  type MismatchVersionRow,
} from './paperDb.ts';
import {
  fetchTodaySeconds,
  istSecondOfDay,
  istSecondToEpochNs,
  type TimeseriesPost,
} from './intradayBars.ts';
import {
  StrategyMismatchTracker,
  istDate,
  istMinute,
  isNearVersion,
  sessionMinutes,
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
  getCoverage?(basketGroupId: string): number | null;
  setCoverage?(basketGroupId: string, liveUntilMs: number): void;
  prune?(basketGroupId: string, deleteIds: number[], renumber: Array<[number, number]>): void;
}

const dbStore: MismatchStore = {
  setTracker: dbSetMismatchTracker,
  listTrackers: dbListMismatchTrackers,
  insertVersion: dbInsertMismatchVersion,
  listVersions: dbListMismatchVersions,
  getCoverage: dbGetMismatchCoverage,
  setCoverage: dbSetMismatchCoverage,
  prune: dbPruneMismatchVersions,
};

/** A row written this long after the moment it describes came from a catch-up replay. */
const REPLAYED_AFTER_MS = 120_000;

/**
 * What to remove from one strategy's stored versions, which must be in saved (id) order.
 *
 * Before 2026-09-24 a restart replayed the whole day and re-stored early moments of existing cases
 * as new cases, and re-added readings an existing case already held. A case goes when it was
 * written by a replay and every one of its readings is a near-copy of a reading in an earlier
 * surviving case; a reading goes when its case already holds the identical reading. The
 * survivors are renumbered 1..n in their original order.
 */
export function planMismatchCleanup(rows: MismatchVersionRow[]): {
  deleteIds: number[];
  renumber: Array<[number, number]>;
} {
  const byCase = new Map<number, MismatchVersionRow[]>();
  for (const r of rows) {
    const list = byCase.get(r.case_no) ?? [];
    list.push(r);
    byCase.set(r.case_no, list);
  }
  const at = (r: MismatchVersionRow) => ({ t1Ns: Number(r.t1_ns), t2Ns: Number(r.t2_ns) });
  const deleteIds: number[] = [];
  const kept: MismatchVersionRow[] = [];
  const keptNos: number[] = [];
  for (const no of [...byCase.keys()].sort((a, b) => a - b)) {
    const list = byCase.get(no)!;
    const first = list[0];
    const replayed =
      first.created_at != null &&
      first.created_at - Number(first.t2_ns) / 1_000_000 > REPLAYED_AFTER_MS;
    if (replayed && list.every((r) => kept.some((k) => isNearVersion(at(k), at(r))))) {
      for (const r of list) if (r.id != null) deleteIds.push(r.id);
      continue;
    }
    const seen = new Set<string>();
    for (const r of list) {
      const key = `${r.t1_ns}|${r.t2_ns}|${r.ce2}|${r.pe2}|${r.gap}`;
      if (seen.has(key) && r.id != null) deleteIds.push(r.id);
      else {
        seen.add(key);
        kept.push(r);
      }
    }
    keptNos.push(no);
  }
  return { deleteIds, renumber: keptNos.map((no, i) => [no, i + 1] as [number, number]) };
}

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
  /**
   * Turn the tracker on by itself for every eligible strategy nobody has toggled yet. A manual
   * "off" is stored and respected. Default on.
   */
  autoEnable?: boolean;
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
  autoEnable = true,
}: MismatchRouteDeps) {
  if (store.prune) {
    const all = store.listVersions();
    for (const gid of new Set(all.map((r) => r.basket_group_id))) {
      const plan = planMismatchCleanup(all.filter((r) => r.basket_group_id === gid));
      if (plan.deleteIds.length === 0 && plan.renumber.every(([a, b]) => a === b)) continue;
      store.prune(gid, plan.deleteIds, plan.renumber);
      console.log(
        `[Mismatch] ${gid}: removed ${plan.deleteIds.length} duplicate reading(s), ${plan.renumber.length} case(s) kept`,
      );
    }
  }
  const stored = store.listTrackers();
  const enabled = new Set(stored.filter((t) => t.enabled).map((t) => t.basket_group_id));
  /** Strategies with a stored on/off, auto or manual. Auto-enable never overrides these. */
  const decided = new Set(stored.map((t) => t.basket_group_id));
  const trackers = new Map<string, StrategyMismatchTracker>();
  /** Which option-chain feed each tracker's legs arrive on, learned from the first tick. */
  const feedOf = new Map<string, string>();
  /** Latest moment (epoch ms) each strategy has been scored up to, live or by replay. */
  const liveUntil = new Map<string, number>();
  const coverageDirty = new Set<string>();
  /** Where each tracker's catch-up replay starts: what was already scored when it was created. */
  const replayFrom = new WeakMap<StrategyMismatchTracker, number>();

  function markCovered(gid: string, ms: number): void {
    if (ms <= (liveUntil.get(gid) ?? 0)) return;
    liveUntil.set(gid, ms);
    coverageDirty.add(gid);
  }

  function flushCoverage(): void {
    for (const gid of coverageDirty) store.setCoverage?.(gid, liveUntil.get(gid)!);
    coverageDirty.clear();
  }

  const sameLegs = (a: StrategyLegs, b: StrategyLegs) =>
    a.ce.refId === b.ce.refId &&
    a.pe.refId === b.pe.refId &&
    a.ce.qty === b.ce.qty &&
    a.pe.qty === b.pe.qty &&
    a.entryNs === b.entryNs;

  /** Bring the live trackers in line with the enabled set and the open book. */
  function sync(): void {
    flushCoverage();
    const positions = simBroker.getPositions();
    // Same gate as the manual toggle: without a broker session the backfill and replay can't run,
    // so wait for one rather than start a tracker that misses everything before now. A strategy
    // that isn't one CE + one PE yet (legs still filling) stays undecided and is retried.
    if (autoEnable && getTimeseriesPost()) {
      const today = istDate(nowMs());
      for (const gid of new Set(positions.map((p) => p.basket_group_id || ''))) {
        if (!gid || decided.has(gid) || !strategyLegs(positions, gid, today).ok) continue;
        decided.add(gid);
        enabled.add(gid);
        store.setTracker(gid, true);
      }
    }
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
      // Read before any live tick reaches the new tracker, or the replay would skip everything.
      replayFrom.set(t, liveUntil.get(gid) ?? store.getCoverage?.(gid) ?? 0);
      trackers.set(gid, t);
      feedOf.delete(gid);
      void backfillAndCatchUp(t);
    }
  }

  /** The symbol the "spot" side is read from: the asset itself, or on MCX the future its options
   * are written on. Null means the future couldn't be resolved — nothing more can be done. */
  async function resolveUnderlying(legs: StrategyLegs): Promise<string | null> {
    if (legs.exchange !== 'MCX') return legs.asset;
    const fut =
      legs.optionExpiry && getMcxFuture
        ? await getMcxFuture(legs.asset, legs.optionExpiry).catch(() => null)
        : null;
    if (!fut)
      console.warn(`[Mismatch] no ${legs.asset} future for ${legs.optionExpiry}; ticks only`);
    return fut;
  }

  async function backfill(t: StrategyMismatchTracker): Promise<void> {
    const post = getTimeseriesPost();
    if (!post) return;
    const date = istDate(nowMs());
    const { legs } = t;
    const underlying = await resolveUnderlying(legs);
    if (!underlying) return;
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

  /**
   * A tracker only ever sees matches from the moment it's created onward — `onTick` is fed by
   * whatever live ticks arrive after that. A strategy entered earlier (backdated legs, or simply
   * turning the tracker on well after entry) can have real matches sitting in the gap between
   * entry and creation that no live tick will ever revisit.
   *
   * Sub-minute history (`1s`) is kept for a rolling 168h — same-day, which every open strategy's
   * entry is — so that gap can be replayed at (close to) the same resolution a live tick feed
   * would have given it, not just at the 1-minute resolution `backfill` uses for the *reference*
   * side of each comparison. `fetchTodaySeconds` only returns seconds that actually traded, so
   * this reconstructs the real sequence of price moves rather than one synthetic tick per minute.
   * Safe to call more than once: an unchanged candidate never outscores the version already on
   * file, so a repeat replay finds nothing new to record.
   */
  async function replayHistory(t: StrategyMismatchTracker): Promise<void> {
    const post = getTimeseriesPost();
    if (!post) return;
    const { legs } = t;
    const nowT = nowMs();
    const date = istDate(nowT);
    const session = sessionMinutes(legs.exchange);
    const entryMs = legs.entryNs / 1_000_000;
    const coveredMs = replayFrom.get(t) ?? 0;
    const firstSec = Math.max(
      (istDate(entryMs) === date ? Math.max(session.open, istMinute(entryMs)) : session.open) * 60,
      // The live feed already scored everything up to here; its readings stand.
      istDate(coveredMs) === date ? istSecondOfDay(coveredMs) + 1 : 0,
    );
    const lastSec = Math.min(istSecondOfDay(nowT), session.last * 60 + 59);
    const underlying = await resolveUnderlying(legs);
    if (!underlying) return;
    let spotBars, ceBars, peBars;
    try {
      [spotBars, ceBars, peBars] = await Promise.all([
        fetchTodaySeconds(post, {
          exchange: legs.exchange,
          type: legs.underlyingType,
          symbol: underlying,
          date,
        }),
        fetchTodaySeconds(post, {
          exchange: legs.exchange,
          type: 'OPT',
          symbol: legs.ce.nubraName,
          date,
        }),
        fetchTodaySeconds(post, {
          exchange: legs.exchange,
          type: 'OPT',
          symbol: legs.pe.nubraName,
          date,
        }),
      ]);
    } catch (e) {
      console.warn(`[Mismatch] replay fetch ${legs.basketGroupId} failed: ${(e as Error).message}`);
      return;
    }
    if (trackers.get(legs.basketGroupId) !== t) return;

    const toMap = (bars: typeof spotBars) => new Map(bars.map((b) => [b.sec, b.close]));
    const spotMap = toMap(spotBars);
    const ceMap = toMap(ceBars);
    const peMap = toMap(peBars);
    const secs = new Set<number>();
    for (const m of [spotMap, ceMap, peMap]) for (const sec of m.keys()) secs.add(sec);
    const ordered = [...secs].filter((s) => s >= firstSec && s <= lastSec).sort((a, b) => a - b);

    for (const sec of ordered) {
      const changed = t.onTick(
        { spot: spotMap.get(sec), ce: ceMap.get(sec), pe: peMap.get(sec) },
        istSecondToEpochNs(date, sec) / 1_000_000,
        { replay: true },
      );
      if (changed.length) record(legs.basketGroupId, changed);
    }
    const doneMs = istSecondToEpochNs(date, lastSec) / 1_000_000;
    replayFrom.set(t, Math.max(coveredMs, doneMs));
    markCovered(legs.basketGroupId, doneMs);
  }

  async function backfillAndCatchUp(t: StrategyMismatchTracker): Promise<void> {
    await backfill(t);
    if (trackers.get(t.legs.basketGroupId) !== t) return;
    await replayHistory(t);
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
      markCovered(gid, now);
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
  // Short interval: sync() is cheap once a strategy is decided (an early-exit Set lookup per open
  // basket), and this is the fallback for a leg that fills after order placement already called
  // sync() and found it not yet eligible. Cut from 5s so a slow second leg doesn't visibly lag.
  const syncTimer = setInterval(sync, 1_000);
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
      decided.add(gid);
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
    backfill: () => Promise.all([...trackers.values()].map(backfillAndCatchUp)),
    stop: () => {
      flushCoverage();
      clearInterval(syncTimer);
      if (backfillTimer) clearInterval(backfillTimer);
    },
  };
}
