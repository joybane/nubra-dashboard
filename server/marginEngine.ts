import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { bsPrice, calendarYearsToExpiry, impliedVolPct } from './backtest/greeks.ts';

export interface BasketMarginOrder {
  ref_id?: number;
  order_qty: number;
  order_side: string;
  order_price?: number;
  order_delivery_type?: string;
  strike?: number;
  option_type?: string;
  ltp?: number;
  lot_size?: number;
  expiry?: string;
  symbol?: string;
  /** Underlying spot, in rupees. Supplied by the margin route from the option chain. */
  spot?: number;
  /** Quoted IV percentage for this leg, if the chain lookup resolved it. */
  iv?: number;
}

export interface LocalMarginResult {
  total_margin: number;
  span: number;
  exposure: number;
  opt_prem: number;
  margin_benefit: number;
  estimated: true;
  source: string;
  message: string;
}

interface SpanRiskContract {
  riskArray?: number[];
  scanRiskPerUnit?: number;
  exposureRate?: number;
}

interface SpanRiskFile {
  generatedAt?: string;
  contracts?: Record<string, SpanRiskContract>;
}

interface MarginLeg {
  symbol: string;
  expiry: string;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  strike: number;
  qty: number;
  premium: number;
  spot: number;
  ivPct: number;
  tYears: number;
  isIndex: boolean;
  isCommodity: boolean;
  isExpiryDay: boolean;
}

// ─── Exchange parameters ─────────────────────────────────────────────────────
// Extreme Loss Margin on short index options: 2% of SPOT notional, rising to 3% for
// strikes >10% out of the money and 5% beyond 9 months residual maturity, plus an
// additional 2% on expiry day (NSE, effective 20-Nov-2024). Long options carry none.
const ELM_INDEX_BASE = Number(process.env.LOCAL_MARGIN_ELM_INDEX || 0.02);
const ELM_INDEX_DEEP_OTM = Number(process.env.LOCAL_MARGIN_ELM_DEEP_OTM || 0.03);
const ELM_INDEX_LONG_DATED = Number(process.env.LOCAL_MARGIN_ELM_LONG_DATED || 0.05);
const ELM_EXPIRY_DAY_ADDON = Number(process.env.LOCAL_MARGIN_ELM_EXPIRY_ADDON || 0.02);
const ELM_STOCK_BASE = Number(process.env.LOCAL_MARGIN_ELM_STOCK || 0.035);

/**
 * ─── MCX ─────────────────────────────────────────────────────────────────────
 *
 * Commodity margin does NOT follow the NSE scenario model, and running it through the
 * 16-scenario simulation was wrong by 12–83%. Measured against the broker on 2026-08-04
 * over 152 positions across 9 commodities (every option-bearing MCX asset that quoted),
 * MCX obeys a much simpler law:
 *
 *     span(short leg) = rate(commodity) × spot × qty + premium × qty
 *     long legs       = free, up to the margin already blocked against the shorts
 *     basket          = Σ legs — there is NO portfolio netting whatsoever
 *
 * The evidence for it is unusually clean. `margin − premium` is flat to within ±1% right
 * across the moneyness grid: CRUDEOIL charges 35.1% of notional at the money and 32.1%
 * at 12.9% out of it, and the whole difference is the premium. A short straddle costs
 * exactly what its two legs cost separately (₹554,293 vs ₹271,776 + ₹282,516), and an
 * iron condor costs *more* than the naked strangle inside it — the opposite of NSE,
 * where the wings save 57%. Mini contracts share their parent's per-unit rate to within
 * 0.01pp (CRUDEOIL 30.82% vs CRUDEOILM 30.83%), which is what makes the table per-asset
 * rather than per-contract.
 *
 * Residual after fitting: median 0.6%, p90 2.5%. What is left is stale LTPs on the
 * illiquid contracts (COPPER and ZINC long options), not model error.
 *
 * These are exchange parameters and the exchange revises them. Re-measure with
 * scripts/collectMarginDataset.ts when they drift, or override a single commodity at
 * runtime with LOCAL_MARGIN_MCX_RATE_<ASSET> (e.g. LOCAL_MARGIN_MCX_RATE_CRUDEOIL=0.31).
 */
const MCX_RATES_MEASURED_ON = '2026-08-04';
const MCX_SCAN_RATE: Record<string, number> = {
  CRUDEOIL: 0.3082,
  CRUDEOILM: 0.3083,
  NATURALGAS: 0.1424,
  NATGASMINI: 0.1423,
  GOLDM: 0.0916,
  // GOLD did not quote on the measurement day. Its per-unit rate is inherited from
  // GOLDM, the same underlying — a substitution the crude and natural-gas pairs justify,
  // since parent and mini agreed to 0.01pp on both.
  GOLD: 0.0916,
  SILVER: 0.1242,
  SILVERM: 0.1257,
  COPPER: 0.0918,
  ZINC: 0.0921,
};
/** Commodities outside the table (MCXBULLDEX, anything newly listed) charge this. */
const MCX_DEFAULT_RATE = Number(process.env.LOCAL_MARGIN_MCX_DEFAULT_RATE || 0.15);

function mcxRateFor(symbol: string): { rate: number; calibrated: boolean } {
  const override = Number(process.env[`LOCAL_MARGIN_MCX_RATE_${symbol}`]);
  if (override > 0) return { rate: override, calibrated: true };
  const rate = MCX_SCAN_RATE[symbol];
  return rate != null ? { rate, calibrated: true } : { rate: MCX_DEFAULT_RATE, calibrated: false };
}

// Price scan range: 6σ scaled by √2, floored at 9.3% of underlying for index products
// and 14.2% for single stocks. At normal index IVs the floor is what binds.
const PSR_FLOOR_INDEX = 0.093;
const PSR_FLOOR_STOCK = 0.142;
const VSR_INDEX_PCT = 4; // ± absolute IV percentage points
const VSR_STOCK_PCT = 10;

// The scan range is a property of the UNDERLYING, but the only volatility we hold is
// each option's implied vol — and a nearly-expired ATM option implies a far higher
// number than the index actually diffuses at. Left unbounded that inflates expiry-day
// margin badly, so the vol feeding the scan range is clamped to a plausible band for
// the underlying. Repricing still uses each leg's own unclamped IV.
//
// The 18% ceiling is measured, not guessed. It was 22, and on expiry day every OTM
// NIFTY short solved an IV that pinned to the ceiling, widening the scan range to 11.8%
// against the exchange's ~9.3% and over-margining those strikes by 15–19%. Sweeping the
// ceiling against 436 broker quotes bottoms out at 18: NSE p90 error falls from 11.3% to
// 6.0% and the worst case from 18.6% to 12.6%. Below 18 the 9.3% floor binds everywhere
// and accuracy flattens back out.
const PSR_VOL_BAND_INDEX: [number, number] = [
  8,
  Number(process.env.LOCAL_MARGIN_PSR_VOL_CAP_INDEX || 18),
];
const PSR_VOL_BAND_STOCK: [number, number] = [12, 60];

// Short option minimum charge — zero in current NSCCL files, kept configurable.
const SHORT_OPTION_MINIMUM = Number(process.env.LOCAL_MARGIN_SHORT_OPTION_MIN || 0);
const DEFAULT_IV_PCT = Number(process.env.LOCAL_MARGIN_DEFAULT_IV || 15);

const DEFAULT_SPAN_PATH = path.join(process.cwd(), 'data', 'margin', 'nse-span-risk.json');
const SPAN_RISK_PATH = process.env.NSE_SPAN_RISK_FILE || DEFAULT_SPAN_PATH;

const INDEX_SYMBOLS = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'NIFTYNXT50',
  'SENSEX',
  'BANKEX',
  'SENSEX50',
]);

/**
 * The 16 SPAN risk scenarios: price shifts of 0, ±1/3, ±2/3, ±1 scan ranges crossed
 * with volatility up/down, plus the two ±2 scan-range moves that carry the exchange's
 * 35% cover fraction (they exist to catch deep-OTM shorts jumping into the money).
 */
const SCENARIOS: Array<{ price: number; vol: number; weight: number }> = [
  { price: 0, vol: 1, weight: 1 },
  { price: 0, vol: -1, weight: 1 },
  { price: 1 / 3, vol: 1, weight: 1 },
  { price: 1 / 3, vol: -1, weight: 1 },
  { price: -1 / 3, vol: 1, weight: 1 },
  { price: -1 / 3, vol: -1, weight: 1 },
  { price: 2 / 3, vol: 1, weight: 1 },
  { price: 2 / 3, vol: -1, weight: 1 },
  { price: -2 / 3, vol: 1, weight: 1 },
  { price: -2 / 3, vol: -1, weight: 1 },
  { price: 1, vol: 1, weight: 1 },
  { price: 1, vol: -1, weight: 1 },
  { price: -1, vol: 1, weight: 1 },
  { price: -1, vol: -1, weight: 1 },
  { price: 2, vol: 0, weight: 0.35 },
  { price: -2, vol: 0, weight: 0.35 },
];

function paise(value: number): number {
  return Math.max(0, Math.round(value * 100));
}

function sideOf(side: string | undefined): 'BUY' | 'SELL' {
  return (side || '').includes('SELL') ? 'SELL' : 'BUY';
}

function optionTypeOf(value: string | undefined): 'CE' | 'PE' | null {
  const upper = (value || '').toUpperCase();
  if (upper.includes('CALL') || upper === 'CE') return 'CE';
  if (upper.includes('PUT') || upper === 'PE') return 'PE';
  return null;
}

function normalizeExpiry(value: string | undefined): string {
  return (value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeSymbol(value: string | undefined): string {
  return (value || 'NIFTY')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Current wall-clock date/time in IST, as the `YYYY-MM-DD` / `HH:MM` pair the clock helper wants. */
function istNow(now: Date): { date: string; hhmm: string } {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`,
    hhmm: `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`,
  };
}

/** `20260804` → `2026-08-04`; anything else is returned untouched. */
function expiryToIso(expiry: string): string | null {
  return /^\d{8}$/.test(expiry)
    ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`
    : null;
}

function normalizeLegs(
  orders: BasketMarginOrder[],
  fallbackSymbol = 'NIFTY',
  now = new Date(),
  exchange = 'NSE',
): {
  legs: MarginLeg[];
  dropped: number;
} {
  const isCommodity = exchange.toUpperCase() === 'MCX';
  const { date, hhmm } = istNow(now);
  let dropped = 0;

  const legs = orders.flatMap((o): MarginLeg[] => {
    const optionType = optionTypeOf(o.option_type);
    const strike = Number(o.strike || 0);
    const qty = Math.abs(Number(o.order_qty || 0));
    if (!optionType || !(strike > 0) || !(qty > 0)) {
      dropped++;
      return [];
    }

    const symbol = normalizeSymbol(o.symbol || fallbackSymbol);
    const expiry = normalizeExpiry(o.expiry);
    const premium = Math.max(0, Number(o.ltp ?? o.order_price ?? 0));
    // Without a spot the scan range has no basis; the strike is the least-bad stand-in
    // and is what the pre-scenario engine always used.
    const spot = Number(o.spot) > 0 ? Number(o.spot) : strike;

    const iso = expiryToIso(expiry);
    // An unparseable expiry is treated as one day out: short-dated is the conservative
    // guess, since it drives the solved IV (and so the scan range) up rather than down.
    const tYears = iso ? calendarYearsToExpiry(date, hhmm, iso) : 1 / 365;
    const bsType = optionType === 'CE' ? 'CALL' : 'PUT';

    // Prefer the IV implied by the traded premium: it makes the model reproduce the
    // observed price exactly, so a long option's scenario loss and its net option value
    // cancel to zero span the way the exchange's own arrays do. Quoted IV is the
    // fallback when the premium carries no time value to solve against.
    const solved = impliedVolPct(bsType, spot, strike, premium, tYears);
    const ivPct = solved ?? (Number(o.iv) > 0 ? Number(o.iv) : DEFAULT_IV_PCT);

    return [
      {
        symbol,
        expiry,
        optionType,
        side: sideOf(o.order_side),
        strike,
        qty,
        premium,
        spot,
        ivPct,
        tYears,
        isIndex: INDEX_SYMBOLS.has(symbol),
        isCommodity,
        isExpiryDay: iso === date,
      },
    ];
  });

  return { legs, dropped };
}

// ─── Scenario engine ─────────────────────────────────────────────────────────

function modelPrice(leg: MarginLeg, spot: number, ivPct: number): number {
  return bsPrice(
    leg.optionType === 'CE' ? 'CALL' : 'PUT',
    spot,
    leg.strike,
    Math.max(0.01, ivPct),
    leg.tYears,
  );
}

/**
 * Worst-case portfolio loss across the 16 scenarios, for legs sharing one underlying.
 * Every leg is repriced at its own time to expiry under a common shock, so verticals,
 * strangles, ratios and calendars all net out without any per-strategy rule.
 */
function scanRisk(legs: MarginLeg[]): number {
  if (!legs.length) return 0;
  const spot = legs[0].spot;
  const isIndex = legs[0].isIndex;
  const avgIv = legs.reduce((s, l) => s + l.ivPct, 0) / legs.length;
  const [ivLo, ivHi] = isIndex ? PSR_VOL_BAND_INDEX : PSR_VOL_BAND_STOCK;
  const psrIv = Math.min(ivHi, Math.max(ivLo, avgIv));
  const psrFloor = isIndex ? PSR_FLOOR_INDEX : PSR_FLOOR_STOCK;
  const psrFrac = Math.max(psrFloor, 6 * (psrIv / 100 / Math.sqrt(252)) * Math.SQRT2);
  const vsr = isIndex ? VSR_INDEX_PCT : VSR_STOCK_PCT;

  // The scan range is a PERCENTAGE, applied multiplicatively — one range up is
  // spot×(1+f), one range down is spot÷(1+f). The down-move is therefore smaller in
  // rupees, which is the whole reason the exchange charges less for a short put than for
  // the equidistant short call. Shifting by ±f·spot instead made the two symmetric and
  // over-margined every put by ~11%; at NIFTY's 4% strikes the ratio this predicts
  // (0.851) lands on what the broker actually charges (0.857).
  const shockedSpot = (ranges: number) => spot * Math.pow(1 + psrFrac, ranges);

  // The scan is repriced off ONE volatility for the underlying, not each leg's own.
  // SPAN's risk arrays are built that way, and per-leg IV was importing the smile into
  // the shock: a 4% OTM put solves a far higher IV than the equidistant call, so it gained
  // more under the down-shock and every short put came out ~11% over-margined against the
  // broker. Market value still uses each leg's own IV — that is optionValues' job.
  const base = legs.map((l) => modelPrice(l, spot, psrIv));

  let worst = 0;
  for (const sc of SCENARIOS) {
    let pnl = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const shocked = modelPrice(leg, shockedSpot(sc.price), psrIv + sc.vol * vsr);
      const signedQty = leg.side === 'BUY' ? leg.qty : -leg.qty;
      pnl += signedQty * (shocked - base[i]);
    }
    worst = Math.max(worst, -pnl * sc.weight);
  }
  return worst;
}

/** Model value of the long legs and of the short legs, kept apart — they are not
 * interchangeable in the margin formula (see spanFor). */
function optionValues(legs: MarginLeg[]): { long: number; short: number } {
  const spot = legs.length ? legs[0].spot : 0;
  let long = 0;
  let short = 0;
  for (const leg of legs) {
    const value = modelPrice(leg, spot, leg.ivPct) * leg.qty;
    if (leg.side === 'BUY') long += value;
    else short += value;
  }
  return { long, short };
}

function elmRateFor(leg: MarginLeg): number {
  if (!leg.isIndex) return ELM_STOCK_BASE;
  let rate = ELM_INDEX_BASE;
  const isOtm = leg.optionType === 'CE' ? leg.strike > leg.spot : leg.strike < leg.spot;
  // Spec measures moneyness off the previous close; spot is the closest thing we hold.
  if (isOtm && Math.abs(leg.strike - leg.spot) / leg.spot > 0.1) rate = ELM_INDEX_DEEP_OTM;
  if (leg.tYears > 0.75) rate = Math.max(rate, ELM_INDEX_LONG_DATED);
  if (leg.isExpiryDay) rate += ELM_EXPIRY_DAY_ADDON;
  return rate;
}

/** ELM applies to short option positions only, on spot notional rather than strike. */
function exposureFor(legs: MarginLeg[]): number {
  return legs
    .filter((l) => l.side === 'SELL')
    .reduce((sum, l) => sum + elmRateFor(l) * l.spot * l.qty, 0);
}

function groupBySymbol(legs: MarginLeg[]): MarginLeg[][] {
  const groups = new Map<string, MarginLeg[]>();
  for (const leg of legs) {
    const list = groups.get(leg.symbol);
    if (list) list.push(leg);
    else groups.set(leg.symbol, [leg]);
  }
  return [...groups.values()];
}

/** SPAN margin for one underlying: worst scenario loss, plus the cost to buy shorts back. */
function spanFor(legs: MarginLeg[]): number {
  const shortUnits = legs.filter((l) => l.side === 'SELL').reduce((s, l) => s + l.qty, 0);
  const som = SHORT_OPTION_MINIMUM * shortUnits;
  // Long and short option value enter asymmetrically. A long leg's value offsets scan
  // risk but cannot go past it — you have already paid that premium in cash, so crediting
  // the surplus hands it back a second time. Short value is always added, because the
  // position has to be bought back to close.
  //
  // The single netted term the code used before (`scanRisk − (long − short)`) collapses
  // the two, and it under-margined every debit spread: a NIFTY bull call spread came out
  // at ₹41.0k against the broker's ₹50.0k, the gap being precisely the short leg's
  // premium that the surplus long credit had swallowed.
  const { long, short } = optionValues(legs);
  return Math.max(0, Math.max(scanRisk(legs), som) - long) + short;
}

function computeScenarioMargin(legs: MarginLeg[]): {
  span: number;
  exposure: number;
  benefit: number;
} {
  const groups = groupBySymbol(legs);
  const span = groups.reduce((sum, g) => sum + spanFor(g), 0);
  const exposure = exposureFor(legs);
  // Benefit is what the portfolio saves against holding every leg on its own.
  const standalone = legs.reduce((sum, l) => sum + spanFor([l]), 0);
  return { span, exposure, benefit: Math.max(0, standalone - span) };
}

// ─── MCX path ────────────────────────────────────────────────────────────────

/**
 * Commodity margin, per the law documented at MCX_SCAN_RATE. Legs are grouped by
 * commodity only so a mixed basket picks up the right rate for each — the groups do not
 * net against one another, and neither do legs inside a group.
 */
function computeCommodityMargin(legs: MarginLeg[]): {
  span: number;
  optPrem: number;
  uncalibrated: string[];
} {
  let span = 0;
  let optPrem = 0;
  const uncalibrated: string[] = [];

  for (const group of groupBySymbol(legs)) {
    const symbol = group[0].symbol;
    const { rate, calibrated } = mcxRateFor(symbol);
    if (!calibrated && !uncalibrated.includes(symbol)) uncalibrated.push(symbol);

    let groupSpan = 0;
    let groupLongPrem = 0;
    for (const leg of group) {
      if (leg.side === 'SELL') groupSpan += (rate * leg.spot + leg.premium) * leg.qty;
      else groupLongPrem += leg.premium * leg.qty;
    }
    span += groupSpan;
    // Premium on a long leg is absorbed by the margin already blocked against the shorts
    // in the same commodity — a long crude call alongside a short one added ₹5,080 of its
    // ₹37,750 premium, not the whole thing. Only the excess is fresh cash.
    optPrem += Math.max(0, groupLongPrem - groupSpan);
  }

  return { span, optPrem, uncalibrated };
}

// ─── Exchange risk-array path ────────────────────────────────────────────────

function loadSpanRiskFile(): SpanRiskFile | null {
  if (!existsSync(SPAN_RISK_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(SPAN_RISK_PATH, 'utf8')) as SpanRiskFile;
    return parsed && parsed.contracts ? parsed : null;
  } catch (err) {
    console.warn('[local-margin] failed to parse SPAN risk file:', (err as Error).message);
    return null;
  }
}

/**
 * Keys are tried most-specific first. Every key carries the symbol, because a bare
 * strike+type would happily match a different underlying's contract at the same strike.
 */
function riskKeys(leg: MarginLeg): string[] {
  return [
    [leg.symbol, leg.expiry, String(leg.strike), leg.optionType].filter(Boolean).join(':'),
    `${leg.symbol}:${leg.strike}:${leg.optionType}`,
  ];
}

function computeSpanFromRiskFile(
  legs: MarginLeg[],
  riskFile: SpanRiskFile,
): { span: number; exposure: number } | null {
  const contracts = riskFile.contracts || {};
  const resolved = legs.map((leg) => {
    const contract = riskKeys(leg)
      .map((k) => contracts[k])
      .find(Boolean);
    return contract ? { leg, contract } : null;
  });
  if (resolved.some((item) => !item)) return null;

  const maxScenarios = Math.max(
    ...resolved.map((item) => item?.contract.riskArray?.length || 0),
    0,
  );
  let span = 0;
  if (maxScenarios > 0) {
    for (let scenario = 0; scenario < maxScenarios; scenario++) {
      let scenarioLoss = 0;
      for (const item of resolved) {
        if (!item) continue;
        const signedQty = item.leg.side === 'BUY' ? item.leg.qty : -item.leg.qty;
        const longPnlPerUnit = Number(item.contract.riskArray?.[scenario] || 0);
        scenarioLoss += -signedQty * longPnlPerUnit;
      }
      span = Math.max(span, scenarioLoss);
    }
  } else {
    span = resolved.reduce((sum, item) => {
      if (!item) return sum;
      return sum + Math.max(0, Number(item.contract.scanRiskPerUnit || 0)) * item.leg.qty;
    }, 0);
  }

  // Same option-value correction the scenario path makes, and asymmetric for the same
  // reason: long value offsets scan risk only as far as the scan risk goes, short value
  // is always added. See spanFor.
  const { long, short } = optionValues(legs);
  span = Math.max(0, span - long) + short;

  const exposure = resolved
    .filter((item) => item && item.leg.side === 'SELL')
    .reduce((sum, item) => {
      if (!item) return sum;
      const rate = Number(item.contract.exposureRate ?? elmRateFor(item.leg));
      return sum + item.leg.spot * item.leg.qty * rate;
    }, 0);

  return { span: Math.max(0, span), exposure: Math.max(0, exposure) };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function calculateLocalBasketMargin(
  orders: BasketMarginOrder[],
  fallbackSymbol = 'NIFTY',
  now = new Date(),
  exchange = 'NSE',
): LocalMarginResult | null {
  const { legs, dropped } = normalizeLegs(orders, fallbackSymbol, now, exchange);
  if (!legs.length) return null;

  const droppedNote =
    dropped > 0
      ? ` ${dropped} non-option leg${dropped > 1 ? 's were' : ' was'} excluded — futures are not yet priced locally.`
      : '';
  // MCX does not use the NSE scenario model at all — see MCX_SCAN_RATE. It also never
  // reaches the SPAN risk-file path below, which holds NSE contracts only.
  if (legs[0].isCommodity) {
    const { span, optPrem, uncalibrated } = computeCommodityMargin(legs);
    const spanP = paise(span);
    const premP = paise(optPrem);
    const warn = uncalibrated.length
      ? ` ⚠ ${uncalibrated.join(', ')} ${uncalibrated.length > 1 ? 'are' : 'is'} not in the measured rate table and fell back to ${(MCX_DEFAULT_RATE * 100).toFixed(1)}% of notional — treat as indicative.`
      : '';
    return {
      total_margin: spanP + premP,
      span: spanP,
      exposure: 0, // MCX quotes one blended charge; SPAN and ELM are not separable from it.
      opt_prem: premP,
      margin_benefit: 0, // MCX gives no portfolio netting, so there is none to report.
      estimated: true,
      source: 'local-mcx-rate',
      message: `Broker margin unavailable. Estimated from MCX commodity rates measured ${MCX_RATES_MEASURED_ON} (median error 0.6%).${droppedNote}${warn}`,
    };
  }

  // Cash actually needed to open the position: premium paid on longs less credit taken
  // in on shorts. A net-credit basket needs no premium outlay, and the risk it carries
  // is already in span/ELM — the credit must not be handed back a second time here.
  const premiumPayable = Math.max(
    0,
    legs.reduce((sum, l) => sum + (l.side === 'BUY' ? 1 : -1) * l.premium * l.qty, 0),
  );

  const riskFile = loadSpanRiskFile();
  const spanResult = riskFile ? computeSpanFromRiskFile(legs, riskFile) : null;

  // Round each component once, then add — rounding the total separately would leave it
  // a paisa off the sum of its parts, which the UI shows side by side.
  const premP = paise(premiumPayable);

  if (spanResult) {
    const spanP = paise(spanResult.span);
    const expP = paise(spanResult.exposure);
    return {
      total_margin: spanP + expP + premP,
      span: spanP,
      exposure: expP,
      opt_prem: premP,
      margin_benefit: 0,
      estimated: true,
      source: 'local-span-risk-file',
      message: `Exchange-style margin from local SPAN risk data${riskFile?.generatedAt ? ` (${riskFile.generatedAt})` : ''}. Broker margin still takes priority when Nubra is available.${droppedNote}`,
    };
  }

  const scenario = computeScenarioMargin(legs);
  const spanP = paise(scenario.span);
  const expP = paise(scenario.exposure);
  return {
    total_margin: spanP + expP + premP,
    span: spanP,
    exposure: expP,
    opt_prem: premP,
    margin_benefit: paise(scenario.benefit),
    estimated: true,
    source: 'local-scenario-span',
    message: `Broker margin unavailable. Estimated from a 16-scenario SPAN simulation. Add NSE SPAN risk data at ${SPAN_RISK_PATH} for exchange-exact figures.${droppedNote}`,
  };
}
