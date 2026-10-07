import { describe, expect, test } from 'vitest';
import { SESSION_BARS, emptyGrid, type DaySeries, type Grid } from '../analysis/daySeries.ts';
import {
  DEFAULT_TRADE_PARAMS,
  premiumRangeFor,
  premiumUniverse,
  simulateSignalTrade,
  type OhlcSeries,
  type OhlcSource,
  type TradeParams,
} from './trade.ts';

const SIGNAL = 30; // t2 = 09:45, so a 1-minute delay enters at 09:46 (index 31)
const ENTRY = SIGNAL + 1;
const EXIT = SESSION_BARS - 1; // 15:29

function grid(base: number, at: Record<number, number | null> = {}): Grid {
  const g = emptyGrid().map(() => base) as Grid;
  for (const [i, v] of Object.entries(at)) g[Number(i)] = v;
  return g;
}

/** Spot flat at 23250 → ATM 23250; OTM 2 is 23350 CE / 23150 PE. */
function makeDay(ce: Grid, pe: Grid = grid(80)): DaySeries {
  return {
    v: 1,
    underlying: 'NIFTY',
    date: '2026-01-05',
    source: 'nubra',
    expiry: '2026-01-06',
    monthly: false,
    spot: grid(23250),
    ce: { '23350': ce },
    pe: { '23150': pe },
  };
}

const params = (over: Partial<TradeParams> = {}): TradeParams => ({
  ...DEFAULT_TRADE_PARAMS,
  ...over,
});

function ohlcOf(series: Partial<Record<'CE' | 'PE', OhlcSeries>>): OhlcSource {
  return { series: (kind) => series[kind] ?? null, strikes: () => [] };
}

/** A day with a CE and PE ladder whose premiums fall as strikes move out of the money. */
function ladderDay(): DaySeries {
  const day = makeDay(grid(0));
  day.ce = {};
  day.pe = {};
  // CE 23250 → 120, 23300 → 90, 23350 → 60, 23400 → 44, 23450 → 30 (and mirrored for PE).
  const premiums = [120, 90, 60, 44, 30];
  premiums.forEach((p, n) => {
    day.ce[String(23250 + n * 50)] = grid(p);
    day.pe[String(23250 - n * 50)] = grid(p);
  });
  return day;
}

describe('simulateSignalTrade', () => {
  test('SELL on closes only: entry at the close, extremes and final P&L', () => {
    const day = makeDay(grid(100, { 40: 90, 50: 120, [EXIT]: 95 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.trade;
    expect(t).toMatchObject({ entryTime: '09:46', atm: 23250, qty: 65, basis: 'close' });
    expect(t.legs[0]).toMatchObject({
      kind: 'CE',
      strike: 23350,
      entryOpen: null,
      entryPrice: 100,
      exitPrice: 95,
      exitTime: '15:29',
      exitFallback: false,
    });
    // Short: premium down is profit. 90 → +₹650 at 09:55; 120 → −₹1,300 at 10:05; 95 → +₹325.
    expect(t).toMatchObject({
      maxProfit: 650,
      maxProfitTime: '09:55',
      maxLoss: -1300,
      maxLossTime: '10:05',
      pnl: 325,
    });
  });

  test('BUY with OHLC: entry is the mean of open and close, highs/lows set the extremes', () => {
    const o = grid(100, { [ENTRY]: 98 });
    const c = grid(100, { [ENTRY]: 102, [EXIT]: 104 });
    const h = grid(101, { 60: 130 });
    const l = grid(99, { 70: 80 });
    const day = makeDay(c);
    const r = simulateSignalTrade(
      day,
      SIGNAL,
      params({ legs: 'CE', side: 'BUY' }),
      ohlcOf({ CE: { o, h, l, c } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.legs[0]).toMatchObject({ entryOpen: 98, entryClose: 102, entryPrice: 100 });
    expect(r.trade).toMatchObject({
      basis: 'ohlc',
      maxProfit: 1950, // (130 − 100) × 65 at 10:15
      maxProfitTime: '10:15',
      maxLoss: -1300, // (80 − 100) × 65 at 10:25
      maxLossTime: '10:25',
      pnl: 260, // (104 − 100) × 65
    });
  });

  test('a close beyond the high/low (other source) still counts: max(high, close)', () => {
    const o = grid(100);
    const h = grid(101);
    const l = grid(99);
    const c = grid(100, { 80: 140 }); // the day's close grid disagrees with the parquet high
    const r = simulateSignalTrade(
      makeDay(c),
      SIGNAL,
      params({ legs: 'CE', side: 'BUY' }),
      ohlcOf({ CE: { o, h, l, c: grid(100) } }),
    );
    expect(r.ok && r.trade.maxProfit).toBe(2600); // (140 − 100) × 65
  });

  test('both legs: P&L adds up, extremes are a per-minute bound', () => {
    const ce = grid(100, { 40: 90, [EXIT]: 95 });
    const pe = grid(80, { 40: 70, 60: 100, [EXIT]: 85 });
    const r = simulateSignalTrade(makeDay(ce, pe), SIGNAL, params({ legs: 'BOTH' }), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.legs.map((l) => [l.kind, l.strike])).toEqual([
      ['CE', 23350],
      ['PE', 23150],
    ]);
    // Short both: CE +325, PE −325.
    expect(r.trade.pnl).toBe(0);
    // Best minute 09:55: both down 10 → +₹1,300. Worst 10:15: PE up 20 → −₹1,300.
    expect(r.trade).toMatchObject({
      maxProfit: 1300,
      maxProfitTime: '09:55',
      maxLoss: -1300,
      maxLossTime: '10:15',
    });
  });

  test('lots multiply the quantity', () => {
    const day = makeDay(grid(100, { [EXIT]: 90 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE', lots: 3 }), null);
    expect(r.ok && r.trade).toMatchObject({ qty: 195, pnl: 1950 });
  });

  test('a missing exit price falls back to the last close, flagged', () => {
    const day = makeDay(grid(100, { [EXIT - 1]: 97, [EXIT]: null }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r.ok && r.trade.legs[0]).toMatchObject({
      exitPrice: 97,
      exitTime: '15:28',
      exitFallback: true,
    });
  });

  test('skips when the strike has no data', () => {
    const r = simulateSignalTrade(makeDay(grid(100)), SIGNAL, params({ otmSteps: 5 }), null);
    expect(r).toEqual({ ok: false, reason: 'no data for 23500 CE' });
  });

  test('an override for a distance from expiry replaces the OTM steps on days at that distance only', () => {
    const day = makeDay(grid(100));
    day.ce['23400'] = grid(70);
    const over = { '0': 3, '4': 1 };
    // The expiry day (0 trading days out) takes its override of 3 steps: 23400.
    const expiryDay = simulateSignalTrade(
      day,
      SIGNAL,
      params({ legs: 'CE', otmSteps: 2, otmStepsByDte: over }),
      null,
      0,
    );
    expect(expiryDay.ok && expiryDay.trade).toMatchObject({
      otmSteps: 3,
      legs: [{ strike: 23400 }],
    });
    // Four days out has its own override, of 1 step.
    const fourOut = simulateSignalTrade(
      { ...day, ce: { ...day.ce, '23300': grid(90) } },
      SIGNAL,
      params({ legs: 'CE', otmSteps: 2, otmStepsByDte: over }),
      null,
      4,
    );
    expect(fourOut.ok && fourOut.trade).toMatchObject({ otmSteps: 1, legs: [{ strike: 23300 }] });
    // A distance with no override, and a day whose distance is unknown, use the default.
    for (const dte of [1, null]) {
      const r = simulateSignalTrade(
        day,
        SIGNAL,
        params({ legs: 'CE', otmSteps: 2, otmStepsByDte: over }),
        null,
        dte,
      );
      expect(r.ok && r.trade).toMatchObject({ otmSteps: 2, legs: [{ strike: 23350 }] });
    }
  });

  test('the weekday does not matter, only the distance from expiry', () => {
    const day = makeDay(grid(100));
    day.ce['23400'] = grid(70);
    const p = params({ legs: 'CE', otmSteps: 2, otmStepsByDte: { '0': 3 } });
    // 2026-01-05 is a Monday and 2026-01-09 a Friday; both are the expiry day here.
    for (const date of ['2026-01-05', '2026-01-09']) {
      const r = simulateSignalTrade({ ...day, date }, SIGNAL, p, null, 0);
      expect(r.ok && r.trade.legs[0].strike).toBe(23400);
    }
  });

  test('skips when the entry would not come before the exit', () => {
    const r = simulateSignalTrade(makeDay(grid(100)), EXIT - 1, params({ legs: 'CE' }), null);
    expect(r).toEqual({ ok: false, reason: 'entry is not before exit' });
  });

  test('skips when there is no price at the entry minute', () => {
    const day = makeDay(grid(100, { [ENTRY]: null }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r).toEqual({ ok: false, reason: 'no 23350 CE price at entry 09:46' });
  });
});

describe('stop paths', () => {
  test('closes only: a step each time the loss goes deeper, starting from the previous close', () => {
    // Short CE at 100: 105 (−325), 101 just before 110 (−650), 108 just before 120 (−1,300).
    const day = makeDay(grid(100, { 40: 105, 49: 101, 50: 110, 59: 108, 60: 120 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.stop.trade).toEqual({
      premium: 6500,
      steps: [
        [40, 325, 0],
        [50, 650, 65],
        [60, 1300, 520],
      ],
    });
    // One leg: its own path is the trade's.
    expect(r.trade.stop.legs).toEqual([r.trade.stop.trade]);
  });

  test('both legs: one leg at its extreme with the other at its close, not both extremes added', () => {
    // At 10:15 the CE trades up to 110 and the PE down to 70 inside the minute; both close flat.
    const ce = { o: grid(100), h: grid(100, { 60: 110 }), l: grid(100), c: grid(100) };
    const pe = { o: grid(80), h: grid(80, { 60: 95 }), l: grid(80, { 60: 70 }), c: grid(80) };
    const r = simulateSignalTrade(
      makeDay(grid(100), grid(80)),
      SIGNAL,
      params({ legs: 'BOTH' }),
      ohlcOf({ CE: ce, PE: pe }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The per-minute bound adds the CE high and the PE high: (10 + 15) × 65.
    expect(r.trade.maxLoss).toBe(-1625);
    // The stop path takes the worse leg alone: PE at 95 with the CE at its close, 15 × 65.
    expect(r.trade.stop.trade.steps).toEqual([[60, 975, 0]]);
    expect(r.trade.stop.trade.premium).toBe(11700);
    expect(r.trade.stop.legs.map((p) => p.steps)).toEqual([[[60, 650, 0]], [[60, 975, 0]]]);
  });

  test('an open beyond the previous close is where a jump through the stop fills', () => {
    const o = grid(100, { 50: 130 });
    const h = grid(100, { 50: 135 });
    const c = grid(100, { 50: 125 });
    const r = simulateSignalTrade(
      makeDay(c),
      SIGNAL,
      params({ legs: 'CE' }),
      ohlcOf({ CE: { o, h, l: grid(100), c } }),
    );
    // Opened 30 against (₹1,950), reached 35 (₹2,275).
    expect(r.ok && r.trade.stop.trade.steps).toEqual([[50, 2275, 1950]]);
  });

  test('after a missing minute the loss starts at the closes where the data resumes', () => {
    const day = makeDay(grid(100, { 49: null, 50: 120 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r.ok && r.trade.stop.trade.steps).toEqual([[50, 1300, 1300]]);
  });

  test('a long trade loses on the way down', () => {
    const day = makeDay(grid(100, { 45: 90 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE', side: 'BUY' }), null);
    expect(r.ok && r.trade.stop.trade.steps).toEqual([[45, 650, 0]]);
  });
});

describe('target paths and the spot range', () => {
  test('a step each time the profit goes higher; a short gains as the premium falls', () => {
    // Short CE at 100: 95 (+325), back up, 91 just before 85 (+975).
    const day = makeDay(grid(100, { 40: 95, 49: 91, 50: 85, 60: 102 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.trade.target).toEqual({
      premium: 6500,
      steps: [
        [40, 325, 0],
        [49, 585, 0],
        [50, 975, 585],
      ],
    });
  });

  test('both legs: one leg at its low with the other at its close, not both lows added', () => {
    const ce = { o: grid(100), h: grid(100), l: grid(100, { 60: 90 }), c: grid(100) };
    const pe = { o: grid(80), h: grid(80), l: grid(80, { 60: 74 }), c: grid(80) };
    const r = simulateSignalTrade(
      makeDay(grid(100), grid(80)),
      SIGNAL,
      params({ legs: 'BOTH' }),
      ohlcOf({ CE: ce, PE: pe }),
    );
    // The per-minute bound adds both lows: (10 + 6) × 65; the target path takes the CE alone.
    expect(r.ok && r.trade.maxProfit).toBe(1040);
    expect(r.ok && r.trade.target.steps).toEqual([[60, 650, 0]]);
  });

  test('a long gains on the way up', () => {
    const day = makeDay(grid(100, { 45: 110 }));
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE', side: 'BUY' }), null);
    expect(r.ok && r.trade.target.steps).toEqual([[45, 650, 0]]);
  });

  test('the loss series: close loss every minute, and how much worse the minute got', () => {
    const c = grid(100, { 40: 110, 41: null, [EXIT]: 95 });
    const h = grid(100, { 40: 115 });
    const r = simulateSignalTrade(
      makeDay(c),
      SIGNAL,
      params({ legs: 'CE' }),
      ohlcOf({ CE: { o: grid(100), h, l: grid(100), c } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.trade.series;
    expect(s.from).toBe(ENTRY + 1);
    expect(s.close).toHaveLength(EXIT - ENTRY);
    // 09:55: closed 10 against (₹650), the high 15 against: ₹325 worse than the close.
    expect(s.close[40 - s.from]).toBe(650);
    expect(s.worst[40 - s.from]).toBe(325);
    // A minute with no close is null; the exit minute closes 5 in favour.
    expect(s.close[41 - s.from]).toBeNull();
    expect(s.close.at(-1)).toBe(-325);
  });

  test('spot at exit and its range over the trade', () => {
    const day = makeDay(grid(100));
    day.spot = grid(23250, { 10: 23500, 100: 23310, 200: 23180, [EXIT]: 23240 });
    const r = simulateSignalTrade(day, SIGNAL, params({ legs: 'CE' }), null);
    // The 23500 at 09:25 is before entry and does not count.
    expect(r.ok && r.trade).toMatchObject({ exitSpot: 23240, spotHigh: 23310, spotLow: 23180 });
  });
});

describe('premium-range strikes', () => {
  const premium = (over: Partial<TradeParams> = {}) =>
    params({
      strikeMode: 'PREMIUM',
      cePremiumMin: 40,
      cePremiumMax: 60,
      pePremiumMin: 80,
      pePremiumMax: 130,
      ...over,
    });

  test('each leg takes the in-range strike closest to the middle of its range', () => {
    const r = simulateSignalTrade(ladderDay(), SIGNAL, premium(), null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // CE ₹40–60, middle 50: 60 (off 10) and 44 (off 6) are in range → 23400 at ₹44.
    // PE ₹80–130, middle 105: 120 (off 15) and 90 (off 15) tie → the one nearer ATM, 23250.
    expect(r.trade.legs.map((l) => [l.kind, l.strike, l.entryPrice])).toEqual([
      ['CE', 23400, 44],
      ['PE', 23250, 120],
    ]);
  });

  test('a day with no strike in range is skipped with the reason', () => {
    const r = simulateSignalTrade(
      ladderDay(),
      SIGNAL,
      premium({ cePremiumMin: 5, cePremiumMax: 10 }),
      null,
    );
    expect(r).toEqual({ ok: false, reason: 'no CE strike priced ₹5–10 at 09:46' });
  });

  test('strikes the OHLC source adds can be chosen', () => {
    const far = { o: grid(12), h: grid(13), l: grid(11), c: grid(12) };
    const source: OhlcSource = {
      series: (kind, strike) => (kind === 'CE' && strike === 23600 ? far : null),
      strikes: (kind) => (kind === 'CE' ? [23600] : []),
    };
    const r = simulateSignalTrade(
      ladderDay(),
      SIGNAL,
      premium({ legs: 'CE', cePremiumMin: 10, cePremiumMax: 15 }),
      source,
    );
    expect(r.ok && r.trade.legs[0]).toMatchObject({ strike: 23600, entryPrice: 12, basis: 'ohlc' });
  });
});

describe('premium ranges by distance from expiry', () => {
  const premium = (over: Partial<TradeParams> = {}) =>
    params({
      strikeMode: 'PREMIUM',
      cePremiumMin: 40,
      cePremiumMax: 60,
      pePremiumMin: 80,
      pePremiumMax: 130,
      ...over,
    });
  const expiryDayOnly: TradeParams['cePremiumByDte'] = { '0': [85, 95] };

  test('that distance’s override wins; every other distance and side keeps the global range', () => {
    const p = premium({ cePremiumByDte: expiryDayOnly });
    expect(premiumRangeFor(p, 'CE', 0)).toEqual([85, 95]);
    expect(premiumRangeFor(p, 'CE', 1)).toEqual([40, 60]);
    expect(premiumRangeFor(p, 'PE', 0)).toEqual([80, 130]); // the other side
    expect(premiumRangeFor(p, 'CE', null)).toEqual([40, 60]); // distance unknown
  });

  test('an expiry-day override changes the strike sold on the expiry day only', () => {
    const p = premium({ legs: 'CE', cePremiumByDte: expiryDayOnly });
    const onExpiry = simulateSignalTrade(ladderDay(), SIGNAL, p, null, 0);
    // ₹85–95: the ₹90 strike, 23300, though the global ₹40–60 would have sold 23400.
    expect(onExpiry.ok && onExpiry.trade.legs[0]).toMatchObject({ strike: 23300, entryPrice: 90 });

    const dayBefore = simulateSignalTrade(ladderDay(), SIGNAL, p, null, 1);
    expect(dayBefore.ok && dayBefore.trade.legs[0]).toMatchObject({
      strike: 23400,
      entryPrice: 44,
    });
  });

  test('a day with nothing inside its range is skipped with that range in the reason', () => {
    const p = premium({ legs: 'CE', cePremiumByDte: { '0': [1, 2] } });
    const r = simulateSignalTrade(ladderDay(), SIGNAL, p, null, 0);
    expect(r).toEqual({ ok: false, reason: 'no CE strike priced ₹1–2 at 09:46' });
  });
});

describe('premium mode that trades only the distances with a chosen range', () => {
  const dataOnly = (over: Partial<TradeParams> = {}) =>
    params({
      strikeMode: 'PREMIUM',
      legs: 'CE',
      premiumTiersOnly: true,
      // Typed ranges that must be ignored entirely.
      cePremiumMin: 40,
      cePremiumMax: 60,
      cePremiumByDte: { '0': [85, 95] },
      ...over,
    });

  test('a distance with a chosen range trades inside it', () => {
    const r = simulateSignalTrade(ladderDay(), SIGNAL, dataOnly(), null, 0);
    expect(r.ok && r.trade.legs[0]).toMatchObject({ strike: 23300, entryPrice: 90 });
  });

  test('a distance with none is skipped, and the typed range is not used as a fallback', () => {
    // ₹40–60 would have sold the 23400 call at ₹44; with the data-only rule it must not.
    expect(simulateSignalTrade(ladderDay(), SIGNAL, dataOnly(), null, 1)).toEqual({
      ok: false,
      reason: 'no CE premium range chosen for 1 day before expiry',
    });
    expect(simulateSignalTrade(ladderDay(), SIGNAL, dataOnly(), null, 3)).toEqual({
      ok: false,
      reason: 'no CE premium range chosen for 3 days before expiry',
    });
    expect(premiumRangeFor(dataOnly(), 'CE', 1)).toBeNull();
    expect(premiumRangeFor(dataOnly(), 'CE', 0)).toEqual([85, 95]);
  });

  test('a day whose distance is unknown has no tier to use', () => {
    expect(simulateSignalTrade(ladderDay(), SIGNAL, dataOnly(), null, null)).toEqual({
      ok: false,
      reason: 'no CE premium range chosen for a day whose expiry distance is unknown',
    });
  });

  test('each side is judged on its own', () => {
    const r = simulateSignalTrade(ladderDay(), SIGNAL, dataOnly({ legs: 'BOTH' }), null, 0);
    // The put has no range chosen for the expiry day, so the whole trade is skipped on that reason.
    expect(r).toEqual({ ok: false, reason: 'no PE premium range chosen for the expiry day' });
  });
});

describe('premiumUniverse', () => {
  test('lists the entry prices of ATM and out-of-the-money strikes, ₹1 and up', () => {
    const day = ladderDay(); // ATM 23250: CE 120, 90, 60, 44, 30 outward; PE the same going down
    day.ce['23200'] = grid(150); // in the money: not something a premium seller means
    day.pe['23300'] = grid(150);
    day.ce['23500'] = grid(0.5); // a dying strike
    const u = premiumUniverse(day, ENTRY, null)!;
    expect([...u.CE].sort((a, b) => b - a)).toEqual([120, 90, 60, 44, 30]);
    expect([...u.PE].sort((a, b) => b - a)).toEqual([120, 90, 60, 44, 30]);
  });

  test('uses the same entry price the trade does: the open/close mean when an open exists', () => {
    const day = ladderDay();
    const source: OhlcSource = {
      series: (kind, strike) =>
        kind === 'CE' && strike === 23350
          ? { o: grid(64), h: grid(65), l: grid(59), c: grid(60) }
          : null,
      strikes: () => [],
    };
    const u = premiumUniverse(day, ENTRY, source)!;
    expect(u.CE).toContain(62); // (64 + 60) / 2, not the bare close of 60
    expect(u.CE).not.toContain(60);
  });

  test('includes strikes only the OHLC source holds', () => {
    const far = { o: grid(12), h: grid(13), l: grid(11), c: grid(12) };
    const source: OhlcSource = {
      series: (kind, strike) => (kind === 'CE' && strike === 23600 ? far : null),
      strikes: (kind) => (kind === 'CE' ? [23600] : []),
    };
    expect(premiumUniverse(ladderDay(), ENTRY, source)!.CE).toContain(12);
  });

  test('is null when the entry minute has no spot', () => {
    const day = ladderDay();
    day.spot[ENTRY] = null;
    expect(premiumUniverse(day, ENTRY, null)).toBeNull();
  });
});
