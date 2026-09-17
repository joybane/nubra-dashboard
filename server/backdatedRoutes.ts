/**
 * Backdated paper trades: "it is 10:00 now; I entered at 09:25:30".
 *
 * The entry fills at a price read off today's 1-second history (open, high, low, close or the
 * minute's VWAP up to that second), stamped with that second. From then on the position is an
 * ordinary SIM position: the live feed updates it, the Positions tab and strategy chart show it,
 * and auto-exit rules act on it. Rules sent with the order are first replayed over the seconds
 * between entry and now (positionRuleReplay.ts), so a stop-loss history already hit closes the
 * position at the second and level it would have.
 *
 * Everything here is additive. The existing order, basket and rule routes are not touched; this
 * file only calls SimBroker's new backdated methods and positionRules' public functions.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  dbInsertBackdatedTrade,
  dbListBackdatedTrades,
  dbSetBackdatedReplayed,
} from './paperDb.ts';
import {
  deleteGroupRule,
  deleteLegRule,
  legRuleKey,
  listPositionRules,
  sanitizeExitTime,
  sanitizeSLTarget,
  seedGroupTrailState,
  seedLegTrailState,
  upsertGroupRule,
  upsertLegRule,
  type GroupRule,
  type LegRule,
  type RuleFireEvent,
  type SLTarget,
  type TrailStop,
} from './positionRules.ts';
import {
  PRICE_SOURCES,
  barAt,
  fetchTodaySeconds,
  formatHms,
  istDateOf,
  istSecondOfDay,
  istSecondToEpochNs,
  minuteVwap,
  pickEntryPrice,
  validateEntryTime,
  type PriceSource,
  type SecBar,
  type TimeseriesPost,
} from './intradayBars.ts';
import { replayRules, type ReplayLeg } from './positionRuleReplay.ts';

interface BackdatedPlaceInput {
  nubraName: string;
  liveRefId: number;
  display_name?: string;
  order_side: string;
  order_qty: number;
  order_delivery_type: string;
  tag?: string;
  basket_group_id?: string;
  strategy_name?: string;
  margin_required?: number;
}

export interface BackdatedBroker {
  placeBackdated(
    p: BackdatedPlaceInput,
    at: { timeNs: number; pricePaise: number },
  ): { order_id: number; avg_filled_price: number };
  closeBackdated(
    refId: number,
    basketGroupId: string | undefined,
    at: { timeNs: number; pricePaise: number },
  ): { order_id: number } | null;
  getPositions(): Array<{
    ref_id: number;
    qty: number;
    avg_price: number;
    basket_group_id?: string;
    entry_time?: number;
  }>;
}

export interface BackdatedRouteDeps {
  fastify: FastifyInstance;
  requireAuth: (reply: FastifyReply) => boolean;
  simBroker: BackdatedBroker;
  subscribeForSim: (
    nubraName: string,
    liveRefId: number,
    derivativeType?: string,
    asset?: string,
    expiry?: string,
    exchange?: string,
  ) => void;
  /** Null while no broker session is connected. */
  getTimeseriesPost: () => TimeseriesPost | null;
  broadcastRuleEvents: (events: RuleFireEvent[]) => void;
  nowMs?: () => number;
}

interface LegRuleInput {
  stopLoss?: SLTarget;
  target?: SLTarget;
  trail?: TrailStop;
  exitTime?: string;
}

interface GroupRuleInput {
  maxProfit?: number;
  maxLoss?: number;
  trail?: TrailStop;
  exitAllOnLegHit?: boolean;
  exitTime?: string;
}

export interface BackdatedLegBody {
  nubraName: string;
  liveRefId: number;
  display_name?: string;
  order_qty: number;
  order_side: string;
  order_delivery_type: string;
  tag?: string;
  asset?: string;
  expiry?: string;
  exchange?: string;
  derivative_type?: string;
  /** The name `/charts/timeseries` knows the contract by (the chart's `getSymbol`). */
  symbol?: string;
  /** OPT | FUT | STOCK | INDEX, as the chart's `nubraType` resolves it. */
  instrument_type?: string;
  rules?: LegRuleInput;
}

type Outcome = { status: number; payload: Record<string, unknown> };
const fail = (status: number, error: string): Outcome => ({ status, payload: { error } });

const TYPES = new Set(['OPT', 'FUT', 'STOCK', 'INDEX']);

function instrumentOf(leg: BackdatedLegBody): { exchange: string; type: string; symbol: string } {
  const given = String(leg.instrument_type || '').toUpperCase();
  const dt = String(leg.derivative_type || '').toUpperCase();
  return {
    exchange: String(leg.exchange || 'NSE').toUpperCase(),
    type: TYPES.has(given) ? given : dt === 'OPT' || dt === 'FUT' ? dt : 'STOCK',
    symbol: leg.symbol || leg.nubraName,
  };
}

const armed = (t: SLTarget | undefined) => !!t && t.type !== 'NONE' && t.value != null;

function legRuleFrom(input: LegRuleInput | undefined, refId: number, gid: string): LegRule | null {
  if (!input) return null;
  const rule: LegRule = {
    scope: 'LEG',
    ref_id: refId,
    basket_group_id: gid,
    stopLoss: sanitizeSLTarget(input.stopLoss),
    target: sanitizeSLTarget(input.target),
    trail: input.trail,
    exitTime: sanitizeExitTime(input.exitTime),
  };
  const live =
    armed(rule.stopLoss) ||
    armed(rule.target) ||
    (!!rule.trail && rule.trail.type !== 'NONE') ||
    !!rule.exitTime;
  return live ? rule : null;
}

function groupRuleFrom(input: GroupRuleInput | undefined, gid: string): GroupRule | null {
  if (!input) return null;
  const rule: GroupRule = {
    scope: 'GROUP',
    basket_group_id: gid,
    maxProfit: input.maxProfit || undefined,
    maxLoss: input.maxLoss || undefined,
    trail: input.trail,
    exitAllOnLegHit: input.exitAllOnLegHit || undefined,
    exitTime: sanitizeExitTime(input.exitTime),
  };
  const live =
    !!rule.maxProfit ||
    !!rule.maxLoss ||
    (!!rule.trail && rule.trail.type !== 'NONE') ||
    !!rule.exitTime;
  return live ? rule : null;
}

const sideSign = (side: string) => (String(side).includes('BUY') ? 1 : -1);

export function registerBackdatedRoutes({
  fastify,
  requireAuth,
  simBroker,
  subscribeForSim,
  getTimeseriesPost,
  broadcastRuleEvents,
  nowMs = () => Date.now(),
}: BackdatedRouteDeps): void {
  async function loadBars(
    post: TimeseriesPost,
    date: string,
    instruments: Array<{ exchange: string; type: string; symbol: string }>,
  ): Promise<SecBar[][]> {
    const key = (i: { exchange: string; type: string; symbol: string }) =>
      `${i.exchange}|${i.type}|${i.symbol}`;
    const unique = new Map(instruments.map((i) => [key(i), i]));
    const loaded = new Map<string, SecBar[]>();
    await Promise.all(
      [...unique].map(async ([k, i]) => {
        loaded.set(k, await fetchTodaySeconds(post, { ...i, date }));
      }),
    );
    return instruments.map((i) => loaded.get(key(i)) ?? []);
  }

  /** Close what history says fired, retire spent rules, and hand live trailing its state. */
  function applyReplay(
    date: string,
    legs: ReplayLeg[],
    legRules: LegRule[],
    groupRule: GroupRule | undefined,
    nowSec: number,
  ) {
    const outcome = replayRules(legs, legRules, groupRule, nowSec);
    const exits = [...outcome.exits].sort((a, b) => a.sec - b.sec);
    for (const e of exits) {
      simBroker.closeBackdated(e.ref_id, e.basket_group_id, {
        timeNs: istSecondToEpochNs(date, e.sec),
        pricePaise: Math.round(e.priceRs * 100),
      });
    }
    for (const s of outcome.legRulesSpent) deleteLegRule(s.ref_id, s.basket_group_id);
    if (outcome.groupRuleSpent && groupRule) deleteGroupRule(groupRule.basket_group_id);

    const events: RuleFireEvent[] = [];
    for (const e of exits) {
      const same =
        e.scope === 'GROUP'
          ? events.find(
              (x) =>
                x.scope === 'GROUP' &&
                x.reason === e.reason &&
                x.basket_group_id === e.basket_group_id,
            )
          : undefined;
      if (same) same.ref_ids.push(e.ref_id);
      else
        events.push({
          scope: e.scope,
          reason: e.reason,
          ref_ids: [e.ref_id],
          basket_group_id: e.basket_group_id,
        });
    }
    broadcastRuleEvents(events);

    const positions = simBroker.getPositions();
    for (const t of outcome.legTrails) {
      const pos = positions.find(
        (p) => p.ref_id === t.ref_id && (p.basket_group_id || '') === (t.basket_group_id || ''),
      );
      if (pos) seedLegTrailState(t.ref_id, t.basket_group_id, pos.entry_time, t.state);
    }
    if (outcome.groupTrail && groupRule) {
      const members = positions.filter((p) => p.basket_group_id === groupRule.basket_group_id);
      if (members.length) {
        const anchor = members.reduce((min, p) => Math.min(min, p.entry_time ?? 0), Infinity);
        seedGroupTrailState(groupRule.basket_group_id, anchor, outcome.groupTrail);
      }
    }

    return exits.map((e) => ({
      ref_id: e.ref_id,
      basket_group_id: e.basket_group_id,
      scope: e.scope,
      reason: e.reason,
      time: formatHms(e.sec),
      price: e.priceRs,
    }));
  }

  async function enter(
    legs: BackdatedLegBody[],
    entryTime: unknown,
    sourceRaw: unknown,
    opts: {
      basketGroupId?: string;
      strategyName?: string;
      marginRequired?: number;
      groupRule?: GroupRuleInput;
    },
  ): Promise<Outcome> {
    if (!Array.isArray(legs) || legs.length === 0)
      return fail(400, 'orders must be a non-empty array');
    const source = (sourceRaw ?? 'close') as PriceSource;
    if (!PRICE_SOURCES.includes(source))
      return fail(400, `price_source must be one of ${PRICE_SOURCES.join(', ')}`);
    for (const leg of legs) {
      if (!leg?.liveRefId || !leg.nubraName)
        return fail(400, 'every leg needs nubraName and liveRefId');
      if (!Number.isInteger(leg.order_qty) || leg.order_qty <= 0)
        return fail(400, 'order_qty must be a positive whole number');
      if (leg.order_side !== 'ORDER_SIDE_BUY' && leg.order_side !== 'ORDER_SIDE_SELL')
        return fail(400, 'order_side must be ORDER_SIDE_BUY or ORDER_SIDE_SELL');
    }

    const now = nowMs();
    const instruments = legs.map(instrumentOf);
    let check = validateEntryTime(instruments[0].exchange, entryTime, now);
    for (const inst of instruments) {
      const c = validateEntryTime(inst.exchange, entryTime, now);
      if (!c.ok) return fail(400, c.error);
      check = c;
    }
    if (!check.ok) return fail(400, check.error);
    const { date, sec, timeNs } = check;

    const gid = opts.basketGroupId || '';
    const open = simBroker.getPositions();
    for (const leg of legs) {
      if (open.some((p) => p.ref_id === leg.liveRefId && (p.basket_group_id || '') === gid)) {
        return fail(
          409,
          `${leg.display_name || leg.nubraName} is already an open position here — a backdated entry cannot be averaged into it`,
        );
      }
    }

    const post = getTimeseriesPost();
    if (!post) return fail(503, "Broker session is not connected, so today's prices can't be read");
    let bars: SecBar[][];
    try {
      bars = await loadBars(post, date, instruments);
    } catch (e) {
      return fail(502, `Could not read today's prices: ${(e as Error).message}`);
    }
    const prices = legs.map((_, i) => pickEntryPrice(bars[i], sec, source));
    for (let i = 0; i < legs.length; i++) {
      const p = prices[i];
      if (!p.ok) return fail(422, `${legs[i].display_name || legs[i].nubraName}: ${p.error}`);
    }

    // Every check has passed. Nothing was placed before this point, so a bad leg can never leave
    // half a basket behind.
    const legRules = legs
      .map((l) => legRuleFrom(l.rules, l.liveRefId, gid))
      .filter((r): r is LegRule => !!r);
    const groupRule = gid ? groupRuleFrom(opts.groupRule, gid) : null;
    const replayed: Record<string, string> = {};
    for (const r of legRules) replayed[legRuleKey(r.ref_id, r.basket_group_id)] = JSON.stringify(r);
    if (groupRule) replayed[groupRule.basket_group_id] = JSON.stringify(groupRule);

    const placed = legs.map((leg, i) => {
      const price = prices[i] as Extract<(typeof prices)[number], { ok: true }>;
      subscribeForSim(
        leg.nubraName,
        leg.liveRefId,
        leg.derivative_type,
        leg.asset,
        leg.expiry,
        leg.exchange,
      );
      const order = simBroker.placeBackdated(
        {
          nubraName: leg.nubraName,
          liveRefId: leg.liveRefId,
          display_name: leg.display_name,
          order_side: leg.order_side,
          order_qty: leg.order_qty,
          order_delivery_type: leg.order_delivery_type,
          tag: leg.tag,
          basket_group_id: gid || undefined,
          strategy_name: opts.strategyName,
          margin_required: opts.marginRequired,
        },
        { timeNs, pricePaise: Math.round(price.price * 100) },
      );
      dbInsertBackdatedTrade({
        order_id: order.order_id,
        ref_id: leg.liveRefId,
        basket_group_id: gid,
        entry_time_ns: timeNs,
        entry_label: formatHms(sec),
        price_source: source,
        exact: price.exact ? 1 : 0,
        fill_price: order.avg_filled_price,
        symbol: instruments[i].symbol,
        exchange: instruments[i].exchange,
        instrument_type: instruments[i].type,
        replayed_json: JSON.stringify(replayed),
      });
      return { order, price };
    });

    for (const r of legRules) upsertLegRule(r);
    if (groupRule) upsertGroupRule(groupRule);

    const exits =
      legRules.length || groupRule
        ? applyReplay(
            date,
            legs.map((leg, i) => ({
              ref_id: leg.liveRefId,
              basket_group_id: gid,
              qty: sideSign(leg.order_side) * leg.order_qty,
              entryRs: placed[i].order.avg_filled_price / 100,
              entrySec: sec,
              bars: bars[i],
            })),
            legRules,
            groupRule ?? undefined,
            istSecondOfDay(now),
          )
        : [];

    return {
      status: 200,
      payload: {
        orders: placed.map(({ order, price }, i) => ({
          order_id: order.order_id,
          ref_id: legs[i].liveRefId,
          fill_price: order.avg_filled_price,
          exact: price.exact,
          actual_time: formatHms(price.bar.sec),
          vwap_fallback: price.vwapFallback,
        })),
        basket_group_id: gid || undefined,
        entry_time: formatHms(sec),
        price_source: source,
        replay: { exits },
      },
    };
  }

  // ─── Price preview for the order ticket ───────────────────────────────────
  fastify.get<{
    Querystring: { exchange?: string; type?: string; symbol?: string; time?: string };
  }>('/paper/backdated/price', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { exchange, type, symbol, time } = req.query;
    if (!symbol) return reply.status(400).send({ error: 'symbol is required' });
    const inst = instrumentOf({
      nubraName: symbol,
      liveRefId: 0,
      order_qty: 0,
      order_side: '',
      order_delivery_type: '',
      exchange,
      instrument_type: type,
      derivative_type: type,
    });
    const check = validateEntryTime(inst.exchange, time, nowMs());
    if (!check.ok) return reply.status(400).send({ error: check.error });
    const post = getTimeseriesPost();
    if (!post)
      return reply
        .status(503)
        .send({ error: "Broker session is not connected, so today's prices can't be read" });
    let bars: SecBar[];
    try {
      [bars] = await loadBars(post, check.date, [inst]);
    } catch (e) {
      return reply
        .status(502)
        .send({ error: `Could not read today's prices: ${(e as Error).message}` });
    }
    const hit = barAt(bars, check.sec);
    if (!hit) return reply.status(422).send({ error: 'no trade at or before that time today' });
    const vwap = minuteVwap(bars, check.sec);
    return reply.send({
      actual_time: formatHms(hit.bar.sec),
      exact: hit.exact,
      open: hit.bar.open,
      high: hit.bar.high,
      low: hit.bar.low,
      close: hit.bar.close,
      vwap,
      vwap_fallback: vwap == null,
    });
  });

  // ─── Place a backdated order ──────────────────────────────────────────────
  fastify.post<{
    Body: BackdatedLegBody & {
      entry_time?: string;
      price_source?: string;
      basket_group_id?: string;
      strategy_name?: string;
    };
  }>('/paper/backdated/order', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const body = req.body ?? ({} as BackdatedLegBody);
    const out = await enter([body], body.entry_time, body.price_source, {
      basketGroupId: body.basket_group_id,
      strategyName: body.strategy_name,
    });
    return reply.status(out.status).send(out.payload);
  });

  fastify.post<{
    Body: {
      orders?: BackdatedLegBody[];
      entry_time?: string;
      price_source?: string;
      strategy_name?: string;
      margin_required?: number;
      group_rule?: GroupRuleInput;
    };
  }>('/paper/backdated/basket', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const body = req.body ?? {};
    const out = await enter(body.orders ?? [], body.entry_time, body.price_source, {
      basketGroupId: `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      strategyName: body.strategy_name || undefined,
      marginRequired: typeof body.margin_required === 'number' ? body.margin_required : undefined,
      groupRule: body.group_rule,
    });
    return reply.status(out.status).send(out.payload);
  });

  // ─── Today's backdated entries (the Positions badge) ──────────────────────
  fastify.get('/paper/backdated', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    const now = nowMs();
    const rows = dbListBackdatedTrades(istSecondToEpochNs(istDateOf(now), 0));
    return reply.send({
      trades: rows.map((r) => ({
        order_id: r.order_id,
        ref_id: r.ref_id,
        basket_group_id: r.basket_group_id,
        entry_time: r.entry_label,
        price_source: r.price_source,
        exact: !!r.exact,
        fill_price: r.fill_price,
      })),
    });
  });

  // ─── Replay a rule added after a backdated entry ──────────────────────────
  // The rule editor saves through the ordinary PUT rule routes, which act live only. For a
  // backdated position the Positions tab calls this afterwards, so the history between entry and
  // now is checked once for that rule. A rule already replayed is not replayed again.
  fastify.post<{ Body: { ref_id?: number; basket_group_id?: string } }>(
    '/paper/backdated/replay-rules',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const refId = Number(req.body?.ref_id);
      const gid = req.body?.basket_group_id || '';
      if (!refId) return reply.status(400).send({ error: 'ref_id is required' });

      const now = nowMs();
      const date = istDateOf(now);
      const rows = dbListBackdatedTrades(istSecondToEpochNs(date, 0));
      const positions = simBroker.getPositions();
      const rules = listPositionRules();

      const groupRule = gid
        ? (rules.find((r) => r.scope === 'GROUP' && r.basket_group_id === gid) as
            GroupRule | undefined)
        : undefined;
      // A group rule is replayed over the whole group, so every open member must be backdated —
      // a live-entered member has no history this route can price.
      const members = positions.filter((p) =>
        gid ? (p.basket_group_id || '') === gid : p.ref_id === refId && !p.basket_group_id,
      );
      const rowFor = (ref: number) =>
        rows.filter((r) => r.ref_id === ref && (r.basket_group_id || '') === gid).at(-1);
      if (!members.length || !rowFor(refId))
        return reply.status(404).send({ error: 'no open backdated position for that ref_id' });

      const replayedOf = (ref: number): Record<string, string> => {
        try {
          return JSON.parse(rowFor(ref)?.replayed_json || '{}') as Record<string, string>;
        } catch {
          return {};
        }
      };
      const fresh = (key: string, rule: object, ref: number) =>
        replayedOf(ref)[key] !== JSON.stringify(rule);

      const legRules = rules.filter(
        (r): r is LegRule =>
          r.scope === 'LEG' &&
          (r.basket_group_id || '') === gid &&
          members.some((m) => m.ref_id === r.ref_id) &&
          !!rowFor(r.ref_id) &&
          fresh(legRuleKey(r.ref_id, r.basket_group_id), r, r.ref_id),
      );
      const allBackdated = members.every((m) => !!rowFor(m.ref_id));
      const replayGroup =
        groupRule && allBackdated && fresh(gid, groupRule, members[0].ref_id)
          ? groupRule
          : undefined;
      if (!legRules.length && !replayGroup) return reply.send({ replayed: false, exits: [] });

      const post = getTimeseriesPost();
      if (!post)
        return reply
          .status(503)
          .send({ error: "Broker session is not connected, so today's prices can't be read" });
      const replayMembers = members.filter((m) => !!rowFor(m.ref_id));
      let bars: SecBar[][];
      try {
        bars = await loadBars(
          post,
          date,
          replayMembers.map((m) => {
            const row = rowFor(m.ref_id)!;
            return { exchange: row.exchange, type: row.instrument_type, symbol: row.symbol };
          }),
        );
      } catch (e) {
        return reply
          .status(502)
          .send({ error: `Could not read today's prices: ${(e as Error).message}` });
      }

      const legs: ReplayLeg[] = replayMembers.map((m, i) => ({
        ref_id: m.ref_id,
        basket_group_id: gid,
        qty: m.qty,
        entryRs: m.avg_price / 100,
        entrySec: istSecondOfDay((m.entry_time ?? rowFor(m.ref_id)!.entry_time_ns) / 1_000_000),
        bars: bars[i],
      }));
      const exits = applyReplay(date, legs, legRules, replayGroup, istSecondOfDay(now));

      for (const m of replayMembers) {
        const row = rowFor(m.ref_id)!;
        const map = replayedOf(m.ref_id);
        for (const r of legRules) map[legRuleKey(r.ref_id, r.basket_group_id)] = JSON.stringify(r);
        if (replayGroup) map[gid] = JSON.stringify(replayGroup);
        dbSetBackdatedReplayed(row.order_id, JSON.stringify(map));
      }
      return reply.send({ replayed: true, exits });
    },
  );
}
