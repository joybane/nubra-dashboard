import type { FastifyInstance, FastifyReply } from 'fastify';

type GetRefdata = (exchange: string) => Promise<Record<string, unknown>[]>;
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
  nubraGet: NubraGet;
  nubraPost: NubraPost;
  requireAuth: (reply: FastifyReply) => boolean;
  getSessionToken: () => string | null;
}

export function registerMarketDataRoutes({
  fastify,
  getRefdata,
  nubraGet,
  nubraPost,
  requireAuth,
  getSessionToken,
}: MarketDataRouteDeps): void {
  // ─── Refdata (instruments) ────────────────────────────────────────────────────
  fastify.get<{ Querystring: { exchange?: string } }>('/api/refdata', async (req, reply) => {
    if (!requireAuth(reply)) return;
    try {
      const exchange = req.query.exchange || 'NSE';
      const arr = await getRefdata(exchange);
      return reply.send({ refdata: arr });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
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
          const name = (
            (item.stock_name || item.asset || item.display_name || '') as string
          ).toLowerCase();
          const sym = (
            (item.zanskar_name ||
              item.nubra_name ||
              item.symbol ||
              item.trading_symbol ||
              '') as string
          ).toLowerCase();
          if (name === q2 || sym === q2) return 0;
          if (name.startsWith(q2) || sym.startsWith(q2)) return 1;
          return 2;
        }

        const filtered = arr
          .filter((item) => {
            const name = (
              (item.stock_name || item.asset || item.symbol || item.display_name || '') as string
            ).toLowerCase();
            const sym = (
              (item.zanskar_name ||
                item.nubra_name ||
                item.symbol ||
                item.trading_symbol ||
                '') as string
            ).toLowerCase();
            const tm =
              !type ||
              ((item.derivative_type || item.asset_type || '') as string).toUpperCase() ===
                type.toUpperCase();
            return tm && (name.includes(q2) || sym.includes(q2));
          })
          .sort((a, b) => {
            const ms = matchScore(a) - matchScore(b);
            if (ms !== 0) return ms;
            return typePriority(a) - typePriority(b);
          })
          .slice(0, Number(limit));

        return reply.send({ results: filtered });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: msg });
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
        return reply.status(500).send({ error: (err as Error).message });
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
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
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

      // Enrich legs with stock_name from refdata so frontend can call historical timeseries
      try {
        const refdata = await getRefdata(exchange);
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
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: msg });
    }
  });

  fastify.get<{ Params: { instrument: string } }>(
    '/api/optionchain/:instrument/price',
    async (req, reply) => {
      if (!requireAuth(reply)) return;
      try {
        const data = await nubraGet(`/optionchains/${req.params.instrument}/price`);
        return reply.send(data);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: msg });
      }
    },
  );
}
