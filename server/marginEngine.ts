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
  /** Previous underlying close in rupees, resolved from the live/history feed. */
  previous_close?: number;
  /** Annualised 20-session realised volatility percentage from the Nubra feed. */
  realized_vol?: number;
  /** Epoch milliseconds for the option-chain observation used by this quote. */
  market_data_as_of?: number;
  oi?: number;
  volume?: number;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
}

export type MarginConfidence = 'high' | 'medium' | 'low';

export interface LocalMarginResult {
  total_margin: number;
  span: number;
  exposure: number;
  opt_prem: number;
  margin_benefit: number;
  estimated: true;
  source: string;
  message: string;
  confidence: MarginConfidence;
  as_of: string | null;
  raw_estimate: number;
  conservative_total: number;
  calibration_samples: number;
}

export interface LocalMarginOptions {
  /** Apply recent successful Nubra quote calibration. Defaults to true. */
  useCalibration?: boolean;
  /** Add a confidence-based safety buffer. Margin routes enable this for fallbacks. */
  conservative?: boolean;
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
  marketIvPct: number;
  hasQuotedIv: boolean;
  realizedVolPct: number | null;
  previousClose: number | null;
  marketDataAsOf: number | null;
  oi: number | null;
  volume: number | null;
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

// Exchange floors stay as safety constraints; the active scan range is recomputed from
// live IV, realised volatility, the overnight gap and liquidity on every request.
const PSR_FLOOR_INDEX = 0.093;
const PSR_FLOOR_STOCK = 0.142;
const VSR_INDEX_FLOOR_PCT = 4;
const VSR_STOCK_FLOOR_PCT = 10;
const MCX_RATE_FLOOR = Number(process.env.LOCAL_MARGIN_MCX_RATE_FLOOR || 0.075);
const MCX_RATE_CAP = Number(process.env.LOCAL_MARGIN_MCX_RATE_CAP || 0.75);

// Short option minimum charge — zero in current NSCCL files, kept configurable.
const SHORT_OPTION_MINIMUM = Number(process.env.LOCAL_MARGIN_SHORT_OPTION_MIN || 0);
const DEFAULT_IV_PCT = Number(process.env.LOCAL_MARGIN_DEFAULT_IV || 15);
const CALIBRATION_TTL_MS = 24 * 60 * 60 * 1000;

interface MarginCalibration {
  riskFactor: number;
  samples: number;
  asOf: number;
}

const marginCalibrations = new Map<string, MarginCalibration>();

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

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
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
    const quotedIv = finitePositive(o.iv);
    const ivPct = solved ?? quotedIv ?? DEFAULT_IV_PCT;

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
        marketIvPct: quotedIv ?? solved ?? DEFAULT_IV_PCT,
        hasQuotedIv: quotedIv != null,
        realizedVolPct: finitePositive(o.realized_vol),
        previousClose: finitePositive(o.previous_close),
        marketDataAsOf: finitePositive(o.market_data_as_of),
        oi: finitePositive(o.oi),
        volume: finitePositive(o.volume),
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

interface DynamicRiskParameters {
  scanFraction: number;
  baseIvPct: number;
  volScanPct: number;
  stressVolPct: number;
  gapPct: number;
  liquidityMultiplier: number;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Converts the current feed state into the two SPAN shocks. The exchange floors are
 * retained as guardrails, but they no longer pin the model in stressed markets:
 * realised volatility, implied volatility, an overnight gap and thin liquidity can all
 * widen the price/volatility scans immediately.
 */
function dynamicRiskParameters(legs: MarginLeg[], commodity = false): DynamicRiskParameters {
  const marketIv = average(legs.map((leg) => leg.marketIvPct).filter((value) => value > 0));
  const realizedValues = legs
    .map((leg) => leg.realizedVolPct)
    .filter((value): value is number => value != null && value > 0);
  const realizedVol = average(realizedValues);
  const stressVolPct = Math.max(marketIv || DEFAULT_IV_PCT, realizedVol || 0);
  const sigmaShock = 6 * (stressVolPct / 100 / Math.sqrt(252)) * Math.SQRT2;
  const gapPct = legs.reduce((largest, leg) => {
    if (!leg.previousClose) return largest;
    return Math.max(largest, Math.abs(leg.spot / leg.previousClose - 1));
  }, 0);

  const hasLiquidity = legs.some((leg) => leg.oi != null || leg.volume != null);
  const thinLiquidity = legs.some(
    (leg) => (leg.oi != null && leg.oi < 500) || (leg.volume != null && leg.volume < 100),
  );
  const liquidityMultiplier = hasLiquidity && thinLiquidity ? 1.08 : 1;
  const exchangeFloor = commodity ? 0 : legs[0]?.isIndex ? PSR_FLOOR_INDEX : PSR_FLOOR_STOCK;
  const scanFraction = Math.min(
    0.8,
    Math.max(exchangeFloor, sigmaShock, gapPct * 2) * liquidityMultiplier,
  );
  const volFloor = legs[0]?.isIndex ? VSR_INDEX_FLOOR_PCT : VSR_STOCK_FLOOR_PCT;
  const volScanPct = Math.min(
    commodity ? 50 : legs[0]?.isIndex ? 20 : 35,
    Math.max(volFloor, stressVolPct * 0.25, Math.abs(marketIv - realizedVol) * 0.5),
  );

  return {
    scanFraction,
    baseIvPct: Math.max(1, Math.min(200, marketIv || DEFAULT_IV_PCT)),
    volScanPct,
    stressVolPct,
    gapPct,
    liquidityMultiplier,
  };
}

/**
 * Worst-case portfolio loss across the 16 scenarios, for legs sharing one underlying.
 * Every leg is repriced at its own time to expiry under a common shock, so verticals,
 * strangles, ratios and calendars all net out without any per-strategy rule.
 */
function scanRisk(legs: MarginLeg[]): number {
  if (!legs.length) return 0;
  const spot = legs[0].spot;
  const { scanFraction: psrFrac, baseIvPct: psrIv, volScanPct: vsr } = dynamicRiskParameters(legs);

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
  const reference = leg.previousClose || leg.spot;
  const isOtm = leg.optionType === 'CE' ? leg.strike > reference : leg.strike < reference;
  if (isOtm && Math.abs(leg.strike - reference) / reference > 0.1) rate = ELM_INDEX_DEEP_OTM;
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
 * MCX quotes behave like a per-underlying scan charge without cross-leg netting. The
 * charge is recomputed from current IV, realised volatility, gaps and liquidity instead
 * of a dated per-commodity rate table.
 */
function computeCommodityMargin(legs: MarginLeg[]): {
  span: number;
  optPrem: number;
  maxRate: number;
} {
  let span = 0;
  let optPrem = 0;
  let maxRate = 0;

  for (const group of groupBySymbol(legs)) {
    const marketRate = 0.9 * dynamicRiskParameters(group, true).scanFraction;
    const rate = Math.max(MCX_RATE_FLOOR, Math.min(MCX_RATE_CAP, marketRate));
    maxRate = Math.max(maxRate, rate);

    let groupSpan = 0;
    let groupLongPrem = 0;
    for (const leg of group) {
      if (leg.side === 'SELL')
        groupSpan += Math.round((rate * leg.spot + leg.premium) * leg.qty * 100) / 100;
      else groupLongPrem += Math.round(leg.premium * leg.qty * 100) / 100;
    }
    span += groupSpan;
    // Premium on a long leg is absorbed by the margin already blocked against the shorts
    // in the same commodity — a long crude call alongside a short one added ₹5,080 of its
    // ₹37,750 premium, not the whole thing. Only the excess is fresh cash.
    optPrem += Math.max(0, groupLongPrem - groupSpan);
  }

  return { span, optPrem, maxRate };
}

// ─── Live quote calibration and confidence ──────────────────────────────────

function calibrationKey(legs: MarginLeg[], exchange: string): string | null {
  if (!legs.length) return null;
  const first = `${normalizeSymbol(exchange)}:${legs[0].symbol}:${legs[0].expiry}`;
  return legs.every((leg) => `${normalizeSymbol(exchange)}:${leg.symbol}:${leg.expiry}` === first)
    ? first
    : null;
}

function currentCalibration(
  legs: MarginLeg[],
  exchange: string,
  nowMs: number,
): MarginCalibration | null {
  const key = calibrationKey(legs, exchange);
  if (!key) return null;
  const calibration = marginCalibrations.get(key);
  if (!calibration || nowMs - calibration.asOf > CALIBRATION_TTL_MS) return null;
  return calibration;
}

function feedAssessment(
  legs: MarginLeg[],
  calibration: MarginCalibration | null,
  nowMs: number,
): { confidence: MarginConfidence; asOf: number | null; buffer: number } {
  const timestamps = legs
    .map((leg) => leg.marketDataAsOf)
    .filter((value): value is number => value != null && value > 0);
  const asOf = timestamps.length ? Math.min(...timestamps) : null;
  const ageMs = asOf == null ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - asOf);
  const quotedIv = legs.every((leg) => leg.hasQuotedIv);
  const hasHistory = legs.every((leg) => leg.realizedVolPct != null && leg.previousClose != null);

  let confidence: MarginConfidence = 'low';
  if (
    ageMs <= 30_000 &&
    quotedIv &&
    hasHistory &&
    calibration != null &&
    calibration.samples >= 2
  ) {
    confidence = 'high';
  } else if (ageMs <= 120_000 && quotedIv && (hasHistory || calibration != null)) {
    confidence = 'medium';
  }

  return {
    confidence,
    asOf,
    buffer: confidence === 'high' ? 1.02 : confidence === 'medium' ? 1.07 : 1.12,
  };
}

interface MarginComponents {
  span: number;
  exposure: number;
  premium: number;
  benefit: number;
}

function finalizeFeedResult(
  legs: MarginLeg[],
  components: MarginComponents,
  exchange: string,
  now: Date,
  options: LocalMarginOptions,
  messageDetail: string,
): LocalMarginResult {
  const rawSpan = paise(components.span);
  const rawExposure = paise(components.exposure);
  const premium = paise(components.premium);
  const rawBenefit = paise(components.benefit);
  const rawEstimate = rawSpan + rawExposure + premium;
  const calibration =
    options.useCalibration === false ? null : currentCalibration(legs, exchange, now.getTime());
  const assessment = feedAssessment(legs, calibration, now.getTime());
  const calibrationFactor = calibration?.riskFactor ?? 1;
  const calibratedSpan = Math.round(rawSpan * calibrationFactor);
  const calibratedExposure = Math.round(rawExposure * calibrationFactor);
  const calibratedBenefit = Math.round(rawBenefit * calibrationFactor);
  const conservativeSpan = Math.round(calibratedSpan * assessment.buffer);
  const conservativeExposure = Math.round(calibratedExposure * assessment.buffer);
  const useConservative = options.conservative === true;
  const span = useConservative ? conservativeSpan : calibratedSpan;
  const exposure = useConservative ? conservativeExposure : calibratedExposure;
  const benefit = useConservative
    ? Math.round(calibratedBenefit * assessment.buffer)
    : calibratedBenefit;
  const total = span + exposure + premium;
  const conservativeTotal = conservativeSpan + conservativeExposure + premium;
  const source = `${exchange.toUpperCase() === 'MCX' ? 'feed-dynamic-mcx' : 'feed-dynamic-span'}${
    calibration ? '-calibrated' : ''
  }`;
  const params = dynamicRiskParameters(legs, exchange.toUpperCase() === 'MCX');
  const calibrationNote = calibration
    ? ` Calibrated from ${calibration.samples} successful Nubra quote${calibration.samples === 1 ? '' : 's'}.`
    : ' No recent Nubra calibration was available.';
  const freshnessNote = assessment.asOf
    ? ` Feed as of ${new Date(assessment.asOf).toISOString()}.`
    : ' Feed timestamp was unavailable.';

  return {
    total_margin: total,
    span,
    exposure,
    opt_prem: premium,
    margin_benefit: benefit,
    estimated: true,
    source,
    confidence: assessment.confidence,
    as_of: assessment.asOf ? new Date(assessment.asOf).toISOString() : null,
    raw_estimate: rawEstimate,
    conservative_total: conservativeTotal,
    calibration_samples: calibration?.samples ?? 0,
    message: `Broker margin unavailable. ${messageDetail} Live stress volatility ${params.stressVolPct.toFixed(
      1,
    )}%, price scan ${(params.scanFraction * 100).toFixed(1)}%, confidence ${assessment.confidence}.${
      useConservative
        ? ` A ${Math.round((assessment.buffer - 1) * 100)}% safety buffer is included.`
        : ''
    }${calibrationNote}${freshnessNote}`,
  };
}

/**
 * Learns a bounded EWMA correction from successful broker quotes. Only a single
 * underlying/expiry basket is accepted so a mixed basket cannot contaminate another
 * contract's future fallback.
 */
export function observeNubraMarginQuote(
  orders: BasketMarginOrder[],
  brokerTotalPaise: number,
  exchange = 'NSE',
  now = new Date(),
): void {
  if (!(brokerTotalPaise > 0)) return;
  const { legs } = normalizeLegs(orders, undefined, now, exchange);
  const key = calibrationKey(legs, exchange);
  if (!key || !legs.some((leg) => leg.side === 'SELL')) return;
  const raw = calculateLocalBasketMargin(orders, undefined, now, exchange, {
    useCalibration: false,
    conservative: false,
  });
  if (!raw) return;
  const localRisk = raw.span + raw.exposure;
  const brokerRisk = Math.max(0, brokerTotalPaise - raw.opt_prem);
  if (!(localRisk > 0) || !(brokerRisk > 0)) return;
  const observed = Math.max(0.5, Math.min(3, brokerRisk / localRisk));
  const previous = marginCalibrations.get(key);
  const riskFactor = previous ? previous.riskFactor * 0.75 + observed * 0.25 : observed;
  marginCalibrations.set(key, {
    riskFactor,
    samples: (previous?.samples ?? 0) + 1,
    asOf: now.getTime(),
  });
}

/** Test/support hook; production never clears calibrations during a running session. */
export function clearMarginCalibrations(): void {
  marginCalibrations.clear();
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function calculateLocalBasketMargin(
  orders: BasketMarginOrder[],
  fallbackSymbol = 'NIFTY',
  now = new Date(),
  exchange = 'NSE',
  options: LocalMarginOptions = {},
): LocalMarginResult | null {
  const { legs, dropped } = normalizeLegs(orders, fallbackSymbol, now, exchange);
  if (!legs.length) return null;

  const droppedNote =
    dropped > 0
      ? ` ${dropped} non-option leg${dropped > 1 ? 's were' : ' was'} excluded — futures are not yet priced locally.`
      : '';
  if (legs[0].isCommodity) {
    const { span, optPrem, maxRate } = computeCommodityMargin(legs);
    return finalizeFeedResult(
      legs,
      { span, exposure: 0, premium: optPrem, benefit: 0 },
      exchange,
      now,
      options,
      `Estimated from the live MCX feed at a ${(maxRate * 100).toFixed(1)}% dynamic scan rate.${droppedNote}`,
    );
  }

  // Cash actually needed to open the position: premium paid on longs less credit taken
  // in on shorts. A net-credit basket needs no premium outlay, and the risk it carries
  // is already in span/ELM — the credit must not be handed back a second time here.
  const premiumPayable = Math.max(
    0,
    legs.reduce((sum, l) => sum + (l.side === 'BUY' ? 1 : -1) * l.premium * l.qty, 0),
  );

  const scenario = computeScenarioMargin(legs);
  return finalizeFeedResult(
    legs,
    {
      span: scenario.span,
      exposure: scenario.exposure,
      premium: premiumPayable,
      benefit: scenario.benefit,
    },
    exchange,
    now,
    options,
    `Estimated from a feed-driven 16-scenario SPAN simulation.${droppedNote}`,
  );
}
