import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDayStore, type DayStore } from './daySeries.ts';
import { createAnalysisSync, type DetailProgress } from './sync.ts';

// No parquet tree: the local phase has nothing to build, so only the Nubra side runs.
vi.mock('../backtest/dataLayer.ts', () => ({ listExpiries: async () => [] }));

// 2026-03-02 (a Monday) 18:00 IST: the session of that day is complete.
const NOW = Date.UTC(2026, 2, 2, 12, 30);

describe('createAnalysisSync full-detail step', () => {
  let dir: string;
  let store: DayStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'analysis-sync-'));
    store = createDayStore(path.join(dir, 'cache'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const detail: DetailProgress = {
    running: true,
    done: 3,
    total: 9,
    failed: 0,
    lastError: null,
    fields: 'all',
  };

  test('runs after the Nubra phase and shows its progress', async () => {
    const order: string[] = [];
    const sync = createAnalysisSync({
      store,
      masterDirs: [path.join(dir, 'no-master')],
      // Nubra answers every request with no bars: the phase runs and stores empty days.
      getPost: () => async () => {
        order.push('nubra');
        return { result: [] };
      },
      afterNubra: async (u) => {
        order.push(`detail ${u}`);
        expect(sync.getState().phase).toBe('detail');
      },
      detailState: () => detail,
      minIntervalMs: 0,
      nowMs: () => NOW,
    });
    sync.start('NIFTY');
    await sync.whenIdle();
    expect(order.at(-1)).toBe('detail NIFTY');
    expect(order.filter((x) => x.startsWith('detail'))).toHaveLength(1);
    expect(sync.getState().detail).toEqual(detail);
  });

  test('is skipped without a broker session', async () => {
    let called = false;
    const sync = createAnalysisSync({
      store,
      masterDirs: [path.join(dir, 'no-master')],
      getPost: () => null,
      afterNubra: async () => {
        called = true;
      },
      minIntervalMs: 0,
      nowMs: () => NOW,
    });
    sync.start('NIFTY');
    await sync.whenIdle();
    expect(called).toBe(false);
    expect(sync.getState().nubra.skipped).toBe('no broker session');
    expect(sync.getState().detail).toBeNull();
  });
});
