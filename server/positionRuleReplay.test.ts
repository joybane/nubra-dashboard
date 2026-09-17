import { beforeEach, describe, expect, it, vi } from 'vitest';

// positionRules persists through paperDb; the engine is what is under test, so the store is stubbed.
vi.mock('./paperDb.ts', () => ({
  dbUpsertPositionRule: vi.fn(),
  dbLoadPositionRules: vi.fn(() => []),
  dbDeletePositionRule: vi.fn(() => true),
}));

import type { TrailStop } from './backtest/types.ts';
import { replayRules, type ReplayBar, type ReplayLeg } from './positionRuleReplay.ts';
import {
  deleteGroupRule,
  deleteLegRule,
  evaluateAndFire,
  listPositionRules,
  upsertLegRule,
  type GroupRule,
  type LegRule,
  type RulePosition,
} from './positionRules.ts';

const ENTRY = 33_900; // 09:25:00
const NOW = 36_000; // 10:00:00

const ohlc = (sec: number, open: number, high: number, low: number, close: number): ReplayBar => ({
  sec,
  open,
  high,
  low,
  close,
});
const flat = (sec: number, p: number) => ohlc(sec, p, p, p, p);
const abs = (value: number) => ({ type: 'PREMIUM_ABSOLUTE' as const, value });

function leg(bars: ReplayBar[], over: Partial<ReplayLeg> = {}): ReplayLeg {
  return {
    ref_id: 101,
    basket_group_id: '',
    qty: -65,
    entryRs: 100,
    entrySec: ENTRY,
    bars,
    ...over,
  };
}
function legRule(over: Partial<LegRule> = {}): LegRule {
  return { scope: 'LEG', ref_id: 101, basket_group_id: '', ...over };
}

beforeEach(() => {
  for (const r of listPositionRules()) {
    if (r.scope === 'LEG') deleteLegRule(r.ref_id, r.basket_group_id);
    else deleteGroupRule(r.basket_group_id);
  }
});

describe('leg price levels', () => {
  it('stops a short on the second whose high reaches the level, at the level', () => {
    const out = replayRules(
      [leg([ohlc(ENTRY + 1, 100, 105, 99, 104), ohlc(ENTRY + 2, 104, 111, 103, 106)])],
      [legRule({ stopLoss: abs(10) })],
      undefined,
      NOW,
    );
    expect(out.exits).toEqual([
      {
        scope: 'LEG',
        reason: 'STOPLOSS',
        ref_id: 101,
        basket_group_id: '',
        sec: ENTRY + 2,
        priceRs: 110,
      },
    ]);
    expect(out.legRulesSpent).toEqual([{ ref_id: 101, basket_group_id: '' }]);
  });

  it("takes a short's target on the second's low", () => {
    const out = replayRules(
      [leg([ohlc(ENTRY + 1, 100, 101, 79, 85)])],
      [legRule({ target: abs(20) })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'TARGET', priceRs: 80 });
  });

  it('takes the stop-loss when one second spans both levels', () => {
    const out = replayRules(
      [leg([ohlc(ENTRY + 1, 100, 112, 78, 95)])],
      [legRule({ stopLoss: abs(10), target: abs(20) })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'STOPLOSS', priceRs: 110 });
  });

  it('fills a gap through the level at the open', () => {
    const out = replayRules(
      [leg([ohlc(ENTRY + 1, 115, 118, 112, 116)])],
      [legRule({ stopLoss: abs(10) })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'STOPLOSS', priceRs: 115 });
  });

  it('mirrors the levels for a long', () => {
    const out = replayRules(
      [leg([ohlc(ENTRY + 1, 95, 96, 88, 89)], { qty: 65 })],
      [legRule({ stopLoss: abs(10) })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'STOPLOSS', priceRs: 90 });
  });

  it('ignores seconds at or before the entry and after now', () => {
    const out = replayRules(
      [leg([ohlc(ENTRY, 100, 200, 100, 150), ohlc(NOW + 1, 100, 200, 100, 150)])],
      [legRule({ stopLoss: abs(10) })],
      undefined,
      NOW,
    );
    expect(out.exits).toEqual([]);
    expect(out.legRulesSpent).toEqual([]);
  });
});

describe('time exits already in the past', () => {
  const AT_0940 = 9 * 3600 + 40 * 60;

  it('exit at the open of the first trade at or after the minute', () => {
    const out = replayRules(
      [leg([flat(34_000, 101), ohlc(AT_0940 + 5, 102, 103, 101, 102)])],
      [legRule({ exitTime: '09:40' })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'TIME_EXIT', sec: AT_0940 + 5, priceRs: 102 });
  });

  it('exit at the minute, at the last price, when the leg never traded again', () => {
    const out = replayRules(
      [leg([flat(34_000, 101)])],
      [legRule({ exitTime: '09:40' })],
      undefined,
      NOW,
    );
    expect(out.exits[0]).toMatchObject({ reason: 'TIME_EXIT', sec: AT_0940, priceRs: 101 });
  });
});

describe('group rules', () => {
  it('judges combined ₹ on carried-forward closes, not on highs', () => {
    const group: GroupRule = { scope: 'GROUP', basket_group_id: 'bg', maxLoss: 300 };
    const out = replayRules(
      [
        leg([ohlc(ENTRY + 1, 100, 130, 100, 101), flat(ENTRY + 3, 110)], { basket_group_id: 'bg' }),
        leg([flat(ENTRY + 2, 95)], { ref_id: 102, basket_group_id: 'bg' }),
      ],
      [],
      group,
      NOW,
    );
    // +1: −65. +2: −65 + 325 = +260. +3: −650 + 325 = −325 → breaches −300.
    expect(out.exits).toEqual([
      {
        scope: 'GROUP',
        reason: 'PORTFOLIO_SL',
        ref_id: 101,
        basket_group_id: 'bg',
        sec: ENTRY + 3,
        priceRs: 110,
      },
      {
        scope: 'GROUP',
        reason: 'PORTFOLIO_SL',
        ref_id: 102,
        basket_group_id: 'bg',
        sec: ENTRY + 3,
        priceRs: 95,
      },
    ]);
    expect(out.groupRuleSpent).toBe(true);
  });

  it('cascades a leg hit to the whole group when asked to', () => {
    const group: GroupRule = { scope: 'GROUP', basket_group_id: 'bg', exitAllOnLegHit: true };
    const out = replayRules(
      [
        leg([ohlc(ENTRY + 2, 104, 111, 103, 106)], { basket_group_id: 'bg' }),
        leg([flat(ENTRY + 1, 96), ohlc(ENTRY + 2, 97, 98, 96, 97)], {
          ref_id: 102,
          basket_group_id: 'bg',
        }),
      ],
      [legRule({ basket_group_id: 'bg', stopLoss: abs(10) })],
      group,
      NOW,
    );
    expect(out.exits).toEqual([
      {
        scope: 'LEG',
        reason: 'STOPLOSS',
        ref_id: 101,
        basket_group_id: 'bg',
        sec: ENTRY + 2,
        priceRs: 110,
      },
      {
        scope: 'GROUP',
        reason: 'STOPLOSS',
        ref_id: 102,
        basket_group_id: 'bg',
        sec: ENTRY + 2,
        priceRs: 97,
      },
    ]);
    expect(out.groupRuleSpent).toBe(true);
  });
});

describe('trailing stop parity with the live engine', () => {
  /** Drive the real live engine one tick per price; index of the tick that fired, or −1. */
  function liveExitIndex(prices: number[], trail: TrailStop, qty: number): number {
    upsertLegRule({ scope: 'LEG', ref_id: 101, basket_group_id: '', trail });
    const pos: RulePosition = {
      ref_id: 101,
      nubraName: 'X',
      display_name: 'X',
      qty,
      avg_price: 10_000,
      last_traded_price: 10_000,
      order_delivery_type: 'IDAY',
      basket_group_id: '',
      entry_time: 1,
    };
    const broker = { placeOrder: vi.fn(), getPositions: () => [pos] };
    try {
      for (let i = 0; i < prices.length; i++) {
        pos.last_traded_price = Math.round(prices[i] * 100);
        if (evaluateAndFire(broker, 101, Date.parse('2026-09-15T04:00:00Z')).length) return i;
      }
      return -1;
    } finally {
      deleteLegRule(101, '');
    }
  }
  function replayExitIndex(prices: number[], trail: TrailStop, qty: number): number {
    const out = replayRules(
      [
        leg(
          prices.map((p, i) => flat(ENTRY + 1 + i, p)),
          { qty },
        ),
      ],
      [legRule({ trail })],
      undefined,
      NOW,
    );
    return out.exits.length ? out.exits[0].sec - ENTRY - 1 : -1;
  }

  const cases: Array<[string, number[], TrailStop, number, number]> = [
    [
      'short TRAIL',
      [98, 94, 90, 89, 93, 95, 97],
      { type: 'TRAIL', trigger: 5, step: 5, trail: 3 },
      -65,
      5,
    ],
    ['short TO_COST', [99, 95, 97, 100.5], { type: 'TO_COST', trigger: 4 }, -65, 3],
    [
      'long LOCK_AND_TRAIL',
      [103, 106, 111, 108, 104, 103, 101],
      { type: 'LOCK_AND_TRAIL', trigger: 5, lock: 2, step: 5, trail: 2 },
      65,
      6,
    ],
    [
      'short TRAIL that never fires',
      [98, 94, 90, 89],
      { type: 'TRAIL', trigger: 5, step: 5, trail: 3 },
      -65,
      -1,
    ],
  ];

  it.each(cases)('%s exits on the same price as live', (_name, prices, trail, qty, expected) => {
    expect(liveExitIndex(prices, trail, qty)).toBe(expected);
    expect(replayExitIndex(prices, trail, qty)).toBe(expected);
  });

  it('hands back the trail it reached when nothing fired, to seed the live engine', () => {
    const out = replayRules(
      [leg([98, 94, 90, 89].map((p, i) => flat(ENTRY + 1 + i, p)))],
      [legRule({ trail: { type: 'TRAIL', trigger: 5, step: 5, trail: 3 } })],
      undefined,
      NOW,
    );
    expect(out.legTrails).toEqual([
      { ref_id: 101, basket_group_id: '', state: { slPriceRs: 94, favExtremeRs: 89 } },
    ]);
  });
});
