import { useEffect, useMemo, useRef, useState } from 'react';
import {
  OPENING_DRIVERS,
  OPENING_DTE_GROUPS,
  OPENING_STRANGLE_API,
  formatPnl,
  openingPnlInUnit,
  openingSummaryAfterCost,
  openingTime,
  plainAmount,
  type OpeningContract,
  type OpeningDates,
  type OpeningDay,
  type OpeningDaySummary,
  type OpeningDriver,
  type OpeningDteGroup,
  type OpeningFilters,
  type OpeningGroup,
  type OpeningResearchRow,
  type OpeningStudy,
  type OpeningUnit,
} from '../lib/openingStrangle';
import type { SignalUnderlying } from '../lib/signalBacktest';
import { OPENING_MOVE_CUTOFF } from '../lib/openingPathGroups';
import { matchOpeningPremiumPrices, type ArchivedOpeningPrices } from '../lib/openingPremiumPrices';
import {
  OpeningAttributionChart,
  OpeningChartCard,
  OpeningComparisonChart,
  OpeningDayCharts,
  OpeningGroupChart,
} from './OpeningStrangleCharts';
import OpeningStrangleHistory, {
  type HistorySource,
  type OpeningHistoryControls,
} from './OpeningStrangleHistory';
import OpeningStrangleReport from './OpeningStrangleReport';
import { OpeningStrangleTrades } from './OpeningStrangleTrades';
import OpeningStrangleTradeStory from './OpeningStrangleTradeStory';

const TABS = [
  'Study report',
  'Expiry study',
  'All trades',
  'Single day',
  'Compare dates',
  'Curve drivers',
] as const;
type Tab = (typeof TABS)[number];
const DRIVERS: Record<OpeningDriver, { label: string; time: string; suffix: string }> = {
  entryCredit: { label: 'Entry credit', time: 'At entry', suffix: ' ₹/lot' },
  entryIv: { label: 'Entry implied volatility', time: 'At entry', suffix: ' vol points' },
  spotMove: { label: 'Maximum absolute spot move', time: 'During the session', suffix: '%' },
  ivChange: {
    label: 'Implied volatility change to close',
    time: 'During the session',
    suffix: ' vol points',
  },
  touch: { label: 'Strike touch', time: 'During the session', suffix: '' },
};

const INPUT = 'rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs';
const BUTTON = `${INPUT} font-medium hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45`;
const LINK = 'text-[var(--accent)] hover:underline';
const CELLS = 'whitespace-nowrap border-b border-[var(--border)] px-2 py-1.5 text-right';
const EMPTY_DAYS: OpeningDaySummary[] = [];

interface OpeningSnapshot {
  rows: OpeningResearchRow[];
  through: string;
  sources: Record<string, OpeningDaySummary['source']>;
}

const snapshotRequests = new Map<SignalUnderlying, Promise<OpeningSnapshot>>();

function useOpeningSnapshot(index: SignalUnderlying | null) {
  const [result, setResult] = useState<{ index: SignalUnderlying; data?: OpeningSnapshot }>();
  useEffect(() => {
    if (!index) return;
    let abandoned = false;
    let request = snapshotRequests.get(index);
    if (!request) {
      request = fetch(`/opening-research/${index}.json`).then(async (response) => {
        if (!response.ok) throw new Error('Archive snapshot unavailable.');
        const snapshot = (await response.json()) as OpeningSnapshot;
        if (!Array.isArray(snapshot.rows) || !snapshot.sources || !snapshot.through) {
          throw new Error('Archive snapshot is incomplete.');
        }
        return snapshot;
      });
      snapshotRequests.set(index, request);
      void request.catch(() => snapshotRequests.delete(index));
    }
    void request.then(
      (data) => {
        if (!abandoned) setResult({ index, data });
      },
      () => {
        if (!abandoned) setResult({ index });
      },
    );
    return () => {
      abandoned = true;
    };
  }, [index]);
  return {
    loading: index != null && result?.index !== index,
    data: index != null && result?.index === index ? result.data : undefined,
  };
}

async function getJson<T>(url: string, signal: AbortSignal, body?: string): Promise<T> {
  const response = await fetch(
    url,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal,
        }
      : { signal },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result as T;
}

function useRequest<T>(url: string | null, refresh: number, body?: string) {
  const key = url == null ? '' : `${refresh}|${url}|${body ?? ''}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    void getJson<T>(url, abort.signal, body).then(
      (data) => {
        if (!abort.signal.aborted) setResult({ key, data });
      },
      (error: Error) => {
        if (!abort.signal.aborted) setResult({ key, error: error.message });
      },
    );
    return () => abort.abort();
  }, [url, body, key]);
  return {
    data: result.key === key ? result.data : undefined,
    error: result.key === key ? result.error : undefined,
    loading: !!key && result.key !== key,
  };
}

function queryString(
  underlying: SignalUnderlying,
  includeLocalOnly?: boolean,
  date?: string,
  onTimeOnly?: boolean,
) {
  const query = new URLSearchParams({ underlying });
  if (includeLocalOnly !== undefined) query.set('includeLocalOnly', String(includeLocalOnly));
  if (date) query.set('date', date);
  if (onTimeOnly) query.set('onTimeOnly', 'true');
  return query.toString();
}

function RequestNotice({ loading, error }: { loading?: boolean; error?: string }) {
  if (error)
    return (
      <p role="alert" className="rounded border border-[var(--border)] p-3 text-[var(--red)]">
        {error}
      </p>
    );
  return loading ? (
    <p role="status" className="py-5 text-[var(--text-muted)]">
      Loading stored sessions…
    </p>
  ) : null;
}

function GroupTable<Group extends OpeningGroup>({
  groups,
  unit,
  select,
  active,
}: {
  groups: Group[];
  unit: OpeningUnit;
  select: (group: Group) => void;
  active?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            {[
              'Group',
              'Sessions',
              'With close',
              'Median credit',
              'Median close',
              'P10 close',
              'Profitable closes',
              'Median drawdown',
            ].map((column, i) => (
              <th key={column} scope="col" className={`${CELLS} ${i === 0 ? 'text-left' : ''}`}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr
              key={group.label}
              className={active === group.label ? 'bg-[var(--bg-secondary)]' : ''}
            >
              <th scope="row" className={`${CELLS} text-left`}>
                <button
                  type="button"
                  className={LINK}
                  aria-pressed={active === group.label}
                  onClick={() => select(group)}
                >
                  {group.label}
                </button>
              </th>
              <td className={CELLS}>
                {group.n}
                {group.n > 0 && group.n < 10 ? (
                  <span className="ml-1 text-[var(--text-muted)]" title="Fewer than 10 sessions">
                    *
                  </span>
                ) : null}
              </td>
              <td className={CELLS}>{group.closeN}</td>
              <td className={CELLS}>{formatPnl(group.medianCredit, 'rupees')}</td>
              <td className={CELLS}>{formatPnl(group.medianClose, unit)}</td>
              <td className={CELLS}>{formatPnl(group.p10Close, unit)}</td>
              <td className={CELLS}>{formatPnl(group.profitableClosePct, 'creditPct')}</td>
              <td className={CELLS}>{formatPnl(group.medianDrawdown, unit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groups.some((group) => group.n > 0 && group.n < 10) && (
        <p className="px-2 py-1 text-xs text-[var(--text-muted)]">
          * Fewer than 10 sessions in this group.
        </p>
      )}
    </div>
  );
}

function SessionList({
  days,
  unit,
  open,
  pin,
  pins,
}: {
  days: OpeningDaySummary[];
  unit: OpeningUnit;
  open: (date: string) => void;
  pin: (date: string) => void;
  pins: string[];
}) {
  if (!days.length)
    return <p className="py-3 text-[var(--text-muted)]">No sessions in this group.</p>;
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[var(--bg-card)]">
          <tr>
            {['Session', 'Expiry', 'Entry IST', 'Close', 'Drawdown', 'Marks', 'Compare'].map(
              (column, i) => (
                <th key={column} scope="col" className={`${CELLS} ${i === 0 ? 'text-left' : ''}`}>
                  {column}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {[...days].reverse().map((day) => (
            <tr key={day.date}>
              <th scope="row" className={`${CELLS} text-left`}>
                <button type="button" className={LINK} onClick={() => open(day.date)}>
                  {day.date}
                </button>
              </th>
              <td className={CELLS}>
                {day.expiry} · {day.monthly ? 'Monthly' : 'Weekly'}
              </td>
              <td className={CELLS}>{openingTime(day.entry)}</td>
              <td className={CELLS}>
                {formatPnl(openingPnlInUnit(day.close, day.entryCredit, unit), unit)}
              </td>
              <td className={CELLS}>
                {formatPnl(openingPnlInUnit(day.drawdown, day.entryCredit, unit), unit)}
              </td>
              <td className={CELLS}>
                {day.marked}/{day.possible}
              </td>
              <td className={CELLS}>
                <button
                  type="button"
                  className={BUTTON}
                  aria-label={`${pins.includes(day.date) ? 'Unpin' : 'Pin'} ${day.date}`}
                  aria-pressed={pins.includes(day.date)}
                  disabled={!pins.includes(day.date) && pins.length === 6}
                  onClick={() => pin(day.date)}
                >
                  {pins.includes(day.date) ? 'Unpin' : 'Pin'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayDetails({
  day,
  underlying,
  unit,
  cost,
  refresh,
}: {
  day: OpeningDay;
  underlying: SignalUnderlying;
  unit: OpeningUnit;
  cost: number;
  refresh: number;
}) {
  const summary = openingSummaryAfterCost(day.summary, cost);
  const query = new URLSearchParams({
    underlying,
    date: day.summary.date,
    source: day.summary.source,
    entryTime: openingTime(day.summary.entry),
    strikeOffset: '2',
  });
  const archive = useRequest<ArchivedOpeningPrices>(`/api/analysis/day?${query}`, refresh);
  const premiums = matchOpeningPremiumPrices(archive.data, underlying, day.summary);
  const converted = (value: number | null) => openingPnlInUnit(value, summary.entryCredit, unit);
  const formatted = (value: number | null) => formatPnl(converted(value), unit);
  const stats = [
    ['Entry', `${openingTime(summary.entry)} IST`],
    ['Entry credit', formatPnl(summary.entryCredit, 'rupees')],
    ['15:29 close', formatted(summary.close)],
    ['Best', `${formatted(summary.best.pnl)} · ${openingTime(summary.best.minute)}`],
    ['Worst', `${formatted(summary.worst.pnl)} · ${openingTime(summary.worst.minute)}`],
    ['Peak-to-trough drawdown', formatted(summary.drawdown)],
  ];
  const modelCoverage = day.attribution.filter((mark) => mark != null).length;
  return (
    <>
      <OpeningStrangleTradeStory day={day} cost={cost} />
      <div className="rounded border border-[var(--border)] bg-[var(--bg-card)] p-2.5">
        <p className="mb-2 text-xs text-[var(--text-muted)]">
          {summary.monthly ? 'Monthly' : 'Weekly'} expiry {summary.expiry} · {summary.dte} trading
          days to expiry · {summary.source === 'nubra' ? 'Nubra' : 'Local'}
          {' · '}Call {plainAmount(summary.ceStrike)} at {plainAmount(summary.ceEntry)} · Put{' '}
          {plainAmount(summary.peStrike)} at {plainAmount(summary.peEntry)} · {summary.quantity}{' '}
          units per lot
        </p>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {stats.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
              <dd className="font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          {summary.marked}/{summary.possible} combined marks · last at{' '}
          {openingTime(summary.lastMarked)} IST
          {summary.close == null && ' · Close unavailable'}
        </p>
      </div>
      <OpeningDayCharts
        day={day}
        unit={unit}
        cost={cost}
        premiums={premiums}
        premiumsLoading={archive.loading}
      />
      <OpeningAttributionChart
        unit={unit}
        description={`${modelCoverage}/${summary.marked} observed combined marks modeled.`}
        points={day.attribution.map((mark, minute) => ({
          minute,
          forward: converted(mark?.forward ?? null),
          time: converted(mark?.time ?? null),
          iv: converted(mark?.iv ?? null),
          residual: converted(mark?.residual ?? null),
          actual: converted(mark?.actual ?? null),
          coverage: mark ? 'Modeled mark' : 'Model unavailable',
        }))}
      />
    </>
  );
}

function SingleDayHeader({
  index,
  date,
  selected,
  days,
  pinned,
  pinLimit,
  onBack,
  onDate,
  onPin,
}: {
  index: SignalUnderlying;
  date: string;
  selected: string;
  days: OpeningDaySummary[];
  pinned: boolean;
  pinLimit: boolean;
  onBack: () => void;
  onDate: (date: string) => void;
  onPin: (date: string) => void;
}) {
  return (
    <section
      aria-label="Single-day navigation"
      className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2.5 py-2 shadow-sm sm:px-3"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <button type="button" className={BUTTON} onClick={onBack}>
          <span aria-hidden="true">← </span>Back to study report
        </button>
        <h2 className="text-[14px] font-semibold tabular-nums">
          {index} · {date || selected || 'Single day'}
        </h2>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-2 text-xs">
          Session
          <select
            aria-label="Session"
            className={`${INPUT} min-w-0 max-w-full`}
            value={date}
            disabled={!days.length}
            onChange={(event) => onDate(event.target.value)}
          >
            {!date && <option value="">No matching sessions</option>}
            {[...days].reverse().map((day) => (
              <option key={day.date} value={day.date}>
                {day.date} · {day.dteGroup} DTE
              </option>
            ))}
          </select>
        </label>
        {date && (
          <button
            type="button"
            className={BUTTON}
            aria-pressed={pinned}
            disabled={pinLimit && !pinned}
            onClick={() => onPin(date)}
          >
            {pinned ? 'Unpin date' : 'Pin date'}
          </button>
        )}
      </div>
    </section>
  );
}

function CompareDates({
  urls,
  unit,
  cost,
  refresh,
}: {
  urls: string[];
  unit: OpeningUnit;
  cost: number;
  refresh: number;
}) {
  const request = urls.join('\n');
  const [result, setResult] = useState<{
    key: string;
    days: OpeningDay[];
    errors: string[];
  } | null>(null);
  const key = `${refresh}|${request}`;
  useEffect(() => {
    if (!request) return;
    const abort = new AbortController();
    void Promise.allSettled(
      request.split('\n').map((url) => getJson<OpeningDay>(url, abort.signal)),
    ).then((answers) => {
      if (abort.signal.aborted) return;
      const days: OpeningDay[] = [];
      const errors: string[] = [];
      answers.forEach((answer, i) => {
        if (answer.status === 'fulfilled') days.push(answer.value);
        else
          errors.push(
            `${new URL(request.split('\n')[i], window.location.origin).searchParams.get('date')} · ${String(answer.reason?.message ?? answer.reason)}`,
          );
      });
      setResult({ key, days, errors });
    });
    return () => abort.abort();
  }, [request, key]);

  if (!request)
    return (
      <p className="py-3 text-[var(--text-muted)]">
        Pin up to six sessions from the expiry study or single day view.
      </p>
    );
  if (result?.key !== key) return <RequestNotice loading />;
  return (
    <>
      {result.errors.map((error) => (
        <RequestNotice key={error} error={error} />
      ))}
      {result.days.length > 0 && (
        <OpeningComparisonChart days={result.days} unit={unit} cost={cost} />
      )}
    </>
  );
}

export default function OpeningStranglePane() {
  const [tab, setTab] = useState<Tab>('Study report');
  const scroller = useRef<HTMLDivElement>(null);
  const [underlying, setUnderlying] = useState<SignalUnderlying>('NIFTY');
  const [includeLocalOnly, setIncludeLocalOnly] = useState<boolean>();
  const [range, setRange] = useState<{ from: string; to: string }>();
  const [contract, setContract] = useState<OpeningContract>('all');
  const [expiry, setExpiry] = useState('');
  const [onTimeOnly, setOnTimeOnly] = useState(false);
  const [unit, setUnit] = useState<OpeningUnit>('rupees');
  const [cost, setCost] = useState(0);
  const [costDraft, setCostDraft] = useState('0');
  const [historyControls, setHistoryControls] = useState<OpeningHistoryControls>({
    grouping: 'curve',
    dte: 'all',
    moveCutoff: OPENING_MOVE_CUTOFF,
    moveDraft: String(OPENING_MOVE_CUTOFF),
    lossThreshold: '50',
    gainThreshold: '50',
  });
  const [dte, setDte] = useState<OpeningDteGroup>('0');
  const [driver, setDriver] = useState<OpeningDriver>('entryCredit');
  const [driverGroup, setDriverGroup] = useState<string>();
  const [selected, setSelected] = useState('');
  const [pins, setPins] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [exploreExpanded, setExploreExpanded] = useState(false);

  const dates = useRequest<OpeningDates>(
    `${OPENING_STRANGLE_API}/dates?${queryString(underlying, includeLocalOnly)}`,
    refresh,
  );
  const dateList = dates.data?.dates ?? [];
  const from = range?.from ?? dateList[0]?.date ?? '';
  const to = range?.to ?? dateList.at(-1)?.date ?? '';
  const rangeError = !!(from && to && from > to);
  const driverTab = tab === 'Curve drivers';
  const filters: OpeningFilters = {
    underlying,
    includeLocalOnly: dates.data?.includeLocalOnly,
    from: from || undefined,
    to: to || undefined,
    contract,
    expiry: expiry || undefined,
    onTimeOnly,
    unit,
    roundTripCost: cost || undefined,
    includeResearch: true,
  };
  const studyUrl =
    dates.data && dateList.length > 0 && !rangeError ? `${OPENING_STRANGLE_API}/study` : null;
  const study = useRequest<OpeningStudy>(studyUrl, refresh, JSON.stringify(filters));
  const driverStudy = useRequest<OpeningStudy>(
    driverTab ? studyUrl : null,
    refresh,
    JSON.stringify({ ...filters, includeResearch: false, driver, dte }),
  );
  const days = study.data?.days ?? EMPTY_DAYS;
  const displayedDays = useMemo(
    () => (cost ? days.map((day) => openingSummaryAfterCost(day, cost)) : days),
    [days, cost],
  );
  const apiHistory = study.data?.research?.rows;
  const useSnapshot = tab === 'Study report' && !!study.data && apiHistory === undefined;
  const snapshot = useOpeningSnapshot(useSnapshot ? underlying : null);
  const snapshotRows = useMemo(() => {
    const archive = snapshot.data;
    if (!archive) return undefined;
    const byDate = new Map(days.map((day) => [day.date, day]));
    return archive.rows.flatMap((row) => {
      const day = byDate.get(row.date);
      if (!day || archive.sources[row.date] !== day.source) return [];
      return [
        { ...row, features: { ...row.features, dte: day.dte, monthly: Number(day.monthly) } },
      ];
    });
  }, [days, snapshot.data]);
  const history: HistorySource = {
    rows: apiHistory ?? snapshotRows,
    loading: snapshot.loading,
    snapshotThrough: apiHistory === undefined ? snapshot.data?.through : undefined,
    error:
      useSnapshot && !snapshot.loading && !snapshot.data
        ? 'Full session curves and entry research require the updated Analysis API or a matching archive snapshot.'
        : undefined,
  };
  const active = study.data?.groups.find((group) => group.dte === dte);
  const expiryCostMismatch = !!study.data && cost !== (study.data.roundTripCost ?? 0);
  const members = displayedDays.filter((day) => day.dteGroup === dte);
  const pickedDate = days.some((day) => day.date === selected)
    ? selected
    : (days.at(-1)?.date ?? '');
  const singleTab = tab === 'Single day';
  const singleDate = singleTab ? pickedDate : null;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [tab, singleDate]);
  const dayUrl = (date: string) =>
    `${OPENING_STRANGLE_API}/day?${queryString(underlying, dates.data?.includeLocalOnly, date, onTimeOnly)}`;
  const single = useRequest<OpeningDay>(singleDate ? dayUrl(singleDate) : null, refresh);
  const pin = (date: string) =>
    setPins((values) =>
      values.includes(date)
        ? values.filter((v) => v !== date)
        : values.length < 6
          ? [...values, date]
          : values,
    );
  const navigate = (next: Tab) => {
    setTab(next);
    setExploreExpanded(next !== 'Study report' && next !== 'Single day');
  };
  const open = (date: string) => {
    setSelected(date);
    navigate('Single day');
  };
  const driverCostMismatch = !!driverStudy.data && cost !== (driverStudy.data.roundTripCost ?? 0);
  const driverResult = driverCostMismatch ? undefined : driverStudy.data?.driver;
  const driverSelection =
    driverResult?.groups.find((group) => group.label === driverGroup) ??
    driverResult?.groups.find((group) => group.n > 0) ??
    driverResult?.groups[0];
  const driverMembers = new Set(driverSelection?.dates);
  const visiblePins = pins.filter((date) => days.some((day) => day.date === date));
  const selectDte = (value: OpeningDteGroup) => {
    setDte(value);
    setDriverGroup(undefined);
  };
  const coverage = study.data && {
    missingClose: days.filter((day) => day.close == null).length,
    delayed: days.filter((day) => day.entry > 0).length,
    missingMarks: days.filter((day) => day.marked < day.possible).length,
  };
  const reportTab = tab === 'Study report';
  const studyTools = (
    <div className="flex flex-wrap items-start gap-2 text-xs">
      <details className="rounded border border-[var(--border)] px-2 py-1" open={filtersExpanded}>
        <summary
          className="cursor-pointer font-medium"
          onClick={(event) => {
            event.preventDefault();
            setFiltersExpanded((expanded) => !expanded);
          }}
        >
          Study filters
        </summary>
        <section
          aria-label="Study filters"
          className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-2 pb-1.5 text-xs"
        >
          <label className="grid gap-1">
            Index
            <select
              aria-label="Index"
              className={INPUT}
              value={underlying}
              onChange={(event) => {
                setUnderlying(event.target.value as SignalUnderlying);
                setRange(undefined);
                setIncludeLocalOnly(undefined);
                setExpiry('');
                setPins([]);
                setSelected('');
              }}
            >
              <option>NIFTY</option>
              <option>SENSEX</option>
            </select>
          </label>
          <label className="grid gap-1">
            From
            <input
              className={INPUT}
              type="date"
              value={from}
              onChange={(event) => {
                setRange({ from: event.target.value, to });
                setExpiry('');
              }}
            />
          </label>
          <label className="grid gap-1">
            To
            <input
              className={INPUT}
              type="date"
              value={to}
              onChange={(event) => {
                setRange({ from, to: event.target.value });
                setExpiry('');
              }}
            />
          </label>
          <button
            type="button"
            className={BUTTON}
            disabled={!range && !expiry}
            onClick={() => {
              setRange(undefined);
              setExpiry('');
            }}
          >
            All history
          </button>
          <label className="grid gap-1">
            Contract
            <select
              aria-label="Contract"
              className={INPUT}
              value={contract}
              onChange={(event) => {
                setContract(event.target.value as OpeningContract);
                setExpiry('');
              }}
            >
              <option value="all">All contracts</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
          <label className="grid gap-1">
            Expiry date
            <select
              aria-label="Expiry date"
              className={INPUT}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            >
              <option value="">All expiries</option>
              {[...new Set([...(study.data?.expiries ?? []), ...(expiry ? [expiry] : [])])]
                .sort()
                .reverse()
                .map((date) => (
                  <option key={date}>{date}</option>
                ))}
            </select>
          </label>
          <label className="grid gap-1">
            P&amp;L unit
            <select
              aria-label="P&L unit"
              className={INPUT}
              value={unit}
              onChange={(event) => setUnit(event.target.value as OpeningUnit)}
            >
              <option value="creditPct">% of entry credit</option>
              <option value="rupees">₹ per lot</option>
            </select>
          </label>
          <label className="flex min-h-[25px] items-center gap-1.5">
            <input
              type="checkbox"
              checked={includeLocalOnly ?? dates.data?.defaultIncludeLocalOnly ?? false}
              disabled={!dates.data}
              onChange={(event) => {
                setIncludeLocalOnly(event.target.checked);
                setExpiry('');
              }}
            />{' '}
            Include local-only history
          </label>
          <label className="flex min-h-[25px] items-center gap-1.5">
            <input
              type="checkbox"
              checked={onTimeOnly}
              onChange={(event) => setOnTimeOnly(event.target.checked)}
            />{' '}
            09:15 entries only
          </label>
          <button type="button" className={BUTTON} onClick={() => setRefresh((n) => n + 1)}>
            Refresh data
          </button>
        </section>
      </details>
      <details className="rounded border border-[var(--border)] px-2 py-1" open={exploreExpanded}>
        <summary
          className="cursor-pointer font-medium"
          onClick={(event) => {
            event.preventDefault();
            setExploreExpanded((expanded) => !expanded);
          }}
        >
          Explore sessions and expiry
        </summary>
        <div
          className="mt-2 flex flex-wrap gap-1 pb-1.5"
          role="group"
          aria-label="Opening P&L analysis views"
        >
          {TABS.map((value) => (
            <button
              key={value}
              type="button"
              className={`${BUTTON} ${value === tab ? '!border-[var(--accent)] text-[var(--accent)]' : ''}`}
              aria-pressed={tab === value}
              onClick={() => navigate(value)}
            >
              {value}
              {value === 'Compare dates' && pins.length > 0 ? ` (${pins.length})` : ''}
            </button>
          ))}
        </div>
      </details>
      <label className="flex flex-wrap items-center gap-1.5">
        Round-trip cost (₹/lot)
        <input
          type="number"
          min="0"
          step="0.01"
          className={`${INPUT} w-24`}
          value={costDraft}
          onChange={(event) => setCostDraft(event.currentTarget.value)}
          onBlur={(event) => {
            const amount = event.currentTarget.valueAsNumber;
            const next = Number.isFinite(amount) && amount > 0 ? amount : 0;
            setCost(next);
            setCostDraft(String(next));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
      </label>
      <span className="self-start py-1 text-[var(--text-muted)]">
        {cost ? 'Net combined P&L' : 'Gross combined P&L'}
      </span>
    </div>
  );

  return (
    <div
      ref={scroller}
      className="absolute inset-0 overflow-auto bg-[var(--bg-primary)] p-2.5 text-[13px] text-[var(--text-primary)] sm:p-3"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-2.5">
        {singleTab ? (
          <SingleDayHeader
            index={underlying}
            date={pickedDate}
            selected={selected}
            days={days}
            pinned={pins.includes(pickedDate)}
            pinLimit={pins.length === 6}
            onBack={() => navigate('Study report')}
            onDate={setSelected}
            onPin={pin}
          />
        ) : (
          !reportTab && <h2 className="text-base font-semibold">Opening OTM 2 P&amp;L</h2>
        )}
        {studyTools}

        {rangeError && <RequestNotice error="The start date must be on or before the end date." />}
        <RequestNotice
          loading={dates.loading || study.loading}
          error={dates.error ?? study.error}
        />
        {dates.data && dateList.length === 0 && (
          <p className="py-4 text-[var(--text-muted)]">
            No stored sessions for this index and source. Check Analysis data coverage or include
            local-only history.
          </p>
        )}

        {study.data && coverage && (
          <>
            {!reportTab && days.length === 0 && (
              <p className="rounded border border-[var(--border)] p-3 text-[var(--text-muted)]">
                No sessions match the selected study filters.
              </p>
            )}
            {!reportTab && !singleTab && (
              <div className="px-0.5 text-xs text-[var(--text-muted)]">
                {days.length} replayed · {coverage.delayed} later entries · {coverage.missingMarks}{' '}
                with missing combined marks · {coverage.missingClose} with no 15:29 close
                {' · '}
                {study.data.skipped.length} skipped
              </div>
            )}
            {!reportTab && !singleTab && study.data.skipped.length > 0 && (
              <details className="rounded border border-[var(--border)] px-2 py-1 text-xs">
                <summary className="cursor-pointer">Skipped sessions</summary>
                <ul className="max-h-40 overflow-auto pt-1">
                  {study.data.skipped.map((item) => (
                    <li key={item.date}>
                      {item.date} · {item.source} · {item.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {reportTab && (
              <OpeningStrangleHistory
                days={days}
                unit={unit}
                open={open}
                pin={pin}
                pins={pins}
                cost={cost}
                source={history}
                index={underlying}
                studyGroups={study.data.groups}
                skipped={study.data.skipped}
                onTimeOnly={onTimeOnly}
                controls={historyControls}
                onControls={setHistoryControls}
                onExpiry={() => navigate('Expiry study')}
                onTrades={() => navigate('All trades')}
              />
            )}
            {tab === 'Expiry study' && active && (
              <OpeningStrangleReport
                days={displayedDays}
                unit={unit}
                open={open}
                pin={pin}
                pins={pins}
                dte={dte}
                onDrivers={() => navigate('Curve drivers')}
                onDteChange={selectDte}
                expiry={
                  <>
                    {expiryCostMismatch ? (
                      <RequestNotice error="Net expiry curves and outcomes require the updated Analysis API." />
                    ) : (
                      <>
                        <OpeningChartCard
                          title="P&L by days to expiry"
                          description={`Median curves by trading days to expiry. Dashed lines mark P10 and P90 for ${active.label}.`}
                        >
                          <OpeningGroupChart
                            groups={study.data.groups}
                            active={active.label}
                            unit={unit}
                          />
                        </OpeningChartCard>
                        <OpeningChartCard
                          title="Expiry outcomes"
                          description="Closing statistics use observed 15:29 marks. Select a group to inspect its sessions."
                        >
                          <GroupTable
                            groups={study.data.groups}
                            unit={unit}
                            active={active.label}
                            select={(group) => selectDte(group.dte)}
                          />
                        </OpeningChartCard>
                      </>
                    )}
                    <OpeningChartCard title={`${active.label} sessions`}>
                      <SessionList days={members} unit={unit} open={open} pin={pin} pins={pins} />
                    </OpeningChartCard>
                  </>
                }
                attribution={
                  <OpeningAttributionChart
                    unit={unit}
                    description={`${active.label} means use the same modeled sessions for each component at each checkpoint.`}
                    points={active.attribution.map(({ minute, n, observed, mean }) => ({
                      minute,
                      forward: mean?.forward ?? null,
                      time: mean?.time ?? null,
                      iv: mean?.iv ?? null,
                      residual: mean?.residual ?? null,
                      actual: mean?.actual ?? null,
                      coverage: `${n}/${observed} observed sessions modeled`,
                    }))}
                  />
                }
              />
            )}
            {tab === 'All trades' && (
              <OpeningChartCard
                title="All trades"
                description="Every replayed session in the filters. Open a date or pin it for comparison."
              >
                <OpeningStrangleTrades
                  days={displayedDays}
                  unit={unit}
                  open={open}
                  pin={pin}
                  pins={pins}
                  searchable
                />
              </OpeningChartCard>
            )}
            {singleTab && (
              <>
                <RequestNotice loading={single.loading} error={single.error} />
                {single.data && (
                  <DayDetails
                    day={single.data}
                    underlying={underlying}
                    unit={unit}
                    cost={cost}
                    refresh={refresh}
                  />
                )}
              </>
            )}
            {tab === 'Compare dates' && (
              <>
                {pins.length > 0 && (
                  <div aria-label="Pinned dates" className="flex flex-wrap items-center gap-1.5">
                    {pins.map((date) => (
                      <button
                        type="button"
                        className={BUTTON}
                        key={date}
                        aria-label={`Unpin ${date}`}
                        onClick={() => pin(date)}
                      >
                        {date} ×
                      </button>
                    ))}
                  </div>
                )}
                {pins.length > visiblePins.length && (
                  <p className="text-xs text-[var(--text-muted)]">
                    {pins.length - visiblePins.length} pinned sessions outside the active filters.
                  </p>
                )}
                <CompareDates
                  urls={visiblePins.map(dayUrl)}
                  unit={unit}
                  cost={cost}
                  refresh={refresh}
                />
              </>
            )}
          </>
        )}

        {driverTab && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2">
                Days to expiry
                <select
                  aria-label="Days to expiry"
                  className={INPUT}
                  value={dte}
                  onChange={(event) => selectDte(event.target.value as OpeningDteGroup)}
                >
                  {OPENING_DTE_GROUPS.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                Condition
                <select
                  aria-label="Condition"
                  className={INPUT}
                  value={driver}
                  onChange={(event) => {
                    setDriver(event.target.value as OpeningDriver);
                    setDriverGroup(undefined);
                  }}
                >
                  {OPENING_DRIVERS.map((value) => (
                    <option key={value} value={value}>
                      {DRIVERS[value].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <RequestNotice loading={driverStudy.loading} error={driverStudy.error} />
            {driverCostMismatch && (
              <RequestNotice error="Net condition curves and outcomes require the updated Analysis API." />
            )}
            {driverResult && (
              <>
                <OpeningChartCard
                  title={DRIVERS[driver].label}
                  description={`${DRIVERS[driver].time} · ${dte} DTE · ${driverResult.missing} sessions missing this reading · Associations across observed sessions`}
                >
                  <OpeningGroupChart
                    groups={driverResult.groups}
                    active={driverSelection?.label}
                    unit={unit}
                  />
                </OpeningChartCard>
                <OpeningChartCard
                  title="Condition groups"
                  description={
                    driverResult.cutoffs
                      ? `Low through ${plainAmount(driverResult.cutoffs[0])}${DRIVERS[driver].suffix}. Middle through ${plainAmount(driverResult.cutoffs[1])}${DRIVERS[driver].suffix}.`
                      : driver === 'touch'
                        ? 'Touch is based on the underlying’s observed minute closes relative to the fixed strikes.'
                        : undefined
                  }
                >
                  <GroupTable
                    groups={driverResult.groups}
                    unit={unit}
                    active={driverSelection?.label}
                    select={(group) => setDriverGroup(group.label)}
                  />
                </OpeningChartCard>
                {driverSelection && (
                  <OpeningChartCard title={`${driverSelection.label} sessions`}>
                    <SessionList
                      days={displayedDays.filter((day) => driverMembers.has(day.date))}
                      unit={unit}
                      open={open}
                      pin={pin}
                      pins={pins}
                    />
                  </OpeningChartCard>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
