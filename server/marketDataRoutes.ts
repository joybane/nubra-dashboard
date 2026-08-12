import type { FastifyInstance, FastifyReply } from 'fastify';
import { sendUpstreamError } from './routeErrors.ts';

/**
 * How long an option-chain request will wait for a cold refdata download before replying without
 * leg symbols. The losing download keeps running and populates the cache, so the client's 5s poll
 * picks up the enriched version shortly after.
 */
const REFDATA_ENRICH_BUDGET_MS = 2_500;

type GetRefdata = (exchange: string) => Promise<Record<string, unknown>[]>;
type PeekRefdata = (exchange: string) => Record<string, unknown>[] | null;
type NubraGet = (
  endpoint: string,
  params?: Record<string, string>,
) => Promise<Record<string, unknown>>;
type NubraPost = (
  endpoint: string,
  body: object,
  extraHeaders?: Record<string, string>,
) => Promise<Record<string, unknown>>;

interface MarketDataRouteDeps {
  fastify: FastifyInstance;
  getRefdata: GetRefdata;
  /** Synchronous cache read. Returns null when the exchange has not been downloaded yet. */
  peekRefdata: PeekRefdata;
  nubraGet: NubraGet;
  nubraPost: NubraPost;
  requireAuth: (reply: FastifyReply) => boolean;
  getSessionToken: () => string | null;
}

export function registerMarketDataRoutes({
  fastify,
  getRefdata,
  peekRefdata,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken,
}: MarketDataRouteDeps): void {
  /**
   * Waits up to REFDATA_ENRICH_BUDGET_MS for a cold exchange's refdata, then gives up and returns
   * null. The download itself is not cancelled — it keeps going and fills the cache, so this is a
   * bounded wait rather than a bounded fetch.
   */
  async function refdataWithinBudget(exchange: string): Promise<Record<string, unknown>[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        getRefdata(exchange).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REFDATA_ENRICH_BUDGET_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── Refdata (instruments) ────────────────────────────────────────────────────
  fastify.get<{ Querystring: { exchange?: string } }>('/api/refdata', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const exchange = req.query.exchange || 'NSE';
      const arr = await getRefdata(exchange);
      return reply.send({ refdata: arr });
    } catch (err: unknown) {
      return sendUpstreamError(reply, err, `GET /api/refdata?exchange=${req.query.exchange || ''}`);
    }
  });

  // ─── Instruments search ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { q?: string; exchange?: string; type?: string; limit?: string } }>(
    '/api/instruments/search',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      try {
        const { q = '', exchange = 'NSE', type = '', limit = '20' } = req.query;
        const arr = await getRefdata(exchange);

        const q2 = q.toLowerCase();

        function typePriority(item: Record<string, unknown>): number {
          const dt = ((item.derivative_type || item.asset_type || '') as string).toUpperCase();
          if (dt === 'STOCK' || dt === 'INDEX' || dt === '') return 0;
          if (dt === 'FUT') return 1;
          return 2;
        }

        function matchScore(item: Record<string, unknown>): number {
          const terms = searchTerms(item);
          if (terms.some((term) => term === q2)) return 0;
          if (terms.some((term) => term.startsWith(q2))) return 1;
          return 2;
        }

        function searchTerms(item: Record<string, unknown>): string[] {
          return [
            item.asset,
            item.stock_name,
            item.display_name,
            item.zanskar_name,
            item.nubra_name,
            item.symbol,
            item.trading_symbol,
          ]
            .filter(Boolean)
            .map((value) => String(value).toLowerCase());
        }

        function expiryValue(item: Record<string, unknown>): number {
          const symbolExpiry = /(?:^|_)(\d{8})(?:_|$)/.exec(
            String(item.zanskar_name || item.nubra_name || item.symbol || item.stock_name || ''),
          )?.[1];
          const raw = String(item.expiry ?? symbolExpiry ?? '');
          if (/^\d{8}$/.test(raw)) return Number(raw);
          const time = new Date(raw).getTime();
          return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
        }

        const filtered = arr
          .filter((item) => {
            const tm =
              !type ||
              ((item.derivative_type || item.asset_type || '') as string).toUpperCase() ===
                type.toUpperCase();
            return tm && searchTerms(item).some((term) => term.includes(q2));
          })
          .sort((a, b) => {
            const ms = matchScore(a) - matchScore(b);
            if (ms !== 0) return ms;
            const tp = typePriority(a) - typePriority(b);
            if (tp !== 0) return tp;
            return expiryValue(a) - expiryValue(b);
          })
          .slice(0, Number(limit));

        return reply.send({ results: filtered });
      } catch (err: unknown) {
        return sendUpstreamError(reply, err, `GET /api/instruments/search?q=${req.query.q || ''}`);
      }
    },
  );

  // ─── Instrument lookup by ref_id ──────────────────────────────────────────────
  fastify.get<{ Querystring: { ref_id?: string; exchange?: string } }>(
    '/api/instruments/lookup',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      try {
        const refId = Number(req.query.ref_id);
        if (!refId) return reply.status(400).send({ error: 'ref_id required' });
        const arr = await getRefdata(req.query.exchange || 'NSE');
        const match = arr.find((item) => (item as Record<string, unknown>).ref_id === refId);
        return reply.send({ instrument: match || null });
      } catch (err: unknown) {
        return sendUpstreamError(
          reply,
          err,
          `GET /api/instruments/lookup?ref_id=${req.query.ref_id || ''}`,
        );
      }
    },
  );

  // ─── Historical data ──────────────────────────────────────────────────────────
  fastify.post('/api/historical', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const data = await nubraPost('/charts/timeseries', req.body as object, {
        Authorization: `Bearer ${getSessionToken()!}`,
      });
      return reply.send(data);
    } catch (err: unknown) {
      return sendUpstreamError(reply, err, 'POST /api/historical');
    }
  });

  // ─── Option chain ─────────────────────────────────────────────────────────────
  fastify.get<{
    Params: { instrument: string };
    Querystring: { exchange?: string; expiry?: string };
  }>('/api/optionchain/:instrument', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const { instrument } = req.params;
      const { exchange = 'NSE', expiry } = req.query;
      const params: Record<string, string> = { exchange };
      if (expiry) params.expiry = expiry;
      const data = await nubraGet(`/optionchains/${instrument}`, params);
      const chain = (data.chain || data) as Record<string, unknown>;

      // Enrich legs with stock_name from refdata so frontend can call historical timeseries.
      //
      // This used to `await getRefdata` unconditionally, which meant the first chain for an
      // exchange we had not downloaded yet (MCX, typically — only NSE is warmed at startup) paid
      // a full multi-megabyte instrument dump *inside* the request, and the pane sat on
      // "Loading option chain…" for as long as that took. Now we only wait a short budget for a
      // cold exchange. Dropping the enrichment is not free — useGreekOverlay and useOIProfile key
      // off leg.symbol and bail out entirely without it — so we still wait, just not forever, and
      // the losing download populates the cache for the next request.
      try {
        const refdata = peekRefdata(exchange) ?? (await refdataWithinBudget(exchange));
        if (!refdata) throw new Error(`refdata for ${exchange} not ready`);
        const refById = new Map<number, string>();
        for (const r of refdata) {
          if (r.ref_id != null && r.stock_name) refById.set(Number(r.ref_id), String(r.stock_name));
        }
        for (const side of ['ce', 'pe'] as const) {
          const legs = chain[side];
          if (!Array.isArray(legs)) continue;
          for (const leg of legs as Record<string, unknown>[]) {
            const rid = Number(leg.ref_id);
            if (rid && refById.has(rid)) leg.symbol = refById.get(rid);
          }
        }
        let enriched = 0;
        for (const side of ['ce', 'pe'] as const) {
          const legs = chain[side];
          if (Array.isArray(legs))
            enriched += (legs as Record<string, unknown>[]).filter((l) => l.symbol).length;
        }
        console.log(
          `[OC] Enriched ${enriched} legs with symbol from refdata (${refById.size} ref entries)`,
        );
      } catch (e) {
        console.warn('[OC] refdata enrichment failed:', e);
      }

      return reply.send(data);
    } catch (err: unknown) {
      return sendUpstreamError(
        reply,
        err,
        `GET /api/optionchain/${req.params.instrument}?exchange=${req.query.exchange || ''}`,
      );
    }
  });

  fastify.get<{ Params: { instrument: string }; Querystring: { exchange?: string } }>(
    '/api/optionchain/:instrument/price',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      try {
        // Omitted for NSE so the upstream call is byte-identical to what it was.
        const exchange = (req.query.exchange || '').toUpperCase();
        const data = await nubraGet(
          `/optionchains/${req.params.instrument}/price`,
          exchange && exchange !== 'NSE' ? { exchange } : undefined,
        );
        return reply.send(data);
      } catch (err: unknown) {
        return sendUpstreamError(reply, err, `GET /api/optionchain/${req.params.instrument}/price`);
      }
    },
  );
}
