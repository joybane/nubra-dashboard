import {
  OPENING_MINUTE,
  openingPnlInUnit,
  type OpeningDaySummary,
  type OpeningDteGroup,
  type OpeningUnit,
} from './openingStrangle';

export type OpeningSort = 'date' | 'close' | 'worst' | 'drawdown';
type Direction = 'asc' | 'desc';

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}

const sorted = (values: Array<number | null>) =>
  values.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);

const share = (numerator: number, denominator: number): number | null =>
  denominator ? (100 * numerator) / denominator : null;

export function openingOutcome(rows: OpeningDaySummary[], unit: OpeningUnit) {
  const close = sorted(rows.map((day) => openingPnlInUnit(day.close, day.entryCredit, unit)));
  const worst = sorted(rows.map((day) => openingPnlInUnit(day.worst.pnl, day.entryCredit, unit)));
  const drawdown = sorted(rows.map((day) => openingPnlInUnit(day.drawdown, day.entryCredit, unit)));
  const exactCloses = rows.filter((day) => day.close != null).length;
  return {
    sessions: rows.length,
    exactCloses,
    closeN: close.length,
    pathN: worst.length,
    medianClose: percentile(close, 0.5),
    p10Close: percentile(close, 0.1),
    profitablePct: share(
      rows.filter((day) => day.close != null && day.close > 0).length,
      exactCloses,
    ),
    medianWorst: percentile(worst, 0.5),
    medianDrawdown: percentile(drawdown, 0.5),
    p90Drawdown: percentile(drawdown, 0.9),
  };
}

export function sortOpeningDays(
  days: OpeningDaySummary[],
  key: OpeningSort,
  direction: Direction,
  unit: OpeningUnit,
) {
  if (key === 'date') {
    return [...days].sort((a, b) =>
      direction === 'asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date),
    );
  }
  const ranked = days.map((day) => {
    const raw = key === 'worst' ? day.worst.pnl : day[key];
    return { day, value: openingPnlInUnit(raw, day.entryCredit, unit) };
  });
  ranked.sort((a, b) => {
    if (a.value != null && b.value != null && a.value !== b.value) {
      return direction === 'asc' ? a.value - b.value : b.value - a.value;
    }
    if (a.value == null && b.value != null) return 1;
    if (a.value != null && b.value == null) return -1;
    return b.day.date.localeCompare(a.day.date);
  });
  return ranked.map(({ day }) => day);
}

export function summarizeOpeningReport(days: OpeningDaySummary[], unit: OpeningUnit) {
  const byYear = new Map<string, OpeningDaySummary[]>();
  const lossHours = Array.from({ length: 7 }, (_, i) => ({ hour: 9 + i, count: 0 }));
  const cutoffs = unit === 'rupees' ? [500, 1000, 2500, 5000, 10000, 25000] : [25, 50, 100, 200];
  const bands = Array.from({ length: cutoffs.length + 2 }, (_, i) => ({
    low: i <= 1 ? 0 : cutoffs[i - 2],
    high: i === 0 ? 0 : (cutoffs[i - 1] ?? null),
    worst: 0,
    drawdown: 0,
  }));
  const bandIndex = (amount: number) => {
    if (amount === 0) return 0;
    const i = cutoffs.findIndex((limit) => amount < limit);
    return i === -1 ? bands.length - 1 : i + 1;
  };
  const lossDays = days.filter((day) => day.worst.pnl < 0);
  for (const day of days) {
    const year = day.date.slice(0, 4);
    const rows = byYear.get(year) ?? [];
    rows.push(day);
    byYear.set(year, rows);
    if (day.worst.pnl < 0) {
      const hour = Math.floor((OPENING_MINUTE + day.worst.minute) / 60);
      lossHours[hour - 9].count++;
    }
    const worst = openingPnlInUnit(-day.worst.pnl, day.entryCredit, unit);
    const drawdown = openingPnlInUnit(day.drawdown, day.entryCredit, unit);
    if (worst != null) bands[bandIndex(worst)].worst++;
    if (drawdown != null) bands[bandIndex(drawdown)].drawdown++;
  }
  const thresholds = [25, 50, 100].map((percent) => {
    const threshold = (day: OpeningDaySummary) => -(day.entryCredit * percent) / 100;
    const reached = days.filter((day) => day.entryCredit > 0 && day.worst.pnl <= threshold(day));
    const closed = reached.filter((day) => day.close != null);
    const recovered = closed.filter((day) => day.close! > threshold(day)).length;
    const positive = closed.filter((day) => day.close! > 0).length;
    return {
      percent,
      reached: reached.length,
      closeN: closed.length,
      recovered,
      positive,
      recoveredPct: share(recovered, closed.length),
      positivePct: share(positive, closed.length),
    };
  });
  return {
    ...openingOutcome(days, unit),
    missingCredit: days.filter((day) => day.entryCredit <= 0).length,
    lossN: lossDays.length,
    bands,
    lossHours,
    thresholds,
    years: [...byYear.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([year, rows]) => ({
        year,
        ...openingOutcome(rows, unit),
      })),
    worstDays: sortOpeningDays(lossDays, 'worst', 'asc', unit)
      .filter((day) => openingPnlInUnit(day.worst.pnl, day.entryCredit, unit) != null)
      .slice(0, 12),
  };
}

export function compareOpeningIv(
  days: OpeningDaySummary[],
  dte: OpeningDteGroup,
  unit: OpeningUnit,
) {
  const cohort = days.filter((day) => day.dteGroup === dte);
  const moves = sorted(cohort.map((day) => day.spotMove));
  const low = percentile(moves, 1 / 3);
  const high = percentile(moves, 2 / 3);
  const groups: OpeningDaySummary[][] = [[], [], []];
  if (low != null && high != null) {
    for (const day of cohort) {
      if (day.spotMove == null) continue;
      groups[day.spotMove <= low ? 0 : day.spotMove <= high ? 1 : 2].push(day);
    }
  }
  const strata = groups.map((rows, i) => ({
    label: ['Low', 'Middle', 'High'][i],
    fell: openingOutcome(
      rows.filter((day) => day.ivChange != null && day.ivChange < 0),
      unit,
    ),
    rose: openingOutcome(
      rows.filter((day) => day.ivChange != null && day.ivChange > 0),
      unit,
    ),
  }));
  return {
    dte,
    low,
    high,
    strata,
    missing: cohort.filter((day) => day.spotMove == null || day.ivChange == null).length,
    unchanged: cohort.filter((day) => day.spotMove != null && day.ivChange === 0).length,
  };
}
