import {
  OPENING_DTE_GROUPS,
  openingPnlAfterCost,
  openingPnlInUnit,
  type OpeningAttribution,
  type OpeningDay,
  type OpeningDayMetadata,
  type OpeningDaySummary,
  type OpeningDteGroup,
  type OpeningFilters,
  type OpeningGrid,
  type OpeningGroup,
  type OpeningStudy,
  type OpeningUnit,
} from '../../src/lib/openingStrangle.ts';
import type { SignalUnderlying } from '../../src/lib/signalBacktest.ts';
import {
  blackScholes,
  forwardFromParity,
  impliedVolatility,
  RISK_FREE,
} from '../../src/lib/GexService.ts';
import { LOT_SIZE } from '../signalBacktest/trade.ts';
import { DEFAULT_FINDER_PARAMS, pickLegs, type DayLegs } from './caseFinder.ts';
import {
  emptyGrid,
  minuteIndex,
  round2,
  SESSION_BARS,
  SESSION_OPEN_MIN,
  type DaySeries,
} from './daySeries.ts';

const CLOSE = SESSION_BARS - 1;
export const OPENING_CHECKPOINTS = [45, 105, 165, 225, 285, 345, CLOSE];

export function openingDteGroup(dte: number): OpeningDteGroup {
  return OPENING_DTE_GROUPS[Math.min(dte, 5)];
}

export interface OpeningReplay {
  summary: OpeningDaySummary;
  pnl: OpeningGrid;
  checkpoints: Array<OpeningAttribution | null>;
  entryIvSkew: number | null;
}

interface PricingMark {
  forward: number;
  time: number;
  ceIv: number | null;
  peIv: number | null;
}

const ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

/** The opening study reprices through the last mark, one minute before expiry settlement. */
export function openingYearsToExpiry(date: string, expiry: string, minute: number): number {
  const markMs = Date.parse(`${date}T00:00:00Z`) + (SESSION_OPEN_MIN + minute) * 60_000;
  const expiryMs = Date.parse(`${expiry}T00:00:00Z`) + (SESSION_OPEN_MIN + SESSION_BARS) * 60_000;
  // Both timestamps are IST clock labels, so their common offset cancels in the difference.
  return Math.max(0, (expiryMs - markMs) / 86_400_000) / 365;
}

function openingForwardAt(day: DaySeries, minute: number, time: number): number | null {
  const spot = day.spot[minute];
  if (spot == null || !(spot > 0)) return null;
  let closest: { strike: number; ce: number; pe: number; gap: number } | undefined;
  for (const key of Object.keys(day.ce)) {
    const ce = day.ce[key][minute];
    const pe = day.pe[key]?.[minute];
    if (ce == null || pe == null || !(ce > 0) || !(pe > 0)) continue;
    const strike = Number(key);
    const gap = Math.abs(strike - spot);
    if (gap < (closest?.gap ?? Infinity)) closest = { strike, ce, pe, gap };
  }
  return closest
    ? forwardFromParity(closest.strike, closest.ce, closest.pe, RISK_FREE, time)
    : spot;
}

function pricingMark(
  day: DaySeries,
  minute: number,
  ceStrike: number,
  peStrike: number,
  ce: number | null,
  pe: number | null,
): PricingMark | null {
  const time = openingYearsToExpiry(day.date, day.expiry, minute);
  const forward = openingForwardAt(day, minute, time);
  if (forward == null || !(forward > 0) || !(time > 0)) return null;
  const iv = (price: number | null, strike: number, side: 'CE' | 'PE') => {
    if (price == null) return null;
    const value = impliedVolatility(price, forward, strike, time, RISK_FREE, side);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return { forward, time, ceIv: iv(ce, ceStrike, 'CE'), peIv: iv(pe, peStrike, 'PE') };
}

function meanIv(mark: PricingMark | null): number | null {
  return mark?.ceIv != null && mark.peIv != null ? 50 * (mark.ceIv + mark.peIv) : null;
}

type EntryMeasurements = Pick<
  OpeningDaySummary,
  'entrySpot' | 'ceStrike' | 'peStrike' | 'ceEntry' | 'peEntry' | 'entryCredit' | 'entryIv'
> & { ivSkew: number | null };

function measureEntry(
  legs: DayLegs,
  quantity: number,
  mark: PricingMark | null,
): EntryMeasurements {
  const { entrySpot, ceStrike, peStrike, ceEntry, peEntry } = legs;
  return {
    entrySpot,
    ceStrike,
    peStrike,
    ceEntry,
    peEntry,
    entryCredit: round2((ceEntry + peEntry) * quantity),
    entryIv: meanIv(mark),
    ivSkew: mark?.ceIv != null && mark.peIv != null ? 100 * (mark.ceIv - mark.peIv) : null,
  };
}

/** Read the opening inputs needed to warm the research history without replaying the session. */
export function readOpeningResearchEntry(
  day: DaySeries,
  underlying: SignalUnderlying,
): EntryMeasurements | null {
  const legs = pickLegs(day, DEFAULT_FINDER_PARAMS);
  if (typeof legs === 'string') return null;
  const minute = minuteIndex(legs.entryTime);
  return measureEntry(
    legs,
    LOT_SIZE[underlying],
    pricingMark(day, minute, legs.ceStrike, legs.peStrike, legs.ceEntry, legs.peEntry),
  );
}

function attributeLeg(
  entry: readonly [number, number, number],
  target: readonly [number, number, number],
  strike: number,
  side: 'CE' | 'PE',
  quantity: number,
): number[] {
  const [startForward, startTime, startIv] = entry;
  const base = blackScholes(startForward, strike, startTime, RISK_FREE, startIv, side).price;
  const contribution = [0, 0, 0];
  for (const order of ORDERS) {
    const inputs = [...entry];
    let last = base;
    for (const factor of order) {
      inputs[factor] = target[factor];
      const [forward, time, iv] = inputs;
      const price = blackScholes(forward, strike, time, RISK_FREE, iv, side).price;
      contribution[factor] += ((last - price) * quantity) / ORDERS.length;
      last = price;
    }
  }
  return contribution;
}

function attributeMark(
  start: PricingMark | null,
  end: PricingMark | null,
  actual: number | null,
  ceStrike: number,
  peStrike: number,
  quantity: number,
): OpeningAttribution | null {
  if (
    start?.ceIv == null ||
    start.peIv == null ||
    end?.ceIv == null ||
    end.peIv == null ||
    actual == null
  )
    return null;
  const call = attributeLeg(
    [start.forward, start.time, start.ceIv],
    [end.forward, end.time, end.ceIv],
    ceStrike,
    'CE',
    quantity,
  );
  const put = attributeLeg(
    [start.forward, start.time, start.peIv],
    [end.forward, end.time, end.peIv],
    peStrike,
    'PE',
    quantity,
  );
  const [forward, time, iv] = call.map((value, i) => value + put[i]);
  return { forward, time, iv, residual: actual - (forward + time + iv), actual };
}

export function replayOpeningStrangle(
  day: DaySeries,
  metadata: OpeningDayMetadata,
  underlying: SignalUnderlying,
  options: { onTimeOnly?: boolean; detail: true },
): OpeningDay | string;
export function replayOpeningStrangle(
  day: DaySeries,
  metadata: OpeningDayMetadata,
  underlying: SignalUnderlying,
  options?: { onTimeOnly?: boolean; detail?: false },
): OpeningReplay | string;
export function replayOpeningStrangle(
  day: DaySeries,
  metadata: OpeningDayMetadata,
  underlying: SignalUnderlying,
  { onTimeOnly, detail }: { onTimeOnly?: boolean; detail?: boolean } = {},
): OpeningDay | OpeningReplay | string {
  const legs = pickLegs(day, DEFAULT_FINDER_PARAMS);
  if (typeof legs === 'string') return legs;
  const entry = minuteIndex(legs.entryTime);
  if (onTimeOnly && entry !== 0) return `09:15 prices unavailable (first entry ${legs.entryTime})`;

  const { ceStrike, peStrike, ceEntry, peEntry, entrySpot } = legs;
  const call = day.ce[String(ceStrike)];
  const put = day.pe[String(peStrike)];
  const quantity = LOT_SIZE[underlying];
  const cePnl = emptyGrid();
  const pePnl = emptyGrid();
  const pnl = emptyGrid();
  let best = { minute: entry, pnl: 0 };
  let worst = { minute: entry, pnl: 0 };
  let drawdown = 0;
  let marked = 0;
  let lastMarked = entry;
  let spotMove: number | null = null;
  let spotGap = false;
  let touchedCall = false;
  let touchedPut = false;
  for (let i = entry; i < SESSION_BARS; i++) {
    const spot = day.spot[i];
    if (spot == null) spotGap = true;
    else {
      spotMove = Math.max(spotMove ?? 0, (100 * Math.abs(spot - entrySpot)) / entrySpot);
      touchedCall ||= spot >= ceStrike;
      touchedPut ||= spot <= peStrike;
    }
    const ce = call[i] == null ? null : round2((ceEntry - call[i]!) * quantity);
    const pe = put[i] == null ? null : round2((peEntry - put[i]!) * quantity);
    cePnl[i] = ce;
    pePnl[i] = pe;
    if (ce == null || pe == null) continue;
    const value = round2(ce + pe);
    pnl[i] = value;
    if (value > best.pnl) best = { minute: i, pnl: value };
    if (value < worst.pnl) worst = { minute: i, pnl: value };
    drawdown = Math.max(drawdown, best.pnl - value);
    marked++;
    lastMarked = i;
  }
  if (marked === 1) return 'No minute after entry has prices for both legs.';

  const modelAt = (i: number) => pricingMark(day, i, ceStrike, peStrike, call[i], put[i]);
  const entryModel = modelAt(entry);
  const closeModel = modelAt(CLOSE);
  const { ivSkew: entryIvSkew, ...entryMeasurements } = measureEntry(legs, quantity, entryModel);
  const closeIv = meanIv(closeModel);
  const summary: OpeningDaySummary = {
    ...metadata,
    ...entryMeasurements,
    entry,
    quantity,
    spotMove,
    ivChange:
      closeIv == null || entryMeasurements.entryIv == null
        ? null
        : closeIv - entryMeasurements.entryIv,
    touch:
      touchedCall && touchedPut
        ? 'Both'
        : spotGap
          ? null
          : touchedCall
            ? 'Call'
            : touchedPut
              ? 'Put'
              : 'Neither',
    close: pnl[CLOSE],
    best,
    worst,
    drawdown: round2(drawdown),
    marked,
    possible: SESSION_BARS - entry,
    lastMarked,
  };
  const attributionAt = (i: number, model: PricingMark | null) =>
    attributeMark(entryModel, model, pnl[i], ceStrike, peStrike, quantity);

  if (!detail) {
    return {
      summary,
      pnl,
      entryIvSkew,
      checkpoints: OPENING_CHECKPOINTS.map((i) =>
        pnl[i] == null ? null : attributionAt(i, i === CLOSE ? closeModel : modelAt(i)),
      ),
    };
  }

  const ceIv = emptyGrid();
  const peIv = emptyGrid();
  const attribution: OpeningDay['attribution'] = Array.from({ length: SESSION_BARS }, () => null);
  for (let i = entry; i < SESSION_BARS; i++) {
    const model = i === entry ? entryModel : i === CLOSE ? closeModel : modelAt(i);
    if (!model) continue;
    ceIv[i] = model.ceIv == null ? null : 100 * model.ceIv;
    peIv[i] = model.peIv == null ? null : 100 * model.peIv;
    attribution[i] = attributionAt(i, model);
  }
  return {
    summary,
    spot: Array.from({ length: SESSION_BARS }, (_, i) => day.spot[i] ?? null),
    cePnl,
    pePnl,
    pnl,
    ceIv,
    peIv,
    attribution,
  };
}

function fromSorted(values: number[], p: number): number | null {
  if (!values.length) return null;
  const i = (values.length - 1) * p;
  const lo = Math.floor(i);
  return values[lo] + (values[Math.ceil(i)] - values[lo]) * (i - lo);
}

const sortedNumbers = (values: Array<number | null>) =>
  values.filter((value): value is number => value != null).sort((a, b) => a - b);

function group(
  label: string,
  rows: OpeningReplay[],
  { unit, roundTripCost = 0 }: Pick<OpeningFilters, 'unit' | 'roundTripCost'>,
): OpeningGroup {
  const amount = (value: number | null, r: OpeningReplay) =>
    openingPnlInUnit(value, r.summary.entryCredit, unit);
  const netAmount = (value: number | null, r: OpeningReplay) =>
    amount(openingPnlAfterCost(value, roundTripCost), r);
  const closes = sortedNumbers(rows.map((r) => netAmount(r.summary.close, r)));
  const curve = Array.from({ length: SESSION_BARS }, (_, i) => {
    const values = sortedNumbers(rows.map((r) => netAmount(r.pnl[i], r)));
    return {
      n: values.length,
      p10: fromSorted(values, 0.1),
      median: fromSorted(values, 0.5),
      p90: fromSorted(values, 0.9),
    };
  });
  return {
    label,
    dates: rows.map((r) => r.summary.date),
    n: rows.length,
    closeN: closes.length,
    medianCredit: fromSorted(sortedNumbers(rows.map((r) => r.summary.entryCredit)), 0.5),
    medianClose: fromSorted(closes, 0.5),
    p10Close: fromSorted(closes, 0.1),
    profitableClosePct: closes.length
      ? (100 * closes.filter((v) => v > 0).length) / closes.length
      : null,
    medianDrawdown: fromSorted(sortedNumbers(rows.map((r) => amount(r.summary.drawdown, r))), 0.5),
    curve,
  };
}

function checkpointStats(rows: OpeningReplay[], unit: OpeningUnit) {
  return OPENING_CHECKPOINTS.map((minute, index) => {
    const sum: OpeningAttribution = { forward: 0, time: 0, iv: 0, residual: 0, actual: 0 };
    let observed = 0;
    let n = 0;
    for (const r of rows) {
      const factor = openingPnlInUnit(1, r.summary.entryCredit, unit);
      if (factor == null) continue;
      if (r.pnl[minute] != null) observed++;
      const mark = r.checkpoints[index];
      if (mark == null) continue;
      for (const key of ['forward', 'time', 'iv', 'residual', 'actual'] as const)
        sum[key] += mark[key] * factor;
      n++;
    }
    return {
      minute,
      observed,
      n,
      mean: n
        ? {
            forward: sum.forward / n,
            time: sum.time / n,
            iv: sum.iv / n,
            residual: sum.residual / n,
            actual: sum.actual / n,
          }
        : null,
    };
  });
}

function driverStudy(rows: OpeningReplay[], filters: OpeningFilters): OpeningStudy['driver'] {
  const { driver: name, dte } = filters;
  if (!name || !dte) return null;
  const cohort = rows.filter((r) => r.summary.dteGroup === dte);
  if (name === 'touch') {
    return {
      name,
      dte,
      cutoffs: null,
      missing: cohort.filter((r) => r.summary.touch == null).length,
      groups: (['Neither', 'Call', 'Put', 'Both'] as const).map((label) =>
        group(
          label,
          cohort.filter((r) => r.summary.touch === label),
          filters,
        ),
      ),
    };
  }
  const values = sortedNumbers(cohort.map((r) => r.summary[name]));
  const low = fromSorted(values, 1 / 3);
  const high = fromSorted(values, 2 / 3);
  const groups: OpeningReplay[][] = [[], [], []];
  if (low != null && high != null) {
    for (const r of cohort) {
      const value = r.summary[name];
      if (value != null) groups[value <= low ? 0 : value <= high ? 1 : 2].push(r);
    }
  }
  return {
    name,
    dte,
    cutoffs: low == null || high == null ? null : [low, high],
    missing: cohort.length - values.length,
    groups: ['Low', 'Middle', 'High'].map((label, i) => group(label, groups[i], filters)),
  };
}

export function summarizeOpeningStrangles(rows: OpeningReplay[], filters: OpeningFilters) {
  const groups = OPENING_DTE_GROUPS.map((dte) => {
    const cohort = rows.filter((r) => r.summary.dteGroup === dte);
    return {
      ...group(`${dte} DTE`, cohort, filters),
      dte,
      attribution: checkpointStats(cohort, filters.unit),
    };
  });
  return { groups, driver: driverStudy(rows, filters) };
}
