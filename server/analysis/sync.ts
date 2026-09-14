/**
 * The job that fills the analysis cache: every local trading day from the parquet tree, every
 * Nubra day from where its history starts, then the overlap validation report.
 *
 * Local and Nubra run side by side — one is disk and CPU, the other is network waiting on the
 * pacer — so neither slows the other. Both skip dates already on disk, so a sync after the first
 * one costs only the days since.
 *
 * Only past dates are fetched (today counts once the session has closed): the cache treats a day as
 * immutable, and a day stored mid-session would stay truncated.
 */
import type { Underlying } from '../backtest/types.ts';
import { listExpiries } from '../backtest/dataLayer.ts';
import { isEmptyDay, type DayStore } from './daySeries.ts';
import { loadCalendar, saveCalendar } from './expiryCalendar.ts';
import { buildLocalDay } from './localSource.ts';
import {
  createPacer,
  fetchNubraDay,
  findNubraStart,
  type NubraDeps,
  type PostTimeseries,
} from './nubraSource.ts';
import { buildValidationReport } from './validation.ts';

export interface SyncProgress {
  done: number;
  total: number;
  built: number;
  empty: number;
  failed: number;
}

export interface SyncState {
  running: boolean;
  underlying: string | null;
  phase: string;
  startedAt: number | null;
  finishedAt: number | null;
  local: SyncProgress;
  nubra: SyncProgress & { start: string | null; skipped: string | null };
  validation: { running: boolean; done: number; total: number; ok: boolean | null };
  errors: string[];
}

export interface AnalysisSyncDeps {
  store: DayStore;
  masterDirs: string[];
  /** A timeseries poster, or null when there is no broker session (Nubra phase is skipped). */
  getPost: () => PostTimeseries | null;
  /** Minimum spacing between Nubra requests. 1400ms ≈ 43/min, under the shared 60/min ceiling. */
  minIntervalMs?: number;
  log?: (msg: string) => void;
  nowMs?: () => number;
}

const IST_MS = 19_800_000;

export function istDate(ms: number): string {
  return new Date(ms + IST_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function weekdaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

/** The last date whose session is complete: today after 15:40 IST, otherwise yesterday. */
export function lastCompleteDate(nowMs: number): string {
  const ist = new Date(nowMs + IST_MS);
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const today = ist.toISOString().slice(0, 10);
  return minutes >= 15 * 60 + 40 ? today : addDays(today, -1);
}

const freshProgress = (): SyncProgress => ({ done: 0, total: 0, built: 0, empty: 0, failed: 0 });

export function createAnalysisSync(deps: AnalysisSyncDeps) {
  const log = deps.log ?? (() => {});
  const now = deps.nowMs ?? Date.now;
  const pace = createPacer(deps.minIntervalMs ?? 1400);

  const state: SyncState = {
    running: false,
    underlying: null,
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    local: freshProgress(),
    nubra: { ...freshProgress(), start: null, skipped: null },
    validation: { running: false, done: 0, total: 0, ok: null },
    errors: [],
  };
  let current: Promise<void> = Promise.resolve();

  const noteError = (msg: string) => {
    log(msg);
    state.errors.push(msg);
    if (state.errors.length > 20) state.errors.shift();
  };

  async function runLocal(
    underlying: Underlying,
    calendar: Awaited<ReturnType<typeof loadCalendar>>,
  ) {
    const expiries = [
      ...(await listExpiries(underlying, 'WEEK')),
      ...(await listExpiries(underlying, 'MONTH')),
    ].sort();
    if (!expiries.length) return;
    const have = new Set(await deps.store.list(underlying, 'local'));
    const dates = weekdaysBetween(addDays(expiries[0], -6), expiries[expiries.length - 1]).filter(
      (d) => !have.has(d),
    );
    state.local.total = dates.length;
    for (const date of dates) {
      try {
        const day = await buildLocalDay(underlying, date, calendar);
        await deps.store.write(day);
        if (isEmptyDay(day)) state.local.empty++;
        else state.local.built++;
      } catch (e) {
        state.local.failed++;
        noteError(`[analysis local] ${date}: ${(e as Error).message}`);
      }
      state.local.done++;
    }
  }

  async function runNubra(
    underlying: Underlying,
    calendar: Awaited<ReturnType<typeof loadCalendar>>,
  ) {
    const post = deps.getPost();
    if (!post) {
      state.nubra.skipped = 'no broker session';
      return;
    }
    const nubra: NubraDeps = { post, pace, log };
    const last = lastCompleteDate(now());
    const start = await findNubraStart(nubra, underlying, istDate(now()));
    state.nubra.start = start;
    log(`[analysis nubra] ${underlying} 1m history starts ${start}`);

    const have = new Set(await deps.store.list(underlying, 'nubra'));
    const dates = weekdaysBetween(start, last).filter((d) => !have.has(d));
    state.nubra.total = dates.length;
    // Newest first: the recent months are what the local tree lacks entirely.
    for (const date of dates.reverse()) {
      try {
        const day = await fetchNubraDay(nubra, underlying, date, calendar);
        await deps.store.write(day);
        if (isEmptyDay(day)) state.nubra.empty++;
        else state.nubra.built++;
      } catch (e) {
        state.nubra.failed++;
        noteError(`[analysis nubra] ${date}: ${(e as Error).message}`);
      }
      state.nubra.done++;
      if (state.nubra.done % 20 === 0) await saveCalendar(deps.store, underlying, calendar);
    }
    await saveCalendar(deps.store, underlying, calendar);
  }

  async function run(underlying: Underlying) {
    state.running = true;
    state.underlying = underlying;
    state.startedAt = now();
    state.finishedAt = null;
    state.local = freshProgress();
    state.nubra = { ...freshProgress(), start: null, skipped: null };
    state.validation = { running: false, done: 0, total: 0, ok: null };
    state.errors = [];
    try {
      state.phase = 'calendar';
      const calendar = await loadCalendar(deps.store, underlying, deps.masterDirs, log);
      state.phase = 'download';
      await Promise.all([
        runLocal(underlying, calendar).catch((e) =>
          noteError(`[analysis local] ${(e as Error).message}`),
        ),
        runNubra(underlying, calendar).catch((e) =>
          noteError(`[analysis nubra] ${(e as Error).message}`),
        ),
      ]);
      state.phase = 'validation';
      state.validation.running = true;
      const report = await buildValidationReport(
        deps.store,
        underlying,
        undefined,
        (done, total) => {
          state.validation.done = done;
          state.validation.total = total;
        },
      );
      state.validation.ok = report.verdict.ok;
    } catch (e) {
      noteError(`[analysis sync] ${(e as Error).message}`);
    } finally {
      state.validation.running = false;
      state.running = false;
      state.phase = 'idle';
      state.finishedAt = now();
      log(
        `[analysis sync] ${underlying} done: local +${state.local.built} (${state.local.empty} empty), ` +
          `nubra +${state.nubra.built} (${state.nubra.empty} empty, ${state.nubra.failed} failed)`,
      );
    }
  }

  return {
    getState: (): SyncState => state,
    /** @returns false when a sync is already running. */
    start(underlying: Underlying): boolean {
      if (state.running) return false;
      current = run(underlying);
      return true;
    },
    whenIdle: () => current,
  };
}

export type AnalysisSync = ReturnType<typeof createAnalysisSync>;
