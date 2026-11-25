import { useMemo, useState } from 'react';
import {
  formatPnl,
  type OpeningDaySummary,
  type OpeningEntryFeature,
} from '../lib/openingStrangle';
import {
  OPENING_ENTRY_FEATURE_META,
  type OpeningEntryAnalysis,
  type OpeningRuleStats,
} from '../lib/openingResearch';
import { OpeningChartCard } from './OpeningStrangleCharts';

const CELL = 'whitespace-nowrap border-b border-[var(--border)] px-2 py-1.5 text-right';
const LINK = 'text-[var(--accent)] hover:underline';
const CONTROL = 'rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs';
const money = (value: number | null) => formatPnl(value, 'rupees');
const rate = (value: number | null) => formatPnl(value, 'creditPct');
const RANGE_DASH = '—';

function sample(stats: OpeningRuleStats) {
  return `${stats.n}/${stats.eligible}`;
}

function Baseline({ result }: { result: OpeningEntryAnalysis }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table aria-label="Entry research baseline" className="w-full text-xs tabular-nums">
        <thead>
          <tr>
            {[
              'Baseline',
              'Dates',
              'Trades / eligible',
              'Net expectancy',
              'Total net P&L',
              'Win rate',
              'P10 net',
              'Median drawdown',
            ].map((header, i) => (
              <th scope="col" key={header} className={`${CELL} ${i === 0 ? 'text-left' : ''}`}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(
            [
              ['Older discovery', result.discovery],
              ['Later validation', result.holdout],
            ] as const
          ).map(([name, period]) => (
            <tr key={name}>
              <th scope="row" className={`${CELL} text-left`}>
                {name}
              </th>
              <td className={CELL}>
                {period.from ? `${period.from} to ${period.to}` : RANGE_DASH}
              </td>
              <td className={CELL}>{sample(period.baseline)}</td>
              <td className={CELL}>{money(period.baseline.meanNet)}</td>
              <td className={CELL}>{money(period.baseline.totalNet)}</td>
              <td className={CELL}>{rate(period.baseline.winRate)}</td>
              <td className={CELL}>{money(period.baseline.p10Net)}</td>
              <td className={CELL}>{money(period.baseline.medianDrawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OpeningStrangleEntryResearch({
  days,
  result,
  readings,
  filteredCount,
  snapshotThrough,
  loading,
  cost,
  open,
  pin,
  pins,
}: {
  days: OpeningDaySummary[];
  result?: OpeningEntryAnalysis;
  readings: number;
  filteredCount: number;
  snapshotThrough?: string;
  loading: boolean;
  cost: number;
  open: (date: string) => void;
  pin: (date: string) => void;
  pins: string[];
}) {
  const [feature, setFeature] = useState<'all' | OpeningEntryFeature>('all');
  const [selected, setSelected] = useState('');
  const dates = useMemo(() => new Map(days.map((day) => [day.date, day])), [days]);
  const candidates =
    result?.candidates.filter((candidate) => feature === 'all' || candidate.feature === feature) ??
    [];
  const validatedCount = candidates.filter((candidate) => candidate.validated).length;
  const active = candidates.find((candidate) => candidate.key === selected);
  const features = [...new Set(result?.candidates.map((candidate) => candidate.feature))];

  return (
    <OpeningChartCard
      title="Entry-only research"
      description="Conditions use information available at entry. They are chosen on older discovery sessions and measured unchanged on later validation sessions. Both periods show the same-period unfiltered baseline."
    >
      {loading ? (
        <p role="status" className="py-3 text-xs text-[var(--text-muted)]">
          Calculating entry conditions…
        </p>
      ) : !result ? (
        <p className="py-3 text-xs text-[var(--text-muted)]">
          Entry readings are unavailable for this data source.
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-end gap-3 text-xs">
            <label className="grid gap-1">
              Entry reading
              <select
                className={CONTROL}
                aria-label="Entry reading"
                value={feature}
                onChange={(event) => {
                  setFeature(event.target.value as 'all' | OpeningEntryFeature);
                  setSelected('');
                }}
              >
                <option value="all">All readings</option>
                {features.map((key) => (
                  <option key={key} value={key}>
                    {OPENING_ENTRY_FEATURE_META[key].label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[var(--text-muted)]">
              {readings} of {filteredCount} sessions have entry readings · {money(cost)} round-trip
              per lot
            </p>
          </div>
          {snapshotThrough && (
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Discovery and validation use dates matched to the archive snapshot through{' '}
              {snapshotThrough}.
            </p>
          )}
          <Baseline result={result} />
          <p role="status" className="mt-2 text-xs font-semibold">
            {validatedCount} of {candidates.length} entry conditions cleared validation checks.
          </p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            A condition needs at least 30 discovery trades and 15 validation trades, higher net
            P&amp;L per eligible session than each period’s baseline, and positive total net P&amp;L
            with higher expectancy in validation.
          </p>
          {candidates.length ? (
            <div className="mt-3 overflow-x-auto">
              <table
                aria-label="Entry conditions and validation"
                className="w-full text-xs tabular-nums"
              >
                <thead>
                  <tr>
                    {[
                      'Entry condition',
                      'Discovery trades',
                      'Discovery expectancy',
                      'Validation trades',
                      'Take rate',
                      'Validation expectancy',
                      'Validation total',
                      'Win rate',
                      'P10 net',
                      'Median drawdown',
                      'Missing reading',
                      'Result',
                    ].map((header, i) => (
                      <th
                        scope="col"
                        key={header}
                        className={`${CELL} ${i === 0 ? 'text-left' : ''}`}
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((candidate) => (
                    <tr
                      key={candidate.key}
                      className={candidate.key === selected ? 'bg-[var(--bg-secondary)]' : ''}
                    >
                      <th scope="row" className={`${CELL} text-left`}>
                        <button
                          type="button"
                          className={LINK}
                          aria-pressed={selected === candidate.key}
                          onClick={() =>
                            setSelected(selected === candidate.key ? '' : candidate.key)
                          }
                        >
                          <span className="font-semibold">
                            {OPENING_ENTRY_FEATURE_META[candidate.feature].label}
                          </span>
                          {' · '}
                          {candidate.condition}
                        </button>
                      </th>
                      <td className={CELL}>{sample(candidate.discovery)}</td>
                      <td className={CELL}>{money(candidate.discovery.meanNet)}</td>
                      <td className={CELL}>{sample(candidate.holdout)}</td>
                      <td className={CELL}>{rate(candidate.holdout.takeRate)}</td>
                      <td className={CELL}>{money(candidate.holdout.meanNet)}</td>
                      <td className={CELL}>{money(candidate.holdout.totalNet)}</td>
                      <td className={CELL}>{rate(candidate.holdout.winRate)}</td>
                      <td className={CELL}>{money(candidate.holdout.p10Net)}</td>
                      <td className={CELL}>{money(candidate.holdout.medianDrawdown)}</td>
                      <td className={CELL}>{candidate.missingHoldout}</td>
                      <td className={CELL}>
                        {candidate.validated ? 'Cleared validation checks' : 'Exploratory'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                P&amp;L is net in rupees per lot. Take rate is the share of eligible sessions taken
                by a condition. Missing entry readings are shown separately. Select a condition for
                its later validation dates.
              </p>
            </div>
          ) : (
            <p className="py-3 text-xs text-[var(--text-muted)]">
              No entry conditions qualified in the discovery sample for these filters.
            </p>
          )}
          {active && (
            <div className="mt-3 rounded border border-[var(--border)] p-2 text-xs">
              <h4 className="font-semibold">Validation dates · {active.label}</h4>
              <p className="mt-1 text-[var(--text-muted)]">
                {money(active.holdout.netPerEligible)} net per eligible session ·{' '}
                {active.missingDiscovery} missing discovery readings · {active.missingHoldout}{' '}
                missing validation readings
              </p>
              {active.holdoutDates.length ? (
                <div className="mt-2 max-h-52 overflow-auto">
                  <ul className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
                    {[...active.holdoutDates].reverse().map((date) => {
                      const day = dates.get(date);
                      const pinned = pins.includes(date);
                      return (
                        <li
                          key={date}
                          className="flex items-center justify-between gap-2 rounded bg-[var(--bg-secondary)] px-2 py-1 tabular-nums"
                        >
                          <button type="button" className={LINK} onClick={() => open(date)}>
                            {date}
                          </button>
                          <span>{money(day?.close != null ? day.close - cost : null)}</span>
                          <button
                            type="button"
                            className={`${CONTROL} disabled:opacity-45`}
                            aria-label={`${pinned ? 'Unpin' : 'Pin'} ${date}`}
                            aria-pressed={pinned}
                            disabled={!pinned && pins.length === 6}
                            onClick={() => pin(date)}
                          >
                            {pinned ? 'Unpin' : 'Pin'}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="mt-2 text-[var(--text-muted)]">
                  No closed validation trades matched this condition.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </OpeningChartCard>
  );
}
