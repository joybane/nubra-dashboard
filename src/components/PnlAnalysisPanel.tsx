/**
 * The Signal Backtest tab's P&L analysis, on the rows the day filter leaves: where targets and
 * stop-losses get hit (and where they never do), what a target and a stop do together, how the
 * results are spread, what paths trades take, and which conditions the biggest losses and wins come
 * from. Every level is taken from the data; the person picks, or types their own.
 *
 * Capital is the premium collected, (CE + PE) × lot size — the most a short trade can make.
 */
import { Fragment, useMemo } from 'react';
import { dteShort, pnlClass, type SignalBacktestRow } from '../lib/signalBacktest';
import {
  GRID_SL_SHARES,
  GRID_TARGET_SHARES,
  PATH_LABEL,
  axisLevels,
  bestPlan,
  boundaries,
  drivers,
  excursions,
  extremeHours,
  hasPnlPaths,
  levelRows,
  pathGroups,
  planStats,
  slices,
  standouts,
  type Boundaries,
  type Driver,
  type ExitPlan,
  type LevelRow,
  type PlanStats,
  type PnlUnit,
} from '../lib/pnlAnalysis';

const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';
const inputCls =
  'h-7 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';
const thCls = 'px-2 py-1 font-normal';
const tdCls = 'px-2 py-0.5';
const sectionTitleCls = 'mb-1 text-[12px] font-semibold';
const noteCls = 'mb-1.5 text-[11px] text-[var(--text-muted)]';
const LOSS = '#ef4444';
const WIN = '#22c55e';

function rs(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
}
const pctText = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(n > 0 && n < 1 ? 1 : 0)}%`;
/** A size in the chosen unit: % of capital or ₹ per lot. */
function sz(v: number, unit: PnlUnit, signed = false): string {
  if (unit === 'rs') return rs(v, signed);
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  const a = Math.abs(v);
  return `${sign}${a.toFixed(a < 10 ? 1 : 0)}%`;
}
const shareText = (s: number) => `${Math.round(s * 100)}% of days`;

export default function PnlAnalysisPanel({
  rows,
  lots,
  plan,
  onPlan,
  filterLabel,
}: {
  rows: SignalBacktestRow[];
  /** The run's lots: P&L totals are for them, ₹ sizes are per lot. */
  lots: number;
  plan: ExitPlan;
  onPlan: (patch: Partial<ExitPlan>) => void;
  /** What the day filter keeps, or null when it is off. */
  filterLabel: string | null;
}) {
  const ready = hasPnlPaths(rows);
  const { unit } = plan;

  // Everything that depends only on the rows and the unit.
  const base = useMemo(() => {
    if (!ready) return null;
    const peaks = excursions(rows, 'peak', unit, lots);
    const dips = excursions(rows, 'dip', unit, lots);
    const caps = rows.map((r) => r.trade.stop!.trade.premium / lots).sort((a, b) => a - b);
    const dr = drivers(rows, unit, lots, dteShort);
    const sl = slices(rows, unit, lots);
    const totalPnl = rows.reduce((s, r) => s + r.trade.pnl, 0);
    return {
      peak: boundaries(peaks)!,
      dip: boundaries(dips)!,
      medianCapital: caps[Math.floor(caps.length / 2)],
      targets: levelRows(rows, 'target', unit, lots),
      sls: levelRows(rows, 'sl', unit, lots),
      targetAxis: axisLevels(peaks, GRID_TARGET_SHARES, unit),
      slAxis: axisLevels(dips, GRID_SL_SHARES, unit),
      best: bestPlan(rows, unit, lots),
      slices: sl,
      hours: extremeHours(rows),
      drivers: dr,
      lossStandouts: standouts(dr.drivers, 'loss'),
      winStandouts: standouts(dr.drivers, 'win'),
      totalPnl,
      winnersTotal: rows.filter((r) => r.trade.pnl > 0).reduce((s, r) => s + r.trade.pnl, 0),
    };
  }, [ready, rows, unit, lots]);

  const grid = useMemo(() => {
    if (!base) return [];
    return base.targetAxis.map((target) =>
      base.slAxis.map((sl) => planStats(rows, { unit, target, sl }, lots)),
    );
  }, [base, rows, unit, lots]);

  const mine = useMemo(
    () => (ready && (plan.target > 0 || plan.sl > 0) ? planStats(rows, plan, lots) : null),
    [ready, rows, plan, lots],
  );

  const paths = useMemo(() => {
    if (!base) return null;
    const scare = plan.sl > 0 ? plan.sl : base.dip.by50;
    const inProfit = plan.target > 0 ? plan.target : base.peak.by50;
    return {
      scare,
      inProfit,
      fromPlan: { scare: plan.sl > 0, inProfit: plan.target > 0 },
      groups: pathGroups(rows, unit, lots, scare, inProfit),
    };
  }, [base, rows, unit, lots, plan.sl, plan.target]);

  if (!rows.length) {
    return (
      <div className="px-3 py-6 text-[12px] text-[var(--text-muted)]">No trades to look at.</div>
    );
  }
  if (!ready || !base || !paths) {
    return (
      <div className="px-3 py-6 text-[12px] text-[#f59e0b]">
        This server predates the P&L analysis — restart it (Ctrl+C, then npm start) and run again.
      </div>
    );
  }

  const worst = base.slices[0];
  const bestSlice = base.slices[base.slices.length - 1];
  const maxSliceAbs = Math.max(...base.slices.map((s) => Math.abs(s.total)), 1);
  const maxHour = Math.max(...base.hours.flatMap((h) => [h.peakPct, h.dipPct]), 1);

  return (
    <div className="space-y-5 px-3 py-2 text-[11px]">
      {/* Controls and the chosen plan */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div
            className="flex flex-col gap-0.5"
            title="Capital = (CE + PE premium at entry) × lot size: the most a sold strangle can make. % of capital compares fairly across years and days to expiry; ₹ per lot is what you would type at the broker."
          >
            <span className={lblCls}>Size in</span>
            <div className="flex h-7 overflow-hidden rounded border border-[var(--border)]">
              {(
                [
                  ['pct', '% of capital'],
                  ['rs', '₹ per lot'],
                ] as const
              ).map(([v, text]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={unit === v}
                  onClick={() => onPlan({ unit: v, target: 0, sl: 0 })}
                  className={`px-2 text-[11px] ${unit === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'}`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
          <SizeInput
            label="Your target"
            unit={unit}
            value={plan.target}
            onChange={(v) => onPlan({ target: v })}
          />
          <SizeInput
            label="Your SL"
            unit={unit}
            value={plan.sl}
            onChange={(v) => onPlan({ sl: v })}
          />
          <div className="min-w-0 flex-1 self-center text-[var(--text-muted)]">
            Capital = (CE + PE premium) × lot size, the most a trade can make. Typical here:{' '}
            {rs(base.medianCapital)} per lot. Type a target or SL, or click any row or grid cell.
          </div>
        </div>
        {mine && <PlanLine s={mine} unit={unit} />}
        {filterLabel && (
          <div className="text-[var(--accent)]">
            Only the days the filter keeps: {filterLabel} ({rows.length} trades)
          </div>
        )}
      </div>

      {/* The short answer */}
      <section>
        <div className={sectionTitleCls}>The short answer</div>
        <ul className="list-disc space-y-1 pl-5 leading-relaxed">
          <TargetSentences b={base.peak} unit={unit} />
          <SlSentences b={base.dip} unit={unit} />
          {worst && (
            <li>
              <b style={{ color: LOSS }}>Biggest losses:</b>{' '}
              {worst.hi < 0 ? (
                <>
                  the worst 10% of days lost {sz(-worst.hi, unit)} or more (down to{' '}
                  {sz(worst.lo, unit, true)})
                </>
              ) : (
                <>
                  even the worst 10% of days ended between {sz(worst.lo, unit, true)} and{' '}
                  {sz(worst.hi, unit, true)}
                </>
              )}{' '}
              and together {worst.total < 0 ? 'cost' : 'made'} <b>{rs(Math.abs(worst.total))}</b>
              {base.winnersTotal > 0 && worst.total < 0 && (
                <>
                  {' '}
                  — {pctText((-worst.total / base.winnersTotal) * 100)} of everything the winning
                  days made
                </>
              )}
              .{' '}
              {base.lossStandouts.length > 0 ? (
                <>
                  They come most when{' '}
                  {base.lossStandouts.map((s, i) => (
                    <Fragment key={s.driver + s.bucket.label}>
                      {i > 0 && (i === base.lossStandouts.length - 1 ? ' and ' : ', ')}
                      <b>{standoutText(s.driver, s.bucket.label)}</b> (
                      {s.bucket.lossLift.toFixed(1)}× as often)
                    </Fragment>
                  ))}
                  .
                </>
              ) : (
                'No condition below stands out for them.'
              )}
            </li>
          )}
          {bestSlice && (
            <li>
              <b style={{ color: WIN }}>Biggest wins:</b> the best 10% of days made{' '}
              {sz(bestSlice.lo, unit)} or more and together {rs(bestSlice.total, true)}.{' '}
              {base.winStandouts.length > 0 ? (
                <>
                  They come most when{' '}
                  {base.winStandouts.map((s, i) => (
                    <Fragment key={s.driver + s.bucket.label}>
                      {i > 0 && (i === base.winStandouts.length - 1 ? ' and ' : ', ')}
                      <b>{standoutText(s.driver, s.bucket.label)}</b> ({s.bucket.winLift.toFixed(1)}
                      × as often)
                    </Fragment>
                  ))}
                  .
                </>
              ) : (
                'No condition below stands out for them.'
              )}
            </li>
          )}
          {base.best && (
            <li>
              <b>Best target + SL found</b> (searched over the levels 95% … 5% of days reached, and
              none):{' '}
              <button
                type="button"
                className="font-semibold text-[var(--accent)] underline"
                onClick={() => onPlan({ target: base.best!.plan.target, sl: base.best!.plan.sl })}
              >
                {planName(base.best.plan)}
              </button>
              , <b className={pnlClass(base.best.delta)}>{rs(base.best.delta, true)}</b> against
              holding every trade to the exit
              {base.best.plan.target === 0 && base.best.plan.sl === 0 && ' — nothing beats holding'}
              .
              <span className="text-[var(--text-muted)]">
                {' '}
                Found with hindsight on this sample: a guide, not a promise.
              </span>
            </li>
          )}
        </ul>
      </section>

      {/* Spread of results */}
      <section>
        <div className={sectionTitleCls}>How the results are spread</div>
        <div className={noteCls}>
          Days ranked by P&L and cut into ten equal slices, worst first. The bars are each slice's
          total — the money is made and lost unevenly.
        </div>
        <table className="border-collapse">
          <thead className="text-[var(--text-muted)]">
            <tr className="border-b border-[var(--border)] text-right">
              <th className={`${thCls} text-left`}>Slice</th>
              <th className={thCls}>Days</th>
              <th className={thCls}>P&L range</th>
              <th className={thCls}>Average</th>
              <th className={thCls}>Total</th>
              <th className={`${thCls} w-[220px]`} />
            </tr>
          </thead>
          <tbody className="font-mono">
            {base.slices.map((s) => (
              <tr key={s.n} className="border-b border-[var(--border)]/40 text-right">
                <td className={`${tdCls} text-left font-sans`}>
                  {s.n === 1
                    ? 'Worst 10%'
                    : s.n === 10
                      ? 'Best 10%'
                      : `${(s.n - 1) * 10}–${s.n * 10}%`}
                </td>
                <td className={tdCls}>{s.trades}</td>
                <td className={tdCls}>
                  {sz(s.lo, unit, true)} … {sz(s.hi, unit, true)}
                </td>
                <td className={`${tdCls} ${pnlClass(s.avg)}`}>{sz(s.avg, unit, true)}</td>
                <td className={`${tdCls} ${pnlClass(s.total)}`}>{rs(s.total, true)}</td>
                <td className={tdCls}>
                  <Bar value={s.total} max={maxSliceAbs} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Targets and stops alone */}
      <div className="flex flex-wrap gap-x-8 gap-y-5">
        <section>
          <div className={sectionTitleCls}>Targets on their own</div>
          <div className={noteCls}>
            Each target is a profit that share of days actually reached. "Helped": of the days it
            fired, how many would have closed lower without it.
          </div>
          <LevelTable
            rows={base.targets}
            unit={unit}
            kind="target"
            chosen={plan.target}
            onPick={(v) => onPlan({ target: v })}
          />
        </section>
        <section>
          <div className={sectionTitleCls}>Stop-losses on their own</div>
          <div className={noteCls}>
            Each SL is a loss that share of days actually reached, so an SL that tight or tighter
            fires at least that often.
          </div>
          <LevelTable
            rows={base.sls}
            unit={unit}
            kind="sl"
            chosen={plan.sl}
            onPick={(v) => onPlan({ sl: v })}
          />
        </section>
      </div>

      {/* Target × SL */}
      <section>
        <div className={sectionTitleCls}>Target and SL together</div>
        <div className={noteCls}>
          Whichever is hit first closes the trade. Each cell: P&L against holding to the exit, and
          below it how often the target (T) and the SL (S) fired first. When both are crossed inside
          one minute the SL is assumed. Click a cell to use that pair.
        </div>
        <table className="border-collapse">
          <thead className="text-[var(--text-muted)]">
            <tr>
              <th className={`${thCls} text-left`}>Target ↓ / SL →</th>
              {base.slAxis.map((sl) => (
                <th key={sl} className={`${thCls} text-right`}>
                  {sl === 0 ? 'no SL' : sz(sl, unit)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {base.targetAxis.map((target, i) => (
              <tr key={target} className="border-t border-[var(--border)]/40">
                <td className={`${tdCls} font-sans text-[var(--text-muted)]`}>
                  {target === 0 ? 'no target' : sz(target, unit)}
                </td>
                {grid[i]?.map((s) => {
                  const chosen = plan.target === s.plan.target && plan.sl === s.plan.sl;
                  const isBest =
                    base.best != null && grid.flat().every((o) => o.pnl <= s.pnl) && s.delta > 0;
                  return (
                    <td
                      key={s.plan.sl}
                      onClick={() => onPlan({ target: s.plan.target, sl: s.plan.sl })}
                      className={`cursor-pointer px-2 py-1 text-right hover:bg-[var(--bg-secondary)] ${chosen ? 'bg-[var(--accent)]/15' : ''}`}
                      title={`Target ${s.plan.target ? sz(s.plan.target, unit) : 'none'}, SL ${s.plan.sl ? sz(s.plan.sl, unit) : 'none'}: target first ${pctText(s.targetPct)}, SL first ${pctText(s.slPct + s.bothPct)} (same minute ${pctText(s.bothPct)}), neither ${pctText(s.nonePct)}; P&L ${rs(s.pnl, true)}`}
                    >
                      <div className={pnlClass(s.delta)}>
                        {isBest && <span className="mr-0.5 text-[#f59e0b]">★</span>}
                        {s.plan.target === 0 && s.plan.sl === 0 ? 'hold' : rs(s.delta, true)}
                      </div>
                      <div className="text-[9px] text-[var(--text-muted)]">
                        T {Math.round(s.targetPct)} · S {Math.round(s.slPct + s.bothPct)}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Paths */}
      <div className="flex flex-wrap gap-x-8 gap-y-5">
        <section>
          <div className={sectionTitleCls}>The paths trades take</div>
          <div className={noteCls}>
            A scare = went {sz(paths.scare, unit)} or more against you (
            {paths.fromPlan.scare ? 'your SL' : 'what half the days reached'}). In profit = was up{' '}
            {sz(paths.inProfit, unit)} or more (
            {paths.fromPlan.inProfit ? 'your target' : 'what half the days reached'}).
          </div>
          <table className="border-collapse">
            <thead className="text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)] text-right">
                <th className={`${thCls} text-left`} />
                <th className={thCls}>Days</th>
                <th className={thCls}>Average P&L</th>
                <th className={thCls}>Avg best</th>
                <th className={thCls}>Avg worst</th>
                <th className={thCls}>Total</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {paths.groups.map((g) => (
                <tr key={g.kind} className="border-b border-[var(--border)]/40 text-right">
                  <td className={`${tdCls} text-left font-sans`}>{PATH_LABEL[g.kind]}</td>
                  <td className={tdCls}>
                    {g.trades} <span className="text-[var(--text-muted)]">({pctText(g.pct)})</span>
                  </td>
                  <td className={`${tdCls} ${pnlClass(g.avg)}`}>{sz(g.avg, unit, true)}</td>
                  <td className={tdCls}>{sz(g.avgPeak, unit, true)}</td>
                  <td className={tdCls}>{sz(-g.avgDip, unit, true)}</td>
                  <td className={`${tdCls} ${pnlClass(g.total)}`}>{rs(g.total, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <div className={sectionTitleCls}>When the best and worst points happen</div>
          <div className={noteCls}>
            Share of days whose highest profit / deepest loss fell in each hour.
          </div>
          <table className="border-collapse">
            <thead className="text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)] text-right">
                <th className={`${thCls} text-left`}>Hour</th>
                <th className={thCls}>Best point</th>
                <th className={`${thCls} w-[90px]`} />
                <th className={thCls}>Worst point</th>
                <th className={`${thCls} w-[90px]`} />
              </tr>
            </thead>
            <tbody className="font-mono">
              {base.hours.map((h) => (
                <tr key={h.hour} className="border-b border-[var(--border)]/40 text-right">
                  <td className={`${tdCls} text-left`}>{h.hour}</td>
                  <td className={tdCls}>{pctText(h.peakPct)}</td>
                  <td className={tdCls}>
                    <Bar value={h.peakPct} max={maxHour} oneSided />
                  </td>
                  <td className={tdCls}>{pctText(h.dipPct)}</td>
                  <td className={tdCls}>
                    <Bar value={-h.dipPct} max={maxHour} oneSided />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {/* Drivers */}
      <section>
        <div className={sectionTitleCls}>Where the biggest losses and wins come from</div>
        <div className={noteCls}>
          Big losses = the worst 10% of these days ({sz(base.drivers.bigLossAt, unit, true)} or
          worse); big wins = the best 10% ({sz(base.drivers.bigWinAt, unit, true)} or better). "× as
          often" compares a bucket's share of them with its share of all days: 1.0× is ordinary,
          2.0× twice as common. Quarters split the days into four equal groups.
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-4">
          {base.drivers.drivers.map((d) => (
            <DriverTable key={d.name} d={d} unit={unit} />
          ))}
        </div>
      </section>

      <div className="pb-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
        How it is worked out: every minute from entry to exit the trade is marked with the legs at
        their closes, or one leg at its high or low with the other at its close, whichever is more
        extreme — both legs peaking in the same minute is not assumed. A target fills at the target;
        an SL at the SL, or at the minute's opening price when it jumped through. 1-minute data,
        whole trade, gross of charges and slippage; with high/low off the closes alone are used.
        Totals are for the run's {lots} lot{lots === 1 ? '' : 's'}.
      </div>
    </div>
  );
}

function planName(p: ExitPlan): string {
  const t = p.target ? `target ${sz(p.target, p.unit)}` : 'no target';
  const s = p.sl ? `SL ${sz(p.sl, p.unit)}` : 'no SL';
  return `${t}, ${s}`;
}

/** A driver bucket as a phrase: "Exp" → "it is the expiry day", quarters keep their range. */
function standoutText(driver: string, label: string): string {
  if (driver === 'Days to expiry')
    return label === 'Exp' ? 'it is the expiry day' : `the day is ${label}`;
  if (driver === 'Weekday') return `it is a ${label}`;
  if (driver === 'Entry time') return `entry is ${label}`;
  if (driver === 'Year') return `the year is ${label}`;
  if (driver === 'Spot direction') return label.charAt(0).toLowerCase() + label.slice(1);
  if (driver.startsWith('How far spot ended'))
    return `spot ends ${label.replace(/ \(.*\)$/, '')} from entry`;
  if (driver.startsWith('Spot range'))
    return `spot swings ${label.replace(/ \(.*\)$/, '')} while in the trade`;
  if (driver.startsWith('Capital'))
    return `the premium collected is ${label.replace(/ \(.*\)$/, '')} a lot`;
  if (driver.startsWith('Signal size'))
    return `the signal's leg gap is ${label.replace(/ \(.*\)$/, '')}`;
  return `${driver}: ${label}`;
}

/**
 * "Above X it is hit on fewer than 10 % of days, above Y fewer than 5 %…": the rare tail of a
 * boundary, with levels that print the same as the one before (or as the maximum) left out.
 */
function rareTail(b: Boundaries, unit: PnlUnit, word: string): string {
  const parts: string[] = [];
  let last = '';
  for (const [v, pct] of [
    [b.by10, 10],
    [b.by5, 5],
    [b.by1, 1],
  ] as const) {
    const text = sz(v, unit);
    if (text === last || text === sz(b.max, unit)) continue;
    parts.push(
      `${parts.length ? `${word} ${text}` : text} it is hit on fewer than ${pct}% of days`,
    );
    last = text;
  }
  return parts.length
    ? `${word.charAt(0).toUpperCase()}${word.slice(1)} ${parts.join(', ')}. `
    : '';
}

function TargetSentences({ b, unit }: { b: Boundaries; unit: PnlUnit }) {
  return (
    <li>
      <b>Targets:</b> a target up to <b>{sz(b.by90, unit)}</b> is hit on 90% of days, and up to{' '}
      <b>{sz(b.by50, unit)}</b> on half of them. {rareTail(b, unit, 'above')}No day went past{' '}
      <b>{sz(b.max, unit)}</b> in profit: a target beyond that is <b>never hit</b>.
      {b.zeroPct > 0 && <> {pctText(b.zeroPct)} of days never went green at all.</>}
    </li>
  );
}

function SlSentences({ b, unit }: { b: Boundaries; unit: PnlUnit }) {
  return (
    <li>
      <b>Stop-losses:</b> an SL of <b>{sz(b.by90, unit)}</b> or tighter is hit on 90% of days — it
      sits inside the normal noise — and <b>{sz(b.by50, unit)}</b> on half of them.{' '}
      {rareTail(b, unit, 'wider than')}No day went deeper than <b>{sz(b.max, unit)}</b>: an SL
      beyond that <b>never fires</b>.
      {b.zeroPct > 0 && <> {pctText(b.zeroPct)} of days never went red at all.</>}
    </li>
  );
}

function PlanLine({ s, unit }: { s: PlanStats; unit: PnlUnit }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1">
      <b>{planName({ ...s.plan, unit })}:</b>
      {s.plan.target > 0 && (
        <span>
          target first on <b style={{ color: WIN }}>{pctText(s.targetPct)}</b> of days
        </span>
      )}
      {s.plan.sl > 0 && (
        <span>
          SL first on <b style={{ color: LOSS }}>{pctText(s.slPct + s.bothPct)}</b>
          {s.bothPct > 0 && ` (${pctText(s.bothPct)} both in the same minute, counted as SL)`}
        </span>
      )}
      <span>
        neither on {pctText(s.nonePct)} (held to exit, average {rs(s.noneAvg, true)})
      </span>
      <span>
        P&L <b className={pnlClass(s.pnl)}>{rs(s.pnl, true)}</b> vs {rs(s.basePnl, true)} holding (
        <b className={pnlClass(s.delta)}>{rs(s.delta, true)}</b>)
      </span>
    </div>
  );
}

function SizeInput({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: PnlUnit;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className={lblCls}>
        {label} ({unit === 'pct' ? '% of capital' : '₹/lot'})
      </span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          className={`${inputCls} w-[90px]`}
          min={0}
          step={unit === 'pct' ? 1 : 100}
          value={value > 0 ? value : ''}
          placeholder="none"
          onChange={(e) => {
            const v = Number(e.target.value);
            onChange(Number.isFinite(v) && v > 0 ? v : 0);
          }}
        />
        {value > 0 && (
          <button
            type="button"
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            onClick={() => onChange(0)}
          >
            clear
          </button>
        )}
      </span>
    </label>
  );
}

function LevelTable({
  rows,
  unit,
  kind,
  chosen,
  onPick,
}: {
  rows: LevelRow[];
  unit: PnlUnit;
  kind: 'target' | 'sl';
  chosen: number;
  onPick: (v: number) => void;
}) {
  const best = rows.reduce<LevelRow | null>(
    (b, r) => (!b || r.stats.delta > b.stats.delta ? r : b),
    null,
  );
  return (
    <table className="border-collapse">
      <thead className="text-[var(--text-muted)]">
        <tr className="border-b border-[var(--border)] text-right">
          <th className={`${thCls} text-left`}>Reached by</th>
          <th className={thCls}>{kind === 'target' ? 'Target' : 'SL'}</th>
          <th className={thCls}>Hit on</th>
          {kind === 'target' && <th className={thCls}>Helped</th>}
          <th className={thCls}>P&L</th>
          <th className={thCls}>vs holding</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map((r) => {
          const hit = kind === 'target' ? r.stats.targetPct : r.stats.slPct + r.stats.bothPct;
          return (
            <tr
              key={r.level}
              onClick={() => onPick(r.level)}
              className={`cursor-pointer border-b border-[var(--border)]/40 text-right hover:bg-[var(--bg-secondary)] ${chosen === r.level ? 'bg-[var(--accent)]/15' : ''}`}
            >
              <td className={`${tdCls} text-left font-sans`}>{shareText(r.share)}</td>
              <td className={`${tdCls} font-semibold`}>
                {best === r && r.stats.delta > 0 && <span className="mr-1 text-[#f59e0b]">★</span>}
                {sz(r.level, unit)}
              </td>
              <td className={tdCls}>{pctText(hit)}</td>
              {kind === 'target' && <td className={tdCls}>{pctText(r.helpedPct)}</td>}
              <td className={`${tdCls} ${pnlClass(r.stats.pnl)}`}>{rs(r.stats.pnl, true)}</td>
              <td className={`${tdCls} ${pnlClass(r.stats.delta)}`}>{rs(r.stats.delta, true)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function DriverTable({ d, unit }: { d: Driver; unit: PnlUnit }) {
  const liftCls = (lift: number, color: string) =>
    lift >= 1.5 ? { color, fontWeight: 600 } : lift < 0.67 ? { opacity: 0.55 } : undefined;
  return (
    <div>
      <div className="mb-0.5 font-semibold text-[var(--text-muted)]">{d.name}</div>
      <table className="border-collapse">
        <thead className="text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border)] text-right">
            <th className={`${thCls} text-left`} />
            <th className={thCls}>Days</th>
            <th className={thCls}>Win</th>
            <th className={thCls}>Avg P&L</th>
            <th className={thCls}>Total</th>
            <th className={thCls} title="Share of all big-loss days that fall in this bucket">
              Big losses
            </th>
            <th className={thCls}>× as often</th>
            <th className={thCls} title="Share of all big-win days that fall in this bucket">
              Big wins
            </th>
            <th className={thCls}>× as often</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {d.buckets.map((b) => (
            <tr key={b.label} className="border-b border-[var(--border)]/40 text-right">
              <td className={`${tdCls} text-left font-sans`}>{b.label}</td>
              <td className={tdCls}>{b.trades}</td>
              <td className={tdCls}>{pctText(b.winPct)}</td>
              <td className={`${tdCls} ${pnlClass(b.avg)}`}>{sz(b.avg, unit, true)}</td>
              <td className={`${tdCls} ${pnlClass(b.total)}`}>{rs(b.total, true)}</td>
              <td className={tdCls}>{pctText(b.bigLossShare)}</td>
              <td className={tdCls} style={liftCls(b.lossLift, LOSS)}>
                {b.lossLift.toFixed(1)}×
              </td>
              <td className={tdCls}>{pctText(b.bigWinShare)}</td>
              <td className={tdCls} style={liftCls(b.winLift, WIN)}>
                {b.winLift.toFixed(1)}×
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A horizontal bar: from a centre line, green right for gains and red left for losses; or, one-sided,
 * from the left edge in the value's colour.
 */
function Bar({ value, max, oneSided = false }: { value: number; max: number; oneSided?: boolean }) {
  const span = oneSided ? 100 : 50;
  const w = Math.min(span, (Math.abs(value) / max) * span);
  return (
    <div className="relative h-2.5 w-full">
      {!oneSided && <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--border)]" />}
      <div
        className="absolute inset-y-0 rounded-sm"
        style={{
          width: `${w}%`,
          left: oneSided ? 0 : value >= 0 ? '50%' : `${50 - w}%`,
          background: value >= 0 ? WIN : LOSS,
          opacity: 0.8,
        }}
      />
    </div>
  );
}
