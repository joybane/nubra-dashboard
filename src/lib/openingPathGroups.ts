import {
  OPENING_SESSION_MINUTES,
  type OpeningDaySummary,
  type OpeningGrid,
} from './openingStrangle';

export const OPENING_MOVE_CUTOFF = 25;
export const OPENING_MOVE_COVERAGE = 90;
const CLOSE = OPENING_SESSION_MINUTES - 1;

type OpeningPathDay = Pick<OpeningDaySummary, 'entry' | 'entryCredit' | 'close'>;

export type OpeningPathIssue =
  'missingClose' | 'lowCoverage' | 'unavailablePath' | 'invalidEntry' | 'nonpositiveCredit';

export type OpeningPathGroup =
  | 'roseHeld'
  | 'fellStayed'
  | 'fellRecoveredNonnegative'
  | 'fellRecoveredNegative'
  | 'roseFadedPositive'
  | 'roseFadedNonpositive'
  | 'swings'
  | 'small'
  | 'insufficient';

export function validOpeningMoveCutoff(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validEntry(entry: number) {
  return Number.isInteger(entry) && entry >= 0 && entry <= CLOSE;
}

function positiveCredit(credit: number) {
  return Number.isFinite(credit) && credit > 0;
}

function observedMark(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value);
}

function enoughCoverage(observed: number, possible: number) {
  return observed * 100 >= possible * OPENING_MOVE_COVERAGE;
}

/** Inspect an excluded session without filling minute gaps or substituting a closing mark. */
export function diagnoseOpeningPath(day: OpeningPathDay, pnl: OpeningGrid | undefined) {
  const { entry, entryCredit } = day;
  const entryValid = validEntry(entry);
  let coverage:
    { observed: number; possible: number; lastCompleteMinute: number | null } | undefined;
  if (entryValid && pnl) {
    let observed = 0;
    let lastCompleteMinute: number | null = null;
    for (let minute = entry; minute <= CLOSE; minute++) {
      if (!observedMark(pnl[minute])) continue;
      observed++;
      lastCompleteMinute = minute;
    }
    coverage = { observed, possible: CLOSE - entry + 1, lastCompleteMinute };
  }
  const issues: OpeningPathIssue[] = [];
  if (!observedMark(day.close) || (pnl && !observedMark(pnl[CLOSE]))) issues.push('missingClose');
  if (coverage && !enoughCoverage(coverage.observed, coverage.possible)) issues.push('lowCoverage');
  if (!pnl || coverage?.observed === 0) issues.push('unavailablePath');
  if (!entryValid) issues.push('invalidEntry');
  if (!positiveCredit(entryCredit)) issues.push('nonpositiveCredit');
  return { issues, coverage };
}

/** Classify the gross P&L path from the actual entry, using premium as the common denominator. */
export function classifyOpeningPath(
  day: OpeningPathDay,
  pnl: OpeningGrid | undefined,
  cutoff: number,
): OpeningPathGroup {
  const close = pnl?.[CLOSE];
  const { entry, entryCredit } = day;
  if (
    !pnl ||
    !validEntry(entry) ||
    !positiveCredit(entryCredit) ||
    !observedMark(close) ||
    !observedMark(day.close) ||
    !validOpeningMoveCutoff(cutoff)
  )
    return 'insufficient';

  let observed = 0;
  let trough = Infinity;
  let peak = -Infinity;
  let zone = 0;
  let transitions = 0;
  for (let minute = entry; minute <= CLOSE; minute++) {
    const mark = pnl[minute];
    if (!observedMark(mark)) continue;
    observed++;
    const move = (100 * mark) / entryCredit;
    trough = Math.min(trough, move);
    peak = Math.max(peak, move);
    const nextZone = move >= cutoff ? 1 : move <= -cutoff ? -1 : 0;
    if (nextZone !== 0 && nextZone !== zone) {
      if (zone !== 0) transitions++;
      zone = nextZone;
    }
  }
  if (!enoughCoverage(observed, CLOSE - entry + 1)) return 'insufficient';
  if (transitions >= 2) return 'swings';
  const recovered = close >= 0 ? 'fellRecoveredNonnegative' : 'fellRecoveredNegative';
  const faded = close > 0 ? 'roseFadedPositive' : 'roseFadedNonpositive';
  if (transitions === 1) return zone === 1 ? recovered : faded;

  const final = (100 * close) / entryCredit;
  if (zone === -1)
    return final - trough >= Math.max(cutoff, -trough / 2) ? recovered : 'fellStayed';
  if (zone === 1) return peak - final >= Math.max(cutoff, peak / 2) ? faded : 'roseHeld';
  return 'small';
}
