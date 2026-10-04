import { describe, expect, test } from 'vitest';
import {
  DEFAULT_TRADE_PARAMS,
  NO_FILTER,
  buildCsv,
  cleanRangeMap,
  cleanStepMap,
  csvCell,
  describeFilter,
  dteShort,
  dteBadge,
  dteLabel,
  filterActive,
  filterRows,
  fmtGreek,
  greekChange,
  inr,
  legEntryPrice,
  rangeText,
  sameRange,
  strikeRule,
  tradePnlSeries,
  tradeStats,
  weekdayIndex,
  type LegGreeks,
  type SignalBacktestRow,
  type TradeParams,
} from './signalBacktest';

const ceT1: LegGreeks = { iv: 14.5, delta: 0.31, gamma: 0.0006, theta: -9.5, vega: 7.2 };
const ceT2: LegGreeks = { iv: 13.9, delta: 0.27, gamma: 0.0006, theta: -9.1, vega: 6.8 };
const peT1: LegGreeks = { iv: 15.1, delta: -0.28, gamma: 0.0006, theta: -8.7, vega: 7.0 };

const row: SignalBacktestRow = {
  date: '2026-05-04',
  source: 'nubra',
  expiry: '2026-05-05',
  ohlcSource: 'nubra-wide',
  signal: {
    legs: { ceStrike: 24300, peStrike: 24100, entryTime: '09:15', entrySpot: 24195 },
    // The PE could not be priced at t2: its t2 and change cells must come out blank.
    greeks: { t1: { CE: ceT1, PE: peT1 }, t2: { CE: ceT2, PE: null } },
    t1: '09:15',
    t2: '10:28',
    spot1: 24195.1,
    spot2: 24195.6,
    ce1: 100,
    ce2: 72.8,
    pe1: 90,
    pe2: 94.45,
    ceDelta: 1768,
    peDelta: -289.25,
    totalDelta: 1478.75,
    gap: 2057.25,
  },
  trade: {
    entryTime: '10:29',
    entrySpot: 24201,
    atm: 24200,
    step: 50,
    otmSteps: 2,
    qty: 65,
    side: 'SELL',
    legs: [
      {
        kind: 'CE',
        strike: 24300,
        entryOpen: 84.5,
        entryClose: 91.35,
        entryPrice: 87.93,
        exitTime: '15:29',
        exitPrice: 48.25,
        exitFallback: false,
        pnl: 2579.2,
        maxProfit: 2700,
        maxProfitTime: '15:12',
        maxLoss: -900,
        maxLossTime: '13:30',
        basis: 'ohlc',
      },
    ],
    exitTime: '15:29',
    pnl: 2579.2,
    maxProfit: 2700,
    maxProfitTime: '15:12',
    maxLoss: -900,
    maxLossTime: '13:30',
    basis: 'ohlc',
  },
};

describe('csvCell', () => {
  test('quotes only when needed and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(false)).toBe('false');
  });
});

describe('buildCsv', () => {
  test('one line per trade, header and data columns line up, missing leg left blank', () => {
    const csv = buildCsv([row]);
    const [header, line, end] = csv.split('\r\n');
    expect(end).toBe('');
    const h = header.split(',');
    const v = line.split(',');
    expect(v).toHaveLength(h.length);
    const at = (name: string) => v[h.indexOf(name)];
    expect(at('date')).toBe('2026-05-04');
    expect(at('signal t2')).toBe('10:28');
    expect(at('CE entry price')).toBe('87.93');
    expect(at('CE basis')).toBe('ohlc');
    expect(at('PE strike')).toBe('');
    expect(at('trade P&L')).toBe('2579.2');
    expect(at('high/low source')).toBe('nubra-wide');
    expect(at('OTM steps')).toBe('2');
  });

  test('carries the reference greeks at t1, t2 and the change; an unpriced end is blank', () => {
    const [header, line] = buildCsv([row]).split('\r\n');
    const h = header.split(',');
    const v = line.split(',');
    const at = (name: string) => v[h.indexOf(name)];
    expect(at('ref CE delta t1')).toBe('0.31');
    expect(at('ref CE delta t2')).toBe('0.27');
    expect(at('ref CE delta change')).toBe('-0.04');
    expect(at('ref CE iv change')).toBe('-0.6');
    expect(at('ref PE delta t1')).toBe('-0.28');
    expect(at('ref PE delta t2')).toBe('');
    expect(at('ref PE delta change')).toBe('');
  });

  test('a row from a server without greeks still lines up, with blank greek cells', () => {
    const { greeks: _greeks, ...bare } = row.signal;
    const [header, line] = buildCsv([{ ...row, signal: bare }]).split('\r\n');
    const v = line.split(',');
    expect(v).toHaveLength(header.split(',').length);
    expect(v[header.split(',').indexOf('ref CE delta t1')]).toBe('');
  });
});

describe('greekChange', () => {
  test('is t2 minus t1, rounded clear of float noise', () => {
    expect(greekChange(ceT1, ceT2, 'delta')).toBe(-0.04);
    expect(greekChange(ceT1, ceT2, 'theta')).toBe(0.4);
  });

  test('is null when either end could not be priced', () => {
    expect(greekChange(null, ceT2, 'iv')).toBeNull();
    expect(greekChange(ceT1, undefined, 'iv')).toBeNull();
  });
});

describe('fmtGreek', () => {
  test('uses each greek’s own precision and dashes the missing', () => {
    expect(fmtGreek('delta', 0.3123456)).toBe('0.312');
    expect(fmtGreek('gamma', 0.00061234)).toBe('0.00061');
    expect(fmtGreek('theta', -9.456)).toBe('-9.46');
    expect(fmtGreek('iv', null)).toBe('—');
    expect(fmtGreek('vega', Number.NaN)).toBe('—');
  });

  test('signed forces a plus on positive changes only', () => {
    expect(fmtGreek('theta', 0.4, true)).toBe('+0.40');
    expect(fmtGreek('theta', -0.4, true)).toBe('-0.40');
    expect(fmtGreek('theta', 0, true)).toBe('0.00');
  });

  test('a value that rounds to zero never shows a sign', () => {
    expect(fmtGreek('gamma', -0.000004, true)).toBe('0.00000');
    expect(fmtGreek('gamma', 0.000004, true)).toBe('0.00000');
    expect(fmtGreek('delta', -0.0004)).toBe('0.000');
    expect(fmtGreek('gamma', 0.00002, true)).toBe('+0.00002');
  });
});

describe('strikeRule', () => {
  test('lists only the expiry distances that differ from the default', () => {
    const t = { ...DEFAULT_TRADE_PARAMS, otmSteps: 2 };
    expect(strikeRule(t)).toBe('OTM 2');
    expect(strikeRule({ ...t, otmStepsByDte: { '0': 3, '1': 3, '2': 2, '4': 0 } })).toBe(
      'OTM 2 (Exp 3, Exp−1 3, Exp−4 0)',
    );
  });
});

describe('dteShort', () => {
  test('the expiry day is Exp and the days before it count down from there', () => {
    expect(dteShort(0)).toBe('Exp');
    expect(dteShort(1)).toBe('Exp−1');
    expect(dteShort(4)).toBe('Exp−4');
  });
});

/** `row` moved to another date, with its trade's P&L and days to expiry set. */
const on = (date: string, dte: number | null | undefined, pnl = 100): SignalBacktestRow => ({
  ...row,
  date,
  dte,
  trade: { ...row.trade, pnl },
});

describe('row filter: weekday and days to expiry', () => {
  // Mon 2026-01-05 (1 day before), Tue 06 (expiry), Fri 02 (2 days before), Mon 12 (no dte known).
  const rows = [
    on('2026-01-02', 2),
    on('2026-01-05', 1),
    on('2026-01-06', 0),
    on('2026-01-12', undefined),
  ];
  const dates = (f: { weekdays: number[]; dte: number[] }) =>
    filterRows(rows, f).map((r) => r.date);

  test('no choice on either axis shows everything, as the same list', () => {
    expect(filterActive(NO_FILTER)).toBe(false);
    expect(filterRows(rows, NO_FILTER)).toBe(rows);
  });

  test('weekdays: Monday is 0 … Friday is 4, and several can be chosen', () => {
    expect(weekdayIndex('2026-01-05')).toBe(0);
    expect(weekdayIndex('2026-01-02')).toBe(4);
    expect(weekdayIndex('2026-01-03')).toBeNull();
    expect(dates({ weekdays: [0], dte: [] })).toEqual(['2026-01-05', '2026-01-12']);
    expect(dates({ weekdays: [0, 4], dte: [] })).toEqual([
      '2026-01-02',
      '2026-01-05',
      '2026-01-12',
    ]);
  });

  test('days to expiry: expiry day and the day before, in any mix', () => {
    expect(dates({ weekdays: [], dte: [0] })).toEqual(['2026-01-06']);
    expect(dates({ weekdays: [], dte: [0, 1] })).toEqual(['2026-01-05', '2026-01-06']);
  });

  test('a row with no known days to expiry matches no expiry choice', () => {
    expect(dates({ weekdays: [], dte: [0, 1, 2, 3, 4] })).not.toContain('2026-01-12');
  });

  test('both axes must match', () => {
    expect(dates({ weekdays: [0], dte: [1] })).toEqual(['2026-01-05']);
    expect(dates({ weekdays: [1], dte: [1] })).toEqual([]);
  });

  test('labels and badges: only the expiry day and the day before are marked', () => {
    expect(dteLabel(0)).toBe('Expiry day');
    expect(dteLabel(1)).toBe('1 day before');
    expect(dteLabel(3)).toBe('3 days before');
    expect(dteBadge(0)).toBe('EXPIRY');
    expect(dteBadge(1)).toBe('EXPIRY−1');
    expect(dteBadge(2)).toBeNull();
    expect(dteBadge(null)).toBeNull();
    expect(dteBadge(undefined)).toBeNull();
  });

  test('describes what is chosen in a line of text', () => {
    expect(describeFilter({ weekdays: [0, 1], dte: [0, 1] })).toBe(
      'Mon, Tue · Expiry day, 1 day before',
    );
    expect(describeFilter({ weekdays: [], dte: [2] })).toBe('2 days before');
    expect(describeFilter(NO_FILTER)).toBe('');
  });

  test('stats are for the rows given', () => {
    const stats = tradeStats([on('2026-01-05', 1, 300), on('2026-01-06', 0, -100)]);
    expect(stats).toEqual({
      trades: 2,
      wins: 1,
      losses: 1,
      winRate: 50,
      totalPnl: 200,
      avgPnl: 100,
    });
    expect(tradeStats([])).toMatchObject({ trades: 0, winRate: 0, totalPnl: 0, avgPnl: 0 });
  });

  test('the CSV carries days to expiry, blank when unknown', () => {
    const [header, a, b] = buildCsv([on('2026-01-05', 1), on('2026-01-12', undefined)]).split(
      '\r\n',
    );
    const col = header.split(',').indexOf('days to expiry');
    expect(a.split(',')[col]).toBe('1');
    expect(b.split(',')[col]).toBe('');
  });
});

describe('tradePnlSeries', () => {
  const leg = (patch: Partial<SignalBacktestRow['trade']['legs'][number]>) => ({
    ...row.trade.legs[0],
    ...patch,
  });
  // Entry 09:20 is slot 5, exit 09:23 slot 8.
  const trade = {
    ...row.trade,
    side: 'SELL' as const,
    qty: 65,
    entryTime: '09:20',
    exitTime: '09:23',
    legs: [
      leg({ kind: 'CE', entryOpen: 10, entryClose: 12, exitTime: '09:23' }), // entry 11
      leg({ kind: 'PE', entryOpen: null, entryClose: 20, exitTime: '09:23' }), // entry 20
    ],
  };
  const grid = (at: Record<number, number>) =>
    Array.from({ length: 375 }, (_, i) => (i in at ? at[i] : null));
  const ce = grid({ 5: 12, 6: 10, 8: 7 }); // no price at slot 7
  const pe = grid({ 5: 20, 6: 22, 7: 23, 8: 25 });

  test('starts at zero at the fill, then marks each leg’s close against its entry price', () => {
    const { legs } = tradePnlSeries(trade, [ce, pe]);
    // SELL: gains when the price falls. CE sold at 11, PE at 20, 65 a lot.
    expect(legs[0][5]).toBe(0);
    expect(legs[0][6]).toBe(65); // (11 - 10) * 65
    expect(legs[0][8]).toBe(260); // (11 - 7) * 65
    expect(legs[1][6]).toBe(-130); // (20 - 22) * 65
    expect(legs[1][8]).toBe(-325);
  });

  test('nothing before the entry or after the exit, and a missing minute stays empty', () => {
    const { legs } = tradePnlSeries(trade, [ce, pe]);
    expect(legs[0][4]).toBeNull();
    expect(legs[0][7]).toBeNull();
    expect(legs[0][9]).toBeNull();
  });

  test('the total needs every leg priced that minute', () => {
    const { total } = tradePnlSeries(trade, [ce, pe]);
    expect(total[5]).toBe(0);
    expect(total[6]).toBe(-65); // 65 - 130
    expect(total[7]).toBeNull(); // the CE has no price
    expect(total[8]).toBe(-65); // 260 - 325
  });

  test('BUY is the mirror image', () => {
    const { legs } = tradePnlSeries({ ...trade, side: 'BUY' }, [ce, pe]);
    expect(legs[0][8]).toBe(-260);
    expect(legs[1][8]).toBe(325);
  });

  test('a leg with no stored prices leaves its line and the total empty', () => {
    const { legs, total } = tradePnlSeries(trade, [ce, null]);
    expect(legs[1].every((v) => v == null)).toBe(true);
    expect(total.every((v) => v == null)).toBe(true);
  });

  test('the entry price is the open/close mean, or the close alone without an open', () => {
    expect(legEntryPrice(trade.legs[0])).toBe(11);
    expect(legEntryPrice(trade.legs[1])).toBe(20);
  });

  test('ends where the table’s P&L does', () => {
    // The table’s leg P&L is (entry - exit price) * qty, from the same entry and the exit close.
    const { legs } = tradePnlSeries(trade, [ce, pe]);
    expect(legs[0][8]).toBe(Math.round((11 - 7) * 65 * 100) / 100);
  });
});

describe('inr', () => {
  test('signs and dashes', () => {
    expect(inr(1234.5)).toBe('+₹1,234.50');
    expect(inr(-2)).toBe('-₹2.00');
    expect(inr(null)).toBe('—');
  });
});

describe('strikeRule: premium mode', () => {
  const t = { ...DEFAULT_TRADE_PARAMS, strikeMode: 'PREMIUM' as const };

  test('data-first: names the tiers chosen per expiry distance, and says when none is chosen', () => {
    expect(t.premiumTiersOnly).toBe(true);
    expect(strikeRule(t)).toBe('premium tiers (none chosen yet)');
    expect(
      strikeRule({
        ...t,
        cePremiumByDte: { '0': [9.5, 15] },
        pePremiumByDte: { '2': [20, 31.5] },
      }),
    ).toBe('premium tiers (Exp CE ₹9.5 – 15, Exp−2 PE ₹20 – 31.5)');
  });

  test('lists only the side being traded', () => {
    const picks = {
      cePremiumByDte: { '0': [9.5, 15] } as TradeParams['cePremiumByDte'],
      pePremiumByDte: { '0': [8, 12] } as TradeParams['pePremiumByDte'],
    };
    expect(strikeRule({ ...t, ...picks, legs: 'CE' })).toBe('premium tiers (Exp CE ₹9.5 – 15)');
    expect(strikeRule({ ...t, ...picks, legs: 'PE' })).toBe('premium tiers (Exp PE ₹8 – 12)');
  });

  test('with typed ranges allowed (the API’s other mode) it still names them', () => {
    const typed = { ...t, premiumTiersOnly: false };
    expect(strikeRule(typed)).toBe('CE ₹40–60 / PE ₹40–60');
    expect(strikeRule({ ...typed, legs: 'CE' })).toBe('CE ₹40–60');
    expect(strikeRule({ ...typed, cePremiumByDte: { '0': [9.5, 15] } })).toBe(
      'CE ₹40–60 / PE ₹40–60 + ranges by days to expiry',
    );
  });
});

describe('cleanRangeMap', () => {
  test('keeps good [min, max] pairs and drops everything else', () => {
    expect(
      cleanRangeMap({ '0': [9.5, 15], '1': null, '2': [20, 20], '3': 'x', '4': [5, 1] }),
    ).toEqual({ '0': [9.5, 15], '2': [20, 20] });
  });

  test('anything that is not a map of small whole-number keys yields nothing', () => {
    expect(cleanRangeMap(undefined)).toEqual({});
    expect(cleanRangeMap([[1, 2]])).toEqual({}); // the old Monday..Friday list
    expect(cleanRangeMap({ mon: [1, 2], '-1': [1, 2], '100': [1, 2] })).toEqual({});
    expect(cleanRangeMap({ '0': [-1, 2], '1': ['a', 3] })).toEqual({});
  });
});

describe('cleanStepMap', () => {
  test('keeps whole numbers 0 – 10 and drops the rest', () => {
    expect(cleanStepMap({ '0': 3, '1': 0, '2': 11, '3': 1.5, '4': 'x', '5': null })).toEqual({
      '0': 3,
      '1': 0,
    });
    expect(cleanStepMap([3, 3, null, null, 1])).toEqual({}); // the old Monday..Friday list
    expect(cleanStepMap(undefined)).toEqual({});
  });
});

describe('rangeText and sameRange', () => {
  test('rupee ranges read cleanly', () => {
    expect(rangeText(25.5, 43.5)).toBe('₹25.5 – 43.5');
    expect(rangeText(10, 15)).toBe('₹10 – 15');
  });

  test('two ranges are the same only when both ends match', () => {
    expect(sameRange([10, 15], [10, 15])).toBe(true);
    expect(sameRange([10, 15], [10, 16])).toBe(false);
    expect(sameRange(null, [10, 15])).toBe(false);
    expect(sameRange(null, null)).toBe(false);
  });
});
