import { describe, it, expect } from 'vitest';
import {
  liveLevels,
  levelHit,
  normalizeExitTime,
  exitTimeMinutes,
  istMinuteOfDay,
  exitTimeDue,
} from './positionRuleLevels';

const NONE = { type: 'NONE' } as const;

describe('liveLevels — PREMIUM_PRICE (absolute level)', () => {
  it('returns the level verbatim regardless of side', () => {
    const buy = liveLevels(
      'BUY',
      82.7,
      { type: 'PREMIUM_PRICE', value: 81.5 },
      { type: 'PREMIUM_PRICE', value: 84 },
    );
    expect(buy).toEqual({ slPrice: 81.5, tgtPrice: 84 });

    const sell = liveLevels(
      'SELL',
      82.7,
      { type: 'PREMIUM_PRICE', value: 90 },
      { type: 'PREMIUM_PRICE', value: 60 },
    );
    expect(sell).toEqual({ slPrice: 90, tgtPrice: 60 });
  });

  it('coerces numeric strings, which JSON round-trips can produce', () => {
    const r = liveLevels('BUY', 82.7, NONE, {
      type: 'PREMIUM_PRICE',
      value: '84' as unknown as number,
    });
    expect(r.tgtPrice).toBe(84);
  });
});

describe('liveLevels — parity with the backtest engine (premiumLevels)', () => {
  // Pinned expected values, mirroring server/backtest/engine.ts:200-209. That
  // module can't be imported here (it pulls in the parquet data layer), so these
  // literals are the guard against the two implementations drifting apart.
  it('PREMIUM_ABSOLUTE is an offset from entry — adverse for SL, favourable for target', () => {
    expect(
      liveLevels(
        'BUY',
        100,
        { type: 'PREMIUM_ABSOLUTE', value: 20 },
        { type: 'PREMIUM_ABSOLUTE', value: 30 },
      ),
    ).toEqual({ slPrice: 80, tgtPrice: 130 });
    expect(
      liveLevels(
        'SELL',
        100,
        { type: 'PREMIUM_ABSOLUTE', value: 20 },
        { type: 'PREMIUM_ABSOLUTE', value: 30 },
      ),
    ).toEqual({ slPrice: 120, tgtPrice: 70 });
  });

  it('PREMIUM_PERCENT is a percentage of entry premium', () => {
    expect(
      liveLevels(
        'BUY',
        100,
        { type: 'PREMIUM_PERCENT', value: 25 },
        { type: 'PREMIUM_PERCENT', value: 50 },
      ),
    ).toEqual({ slPrice: 75, tgtPrice: 150 });
    expect(
      liveLevels(
        'SELL',
        100,
        { type: 'PREMIUM_PERCENT', value: 25 },
        { type: 'PREMIUM_PERCENT', value: 50 },
      ),
    ).toEqual({ slPrice: 125, tgtPrice: 50 });
  });

  it('treats NONE and a missing value as "no level"', () => {
    expect(liveLevels('BUY', 100, NONE, NONE)).toEqual({ slPrice: null, tgtPrice: null });
    expect(liveLevels('BUY', 100, { type: 'PREMIUM_PRICE' }, { type: 'PREMIUM_ABSOLUTE' })).toEqual(
      { slPrice: null, tgtPrice: null },
    );
  });
});

describe('the reported bug — NIFTY 24000 CE, BUY @ 82.70, LTP 84.75', () => {
  const ENTRY = 82.7;
  const LTP = 84.75;

  it('PREMIUM_PRICE 84 fires the target', () => {
    const { tgtPrice } = liveLevels('BUY', ENTRY, NONE, { type: 'PREMIUM_PRICE', value: 84 });
    expect(tgtPrice).toBe(84);
    expect(levelHit('TARGET', 'BUY', tgtPrice, LTP)).toBe(true);
  });

  it('the same 84 as PREMIUM_ABSOLUTE resolves to 166.70 and does not fire', () => {
    const { slPrice, tgtPrice } = liveLevels(
      'BUY',
      ENTRY,
      { type: 'PREMIUM_ABSOLUTE', value: 81.5 },
      { type: 'PREMIUM_ABSOLUTE', value: 84 },
    );
    expect(tgtPrice).toBeCloseTo(166.7, 10);
    expect(slPrice).toBeCloseTo(1.2, 10);
    expect(levelHit('TARGET', 'BUY', tgtPrice, LTP)).toBe(false);
    expect(levelHit('SL', 'BUY', slPrice, LTP)).toBe(false);
  });
});

describe('levelHit', () => {
  it('a long loses as premium falls and profits as it rises', () => {
    expect(levelHit('SL', 'BUY', 80, 79.9)).toBe(true);
    expect(levelHit('SL', 'BUY', 80, 80.1)).toBe(false);
    expect(levelHit('TARGET', 'BUY', 120, 120)).toBe(true);
    expect(levelHit('TARGET', 'BUY', 120, 119.9)).toBe(false);
  });

  it('a short is the mirror image', () => {
    expect(levelHit('SL', 'SELL', 120, 120.1)).toBe(true);
    expect(levelHit('SL', 'SELL', 120, 119.9)).toBe(false);
    expect(levelHit('TARGET', 'SELL', 80, 80)).toBe(true);
    expect(levelHit('TARGET', 'SELL', 80, 80.1)).toBe(false);
  });

  it('never fires on a level that is switched off', () => {
    expect(levelHit('SL', 'BUY', null, 1)).toBe(false);
    expect(levelHit('TARGET', 'SELL', null, 1)).toBe(false);
  });
});

// ── Time exit ──────────────────────────────────────────────────────────────────
// Instants are written as UTC and asserted in IST (UTC+5:30) on purpose: the whole
// point of these helpers is that they read the same clock whatever timezone the
// host running them is set to.
const AT = (utcIso: string) => new Date(utcIso).getTime();

describe('normalizeExitTime', () => {
  it('accepts a 24-hour HH:MM and trims surrounding space', () => {
    expect(normalizeExitTime('15:15')).toBe('15:15');
    expect(normalizeExitTime('00:00')).toBe('00:00');
    expect(normalizeExitTime('23:59')).toBe('23:59');
    expect(normalizeExitTime(' 09:20 ')).toBe('09:20');
  });

  it('rejects everything that is not one, rather than guessing', () => {
    for (const bad of [
      '',
      '9:20', // unpadded — an input[type=time] never emits this, a hand-rolled body might
      '24:00',
      '15:60',
      '15:15:30',
      'later',
      '15-15',
      null,
      undefined,
      1515,
      {},
    ]) {
      expect(normalizeExitTime(bad)).toBeUndefined();
    }
  });
});

describe('exitTimeMinutes', () => {
  it('counts minutes from IST midnight', () => {
    expect(exitTimeMinutes('00:00')).toBe(0);
    expect(exitTimeMinutes('09:15')).toBe(555);
    expect(exitTimeMinutes('15:15')).toBe(915);
    expect(exitTimeMinutes('23:59')).toBe(1439);
  });

  it('is null for anything unparseable, so a bad value can never read as midnight', () => {
    expect(exitTimeMinutes('nope')).toBeNull();
    expect(exitTimeMinutes(undefined)).toBeNull();
  });
});

describe('istMinuteOfDay', () => {
  it('reads the IST wall clock regardless of the host timezone', () => {
    expect(istMinuteOfDay(AT('2026-08-14T09:45:00Z'))).toBe(15 * 60 + 15); // 15:15 IST
    expect(istMinuteOfDay(AT('2026-08-14T03:45:00Z'))).toBe(9 * 60 + 15); // 09:15 IST
  });

  it('handles the 18:30 UTC rollover into the next IST day', () => {
    expect(istMinuteOfDay(AT('2026-08-14T18:29:00Z'))).toBe(23 * 60 + 59);
    expect(istMinuteOfDay(AT('2026-08-14T18:30:00Z'))).toBe(0);
  });
});

describe('exitTimeDue', () => {
  const AT_1514 = AT('2026-08-14T09:44:00Z');
  const AT_1515 = AT('2026-08-14T09:45:00Z');

  it('is due from the configured minute onward, and not a minute before', () => {
    expect(exitTimeDue('15:15', AT_1514)).toBe(false);
    expect(exitTimeDue('15:15', AT_1515)).toBe(true);
    expect(exitTimeDue('15:15', AT('2026-08-14T17:00:00Z'))).toBe(true); // 22:30 IST, still due
  });

  it('is never due without a valid time — a garbled rule must not square anything off', () => {
    expect(exitTimeDue(undefined, AT_1515)).toBe(false);
    expect(exitTimeDue('', AT_1515)).toBe(false);
    expect(exitTimeDue('half past three', AT_1515)).toBe(false);
  });

  it('resets across the IST midnight rollover rather than staying latched', () => {
    // 00:05 IST on the 15th: a 15:15 rule is not due again until that afternoon.
    expect(exitTimeDue('15:15', AT('2026-08-14T18:35:00Z'))).toBe(false);
  });
});
