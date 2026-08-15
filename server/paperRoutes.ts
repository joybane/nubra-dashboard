import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  dbInsertBasket,
  dbLoadBaskets,
  dbDeleteBasket,
  dbUpdateBasket,
  dbRenameSavedBasket,
  dbUpsertSnapshot,
  dbListSnapshots,
  dbGetSnapshot,
  dbDeleteSnapshot,
} from './paperDb.ts';
import { calculateLocalBasketMargin, observeNubraMarginQuote } from './marginEngine.ts';
import {
  upsertLegRule,
  upsertGroupRule,
  deleteLegRule,
  deleteGroupRule,
  listPositionRules,
  sanitizeSLTarget,
  sanitizeExitTime,
  legRuleKey,
  type LegRule,
  type GroupRule,
  type SLTarget,
  type TrailStop,
} from './positionRules.ts';

type AuthStatus = 'idle' | 'awaiting_otp' | 'awaiting_mpin' | 'authenticated';

interface PlaceOrderInput {
  nubraName: string;
  liveRefId: number;
  display_name?: string;
  order_type: string;
  order_side: string;
  order_qty: number;
  order_price?: number;
  trigger_price?: number;
  order_delivery_type: string;
  validity_type: string;
  tag?: string;
  basket_group_id?: string;
  strategy_name?: string;
  margin_required?: number;
}

interface PaperPosition {
  ref_id: number;
  nubraName: string;
  display_name: string;
  qty: number;
  avg_price: number;
  realized_pnl: number;
  last_traded_price: number;
  order_delivery_type: string;
  basket_group_id?: string;
  strategy_name?: string;
  entry_time?: number;
  exit_time?: number;
  exit_price?: number;
  margin_required?: number;
  entry_qty?: number;
}

interface SimBrokerLike {
  getOrders: (filter: 'live' | 'executed' | 'all') => unknown[];
  placeOrder: (input: PlaceOrderInput) => { order_id: number };
  getPositions: () => PaperPosition[];
  getClosedPositions: () => PaperPosition[];
  modifyOrder: (id: number, patch: Record<string, unknown>) => boolean;
  cancelOrder: (id: number) => boolean;
  registerName: (name: string, refId: number) => void;
  renameStrategy: (basketGroupId: string, name: string) => boolean;
}

type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;
type NubraPostAt = (
  baseUrl: string,
  endpoint: string,
  body: object,
  extraHeaders?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface PaperRouteDeps {
  fastify: FastifyInstance;
  requireAuth: (reply: FastifyReply) => boolean;
  getAuthStatus: () => AuthStatus;
  getSessionToken: () => string | null;
  simBroker: SimBrokerLike;
  subscribeForSim: (
    nubraName: string,
    liveRefId: number,
    derivativeType?: string,
    asset?: string,
    expiry?: string,
    exchange?: string,
  ) => void;
  fireRules: (refId: number) => void;
  buildDebugResponse: () => Record<string, unknown>;
  nubraGet: NubraGet;
  nubraPostAt: NubraPostAt;
  marginBaseUrl: string;
}

export function registerPaperRoutes({
  fastify,
  requireAuth,
  getAuthStatus,
  getSessionToken,
  simBroker,
  subscribeForSim,
  fireRules,
  buildDebugResponse,
  nubraGet,
  nubraPostAt,
  marginBaseUrl,
}: PaperRouteDeps): void {
  const marginMarketDataBaseUrl = process.env.NUBRA_BASE_URL || 'https://api2.nubra.io';
  // ─── Paper Trading auth status ────────────────────────────────────────────────
  fastify.get('/paper/auth/status', async (_req, reply) => {
    return reply.send({
      status: getAuthStatus(),
      authenticated: getAuthStatus() === 'authenticated',
    });
  });

  // ─── Paper Trading routes (SimBroker — local simulation on live PROD data) ────

  fastify.get<{ Querystring: { live?: string; executed?: string } }>(
    '/paper/orders',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const filter = req.query.live ? 'live' : req.query.executed ? 'executed' : 'all';
      return reply.send(simBroker.getOrders(filter));
    },
  );

  interface PaperOrderBody {
    nubraName: string;
    liveRefId: number;
    display_name?: string;
    order_type: string;
    order_qty: number;
    order_side: string;
    order_delivery_type: string;
    validity_type: string;
    order_price?: number;
    trigger_price?: number;
    tag?: string;
    // For auto-subscription to the live option chain feed
    asset?: string;
    expiry?: string;
    exchange?: string;
    derivative_type?: string;
    basket_group_id?: string;
    strategy_name?: string;
  }

  fastify.post<{ Body: PaperOrderBody }>('/paper/orders', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const {
        nubraName,
        liveRefId,
        display_name,
        order_type,
        order_qty,
        order_side,
        order_delivery_type,
        validity_type,
        order_price,
        trigger_price,
        tag,
        asset,
        expiry,
        exchange,
        derivative_type,
        basket_group_id,
        strategy_name,
      } = req.body;
      if (!liveRefId)
        return reply.status(400).send({ error: 'liveRefId is required for live simulation.' });

      // Auto-subscribe option chain so fills happen against real-time prices
      subscribeForSim(nubraName, liveRefId, derivative_type, asset, expiry, exchange);

      const order = simBroker.placeOrder({
        nubraName,
        liveRefId,
        display_name,
        order_type,
        order_side,
        order_qty,
        order_price,
        trigger_price,
        order_delivery_type,
        validity_type,
        tag,
        basket_group_id,
        strategy_name,
      });
      return reply.send({ order_id: order.order_id });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  interface MultiOrderLeg {
    nubraName: string;
    liveRefId: number;
    display_name?: string;
    order_type: string;
    order_qty: number;
    order_side: string;
    order_delivery_type: string;
    validity_type: string;
    order_price?: number;
    trigger_price?: number;
    asset?: string;
    expiry?: string;
    exchange?: string;
    derivative_type?: string;
  }

  fastify.post<{ Body: { orders: MultiOrderLeg[] } }>('/paper/orders/multi', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      if (!Array.isArray(req.body?.orders) || req.body.orders.length === 0)
        return reply.status(400).send({ error: 'orders must be a non-empty array' });
      const results = req.body.orders.map((o) => {
        subscribeForSim(o.nubraName, o.liveRefId, o.derivative_type, o.asset, o.expiry, o.exchange);
        return simBroker.placeOrder({
          nubraName: o.nubraName,
          liveRefId: o.liveRefId,
          display_name: o.display_name,
          order_type: o.order_type,
          order_side: o.order_side,
          order_qty: o.order_qty,
          order_price: o.order_price,
          trigger_price: o.trigger_price,
          order_delivery_type: o.order_delivery_type,
          validity_type: o.validity_type,
        });
      });
      return reply.send({ orders: results.map((o) => ({ order_id: o.order_id })) });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ─── Position auto-exit rules (SL/Target/Trailing on live positions) ──────────

  fastify.get('/paper/positions/rules', async (req, reply) => {
    if (!requireAuth(reply)) return;
    return reply.send({ rules: listPositionRules() });
  });

  interface LegRuleBody {
    ref_id: number;
    basket_group_id?: string;
    stopLoss?: SLTarget;
    target?: SLTarget;
    trail?: TrailStop;
    exitTime?: string;
  }
  fastify.put<{ Body: LegRuleBody }>('/paper/positions/rules/leg', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { ref_id, basket_group_id, stopLoss, target, trail, exitTime } = req.body;
    if (!ref_id) return reply.status(400).send({ error: 'ref_id is required' });
    const rule: LegRule = {
      scope: 'LEG',
      ref_id,
      basket_group_id: basket_group_id || '',
      stopLoss: sanitizeSLTarget(stopLoss),
      target: sanitizeSLTarget(target),
      trail,
      exitTime: sanitizeExitTime(exitTime),
    };
    upsertLegRule(rule);
    // Evaluate straight away. Rules are otherwise only checked when routeTickToSim
    // sees the LTP *change*, so a level the price has already passed would sit idle
    // until the next differing tick — and never fire at all outside market hours.
    fireRules(ref_id);
    return reply.send({ ok: true, rule_key: legRuleKey(ref_id, basket_group_id) });
  });

  interface GroupRuleBody {
    basket_group_id: string;
    maxProfit?: number;
    maxLoss?: number;
    trail?: TrailStop;
    exitAllOnLegHit?: boolean;
    exitTime?: string;
  }
  fastify.put<{ Body: GroupRuleBody }>('/paper/positions/rules/group', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { basket_group_id, maxProfit, maxLoss, trail, exitAllOnLegHit, exitTime } = req.body;
    if (!basket_group_id) return reply.status(400).send({ error: 'basket_group_id is required' });
    const rule: GroupRule = {
      scope: 'GROUP',
      basket_group_id,
      maxProfit: maxProfit || undefined,
      maxLoss: maxLoss || undefined,
      trail,
      exitAllOnLegHit: exitAllOnLegHit || undefined,
      exitTime: sanitizeExitTime(exitTime),
    };
    upsertGroupRule(rule);
    // Same immediate evaluation as the leg route. evaluateAndFire keys off a
    // changed ref_id, so nominate any member of the group to stand in for the tick.
    const member = simBroker.getPositions().find((p) => p.basket_group_id === basket_group_id);
    if (member) fireRules(member.ref_id);
    return reply.send({ ok: true });
  });

  fastify.delete<{ Querystring: { ref_id?: string; basket_group_id?: string } }>(
    '/paper/positions/rules/leg',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const refId = Number(req.query.ref_id);
      if (!refId) return reply.status(400).send({ error: 'ref_id is required' });
      deleteLegRule(refId, req.query.basket_group_id);
      return reply.send({ ok: true });
    },
  );

  fastify.delete<{ Querystring: { basket_group_id?: string } }>(
    '/paper/positions/rules/group',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      if (!req.query.basket_group_id)
        return reply.status(400).send({ error: 'basket_group_id is required' });
      deleteGroupRule(req.query.basket_group_id);
      return reply.send({ ok: true });
    },
  );

  fastify.post('/paper/orders/basket', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const body = req.body as Record<string, unknown>;
      const legs = body.orders as Array<Record<string, unknown>>;
      if (!Array.isArray(legs) || legs.length === 0)
        return reply.status(400).send({ error: 'orders must be a non-empty array' });
      if (legs.some((l) => !l.liveRefId))
        return reply.status(400).send({ error: 'every leg must have a liveRefId' });
      const strategyName = (body.strategy_name as string) || undefined;
      const marginRequired =
        typeof body.margin_required === 'number' ? body.margin_required : undefined;
      const basketGroupId = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const results = legs.map((o) => {
        const nubraName = o.nubraName as string;
        const liveRefId = o.liveRefId as number;
        const asset = o.asset as string | undefined;
        const expiry = o.expiry as string | undefined;
        const derivType = o.derivative_type as string | undefined;
        const exchange = o.exchange as string | undefined;
        subscribeForSim(nubraName, liveRefId, derivType, asset, expiry, exchange);
        return simBroker.placeOrder({
          nubraName,
          liveRefId,
          display_name: o.display_name as string | undefined,
          order_type: o.order_type as string,
          order_side: o.order_side as string,
          order_qty: o.order_qty as number,
          order_price: o.order_price as number | undefined,
          trigger_price: o.trigger_price as number | undefined,
          order_delivery_type: o.order_delivery_type as string,
          validity_type: o.validity_type as string,
          tag: o.tag as string | undefined,
          basket_group_id: basketGroupId,
          strategy_name: strategyName,
          margin_required: marginRequired,
        });
      });
      return reply.send({
        orders: results.map((o) => ({ order_id: o.order_id })),
        basket_group_id: basketGroupId,
      });
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  interface ModifyOrderBody {
    order_price?: number;
    trigger_price?: number;
    order_qty?: number;
  }

  const MODIFIABLE_FIELDS = ['order_price', 'trigger_price', 'order_qty'] as const;

  fastify.post<{ Params: { id: string }; Body: ModifyOrderBody }>(
    '/paper/orders/modify/:id',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0)
        return reply.status(400).send({ error: 'order id must be a positive integer' });

      // Distinguish "nothing to change" from "the broker refused the change" up front, so the
      // 404 below can only ever mean the latter.
      const body = (req.body ?? {}) as ModifyOrderBody;
      const supplied = MODIFIABLE_FIELDS.filter((field) => body[field] != null);
      if (supplied.length === 0)
        return reply
          .status(400)
          .send({ error: `supply at least one of ${MODIFIABLE_FIELDS.join(', ')}` });
      const invalid = supplied.filter((field) => {
        const value = body[field];
        return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
      });
      if (invalid.length > 0)
        return reply
          .status(400)
          .send({ error: `${invalid.join(', ')} must be a non-negative number` });
      if (body.order_qty != null && body.order_qty <= 0)
        return reply.status(400).send({ error: 'order_qty must be greater than zero' });
      // Lots are whole. Without this the broker's Math.round would quietly turn 65.5 into 66 —
      // a silently different order from the one the caller asked for.
      if (body.order_qty != null && !Number.isInteger(body.order_qty))
        return reply.status(400).send({ error: 'order_qty must be a whole number' });

      // Rebuild from the validated fields rather than forwarding the raw body: anything the
      // client sent that is not modifiable has no business reaching the broker.
      const patch: Record<string, unknown> = {};
      for (const field of supplied) patch[field] = body[field];
      const ok = simBroker.modifyOrder(orderId, patch);
      if (!ok)
        return reply.status(404).send({ error: 'Order not found or already filled/cancelled.' });
      // The amendment can fill the order immediately against the last tick, so hand back the
      // order itself rather than a bare ack — the client would otherwise have to poll to notice.
      const updated = (simBroker.getOrders('all') as Array<{ order_id: number }>).find(
        (o) => o.order_id === orderId,
      );
      return reply.send({ ok: true, order: updated ?? null });
    },
  );

  fastify.delete<{ Params: { id: string } }>('/paper/orders/:id', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const ok = simBroker.cancelOrder(Number(req.params.id));
    if (!ok) return reply.status(404).send({ error: 'Order not found or cannot be cancelled.' });
    return reply.send({ ok: true });
  });

  fastify.get('/paper/positions', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    const positions = simBroker.getPositions().map((p) => {
      const ltp = p.last_traded_price || p.avg_price;
      const isLong = p.qty > 0;
      // p.qty is signed (negative = short), so this formula is correct for both directions:
      // Long: (ltp-avg)*qty_positive = profit when price rises ✓
      // Short: (ltp-avg)*qty_negative = loss when price rises ✓
      const unrealizedPnl = (ltp - p.avg_price) * p.qty;
      const totalPnl = unrealizedPnl + p.realized_pnl;
      // pnlChg as % of notional entry value — correctly signed for long/short
      const pnlChg =
        p.avg_price > 0 && p.qty !== 0
          ? (unrealizedPnl / (p.avg_price * Math.abs(p.qty))) * 100
          : 0;
      return {
        ref_id: p.ref_id,
        display_name: p.display_name,
        zanskar_name: p.nubraName,
        order_side: isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
        qty: Math.abs(p.qty),
        avg_price: p.avg_price,
        last_traded_price: ltp,
        pnl: Math.round(totalPnl),
        pnl_chg: parseFloat(pnlChg.toFixed(2)),
        unrealised_pnl: Math.round(unrealizedPnl),
        realised_pnl: Math.round(p.realized_pnl),
        product: p.order_delivery_type === 'ORDER_DELIVERY_TYPE_IDAY' ? 'MIS' : 'NRML',
        basket_group_id: p.basket_group_id || undefined,
        strategy_name: p.strategy_name || undefined,
        entry_time: p.entry_time || undefined,
        margin_required: p.margin_required || undefined,
      };
    });
    return reply.send(positions);
  });

  fastify.get('/paper/positions/closed', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    const closed = simBroker.getClosedPositions().map((p) => {
      const entryQty = p.entry_qty ?? 0;
      const priceDiff = Math.abs((p.exit_price || 0) - p.avg_price);
      const derivedQty =
        entryQty !== 0
          ? Math.abs(entryQty)
          : priceDiff > 0
            ? Math.round(Math.abs(p.realized_pnl) / priceDiff)
            : 0;
      const isLong =
        entryQty > 0 || (entryQty === 0 && p.realized_pnl > 0 && (p.exit_price || 0) > p.avg_price);
      return {
        ref_id: p.ref_id,
        display_name: p.display_name,
        zanskar_name: p.nubraName,
        order_side: isLong ? 'ORDER_SIDE_BUY' : 'ORDER_SIDE_SELL',
        qty: derivedQty,
        avg_price: p.avg_price,
        last_traded_price: p.last_traded_price,
        pnl: Math.round(p.realized_pnl),
        realised_pnl: Math.round(p.realized_pnl),
        product: p.order_delivery_type === 'ORDER_DELIVERY_TYPE_IDAY' ? 'MIS' : 'NRML',
        basket_group_id: p.basket_group_id || undefined,
        strategy_name: p.strategy_name || undefined,
        entry_time: p.entry_time || undefined,
        exit_time: p.exit_time || undefined,
        exit_price: p.exit_price || undefined,
        margin_required: p.margin_required || undefined,
      };
    });
    return reply.send(closed);
  });

  fastify.get('/paper/debug', async (_req, reply) => {
    return reply.send(buildDebugResponse());
  });

  fastify.get('/paper/holdings', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    // SimBroker is designed for intraday/derivative paper trading; holdings are always empty.
    return reply.send([]);
  });

  fastify.get('/paper/pnl', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    let realised = 0,
      unrealised = 0;
    for (const p of simBroker.getPositions()) {
      realised += p.realized_pnl;
      const ltp = p.last_traded_price || p.avg_price;
      unrealised += (ltp - p.avg_price) * p.qty;
    }
    for (const p of simBroker.getClosedPositions()) {
      realised += p.realized_pnl;
    }
    return reply.send({
      realised: Math.round(realised),
      unrealised: Math.round(unrealised),
      total: Math.round(realised + unrealised),
    });
  });

  interface MarginBody {
    liveRefId: number;
    order_qty: number;
    order_side: string;
    order_type: string;
    order_price?: number;
    order_delivery_type: string;
    exchange?: string;
    // Optional contract detail. The broker needs only the ref_id, but the local engine
    // cannot price a leg it cannot identify, so without these the order ticket has no
    // fallback at all and simply errors when the broker is unreachable.
    strike?: number;
    option_type?: string;
    expiry?: string;
    symbol?: string;
    lot_size?: number;
    ltp?: number;
  }

  interface BasketMarginBody {
    exchange?: string;
    orders: Array<{
      ref_id: number;
      order_qty: number;
      order_side: string;
      order_type: string;
      order_price?: number;
      order_delivery_type: string;
      strike?: number;
      option_type?: string;
      ltp?: number;
      lot_size?: number;
      expiry?: string;
      symbol?: string;
      /** Filled in server-side from the option chain; consumed by the local margin engine. */
      spot?: number;
      iv?: number;
      previous_close?: number;
      realized_vol?: number;
      market_data_as_of?: number;
      oi?: number;
      volume?: number;
      delta?: number;
      gamma?: number;
      theta?: number;
      vega?: number;
    }>;
  }

  /**
   * Nubra V3 rejects an order carrying more than one strategy tag:
   *   "an order may carry at most one strategy tag, but this request would leave it
   *    with 2: [nubra-dashboard, single-margin]"
   * That HTTP 400 is what made the margin API look dead — it was never the static IP.
   * One tag, everywhere.
   */
  const STRAT_TAG = 'nubra-dashboard';

  function v3Side(side: string | undefined): 'BUY' | 'SELL' {
    return (side || '').includes('SELL') ? 'SELL' : 'BUY';
  }

  function v3Delivery(delivery: string | undefined): 'IDAY' | 'CNC' {
    return (delivery || '').includes('IDAY') ? 'IDAY' : 'CNC';
  }

  function readNumber(source: Record<string, unknown>, paths: string[]): number {
    for (const path of paths) {
      let cur: unknown = source;
      for (const key of path.split('.')) {
        if (!cur || typeof cur !== 'object') {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[key];
      }
      const n = Number(cur);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  function normalizeMarginResponse(data: Record<string, unknown>): Record<string, unknown> {
    const multiplier = 1.0; // remove the buffer to match raw broker margins exactly
    // `marginInfo.totalMargin` is the margin the exchange actually blocks;
    // `totalFundsRequired` is that plus brokerage/STT/GST, so it must stay a fallback —
    // reading it first inflated every broker figure by the charges (₹2.8k on a NIFTY lot).
    const totalMargin = readNumber(data, [
      'total_margin',
      'marginInfo.totalMargin',
      'totalMargin',
      'data.total_margin',
      'data.totalMargin',
      'totalFundsRequired',
    ]);
    const marginBenefit = readNumber(data, [
      'margin_benefit',
      'marginBenefit',
      'marginBenefitAmount',
      'benefit',
      'marginInfo.marginBenefit',
      'marginInfo.margin_benefit',
      'data.margin_benefit',
      'data.marginBenefit',
    ]);
    const span = readNumber(data, [
      'span',
      'span_margin',
      'spanMargin',
      'marginInfo.span',
      'data.span',
    ]);
    const exposure = readNumber(data, [
      'exposure',
      'exposure_margin',
      'exposureMargin',
      'marginInfo.exposure',
      'data.exposure',
    ]);

    return {
      ...data,
      total_margin: Math.round(totalMargin * multiplier),
      span: Math.round(span * multiplier),
      exposure: Math.round(exposure * multiplier),
      opt_prem: readNumber(data, [
        'opt_prem',
        'option_premium',
        'premium',
        'premiumPayable',
        'marginInfo.optPrem',
        'data.opt_prem',
      ]),
      margin_benefit: Math.round(marginBenefit * multiplier),
      leg_margin:
        data.leg_margin ||
        data.legMargin ||
        (data.data as Record<string, unknown> | undefined)?.leg_margin ||
        null,
      message: ((data.marginInfo as Record<string, unknown> | undefined)?.message ||
        data.message ||
        null) as unknown,
    };
  }

  function singleV3Order(o: BasketMarginBody['orders'][number]): Record<string, unknown> {
    return {
      refId: o.ref_id,
      qty: o.order_qty,
      side: v3Side(o.order_side),
      deliveryType: v3Delivery(o.order_delivery_type),
      priceType: o.order_price ? 'LIMIT' : 'MARKET',
      validityType: 'IOC',
      isMultiLeg: false,
      executionMode: 'ENTRY',
      entryPrice: o.order_price ?? 0,
      stratTags: [STRAT_TAG],
    };
  }

  function greatestCommonDivisor(a: number, b: number): number {
    let left = Math.abs(Math.round(a));
    let right = Math.abs(Math.round(b));
    while (right) [left, right] = [right, left % right];
    return Math.max(1, left);
  }

  function buildV3MarginOrders(
    orders: BasketMarginBody['orders'],
    exchange: string,
  ): Array<Record<string, unknown>> {
    if (orders.length <= 1) return [singleV3Order(orders[0])];

    // MCX rejects the multi-leg ("Flexi") shape outright — "Strategy Flexi is not
    // supported in MCX" — so a commodity basket is quoted as independent single orders
    // in one request instead. The broker still prices them together; what is lost is
    // only the cross-leg netting the Flexi wrapper would have expressed, and MCX SPAN
    // nets by underlying anyway.
    if (exchange.toUpperCase() === 'MCX') return orders.map(singleV3Order);

    const quantities = orders.map((order) => Math.max(1, Math.round(Number(order.order_qty || 1))));
    const baseQty = quantities.reduce(greatestCommonDivisor);
    const first = orders[0];
    return [
      {
        isMultiLeg: true,
        qty: baseQty,
        side: 'BUY',
        deliveryType: v3Delivery(first?.order_delivery_type),
        priceType: 'MARKET',
        validityType: 'IOC',
        executionMode: 'ENTRY',
        entryPrice: 0,
        legs: orders.map((o) => {
          const multiplier = Math.max(1, Math.round(Number(o.order_qty || baseQty) / baseQty));
          const isSell = (o.order_side || '').includes('SELL');
          return {
            refId: o.ref_id,
            unitQty: isSell ? -multiplier : multiplier,
          };
        }),
        stratTags: [STRAT_TAG],
      },
    ];
  }

  function parseExpiryToYYYYMMDD(exp: string | undefined): string | null {
    if (!exp) return null;
    const clean = exp.trim();
    if (/^\d{8}$/.test(clean)) return clean;
    const parts = clean.split(/\s+/);
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0');
      const monthStr = parts[1].toLowerCase();
      const yearSuffix = parts[2];
      const year = yearSuffix.length === 2 ? '20' + yearSuffix : yearSuffix;
      const months: Record<string, string> = {
        jan: '01',
        feb: '02',
        mar: '03',
        apr: '04',
        may: '05',
        jun: '06',
        jul: '07',
        aug: '08',
        sep: '09',
        oct: '10',
        nov: '11',
        dec: '12',
      };
      const month = months[monthStr.slice(0, 3)];
      if (month && day && year) {
        return `${year}${month}${day}`;
      }
    }
    try {
      const d = new Date(clean);
      if (!isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}${mm}${dd}`;
      }
    } catch {}
    return clean;
  }

  interface MarginHistoryState {
    previousClose: number;
    realizedVolPct: number;
    expiresAt: number;
  }

  const marginHistoryCache = new Map<string, MarginHistoryState>();
  const marginIndexSymbols = new Set([
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'MIDCPNIFTY',
    'NIFTYNXT50',
    'SENSEX',
    'BANKEX',
    'SENSEX50',
  ]);

  function feedPriceInRupees(raw: unknown, reference?: number): number {
    const value = Number(raw);
    if (!(value > 0)) return 0;
    if (reference && reference > 0) {
      const directDistance = Math.abs(Math.log(value / reference));
      const paiseDistance = Math.abs(Math.log(value / 100 / reference));
      return paiseDistance < directDistance ? value / 100 : value;
    }
    return value > 10_000 ? value / 100 : value;
  }

  function feedTimestampMs(raw: unknown): number | null {
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      if (value > 1e17) return value / 1e6; // nanoseconds
      if (value > 1e14) return value / 1e3; // microseconds
      if (value > 1e12) return value; // milliseconds
      if (value > 1e9) return value * 1000; // seconds
    }
    const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  }

  function istDateKey(ms: number): string {
    return new Date(ms + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function collectHistoricalCloses(
    data: Record<string, unknown>,
    spotReference: number,
  ): Array<{ ts: number; close: number }> {
    const points: Array<{ ts: number; close: number }> = [];
    const result = Array.isArray(data.result) ? data.result : [];
    for (const group of result as Array<Record<string, unknown>>) {
      const values = Array.isArray(group.values) ? group.values : [];
      for (const row of values as Array<Record<string, unknown>>) {
        for (const series of Object.values(row)) {
          if (!series || typeof series !== 'object') continue;
          const closes = (series as Record<string, unknown>).close;
          if (!Array.isArray(closes)) continue;
          for (const point of closes as Array<Record<string, unknown>>) {
            const ts = feedTimestampMs(point.ts);
            const close = feedPriceInRupees(point.v, spotReference);
            if (ts != null && close > 0) points.push({ ts, close });
          }
        }
      }
    }
    return points.sort((a, b) => a.ts - b.ts);
  }

  function realizedVolatility(closes: number[]): number {
    const sample = closes.slice(-21);
    if (sample.length < 6) return 0;
    const returns: number[] = [];
    for (let i = 1; i < sample.length; i++) {
      if (sample[i - 1] > 0 && sample[i] > 0) returns.push(Math.log(sample[i] / sample[i - 1]));
    }
    if (returns.length < 5) return 0;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
      Math.max(1, returns.length - 1);
    return Math.sqrt(variance) * Math.sqrt(252) * 100;
  }

  function withMarginFeedTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('market-history request timed out')),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function loadMarginHistory(
    symbol: string,
    exchange: string,
    spotReference: number,
  ): Promise<MarginHistoryState | null> {
    const normalizedSymbol = symbol.toUpperCase();
    const key = `${exchange.toUpperCase()}:${normalizedSymbol}`;
    const cached = marginHistoryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;

    const end = new Date();
    const start = new Date(end.getTime() - 45 * 24 * 60 * 60 * 1000);
    const type =
      exchange.toUpperCase() === 'MCX'
        ? 'FUT'
        : marginIndexSymbols.has(normalizedSymbol)
          ? 'INDEX'
          : 'STOCK';
    try {
      const data = await withMarginFeedTimeout(
        nubraPostAt(
          marginMarketDataBaseUrl,
          '/charts/timeseries',
          {
            query: [
              {
                exchange,
                type,
                values: [normalizedSymbol],
                fields: ['close'],
                startDate: start.toISOString(),
                endDate: end.toISOString(),
                interval: '1d',
                intraDay: false,
                realTime: false,
              },
            ],
          },
          { Authorization: `Bearer ${getSessionToken()!}` },
        ),
      );
      const points = collectHistoricalCloses(data, spotReference);
      const today = istDateKey(end.getTime());
      const completed = points.filter((point) => istDateKey(point.ts) < today);
      const usable = completed.length ? completed : points;
      const previousClose = usable.at(-1)?.close ?? 0;
      const realizedVolPct = realizedVolatility(usable.map((point) => point.close));
      if (!(previousClose > 0) || !(realizedVolPct > 0)) return null;
      const state = {
        previousClose,
        realizedVolPct,
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
      marginHistoryCache.set(key, state);
      return state;
    } catch (error) {
      console.warn(`[margin-feed] history unavailable for ${key}:`, (error as Error).message);
      return null;
    }
  }

  async function enrichOrdersWithMarginHistory(
    orders: BasketMarginBody['orders'],
    exchange: string,
  ): Promise<void> {
    const groups = new Map<string, BasketMarginBody['orders']>();
    for (const order of orders) {
      if (!order.symbol || !(Number(order.spot) > 0)) continue;
      const key = order.symbol.toUpperCase();
      const group = groups.get(key);
      if (group) group.push(order);
      else groups.set(key, [order]);
    }
    await Promise.all(
      [...groups.entries()].map(async ([symbol, group]) => {
        const history = await loadMarginHistory(symbol, exchange, Number(group[0].spot));
        if (!history) return;
        for (const order of group) {
          order.previous_close = history.previousClose;
          order.realized_vol = history.realizedVolPct;
        }
      }),
    );
  }

  /**
   * Fill each order in place with the live ref_id, LTP, IV and underlying spot from the
   * option chain, and return the resolved leg detail for the client. The local margin
   * engine prices from exactly these fields, so without this it would be working off
   * whatever stale (or absent) values the client sent.
   */
  async function resolveOrdersFromChain(
    orders: BasketMarginBody['orders'],
    exchange: string,
  ): Promise<Array<Record<string, unknown>>> {
    const resolvedLegs: Array<Record<string, unknown>> = [];
    const chainCache = new Map<string, any>();

    for (const o of orders) {
      const cleanExpiry = parseExpiryToYYYYMMDD(o.expiry);
      if (o.symbol && cleanExpiry && o.strike && o.option_type) {
        const cacheKey = `${o.symbol}__${cleanExpiry}`;
        let chain = chainCache.get(cacheKey);
        if (!chain) {
          try {
            const resData = await nubraGet(`/optionchains/${o.symbol}`, {
              exchange,
              expiry: cleanExpiry,
            });
            chain = resData.chain || resData;
            chainCache.set(cacheKey, chain);
          } catch (e: any) {
            console.warn(`[basket-margin] failed to load optionchain for ${cacheKey}:`, e.message);
          }
        }
        if (chain) {
          const list = (o.option_type.toUpperCase() === 'CE' ? chain.ce : chain.pe) || [];
          // Option-chain spot is always paise, including stocks below Rs 100 where a
          // magnitude heuristic would otherwise misread 5,000 paise as Rs 5,000.
          const chainSpotRaw = Number(chain.cp ?? chain.currentprice ?? 0);
          const chainSpot = chainSpotRaw > 0 ? chainSpotRaw / 100 : 0;
          const targetStrike = feedPriceInRupees(o.strike, chainSpot || undefined);
          const matched = list.find((c: any) => {
            const strike = feedPriceInRupees(c.sp, chainSpot || undefined);
            return targetStrike > 0 && Math.abs(strike - targetStrike) < 0.005;
          });
          if (matched) {
            o.ref_id = Number(matched.ref_id || matched.refId);
            const rawSpot = chainSpot;
            if (rawSpot > 0) o.spot = rawSpot;
            // REST refdata/order-ticket strikes may be paise while basket strikes are
            // rupees. Resolve against spot so the local engine always receives rupees.
            const normalizedStrike = feedPriceInRupees(matched.sp, rawSpot || undefined);
            if (normalizedStrike > 0) o.strike = normalizedStrike;
            // Feed the freshly resolved market data back onto the order itself, not only
            // into resolvedLegs. The local margin engine prices from these fields and
            // would otherwise use whatever stale (or absent) values the client sent.
            const freshLtp = matched.ltp != null ? Number(matched.ltp) / 100 : 0;
            if (freshLtp > 0) o.ltp = freshLtp;
            // The chain reports IV as a decimal (0.1905); the margin engine wants percent.
            if (matched.iv != null && Number(matched.iv) > 0) o.iv = Number(matched.iv) * 100;
            const previousClose = feedPriceInRupees(
              chain.prev_close ??
                chain.prevClose ??
                chain.previous_close ??
                chain.previousClose ??
                chain.pc,
              rawSpot || undefined,
            );
            if (previousClose > 0) o.previous_close = previousClose;
            o.market_data_as_of = feedTimestampMs(matched.ts) ?? Date.now();
            if (matched.oi != null) o.oi = Number(matched.oi);
            if (matched.volume != null) o.volume = Number(matched.volume);
            if (matched.delta != null) o.delta = Number(matched.delta);
            if (matched.gamma != null) o.gamma = Number(matched.gamma);
            if (matched.theta != null) o.theta = Number(matched.theta);
            if (matched.vega != null) o.vega = Number(matched.vega);
            resolvedLegs.push({
              strike: normalizedStrike || o.strike,
              optionType: o.option_type,
              expiry: o.expiry,
              refId: o.ref_id,
              ltp: matched.ltp ? Number(matched.ltp) / 100 : o.ltp || 0,
              iv: matched.iv != null ? Number(matched.iv) : null,
              delta: matched.delta != null ? Number(matched.delta) : null,
              gamma: matched.gamma != null ? Number(matched.gamma) : null,
              theta: matched.theta != null ? Number(matched.theta) : null,
              vega: matched.vega != null ? Number(matched.vega) : null,
              oi: matched.oi != null ? Number(matched.oi) : null,
              volume: matched.volume != null ? Number(matched.volume) : null,
              spot: rawSpot || null,
              previousClose: previousClose || null,
              asOf: o.market_data_as_of,
              nubraName: String(matched.zanskar_name || matched.nubra_name || matched.symbol || ''),
              lotSize: Number(matched.ls || matched.lot_size || o.lot_size || 1),
            });
            if (matched.symbol || matched.zanskar_name || matched.nubra_name) {
              const name = String(
                matched.zanskar_name || matched.nubra_name || matched.symbol || '',
              );
              simBroker.registerName(name, o.ref_id);
            }
          }
        }
      }
    }
    return resolvedLegs;
  }

  fastify.post<{ Body: BasketMarginBody }>('/paper/margin/basket', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { exchange = 'NSE', orders } = req.body as BasketMarginBody & { multiplier?: number };
      if (!Array.isArray(orders) || orders.length === 0)
        return reply.status(400).send({ error: 'orders must be non-empty' });

      const resolvedLegs = await resolveOrdersFromChain(orders, exchange);

      const v3Payload = {
        requestType: 'NEW',
        orders: buildV3MarginOrders(orders, exchange),
      };
      console.log('[basket-margin-v3] request:', JSON.stringify(v3Payload));
      try {
        const v3Data = await nubraPostAt(
          marginBaseUrl,
          '/sentinel/orders/funds_required',
          v3Payload,
          { Authorization: `Bearer ${getSessionToken()!}` },
        );
        const normalized = normalizeMarginResponse(v3Data);
        console.log('[basket-margin-v3] response:', JSON.stringify(normalized));
        if (Number(normalized.total_margin ?? 0) > 0) {
          observeNubraMarginQuote(orders, Number(normalized.total_margin), exchange);
          return reply.send({
            ...normalized,
            resolved_legs: resolvedLegs,
            estimated: false,
            source: 'nubra-margin-api',
            confidence: 'authoritative',
            as_of: new Date().toISOString(),
          });
        }
        throw new Error('Broker returned no total margin.');
      } catch (err) {
        const v3Error = (err as Error).message;
        await enrichOrdersWithMarginHistory(orders, exchange);
        const localMargin = calculateLocalBasketMargin(orders, undefined, undefined, exchange, {
          conservative: true,
        });
        if (localMargin && Number(localMargin.total_margin || 0) > 0) {
          const normalizedLocal = normalizeMarginResponse(localMargin as any);
          console.warn(
            '[basket-margin] broker unavailable, using local margin:',
            JSON.stringify({
              source: localMargin.source,
              total_margin: normalizedLocal.total_margin,
              broker_error: `V3: ${v3Error}`,
            }),
          );
          return reply.send({
            ...normalizedLocal,
            resolved_legs: resolvedLegs,
            broker_error: `Broker margin unavailable. V3: ${v3Error}`,
          });
        }
        return reply.status(502).send({
          error: `Broker margin unavailable. V3: ${v3Error}`,
        });
      }
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ─── Saved Baskets CRUD ─────────────────────────────────────────────────────

  fastify.get('/paper/baskets', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    const baskets = dbLoadBaskets().map((b) => {
      // One unparseable row used to 500 the whole list, taking every healthy basket with it.
      // An empty leg list is visibly broken in the UI; a dead endpoint is not diagnosable at all.
      let legs: unknown = [];
      try {
        legs = JSON.parse(b.legs_json);
      } catch {
        console.warn(`[baskets] ${b.basket_id} has unparseable legs_json — serving it empty`);
      }
      return { ...b, legs, legs_json: undefined };
    });
    return reply.send({ baskets });
  });

  fastify.post<{
    Body: {
      name: string;
      symbol: string;
      expiry: string;
      legs: unknown[];
      basket_group_id?: string;
    };
  }>('/paper/baskets', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { name, symbol, expiry, legs, basket_group_id } = req.body ?? {};
    // These four columns are NOT NULL. Without this check a malformed body reached better-sqlite3
    // and came back as an opaque 500 from the driver rather than a 400 naming the missing field.
    if (typeof name !== 'string' || !name.trim())
      return reply.status(400).send({ error: 'name is required' });
    if (typeof symbol !== 'string' || !symbol.trim())
      return reply.status(400).send({ error: 'symbol is required' });
    if (typeof expiry !== 'string' || !expiry.trim())
      return reply.status(400).send({ error: 'expiry is required' });
    if (!Array.isArray(legs) || legs.length === 0)
      return reply.status(400).send({ error: 'legs must be a non-empty array' });
    const basketId = `bsk_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    dbInsertBasket({
      basket_id: basketId,
      name,
      symbol,
      expiry,
      legs_json: JSON.stringify(legs),
      created_at: now,
      updated_at: now,
      basket_group_id: basket_group_id || undefined,
    });
    return reply.send({ basket_id: basketId });
  });

  fastify.delete<{ Params: { id: string } }>('/paper/baskets/:id', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const ok = dbDeleteBasket(req.params.id);
    if (!ok) return reply.status(404).send({ error: 'Basket not found' });
    return reply.send({ ok: true });
  });

  fastify.put<{ Params: { id: string }; Body: { name?: string; legs?: unknown[] } }>(
    '/paper/baskets/:id',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const { name, legs } = req.body;
      if (name?.trim()) {
        const result = dbRenameSavedBasket(req.params.id, name.trim());
        if (result.basket_group_id) simBroker.renameStrategy(result.basket_group_id, name.trim());
      }
      if (legs) {
        const existing = dbLoadBaskets().find((b) => b.basket_id === req.params.id);
        if (existing) dbUpdateBasket(req.params.id, existing.name, JSON.stringify(legs));
      }
      return reply.send({ ok: true });
    },
  );

  fastify.put<{ Body: { basket_group_id: string; name: string } }>(
    '/paper/strategy/rename',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const { basket_group_id, name } = req.body;
      if (!basket_group_id || !name?.trim())
        return reply.status(400).send({ error: 'basket_group_id and name required' });
      const ok = simBroker.renameStrategy(basket_group_id, name.trim());
      if (!ok) return reply.status(404).send({ error: 'No orders/positions found for this group' });
      return reply.send({ ok: true });
    },
  );

  // ─── Strategy snapshots (frozen day-charts) ───────────────────────────────────
  interface SnapshotBody {
    basket_group_id: string;
    trade_date: string;
    strategy_name?: string;
    underlying?: string;
    total_pnl?: number;
    leg_count?: number;
    source?: string;
    data: unknown;
  }

  // Every other /paper route is behind requireAuth; the four snapshot routes were not, which left
  // the one store on this server that accepts an arbitrary-sized JSON blob as its only unguarded
  // writer. The guard asks whether a broker session exists, so this changes nothing for a
  // logged-in user and closes the inconsistency for everyone else.
  fastify.post<{ Body: SnapshotBody }>('/paper/strategy/snapshot', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const b = req.body;
    if (!b?.basket_group_id || !b?.trade_date || b.data == null) {
      return reply.status(400).send({ error: 'basket_group_id, trade_date and data required' });
    }
    const snapshot_id = `${b.basket_group_id}__${b.trade_date}`;
    try {
      dbUpsertSnapshot({
        snapshot_id,
        basket_group_id: b.basket_group_id,
        strategy_name: b.strategy_name ?? null,
        underlying: b.underlying ?? null,
        trade_date: b.trade_date,
        total_pnl: b.total_pnl ?? 0,
        leg_count: b.leg_count ?? 0,
        source: b.source ?? 'manual',
        data_json: JSON.stringify(b.data),
      });
      return reply.send({ ok: true, snapshot_id });
    } catch (err: unknown) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get('/paper/strategy/snapshots', async (_req, reply) => {
    if (!requireAuth(reply)) return;
    return reply.send({ snapshots: dbListSnapshots() });
  });

  fastify.get<{ Params: { id: string } }>('/paper/strategy/snapshot/:id', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const row = dbGetSnapshot(req.params.id);
    if (!row) return reply.status(404).send({ error: 'snapshot not found' });
    let data: unknown = null;
    try {
      data = JSON.parse(row.data_json);
    } catch {
      /* corrupt blob → null */
    }
    const { data_json: _omit, ...meta } = row;
    return reply.send({ ...meta, data });
  });

  fastify.delete<{ Params: { id: string } }>('/paper/strategy/snapshot/:id', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const ok = dbDeleteSnapshot(req.params.id);
    if (!ok) return reply.status(404).send({ error: 'snapshot not found' });
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: MarginBody }>('/paper/margin', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const {
        liveRefId,
        order_qty,
        order_side,
        order_type,
        order_price,
        order_delivery_type,
        exchange = 'NSE',
      } = req.body;
      // Nubra API: ORDER_TYPE_MARKET is deprecated — use REGULAR + price_type
      const isMarket = order_type === 'ORDER_TYPE_MARKET' || !order_price;
      const priceType = isMarket ? 'MARKET' : 'LIMIT';
      const v3Payload = {
        requestType: 'NEW',
        orders: [
          {
            refId: liveRefId,
            qty: order_qty,
            side: v3Side(order_side),
            deliveryType: v3Delivery(order_delivery_type),
            priceType,
            // "Use a Limit Order for Day validity." — the broker rejects MARKET+DAY
            // outright, which 502'd every single-order margin quote. Validity does not
            // change the figure; IOC is what the basket route has always sent.
            validityType: isMarket ? 'IOC' : 'DAY',
            isMultiLeg: false,
            executionMode: 'ENTRY',
            entryPrice: order_price ?? 0,
            stratTags: [STRAT_TAG],
          },
        ],
      };
      console.log('[margin-v3] request:', JSON.stringify(v3Payload));
      try {
        const v3Data = await nubraPostAt(
          marginBaseUrl,
          '/sentinel/orders/funds_required',
          v3Payload,
          { Authorization: `Bearer ${getSessionToken()!}` },
        );
        const normalized = normalizeMarginResponse(v3Data);
        console.log('[margin-v3] response:', JSON.stringify(normalized));
        if (Number(normalized.total_margin ?? 0) > 0) {
          return reply.send({
            ...normalized,
            estimated: false,
            source: 'nubra-margin-api',
            confidence: 'authoritative',
            as_of: new Date().toISOString(),
          });
        }
        throw new Error('Broker returned no total margin.');
      } catch (err) {
        const v3Error = (err as Error).message;
        // Same fallback the basket route has always had. It needs the contract detail the
        // client optionally sends; with only a ref_id there is nothing to price.
        const { strike, option_type, expiry, symbol, lot_size, ltp } = req.body;
        if (strike && option_type && symbol) {
          const orders = [
            {
              ref_id: liveRefId,
              order_qty,
              order_side,
              order_type,
              order_price,
              order_delivery_type,
              strike,
              option_type,
              expiry,
              symbol,
              lot_size,
              ltp,
            },
          ];
          await resolveOrdersFromChain(orders, exchange);
          await enrichOrdersWithMarginHistory(orders, exchange);
          const localMargin = calculateLocalBasketMargin(orders, symbol, undefined, exchange, {
            conservative: true,
          });
          if (localMargin && Number(localMargin.total_margin || 0) > 0) {
            console.warn(
              '[margin] broker unavailable, using local margin:',
              JSON.stringify({ source: localMargin.source, broker_error: `V3: ${v3Error}` }),
            );
            return reply.send({
              ...normalizeMarginResponse(localMargin as any),
              broker_error: `Broker margin unavailable. V3: ${v3Error}`,
            });
          }
        }
        return reply.status(502).send({ error: `Broker margin unavailable. V3: ${v3Error}` });
      }
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
