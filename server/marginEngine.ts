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
  isExpiryDay: boolean;
}

// ─── Exchange parameters ─────────────────────────────────────────────────────
// Extreme Loss Margin on short index options: 2% of SPOT notional, rising to 3% for
// strikes >10% out of the money and 5% beyond 9 months residual maturity, plus an
// additional 2% on expiry day (NSE, effective 20-Nov-2024). Long options carry none.
const ELM_INDEX_BASE       = Number(process.env.LOCAL_MARGIN_ELM_INDEX      || 0.02);
const ELM_INDEX_DEEP_OTM   = Number(process.env.LOCAL_MARGIN_ELM_DEEP_OTM   || 0.03);
const ELM_INDEX_LONG_DATED = Number(process.env.LOCAL_MARGIN_ELM_LONG_DATED || 0.05);
const ELM_EXPIRY_DAY_ADDON = Number(process.env.LOCAL_MARGIN_ELM_EXPIRY_ADDON || 0.02);
const ELM_STOCK_BASE       = Number(process.env.LOCAL_MARGIN_ELM_STOCK      || 0.035);

// Price scan range: 6σ scaled by √2, floored at 9.3% of underlying for index products
// and 14.2% for single stocks. At normal index IVs the floor is what binds.
const PSR_FLOOR_INDEX = 0.093;
const PSR_FLOOR_STOCK = 0.142;
const VSR_INDEX_PCT   = 4;   // ± absolute IV percentage points
const VSR_STOCK_PCT   = 10;

// The scan range is a property of the UNDERLYING, but the only volatility we hold is
// each option's implied vol — and a nearly-expired ATM option implies a far higher
// number than the index actually diffuses at. Left unbounded that inflates expiry-day
// margin badly, so the vol feeding the scan range is clamped to a plausible band for
// the underlying. Repricing still uses each leg's own unclamped IV.
const PSR_VOL_BAND_INDEX: [number, number] = [8, 22];
const PSR_VOL_BAND_STOCK: [number, number] = [12, 60];

// Short option minimum charge — zero in current NSCCL files, kept configurable.
const SHORT_OPTION_MINIMUM = Number(process.env.LOCAL_MARGIN_SHORT_OPTION_MIN || 0);
const DEFAULT_IV_PCT       = Number(process.env.LOCAL_MARGIN_DEFAULT_IV || 15);

const DEFAULT_SPAN_PATH = path.join(process.cwd(), 'data', 'margin', 'nse-span-risk.json');
const SPAN_RISK_PATH = process.env.NSE_SPAN_RISK_FILE || DEFAULT_SPAN_PATH;

const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX', 'SENSEX50']);

/**
 * The 16 SPAN risk scenarios: price shifts of 0, ±1/3, ±2/3, ±1 scan ranges crossed
 * with volatility up/down, plus the two ±2 scan-range moves that carry the exchange's
 * 35% cover fraction (they exist to catch deep-OTM shorts jumping into the money).
 */
const SCENARIOS: Array<{ price: number; vol: number; weight: number }> = [
  { price:  0,     vol:  1, weight: 1 },
  { price:  0,     vol: -1, weight: 1 },
  { price:  1 / 3, vol:  1, weight: 1 },
  { price:  1 / 3, vol: -1, weight: 1 },
  { price: -1 / 3, vol:  1, weight: 1 },
  { price: -1 / 3, vol: -1, weight: 1 },
  { price:  2 / 3, vol:  1, weight: 1 },
  { price:  2 / 3, vol: -1, weight: 1 },
  { price: -2 / 3, vol:  1, weight: 1 },
  { price: -2 / 3, vol: -1, weight: 1 },
  { price:  1,     vol:  1, weight: 1 },
  { price:  1,     vol: -1, weight: 1 },
  { price: -1,     vol:  1, weight: 1 },
  { price: -1,     vol: -1, weight: 1 },
  { price:  2,     vol:  0, weight: 0.35 },
  { price: -2,     vol:  0, weight: 0.35 },
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
  return (value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeSymbol(value: string | undefined): string {
  return (value || 'NIFTY').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
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
  return /^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}` : null;
}

function normalizeLegs(orders: BasketMarginOrder[], fallbackSymbol = 'NIFTY', now = new Date()): {
  legs: MarginLeg[];
  dropped: number;
} {
  const { date, hhmm } = istNow(now);
  let dropped = 0;

  const legs = orders.flatMap((o): MarginLeg[] => {
    const optionType = optionTypeOf(o.option_type);
    const strike = Number(o.strike || 0);
    const qty = Math.abs(Number(o.order_qty || 0));
    if (!optionType || !(strike > 0) || !(qty > 0)) { dropped++; return []; }

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

    return [{
      symbol, expiry, optionType, side: sideOf(o.order_side), strike, qty, premium,
      spot, ivPct, tYears,
      isIndex: INDEX_SYMBOLS.has(symbol),
      isExpiryDay: iso === date,
    }];
  });

  return { legs, dropped };
}

// ─── Scenario engine ─────────────────────────────────────────────────────────

function modelPrice(leg: MarginLeg, spot: number, ivPct: number): number {
  return bsPrice(leg.optionType === 'CE' ? 'CALL' : 'PUT', spot, leg.strike, Math.max(0.01, ivPct), leg.tYears);
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
  const psr = spot * Math.max(
    isIndex ? PSR_FLOOR_INDEX : PSR_FLOOR_STOCK,
    6 * (psrIv / 100 / Math.sqrt(252)) * Math.SQRT2,
  );
  const vsr = isIndex ? VSR_INDEX_PCT : VSR_STOCK_PCT;

  const base = legs.map(l => modelPrice(l, spot, l.ivPct));

  let worst = 0;
  for (const sc of SCENARIOS) {
    let pnl = 0;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const shocked = modelPrice(leg, spot + sc.price * psr, leg.ivPct + sc.vol * vsr);
      const signedQty = leg.side === 'BUY' ? leg.qty : -leg.qty;
      pnl += signedQty * (shocked - base[i]);
    }
    worst = Math.max(worst, -pnl * sc.weight);
  }
  return worst;
}

/** Net option value: what the option position is worth, long positive and short negative. */
function netOptionValue(legs: MarginLeg[]): number {
  const spot = legs.length ? legs[0].spot : 0;
  return legs.reduce((sum, l) => {
    const signedQty = l.side === 'BUY' ? l.qty : -l.qty;
    return sum + signedQty * modelPrice(l, spot, l.ivPct);
  }, 0);
}

function elmRateFor(leg: MarginLeg): number {
  if (!leg.isIndex) return ELM_STOCK_BASE;
  let rate = ELM_INDEX_BASE;
  const isOtm = leg.optionType === 'CE' ? leg.strike > leg.spot : leg.strike < leg.spot;
  // Spec measures moneyness off the previous close; spot is the closest thing we hold.
  if (isOtm && Math.abs(leg.strike - leg.spot) / leg.spot > 0.10) rate = ELM_INDEX_DEEP_OTM;
  if (leg.tYears > 0.75) rate = Math.max(rate, ELM_INDEX_LONG_DATED);
  if (leg.isExpiryDay) rate += ELM_EXPIRY_DAY_ADDON;
  return rate;
}

/** ELM applies to short option positions only, on spot notional rather than strike. */
function exposureFor(legs: MarginLeg[]): number {
  return legs
    .filter(l => l.side === 'SELL')
    .reduce((sum, l) => sum + elmRateFor(l) * l.spot * l.qty, 0);
}

function groupBySymbol(legs: MarginLeg[]): MarginLeg[][] {
  const groups = new Map<string, MarginLeg[]>();
  for (const leg of legs) {
    const list = groups.get(leg.symbol);
    if (list) list.push(leg); else groups.set(leg.symbol, [leg]);
  }
  return [...groups.values()];
}

/** SPAN margin for one underlying: worst scenario loss, less what the options are worth. */
function spanFor(legs: MarginLeg[]): number {
  const shortUnits = legs.filter(l => l.side === 'SELL').reduce((s, l) => s + l.qty, 0);
  const som = SHORT_OPTION_MINIMUM * shortUnits;
  return Math.max(0, Math.max(scanRisk(legs), som) - netOptionValue(legs));
}

function computeScenarioMargin(legs: MarginLeg[]): { span: number; exposure: number; benefit: number } {
  const groups = groupBySymbol(legs);
  const span = groups.reduce((sum, g) => sum + spanFor(g), 0);
  const exposure = exposureFor(legs);
  // Benefit is what the portfolio saves against holding every leg on its own.
  const standalone = legs.reduce((sum, l) => sum + spanFor([l]), 0);
  return { span, exposure, benefit: Math.max(0, standalone - span) };
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

function computeSpanFromRiskFile(legs: MarginLeg[], riskFile: SpanRiskFile): { span: number; exposure: number } | null {
  const contracts = riskFile.contracts || {};
  const resolved = legs.map((leg) => {
    const contract = riskKeys(leg).map(k => contracts[k]).find(Boolean);
    return contract ? { leg, contract } : null;
  });
  if (resolved.some(item => !item)) return null;

  const maxScenarios = Math.max(...resolved.map(item => item?.contract.riskArray?.length || 0), 0);
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

  // Same net-option-value correction the scenario path makes: without it short options
  // are under-margined by their premium and long options over-margined by theirs.
  span = Math.max(0, span - netOptionValue(legs));

  const exposure = resolved
    .filter(item => item && item.leg.side === 'SELL')
    .reduce((sum, item) => {
      if (!item) return sum;
      const rate = Number(item.contract.exposureRate ?? elmRateFor(item.leg));
      return sum + item.leg.spot * item.leg.qty * rate;
    }, 0);

  return { span: Math.max(0, span), exposure: Math.max(0, exposure) };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function calculateLocalBasketMargin(
  orders: BasketMarginOrder[], fallbackSymbol = 'NIFTY', now = new Date(),
): LocalMarginResult | null {
  const { legs, dropped } = normalizeLegs(orders, fallbackSymbol, now);
  if (!legs.length) return null;

  const droppedNote = dropped > 0
    ? ` ${dropped} non-option leg${dropped > 1 ? 's were' : ' was'} excluded — futures are not yet priced locally.`
    : '';
  // Cash actually needed to open the position: premium paid on longs less credit taken
  // in on shorts. A net-credit basket needs no premium outlay, and the risk it carries
  // is already in span/ELM — the credit must not be handed back a second time here.
  const premiumPayable = Math.max(0, legs.reduce(
    (sum, l) => sum + (l.side === 'BUY' ? 1 : -1) * l.premium * l.qty, 0,
  ));

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
