import { existsSync, readFileSync } from 'fs';
import path from 'path';

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
}

const INDEX_OPTION_EXPOSURE_RATE = Number(process.env.LOCAL_MARGIN_EXPOSURE_RATE || 0.02);
const NAKED_SHORT_SPAN_RATE = Number(process.env.LOCAL_MARGIN_NAKED_SHORT_SPAN_RATE || 0.09);
const SHORT_STRANGLE_SECOND_LEG_ADDON = Number(process.env.LOCAL_MARGIN_STRANGLE_SECOND_LEG_ADDON || 0.0);
const DEFAULT_SPAN_PATH = path.join(process.cwd(), 'data', 'margin', 'nse-span-risk.json');
const SPAN_RISK_PATH = process.env.NSE_SPAN_RISK_FILE || DEFAULT_SPAN_PATH;

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

function normalizeLegs(orders: BasketMarginOrder[], fallbackSymbol = 'NIFTY'): MarginLeg[] {
  return orders.flatMap((o) => {
    const optionType = optionTypeOf(o.option_type);
    const strike = Number(o.strike || 0);
    const qty = Math.abs(Number(o.order_qty || 0));
    if (!optionType || !(strike > 0) || !(qty > 0)) return [];
    return [{
      symbol: normalizeSymbol(o.symbol || fallbackSymbol),
      expiry: normalizeExpiry(o.expiry),
      optionType,
      side: sideOf(o.order_side),
      strike,
      qty,
      premium: Math.max(0, Number(o.ltp ?? o.order_price ?? 0)),
    }];
  });
}

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

function riskKeys(leg: MarginLeg): string[] {
  const full = [leg.symbol, leg.expiry, String(leg.strike), leg.optionType].filter(Boolean).join(':');
  return [
    full,
    `${leg.symbol}:${leg.strike}:${leg.optionType}`,
    `${leg.expiry}:${leg.strike}:${leg.optionType}`,
    `${leg.strike}:${leg.optionType}`,
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

  const exposure = resolved.reduce((sum, item) => {
    if (!item) return sum;
    const rate = Number(item.contract.exposureRate ?? INDEX_OPTION_EXPOSURE_RATE);
    return sum + item.leg.strike * item.leg.qty * rate;
  }, 0);

  return { span: Math.max(0, span), exposure: Math.max(0, exposure) };
}

function matchVerticals(shorts: MarginLeg[], longs: MarginLeg[], isCall: boolean): { definedRisk: number; nakedQty: number; usedLongPremium: number } {
  let definedRisk = 0;
  let nakedQty = 0;
  let usedLongPremium = 0;
  const remainingLongs = longs.map(l => ({ ...l }));

  for (const short of shorts) {
    let remaining = short.qty;
    const hedges = remainingLongs
      .filter(long => long.qty > 0 && (isCall ? long.strike > short.strike : long.strike < short.strike))
      .sort((a, b) => isCall ? a.strike - b.strike : b.strike - a.strike);

    for (const hedge of hedges) {
      if (remaining <= 0) break;
      const matchedQty = Math.min(remaining, hedge.qty);
      const width = Math.abs(hedge.strike - short.strike);
      const netCredit = Math.max(0, short.premium - hedge.premium);
      definedRisk += Math.max(0, width - netCredit) * matchedQty;
      usedLongPremium += hedge.premium * matchedQty;
      hedge.qty -= matchedQty;
      remaining -= matchedQty;
    }

    nakedQty += Math.max(0, remaining);
  }

  return { definedRisk, nakedQty, usedLongPremium };
}

function shortNakedSpan(leg: MarginLeg, qty: number): number {
  return leg.strike * qty * NAKED_SHORT_SPAN_RATE;
}

function pairShortStrangles(unpairedCalls: MarginLeg[], unpairedPuts: MarginLeg[]): { span: number; pairedStandaloneSpan: number } {
  let span = 0;
  let pairedStandaloneSpan = 0;
  const calls = unpairedCalls.map(l => ({ ...l }));
  const puts = unpairedPuts.map(l => ({ ...l }));

  for (const call of calls) {
    if (call.qty <= 0) continue;
    const candidates = puts
      .filter(put => put.qty > 0 && put.expiry === call.expiry && put.symbol === call.symbol)
      .sort((a, b) => Math.abs(a.strike - call.strike) - Math.abs(b.strike - call.strike));

    for (const put of candidates) {
      if (call.qty <= 0) break;
      const qty = Math.min(call.qty, put.qty);
      const callSpan = shortNakedSpan(call, qty);
      const putSpan = shortNakedSpan(put, qty);
      span += Math.max(callSpan, putSpan) + Math.min(callSpan, putSpan) * SHORT_STRANGLE_SECOND_LEG_ADDON;
      pairedStandaloneSpan += callSpan + putSpan;
      call.qty -= qty;
      put.qty -= qty;
    }
  }

  unpairedCalls.splice(0, unpairedCalls.length, ...calls.filter(l => l.qty > 0));
  unpairedPuts.splice(0, unpairedPuts.length, ...puts.filter(l => l.qty > 0));
  return { span, pairedStandaloneSpan };
}

function computeConservativeFallback(legs: MarginLeg[]): { span: number; exposure: number; benefit: number } {
  const grossNakedMargin = legs
    .filter(l => l.side === 'SELL')
    .reduce((sum, l) => sum + shortNakedSpan(l, l.qty), 0);

  let span = 0;
  let hedgedLongPremium = 0;
  const unpairedShorts: Record<'CE' | 'PE', MarginLeg[]> = { CE: [], PE: [] };
  for (const optionType of ['CE', 'PE'] as const) {
    const sameType = legs.filter(l => l.optionType === optionType);
    const shorts = sameType.filter(l => l.side === 'SELL').sort((a, b) => a.strike - b.strike);
    const longs = sameType.filter(l => l.side === 'BUY').sort((a, b) => a.strike - b.strike);
    const matched = matchVerticals(shorts, longs, optionType === 'CE');
    span += matched.definedRisk;
    if (matched.nakedQty > 0) {
      for (const short of shorts) {
        const qty = Math.min(short.qty, matched.nakedQty - unpairedShorts[optionType].reduce((sum, l) => sum + l.qty, 0));
        if (qty > 0) unpairedShorts[optionType].push({ ...short, qty });
        if (unpairedShorts[optionType].reduce((sum, l) => sum + l.qty, 0) >= matched.nakedQty) break;
      }
    }
    hedgedLongPremium += matched.usedLongPremium;
  }

  const paired = pairShortStrangles(unpairedShorts.CE, unpairedShorts.PE);
  span += paired.span;
  for (const l of [...unpairedShorts.CE, ...unpairedShorts.PE]) span += shortNakedSpan(l, l.qty);

  const longPremium = legs
    .filter(l => l.side === 'BUY')
    .reduce((sum, l) => sum + l.premium * l.qty, 0);
  span += Math.max(0, longPremium - hedgedLongPremium);

  const exposure = legs
    .filter(l => l.side === 'SELL')
    .reduce((sum, l) => sum + l.strike * l.qty * INDEX_OPTION_EXPOSURE_RATE, 0);

  const unhedgedTotal = grossNakedMargin + exposure + longPremium;
  const hedgedTotal = span + exposure;
  return { span, exposure, benefit: Math.max(0, unhedgedTotal - hedgedTotal) };
}

export function calculateLocalBasketMargin(orders: BasketMarginOrder[], fallbackSymbol = 'NIFTY'): LocalMarginResult | null {
  const legs = normalizeLegs(orders, fallbackSymbol);
  if (!legs.length) return null;

  const premiumPayable = legs
    .filter(l => l.side === 'BUY')
    .reduce((sum, l) => sum + l.premium * l.qty, 0);

  const riskFile = loadSpanRiskFile();
  const spanResult = riskFile ? computeSpanFromRiskFile(legs, riskFile) : null;

  if (spanResult) {
    const total = spanResult.span + spanResult.exposure + premiumPayable;
    return {
      total_margin: paise(total),
      span: paise(spanResult.span),
      exposure: paise(spanResult.exposure),
      opt_prem: paise(premiumPayable),
      margin_benefit: 0,
      estimated: true,
      source: 'local-span-risk-file',
      message: `Exchange-style margin from local SPAN risk data${riskFile?.generatedAt ? ` (${riskFile.generatedAt})` : ''}. Broker margin still takes priority when Nubra is available.`,
    };
  }

  const fallback = computeConservativeFallback(legs);
  const total = fallback.span + fallback.exposure + premiumPayable;
  return {
    total_margin: paise(total),
    span: paise(fallback.span),
    exposure: paise(fallback.exposure),
    opt_prem: paise(premiumPayable),
    margin_benefit: paise(fallback.benefit),
    estimated: true,
    source: 'local-conservative-fallback',
    message: `Broker margin unavailable. Using local exchange-style fallback. Add NSE SPAN risk data at ${SPAN_RISK_PATH} for Level 3 risk-file calculation.`,
  };
}
