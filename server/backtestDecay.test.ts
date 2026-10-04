import { describe, expect, it } from 'vitest';
import {
  TICK_RETENTION_MS,
  replayDecay,
  tickCoverageStart,
  type MinuteCloses,
} from './backtestDecay.ts';
import { istMinuteToMs, type StrategyLegs } from './mismatchTracker.ts';

const DATE = '2026-09-28';
const OPEN = 9 * 60 + 15;

const legs: StrategyLegs = {
  basketGroupId: 'nubra-bt',
  asset: 'NIFTY',
  exchange: 'NSE',
  underlyingType: 'INDEX',
  ce: { refId: 1, nubraName: 'CE', qty: -65 },
  pe: { refId: 2, nubraName: 'PE', qty: -65 },
  entryNs: istMinuteToMs(DATE, OPEN) * 1_000_000,
};

/** Spot flat all morning; the CE loses a rupee a minute, the PE is flat — every pair diverges. */
function morning(minutes = 90): MinuteCloses {
  const c: MinuteCloses = { spot: [], ce: [], pe: [] };
  for (let i = 0; i < minutes; i++) {
    c.spot.push({ minute: OPEN + i, close: 25000 });
    c.ce.push({ minute: OPEN + i, close: 200 - i });
    c.pe.push({ minute: OPEN + i, close: 150 });
  }
  return c;
}

describe('tickCoverageStart', () => {
  const from = OPEN * 60;
  const to = (15 * 60 + 29) * 60 + 59;
  const sessionOpenMs = istMinuteToMs(DATE, OPEN);

  it('covers the whole window inside retention', () => {
    expect(tickCoverageStart(DATE, from, to, sessionOpenMs + 3_600_000)).toBe(from);
  });

  it('starts part-way through when the retention edge falls inside the window', () => {
    // The edge (plus its 5-minute margin) lands at 11:00 IST.
    const now = istMinuteToMs(DATE, 11 * 60) + TICK_RETENTION_MS - 5 * 60_000;
    expect(tickCoverageStart(DATE, from, to, now)).toBe(11 * 3600);
  });

  it('has nothing for a day older than a week', () => {
    const now = istMinuteToMs(DATE, 16 * 60) + TICK_RETENTION_MS;
    expect(tickCoverageStart(DATE, from, to, now)).toBeNull();
  });
});

describe('replayDecay', () => {
  it('finds cases from minute closes alone when no ticks are left', () => {
    const r = replayDecay({
      legs,
      date: DATE,
      entryMinute: OPEN,
      exitMinute: OPEN + 89,
      closes: morning(),
      ticks: null,
      tickFromSec: null,
    });
    expect(r.resolution).toBe('1m');
    expect(r.cases.length).toBeGreaterThan(0);
    const v = r.cases[0].versions.at(-1)!;
    // Short CE that lost value = a gain on that leg; the PE didn't move.
    expect(v.ceDelta).toBeGreaterThan(0);
    expect(Math.abs(v.peDelta)).toBe(0);
    // Minute walk: the live moment is a minute's last second.
    expect(new Date(v.t2Ns / 1e6).getUTCSeconds()).toBe(59);
  });

  it('scores the live side on recorded ticks, to the second', () => {
    const closes = morning();
    const ticks = { spot: [] as Array<{ sec: number; close: number }>, ce: [], pe: [] } as {
      spot: Array<{ sec: number; close: number }>;
      ce: Array<{ sec: number; close: number }>;
      pe: Array<{ sec: number; close: number }>;
    };
    // Index ticks every second; the options only trade at :17 of each minute.
    for (let s = OPEN * 60; s < (OPEN + 90) * 60; s++) {
      ticks.spot.push({ sec: s, close: 25000 });
      if (s % 60 === 17) {
        const i = Math.floor(s / 60) - OPEN;
        ticks.ce.push({ sec: s, close: 200 - i });
        ticks.pe.push({ sec: s, close: 150 });
      }
    }
    const r = replayDecay({
      legs,
      date: DATE,
      entryMinute: OPEN,
      exitMinute: OPEN + 89,
      closes,
      ticks,
      tickFromSec: OPEN * 60,
    });
    expect(r.resolution).toBe('tick');
    expect(r.steps).toBeGreaterThan(5000);
    expect(r.cases.length).toBeGreaterThan(0);
    const seconds = r.cases.flatMap((c) =>
      c.versions.map((v) => new Date(v.t2Ns / 1e6).getUTCSeconds()),
    );
    expect(seconds.some((s) => s !== 59)).toBe(true);
  });

  it('switches from minutes to ticks where the ticks begin', () => {
    const closes = morning();
    const from = (OPEN + 45) * 60;
    const ticks = { spot: [], ce: [], pe: [] } as {
      spot: Array<{ sec: number; close: number }>;
      ce: Array<{ sec: number; close: number }>;
      pe: Array<{ sec: number; close: number }>;
    };
    for (let s = from; s < (OPEN + 90) * 60; s++) ticks.spot.push({ sec: s, close: 25000 });
    const r = replayDecay({
      legs,
      date: DATE,
      entryMinute: OPEN,
      exitMinute: OPEN + 89,
      closes,
      ticks,
      tickFromSec: from,
    });
    expect(r.resolution).toBe('mixed');
    // 45 minute steps before the switch, then a step per second after it.
    expect(r.steps).toBe(45 + 45 * 60);
    expect(r.cases.length).toBeGreaterThan(0);
  });

  it('ignores everything after the exit minute', () => {
    const r = replayDecay({
      legs,
      date: DATE,
      entryMinute: OPEN,
      exitMinute: OPEN + 20,
      closes: morning(),
      ticks: null,
      tickFromSec: null,
    });
    // Nothing can be 30 minutes after an earlier minute inside a 21-minute trade.
    expect(r.cases).toEqual([]);
  });
});
