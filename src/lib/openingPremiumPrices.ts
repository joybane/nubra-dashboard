import {
  OPENING_SESSION_MINUTES,
  openingTime,
  type OpeningDaySummary,
  type OpeningGrid,
  type OpeningSource,
} from './openingStrangle';
import type { SignalUnderlying } from './signalBacktest';

export interface ArchivedOpeningPrices {
  ok: boolean;
  underlying: SignalUnderlying;
  date: string;
  source: OpeningSource;
  expiry: string;
  legs: { entryTime: string; ceStrike: number; peStrike: number };
  ce: OpeningGrid;
  pe: OpeningGrid;
}

export interface OpeningPremiumPrices {
  call: OpeningGrid;
  put: OpeningGrid;
}

type OpeningPriceReplay = Pick<
  OpeningDaySummary,
  'date' | 'source' | 'expiry' | 'entry' | 'ceStrike' | 'peStrike' | 'ceEntry' | 'peEntry'
>;

function isCloseGrid(values: unknown): values is OpeningGrid {
  return (
    Array.isArray(values) &&
    values.length === OPENING_SESSION_MINUTES &&
    values.every((value) => value === null || Number.isFinite(value))
  );
}

export function matchOpeningPremiumPrices(
  archive: ArchivedOpeningPrices | undefined,
  underlying: SignalUnderlying,
  day: OpeningPriceReplay,
): OpeningPremiumPrices | undefined {
  if (
    archive?.ok !== true ||
    archive.underlying !== underlying ||
    archive.date !== day.date ||
    archive.source !== day.source ||
    archive.expiry !== day.expiry ||
    archive.legs?.entryTime !== openingTime(day.entry) ||
    archive.legs.ceStrike !== day.ceStrike ||
    archive.legs.peStrike !== day.peStrike ||
    !isCloseGrid(archive.ce) ||
    !isCloseGrid(archive.pe) ||
    archive.ce[day.entry] !== day.ceEntry ||
    archive.pe[day.entry] !== day.peEntry
  )
    return undefined;

  return { call: archive.ce, put: archive.pe };
}
