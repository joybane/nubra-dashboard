import { useId, useMemo, type ReactNode } from 'react';
import {
  formatPnl,
  OPENING_DTE_GROUPS,
  type OpeningDteGroup,
  type OpeningUnit,
} from '../lib/openingStrangle';
import { compareOpeningIv, summarizeOpeningReport } from '../lib/openingStrangleReport';
import { OpeningChartCard } from './OpeningStrangleCharts';
import { OpeningStrangleTrades, type OpeningTradeActions } from './OpeningStrangleTrades';

const SECTIONS = [
  ['overview', 'Overview'],
  ['expiry', 'Expiry curves'],
  ['losses', 'Loss paths'],
  ['years', 'By year'],
  ['worst', 'Worst days'],
  ['levels', 'After a loss'],
  ['drivers', 'Drivers'],
  ['attribution', 'Attribution'],
] as const;
const BUTTON =
  'rounded border border-[var(--border)] px-2 py-1 text-xs font-medium hover:border-[var(--accent)] hover:text-[var(--accent)]';
const CELL = 'whitespace-nowrap border-b border-[var(--border)] px-2 py-1.5 text-right';
const PERCENT = (value: number | null) => formatPnl(value, 'creditPct');

type Report = ReturnType<typeof summarizeOpeningReport>;
type IvComparison = ReturnType<typeof compareOpeningIv>;

function ReportTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr>
            {headers.map((header, i) => (
              <th
                key={`${i}-${header}`}
                scope="col"
                className={`${CELL} ${i === 0 ? 'text-left' : ''}`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, ...values], i) => (
            <tr key={i}>
              <th scope="row" className={`${CELL} text-left`}>
                {label}
              </th>
              {values.map((value, j) => (
                <td key={j} className={CELL}>
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ report, unit }: { report: Report; unit: OpeningUnit }) {
  const stats = [
    [
      'Median close',
      formatPnl(report.medianClose, unit),
      `${report.closeN} session closes in this unit`,
    ],
    [
      'Profitable closes',
      PERCENT(report.profitablePct),
      `${report.exactCloses} exact 15:29 closes`,
    ],
    [
      'Median worst mark',
      formatPnl(report.medianWorst, unit),
      `${report.pathN} observed intraday paths`,
    ],
    [
      'Median drawdown',
      formatPnl(report.medianDrawdown, unit),
      `90th percentile ${formatPnl(report.p90Drawdown, unit)}`,
    ],
  ];
  return (
    <dl className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {stats.map(([label, value, note]) => (
        <div
          key={label}
          className="rounded border border-[var(--border)] bg-[var(--bg-card)] px-3 py-2"
        >
          <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
          <dd className="py-0.5 text-lg font-semibold tabular-nums">{value}</dd>
          <dd className="text-xs text-[var(--text-muted)]">{note}</dd>
        </div>
      ))}
    </dl>
  );
}

function Bars({ labels, counts, color }: { labels: string[]; counts: number[]; color: string }) {
  const max = Math.max(...counts, 1);
  return (
    <ul className="mt-1 space-y-1.5 text-xs tabular-nums">
      {labels.map((label, i) => (
        <li
          key={label}
          className="grid grid-cols-[minmax(6.75rem,auto)_1fr_2.7rem] items-center gap-2"
        >
          <span className="text-[var(--text-muted)]">{label}</span>
          <div
            aria-hidden="true"
            className="h-2 overflow-hidden rounded-sm bg-[var(--bg-secondary)]"
          >
            <div
              className="h-full"
              style={{ width: `${(100 * counts[i]) / max}%`, background: color }}
            />
          </div>
          <span className="text-right">{counts[i]}</span>
        </li>
      ))}
    </ul>
  );
}

function LossPaths({ report, unit }: { report: Report; unit: OpeningUnit }) {
  const bins = report.bands.map(({ low, high }) => {
    if (high === 0) return 'Zero';
    if (high == null) return `${formatPnl(low, unit)} or more`;
    if (low === 0) return `Under ${formatPnl(high, unit)}`;
    return `${formatPnl(low, unit)}–<${formatPnl(high, unit)}`;
  });
  return (
    <OpeningChartCard
      title="Loss paths"
      description="Depth and drawdown use observed minute marks. The hour counts the first minute at the day’s worst negative mark."
    >
      <div className="grid gap-3 py-2 lg:grid-cols-3">
        <div>
          <h4 className="mb-2 text-xs font-semibold">Worst mark depth · {report.pathN}</h4>
          <Bars
            labels={bins}
            counts={report.bands.map((band) => band.worst)}
            color="var(--accent)"
          />
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold">Peak-to-trough drawdown · {report.pathN}</h4>
          <Bars labels={bins} counts={report.bands.map((band) => band.drawdown)} color="#aa73c2" />
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold">
            Hour of worst mark (IST) · {report.lossN} loss days
          </h4>
          <Bars
            labels={report.lossHours.map(({ hour }) => `${String(hour).padStart(2, '0')}:00`)}
            counts={report.lossHours.map(({ count }) => count)}
            color="#c17126"
          />
        </div>
      </div>
    </OpeningChartCard>
  );
}

function IvComparisonTable({
  comparison,
  unit,
  onDrivers,
  onDteChange,
}: {
  comparison: IvComparison;
  unit: OpeningUnit;
  onDrivers: () => void;
  onDteChange: (dte: OpeningDteGroup) => void;
}) {
  const { dte, low, high, unchanged, missing } = comparison;
  return (
    <OpeningChartCard
      title="Similar spot moves, different IV"
      description={`Compare observed 15:29 closes within ${dte} DTE, grouped by each session’s maximum absolute spot move from entry. IV is the change from entry through close.`}
    >
      <div className="flex flex-wrap items-center gap-3 py-1.5 text-xs">
        <label className="flex items-center gap-1.5">
          Days to expiry
          <select
            aria-label="Driver days to expiry"
            className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5"
            value={dte}
            onChange={(event) => onDteChange(event.target.value as OpeningDteGroup)}
          >
            {OPENING_DTE_GROUPS.map((group) => (
              <option key={group}>{group}</option>
            ))}
          </select>
        </label>
        {low != null && high != null && (
          <p className="text-[var(--text-muted)]">
            Low through {PERCENT(low)} · Middle through {PERCENT(high)} · High above {PERCENT(high)}
          </p>
        )}
      </div>
      <ReportTable
        headers={[
          'Spot move',
          'IV fell · sessions',
          'IV fell · closes used',
          'IV fell · median close',
          'IV rose · sessions',
          'IV rose · closes used',
          'IV rose · median close',
        ]}
        rows={comparison.strata.map(({ label, fell, rose }) => [
          label,
          fell.sessions,
          fell.closeN,
          formatPnl(fell.medianClose, unit),
          rose.sessions,
          rose.closeN,
          formatPnl(rose.medianClose, unit),
        ])}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-muted)]">
          {unchanged} unchanged IV · {missing} missing spot movement or IV. Groups compare observed
          outcomes.
        </p>
        <button type="button" className={BUTTON} onClick={onDrivers}>
          Explore all curve drivers
        </button>
      </div>
    </OpeningChartCard>
  );
}

export default function OpeningStrangleReport({
  days,
  unit,
  open,
  pin,
  pins,
  dte,
  expiry,
  attribution,
  onDrivers,
  onDteChange,
}: OpeningTradeActions & {
  dte: OpeningDteGroup;
  expiry: ReactNode;
  attribution: ReactNode;
  onDrivers: () => void;
  onDteChange: (dte: OpeningDteGroup) => void;
}) {
  const id = useId();
  const report = useMemo(() => summarizeOpeningReport(days, unit), [days, unit]);
  const comparison = useMemo(() => compareOpeningIv(days, dte, unit), [days, dte, unit]);
  return (
    <>
      <nav className="flex flex-wrap gap-1.5" aria-label="Opening report sections">
        {SECTIONS.map(([section, label]) => (
          <button
            key={section}
            type="button"
            className={BUTTON}
            onClick={() =>
              document.getElementById(`${id}-${section}`)?.scrollIntoView({ block: 'start' })
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <section id={`${id}-overview`} aria-label="Opening report overview">
        <Overview report={report} unit={unit} />
      </section>
      <section id={`${id}-expiry`} className="flex flex-col gap-2.5">
        {expiry}
      </section>
      <section id={`${id}-losses`}>
        <LossPaths report={report} unit={unit} />
      </section>
      <section id={`${id}-years`}>
        <OpeningChartCard
          title="Year-by-year outcomes"
          description="Closing statistics use exact 15:29 marks. Drawdown uses the observed intraday path."
        >
          <ReportTable
            headers={[
              'Year',
              'Sessions',
              'Exact closes',
              'Closes used',
              'Median close',
              'P10 close',
              'Profitable closes',
              'Median drawdown',
              'P90 drawdown',
            ]}
            rows={report.years.map((year) => [
              year.year,
              year.sessions,
              year.exactCloses,
              year.closeN,
              formatPnl(year.medianClose, unit),
              formatPnl(year.p10Close, unit),
              PERCENT(year.profitablePct),
              formatPnl(year.medianDrawdown, unit),
              formatPnl(year.p90Drawdown, unit),
            ])}
          />
        </OpeningChartCard>
      </section>
      <section id={`${id}-worst`}>
        <OpeningChartCard
          title="Worst days"
          description="The lowest intraday marks in the selected unit. Select a date to inspect its path."
        >
          <OpeningStrangleTrades
            days={report.worstDays}
            unit={unit}
            open={open}
            pin={pin}
            pins={pins}
            compact
          />
        </OpeningChartCard>
      </section>
      <section id={`${id}-levels`}>
        <OpeningChartCard
          title="After a loss level"
          description="Among sessions reaching each depth in observed marks, closing shares use only exact 15:29 closes. A recovery closes strictly above the loss level."
        >
          <ReportTable
            headers={[
              'Loss of entry credit',
              'Reached',
              'With exact close',
              'Closed above loss level',
              'Closed positive',
            ]}
            rows={report.thresholds.map((row) => [
              PERCENT(row.percent),
              row.reached,
              row.closeN,
              row.closeN ? `${PERCENT(row.recoveredPct)} (${row.recovered}/${row.closeN})` : '—',
              row.closeN ? `${PERCENT(row.positivePct)} (${row.positive}/${row.closeN})` : '—',
            ])}
          />
          {report.missingCredit > 0 && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {report.missingCredit} sessions without positive entry credit are excluded from this
              table.
            </p>
          )}
        </OpeningChartCard>
      </section>
      <section id={`${id}-drivers`}>
        <IvComparisonTable
          comparison={comparison}
          unit={unit}
          onDrivers={onDrivers}
          onDteChange={onDteChange}
        />
      </section>
      <section id={`${id}-attribution`}>{attribution}</section>
    </>
  );
}
