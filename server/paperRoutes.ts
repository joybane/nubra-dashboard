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
import { calculateLocalBasketMargin } from './marginEngine.ts';
import {
  upsertLegRule,
  upsertGroupRule,
  deleteLegRule,
  deleteGroupRule,
  listPositionRules,
  sanitizeSLTarget,
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
        derivative_type,
        basket_group_id,
        strategy_name,
      } = req.body;
      if (!liveRefId)
        return reply.status(400).send({ error: 'liveRefId is required for live simulation.' });

      // Auto-subscribe option chain so fills happen against real-time prices
      subscribeForSim(nubraName, liveRefId, derivative_type, asset, expiry);

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
    derivative_type?: string;
  }

  fastify.post<{ Body: { orders: MultiOrderLeg[] } }>('/paper/orders/multi', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      if (!Array.isArray(req.body?.orders) || req.body.orders.length === 0)
        return reply.status(400).send({ error: 'orders must be a non-empty array' });
      const results = req.body.orders.map((o) => {
        subscribeForSim(o.nubraName, o.liveRefId, o.derivative_type, o.asset, o.expiry);
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
  }
  fastify.put<{ Body: LegRuleBody }>('/paper/positions/rules/leg', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { ref_id, basket_group_id, stopLoss, target, trail } = req.body;
    if (!ref_id) return reply.status(400).send({ error: 'ref_id is required' });
    const rule: LegRule = {
      scope: 'LEG',
      ref_id,
      basket_group_id: basket_group_id || '',
      stopLoss: sanitizeSLTarget(stopLoss),
      target: sanitizeSLTarget(target),
      trail,
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
  }
  fastify.put<{ Body: GroupRuleBody }>('/paper/positions/rules/group', async (req, reply) => {
    if (!requireAuth(reply)) return;
    const { basket_group_id, maxProfit, maxLoss, trail, exitAllOnLegHit } = req.body;
    if (!basket_group_id) return reply.status(400).send({ error: 'basket_group_id is required' });
    const rule: GroupRule = {
      scope: 'GROUP',
      basket_group_id,
      maxProfit: maxProfit || undefined,
      maxLoss: maxLoss || undefined,
      trail,
      exitAllOnLegHit: exitAllOnLegHit || undefined,
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
        subscribeForSim(nubraName, liveRefId, derivType, asset, expiry);
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

  fastify.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/paper/orders/modify/:id',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      const ok = simBroker.modifyOrder(Number(req.params.id), req.body);
      if (!ok)
        return reply.status(404).send({ error: 'Order not found or already filled/cancelled.' });
      return reply.send({ ok: true });
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
    }>;
  }

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
    const totalMargin = readNumber(data, [
      'total_margin',
      'totalMargin',
      'totalFundsRequired',
      'marginInfo.totalMargin',
      'data.total_margin',
      'data.totalMargin',
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

  function buildV3MarginOrders(orders: BasketMarginBody['orders']): Array<Record<string, unknown>> {
    if (orders.length <= 1) {
      const o = orders[0];
      return [
        {
          refId: o.ref_id,
          qty: o.order_qty,
          side: v3Side(o.order_side),
          deliveryType: v3Delivery(o.order_delivery_type),
          priceType: o.order_price ? 'LIMIT' : 'MARKET',
          validityType: 'IOC',
          isMultiLeg: false,
          executionMode: 'ENTRY',
          entryPrice: o.order_price ?? 0,
          stratTags: ['nubra-dashboard', 'single-margin'],
        },
      ];
    }

    const baseQty = Math.max(
      1,
      Math.min(...orders.map((o) => Math.max(1, Number(o.order_qty || 1)))),
    );
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
        stratTags: ['nubra-dashboard', 'basket-margin'],
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

  fastify.post<{ Body: BasketMarginBody }>('/paper/margin/basket', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { exchange = 'NSE', orders } = req.body as BasketMarginBody & { multiplier?: number };
      if (!Array.isArray(orders) || orders.length === 0)
        return reply.status(400).send({ error: 'orders must be non-empty' });

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
              console.warn(
                `[basket-margin] failed to load optionchain for ${cacheKey}:`,
                e.message,
              );
            }
          }
          if (chain) {
            const list = (o.option_type.toUpperCase() === 'CE' ? chain.ce : chain.pe) || [];
            const matched = list.find((c: any) => {
              const sp = Number(c.sp);
              return o.strike != null && (sp === o.strike || sp === o.strike * 100);
            });
            if (matched) {
              o.ref_id = Number(matched.ref_id || matched.refId);
              // Feed the freshly resolved market data back onto the order itself, not only
              // into resolvedLegs. The local margin engine prices from these fields and
              // would otherwise use whatever stale (or absent) values the client sent.
              const freshLtp = matched.ltp != null ? Number(matched.ltp) / 100 : 0;
              if (freshLtp > 0) o.ltp = freshLtp;
              // The chain reports IV as a decimal (0.1905); the margin engine wants percent.
              if (matched.iv != null && Number(matched.iv) > 0) o.iv = Number(matched.iv) * 100;
              const rawSpot = Number(chain.cp ?? chain.currentprice ?? 0) / 100; // cp is paise
              if (rawSpot > 0) o.spot = rawSpot;
              resolvedLegs.push({
                strike: o.strike,
                optionType: o.option_type,
                expiry: o.expiry,
                refId: o.ref_id,
                ltp: matched.ltp ? Number(matched.ltp) / 100 : o.ltp || 0,
                iv: matched.iv != null ? Number(matched.iv) : null,
                delta: matched.delta != null ? Number(matched.delta) : null,
                gamma: matched.gamma != null ? Number(matched.gamma) : null,
                theta: matched.theta != null ? Number(matched.theta) : null,
                vega: matched.vega != null ? Number(matched.vega) : null,
                nubraName: String(
                  matched.zanskar_name || matched.nubra_name || matched.symbol || '',
                ),
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

      const v3Payload = {
        requestType: 'NEW',
        orders: buildV3MarginOrders(orders),
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
        if (Number(normalized.total_margin ?? 0) > 0)
          return reply.send({ ...normalized, resolved_legs: resolvedLegs });
        throw new Error('Broker returned no total margin.');
      } catch (err) {
        const v3Error = (err as Error).message;
        const localMargin = calculateLocalBasketMargin(orders);
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
    const baskets = dbLoadBaskets().map((b) => ({
      ...b,
      legs: JSON.parse(b.legs_json),
      legs_json: undefined,
    }));
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
    const { name, symbol, expiry, legs, basket_group_id } = req.body;
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

  fastify.post<{ Body: SnapshotBody }>('/paper/strategy/snapshot', async (req, reply) => {
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
    return reply.send({ snapshots: dbListSnapshots() });
  });

  fastify.get<{ Params: { id: string } }>('/paper/strategy/snapshot/:id', async (req, reply) => {
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
    const ok = dbDeleteSnapshot(req.params.id);
    if (!ok) return reply.status(404).send({ error: 'snapshot not found' });
    return reply.send({ ok: true });
  });

  fastify.post<{ Body: MarginBody }>('/paper/margin', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { liveRefId, order_qty, order_side, order_type, order_price, order_delivery_type } =
        req.body;
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
            validityType: 'DAY',
            isMultiLeg: false,
            executionMode: 'ENTRY',
            entryPrice: order_price ?? 0,
            stratTags: ['nubra-dashboard', 'single-margin'],
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
        return reply.send(normalized);
      } catch (err) {
        return reply
          .status(502)
          .send({ error: `Broker margin unavailable. V3: ${(err as Error).message}` });
      }
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
