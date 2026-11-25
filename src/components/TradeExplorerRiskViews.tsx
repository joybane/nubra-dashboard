import { useState } from 'react';
import type { SignalUnderlying } from '../lib/signalBacktest';
import {
  COLUMN_BY_KEY,
  formatCell,
  quantile,
  riskCuts,
  RISK_SIGNS,
  type DayRow,
} from '../lib/tradeExplorer';
import { setLine, type SetLine } from '../lib/tradeExplorerCompare';
import { riskLadder, riskOutcomes, riskSignTable, ruleYears } from '../lib/tradeExplorerRisk';
import type { Outcome } from '../lib/tradeExplorerSplits';
import { percent, rupees, SETS, useSlimSets } from './TradeExplorerCompareViews';
import { InfoBox } from './TradeExplorerLossViews';

interface ViewProps {
  rows: DayRow[];
  allRows: DayRow[];
  outcome: Outcome;
  onPick: (picks: Array<{ key: string; side: DayRow[]; label: string }>, close: boolean) => void;
}

const sharePercent = (value: number | null) => percent(value == null ? null : value * 100, 0);

export function RiskSignsView({
  rows,
  allRows,
  outcome,
  linePct,
  onPick,
}: ViewProps & { linePct: number }) {
  const [openSign, setOpenSign] = useState<string | null>(null);
  if (rows.length < 30)
    return <p className="te-caption">Too few days ({rows.length}). Widen the criteria.</p>;

  const outcomeCol = COLUMN_BY_KEY.get(outcome)!;
  const line = quantile(riskOutcomes(rows, outcome), linePct);
  const fmt = (value: number | null) => formatCell(outcomeCol, value);
  const cuts = riskCuts(allRows);
  const signs = riskSignTable(rows, outcome, line ?? Infinity, cuts);
  const ladder = riskLadder(rows, outcome, line ?? Infinity);

  return (
    <section className="te-chart-card te-cmp-card">
      <div className="te-card-heading">
        <div>
          <span className="te-eyebrow">RISK SIGNS</span>
          <h2>How did these days do, by number of signs?</h2>
        </div>
      </div>
      <p className="te-caption">
        Four signs known at the signal. Cut-offs come from all {allRows.length} days of this trade
        set.
      </p>
      <ul className="te-risk-signs">
        {RISK_SIGNS.map((sign) => {
          const col = COLUMN_BY_KEY.get(sign.key)!;
          const cut = formatCell(col, cuts[sign.id]);
          const open = openSign === sign.id;
          return (
            <li key={sign.id}>
              <span>
                {sign.label}: {col.label} {sign.id === 'gap' ? cut.replace(/^₹/, '') : cut} or{' '}
                {sign.side === 'le' ? 'less' : 'more'}
              </span>{' '}
              <button
                type="button"
                className="te-loss-help"
                aria-expanded={open}
                aria-label={'What is this reading? ' + col.label}
                title="What is this reading?"
                onClick={() => setOpenSign(open ? null : sign.id)}
              >
                ?
              </button>
              {open && <InfoBox keys={[sign.key]} />}
            </li>
          );
        })}
      </ul>
      <div className="te-split-scroll">
        <table className="te-split-table te-cmp-table">
          <thead>
            <tr>
              <th>Signs</th>
              <th>Days</th>
              <th>Above {fmt(line)}</th>
              <th>Median max loss</th>
              <th>1 in 10 past</th>
              <th>Strike touched</th>
            </tr>
          </thead>
          <tbody>
            {ladder.map((row) => (
              <tr
                key={row.label}
                className={row.label === '3 or more' ? 'te-risk-combined' : undefined}
              >
                <th scope="row">
                  <button
                    type="button"
                    className="te-loss-label"
                    onClick={() =>
                      onPick(
                        [{ key: 'warnCount', side: row.rows, label: 'Risk signs: ' + row.label }],
                        false,
                      )
                    }
                  >
                    {row.label}
                  </button>
                </th>
                <td>
                  {row.days}
                  {row.days < 20 && <span className="te-split-muted"> few</span>}
                </td>
                <td>{sharePercent(row.above)}</td>
                <td>{fmt(row.median)}</td>
                <td>{fmt(row.oneInTen)}</td>
                <td>{sharePercent(row.touched)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="te-risk-subheading">Each sign on its own</h3>
      <div className="te-split-scroll">
        <table className="te-split-table te-cmp-table">
          <thead>
            <tr>
              <th>Sign</th>
              <th>Days with it</th>
              <th>Above the line with it</th>
              <th>Without it</th>
            </tr>
          </thead>
          <tbody>
            {signs.map((row, index) => (
              <tr key={row.id}>
                <th scope="row">
                  <button
                    type="button"
                    className="te-loss-label"
                    onClick={() =>
                      onPick(
                        [{ key: RISK_SIGNS[index].key, side: row.rows, label: row.label }],
                        false,
                      )
                    }
                  >
                    {row.label}
                  </button>
                </th>
                <td>{row.days}</td>
                <td>{sharePercent(row.aboveWith)}</td>
                <td>{sharePercent(row.aboveWithout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const RULE_CHOICES = [
  { count: 2, label: '2 or more risk signs' },
  { count: 3, label: '3 or more risk signs' },
  { count: 4, label: '4 risk signs' },
];

function DistanceCells({ line }: { line: SetLine }) {
  return (
    <>
      <td>{line.days}</td>
      <td>{rupees(line.medianLoss)}</td>
      <td>{rupees(line.oneInTen)}</td>
      <td>{percent(line.medianPct)}</td>
      <td>{sharePercent(line.touchedShare)}</td>
    </>
  );
}

export function RuleTesterView({
  rows,
  allRows,
  outcome,
  underlying,
  tradeSet,
  onPick,
}: ViewProps & { underlying: SignalUnderlying; tradeSet: string }) {
  const { get, load, loading, anyLoaded, failed } = useSlimSets(underlying);
  if (rows.length === allRows.length) {
    return (
      <>
        <p className="te-caption">
          Choose the days to test first. Filter the table, click a line in Worst criteria, or use
          one of these:
        </p>
        <div className="te-split-actions">
          {RULE_CHOICES.map(({ count, label }) => (
            <button
              key={count}
              type="button"
              onClick={() => {
                const side = allRows.filter((row) => Number(row.values.warnCount) >= count);
                onPick([{ key: 'warnCount', side, label }], false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </>
    );
  }

  const line = quantile(riskOutcomes(allRows, outcome), 0.5);
  const flaggedDates = new Set(rows.map((row) => row.raw.date));
  const otherDates = new Set(
    allRows.map((row) => row.raw.date).filter((date) => !flaggedDates.has(date)),
  );
  const years = ruleYears(allRows, flaggedDates, outcome, line ?? Infinity);
  const onScreen = tradeSet === 'saved' ? 'otm2' : tradeSet;
  const hasResults = anyLoaded || failed.size > 0 || loading != null;
  const hasPendingSets = SETS.some(({ key }) => !get(key) && !failed.has(key));
  const distanceHeaders = [
    'Days',
    'Median max loss',
    '1 in 10 past',
    'Median, % of premium',
    'Strike touched',
  ];

  return (
    <section className="te-chart-card te-cmp-card">
      <div className="te-card-heading">
        <div>
          <span className="te-eyebrow">RULE TESTER</span>
          <h2>What if these {rows.length} days had been treated differently?</h2>
        </div>
      </div>
      <p className="te-caption">
        Flagged days are the days on screen. The loss line is{' '}
        {formatCell(COLUMN_BY_KEY.get(outcome)!, line)}, the median of all {allRows.length} days of
        this trade set.
      </p>
      <h3 className="te-risk-subheading">If you had skipped them</h3>
      <div className="te-split-scroll">
        <table className="te-split-table te-cmp-table">
          <thead>
            <tr>
              <th>Year</th>
              <th>Days</th>
              <th>Flagged</th>
              <th>Flagged, above the line</th>
              <th>Flagged, below the line</th>
              <th>Other days above the line</th>
              <th>All days above the line</th>
            </tr>
          </thead>
          <tbody>
            {years.map((year) => (
              <tr
                key={year.year}
                className={year.year === 'All years' ? 'te-risk-total' : undefined}
              >
                <th scope="row">{year.year}</th>
                <td>{year.days}</td>
                <td>{year.flagged}</td>
                <td>{year.flaggedAbove}</td>
                <td>{year.flaggedBelow}</td>
                <td>{sharePercent(year.restAbove)}</td>
                <td>{sharePercent(year.allAbove)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="te-risk-subheading">If you had sold further out on them</h3>
      {hasPendingSets && (
        <div className="te-split-actions">
          <button type="button" disabled={loading != null} onClick={() => void load()}>
            Load the eight strike distances
          </button>
        </div>
      )}
      {hasResults && (
        <>
          <div className="te-split-scroll">
            <table className="te-split-table te-cmp-table te-risk-distances">
              <thead>
                <tr>
                  <th rowSpan={2}>Strikes</th>
                  <th scope="colgroup" colSpan={5}>
                    Flagged days
                  </th>
                  <th scope="colgroup" colSpan={5}>
                    Other days
                  </th>
                </tr>
                <tr>
                  {['flagged', 'other'].flatMap((group) =>
                    distanceHeaders.map((header) => (
                      <th scope="col" key={group + header}>
                        {header}
                      </th>
                    )),
                  )}
                </tr>
              </thead>
              <tbody>
                {SETS.map(({ key, label }) => {
                  const slim = get(key);
                  return (
                    <tr key={key}>
                      <th scope="row">
                        {label}
                        {key === onScreen && <span className="te-split-muted"> on screen</span>}
                      </th>
                      {slim ? (
                        <>
                          <DistanceCells line={setLine(flaggedDates, slim)} />
                          <DistanceCells line={setLine(otherDates, slim)} />
                        </>
                      ) : (
                        <td colSpan={10} className="te-split-muted">
                          {failed.has(key)
                            ? 'not available'
                            : loading === key
                              ? 'Loading OTM ' + key.slice(3) + '…'
                              : ''}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="te-caption">
            Selling further out collects less premium, so rupees fall while &quot;% of premium&quot;
            can rise. &quot;Strike touched&quot; shows how often spot reached a sold strike.
          </p>
        </>
      )}
    </section>
  );
}
