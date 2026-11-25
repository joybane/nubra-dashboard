import { useId, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  OPENING_SESSION_MINUTES,
  OPENING_DTE_GROUPS,
  formatPnl,
  openingPnlAfterCost,
  openingPnlInUnit,
  openingTime,
  type OpeningDaySummary,
  type OpeningDteGroup,
  type OpeningResearchRow,
  type OpeningStudy,
} from '../lib/openingStrangle';
import { analyzeOpeningEntryRules } from '../lib/openingResearch';
import { clusterOpeningCurves, type OpeningCurveSubgroup } from '../lib/openingCurveClusters';
import {
  OPENING_MOVE_COVERAGE,
  classifyOpeningPath,
  diagnoseOpeningPath,
  validOpeningMoveCutoff,
  type OpeningPathGroup,
  type OpeningPathIssue,
} from '../lib/openingPathGroups';
import { OpeningChartCard } from './OpeningStrangleCharts';
import OpeningStrangleEntryResearch from './OpeningStrangleEntryResearch';
import OpeningStrangleFindings from './OpeningStrangleFindings';
import OpeningStrangleOverlay, {
  openingOverlayExtent,
  type OpeningOverlayPath,
  type OpeningOverlayRange,
} from './OpeningStrangleOverlay';
import type { OpeningTradeActions } from './OpeningStrangleTrades';
import {
  OpeningCurveFindings,
  OpeningCurveGroupingMethod,
  OpeningKnownAtEntry,
  OpeningProfitFindings,
  OpeningStudyMethod,
  OpeningStudyOverview,
  OpeningValidationFindings,
} from './OpeningStrangleStudyText';

const CLOSING_GROUPS = [
  { key: 'largeLoss', label: 'Large losses', color: '#e75b72' },
  { key: 'loss', label: 'Smaller losses', color: '#e69a57' },
  { key: 'flat', label: 'Flat', color: '#a293ba' },
  { key: 'gain', label: 'Smaller gains', color: '#59abc8' },
  { key: 'largeGain', label: 'Large gains', color: '#52ce95' },
  { key: 'missing', label: 'Unclassified', color: '#8190a7' },
] as const;

const CURVE_GROUPS: Array<{ key: OpeningPathGroup; label: string; color: string }> = [
  { key: 'roseHeld', label: 'Rose and held gains', color: '#52ce95' },
  { key: 'fellStayed', label: 'Fell and stayed down', color: '#e75b72' },
  {
    key: 'fellRecoveredNonnegative',
    label: 'Fell, recovered to break-even or better',
    color: '#59abc8',
  },
  { key: 'fellRecoveredNegative', label: 'Fell, partly recovered', color: '#6e83df' },
  { key: 'roseFadedPositive', label: 'Rose, gave back some gains', color: '#e69a57' },
  { key: 'roseFadedNonpositive', label: 'Rose, gave back all gains', color: '#ce72af' },
  { key: 'swings', label: 'Back-and-forth swings', color: '#b586da' },
  { key: 'small', label: 'Small move', color: '#c7b779' },
  { key: 'insufficient', label: 'Insufficient data', color: '#8190a7' },
];

type ClosingGroup = (typeof CLOSING_GROUPS)[number]['key'];
type GroupKey = ClosingGroup | OpeningPathGroup;

export interface OpeningHistoryControls {
  grouping: 'curve' | 'close';
  dte: 'all' | OpeningDteGroup;
  selected?: GroupKey;
  subgroup?: { scope: string; representative: string };
  moveCutoff: number;
  moveDraft: string;
  lossThreshold: string;
  gainThreshold: string;
  fitGroupCharts?: boolean;
}

const INPUT =
  'w-[5.3rem] rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs tabular-nums';
const BUTTON =
  'rounded border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45';
const CELL = 'whitespace-nowrap border-b border-[var(--border)] px-2 py-1.5 text-right';
const ISSUE_CELL = 'border-b border-[var(--border)] px-1.5 py-1.5';
const LINK = 'text-[var(--accent)] hover:underline';
const PAGE_SIZE = 40;
const SECTIONS = [
  ['overview', 'Overview'],
  ['curves', 'Curve paths'],
  ['group-curves', 'P&L by group'],
  ['groups', 'P&L groups'],
  ['entry', 'Known at entry'],
  ['findings', 'Findings'],
  ['validation', 'Validation'],
  ['method', 'Method and coverage'],
] as const;
const SECTION = 'grid scroll-mt-3 gap-2.5 border-t border-[var(--border)] pt-4';
const HEADING = 'text-[17px] font-semibold';
const PATH_ISSUE_LABELS: Record<OpeningPathIssue, string> = {
  missingClose: 'Missing 15:29 mark',
  lowCoverage: `Below ${OPENING_MOVE_COVERAGE}% coverage`,
  unavailablePath: 'Minute path unavailable',
  invalidEntry: 'Invalid entry minute',
  nonpositiveCredit: 'Invalid or nonpositive opening credit',
};

export interface HistorySource {
  rows?: OpeningResearchRow[];
  loading: boolean;
  snapshotThrough?: string;
  error?: string;
}

function closingGroup(result: number | null, loss: number, gain: number): ClosingGroup {
  if (result == null) return 'missing';
  if (result <= -loss) return 'largeLoss';
  if (result < 0) return 'loss';
  if (result === 0) return 'flat';
  if (result >= gain) return 'largeGain';
  return 'gain';
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x);
  return sorted[lo] + (sorted[Math.ceil(x)] - sorted[lo]) * (x - lo);
}

function interval(paths: OpeningOverlayPath[]): OpeningOverlayRange | undefined {
  if (!paths.length) return undefined;
  const median: Array<number | null> = [];
  const p10: Array<number | null> = [];
  const p90: Array<number | null> = [];
  for (let minute = 0; minute < OPENING_SESSION_MINUTES; minute++) {
    const values = paths.flatMap((path) =>
      path.values[minute] == null ? [] : [path.values[minute]!],
    );
    values.sort((a, b) => a - b);
    median.push(quantile(values, 0.5));
    p10.push(quantile(values, 0.1));
    p90.push(quantile(values, 0.9));
  }
  return { median, p10, p90 };
}

function SimilarCurveGroups({
  subgroups,
  parent,
  cost,
  chosen,
  onChoose,
  open,
}: {
  subgroups: OpeningCurveSubgroup[];
  parent: OpeningDaySummary[];
  cost: number;
  chosen?: string;
  onChoose: (representative?: string) => void;
  open: (date: string) => void;
}) {
  if (!subgroups.length) {
    return (
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        This group has too few sessions or its paths are too similar to split reliably.
      </p>
    );
  }

  const byDate = new Map(parent.map((day) => [day.date, day]));
  return (
    <div className="mt-3 grid gap-2 border-t border-[var(--border)] pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">Similar curves</h4>
        <button
          type="button"
          aria-pressed={!chosen}
          className={`${BUTTON} ${!chosen ? '!border-[var(--accent)]' : ''}`}
          onClick={() => onChoose()}
        >
          All subgroups
        </button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Subgroups compare gross P&L relative to opening credit in 15-minute windows at the same
        clock times. Summary amounts show {cost ? 'net' : 'gross'} rupees per lot. Select a subgroup
        to see its curves and dates.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {subgroups.map(({ representative, dates }, i) => {
          const days = dates.map((date) => byDate.get(date)!);
          const medianOf = (values: number[]) =>
            quantile(
              values.sort((a, b) => a - b),
              0.5,
            )!;
          const low = openingPnlAfterCost(medianOf(days.map(({ worst }) => worst.pnl)), cost);
          const lowTime = openingTime(Math.round(medianOf(days.map(({ worst }) => worst.minute))));
          const high = openingPnlAfterCost(medianOf(days.map(({ best }) => best.pnl)), cost);
          const highTime = openingTime(Math.round(medianOf(days.map(({ best }) => best.minute))));
          const close = openingPnlAfterCost(medianOf(days.map((day) => day.close!)), cost);
          const selected = representative === chosen;
          return (
            <li
              key={representative}
              className="grid gap-1.5 rounded border border-[var(--border)] px-2.5 py-2 text-xs"
            >
              <button
                type="button"
                aria-pressed={selected}
                className={`${BUTTON} justify-self-start ${selected ? '!border-[var(--accent)]' : ''}`}
                onClick={() => onChoose(representative)}
              >
                Subgroup {i + 1} · {dates.length} sessions
              </button>
              <span>
                Median low {formatPnl(low, 'rupees')} at {lowTime} · high{' '}
                {formatPnl(high, 'rupees')} at {highTime} IST
              </span>
              <span>
                Median close {formatPnl(close, 'rupees')} ·{' '}
                <button type="button" className={LINK} onClick={() => open(representative)}>
                  Typical date {representative}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GroupDates({
  days,
  grouping,
  unit,
  cost,
  available,
  open,
  pin,
  pins,
}: OpeningTradeActions & {
  grouping: OpeningHistoryControls['grouping'];
  cost: number;
  available: Map<string, OpeningResearchRow>;
}) {
  const [page, setPage] = useState(0);
  const displayPage = Math.min(page, Math.max(0, Math.ceil(days.length / PAGE_SIZE) - 1));
  const visible = [...days]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(displayPage * PAGE_SIZE, (displayPage + 1) * PAGE_SIZE);
  if (!visible.length)
    return <p className="py-2 text-xs text-[var(--text-muted)]">No sessions in this group.</p>;
  return (
    <>
      <div className="overflow-x-auto">
        <table
          aria-label={
            grouping === 'curve' ? 'Sessions in curve movement group' : 'Sessions in closing group'
          }
          className="w-full text-xs tabular-nums"
        >
          <thead>
            <tr>
              {['Session', 'Entry IST', 'Expiry', '15:29 P&L', 'Minute path', 'Compare'].map(
                (label, i) => (
                  <th scope="col" key={label} className={`${CELL} ${i === 0 ? 'text-left' : ''}`}>
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map((day) => {
              const pinned = pins.includes(day.date);
              return (
                <tr key={day.date}>
                  <th scope="row" className={`${CELL} text-left`}>
                    <button type="button" className={LINK} onClick={() => open(day.date)}>
                      {day.date}
                    </button>
                  </th>
                  <td className={CELL}>{openingTime(day.entry)}</td>
                  <td className={CELL}>
                    {day.expiry} · {day.dte} DTE
                  </td>
                  <td className={CELL}>
                    {formatPnl(
                      openingPnlInUnit(openingPnlAfterCost(day.close, cost), day.entryCredit, unit),
                      unit,
                    )}
                  </td>
                  <td
                    className={`${CELL} ${available.has(day.date) ? '' : 'text-[var(--text-muted)]'}`}
                  >
                    {available.has(day.date)
                      ? `${day.marked}/${day.possible}`
                      : 'Unavailable in history'}
                  </td>
                  <td className={CELL}>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${day.date}`}
                      aria-pressed={pinned}
                      disabled={!pinned && pins.length === 6}
                      onClick={() => pin(day.date)}
                    >
                      {pinned ? 'Unpin' : 'Pin'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span>
          {displayPage * PAGE_SIZE + 1}–{Math.min((displayPage + 1) * PAGE_SIZE, days.length)} of{' '}
          {days.length} sessions
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={displayPage === 0}
            onClick={() => setPage(displayPage - 1)}
          >
            Previous group dates
          </button>
          <button
            type="button"
            className={BUTTON}
            disabled={(displayPage + 1) * PAGE_SIZE >= days.length}
            onClick={() => setPage(displayPage + 1)}
          >
            Next group dates
          </button>
        </div>
      </div>
    </>
  );
}

function InsufficientDataDetails({
  days,
  available,
  open,
}: {
  days: OpeningDaySummary[];
  available: Map<string, OpeningResearchRow>;
  open: (date: string) => void;
}) {
  const rows = useMemo(
    () =>
      days
        .map((day) => ({ day, ...diagnoseOpeningPath(day, available.get(day.date)?.pnl) }))
        .sort((a, b) => b.day.date.localeCompare(a.day.date)),
    [days, available],
  );
  const count = (issue: OpeningPathIssue) =>
    rows.filter(({ issues }) => issues.includes(issue)).length;
  const both = rows.filter(
    ({ issues }) => issues.includes('missingClose') && issues.includes('lowCoverage'),
  ).length;
  const otherIssues = (['unavailablePath', 'invalidEntry', 'nonpositiveCredit'] as const)
    .map((issue) => ({ label: PATH_ISSUE_LABELS[issue], count: count(issue) }))
    .filter((issue) => issue.count > 0);
  const totals = [
    { label: PATH_ISSUE_LABELS.missingClose, count: count('missingClose') },
    { label: PATH_ISSUE_LABELS.lowCoverage, count: count('lowCoverage') },
    { label: 'Both', count: both },
    ...otherIssues,
  ];
  return (
    <div className="mt-2 grid gap-2 border-t border-[var(--border)] pt-2 text-xs">
      <dl className="grid grid-cols-3 gap-2 tabular-nums">
        {totals.map(({ label, count }) => (
          <div key={label}>
            <dt className="text-[var(--text-muted)]">{label}</dt>
            <dd className="font-semibold">{count.toLocaleString('en-IN')}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[var(--text-muted)]">
        Counts overlap. Both counts dates with a missing close and low coverage.
      </p>
      <details>
        <summary className="cursor-pointer font-medium">View affected dates</summary>
        {rows.some(({ coverage }) => !coverage) && (
          <p className="mt-2 text-[var(--text-muted)]">
            Where minute-grid counts are unavailable, mark counts and times come from the replay
            summary.
          </p>
        )}
        <div className="mt-2 overflow-x-auto">
          <table aria-label="Insufficient data dates" className="w-full tabular-nums">
            <thead>
              <tr>
                {['Date', 'Source', 'Reason', 'Combined marks', 'Last combined mark (IST)'].map(
                  (header) => (
                    <th key={header} scope="col" className={`${ISSUE_CELL} text-left`}>
                      {header}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ day, issues, coverage }) => {
                const marks = coverage ?? {
                  observed: day.marked,
                  possible: day.possible,
                  lastCompleteMinute: day.marked > 0 ? day.lastMarked : null,
                };
                return (
                  <tr key={day.date}>
                    <th scope="row" className={`${ISSUE_CELL} whitespace-nowrap text-left`}>
                      <button type="button" className={LINK} onClick={() => open(day.date)}>
                        {day.date}
                      </button>
                    </th>
                    <td className={ISSUE_CELL}>{day.source === 'nubra' ? 'Nubra' : 'Local'}</td>
                    <td className={ISSUE_CELL}>
                      {issues.map((issue) => PATH_ISSUE_LABELS[issue]).join(' · ')}
                    </td>
                    <td className={`${ISSUE_CELL} whitespace-nowrap`}>
                      {marks.observed}/{marks.possible}
                    </td>
                    <td className={`${ISSUE_CELL} whitespace-nowrap`}>
                      {marks.lastCompleteMinute == null
                        ? '—'
                        : openingTime(marks.lastCompleteMinute)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export default function OpeningStrangleHistory({
  days,
  unit,
  open,
  pin,
  pins,
  cost,
  source,
  onExpiry,
  onTrades,
  index,
  studyGroups,
  skipped,
  onTimeOnly,
  controls,
  onControls,
}: OpeningTradeActions & {
  cost: number;
  source: HistorySource;
  onExpiry: () => void;
  onTrades: () => void;
  index: string;
  studyGroups: OpeningStudy['groups'];
  skipped: OpeningStudy['skipped'];
  onTimeOnly: boolean;
  controls: OpeningHistoryControls;
  onControls: Dispatch<SetStateAction<OpeningHistoryControls>>;
}) {
  const id = useId();
  const {
    grouping,
    dte,
    selected,
    subgroup,
    moveCutoff,
    moveDraft,
    lossThreshold,
    gainThreshold,
    fitGroupCharts = false,
  } = controls;
  const isCurve = grouping === 'curve';
  const updateControls = (change: Partial<OpeningHistoryControls>) =>
    onControls((previous) => {
      const next = { ...previous, ...change };
      if (
        next.selected !== previous.selected ||
        next.dte !== previous.dte ||
        next.moveCutoff !== previous.moveCutoff ||
        next.grouping !== previous.grouping
      )
        next.subgroup = undefined;
      return next;
    });
  const loss = Number(lossThreshold) > 0 ? Number(lossThreshold) : 50;
  const gain = Number(gainThreshold) > 0 ? Number(gainThreshold) : 50;
  const cohort = useMemo(
    () => (dte === 'all' ? days : days.filter((day) => day.dteGroup === dte)),
    [days, dte],
  );
  const available = useMemo(() => {
    const selectedDates = new Set(cohort.map((day) => day.date));
    return new Map(
      source.rows?.filter((row) => selectedDates.has(row.date)).map((row) => [row.date, row]),
    );
  }, [cohort, source.rows]);
  const researchDays = useMemo(
    () => (source.snapshotThrough ? cohort.filter((day) => available.has(day.date)) : cohort),
    [available, cohort, source.snapshotThrough],
  );
  const validation = useMemo(
    () =>
      source.rows
        ? analyzeOpeningEntryRules(researchDays, [...available.values()], cost)
        : undefined,
    [available, cost, researchDays, source.rows],
  );
  const curves = useMemo(
    () =>
      new Map(
        cohort.map((day) => [
          day.date,
          classifyOpeningPath(day, available.get(day.date)?.pnl, moveCutoff),
        ]),
      ),
    [available, cohort, moveCutoff],
  );
  const canSplit = isCurve && selected != null && selected !== 'insufficient';
  const parent = useMemo(
    () => (canSplit ? cohort.filter((day) => curves.get(day.date) === selected) : []),
    [canSplit, cohort, curves, selected],
  );
  const subgroups = useMemo(
    () =>
      clusterOpeningCurves(
        parent.flatMap((day) => {
          const pnl = available.get(day.date)?.pnl;
          return pnl
            ? [{ date: day.date, entry: day.entry, entryCredit: day.entryCredit, pnl }]
            : [];
        }),
      ),
    [available, parent],
  );
  const scope = `${index}|${selected}|${dte}|${moveCutoff}|${parent.map((day) => day.date).join(',')}`;
  const pickedSubgroup =
    subgroup?.scope === scope
      ? subgroups.find(({ representative }) => representative === subgroup.representative)
      : undefined;
  const subgroupDates = useMemo(
    () => (pickedSubgroup ? new Set(pickedSubgroup.dates) : null),
    [pickedSubgroup],
  );
  const { groups, paths, allRange, allExtent } = useMemo(() => {
    const groupDefinitions: ReadonlyArray<{ key: GroupKey; label: string; color: string }> = isCurve
      ? CURVE_GROUPS
      : CLOSING_GROUPS;
    const groups = groupDefinitions.map((group) => ({
      ...group,
      days: [] as OpeningDaySummary[],
      close: [] as number[],
      worst: [] as number[],
      drawdown: [] as number[],
      exactCloses: 0,
      profitable: 0,
      paths: [] as OpeningOverlayPath[],
    }));
    const byKey = new Map(groups.map((group) => [group.key, group]));
    const paths: OpeningOverlayPath[] = [];
    for (const day of cohort) {
      const close = openingPnlAfterCost(day.close, cost);
      const key = isCurve
        ? (curves.get(day.date) ?? 'insufficient')
        : closingGroup(openingPnlInUnit(close, day.entryCredit, 'creditPct'), loss, gain);
      const group = byKey.get(key)!;
      group.days.push(day);
      if (close != null) {
        group.exactCloses++;
        if (close > 0) group.profitable++;
      }
      const shown = openingPnlInUnit(close, day.entryCredit, unit);
      if (shown != null) group.close.push(shown);
      const worst = openingPnlInUnit(
        openingPnlAfterCost(day.worst.pnl, cost),
        day.entryCredit,
        unit,
      );
      if (worst != null) group.worst.push(worst);
      const drawdown = openingPnlInUnit(day.drawdown, day.entryCredit, unit);
      if (drawdown != null) group.drawdown.push(drawdown);
      const row = available.get(day.date);
      if (!row) continue;
      const values = row.pnl.map((value) =>
        openingPnlInUnit(openingPnlAfterCost(value, cost), day.entryCredit, unit),
      );
      if (values.every((value) => value == null)) continue;
      const path = { date: day.date, values, color: group.color };
      group.paths.push(path);
      paths.push(path);
    }
    for (const group of groups)
      for (const values of [group.close, group.worst, group.drawdown]) values.sort((a, b) => a - b);
    return {
      groups: groups.map((group) => ({ ...group, range: interval(group.paths) })),
      paths,
      allRange: interval(paths),
      allExtent: openingOverlayExtent(paths),
    };
  }, [available, cohort, cost, curves, gain, isCurve, loss, unit]);
  const chartGroups = groups.filter((group) => group.days.length > 0);
  const active = groups.find((group) => group.key === selected && group.days.length > 0);
  const visiblePaths = useMemo(() => {
    if (!active) return paths;
    return subgroupDates
      ? active.paths.filter((path) => subgroupDates.has(path.date))
      : active.paths;
  }, [active, paths, subgroupDates]);
  const range = useMemo(() => {
    if (!active) return allRange;
    return subgroupDates ? interval(visiblePaths) : active.range;
  }, [active, allRange, subgroupDates, visiblePaths]);
  const rebound =
    'Reached the down zone first and later the up zone, or materially rebounded from a down-only trough.';
  const giveback =
    'Reached the up zone first and later the down zone, or materially gave back an up-only peak.';
  const descriptions: Record<GroupKey, string> = {
    largeLoss: `At or below −${loss}%`,
    loss: `Above −${loss}% and below 0%`,
    flat: 'Exactly 0%',
    gain: `Above 0% and below ${gain}%`,
    largeGain: `At or above ${gain}%`,
    missing: 'No exact close or nonpositive credit',
    roseHeld: `Reached +${moveCutoff}% and closed without a material giveback.`,
    fellStayed: `Reached −${moveCutoff}% and closed without a material rebound.`,
    fellRecoveredNonnegative: `${rebound} The gross close was zero or higher.`,
    fellRecoveredNegative: `${rebound} The gross close was below zero.`,
    roseFadedPositive: `${giveback} The gross close was above zero.`,
    roseFadedNonpositive: `${giveback} The gross close was zero or lower.`,
    swings: 'Changed from one meaningful zone to the other at least twice.',
    small: `Every observed mark stayed between −${moveCutoff}% and +${moveCutoff}%.`,
    insufficient:
      'Requires positive opening credit, an exact 15:29 mark and at least 90% combined minute coverage.',
  };
  const tableTitle = isCurve ? 'Curve movement groups' : 'Closing P&L groups';

  return (
    <article aria-label="Opening OTM 2 study report" className="flex flex-col gap-4">
      <section id={`${id}-overview`} aria-label="Study overview" className="scroll-mt-3">
        <OpeningStudyOverview
          index={index}
          days={cohort}
          cost={cost}
          dte={dte}
          validation={validation}
        />
      </section>
      <nav aria-label="Study report sections" className="flex flex-wrap gap-1.5 text-xs">
        {SECTIONS.map(([section, label]) => (
          <button
            key={section}
            type="button"
            className={BUTTON}
            onClick={() => {
              document.getElementById(`${id}-${section}`)?.scrollIntoView({ block: 'start' });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <section id={`${id}-curves`} className={SECTION}>
        <h3 className={HEADING}>Curve paths</h3>
        <OpeningCurveFindings
          days={cohort}
          rows={available}
          groups={studyGroups}
          unit={unit}
          cost={cost}
          onlyDte={dte}
        />
        <OpeningChartCard
          title="Full-history intraday P&L"
          description={`${cost ? 'Net of the entered round-trip cost' : 'Gross of transaction costs'} · ${visiblePaths.length.toLocaleString('en-IN')} visible session paths · grouped by ${isCurve ? 'curve movement' : 'closing P&L'} · IST`}
        >
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs">
              Days to expiry
              <select
                aria-label="History days to expiry"
                className={`${INPUT} min-w-[6.5rem]`}
                value={dte}
                onChange={(event) => {
                  updateControls({
                    dte: event.target.value as 'all' | OpeningDteGroup,
                    selected: undefined,
                  });
                }}
              >
                <option value="all">All DTE</option>
                {OPENING_DTE_GROUPS.map((group) => (
                  <option key={group} value={group}>
                    {group} DTE
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              Group by
              <select
                aria-label="Group by"
                className={`${INPUT} min-w-[9rem]`}
                value={grouping}
                onChange={(event) =>
                  updateControls({
                    grouping: event.target.value as OpeningHistoryControls['grouping'],
                    selected: undefined,
                  })
                }
              >
                <option value="curve">Curve movement</option>
                <option value="close">Closing P&amp;L</option>
              </select>
            </label>
            {isCurve && (
              <label className="flex flex-wrap items-center gap-2 text-xs">
                Meaningful move cutoff (% of credit)
                <input
                  type="number"
                  step="any"
                  className={INPUT}
                  value={moveDraft}
                  aria-invalid={!validOpeningMoveCutoff(Number(moveDraft))}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    updateControls(
                      validOpeningMoveCutoff(value)
                        ? { moveDraft: event.target.value, moveCutoff: value }
                        : { moveDraft: event.target.value },
                    );
                  }}
                />
              </label>
            )}
            <button
              type="button"
              aria-pressed={!active}
              className={`${BUTTON} ${!active ? '!border-[var(--accent)]' : ''}`}
              onClick={() => updateControls({ selected: undefined })}
            >
              {isCurve ? 'All curve groups' : 'All closing groups'}
            </button>
            {groups.map((group) => (
              <button
                type="button"
                key={group.key}
                aria-pressed={active?.key === group.key}
                disabled={group.days.length === 0}
                className={`${BUTTON} ${active?.key === group.key ? '!border-[var(--accent)]' : ''}`}
                onClick={() =>
                  updateControls({ selected: active?.key === group.key ? undefined : group.key })
                }
              >
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block h-2 w-2 rounded-full"
                  style={{ background: group.color }}
                />
                {group.label} · {group.days.length}
              </button>
            ))}
          </div>
          {canSplit && active && source.rows && (
            <SimilarCurveGroups
              subgroups={subgroups}
              parent={parent}
              cost={cost}
              chosen={pickedSubgroup?.representative}
              onChoose={(representative) =>
                updateControls({ subgroup: representative ? { scope, representative } : undefined })
              }
              open={open}
            />
          )}
          {isCurve && !validOpeningMoveCutoff(Number(moveDraft)) && (
            <p role="status" className="mt-1 text-xs text-[var(--text-muted)]">
              Enter a finite cutoff greater than 0%. The chart still uses {moveCutoff}%.
            </p>
          )}
          {visiblePaths.length > 0 && (
            <OpeningStrangleOverlay
              paths={visiblePaths}
              range={range}
              unit={unit}
              label="Full-history intraday P&L"
              extent={active ? undefined : allExtent}
              onOpen={open}
            />
          )}
          {source.loading && (
            <p role="status" className="py-4 text-xs text-[var(--text-muted)]">
              Loading session curves and entry readings…
            </p>
          )}
          {!source.loading && source.error && (
            <div className="flex flex-wrap items-center gap-2 py-3 text-xs text-[var(--text-muted)]">
              <p role="status">{source.error}</p>
              <button type="button" className={BUTTON} onClick={onExpiry}>
                Open expiry study
              </button>
            </div>
          )}
          {!source.loading && !source.error && visiblePaths.length === 0 && (
            <p className="py-3 text-xs text-[var(--text-muted)]">
              No recorded paths to show in this group and unit.
            </p>
          )}
          {!source.loading && source.rows && (
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              {source.snapshotThrough
                ? `Archive snapshot through ${source.snapshotThrough} · `
                : ''}
              {available.size.toLocaleString('en-IN')} of {cohort.length.toLocaleString('en-IN')}{' '}
              filtered sessions have history data. Missing minute marks remain gaps.
            </p>
          )}
        </OpeningChartCard>
      </section>

      <section
        id={`${id}-group-curves`}
        aria-labelledby={`${id}-group-curves-heading`}
        className={`${SECTION} min-w-0 [container-type:inline-size]`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={`${id}-group-curves-heading`} className={HEADING}>
            P&L by group
          </h3>
          {chartGroups.filter((group) => group.paths.length > 0).length > 1 && (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={fitGroupCharts}
                onChange={(event) =>
                  updateControls({ fitGroupCharts: event.currentTarget.checked })
                }
              />
              Fit each chart
            </label>
          )}
        </div>
        {chartGroups.length > 0 ? (
          <>
            <p className="text-xs text-[var(--text-muted)]">
              {fitGroupCharts ? 'P&L scale fitted to each chart' : 'Shared P&L scale'} · IST · Solid
              median · Dotted P10 and P90 · Dashed zero line
            </p>
            <div className="grid grid-cols-1 gap-2.5 [@container(min-width:720px)]:grid-cols-2">
              {chartGroups.map((group) => (
                <section
                  key={group.key}
                  aria-labelledby={`${id}-group-curve-${group.key}`}
                  className="min-w-0 rounded border border-[var(--border)] bg-[var(--bg-card)] p-2.5"
                >
                  <h4 id={`${id}-group-curve-${group.key}`} className="text-sm font-semibold">
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                      style={{ background: group.color }}
                    />
                    {group.label}
                  </h4>
                  <p className="text-xs text-[var(--text-muted)]">
                    {group.days.length.toLocaleString('en-IN')}{' '}
                    {group.days.length === 1 ? 'session' : 'sessions'} ·{' '}
                    {group.paths.length.toLocaleString('en-IN')} with paths
                  </p>
                  {group.paths.length > 0 ? (
                    <OpeningStrangleOverlay
                      paths={group.paths}
                      range={group.range}
                      unit={unit}
                      label={`${group.label} intraday P&L`}
                      mode="compact"
                      extent={fitGroupCharts ? undefined : allExtent}
                      onOpen={open}
                    />
                  ) : (
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      {source.loading ? 'Loading session paths…' : 'No recorded paths to show.'}
                    </p>
                  )}
                  {group.key === 'insufficient' && !source.loading && (
                    <InsufficientDataDetails days={group.days} available={available} open={open} />
                  )}
                </section>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-[var(--text-muted)]">No sessions match the current filters.</p>
        )}
      </section>

      <section id={`${id}-groups`} className={SECTION}>
        <h3 className={HEADING}>P&L groups</h3>
        <OpeningProfitFindings days={cohort} cost={cost} />
        {isCurve && <OpeningCurveGroupingMethod cutoff={moveCutoff} />}
        <OpeningChartCard
          title={tableTitle}
          description={
            isCurve
              ? 'The ending P&L and drawdown describe the outcomes within each movement group. Select a group to isolate its paths and open individual dates.'
              : 'A session enters a group using its exact 15:29 close as a percentage of entry credit. Select a group to isolate its paths and open individual dates.'
          }
        >
          <div className="mt-2 flex flex-wrap items-end gap-3 text-xs">
            {!isCurve && (
              <>
                <label className="grid gap-1">
                  Large loss cutoff (%)
                  <input
                    type="number"
                    min="1"
                    className={INPUT}
                    value={lossThreshold}
                    onChange={(event) => updateControls({ lossThreshold: event.target.value })}
                    onBlur={() => updateControls({ lossThreshold: String(loss) })}
                  />
                </label>
                <label className="grid gap-1">
                  Large gain cutoff (%)
                  <input
                    type="number"
                    min="1"
                    className={INPUT}
                    value={gainThreshold}
                    onChange={(event) => updateControls({ gainThreshold: event.target.value })}
                    onBlur={() => updateControls({ gainThreshold: String(gain) })}
                  />
                </label>
              </>
            )}
            <button type="button" className={BUTTON} onClick={onTrades}>
              Open all trades
            </button>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table aria-label={tableTitle} className="w-full text-xs tabular-nums">
              <thead>
                <tr>
                  {[
                    'Group',
                    isCurve ? 'How the curve moved' : 'Close as % of credit',
                    'Sessions',
                    'Paths available',
                    'Median close',
                    'Median worst mark',
                    'Median drawdown',
                    ...(isCurve ? ['Profitable exact closes'] : []),
                  ].map((label, i) => (
                    <th scope="col" className={`${CELL} ${i === 0 ? 'text-left' : ''}`} key={label}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr
                    key={group.key}
                    className={active?.key === group.key ? 'bg-[var(--bg-secondary)]' : ''}
                  >
                    <th scope="row" className={`${CELL} text-left`}>
                      <button
                        type="button"
                        className={`${LINK} disabled:opacity-45`}
                        aria-label={`Show ${group.label.toLowerCase()} dates`}
                        aria-pressed={active?.key === group.key}
                        disabled={!group.days.length}
                        onClick={() =>
                          updateControls({
                            selected: active?.key === group.key ? undefined : group.key,
                          })
                        }
                      >
                        {group.label}
                      </button>
                    </th>
                    <td
                      className={
                        isCurve ? 'min-w-[14rem] border-b border-[var(--border)] px-2 py-1.5' : CELL
                      }
                    >
                      {descriptions[group.key]}
                    </td>
                    <td className={CELL}>{group.days.length}</td>
                    <td className={CELL}>{group.paths.length}</td>
                    <td className={CELL}>{formatPnl(quantile(group.close, 0.5), unit)}</td>
                    <td className={CELL}>{formatPnl(quantile(group.worst, 0.5), unit)}</td>
                    <td className={CELL}>{formatPnl(quantile(group.drawdown, 0.5), unit)}</td>
                    {isCurve && (
                      <td className={CELL}>
                        {group.exactCloses
                          ? `${formatPnl((100 * group.profitable) / group.exactCloses, 'creditPct')} (${group.profitable}/${group.exactCloses})`
                          : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {active && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold">
                {active.label}
                {pickedSubgroup ? ` · Subgroup ${subgroups.indexOf(pickedSubgroup) + 1}` : ''} dates
              </h4>
              <GroupDates
                key={`${active.key}:${pickedSubgroup?.representative ?? ''}`}
                grouping={grouping}
                days={
                  subgroupDates
                    ? active.days.filter((day) => subgroupDates.has(day.date))
                    : active.days
                }
                unit={unit}
                cost={cost}
                available={available}
                open={open}
                pin={pin}
                pins={pins}
              />
            </div>
          )}
        </OpeningChartCard>
      </section>

      <section id={`${id}-entry`} className={SECTION}>
        <h3 className={HEADING}>Known at entry</h3>
        <OpeningKnownAtEntry />
      </section>

      <section id={`${id}-findings`} className={SECTION}>
        <h3 className={HEADING}>Findings</h3>
        <OpeningStrangleFindings index={index} />
      </section>

      <section id={`${id}-validation`} className={SECTION}>
        <h3 className={HEADING}>Validation</h3>
        <OpeningValidationFindings result={validation} loading={source.loading} />
        <OpeningStrangleEntryResearch
          key={dte}
          days={researchDays}
          result={validation}
          readings={available.size}
          filteredCount={cohort.length}
          snapshotThrough={source.snapshotThrough}
          loading={source.loading}
          cost={cost}
          open={open}
          pin={pin}
          pins={pins}
        />
      </section>

      <section id={`${id}-method`} className={`${SECTION} pb-4`}>
        <h3 className={HEADING}>Method and coverage</h3>
        <OpeningStudyMethod
          cohort={cohort}
          skipped={skipped}
          covered={available.size}
          through={source.snapshotThrough}
          onTimeOnly={onTimeOnly}
        />
      </section>
    </article>
  );
}
