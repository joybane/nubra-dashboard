import { afterEach, test, expect } from 'vitest';
import {
  calculateLocalBasketMargin,
  clearMarginCalibrations,
  observeNubraMarginQuote,
  type BasketMarginOrder,
} from './marginEngine.ts';

afterEach(() => clearMarginCalibrations());

// These tests cover the LOCAL margin engine (used when the broker margin API is
// unavailable). Unlike the earlier structural-only suite, they assert absolute
// rupee values where the correct answer is knowable from the payoff itself —
// a long option costs its premium, a debit spread costs its debit — because the
// previous suite passed while charging 2x premium and 73x on a bull call spread.

const SPOT = 24000;
const QTY = 65; // one NIFTY lot
const FAR_EXPIRY = '20260904';

const leg = (
  side: 'BUY' | 'SELL',
  ot: 'CE' | 'PE',
  strike: number,
  ltp: number,
  {
    qty = QTY,
    expiry = FAR_EXPIRY,
    spot = SPOT,
  }: { qty?: number; expiry?: string; spot?: number } = {},
): BasketMarginOrder => ({
  order_qty: qty,
  order_side: side,
  option_type: ot,
  strike,
  ltp,
  symbol: 'NIFTY',
  expiry,
  spot,
});

const rupees = (paise: number) => paise / 100;
/** Fixed clock so expiry-day rules and time-to-expiry stay deterministic. */
const ON = (iso: string) => new Date(`${iso}T10:00:00+05:30`);
const NOW = ON('2026-08-25');
const calc = (orders: BasketMarginOrder[], now = NOW) =>
  calculateLocalBasketMargin(orders, 'NIFTY', now)!;

test('returns null when no leg is a valid option (missing strike / type)', () => {
  expect(calculateLocalBasketMargin([])).toBeNull();
  expect(calculateLocalBasketMargin([{ order_qty: 50, order_side: 'SELL' }])).toBeNull();
});

test('long option costs exactly its premium — no span, no exposure', () => {
  const r = calc([leg('BUY', 'CE', 24000, 150)]);
  expect(rupees(r.span)).toBe(0);
  expect(rupees(r.exposure)).toBe(0);
  expect(rupees(r.opt_prem)).toBe(150 * QTY);
  expect(rupees(r.total_margin)).toBe(150 * QTY);
});

test('naked short sits near the exchange scan-range floor, plus 2% ELM', () => {
  const r = calc([leg('SELL', 'CE', 24000, 150)]);
  const notional = SPOT * QTY;
  // Span is driven by the ~9.3% price scan range floor for index products.
  expect(rupees(r.span) / notional).toBeGreaterThan(0.08);
  expect(rupees(r.span) / notional).toBeLessThan(0.16);
  expect(rupees(r.exposure)).toBeCloseTo(0.02 * notional, 0);
  expect(rupees(r.opt_prem)).toBe(0); // net credit — nothing payable
});

test('BULL call spread (debit) is defined-risk, not a naked short', () => {
  const r = calc([leg('BUY', 'CE', 24300, 120), leg('SELL', 'CE', 24400, 80)]);
  const netDebit = (120 - 80) * QTY;
  expect(rupees(r.opt_prem)).toBeCloseTo(netDebit, 0);
  expect(rupees(r.span)).toBeLessThan((24400 - 24300) * QTY); // capped by the width
  // Regression guard: this returned ~Rs 1,90,060 when debit spreads fell through
  // to naked-short pricing. It must stay an order of magnitude below that.
  expect(rupees(r.total_margin)).toBeLessThan(60_000);
});

test('BEAR put spread (debit) is defined-risk too', () => {
  // Priced above intrinsic, or the IV solve fails and the legs are not real options.
  const r = calc([leg('BUY', 'PE', 24300, 420), leg('SELL', 'PE', 24200, 330)]);
  const naked = calc([leg('SELL', 'PE', 24200, 330)]);
  expect(rupees(r.opt_prem)).toBeCloseTo((420 - 330) * QTY, 0); // the debit, in cash
  expect(r.total_margin).toBeLessThan(naked.total_margin);
  expect(rupees(r.total_margin)).toBeLessThan(60_000);
});

test('credit spread costs far less than the naked short it hedges', () => {
  const naked = calc([leg('SELL', 'CE', 24300, 120)]);
  const spread = calc([leg('SELL', 'CE', 24300, 120), leg('BUY', 'CE', 24400, 80)]);
  expect(spread.total_margin).toBeLessThan(naked.total_margin);
  expect(spread.margin_benefit).toBeGreaterThan(0);
  // The long wing caps scan risk at the width, but the short still has to be bought
  // back, so span keeps that leg's value. It must stay well under the naked short's.
  expect(spread.span).toBeLessThan(naked.span);
  expect(rupees(spread.opt_prem)).toBe(0); // net credit — nothing payable
});

test('short strangle nets to roughly one leg of span, but ELM on both', () => {
  const call = calc([leg('SELL', 'CE', 24200, 100)]);
  const strangle = calc([leg('SELL', 'CE', 24200, 100), leg('SELL', 'PE', 23800, 100)]);
  // Only one side can lose, so span must not double.
  expect(rupees(strangle.span)).toBeLessThan(rupees(call.span) * 1.6);
  expect(rupees(strangle.span)).toBeGreaterThan(rupees(call.span) * 0.9);
  // Exposure, by contrast, is charged on both short legs.
  expect(rupees(strangle.exposure)).toBeCloseTo(2 * 0.02 * SPOT * QTY, 0);
});

test('iron condor is defined-risk on both wings', () => {
  // Both shorts out of the money and both wings 300 wide, so the premiums are
  // arbitrage-consistent and the IV solve has something real to work with.
  const wings = [
    leg('BUY', 'PE', 23400, 55),
    leg('SELL', 'PE', 23700, 90),
    leg('SELL', 'CE', 24300, 95),
    leg('BUY', 'CE', 24600, 50),
  ];
  const condor = calc(wings);
  const strangle = calc([wings[1], wings[2]]);
  // The wings cap the scan loss at the widths; what is left in span is the cost of
  // buying the two shorts back.
  expect(rupees(condor.span)).toBeLessThan(300 * QTY * 2 + (90 + 95) * QTY);
  expect(condor.span).toBeLessThan(strangle.span);
  expect(condor.margin_benefit).toBeGreaterThan(0);
});

test('a diagonal is not priced as if it were a vertical', () => {
  const vertical = calc([leg('SELL', 'CE', 24400, 90), leg('BUY', 'CE', 24500, 120)]);
  const diagonal = calc([
    leg('SELL', 'CE', 24400, 90),
    leg('BUY', 'CE', 24500, 120, { expiry: '20261030' }),
  ]);
  // The far-dated long behaves differently under the shock; the two must not agree exactly.
  expect(rupees(diagonal.span)).not.toBeCloseTo(rupees(vertical.span), 0);
});

test('expiry day adds 2% ELM on short index options', () => {
  const orders = [leg('SELL', 'CE', 24000, 150, { expiry: '20260827' })];
  const normal = calc(orders, ON('2026-08-25'));
  const expiryDay = calc(orders, ON('2026-08-27'));
  expect(rupees(expiryDay.exposure)).toBeCloseTo(2 * rupees(normal.exposure), 0);
  expect(rupees(normal.exposure)).toBeCloseTo(0.02 * SPOT * QTY, 0);
});

test('exposure follows spot notional, not the strike', () => {
  // A far-OTM strike must not inflate exposure — ELM is charged on the underlying.
  const atm = calc([leg('SELL', 'CE', 24000, 150)]);
  const otm = calc([leg('SELL', 'CE', 30000, 5)]);
  // 30000 strike is >10% OTM so it steps to the 3% band, but off the same 24000 spot.
  expect(rupees(otm.exposure)).toBeCloseTo(0.03 * SPOT * QTY, 0);
  expect(rupees(atm.exposure)).toBeCloseTo(0.02 * SPOT * QTY, 0);
});

test('quantities are treated by absolute size (sign carried by order_side)', () => {
  const a = calc([leg('SELL', 'CE', 24000, 150)]);
  const b = calc([{ ...leg('SELL', 'CE', 24000, 150), order_qty: -QTY }]);
  expect(b.total_margin).toBe(a.total_margin);
});

test('all money fields are whole paise', () => {
  const r = calc([leg('SELL', 'CE', 24000, 150), leg('BUY', 'CE', 24200, 80)]);
  for (const v of [r.total_margin, r.span, r.exposure, r.opt_prem, r.margin_benefit]) {
    expect(Number.isInteger(v)).toBe(true);
  }
  expect(r.total_margin).toBe(r.span + r.exposure + r.opt_prem);
});

test('the total always equals the sum of its parts, across many baskets', () => {
  // Rounding each component and the total independently leaves them a paisa apart,
  // and the UI prints them side by side. One shaped basket cannot catch that.
  let rng = 12345;
  const next = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 300; i++) {
    const orders = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
      const strike = Math.round((21000 + next() * 6000) / 50) * 50;
      const ot = next() < 0.5 ? 'CE' : 'PE';
      const intrinsic = ot === 'CE' ? Math.max(0, SPOT - strike) : Math.max(0, strike - SPOT);
      return leg(
        next() < 0.5 ? 'BUY' : 'SELL',
        ot,
        strike,
        Math.round((intrinsic + 1 + next() * 400) * 100) / 100,
        { expiry: ['20260827', '20260904', '20261030'][Math.floor(next() * 3)] },
      );
    });
    const r = calc(orders);
    expect(r.total_margin).toBe(r.span + r.exposure + r.opt_prem);
    expect(r.span).toBeGreaterThanOrEqual(0);
  }
});

test('an all-long basket never carries span — its risk is the premium it already paid', () => {
  const r = calc([
    leg('BUY', 'CE', 24200, 90),
    leg('BUY', 'PE', 23800, 85),
    leg('BUY', 'CE', 25000, 12, { expiry: '20261030' }),
  ]);
  expect(rupees(r.span)).toBe(0);
  expect(rupees(r.exposure)).toBe(0);
  expect(rupees(r.opt_prem)).toBeCloseTo((90 + 85 + 12) * QTY, 0);
});

test('residual maturity beyond 9 months steps ELM up to 5%', () => {
  // Regression: the trading-time clock this used to read never reached 0.75 years,
  // so the long-dated band was unreachable no matter how far out the expiry was.
  const near = calc([leg('SELL', 'CE', 24000, 150)]);
  const far = calc([leg('SELL', 'CE', 24000, 900, { expiry: '20270624' })]);
  expect(rupees(near.exposure)).toBeCloseTo(0.02 * SPOT * QTY, 0);
  expect(rupees(far.exposure)).toBeCloseTo(0.05 * SPOT * QTY, 0);
});

test('IV is calibrated from the traded premium, so a wider premium costs more span', () => {
  // A richer quote on the same contract implies a higher vol and a wider scan range.
  const cheap = calc([leg('SELL', 'CE', 24000, 100)]);
  const rich = calc([leg('SELL', 'CE', 24000, 400)]);
  expect(rich.span).toBeGreaterThan(cheap.span);
});

test('realised volatility from the feed widens the price scan in stressed markets', () => {
  const base = { ...leg('SELL', 'CE', 24000, 150), iv: 12, previous_close: 24000 };
  const calm = calc([{ ...base, realized_vol: 10 }]);
  const stressed = calc([{ ...base, realized_vol: 45 }]);
  expect(stressed.span).toBeGreaterThan(calm.span);
});

test('an overnight gap from previous close widens the live scan', () => {
  const base = { ...leg('SELL', 'CE', 24000, 150), iv: 12, realized_vol: 10 };
  const unchanged = calc([{ ...base, previous_close: 24000 }]);
  const gapped = calc([{ ...base, previous_close: 22000 }]);
  expect(gapped.span).toBeGreaterThan(unchanged.span);
});

test('the margin route can request a confidence-based conservative total', () => {
  const order = {
    ...leg('SELL', 'CE', 24000, 150),
    iv: 12,
    realized_vol: 15,
    previous_close: 23950,
    market_data_as_of: NOW.getTime(),
  };
  const raw = calculateLocalBasketMargin([order], 'NIFTY', NOW, 'NSE', {
    conservative: false,
  })!;
  const guarded = calculateLocalBasketMargin([order], 'NIFTY', NOW, 'NSE', {
    conservative: true,
  })!;
  expect(guarded.confidence).toBe('medium');
  expect(guarded.total_margin).toBe(guarded.conservative_total);
  expect(guarded.total_margin).toBeGreaterThan(raw.total_margin);
});

test('successful Nubra quotes continuously calibrate the same underlying and expiry', () => {
  const order = {
    ...leg('SELL', 'CE', 24000, 150),
    iv: 12,
    realized_vol: 15,
    previous_close: 23950,
    market_data_as_of: NOW.getTime(),
  };
  const raw = calculateLocalBasketMargin([order], 'NIFTY', NOW, 'NSE', {
    useCalibration: false,
  })!;
  const brokerTotal = Math.round(raw.total_margin * 1.25);
  observeNubraMarginQuote([order], brokerTotal, 'NSE', NOW);
  observeNubraMarginQuote([order], brokerTotal, 'NSE', NOW);
  const calibrated = calculateLocalBasketMargin([order], 'NIFTY', NOW, 'NSE')!;
  expect(calibrated.source).toContain('calibrated');
  expect(calibrated.calibration_samples).toBe(2);
  expect(calibrated.confidence).toBe('high');
  expect(calibrated.total_margin).toBeGreaterThan(raw.total_margin);
});

// ─── Calibration anchors ─────────────────────────────────────────────────────
// Real positions quoted by the broker on 2026-08-04, captured by
// scripts/collectMarginDataset.ts. These are the only tests here that can tell you the
// engine is *right* rather than merely self-consistent — everything above checks shape.
// A change that improves the model moves these closer; a change that breaks it moves
// them apart. Tolerances are the measured residual with headroom, not aspirations.

const anchor = (
  name: string,
  exchange: string,
  symbol: string,
  brokerRupees: number,
  tolPct: number,
  orders: BasketMarginOrder[],
) =>
  test(`broker anchor: ${name}`, () => {
    const r = calculateLocalBasketMargin(orders, symbol, ON('2026-08-04'), exchange)!;
    const err = (rupees(r.total_margin) - brokerRupees) / brokerRupees;
    expect(Math.abs(err) * 100).toBeLessThan(tolPct);
  });

const nifty = (
  side: 'BUY' | 'SELL',
  ot: 'CE' | 'PE',
  strike: number,
  ltp: number,
  iv: number,
): BasketMarginOrder => ({
  order_qty: 65,
  order_side: side,
  option_type: ot,
  strike,
  ltp,
  iv,
  symbol: 'NIFTY',
  expiry: '20260811',
  spot: 24598.6,
});

anchor('NIFTY short ATM CE', 'NSE', 'NIFTY', 180593.79, 4, [
  nifty('SELL', 'CE', 24600, 144.9, 10.27),
]);
anchor('NIFTY short ATM PE', 'NSE', 'NIFTY', 168411.29, 6, [
  nifty('SELL', 'PE', 24600, 139.4, 10.26),
]);
anchor('NIFTY short straddle', 'NSE', 'NIFTY', 212800.38, 4, [
  nifty('SELL', 'CE', 24600, 144.9, 10.27),
  nifty('SELL', 'PE', 24600, 139.4, 10.26),
]);
// The vertical is the case the old single netted option-value term got wrong: it
// returned ~₹34.7k against the broker's ₹41.6k until long and short value were split.
anchor('NIFTY call vertical', 'NSE', 'NIFTY', 41638.09, 8, [
  nifty('BUY', 'CE', 24600, 144.9, 10.27),
  nifty('SELL', 'CE', 24900, 38.45, 9.97),
]);
anchor('NIFTY iron condor', 'NSE', 'NIFTY', 84693.82, 8, [
  nifty('SELL', 'CE', 24900, 38.45, 9.97),
  nifty('BUY', 'CE', 25200, 8.85, 10.65),
  nifty('SELL', 'PE', 24300, 44.1, 10.91),
  nifty('BUY', 'PE', 24000, 15.15, 12.49),
]);

const crude = (side: 'BUY' | 'SELL', ot: 'CE' | 'PE', ltp: number): BasketMarginOrder => ({
  order_qty: 100,
  order_side: side,
  option_type: ot,
  strike: 7750,
  ltp,
  iv: 63.76,
  symbol: 'CRUDEOIL',
  expiry: '20260817',
  spot: 7749,
});

anchor('CRUDEOIL short ATM CE', 'MCX', 'CRUDEOIL', 271776.25, 4, [crude('SELL', 'CE', 377.5)]);
anchor('CRUDEOIL short straddle', 'MCX', 'CRUDEOIL', 554292.5, 4, [
  crude('SELL', 'CE', 377.5),
  crude('SELL', 'PE', 381.6),
]);
anchor('GOLDM short ATM CE', 'MCX', 'GOLDM', 157268.52, 4, [
  {
    order_qty: 10,
    order_side: 'SELL',
    option_type: 'CE',
    strike: 142500,
    ltp: 2870,
    iv: 19.01,
    symbol: 'GOLDM',
    expiry: '20260828',
    spot: 142617,
  },
]);

test('MCX gives no portfolio netting — a straddle costs exactly its two legs', () => {
  // The opposite of NSE, where the same straddle saves 39%. Measured: ₹554,292.50 for
  // the pair against ₹271,776.25 + ₹282,516.25 apart, to the paisa.
  const ce = calculateLocalBasketMargin([crude('SELL', 'CE', 377.5)], 'CRUDEOIL', NOW, 'MCX')!;
  const pe = calculateLocalBasketMargin([crude('SELL', 'PE', 381.6)], 'CRUDEOIL', NOW, 'MCX')!;
  const both = calculateLocalBasketMargin(
    [crude('SELL', 'CE', 377.5), crude('SELL', 'PE', 381.6)],
    'CRUDEOIL',
    NOW,
    'MCX',
  )!;
  expect(both.total_margin).toBe(ce.total_margin + pe.total_margin);
  expect(both.margin_benefit).toBe(0);
});

test('a newly listed MCX commodity uses the same live volatility model without a table', () => {
  const r = calculateLocalBasketMargin(
    [{ ...crude('SELL', 'CE', 377.5), symbol: 'MCXBULLDEX' }],
    'MCXBULLDEX',
    NOW,
    'MCX',
  )!;
  expect(r.message).toMatch(/live MCX feed/i);
  expect(r.source).toBe('feed-dynamic-mcx');
  expect(r.total_margin).toBeGreaterThan(0);
});

test('MCX never routes through the NSE scenario engine', () => {
  const r = calculateLocalBasketMargin([crude('SELL', 'CE', 377.5)], 'CRUDEOIL', NOW, 'MCX')!;
  expect(r.source).toBe('feed-dynamic-mcx');
  expect(r.exposure).toBe(0); // MCX quotes one blended charge, no separate ELM
});

test('MCX scan rates rise with current feed volatility', () => {
  const calm = calculateLocalBasketMargin(
    [{ ...crude('SELL', 'CE', 377.5), iv: 25 }],
    'CRUDEOIL',
    NOW,
    'MCX',
  )!;
  const stressed = calculateLocalBasketMargin(
    [{ ...crude('SELL', 'CE', 377.5), iv: 70 }],
    'CRUDEOIL',
    NOW,
    'MCX',
  )!;
  expect(stressed.total_margin).toBeGreaterThan(calm.total_margin);
});

test('non-option legs are reported as excluded rather than dropped silently', () => {
  const r = calc([
    leg('SELL', 'CE', 24000, 150),
    { order_qty: QTY, order_side: 'BUY', symbol: 'NIFTY' },
  ]);
  expect(r.message).toMatch(/excluded/i);
});
