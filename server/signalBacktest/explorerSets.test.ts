import { expect, test } from 'vitest';
import { emptyGrid, SESSION_BARS, type DaySeries } from '../analysis/daySeries.ts';
import { explorerDaySets, explorerSetOptions, parseSetKey } from './explorerSets.ts';
import type { SignalBacktestRow } from './routes.ts';

function fixture() {
  const day: DaySeries = {
    v: 1,
    underlying: 'NIFTY',
    date: '2026-01-05',
    source: 'local',
    expiry: '2026-01-06',
    monthly: false,
    spot: emptyGrid().fill(23000),
    ce: {},
    pe: {},
  };
  for (let n = 0; n <= 7; n++) {
    day.ce[String(23000 + n * 50)] = Array.from(
      { length: SESSION_BARS },
      (_, i) => 100 - n * 5 + (i > 40 ? n * 2 : 0),
    );
    day.pe[String(23000 - n * 50)] = emptyGrid().fill(50);
  }
  const base = {
    date: day.date,
    source: 'local',
    expiry: day.expiry,
    dte: 5,
    signal: { t2: '09:45' },
  } as SignalBacktestRow;
  return { day, base };
}

test('OTM 7 selects the correct pair and daily worst uses the same max-loss measure', () => {
  const { day, base } = fixture();
  const r = explorerDaySets(base, day, null, 'NIFTY', 'otm7');
  expect(r.trade?.legs.map((l) => l.strike)).toEqual([23350, 22650]);
  expect(r.comparisons).toHaveLength(8);
  expect(r.worst?.key).toBe('otm7');
  expect(r.worst?.maxLoss).toBe(Math.max(...r.comparisons.map((c) => c.maxLoss)));
  const worst = explorerDaySets(base, day, null, 'NIFTY', 'worst');
  expect(worst.trade).toEqual(r.trade);
});

test('missing contracts exclude that pair rather than borrowing another strike', () => {
  const { day, base } = fixture();
  delete day.pe['22650'];
  const r = explorerDaySets(base, day, null, 'NIFTY', 'otm7');
  expect(r.trade).toBeNull();
  expect(r.comparisons.some((c) => c.key === 'otm7')).toBe(false);
  expect(r.worst?.key).toBe('otm6');
});

test('both markets expose report price bands and ATM through OTM 7', () => {
  for (const underlying of ['NIFTY', 'SENSEX']) {
    const options = explorerSetOptions(underlying);
    expect(options.some((o) => o.key === 'worst')).toBe(true);
    expect(options.some((o) => o.key === 'otm7')).toBe(true);
    expect(options.some((o) => o.key.startsWith('band'))).toBe(true);
  }
});

test('price-band selection uses the report range for that expiry distance', () => {
  const { day, base } = fixture();
  base.dte = 4;
  const r = explorerDaySets(base, day, null, 'NIFTY', 'band5');
  expect(r.trade).not.toBeNull();
  expect(r.label).toBe('₹45–66 band');
  // Report rule: per leg, the price nearest the band's middle (55.55), up to one width outside.
  expect(r.trade!.legs.map((l) => l.entryPrice)).toEqual([65, 50]);
});

test('bands are listed per expiry distance, the way the report ranks them', () => {
  const options = explorerSetOptions('NIFTY');
  expect(options.find((o) => o.key === 'band11@0')?.label).toBe('Exp · ₹36–51 per leg');
  expect(options.find((o) => o.key === 'band11@1')?.label).toBe('Exp−1 · ₹52–76 per leg');
  // The bare key the report sends on a day click still works, unlisted.
  expect(options.find((o) => o.key === 'band11')?.hidden).toBe(true);
  expect(parseSetKey('band11@2')).toEqual({ set: 'band11', dte: 2 });
  expect(parseSetKey('otm3')).toEqual({ set: 'otm3', dte: null });
});
