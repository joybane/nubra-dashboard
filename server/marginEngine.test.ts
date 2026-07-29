import { test, expect } from 'vitest';
import { calculateLocalBasketMargin, type BasketMarginOrder } from './marginEngine.ts';

// These tests cover the LOCAL margin engine (used when the broker margin API is
// unavailable). Unlike the earlier structural-only suite, they assert absolute
// rupee values where the correct answer is knowable from the payoff itself —
// a long option costs its premium, a debit spread costs its debit — because the
// previous suite passed while charging 2x premium and 73x on a bull call spread.

const SPOT = 24000;
const QTY = 65;          // one NIFTY lot
const FAR_EXPIRY = '20260904';

const leg = (
  side: 'BUY' | 'SELL', ot: 'CE' | 'PE', strike: number, ltp: number,
  { qty = QTY, expiry = FAR_EXPIRY, spot = SPOT }: { qty?: number; expiry?: string; spot?: number } = {},
): BasketMarginOrder => ({
  order_qty: qty, order_side: side, option_type: ot, strike, ltp,
  symbol: 'NIFTY', expiry, spot,
});

const rupees = (paise: number) => paise / 100;
/** Fixed clock so expiry-day rules and time-to-expiry stay deterministic. */
const ON = (iso: string) => new Date(`${iso}T10:00:00+05:30`);
const NOW = ON('2026-08-25');
const calc = (orders: BasketMarginOrder[], now = NOW) => calculateLocalBasketMargin(orders, 'NIFTY', now)!;

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
  const r = calc([leg('BUY', 'PE', 24300, 120), leg('SELL', 'PE', 24200, 80)]);
  expect(rupees(r.span)).toBeLessThan((24300 - 24200) * QTY);
  expect(rupees(r.total_margin)).toBeLessThan(60_000);
});

test('credit spread costs far less than the naked short it hedges', () => {
  const naked = calc([leg('SELL', 'CE', 24300, 120)]);
  const spread = calc([leg('SELL', 'CE', 24300, 120), leg('BUY', 'CE', 24400, 80)]);
  expect(spread.total_margin).toBeLessThan(naked.total_margin);
  expect(spread.margin_benefit).toBeGreaterThan(0);
  // Span lands on the full width: scan risk is the max loss (width less credit) and
  // net option value adds the credit back, because the credit is received as cash
  // and must not reduce the margin as well. Nothing payable — it is a net credit.
  expect(rupees(spread.span)).toBeCloseTo((24400 - 24300) * QTY, -2);
  expect(rupees(spread.opt_prem)).toBe(0);
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
  const r = calc([
    leg('BUY', 'PE', 24200, 60), leg('SELL', 'PE', 24300, 90),
    leg('SELL', 'CE', 24400, 90), leg('BUY', 'CE', 24500, 60),
  ]);
  expect(rupees(r.span)).toBeLessThan(100 * QTY * 2); // both wings capped by width
  expect(r.margin_benefit).toBeGreaterThan(0);
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
      return leg(next() < 0.5 ? 'BUY' : 'SELL', ot, strike,
        Math.round((intrinsic + 1 + next() * 400) * 100) / 100,
        { expiry: ['20260827', '20260904', '20261030'][Math.floor(next() * 3)] });
    });
    const r = calc(orders);
    expect(r.total_margin).toBe(r.span + r.exposure + r.opt_prem);
    expect(r.span).toBeGreaterThanOrEqual(0);
  }
});

test('an all-long basket never carries span — its risk is the premium it already paid', () => {
  const r = calc([
    leg('BUY', 'CE', 24200, 90), leg('BUY', 'PE', 23800, 85),
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

test('non-option legs are reported as excluded rather than dropped silently', () => {
  const r = calc([leg('SELL', 'CE', 24000, 150), { order_qty: QTY, order_side: 'BUY', symbol: 'NIFTY' }]);
  expect(r.message).toMatch(/excluded/i);
});
