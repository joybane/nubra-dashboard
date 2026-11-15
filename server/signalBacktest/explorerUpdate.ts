/**
 * "Update data" for the Trade Explorer: brings the saved run up to the latest stored day.
 *
 *   1. download  — the Analysis tab's own "Update data" sync (new Nubra days, then the full-detail
 *                  option download). Skipped, with a note, when there is no broker session.
 *   2. run       — the full Signal Backtest again, with the saved run's own settings, so every
 *                  figure is recalculated the same way the saved run was.
 *   3. groups    — `loss-analysis-work/enrich_explorer.mjs`, which adds the report's groups and
 *                  prices the legs that run past the stored strikes, then writes the saved run.
 *
 * The previous files are kept as `*.prev.json`, and a run with fewer days than the saved one is
 * refused (a half-downloaded cache must not shrink the history). Every step goes through the
 * dashboard's own routes (`fastify.inject`), so nothing here duplicates their logic.
 */
import type { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import { copyFile, readFile, rename, stat, writeFile } from 'fs/promises';
import path from 'path';

const UNDERLYINGS = ['NIFTY', 'SENSEX'] as const;
type Underlying = (typeof UNDERLYINGS)[number];

export type UpdatePhase = 'idle' | 'download' | 'run' | 'groups' | 'report' | 'done' | 'error';

export interface ExplorerUpdateState {
  running: boolean;
  underlying: Underlying | null;
  phase: UpdatePhase;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** Days and last date before and after, so the page can say what changed. */
  before: { days: number; through: string | null } | null;
  after: { days: number; through: string | null } | null;
  downloadSkipped: string | null;
  error: string | null;
}

interface SavedRunShape {
  rows: Array<{ date: string }>;
  signalParams?: unknown;
  tradeParams?: unknown;
  includeLocalOnly?: boolean;
  useHighLow?: boolean;
}

const summary = (run: SavedRunShape) => ({
  days: run.rows.length,
  through: run.rows.reduce<string | null>((a, r) => (a == null || r.date > a ? r.date : a), null),
});

export function registerExplorerUpdate(deps: { fastify: FastifyInstance; rootDir: string }) {
  const { fastify, rootDir } = deps;
  const workDir = path.join(rootDir, '..', 'loss-analysis-work');
  const runFile = (u: Underlying) =>
    path.join(workDir, u === 'NIFTY' ? 'run_full.json' : path.join('sensex', 'run_full.json'));
  const savedFile = (u: Underlying) => path.join(rootDir, '.signal-cache', u, 'explorer-run.json');

  const state: ExplorerUpdateState = {
    running: false,
    underlying: null,
    phase: 'idle',
    message: '',
    startedAt: null,
    finishedAt: null,
    before: null,
    after: null,
    downloadSkipped: null,
    error: null,
  };

  const getJson = async (url: string) => (await fastify.inject({ method: 'GET', url })).json();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function download(u: Underlying) {
    const status = await getJson(`/api/analysis/status?underlying=${u}`);
    if (!status.brokerSession) {
      state.downloadSkipped = 'not logged in to the broker, so no new days were downloaded';
      return;
    }
    await fastify.inject({ method: 'POST', url: '/api/analysis/sync', payload: { underlying: u } });
    // Started here or already running from the Analysis tab: either way, wait for it to finish.
    for (;;) {
      await sleep(2000);
      const s = (await getJson(`/api/analysis/status?underlying=${u}`)).sync;
      if (!s?.running) {
        if (s?.nubra?.skipped) state.downloadSkipped = String(s.nubra.skipped);
        return;
      }
      const d = s.detail;
      state.message =
        s.phase === 'detail' && d?.total
          ? `Downloading full option detail ${d.done}/${d.total}`
          : s.phase === 'download' && s.nubra?.total
            ? `Downloading new days from Nubra ${s.nubra.done}/${s.nubra.total}`
            : `Downloading (${s.phase})`;
    }
  }

  function node(script: string, u: Underlying, cwd = workDir) {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, u], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stdout.on('data', (b) => fastify.log.info(`[explorer update] ${String(b).trim()}`));
      child.stderr.on('data', (b) => (err += String(b)));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `exit ${code}`)),
      );
    });
  }

  async function run(u: Underlying) {
    Object.assign(state, {
      running: true,
      underlying: u,
      startedAt: Date.now(),
      finishedAt: null,
      before: null,
      after: null,
      downloadSkipped: null,
      error: null,
    });
    const saved = savedFile(u);
    const source = runFile(u);
    let backedUp = false;
    try {
      const old = JSON.parse(await readFile(source, 'utf8')) as SavedRunShape;
      state.before = summary(old);

      state.phase = 'download';
      state.message = 'Checking for new days';
      await download(u);

      state.phase = 'run';
      state.message = 'Re-running the backtest over every day (about a minute)';
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/signal-backtest/run',
        payload: {
          underlying: u,
          signalParams: old.signalParams,
          tradeParams: old.tradeParams,
          includeLocalOnly: old.includeLocalOnly,
          useHighLow: old.useHighLow,
        },
      });
      const fresh = res.json() as SavedRunShape & { ok?: boolean; error?: string };
      if (!fresh.ok) throw new Error(fresh.error ?? `backtest run failed (${res.statusCode})`);
      const next = summary(fresh);
      if (next.days < state.before.days)
        throw new Error(
          `the new run has ${next.days} days, fewer than the saved ${state.before.days}; nothing was changed`,
        );

      state.phase = 'groups';
      state.message = 'Adding the report groups and pricing far legs';
      await copyFile(source, source.replace(/\.json$/, '.prev.json'));
      await copyFile(saved, saved.replace(/\.json$/, '.prev.json')).catch(() => undefined);
      backedUp = true;
      await writeFile(source, JSON.stringify(fresh));
      await node('enrich_explorer.mjs', u);

      state.after = summary(JSON.parse(await readFile(saved, 'utf8')) as SavedRunShape);

      // The Strangle Max Loss report (Report view), rebuilt from the same run. A failure here
      // leaves the trade data updated and the previous report in place.
      state.phase = 'report';
      state.message = 'Rebuilding the Strangle Max Loss report (about a minute)';
      let reportNote = '';
      try {
        await node('update_report.mjs', u, path.join(workDir, 'report-build'));
      } catch (e) {
        reportNote = ` — the report was not rebuilt: ${(e as Error).message}`;
        fastify.log.error(`[explorer update] ${u} report: ${(e as Error).message}`);
      }
      state.phase = 'done';
      const added = state.after.days - state.before.days;
      state.message =
        added > 0
          ? `Updated: ${added} new day${added === 1 ? '' : 's'}, data through ${state.after.through}`
          : `Recalculated; no new days (data through ${state.after.through})` +
            (state.downloadSkipped ? ` — ${state.downloadSkipped}` : '');
      state.message += reportNote;
    } catch (e) {
      if (backedUp) {
        // Put both files back so the tab keeps showing the run it showed before.
        await rename(source.replace(/\.json$/, '.prev.json'), source).catch(() => undefined);
        await stat(saved.replace(/\.json$/, '.prev.json'))
          .then(() => copyFile(saved.replace(/\.json$/, '.prev.json'), saved))
          .catch(() => undefined);
      }
      state.phase = 'error';
      state.error = (e as Error).message;
      state.message = `Update failed: ${state.error}`;
      fastify.log.error(`[explorer update] ${u}: ${state.error}`);
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
    }
  }

  fastify.get('/api/signal-backtest/explorer/update', async () => ({ ok: true, ...state }));

  fastify.post<{ Body: { underlying?: string } }>(
    '/api/signal-backtest/explorer/update',
    async (req, reply) => {
      const u = String(req.body?.underlying ?? 'NIFTY').toUpperCase() as Underlying;
      if (!UNDERLYINGS.includes(u)) {
        reply.code(400);
        return { ok: false, error: `unsupported underlying ${req.body?.underlying}` };
      }
      if (state.running) return { ok: true, started: false, ...state };
      void run(u);
      return { ok: true, started: true, ...state };
    },
  );
}
