/**
 * The Signal Backtest tab's Stop-loss view: how far trades went against the position before they
 * closed, and what a stop of a given size would have done — on the rows the day filter leaves.
 *
 * The stop levels in the main table come from the data (the dip 95 %, 90 %… of trades reached),
 * never from a list of round numbers; the person picks one, or types their own.
 */
import { useMemo } from 'react';
import { dteShort, pnlClass, type SignalBacktestRow } from '../lib/signalBacktest';
import {
  bestStop,
  dataLevels,
  dipSummary,
  dipsByOutcome,
  dipsOf,
  hasStopPaths,
  reachedBy,
  stopStats,
  type DipSummary,
  type StopRule,
  type StopScope,
  type StopStats,
  type StopUnit,
} from '../lib/stopLoss';

const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';
const inputCls =
  'h-7 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';
const thCls = 'px-2 py-1 font-normal';
const sectionTitleCls = 'mb-1 text-[12px] font-semibold';
const noteCls = 'mb-1.5 text-[11px] text-[var(--text-muted)]';

/** Whole rupees, signed when asked. */
function rs(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
}
const pctText = (n: number | null | undefined, digits = 0) =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;

/** A stop or a dip in the chosen unit. */
const levelText = (v: number, unit: StopUnit) =>
  unit === 'pct' ? `${v.toFixed(v < 10 ? 1 : 0)}%` : rs(v);

export default function StopLossPanel({
  rows,
  lots,
  rule,
  onRule,
  filterLabel,
}: {
  rows: SignalBacktestRow[];
  /** The run's lots: paths are in ₹ for them, ₹ stops are per lot. */
  lots: number;
  rule: StopRule;
  onRule: (patch: Partial<StopRule>) => void;
  /** What the day filter keeps, or null when it is off. */
  filterLabel: string | null;
}) {
  const ready = hasStopPaths(rows);
  const { scope, unit } = rule;
  const levels = useMemo(
    () => (ready ? dataLevels(rows, scope, unit, lots) : []),
    [ready, rows, scope, unit, lots],
  );
  const mine = useMemo(
    () => (ready && rule.value > 0 ? stopStats(rows, rule, lots) : null),
    [ready, rows, rule, lots],
  );
  const dips = useMemo(() => {
    if (!ready) return null;
    const { winners, losers } = dipsByOutcome(rows, scope, unit, lots);
    return {
      winners: dipSummary(winners),
      losers: dipSummary(losers),
      all: dipSummary([...winners, ...losers]),
    };
  }, [ready, rows, scope, unit, lots]);
  const byDte = useMemo(() => {
    if (!ready) return [];
    const groups = new Map<number | null, SignalBacktestRow[]>();
    for (const r of rows) {
      const k = r.dte ?? null;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a ?? 99) - (b ?? 99))
      .map(([dte, group]) => {
        const values = dipsOf(group, scope, unit, lots);
        const premiums = group.map((r) => r.trade.stop!.trade.premium / lots).sort((a, b) => a - b);
        return {
          dte,
          trades: group.length,
          winPct: (group.filter((r) => r.trade.pnl > 0).length / group.length) * 100,
          premium: premiums[Math.floor(premiums.length / 2)],
          by90: reachedBy(values, 0.9),
          by50: reachedBy(values, 0.5),
          by10: reachedBy(values, 0.1),
          group,
          best: bestStop(group, scope, unit, lots),
        };
      });
  }, [ready, rows, scope, unit, lots]);
  // Apart from the above, so typing a stop does not redo the best-stop searches.
  const mineByDte = useMemo(
    () => byDte.map((g) => (rule.value > 0 ? stopStats(g.group, rule, lots) : null)),
    [byDte, rule, lots],
  );
  const overallBest = useMemo(
    () => (ready ? bestStop(rows, scope, unit, lots) : null),
    [ready, rows, scope, unit, lots],
  );

  if (!rows.length) {
    return (
      <div className="px-3 py-6 text-[12px] text-[var(--text-muted)]">No trades to look at.</div>
    );
  }
  if (!ready) {
    return (
      <div className="px-3 py-6 text-[12px] text-[#f59e0b]">
        This server predates the Stop-loss view — restart it (Ctrl+C, then npm start) and run again.
      </div>
    );
  }

  const best = levels.reduce<StopStats | null>(
    (b, l) => (b == null || l.stats.delta > b.delta ? l.stats : b),
    null,
  );
  const what = scope === 'trade' ? 'trades' : 'legs';
  const ofWhat =
    unit === 'pct'
      ? `% of the premium ${scope === 'trade' ? 'collected' : 'on that leg'}`
      : '₹ per lot';

  return (
    <div className="space-y-4 px-3 py-2 text-[11px]">
      {/* Controls and the chosen stop */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <Choice
          label="Stop on"
          value={scope}
          options={[
            ['trade', 'Whole trade'],
            ['leg', 'Each leg'],
          ]}
          title="Whole trade: everything is squared off when the combined loss reaches the stop. Each leg: a leg is squared off when its own loss reaches the stop; the other keeps running to the exit."
          onChange={(v) => onRule({ scope: v as StopScope })}
        />
        <Choice
          label="Size in"
          value={unit}
          options={[
            ['pct', '% of premium'],
            ['rs', '₹ per lot'],
          ]}
          title="% of premium compares fairly across years and days to expiry (premiums differ a lot); ₹ per lot is what you would type at the broker."
          onChange={(v) => onRule({ unit: v as StopUnit, value: 0 })}
        />
        <label
          className="flex flex-col gap-0.5"
          title="Type a stop, or click a row in the table below"
        >
          <span className={lblCls}>Your stop ({unit === 'pct' ? '%' : '₹/lot'})</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              className={`${inputCls} w-[90px]`}
              min={0}
              step={unit === 'pct' ? 1 : 100}
              value={rule.value > 0 ? rule.value : ''}
              placeholder="none"
              onChange={(e) => {
                const v = Number(e.target.value);
                onRule({ value: Number.isFinite(v) && v > 0 ? v : 0 });
              }}
            />
            {rule.value > 0 && (
              <button
                type="button"
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => onRule({ value: 0 })}
              >
                clear
              </button>
            )}
          </span>
        </label>
        <div className="min-w-0 flex-1 self-center">
          {mine ? (
            <span className="flex flex-wrap gap-x-4 gap-y-0.5">
              <span>
                Fires on <b>{pctText(mine.hitPct)}</b> of days
                {mine.legsHitPct != null && ` (${pctText(mine.legsHitPct)} of legs)`}
              </span>
              <span>
                stops <b>{pctText(mine.winnersStoppedPct)}</b> of winning {what}
              </span>
              <span>
                cuts <b>{pctText(mine.losersStoppedPct)}</b> of losing {what}
              </span>
              <span>
                P&L <b className={pnlClass(mine.pnl)}>{rs(mine.pnl, true)}</b> vs{' '}
                {rs(mine.basePnl, true)} with no stop (
                <b className={pnlClass(mine.delta)}>{rs(mine.delta, true)}</b>)
              </span>
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">
              Type a stop, or click a row in the table below to try it.
            </span>
          )}
        </div>
      </div>
      {filterLabel && (
        <div className="text-[11px] text-[var(--accent)]">
          Only the days the filter keeps: {filterLabel} ({rows.length} trades)
        </div>
      )}

      {/* How deep trades go */}
      {dips && (
        <section>
          <div className={sectionTitleCls}>How far {what} went against you before they closed</div>
          <div className={noteCls}>
            The deepest point each {scope === 'trade' ? 'trade' : 'leg'} reached between entry and
            exit, in {ofWhat}. Winners and losers by how they closed with no stop.
          </div>
          <table className="border-collapse">
            <thead className="text-[var(--text-muted)]">
              <tr className="border-b border-[var(--border)] text-right">
                <th className={`${thCls} text-left`} />
                <th className={thCls}>{what}</th>
                <th className={thCls} title="Never went below the entry price at all">
                  never red
                </th>
                <th className={thCls} title="Half went deeper than this, half less">
                  typical (median)
                </th>
                <th className={thCls}>average</th>
                <th className={thCls}>1 in 4 went past</th>
                <th className={thCls}>1 in 10 went past</th>
                <th className={thCls}>deepest</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              <DipRow label="Winners" s={dips.winners} unit={unit} />
              <DipRow label="Losers" s={dips.losers} unit={unit} />
              <DipRow label="All" s={dips.all} unit={unit} />
            </tbody>
          </table>
        </section>
      )}

      {/* Levels from the data */}
      <section>
        <div className={sectionTitleCls}>What a stop of each size would have done</div>
        <div className={noteCls}>
          Each level is a dip that share of {what} actually reached, so a stop that tight or tighter
          fires at least that often. Click a row to try it as your stop.
          {best && best.delta > 0 && <> The best row is marked ★.</>}
        </div>
        {overallBest && (
          <div className="mb-1.5 text-[11px]">
            {overallBest.delta > 0 ? (
              <>
                Trying every level from the dip 99% of {what} reached to the one 1% reached, the
                most a stop would have added here is{' '}
                <b className={pnlClass(overallBest.delta)}>{rs(overallBest.delta, true)}</b>, at{' '}
                <button
                  type="button"
                  className="font-semibold text-[var(--accent)] underline"
                  onClick={() => onRule({ value: overallBest.level })}
                >
                  {levelText(overallBest.level, unit)}
                </button>{' '}
                (fires on {pctText(overallBest.hitPct)} of days).
              </>
            ) : (
              <>
                No stop size, from the dip 99% of {what} reached to the one 1% reached, would have
                made more than holding to the exit on these days.
              </>
            )}{' '}
            <span className="text-[var(--text-muted)]">
              Found with hindsight on this sample: a guide, not a promise.
            </span>
          </div>
        )}
        <table className="border-collapse">
          <thead className="text-[var(--text-muted)]">
            <tr className="border-b border-[var(--border)] text-right">
              <th className={`${thCls} text-left`}>Reached by</th>
              <th className={thCls}>Stop</th>
              <th className={thCls}>Fires on (days)</th>
              {scope === 'leg' && <th className={thCls}>Legs stopped</th>}
              <th className={thCls}>Winning {what} stopped</th>
              <th className={thCls}>Losing {what} cut</th>
              <th
                className={thCls}
                title="Average loss booked when the stop fires (the stop, or worse when the price jumped through it)"
              >
                Avg stop loss
              </th>
              <th className={thCls}>P&L with stop</th>
              <th className={thCls}>vs no stop</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {levels.map(({ share, stats }) => {
              const chosen = rule.value === stats.level;
              const isBest = best != null && best.delta > 0 && stats === best;
              return (
                <tr
                  key={stats.level}
                  onClick={() => onRule({ value: stats.level })}
                  className={`cursor-pointer border-b border-[var(--border)]/40 text-right hover:bg-[var(--bg-secondary)] ${chosen ? 'bg-[var(--accent)]/10' : ''}`}
                >
                  <td className="px-2 py-0.5 text-left font-sans">
                    {Math.round(share * 100)}% of {what}
                  </td>
                  <td className="px-2 py-0.5 font-semibold">
                    {isBest && <span className="mr-1 text-[#f59e0b]">★</span>}
                    {levelText(stats.level, unit)}
                  </td>
                  <td className="px-2 py-0.5">{pctText(stats.hitPct)}</td>
                  {scope === 'leg' && <td className="px-2 py-0.5">{pctText(stats.legsHitPct)}</td>}
                  <td className="px-2 py-0.5">{pctText(stats.winnersStoppedPct)}</td>
                  <td className="px-2 py-0.5">{pctText(stats.losersStoppedPct)}</td>
                  <td className="px-2 py-0.5">
                    {rs(stats.avgStopLoss == null ? null : stats.avgStopLoss / lots)}
                  </td>
                  <td className={`px-2 py-0.5 ${pnlClass(stats.pnl)}`}>{rs(stats.pnl, true)}</td>
                  <td className={`px-2 py-0.5 ${pnlClass(stats.delta)}`}>
                    {rs(stats.delta, true)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-1 text-[10px] text-[var(--text-muted)]">
          Avg stop loss is per lot. P&L columns are for the run's {lots} lot{lots === 1 ? '' : 's'}.
        </div>
      </section>

      {/* By days to expiry */}
      <section>
        <div className={sectionTitleCls}>By days to expiry</div>
        <div className={noteCls}>
          Premiums shrink toward expiry, so the same stop behaves very differently on each day.
        </div>
        <table className="border-collapse">
          <thead className="text-[var(--text-muted)]">
            <tr className="text-right">
              <th className={thCls} colSpan={4} />
              <th className={`${thCls} border-l border-[var(--border)] text-center`} colSpan={3}>
                Dip reached by
              </th>
              {mine && (
                <th className={`${thCls} border-l border-[var(--border)] text-center`} colSpan={3}>
                  Your stop ({levelText(rule.value, unit)})
                </th>
              )}
              <th className={`${thCls} border-l border-[var(--border)] text-center`} colSpan={2}>
                Best stop for that day
              </th>
            </tr>
            <tr className="border-b border-[var(--border)] text-right">
              <th className={`${thCls} text-left`}>Day</th>
              <th className={thCls}>Trades</th>
              <th className={thCls}>Win</th>
              <th className={thCls} title="Median premium collected, per lot">
                Premium/lot
              </th>
              <th className={`${thCls} border-l border-[var(--border)]`}>90%</th>
              <th className={thCls}>50%</th>
              <th className={thCls}>10%</th>
              {mine && (
                <>
                  <th className={`${thCls} border-l border-[var(--border)]`}>Fires</th>
                  <th className={thCls}>Winners stopped</th>
                  <th className={thCls}>vs no stop</th>
                </>
              )}
              <th className={`${thCls} border-l border-[var(--border)]`}>Stop</th>
              <th className={thCls}>vs no stop</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {byDte.map((g, i) => {
              const mineHere = mineByDte[i];
              return (
                <tr key={String(g.dte)} className="border-b border-[var(--border)]/40 text-right">
                  <td className="px-2 py-0.5 text-left font-sans">
                    {g.dte == null ? 'Unknown' : dteShort(g.dte)}
                  </td>
                  <td className="px-2 py-0.5">{g.trades}</td>
                  <td className="px-2 py-0.5">{pctText(g.winPct)}</td>
                  <td className="px-2 py-0.5">{rs(g.premium)}</td>
                  <td className="border-l border-[var(--border)] px-2 py-0.5">
                    {levelText(g.by90, unit)}
                  </td>
                  <td className="px-2 py-0.5">{levelText(g.by50, unit)}</td>
                  <td className="px-2 py-0.5">{levelText(g.by10, unit)}</td>
                  {mineHere && (
                    <>
                      <td className="border-l border-[var(--border)] px-2 py-0.5">
                        {pctText(mineHere.hitPct)}
                      </td>
                      <td className="px-2 py-0.5">{pctText(mineHere.winnersStoppedPct)}</td>
                      <td className={`px-2 py-0.5 ${pnlClass(mineHere.delta)}`}>
                        {rs(mineHere.delta, true)}
                      </td>
                    </>
                  )}
                  <td className="border-l border-[var(--border)] px-2 py-0.5">
                    {g.best && g.best.delta > 0 ? levelText(g.best.level, unit) : 'none helps'}
                  </td>
                  <td
                    className={`px-2 py-0.5 ${pnlClass(g.best && g.best.delta > 0 ? g.best.delta : 0)}`}
                  >
                    {g.best && g.best.delta > 0 ? rs(g.best.delta, true) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="pb-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
        How it is worked out: every minute from entry to exit, the loss is marked with the legs at
        their closes, or with one leg at its high (low when long) and the other at its close,
        whichever is worse; both legs spiking in the same minute is not assumed. A stop fills at its
        level, or at the price the minute opened at when it jumped through. 1-minute data, gross of
        charges and slippage; with high/low off the closes alone are used.
      </div>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  title,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  title?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className={lblCls}>{label}</span>
      <div className="flex h-7 overflow-hidden rounded border border-[var(--border)]">
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`px-2 text-[11px] ${value === v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function DipRow({ label, s, unit }: { label: string; s: DipSummary | null; unit: StopUnit }) {
  if (!s) return null;
  return (
    <tr className="border-b border-[var(--border)]/40 text-right">
      <td className="px-2 py-0.5 text-left font-sans">{label}</td>
      <td className="px-2 py-0.5">{s.n}</td>
      <td className="px-2 py-0.5">{pctText(s.neverRedPct)}</td>
      <td className="px-2 py-0.5 font-semibold">{levelText(s.median, unit)}</td>
      <td className="px-2 py-0.5">{levelText(s.mean, unit)}</td>
      <td className="px-2 py-0.5">{levelText(s.p75, unit)}</td>
      <td className="px-2 py-0.5">{levelText(s.p90, unit)}</td>
      <td className="px-2 py-0.5">{levelText(s.max, unit)}</td>
    </tr>
  );
}
