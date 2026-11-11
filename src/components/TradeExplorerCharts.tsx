/**
 * The Trade Explorer's analysis charts: where the losses sit, how one condition changes them, and
 * two conditions crossed in a grid. Clicking any bar, row or cell hands back the filters that keep
 * exactly those days.
 */
import {
  COLUMN_BY_KEY,
  REPORT_GROUPS,
  SMALL_SAMPLE,
  bucketRows,
  crossGrid,
  bucketFilter,
  lossBins,
  lossSummary,
  money,
  share,
  type Column,
  type ColumnFilter,
  type DayRow,
} from '../lib/tradeExplorer';

type ChartFilter = Array<[string, ColumnFilter]>;

/** Readings known at the signal that are worth cutting into bands. */
const BANDED = ['ivRatio', 'ivNow', 'gap', 'gapPct', 'morning', 'premium', 't2', 'wait'];

export default function TradeExplorerCharts({
  rows,
  bands,
  onFilter,
  compareBy,
  onCompare,
  gridBy,
  onGrid,
}: {
  rows: DayRow[];
  bands: number;
  onFilter: (picks: ChartFilter) => void;
  compareBy: string;
  onCompare: (key: string) => void;
  gridBy: [string, string];
  onGrid: (keys: [string, string]) => void;
}) {
  const values = rows.flatMap((r) =>
    typeof r.values.maxLoss === 'number' ? [r.values.maxLoss] : [],
  );
  const bins = lossBins(values);
  const largest = Math.max(1, ...bins.map((b) => b.count));
  const groupColumn = COLUMN_BY_KEY.get(compareBy) as Column;
  const groups = bucketRows(rows, groupColumn, bands).map((g) => ({
    ...g,
    summary: lossSummary(g.rows),
  }));
  const peak = Math.max(1, ...groups.map((g) => g.summary.median ?? 0));

  const downColumn = COLUMN_BY_KEY.get(gridBy[0]) as Column;
  const acrossColumn = COLUMN_BY_KEY.get(gridBy[1]) as Column;
  const grid = crossGrid(rows, downColumn, acrossColumn, bands);
  const hottest = Math.max(
    1,
    ...grid.cells.flatMap((line) =>
      line.flatMap((cell) =>
        // A handful of days can show any median, so they neither set the scale nor get a tint.
        cell.length >= SMALL_SAMPLE ? [lossSummary(cell).median ?? 0] : [],
      ),
    ),
  );
  const conditionOptions = (
    <>
      {(['entry', 'after'] as const).map((when) => (
        <optgroup key={when} label={when === 'entry' ? 'Known at entry' : 'What happened after'}>
          {REPORT_GROUPS.filter((g) => g.when === when).map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </optgroup>
      ))}
      <optgroup label="Readings at the signal, in bands">
        {BANDED.map((k) => (
          <option key={k} value={k}>
            {COLUMN_BY_KEY.get(k)?.title}
          </option>
        ))}
      </optgroup>
    </>
  );
  return (
    <div className="te-analysis">
      <section className="te-chart-card">
        <div className="te-card-heading">
          <div>
            <span className="te-eyebrow">RISK PROFILE</span>
            <h2>Where do losses concentrate?</h2>
          </div>
          <span className="te-badge">{values.length} days</span>
        </div>
        <p className="te-caption">
          Maximum intraday loss. Even steps up to the level one day in ten goes past, then one bar
          for everything beyond it. Click a bar to see its days.
        </p>
        <div className="te-histogram">
          {bins.map((b, i) => {
            const lastInner = !b.beyond && (i === bins.length - 1 || bins[i + 1].beyond);
            const range = b.beyond
              ? `Past ${money(b.lo)}, up to ${money(b.hi)}`
              : `${money(b.lo)} to ${money(b.hi)}`;
            return (
              <button
                key={i}
                type="button"
                disabled={!b.count}
                data-beyond={b.beyond}
                title={`${range}: ${b.count} days`}
                onClick={() =>
                  onFilter([
                    [
                      'maxLoss',
                      {
                        min: String(b.beyond ? b.lo + 1e-6 : b.lo),
                        max: String(b.beyond || lastInner ? b.hi : b.hi - 1e-6),
                      },
                    ],
                  ])
                }
              >
                <span className="te-bin-count">{b.count}</span>
                <span className="te-bin-track">
                  <span
                    className="te-bin-fill"
                    style={{ height: `${(b.count / largest) * 100}%` }}
                  />
                </span>
                <span className="te-bin-label">
                  {b.beyond ? `past ${money(b.lo)}` : money(b.lo)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="te-chart-foot">
          <span>Lower loss</span>
          <span>Maximum loss per lot →</span>
          <span>worst {money(values.length ? Math.max(...values) : null)}</span>
        </div>
        {!values.length && (
          <p>No loss readings in this selection. Clear a filter to broaden the sample.</p>
        )}
      </section>
      <section className="te-chart-card">
        <div className="te-card-heading">
          <div>
            <span className="te-eyebrow">COMPARE CONDITIONS</span>
            <h2>What changes the risk?</h2>
          </div>
          <select
            aria-label="Compare conditions"
            value={compareBy}
            onChange={(e) => onCompare(e.target.value)}
          >
            {conditionOptions}
          </select>
        </div>
        <p className="te-caption">Max loss by condition · click a row to see its days</p>
        <div className="te-comparison">
          <div className="te-compare-row te-compare-labels">
            <span>Condition</span>
            <span>Days</span>
            <span>Median</span>
            <span>1 in 10 past</span>
            <span>Closed red</span>
          </div>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="te-compare-row"
              onClick={() => onFilter([[groupColumn.key, bucketFilter(groupColumn, g)]])}
            >
              <span className="te-condition">
                <span>{g.label}</span>
                <i style={{ width: `${((g.summary.median ?? 0) / peak) * 100}%` }} />
              </span>
              <span
                className={g.rows.length < SMALL_SAMPLE ? 'te-small-sample' : ''}
                title={
                  g.rows.length < SMALL_SAMPLE
                    ? `Small sample: fewer than ${SMALL_SAMPLE} days`
                    : 'Sample size'
                }
              >
                {g.rows.length}
              </span>
              <span>{money(g.summary.median)}</span>
              <span>{money(g.summary.oneInTen)}</span>
              <span>{share(g.summary.closedRed)}</span>
            </button>
          ))}
        </div>
        <div className="te-chart-foot">
          Amber counts are fewer than {SMALL_SAMPLE} days. Groups under "What happened after" are
          hindsight.
        </div>
      </section>
      <section className="te-chart-card te-grid-card">
        <div className="te-card-heading">
          <div>
            <span className="te-eyebrow">TWO CONDITIONS AT ONCE</span>
            <h2>Does one condition change the other?</h2>
          </div>
          <div className="te-grid-picks">
            <label>
              Down
              <select
                aria-label="Grid rows"
                value={gridBy[0]}
                onChange={(e) => onGrid([e.target.value, gridBy[1]])}
              >
                {conditionOptions}
              </select>
            </label>
            <label>
              Across
              <select
                aria-label="Grid columns"
                value={gridBy[1]}
                onChange={(e) => onGrid([gridBy[0], e.target.value])}
              >
                {conditionOptions}
              </select>
            </label>
          </div>
        </div>
        <p className="te-caption">
          Each cell shows the median max loss with its number of days. A stronger tint means a
          larger median; cells with fewer than {SMALL_SAMPLE} days get no tint. Put Year across to
          check that a pattern holds every year. Click a cell to see its days.
        </p>
        {gridBy[0] === gridBy[1] ? (
          <p>Choose two different conditions.</p>
        ) : (
          <div className="te-grid-scroll">
            <table className="te-grid">
              <thead>
                <tr>
                  <th>
                    {downColumn.label} ↓ · {acrossColumn.label} →
                  </th>
                  {grid.across.map((b) => (
                    <th key={b.id}>{b.label}</th>
                  ))}
                  <th>All</th>
                </tr>
              </thead>
              <tbody>
                {grid.down.map((a, i) => (
                  <tr key={a.id}>
                    <th>{a.label}</th>
                    {grid.across.map((b, j) => {
                      const cell = grid.cells[i][j];
                      if (!cell.length) return <td key={b.id} className="te-grid-empty" />;
                      const s = lossSummary(cell);
                      const heat =
                        cell.length >= SMALL_SAMPLE
                          ? Math.round(Math.min(1, (s.median ?? 0) / hottest) * 55)
                          : 0;
                      return (
                        <td key={b.id} style={{ ['--heat' as string]: `${heat}%` }}>
                          <button
                            type="button"
                            title={`${a.label} · ${b.label}: 1 in 10 past ${money(s.oneInTen)}, worst ${money(s.worst)}, closed red ${share(s.closedRed)}`}
                            onClick={() =>
                              onFilter([
                                [downColumn.key, bucketFilter(downColumn, a)],
                                [acrossColumn.key, bucketFilter(acrossColumn, b)],
                              ])
                            }
                          >
                            <b>{money(s.median)}</b>
                            <span className={cell.length < SMALL_SAMPLE ? 'te-small-sample' : ''}>
                              {cell.length} days
                            </span>
                          </button>
                        </td>
                      );
                    })}
                    <td className="te-grid-total">
                      <b>{money(lossSummary(a.rows).median)}</b>
                      <span>{a.rows.length} days</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
