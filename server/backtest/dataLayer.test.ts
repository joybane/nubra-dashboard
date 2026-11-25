import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

test('weekly expiry lookup includes monthly dates, prefers duplicate weekly dates, and clears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'backtest-expiries-'));
  vi.stubEnv('BACKTEST_DATA_ROOT', root);
  const addExpiry = (expiry: string, flag: string) =>
    mkdir(path.join(root, 'NIFTY', expiry, 'ATM', flag), { recursive: true });
  try {
    await Promise.all([
      addExpiry('2026-01-13', 'WEEK'),
      addExpiry('2026-01-20', 'MONTH'),
      addExpiry('2026-01-20', 'WEEK'),
      addExpiry('2026-01-27', 'MONTH'),
    ]);
    const { clearCaches, resolveExpiry } = await import('./dataLayer.ts');
    await expect(
      Promise.all([
        resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 0),
        resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 1),
        resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 2),
        resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 3),
        resolveExpiry('NIFTY', 'MONTH', '2026-01-12', 0),
        resolveExpiry('SENSEX', 'WEEK', '2026-01-12', 0),
      ]),
    ).resolves.toEqual([
      { expiry: '2026-01-13', flag: 'WEEK' },
      { expiry: '2026-01-20', flag: 'WEEK' },
      { expiry: '2026-01-27', flag: 'MONTH' },
      null,
      { expiry: '2026-01-20', flag: 'MONTH' },
      null,
    ]);

    await addExpiry('2026-01-12', 'MONTH');
    await expect(resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 0)).resolves.toEqual({
      expiry: '2026-01-13',
      flag: 'WEEK',
    });
    clearCaches();
    await expect(resolveExpiry('NIFTY', 'WEEK', '2026-01-12', 0)).resolves.toEqual({
      expiry: '2026-01-12',
      flag: 'MONTH',
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
