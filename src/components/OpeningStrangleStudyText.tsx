import type { OpeningEntryAnalysis } from '../lib/openingResearch';
import { OPENING_MOVE_COVERAGE } from '../lib/openingPathGroups';
import {
  OPENING_MINUTE,
  OPENING_SESSION_MINUTES,
  formatPnl,
  type OpeningDaySummary,
  type OpeningDteGroup,
  type OpeningResearchRow,
  type OpeningStudy,
  type OpeningUnit,
} from '../lib/openingStrangle';

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const NUMBER = new Intl.NumberFormat('en-IN');
const count = (value: number) => NUMBER.format(value);
const money = (value: number | null) => formatPnl(value, 'rupees');
const rate = (value: number | null) => formatPnl(value, 'creditPct');
const dateLabel = (date: string) => DATE.format(new Date(`${date}T00:00:00Z`));
const P = 'max-w-[90ch] text-[14px] leading-relaxed text-[var(--text-secondary)]';
const NOON = 12 * 60 - OPENING_MINUTE;
const CLOSE = OPENING_SESSION_MINUTES - 1;
const MIN_DESCRIPTIVE_SAMPLE = 10;

function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = (ordered.length - 1) * fraction;
  const lower = Math.floor(index);
  return ordered[lower] + (ordered[Math.ceil(index)] - ordered[lower]) * (index - lower);
}

function closes(days: OpeningDaySummary[], cost: number): number[] {
  return days.flatMap(({ close }) => (close == null ? [] : [close - cost]));
}

export function OpeningStudyOverview({
  index,
  days,
  cost,
  dte,
  validation,
}: {
  index: string;
  days: OpeningDaySummary[];
  cost: number;
  dte: 'all' | OpeningDteGroup;
  validation?: OpeningEntryAnalysis;
}) {
  const marks = closes(days, cost);
  const dates = days.map(({ date }) => date).sort();
  const start = dates[0];
  const end = dates.at(-1);
  const win = marks.filter((mark) => mark > 0).length;
  const missing = days.length - marks.length;
  const validated = validation?.candidates.filter((candidate) => candidate.validated).length;
  const smallValidation =
    validation && (validation.discovery.baseline.n < 30 || validation.holdout.baseline.n < 15);
  const mean = marks.length ? marks.reduce((sum, value) => sum + value, 0) / marks.length : null;
  const drawdown = quantile(
    days.map((day) => day.drawdown),
    0.5,
  );

  return (
    <header className="border-b border-[var(--border)] pb-3">
      <h2 className="text-[24px] font-semibold leading-tight">
        {index} Opening OTM 2 study report
      </h2>
      <div className="mt-2.5 grid gap-2">
        {start && end ? (
          <>
            <p className={P}>
              This study simulated {count(days.length)} opening strangles{' '}
              {start === end
                ? `on ${dateLabel(start)}`
                : `from ${dateLabel(start)} to ${dateLabel(end)}`}
              {dte === 'all' ? '' : ` at ${dte} trading days to expiry`}.{' '}
              <strong>{count(marks.length)} had exact 15:29 IST closes.</strong>{' '}
              {missing > 0 &&
                `${count(missing)} sessions lacked a price for at least one leg at the close. `}
              {cost
                ? `Results deduct ${money(cost)} per round trip.`
                : 'Results use gross P&L before costs.'}
            </p>
            {marks.length > 0 ? (
              <p className={P}>
                The median closing P&amp;L was <strong>{money(quantile(marks, 0.5))}</strong> per
                lot, the mean was {money(mean)}, and {rate((100 * win) / marks.length)} of exact
                closes were profitable.{' '}
                {marks.length < MIN_DESCRIPTIVE_SAMPLE
                  ? 'This is a small closing sample.'
                  : `The 10th-percentile close was ${money(quantile(marks, 0.1))}, the lower tail of closing results.`}{' '}
                The median intraday drawdown was {money(drawdown)} from a prior peak to a later
                trough.
              </p>
            ) : (
              <p className={P}>
                Closing statistics are unavailable for this selection. The observed minute paths
                remain available where quotes exist.
              </p>
            )}
          </>
        ) : (
          <p className={P}>
            The current study filters returned no simulated sessions. Widen the date range or expiry
            selection to see results.
          </p>
        )}
        {validation && validation.candidates.length > 0 && (
          <p className={P}>
            <strong>
              {smallValidation
                ? 'The sample is too small to clear the entry-condition checks.'
                : validated === 0
                  ? 'No tested entry condition cleared the later validation checks.'
                  : `${validated} of ${validation.candidates.length} tested entry conditions cleared the later validation checks.`}
            </strong>{' '}
            The conditions were chosen using earlier dates and compared with selling every eligible
            session in the later period.
          </p>
        )}
        <div className="mt-1">
          <h3 className="mb-1 text-[14px] font-semibold">How to read this study</h3>
          <p className={P}>
            The written findings and grouped curves summarize many historical sessions. Open a date
            to follow one simulated trade from entry to close. The entry validation below uses
            information available when trades opened and checks how the same conditions fared across
            later historical sessions.
          </p>
        </div>
      </div>
    </header>
  );
}

export function OpeningCurveFindings({
  days,
  rows,
  groups,
  unit,
  cost,
  onlyDte,
}: {
  days: OpeningDaySummary[];
  rows: Map<string, OpeningResearchRow>;
  groups: OpeningStudy['groups'];
  unit: OpeningUnit;
  cost: number;
  onlyDte: 'all' | OpeningDteGroup;
}) {
  const relevant: OpeningDteGroup[] = onlyDte === 'all' ? ['0', '1'] : [onlyDte];
  return (
    <div className="grid gap-2">
      <p className={P}>
        Each thin line follows one fixed-strike strangle from entry to the last available mark. The
        solid median traces the middle result at each minute. The dotted lines show the 10th and
        90th percentiles of the visible sessions with quotes at that minute.
      </p>
      {relevant.map((dte) => {
        const grouped = days.filter((day) => day.dteGroup === dte);
        const pairs = grouped.flatMap((day) => {
          const midday = rows.get(day.date)?.pnl[NOON];
          return midday == null || day.close == null
            ? []
            : [{ midday: midday - cost, close: day.close - cost }];
        });
        const label =
          dte === '0'
            ? 'Expiry day (0 DTE)'
            : dte === '1'
              ? 'One trading day to expiry (1 DTE)'
              : `${dte} trading days to expiry (${dte} DTE)`;
        if (pairs.length >= MIN_DESCRIPTIVE_SAMPLE) {
          const noon = quantile(
            pairs.map((pair) => pair.midday),
            0.5,
          )!;
          const final = quantile(
            pairs.map((pair) => pair.close),
            0.5,
          )!;
          const tail = quantile(
            pairs.map((pair) => pair.close),
            0.1,
          );
          const movement = final > noon ? 'rose' : final < noon ? 'fell' : 'was unchanged';
          return (
            <p className={P} key={dte}>
              <strong>{label}.</strong> In the {count(pairs.length)} sessions with quotes at both
              times, the median {movement} from {money(noon)} at noon to {money(final)} per lot at
              15:29. The 10th-percentile close was {money(tail)}.
            </p>
          );
        }
        const group = groups.find((item) => item.dte === dte);
        const noon = group?.curve[NOON];
        const final = group?.curve[CLOSE];
        if (
          cost === 0 &&
          noon &&
          final &&
          noon.n >= MIN_DESCRIPTIVE_SAMPLE &&
          final.n >= MIN_DESCRIPTIVE_SAMPLE
        ) {
          return (
            <p className={P} key={dte}>
              <strong>{label}.</strong> The stored median was {formatPnl(noon.median, unit)} at noon
              across {count(noon.n)} marks and {formatPnl(final.median, unit)} at 15:29 across{' '}
              {count(final.n)} exact closes. The 10th-percentile close was{' '}
              {formatPnl(final.p10, unit)}. Each time uses the marks available for that minute.
            </p>
          );
        }
        return (
          <p className={P} key={dte}>
            <strong>{label}.</strong>{' '}
            {grouped.length === 0
              ? 'No sessions match the current filters.'
              : `Only ${count(pairs.length)} comparable noon and closing paths are available, too few to describe a typical move.`}
          </p>
        );
      })}
    </div>
  );
}

export function OpeningProfitFindings({ days, cost }: { days: OpeningDaySummary[]; cost: number }) {
  const winners = days.filter((day) => day.close != null && day.close > cost);
  const comparable = winners.filter((day) => day.entryCredit > 0);
  const dipped = comparable.filter((day) => day.worst.pnl - cost <= -0.25 * day.entryCredit).length;
  const gaps = comparable.filter((day) => day.marked < day.possible).length;
  return winners.length > 0 ? (
    <p className={P}>
      A profitable close can follow an intraday loss. Of {count(winners.length)} profitable closes
      in the current selection, {count(comparable.length)} had a positive opening credit for
      comparison.{' '}
      {comparable.length > 0 ? (
        <strong>
          {count(dipped)} of those {count(comparable.length)} (
          {rate((100 * dipped) / comparable.length)}) reached a loss of at least 25% of the opening
          credit before finishing profitable.
        </strong>
      ) : (
        'The 25% comparison is unavailable for these trades.'
      )}{' '}
      {gaps > 0 &&
        `${count(gaps)} of the comparable paths have missing minute marks, so the dip count reflects observed prices.`}
    </p>
  ) : (
    <p className={P}>
      The current selection has no profitable exact closes, so there are no profitable paths for the
      25% dip comparison.
    </p>
  );
}

export function OpeningCurveGroupingMethod({ cutoff }: { cutoff: number }) {
  return (
    <div className="grid gap-2">
      <p className={P}>
        Curve movement groups use the order of gains and losses during the hold. A meaningful move
        reaches at least {cutoff}% of the combined opening credit in either direction. If only one
        side was reached, a rebound or giveback must move at least {cutoff}% of opening credit and
        retrace at least half the observed trough or peak by the close.
      </p>
      <p className={P}>
        Grouping uses gross marks and requires an exact 15:29 close and at least{' '}
        {OPENING_MOVE_COVERAGE}% combined minute coverage. The gross 15:29 close separates
        recoveries below break-even from those at or above it, and givebacks above break-even from
        those at or below it. The display unit and round-trip cost affect shown results only. These
        groups describe the completed session. Entry validation uses readings available at entry.
      </p>
    </div>
  );
}

export function OpeningKnownAtEntry() {
  return (
    <div className="grid gap-2">
      <p className={P}>
        <strong>What the premiums say.</strong> The total opening credit and the imbalance between
        the call and put premiums describe the trade as priced at entry. Opening implied volatility,
        the difference between the legs, and credit and volatility relative to earlier sessions
        describe the starting conditions.
      </p>
      <p className={P}>
        <strong>Where spot and expiry start.</strong> Distance to each fixed strike, the gap from
        the previous close, days to expiry and weekly versus monthly expiry are all known when the
        trade opens. That timing makes them eligible for choosing trades before looking at the
        result.
      </p>
      <p className={P}>
        The Curve drivers view describes what happened during the hold, including how far spot
        moved, whether it touched a strike and how implied volatility changed by the close.
      </p>
    </div>
  );
}

export function OpeningValidationFindings({
  result,
  loading,
}: {
  result?: OpeningEntryAnalysis;
  loading: boolean;
}) {
  if (!result)
    return (
      <p className={P}>
        {loading
          ? 'Entry validation is loading with the historical paths.'
          : 'Entry and validation readings are unavailable for this source.'}
      </p>
    );
  const older = result.discovery;
  const later = result.holdout;
  if (!older.from || !older.to || !later.from || !later.to)
    return (
      <p className={P}>
        Too few closed sessions are available to form separate discovery and validation periods.
      </p>
    );
  return (
    <div className="grid gap-2">
      <p className={P}>
        The study uses the earlier 70% of eligible exact closes to choose conditions and the
        remaining dates to validate them. In discovery ({dateLabel(older.from)} to{' '}
        {dateLabel(older.to)}), selling every eligible trade averaged{' '}
        {money(older.baseline.meanNet)} across {count(older.baseline.n)} sessions. In validation (
        {dateLabel(later.from)} to {dateLabel(later.to)}), the same baseline averaged{' '}
        {money(later.baseline.meanNet)} per lot over {count(later.baseline.n)} exact closes.
      </p>
      {(older.baseline.n < 30 || later.baseline.n < 15) && (
        <p className={P}>
          The current sample has fewer than 30 discovery closes or 15 validation closes, so it
          cannot meet the minimum trade counts for a condition.
        </p>
      )}
      <p className={P}>
        Each condition keeps its earlier cutoff in the later period. Compare its average per trade
        and its net P&amp;L per eligible session with the later baseline. The latter includes
        skipped dates in the denominator and shows what selectivity did to the result for the whole
        period.
      </p>
    </div>
  );
}

export function OpeningStudyMethod({
  cohort,
  skipped,
  covered,
  through,
  onTimeOnly,
}: {
  cohort: OpeningDaySummary[];
  skipped: OpeningStudy['skipped'];
  covered: number;
  through?: string;
  onTimeOnly: boolean;
}) {
  const later = cohort.filter((day) => day.entry > 0).length;
  const gaps = cohort.filter((day) => day.marked < day.possible).length;
  return (
    <div className="grid gap-2">
      <p className={P}>
        The simulation sells one lot each of the call two strike steps above at-the-money and the
        put two steps below it. At-the-money is the listed strike closest to the underlying mark at
        entry. The selected strikes are held through the 15:29 IST bar. Entry and later marks use
        stored minute closes.{' '}
        {onTimeOnly
          ? 'The 09:15 filter retains entries with both prices at 09:15.'
          : 'The simulation starts at 09:15 and allows entry through 09:20 when a price is missing.'}
      </p>
      <p className={P}>
        There were {count(later)} later entries and {count(gaps)} simulated sessions with missing
        combined minute marks in this view. A combined mark requires both leg prices, so gaps stay
        blank. Minute paths and research records cover {count(covered)} of {count(cohort.length)}{' '}
        simulated sessions{through ? ` in the archive snapshot through ${dateLabel(through)}` : ''}.
      </p>
      <p className={P}>
        The optional pricing attribution in Expiry study uses Black–76 to estimate contributions
        from the forward level, time to expiry and implied volatility. The results describe
        historical simulations.
      </p>
      {skipped.length > 0 && (
        <details className="text-xs text-[var(--text-secondary)]">
          <summary className="cursor-pointer">
            {count(skipped.length)} sessions skipped under the Study filters
          </summary>
          <ul className="mt-1 max-h-36 overflow-auto">
            {skipped.map((item) => (
              <li key={item.date}>
                {item.date} · {item.source} · {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
