import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLUMN_BY_KEY,
  SIMILAR_KEY,
  filterActive,
  buildDayRows,
  formatCell,
  quantile,
  type Column,
  type DayRow,
  type Filters,
  type SimilarPlan,
} from '../lib/tradeExplorer';
import type { SignalUnderlying } from '../lib/signalBacktest';
import {
  applyCriteria,
  ladder,
  setLine,
  slimSet,
  type SavedCriteria,
  type SlimSet,
} from '../lib/tradeExplorerCompare';
import type { Outcome } from '../lib/tradeExplorerSplits';

// ── Strike distances ─────────────────────────────────────────────────────────

const slimSets = new Map<string, SlimSet>();
export function clearSlimSets() {
  slimSets.clear();
}

const SETS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
  key: `otm${n}`,
  label: n === 0 ? 'OTM 0 (ATM)' : `OTM ${n}`,
}));
const rupees = (v: number | null) =>
  v == null ? '–' : `₹${Math.round(v).toLocaleString('en-IN')}`;
const percent = (v: number | null, digits = 1) => (v == null ? '–' : `${v.toFixed(digits)}%`);

export function StrikeDistancesView(props: {
  rows: DayRow[];
  underlying: SignalUnderlying;
  tradeSet: string;
}) {
  const { rows, underlying } = props;
  const dates = useMemo(() => new Set(rows.map((r) => r.raw.date)), [rows]);
  const [, bump] = useState(0);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = async () => {
    for (const s of SETS) {
      if (!alive.current) return;
      const id = `${underlying}|${s.key}`;
      if (slimSets.has(id)) continue;
      setLoading(s.key);
      try {
        const res = await fetch(
          `/api/signal-backtest/explorer-sets?underlying=${underlying}&set=${s.key}`,
        );
        const body = await res.json();
        if (!res.ok || body?.ok === false || !body.rows) throw new Error('not available');
        slimSets.set(id, slimSet(buildDayRows(body.rows, underlying)));
        if (alive.current) bump((n) => n + 1);
      } catch {
        if (alive.current) setFailed((f) => new Set([...f, s.key]));
      }
    }
    if (alive.current) setLoading(null);
  };

  const onScreen = props.tradeSet === 'saved' ? 'otm2' : props.tradeSet;
  const anyLoaded = SETS.some((s) => slimSets.has(`${underlying}|${s.key}`));
  return (
    <section className="te-chart-card te-cmp-card">
      <div className="te-card-heading">
        <div>
          <span className="te-eyebrow">STRIKE DISTANCES</span>
        </div>
        <span className="te-badge">{rows.length} days</span>
      </div>
      <p className="te-caption">
        The same {rows.length} days, with a different strike distance sold. Rupees fall as you sell
        further out because less premium is collected; &quot;% of premium&quot; and &quot;days worse
        than its usual&quot; show whether the days were actually easier.
      </p>
      <div className="te-split-actions">
        <button type="button" disabled={loading != null} onClick={() => void load()}>
          Load the eight strike distances
        </button>
      </div>
      {(anyLoaded || loading != null || failed.size > 0) && (
        <div className="te-split-scroll">
          <table className="te-split-table te-cmp-table">
            <thead>
              <tr>
                <th>Strikes</th>
                <th>Days</th>
                <th>Median max loss</th>
                <th>1 in 10 past</th>
                <th>Median, % of premium</th>
                <th>Its usual day</th>
                <th>Days worse than its usual</th>
              </tr>
            </thead>
            <tbody>
              {SETS.map((s) => {
                const slim = slimSets.get(`${underlying}|${s.key}`);
                const line = slim ? setLine(dates, slim) : null;
                return (
                  <tr key={s.key}>
                    <td>
                      {s.label}
                      {s.key === onScreen && <span className="te-split-muted"> on screen</span>}
                    </td>
                    {line ? (
                      <>
                        <td>{line.days}</td>
                        <td>{rupees(line.medianLoss)}</td>
                        <td>{rupees(line.oneInTen)}</td>
                        <td>{percent(line.medianPct)}</td>
                        <td>{percent(line.usualPct)}</td>
                        <td>
                          {line.worseShare == null ? '–' : `${Math.round(line.worseShare * 100)}%`}
                        </td>
                      </>
                    ) : (
                      <td colSpan={6} className="te-split-muted">
                        {failed.has(s.key)
                          ? 'not available'
                          : loading === s.key
                            ? `Loading OTM ${s.key.slice(3)}…`
                            : ''}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ── Saved criteria ───────────────────────────────────────────────────────────

const MAX_SAVED = 12;
const MAX_TICKED = 3;

const summary = (c: SavedCriteria) => {
  const k = Object.entries(c.filters).filter(
    ([key, f]) => key !== SIMILAR_KEY && filterActive(f),
  ).length;
  const filters = k === 0 ? 'no filters' : `${k} filter${k === 1 ? '' : 's'}`;
  return c.similar ? `similar to ${c.similar.date} · ${filters}` : filters;
};

export function SavedCriteriaView(props: {
  allRows: DayRow[];
  outcome: Outcome;
  current: { filters: Filters; similar: SimilarPlan | null };
  saved: SavedCriteria[];
  onSaved(list: SavedCriteria[]): void;
  onLoad(c: SavedCriteria): void;
}) {
  const { allRows, outcome, saved } = props;
  const [name, setName] = useState('');
  const [ticked, setTicked] = useState<string[] | null>(null);
  const outCol = COLUMN_BY_KEY.get(outcome) as Column;
  const fmt = (v: number | null) => (v == null ? '–' : formatCell(outCol, v));
  const chosen = (ticked ?? saved.slice(0, MAX_TICKED).map((c) => c.name)).filter((n) =>
    saved.some((c) => c.name === n),
  );

  const values = useMemo(
    () =>
      allRows.flatMap((r) => {
        const v = r.values[outcome];
        return typeof v === 'number' ? [v] : [];
      }),
    [allRows, outcome],
  );
  const line = quantile(values, 0.5) ?? 0;
  const cuts = useMemo(() => [0.25, 0.5, 0.75].map((q) => quantile(values, q) ?? 0), [values]);
  const columns = useMemo(
    () => [
      { title: 'All days', rows: allRows },
      ...saved
        .filter((c) => chosen.includes(c.name))
        .map((c) => ({ title: c.name, rows: applyCriteria(allRows, c) })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, saved, chosen.join('|')],
  );
  const cols = columns.map((c) => ({ ...c, col: ladder(c.rows, outcome, line, cuts) }));

  const save = () => {
    const n = name.trim();
    if (!n) return;
    const next = [
      ...saved.filter((c) => c.name !== n),
      { name: n, filters: props.current.filters, similar: props.current.similar },
    ];
    props.onSaved(next.slice(-MAX_SAVED));
    setName('');
  };
  const toggle = (n: string) =>
    setTicked(
      chosen.includes(n)
        ? chosen.filter((x) => x !== n)
        : chosen.length < MAX_TICKED
          ? [...chosen, n]
          : chosen,
    );
  const bandLabels = [
    `Up to ${fmt(cuts[0])}`,
    `${fmt(cuts[0])} to ${fmt(cuts[1])}`,
    `${fmt(cuts[1])} to ${fmt(cuts[2])}`,
    `Above ${fmt(cuts[2])}`,
  ];

  return (
    <section className="te-chart-card te-cmp-card">
      <div className="te-card-heading">
        <div>
          <span className="te-eyebrow">SAVED CRITERIA</span>
        </div>
      </div>
      <div className="te-split-actions">
        <input
          type="text"
          className="te-cmp-name"
          placeholder="Name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <button type="button" disabled={!name.trim()} onClick={save}>
          Save the criteria on screen
        </button>
      </div>
      <div className="te-cmp-list">
        {saved.map((c) => (
          <div key={c.name} className="te-split-row">
            <input
              type="checkbox"
              aria-label={`Compare ${c.name}`}
              checked={chosen.includes(c.name)}
              disabled={!chosen.includes(c.name) && chosen.length >= MAX_TICKED}
              onChange={() => toggle(c.name)}
            />
            <strong>{c.name}</strong>
            <span className="te-split-muted">{summary(c)}</span>
            <button type="button" onClick={() => props.onLoad(c)}>
              Load
            </button>
            <button
              type="button"
              onClick={() => props.onSaved(saved.filter((x) => x.name !== c.name))}
            >
              Delete ×
            </button>
          </div>
        ))}
      </div>
      <p className="te-caption">
        Loss line and bands come from all {allRows.length} days of this trade set.
      </p>
      <div className="te-split-scroll">
        <table className="te-split-table te-cmp-table">
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c.title}>{c.title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row
              label="Days"
              cells={cols.map((c) => (c.col.days ? String(c.col.days) : 'not available here'))}
            />
            <Row label="Median max loss" cells={cols.map((c) => fmt(c.col.median))} />
            <Row label="1 in 10 past" cells={cols.map((c) => fmt(c.col.oneInTen))} />
            <Row label="Worst" cells={cols.map((c) => fmt(c.col.worst))} />
            <Row
              label={`Days above ${fmt(line)}`}
              cells={cols.map((c) =>
                c.col.aboveLine == null ? '–' : `${Math.round(c.col.aboveLine * 100)}%`,
              )}
            />
            {bandLabels.map((label, i) => (
              <Row
                key={label}
                label={label}
                cells={cols.map((c) =>
                  c.col.days
                    ? `${c.col.bands[i]} (${Math.round((c.col.bands[i] / c.col.days) * 100)}%)`
                    : '–',
                )}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ label, cells }: { label: string; cells: string[] }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      {cells.map((c, i) => (
        <td key={i}>{c}</td>
      ))}
    </tr>
  );
}
