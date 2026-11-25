import type { SignalUnderlying } from './signalBacktest';

export const OPENING_STRANGLE_API = '/api/analysis/opening-strangle';
export const OPENING_MINUTE = 9 * 60 + 15;
export const OPENING_SESSION_MINUTES = 375;
export const OPENING_DTE_GROUPS = ['0', '1', '2', '3', '4', '5+'] as const;
export const OPENING_DRIVERS = ['entryCredit', 'entryIv', 'spotMove', 'ivChange', 'touch'] as const;
export const OPENING_ENTRY_FEATURES = [
  'entryCredit',
  'premiumImbalance',
  'entryIv',
  'ivSkew',
  'callDistancePct',
  'putDistancePct',
  'overnightGapPct',
  'dte',
  'monthly',
  'creditVsRecent',
  'ivVsRecent',
] as const;

export type OpeningDteGroup = (typeof OPENING_DTE_GROUPS)[number];
export type OpeningDriver = (typeof OPENING_DRIVERS)[number];
export type OpeningUnit = 'rupees' | 'creditPct';
export type OpeningContract = 'all' | 'weekly' | 'monthly';
export type OpeningSource = 'nubra' | 'local';
export type StrikeTouch = 'Neither' | 'Call' | 'Put' | 'Both';
export type OpeningGrid = Array<number | null>;
export type OpeningEntryFeature = (typeof OPENING_ENTRY_FEATURES)[number];

export interface OpeningResearchRow {
  date: string;
  pnl: OpeningGrid;
  features: Record<OpeningEntryFeature, number | null>;
}

export interface OpeningFilters {
  underlying: SignalUnderlying;
  includeLocalOnly?: boolean;
  from?: string;
  to?: string;
  contract: OpeningContract;
  expiry?: string;
  onTimeOnly: boolean;
  unit: OpeningUnit;
  roundTripCost?: number;
  driver?: OpeningDriver;
  dte?: OpeningDteGroup;
  includeResearch?: boolean;
}

export interface OpeningDates {
  underlying: SignalUnderlying;
  defaultIncludeLocalOnly: boolean;
  includeLocalOnly: boolean;
  dates: Array<{ date: string; source: OpeningSource }>;
}

export interface OpeningDayMetadata {
  date: string;
  source: OpeningSource;
  expiry: string;
  monthly: boolean;
  dte: number;
  dteGroup: OpeningDteGroup;
}

export interface OpeningDaySummary extends OpeningDayMetadata {
  entry: number;
  entrySpot: number;
  ceStrike: number;
  peStrike: number;
  ceEntry: number;
  peEntry: number;
  quantity: number;
  entryCredit: number;
  entryIv: number | null;
  spotMove: number | null;
  ivChange: number | null;
  touch: StrikeTouch | null;
  close: number | null;
  best: { minute: number; pnl: number };
  worst: { minute: number; pnl: number };
  drawdown: number;
  marked: number;
  possible: number;
  lastMarked: number;
}

export interface OpeningAttribution {
  forward: number;
  time: number;
  iv: number;
  residual: number;
  actual: number;
}

export interface OpeningDay {
  summary: OpeningDaySummary;
  spot: OpeningGrid;
  cePnl: OpeningGrid;
  pePnl: OpeningGrid;
  pnl: OpeningGrid;
  ceIv: OpeningGrid;
  peIv: OpeningGrid;
  attribution: Array<OpeningAttribution | null>;
}

export interface OpeningCurvePoint {
  n: number;
  p10: number | null;
  median: number | null;
  p90: number | null;
}

export interface OpeningGroup {
  label: string;
  dates: string[];
  n: number;
  closeN: number;
  medianCredit: number | null;
  medianClose: number | null;
  p10Close: number | null;
  profitableClosePct: number | null;
  medianDrawdown: number | null;
  curve: OpeningCurvePoint[];
}

export interface OpeningCheckpoint {
  minute: number;
  n: number;
  observed: number;
  mean: OpeningAttribution | null;
}

export interface OpeningStudy {
  days: OpeningDaySummary[];
  skipped: Array<{ date: string; source: OpeningSource; reason: string }>;
  expiries: string[];
  roundTripCost?: number;
  groups: Array<OpeningGroup & { dte: OpeningDteGroup; attribution: OpeningCheckpoint[] }>;
  research?: { rows: OpeningResearchRow[] };
  driver: {
    name: OpeningDriver;
    dte: OpeningDteGroup;
    missing: number;
    cutoffs: [number, number] | null;
    groups: OpeningGroup[];
  } | null;
}

export function openingTime(minute: number): string {
  const clock = OPENING_MINUTE + Math.round(minute);
  return `${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
}

export function openingPnlAfterCost(pnl: number, roundTripCost: number): number;
export function openingPnlAfterCost(pnl: number | null, roundTripCost: number): number | null;
export function openingPnlAfterCost(pnl: number | null, roundTripCost: number): number | null {
  return pnl == null ? null : pnl - roundTripCost;
}

export function openingSummaryAfterCost(
  day: OpeningDaySummary,
  roundTripCost: number,
): OpeningDaySummary {
  if (roundTripCost === 0) return day;
  return {
    ...day,
    close: openingPnlAfterCost(day.close, roundTripCost),
    best: { ...day.best, pnl: openingPnlAfterCost(day.best.pnl, roundTripCost) },
    worst: { ...day.worst, pnl: openingPnlAfterCost(day.worst.pnl, roundTripCost) },
  };
}

export function openingPnlInUnit(
  pnl: number | null,
  entryCredit: number,
  unit: OpeningUnit,
): number | null {
  return pnl == null || unit === 'rupees'
    ? pnl
    : entryCredit > 0
      ? (100 * pnl) / entryCredit
      : null;
}

const AMOUNT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

export const plainAmount = (value: number | null | undefined) =>
  value == null ? '—' : AMOUNT.format(value);

export function formatPnl(value: number | null | undefined, unit: OpeningUnit): string {
  if (value == null) return '—';
  return unit === 'rupees'
    ? `${value < 0 ? '−' : ''}₹${AMOUNT.format(Math.abs(value))}`
    : `${AMOUNT.format(value)}%`;
}
