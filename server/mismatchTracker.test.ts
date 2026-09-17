import { describe, expect, test } from 'vitest';
import {
  StrategyMismatchTracker,
  istMinute,
  istMinuteToMs,
  strategyLegs,
  type StrategyLegs,
} from './mismatchTracker.ts';

const DATE = '2026-09-16';
/** Epoch ms of an IST HH:MM(:SS) on DATE. */
const at = (hms: string) => {
  const [h, m, s = '0'] = hms.split(':');
  return istMinuteToMs(DATE, Number(h) * 60 + Number(m)) + Number(s) * 1000;
};
const hhmmss = (ns: number) => new Date(ns / 1e6 + 19_800_000).toISOString().slice(11, 19);

const LEGS: StrategyLegs = {
  basketGroupId: 'bg_1',
  asset: 'NIFTY',
  exchange: 'NSE',
  underlyingType: 'INDEX',
  ce: { refId: 1, nubraName: 'NIFTY2692223350CE', qty: -65 },
  pe: { refId: 2, nubraName: 'NIFTY2692223150PE', qty: -65 },
  entryNs: at('09:15') * 1_000_000,
};

/** A tracker whose broker closes for 09:15..14:59 are given by functions of the minute offset. */
function tracker(
  spot: (i: number) => number,
  ce: (i: number) => number,
  pe: (i: number) => number,
  legs: StrategyLegs = LEGS,
) {
  const t = new StrategyMismatchTracker(legs);
  const minutes = Array.from({ length: 345 }, (_, i) => 555 + i);
  t.setBrokerCloses(
    DATE,
    'spot',
    minutes.map((m) => ({ minute: m, close: spot(m - 555) })),
  );
  t.setBrokerCloses(
    DATE,
    'ce',
    minutes.map((m) => ({ minute: m, close: ce(m - 555) })),
  );
  t.setBrokerCloses(
    DATE,
    'pe',
    minutes.map((m) => ({ minute: m, close: pe(m - 555) })),
  );
  return t;
}

/** NIFTY at 23,226 only in the 10:00 minute; 23,300 otherwise. */
const onlyAtTen = (i: number) => (i === 45 ? 23226 : 23300);

describe('strategyLegs', () => {
  const pos = (ref_id: number, nubraName: string, qty: number, gid = 'bg_1', entry = 1) => ({
    ref_id,
    nubraName,
    qty,
    basket_group_id: gid,
    entry_time: entry,
  });

  test('one CE and one PE on the same underlying are tracked, entry = the later leg', () => {
    const r = strategyLegs(
      [pos(1, 'NIFTY2692223350CE', -65, 'bg_1', 5), pos(2, 'NIFTY2692223150PE', -65, 'bg_1', 9)],
      'bg_1',
    );
    expect(r).toMatchObject({
      ok: true,
      legs: { asset: 'NIFTY', exchange: 'NSE', underlyingType: 'INDEX', entryNs: 9 },
    });
    const sensex = strategyLegs(
      [pos(1, 'SENSEX2692282000CE', 20), pos(2, 'SENSEX2692281000PE', 20)],
      'bg_1',
    );
    expect(sensex).toMatchObject({ ok: true, legs: { exchange: 'BSE' } });
  });

  test('anything else is refused with a reason', () => {
    const reason = (ps: ReturnType<typeof pos>[]) => {
      const r = strategyLegs(ps, 'bg_1');
      return r.ok ? null : r.reason;
    };
    expect(reason([])).toMatch(/no open strategy/);
    expect(reason([pos(1, 'NIFTY2692223350CE', -65), pos(2, 'NIFTY2692223400CE', -65)])).toMatch(
      /one CE and one PE/,
    );
    expect(
      reason([
        pos(1, 'NIFTY2692223350CE', -65),
        pos(2, 'NIFTY2692223150PE', -65),
        pos(3, 'NIFTY2692223100PE', 65),
      ]),
    ).toMatch(/one CE and one PE/);
    expect(
      reason([pos(1, 'NIFTY2692223350CE', -65), pos(2, 'BANKNIFTY2692251000PE', -35)]),
    ).toMatch(/same underlying/);
    expect(
      reason([pos(1, 'OPT_CRUDEOIL_20261016_CE_880000', -100), pos(2, 'CRUDEOIL26O16860PE', -100)]),
    ).toMatch(/same underlying/);
    // A closed leg (qty 0) no longer counts.
    expect(reason([pos(1, 'NIFTY2692223350CE', -65), pos(2, 'NIFTY2692223150PE', 0)])).toMatch(
      /one CE and one PE/,
    );
  });
});

describe('strategyLegs on MCX', () => {
  const pos = (ref_id: number, nubraName: string, qty: number) => ({
    ref_id,
    nubraName,
    qty,
    basket_group_id: 'bg_c',
    entry_time: 1,
  });
  const crude = [
    pos(1, 'OPT_CRUDEOIL_20260917_PE_860000', -100),
    pos(2, 'OPT_CRUDEOIL_20260917_CE_880000', -100),
  ];

  test('a crude strangle is tracked on the future its options are written on', () => {
    expect(strategyLegs(crude, 'bg_c', '2026-09-16')).toMatchObject({
      ok: true,
      legs: {
        asset: 'CRUDEOIL',
        exchange: 'MCX',
        underlyingType: 'FUT',
        optionExpiry: '20260917',
        ce: { refId: 2 },
        pe: { refId: 1 },
      },
    });
  });

  test('an expired series is refused; the expiry day itself is not', () => {
    expect(strategyLegs(crude, 'bg_c', '2026-09-17').ok).toBe(true);
    const r = strategyLegs(crude, 'bg_c', '2026-09-18');
    expect(r.ok ? null : r.reason).toMatch(/expired on 20260917/);
  });

  test('CRUDEOIL and CRUDEOILM are different underlyings', () => {
    const r = strategyLegs(
      [crude[0], pos(2, 'OPT_CRUDEOILM_20260917_CE_880000', -100)],
      'bg_c',
      '2026-09-16',
    );
    expect(r.ok ? null : r.reason).toMatch(/same underlying/);
  });
});

describe('StrategyMismatchTracker', () => {
  test('finds an opposite-leg case at the same close, with the real signed quantities', () => {
    // NIFTY 23,226 at 10:00; CE was 120, PE 110 then.
    const t = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
    );
    // 11:49:23 — NIFTY 23,226.5, CE fell to 103.3 (short gains), PE rose to 116.25 (short loses).
    const changed = t.onTick({ spot: 23226.5, ce: 103.3, pe: 116.25 }, at('11:49:23'));
    expect(changed).toHaveLength(1);
    const v = changed[0].versions[0];
    expect(v.ceDelta).toBeCloseTo((103.3 - 120) * -65, 2);
    expect(v.peDelta).toBeCloseTo((116.25 - 110) * -65, 2);
    expect(v.ceDelta).toBeGreaterThan(0);
    expect(v.peDelta).toBeLessThan(0);
    expect(hhmmss(v.t1Ns)).toBe('10:00:00');
    expect(hhmmss(v.t2Ns)).toBe('11:49:23');
    expect(changed[0]).toMatchObject({ caseNo: 1, colorIdx: 0 });
  });

  test('legs that move together are not a case', () => {
    const t = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
    );
    // Both shorts lose alike: CE +8, PE +7.
    expect(t.onTick({ spot: 23226, ce: 128, pe: 117 }, at('11:49:00'))).toEqual([]);
  });

  test('closes more than a point away, or less than 30 minutes back, are never used', () => {
    const spot = (i: number) => (i < 60 ? 23300 : 23226);
    const t = tracker(
      spot,
      () => 120,
      () => 110,
    );
    // At 10:40 only minutes up to 10:10 are old enough; 10:15.. are at 23,226 but too recent,
    // and 09:15..10:14 are 74 points away.
    expect(t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('10:40:10'))).toEqual([]);
    expect(t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('10:45:10'))).toHaveLength(1);
    const v = t.cases[0].versions[0];
    expect(hhmmss(v.t1Ns)).toBe('10:15:00');
  });

  test('no earlier minute before the entry', () => {
    const legs = { ...LEGS, entryNs: at('11:00:30') * 1_000_000 };
    const t = tracker(
      () => 23226,
      () => 120,
      () => 110,
      legs,
    );
    expect(t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('11:29:50'))).toEqual([]);
    const [c] = t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('11:30:05'));
    expect(hhmmss(c.versions[0].t1Ns)).toBe('11:00:00');
  });

  test('a near-copy with a wider gap adds a version; a narrower one does not', () => {
    const t = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
    );
    t.onTick({ spot: 23226, ce: 110, pe: 115 }, at('11:49:05'));
    expect(t.cases).toHaveLength(1);
    // Narrower: nothing changes.
    expect(t.onTick({ spot: 23226, ce: 112, pe: 114 }, at('11:49:08'))).toEqual([]);
    // NIFTY leaves the band: no candidates, the case is untouched.
    expect(t.onTick({ spot: 23229, ce: 100, pe: 120 }, at('11:49:10'))).toEqual([]);
    // Back in the band a few seconds later with a wider gap: a second version of the same case.
    const changed = t.onTick({ spot: 23226.3, ce: 104, pe: 117 }, at('11:49:12'));
    expect(changed).toHaveLength(1);
    expect(t.cases).toHaveLength(1);
    const versions = t.cases[0].versions;
    expect(versions).toHaveLength(2);
    expect(versions[1].gap).toBeGreaterThan(versions[0].gap);
    expect(versions.map((v) => hhmmss(v.t2Ns))).toEqual(['11:49:05', '11:49:12']);
  });

  test('30 minutes after its last version a case is frozen and a new case starts', () => {
    const t = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
    );
    t.onTick({ spot: 23226, ce: 110, pe: 115 }, at('11:00:00'));
    const top = () => t.cases[0].versions[t.cases[0].versions.length - 1];
    const firstT2 = top().t2Ns;
    // 29 minutes later, wider: still the same case.
    t.onTick({ spot: 23226, ce: 105, pe: 117 }, at('11:29:00'));
    expect(t.cases).toHaveLength(1);
    expect(top().t2Ns).not.toBe(firstT2);
    // 30 minutes after that version, even wider: a new case, and the old one keeps its versions.
    t.onTick({ spot: 23226, ce: 100, pe: 119 }, at('11:59:00'));
    expect(t.cases).toHaveLength(2);
    expect(t.cases[0].versions).toHaveLength(2);
    expect(t.cases[1]).toMatchObject({ caseNo: 2, colorIdx: 1 });
  });

  test('two far-apart earlier moments at the same level are two cases', () => {
    // 23,226 from 09:15–09:44 and again from 11:00; 23,300 in between. Each stretch is shorter
    // than 30 minutes of usable closes, so each is one case.
    const spot = (i: number) => (i < 30 || i >= 105 ? 23226 : 23300);
    const ce = (i: number) => (i < 30 ? 120 : 112);
    const pe = (i: number) => (i < 30 ? 110 : 111);
    const t = tracker(spot, ce, pe);
    const changed = t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('11:55:00'));
    expect(changed).toHaveLength(2);
    expect(t.cases.map((c) => hhmmss(c.versions[0].t1Ns))).toEqual(['09:15:00', '11:00:00']);
    // Strongest first: the 09:15 case (CE 120 → 100) is case 1.
    expect(t.cases[0].versions[0].gap).toBeGreaterThan(t.cases[1].versions[0].gap);
  });

  test('a match near two cases at once is ignored, so cases never converge', () => {
    // NIFTY at 23,226 at 09:20 and 09:50: two cases 30 minutes apart at the start.
    const spot = (i: number) => (i === 5 || i === 35 ? 23226 : 23300);
    const t = tracker(
      spot,
      () => 120,
      () => 110,
    );
    t.onTick({ spot: 23226, ce: 110, pe: 115 }, at('11:00:00'));
    expect(t.cases.map((c) => hhmmss(c.versions[0].t1Ns))).toEqual(['09:20:00', '09:50:00']);
    // The broker later shows 23,226 at 09:35 too — 15 minutes from both cases.
    t.setBrokerCloses(DATE, 'spot', [{ minute: 9 * 60 + 35, close: 23226 }]);
    t.onTick({ spot: 23226, ce: 105, pe: 117 }, at('11:00:10'));
    expect(t.cases).toHaveLength(2);
    const t1s = t.cases.flatMap((c) => c.versions.map((v) => hhmmss(v.t1Ns)));
    expect(t1s).not.toContain('09:35:00');
    // Each case still took its own wider reading.
    expect(t.cases.map((c) => c.versions.length)).toEqual([2, 2]);
  });

  test('BUY legs flip the sign of each delta', () => {
    const long = {
      ...LEGS,
      ce: { ...LEGS.ce, qty: 65 },
      pe: { ...LEGS.pe, qty: 65 },
    };
    const sell = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
    );
    const buy = tracker(
      onlyAtTen,
      () => 120,
      () => 110,
      long,
    );
    const [s] = sell.onTick({ spot: 23226, ce: 104, pe: 117 }, at('11:49:00'));
    const [b] = buy.onTick({ spot: 23226, ce: 104, pe: 117 }, at('11:49:00'));
    expect(b.versions[0].ceDelta).toBeCloseTo(-s.versions[0].ceDelta, 2);
    expect(b.versions[0].peDelta).toBeCloseTo(-s.versions[0].peDelta, 2);
  });

  test('broker closes win over tick closes, and ticks fill minutes the broker lacks', () => {
    const t = new StrategyMismatchTracker(LEGS);
    t.onTick({ spot: 23226, ce: 120, pe: 110 }, at('10:00:10'));
    t.onTick({ spot: 23226.4, ce: 121, pe: 109 }, at('10:00:50'));
    expect(t.closeAt('ce', istMinute(at('10:00:00')))).toBe(121);
    // A minute where only the index ticked still carries the legs' last prices.
    t.onTick({ spot: 23230 }, at('10:01:30'));
    expect(t.closeAt('pe', istMinute(at('10:01:00')))).toBe(109);
    t.setBrokerCloses(DATE, 'ce', [{ minute: istMinute(at('10:00:00')), close: 120.5 }]);
    expect(t.closeAt('ce', istMinute(at('10:00:00')))).toBe(120.5);
  });

  test('MCX is evaluated in its evening session, NSE is not', () => {
    const mcxLegs: StrategyLegs = {
      ...LEGS,
      asset: 'CRUDEOIL',
      exchange: 'MCX',
      underlyingType: 'FUT',
      entryNs: at('09:00') * 1_000_000,
    };
    const mcx = new StrategyMismatchTracker(mcxLegs);
    const nse = new StrategyMismatchTracker(LEGS);
    const evening = Array.from({ length: 60 }, (_, i) => ({ minute: 21 * 60 + i, close: 0 }));
    for (const t of [mcx, nse]) {
      t.setBrokerCloses(
        DATE,
        'spot',
        evening.map((e) => ({ ...e, close: 9815 })),
      );
      t.setBrokerCloses(
        DATE,
        'ce',
        evening.map((e) => ({ ...e, close: 120 })),
      );
      t.setBrokerCloses(
        DATE,
        'pe',
        evening.map((e) => ({ ...e, close: 110 })),
      );
    }
    // 22:40: 21:00–22:10 are old enough; crude back at ₹9,815.50, CE down, PE up.
    expect(mcx.onTick({ spot: 9815.5, ce: 100, pe: 118 }, at('22:40:00')).length).toBeGreaterThan(
      0,
    );
    expect(nse.onTick({ spot: 9815.5, ce: 100, pe: 118 }, at('22:40:00'))).toEqual([]);
  });

  test('nothing is evaluated outside the session', () => {
    const t = tracker(
      () => 23226,
      () => 120,
      () => 110,
    );
    expect(t.onTick({ spot: 23226, ce: 100, pe: 118 }, at('15:31:00'))).toEqual([]);
  });
});
