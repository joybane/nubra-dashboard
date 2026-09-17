import { describe, expect, it } from 'vitest';
import {
  candleSecond,
  describeReplay,
  istHmsFromNs,
  istToday,
  matchChainLegs,
  normalizeHms,
} from './backdatedEntry';

describe('candleSecond', () => {
  it("maps a candle's open to its first second and close or VWAP to its last", () => {
    expect(candleSecond('09:25', 'open')).toBe('09:25:00');
    expect(candleSecond('09:25', 'close')).toBe('09:25:59');
    expect(candleSecond('09:25', 'vwap')).toBe('09:25:59');
  });
});

describe('matchChainLegs', () => {
  const chain = {
    ce: [{ ref_id: 11, sp: 2_330_000, symbol: 'NIFTY2692223300CE' }],
    pe: [
      { ref_id: 22, sp: 23100, symbol: 'NIFTY2692223100PE' },
      { ref_id: 33, sp: 2_320_000 },
    ],
  };

  it('matches legs by strike (paise or rupees) and side', () => {
    const legs = [
      { strike: 23300, optionType: 'CE' as const, id: 'a' },
      { strike: 23100, optionType: 'PE' as const, id: 'b' },
    ];
    const out = matchChainLegs(chain, legs);
    expect(out.missing).toEqual([]);
    expect(out.matched.map((m) => [m.leg.id, m.refId, m.symbol])).toEqual([
      ['a', 11, 'NIFTY2692223300CE'],
      ['b', 22, 'NIFTY2692223100PE'],
    ]);
  });

  it('reports legs with no row, the wrong side, or no history symbol as missing', () => {
    const legs = [
      { strike: 23300, optionType: 'PE' as const },
      { strike: 23500, optionType: 'CE' as const },
      { strike: 23200, optionType: 'PE' as const },
    ];
    expect(matchChainLegs(chain, legs).missing).toEqual(legs);
  });
});

describe('time helpers', () => {
  it('reads IST dates and clocks', () => {
    const late = Date.parse('2026-09-15T19:00:00Z'); // 00:30 IST on the 16th
    expect(istToday(late)).toBe('2026-09-16');
    expect(istHmsFromNs(Date.parse('2026-09-15T03:55:30Z') * 1_000_000)).toBe('09:25:30');
    expect(normalizeHms('09:25')).toBe('09:25:00');
  });

  it('describes replayed exits, one clause per moment', () => {
    expect(
      describeReplay([
        {
          ref_id: 1,
          basket_group_id: 'g',
          scope: 'GROUP',
          reason: 'PORTFOLIO_SL',
          time: '09:30:00',
          price: 95,
        },
        {
          ref_id: 2,
          basket_group_id: 'g',
          scope: 'GROUP',
          reason: 'PORTFOLIO_SL',
          time: '09:30:00',
          price: 90,
        },
      ]),
    ).toBe('Max loss hit at 09:30:00 — 2 legs closed');
  });
});
