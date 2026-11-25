import { useEffect, useMemo, useState } from 'react';
import { SavedCriteriaView, StrikeDistancesView } from './TradeExplorerCompareViews';
import { LossGroupsView, WorstCriteriaView } from './TradeExplorerLossViews';
import { RiskSignsView, RuleTesterView } from './TradeExplorerRiskViews';
import {
  COLUMN_BY_KEY,
  SMALL_SAMPLE,
  formatCell,
  quantile,
  type Column,
  type DayRow,
  type Filters,
  type SimilarPlan,
} from '../lib/tradeExplorer';
import type { SignalUnderlying } from '../lib/signalBacktest';
import type { SavedCriteria } from '../lib/tradeExplorerCompare';
import {
  AFTER_KEYS,
  ENTRY_KEYS,
  bandCompare,
  chanceWord,
  rankSplits,
  splitChances,
  type Outcome,
  type Split,
} from '../lib/tradeExplorerSplits';

export type SplitMode = 'groups' | 'worst' | 'risk' | 'rule' | 'split' | 'bands' | 'sets' | 'saved';

interface Props {
  rows: DayRow[];
  outcome: Outcome;
  onOutcome: (o: Outcome) => void;
  mode: SplitMode;
  onMode: (m: SplitMode) => void;
  trail: string[];
  onBack: () => void;
  onPick: (key: string, side: DayRow[], label: string, close: boolean) => void;
  onPickMany: (
    picks: Array<{ key: string; side: DayRow[]; label: string }>,
    close: boolean,
  ) => void;
  onOpenDay: (date: string) => void;
  underlying: SignalUnderlying;
  tradeSet: string;
  allRows: DayRow[];
  current: { filters: Filters; similar: SimilarPlan | null };
  saved: SavedCriteria[];
  onSaved: (list: SavedCriteria[]) => void;
  onLoad: (c: SavedCriteria) => void;
  /** The other index's days for the same trade set, once loaded. */
  other?: { name: string; rows: DayRow[] };
}

const MIN_DAYS = 16;
const BAND_CHOICES: Array<[string, number]> = [
  ['halves', 2],
  ['thirds', 3],
  ['fifths', 5],
];

const nums = (rows: DayRow[], key: string) =>
  rows.flatMap((r) => (typeof r.values[key] === 'number' ? [r.values[key] as number] : []));

function SideBlock(props: {
  tone: 'worse' | 'better';
  label: string;
  rows: DayRow[];
  outcome: Column;
  few: boolean;
  onFurther: () => void;
  onShow: () => void;
}) {
  const v = nums(props.rows, props.outcome.key);
  const f = (x: number | null) => (x == null ? '–' : formatCell(props.outcome, x));
  return (
    <div className={`te-split-block te-split-${props.tone}`}>
      <strong>{props.label}</strong>
      <span className="te-split-days">
        {props.rows.length} days{props.few ? ' (few)' : ''}
      </span>
      <dl>
        <dt>Median max loss</dt>
        <dd>{f(quantile(v, 0.5))}</dd>
        <dt>1 in 10 past</dt>
        <dd>{f(quantile(v, 0.9))}</dd>
        <dt>Worst</dt>
        <dd>{f(v.length ? Math.max(...v) : null)}</dd>
      </dl>
      <div className="te-split-actions">
        <button type="button" onClick={props.onFurther}>
          Split these further
        </button>
        <button type="button" onClick={props.onShow}>
          Show these days
        </button>
      </div>
    </div>
  );
}

export default function TradeExplorerSplits(props: Props) {
  const { rows, outcome, mode, trail } = props;
  const [showAfter, setShowAfter] = useState(false);
  const [bands, setBands] = useState(3);
  const [linePct, setLinePct] = useState(0.5);
  const [crossOn, setCrossOn] = useState(true);
  useEffect(() => setLinePct(0.5), [rows]);
  const keys = useMemo(
    () => (showAfter ? [...ENTRY_KEYS, ...AFTER_KEYS] : ENTRY_KEYS),
    [showAfter],
  );
  const outcomeCol = COLUMN_BY_KEY.get(outcome) as Column;
  const enough = rows.length >= MIN_DAYS;

  const ranked = useMemo(
    () => (mode === 'split' && enough ? rankSplits(rows, outcome, keys) : []),
    [mode, enough, rows, outcome, keys],
  );
  const compare = useMemo(
    () => (mode === 'bands' && enough ? bandCompare(rows, outcome, bands, keys) : null),
    [mode, enough, rows, outcome, keys, bands],
  );

  const [chances, setChances] = useState<{
    list: Split[];
    headline: number;
    perSplit: number[];
  } | null>(null);
  useEffect(() => {
    if (!ranked.length) return;
    let live = true;
    const t = setTimeout(() => {
      const res = splitChances(rows, outcome, keys, ranked);
      if (live) setChances({ list: ranked, ...res });
    }, 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [ranked, rows, outcome, keys]);
  const ready = chances && chances.list === ranked ? chances : null;

  const head = ranked[0];
  const headChance = ready ? ready.headline : null;
  const nothing = !head || (headChance != null && headChance >= 0.2);
  const word = (i: number) => (ready ? chanceWord(ready.perSplit[i]) : 'checking…');

  const canCrossCheck = mode === 'groups' || mode === 'worst';
  const isLoss = canCrossCheck || mode === 'risk';
  const lineValue = useMemo(() => {
    const v = quantile(nums(rows, outcome), linePct);
    return v == null ? '–' : formatCell(outcomeCol, v);
  }, [rows, outcome, linePct, outcomeCol]);

  const controls = (
    <div className="te-split-controls">
      <span>Measure loss in</span>
      <div className="te-split-seg">
        <button
          type="button"
          className={outcome === 'maxLoss' ? 'on' : ''}
          onClick={() => props.onOutcome('maxLoss')}
        >
          ₹ per lot
        </button>
        <button
          type="button"
          className={outcome === 'maxLossPct' ? 'on' : ''}
          onClick={() => props.onOutcome('maxLossPct')}
        >
          % of premium
        </button>
      </div>
      <span>View</span>
      <div className="te-split-seg">
        <button
          type="button"
          className={mode === 'groups' ? 'on' : ''}
          onClick={() => props.onMode('groups')}
        >
          Loss groups
        </button>
        <button
          type="button"
          className={mode === 'worst' ? 'on' : ''}
          onClick={() => props.onMode('worst')}
        >
          Worst criteria
        </button>
        <button
          type="button"
          className={mode === 'risk' ? 'on' : ''}
          onClick={() => props.onMode('risk')}
        >
          Risk signs
        </button>
        <button
          type="button"
          className={mode === 'rule' ? 'on' : ''}
          onClick={() => props.onMode('rule')}
        >
          Rule tester
        </button>
        <button
          type="button"
          className={mode === 'split' ? 'on' : ''}
          onClick={() => props.onMode('split')}
        >
          Natural split
        </button>
        <button
          type="button"
          className={mode === 'bands' ? 'on' : ''}
          onClick={() => props.onMode('bands')}
        >
          Split by loss size
        </button>
        <button
          type="button"
          className={mode === 'sets' ? 'on' : ''}
          onClick={() => props.onMode('sets')}
        >
          Strike distances
        </button>
        <button
          type="button"
          className={mode === 'saved' ? 'on' : ''}
          onClick={() => props.onMode('saved')}
        >
          Saved criteria
        </button>
      </div>
      {canCrossCheck && props.other && (
        <label>
          <input type="checkbox" checked={crossOn} onChange={(e) => setCrossOn(e.target.checked)} />{' '}
          Cross-check on {props.other.name}
        </label>
      )}
      {isLoss ? (
        <label>
          Loss line{' '}
          <input
            type="range"
            min={0.3}
            max={0.9}
            step={0.05}
            value={linePct}
            onChange={(e) => setLinePct(Number(e.target.value))}
          />{' '}
          {lineValue} · top {Math.round(100 - linePct * 100)}% of days
        </label>
      ) : mode === 'split' || mode === 'bands' ? (
        <label>
          <input
            type="checkbox"
            checked={showAfter}
            onChange={(e) => setShowAfter(e.target.checked)}
          />{' '}
          Also show what happened after entry
        </label>
      ) : null}
      {trail.length > 0 && (
        <span className="te-split-trail">
          All chosen days › {trail.join(' › ')}{' '}
          <button type="button" onClick={props.onBack}>
            ← Back
          </button>
        </span>
      )}
    </div>
  );

  if (!enough && (mode === 'split' || mode === 'bands')) {
    return (
      <div className="te-split">
        {controls}
        <p className="te-caption">Too few days to compare ({rows.length}). Widen the criteria.</p>
      </div>
    );
  }

  const few = (n: number) => n < SMALL_SAMPLE;
  const med = (rs: DayRow[]) => formatCell(outcomeCol, quantile(nums(rs, outcome), 0.5));

  return (
    <div className="te-split">
      {controls}
      {mode === 'groups' && (
        <LossGroupsView
          rows={rows}
          outcome={outcome}
          linePct={linePct}
          onPick={props.onPickMany}
          onOpenDay={props.onOpenDay}
          other={crossOn ? props.other : undefined}
        />
      )}
      {mode === 'worst' && (
        <WorstCriteriaView
          rows={rows}
          outcome={outcome}
          linePct={linePct}
          onPick={props.onPickMany}
          onOpenDay={props.onOpenDay}
          other={crossOn ? props.other : undefined}
        />
      )}
      {mode === 'risk' && (
        <RiskSignsView
          rows={rows}
          allRows={props.allRows}
          outcome={outcome}
          linePct={linePct}
          onPick={props.onPickMany}
        />
      )}
      {mode === 'rule' && (
        <RuleTesterView
          key={props.underlying}
          rows={rows}
          allRows={props.allRows}
          outcome={outcome}
          underlying={props.underlying}
          tradeSet={props.tradeSet}
          onPick={props.onPickMany}
        />
      )}
      {mode === 'sets' && (
        <StrikeDistancesView
          key={props.underlying}
          rows={rows}
          underlying={props.underlying}
          tradeSet={props.tradeSet}
        />
      )}
      {mode === 'saved' && (
        <SavedCriteriaView
          allRows={props.allRows}
          underlying={props.underlying}
          outcome={outcome}
          current={props.current}
          saved={props.saved}
          onSaved={props.onSaved}
          onLoad={props.onLoad}
        />
      )}
      {mode === 'split' && (
        <>
          <section className="te-chart-card">
            <div className="te-card-heading">
              <div>
                <span className="te-eyebrow">BIGGEST DIFFERENCE</span>
                <h2>{nothing ? 'Nothing clearly separates these days' : head.worseLabel}</h2>
              </div>
              <span className="te-badge">{rows.length} days</span>
            </div>
            {nothing ? (
              <p className="te-caption">Try more days, or a different measure.</p>
            ) : (
              <>
                <div className="te-split-blocks">
                  <SideBlock
                    tone="worse"
                    label={head.worseLabel}
                    rows={head.worse}
                    outcome={outcomeCol}
                    few={few(head.worse.length)}
                    onFurther={() => props.onPick(head.key, head.worse, head.worseLabel, false)}
                    onShow={() => props.onPick(head.key, head.worse, head.worseLabel, true)}
                  />
                  <SideBlock
                    tone="better"
                    label={head.betterLabel}
                    rows={head.better}
                    outcome={outcomeCol}
                    few={few(head.better.length)}
                    onFurther={() => props.onPick(head.key, head.better, head.betterLabel, false)}
                    onShow={() => props.onPick(head.key, head.better, head.betterLabel, true)}
                  />
                </div>
                <p className="te-caption">
                  {ready && <span className="te-badge">{chanceWord(ready.headline)}</span>}
                  {head.same.length > 0 && <> Same days as: {head.same.join(', ')}.</>}
                  {head.blank > 0 && <> {head.blank} days have no reading.</>}
                  {(few(head.worse.length) || few(head.better.length)) && (
                    <> Few days: one day can move these figures.</>
                  )}
                </p>
              </>
            )}
          </section>
          <section className="te-chart-card">
            <div className="te-card-heading">
              <div>
                <span className="te-eyebrow">ALL READINGS</span>
                <h2>Where were losses highest?</h2>
              </div>
            </div>
            <div className="te-split-list">
              {ranked.map((s, i) => (
                <div className="te-split-row" key={s.key}>
                  <button
                    type="button"
                    onClick={() => props.onPick(s.key, s.worse, s.worseLabel, false)}
                  >
                    {s.worseLabel} · {s.worse.length} days · {med(s.worse)}
                  </button>
                  <span className="te-split-vs">against</span>
                  <button
                    type="button"
                    onClick={() => props.onPick(s.key, s.better, s.betterLabel, false)}
                  >
                    {s.betterLabel} · {s.better.length} days · {med(s.better)}
                  </button>
                  <span className="te-split-word">{word(i)}</span>
                  {s.same.length > 0 && (
                    <span className="te-split-muted">Same days as {s.same.join(', ')}</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {mode === 'bands' && compare && (
        <section className="te-chart-card">
          <div className="te-card-heading">
            <div>
              <span className="te-eyebrow">LOSS SIZE</span>
              <h2>What changes from small losses to big ones?</h2>
            </div>
            <select value={bands} onChange={(e) => setBands(Number(e.target.value))}>
              {BAND_CHOICES.map(([name, n]) => (
                <option key={name} value={n}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="te-split-scroll">
            <table className="te-split-table">
              <thead>
                <tr>
                  <th />
                  {compare.groups.map((g) => (
                    <th key={g.id}>
                      <button
                        type="button"
                        onClick={() => props.onPick(outcome, g.rows, g.label, false)}
                      >
                        {g.label}
                      </button>
                      <span className="te-split-muted">
                        {g.rows.length} days{few(g.rows.length) ? ' · few' : ''}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compare.lines.map((l) => (
                  <tr key={l.key}>
                    <th>{l.label}</th>
                    {l.cells.map((cell, i) => (
                      <td key={i}>
                        {l.column.type === 'cat'
                          ? `${formatCell(l.column, cell.value)} (${
                              cell.share == null ? '–' : Math.round(cell.share * 100)
                            }%)`
                          : formatCell(l.column, cell.value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
