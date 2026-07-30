import type { FastifyInstance } from 'fastify';
import {
  getMeta as btGetMeta,
  runBacktest,
  runDayDetail,
  validateConfig,
  validateSweep,
  runSweep,
  validateWalkForward,
  runWalkForward,
} from './index.ts';
import type { BacktestConfig, SweepRequest, WalkForwardRequest } from './types.ts';
import { buildIvHistory, normalizeUnderlying } from './ivHistory.ts';

const IV_HISTORY_MAX_DAYS = 1830; // ~5 years, the depth of the parquet tree

export function registerBacktestRoutes(fastify: FastifyInstance): void {
  // Baseline for the Tracker's IV rank / percentile. Lives here because it reads the
  // backtest parquet tree; it is not part of a backtest run. Cheap after the first
  // call — see the per-expiry cache in ivHistory.
  fastify.get<{ Querystring: { und?: string; days?: string } }>(
    '/api/iv-history',
    async (req, reply) => {
      const und = normalizeUnderlying(req.query.und ?? '');
      if (!und) {
        reply.code(400);
        return { error: `no historical IV data for "${req.query.und ?? ''}"` };
      }
      const days = Math.min(IV_HISTORY_MAX_DAYS, Math.max(30, Number(req.query.days) || 365));
      try {
        return await buildIvHistory(und, days);
      } catch (e) {
        reply.code(500);
        return { error: (e as Error).message };
      }
    },
  );

  fastify.get('/api/backtest/meta', async (_req, reply) => {
    try {
      return await btGetMeta();
    } catch (err) {
      reply.code(500);
      return { error: (err as Error).message };
    }
  });

  fastify.post<{ Body: BacktestConfig }>('/api/backtest/run', async (req, reply) => {
    const cfg = req.body;
    const err = validateConfig(cfg);
    if (err) {
      reply.code(400);
      return { ok: false, error: err };
    }
    try {
      const t0 = Date.now();
      const res = await runBacktest(cfg);
      console.log(
        `Backtest ${cfg.underlying} ${cfg.from}→${cfg.to}: ${res.trades.length} trades in ${Date.now() - t0}ms`,
      );
      return res;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

  fastify.post<{ Body: { config: BacktestConfig; date: string } }>(
    '/api/backtest/day',
    async (req, reply) => {
      const { config, date } = (req.body ?? {}) as { config: BacktestConfig; date: string };
      const err = validateConfig(config);
      if (err) {
        reply.code(400);
        return { ok: false, error: err };
      }
      try {
        return await runDayDetail(config, date);
      } catch (e) {
        reply.code(500);
        return { ok: false, error: (e as Error).message };
      }
    },
  );

  fastify.post<{ Body: SweepRequest }>('/api/backtest/sweep', async (req, reply) => {
    const sw = req.body;
    const err = validateSweep(sw);
    if (err) {
      reply.code(400);
      return { ok: false, error: err };
    }
    try {
      const t0 = Date.now();
      const res = await runSweep(sw);
      console.log(
        `Sweep ${sw.base.underlying} ${sw.param1.path} [${sw.param1.from}→${sw.param1.to}]: ${res.cells.length} cells in ${Date.now() - t0}ms`,
      );
      return res;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });

  fastify.post<{ Body: WalkForwardRequest }>('/api/backtest/walkforward', async (req, reply) => {
    const wf = req.body;
    const err = validateWalkForward(wf);
    if (err) {
      reply.code(400);
      return { ok: false, error: err };
    }
    try {
      const t0 = Date.now();
      const res = await runWalkForward(wf);
      console.log(
        `Walk-forward ${wf.base.underlying} ${wf.windows}w ${wf.param.path}: ${res.windows.length} windows in ${Date.now() - t0}ms`,
      );
      return res;
    } catch (e) {
      reply.code(500);
      return { ok: false, error: (e as Error).message };
    }
  });
}
