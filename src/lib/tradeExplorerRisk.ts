import { quantile, riskFlags, RISK_SIGNS, type DayRow } from './tradeExplorer';
import type { Outcome } from './tradeExplorerSplits';

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const share = (part: number, total: number) => (total ? part / total : null);

export function riskOutcomes(rows: DayRow[], outcome: Outcome): number[] {
  return rows.map((row) => row.values[outcome]).filter(isNumber);
}

function aboveShare(rows: DayRow[], outcome: Outcome, line: number): number | null {
  const values = riskOutcomes(rows, outcome);
  return share(values.filter((value) => value > line).length, values.length);
}

export interface LadderRow {
  label: string;
  rows: DayRow[];
  days: number;
  above: number | null;
  median: number | null;
  oneInTen: number | null;
  touched: number | null;
}

export function riskLadder(rows: DayRow[], outcome: Outcome, line: number): LadderRow[] {
  const eligible = rows.filter(
    (row) => isNumber(row.values[outcome]) && isNumber(row.values.warnCount),
  );
  const groups = [0, 1, 2, 3, 4].map((count) => ({
    label: count === 1 ? '1 sign' : `${count} signs`,
    rows: eligible.filter((row) => row.values.warnCount === count),
  }));
  groups.push({
    label: '3 or more',
    rows: eligible.filter((row) => row.values.warnCount === 3 || row.values.warnCount === 4),
  });
  return groups.map(({ label, rows }) => {
    const values = riskOutcomes(rows, outcome);
    return {
      label,
      rows,
      days: rows.length,
      above: share(values.filter((value) => value > line).length, values.length),
      median: quantile(values, 0.5),
      oneInTen: quantile(values, 0.9),
      touched: share(rows.filter((row) => row.values.touched === 'Yes').length, rows.length),
    };
  });
}

export interface SignRow {
  id: string;
  label: string;
  cut: number | null;
  days: number;
  aboveWith: number | null;
  aboveWithout: number | null;
  rows: DayRow[];
}

export function riskSignTable(
  rows: DayRow[],
  outcome: Outcome,
  line: number,
  cuts: Record<string, number | null>,
): SignRow[] {
  const readings = rows.map((row) => ({ row, flags: riskFlags(row, cuts) }));
  return RISK_SIGNS.map(({ id, label }, index) => {
    const withSign = readings.filter(({ flags }) => flags[index]).map(({ row }) => row);
    const withoutSign = readings.filter(({ flags }) => !flags[index]).map(({ row }) => row);
    return {
      id,
      label,
      cut: cuts[id] ?? null,
      days: withSign.length,
      aboveWith: aboveShare(withSign, outcome, line),
      aboveWithout: aboveShare(withoutSign, outcome, line),
      rows: withSign,
    };
  });
}

export interface YearRow {
  year: string;
  days: number;
  flagged: number;
  flaggedAbove: number;
  flaggedBelow: number;
  restAbove: number | null;
  allAbove: number | null;
}

export function ruleYears(
  allRows: DayRow[],
  flagged: ReadonlySet<string>,
  outcome: Outcome,
  line: number,
): YearRow[] {
  const years = new Map<string, DayRow[]>();
  for (const row of allRows) {
    const year = row.raw.date.slice(0, 4);
    const group = years.get(year);
    if (group) group.push(row);
    else years.set(year, [row]);
  }
  const summarize = (year: string, rows: DayRow[]): YearRow => {
    const tested = rows.filter((row) => flagged.has(row.raw.date));
    const rest = rows.filter((row) => !flagged.has(row.raw.date));
    const countAbove = (days: DayRow[]) =>
      riskOutcomes(days, outcome).filter((value) => value > line).length;
    const flaggedAbove = countAbove(tested);
    return {
      year,
      days: rows.length,
      flagged: tested.length,
      flaggedAbove,
      flaggedBelow: tested.length - flaggedAbove,
      restAbove: share(countAbove(rest), rest.length),
      allAbove: share(countAbove(rows), rows.length),
    };
  };
  return [
    ...[...years.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([year, days]) => summarize(year, days)),
    summarize('All years', allRows),
  ];
}
