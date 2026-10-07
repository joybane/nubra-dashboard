/**
 * The Signal Backtest tab's Losses view, on the rows the day filter leaves: losses only, ₹ per lot,
 * for all days and for each distance from expiry. Exit levels come from the data (the worst points
 * 90 % … 5 % of the days reached, and the average); clicking one shows what the loss did after it
 * was hit, told in the same levels, as a tree of day counts with medians and means.
 */
import { useMemo, useState } from 'react';
import { dteShort, type SignalBacktestRow } from '../lib/signalBacktest';
import {
  afterHit,
  hasLossSeries,
  lossGroups,
  type AfterHit,
  type ExitRow,
  type LossGroup,
  type TreeNode,
} from '../lib/lossAnalysis';

const thCls = 'px-2 py-1 font-normal';
const tdCls = 'px-2 py-0.5';
const LOSS = '#ef4444';

function rs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
}
/** A loss as −₹; a closing value in profit as +₹. */
const lossText = (n: number) => (n < 0 ? `+${rs(n)}` : n === 0 ? '₹0' : `−${rs(n)}`);
const pctText = (n: number) => `${n.toFixed(n > 0 && n < 1 ? 1 : 0)}%`;
function hhmm(minute: number): string {
  const t = 9 * 60 + 15 + minute;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export default function LossAnalysisPanel({
  rows,
  lots,
  filterLabel,
  onOpenDay,
}: {
  rows: SignalBacktestRow[];
  /** The run's lots: everything is shown per lot. */
  lots: number;
  /** What the day filter keeps, or null when it is off. */
  filterLabel: string | null;
  /** Open a day's chart (in the Trades view). */
  onOpenDay: (date: string) => void;
}) {
  const ready = hasLossSeries(rows);
  const groups = useMemo(
    () => (ready ? lossGroups(rows, lots, dteShort) : []),
    [ready, rows, lots],
  );
  const [picked, setPicked] = useState<{ group: string; level: number } | null>(null);
  const pickedGroup = picked ? groups.find((g) => g.key === picked.group) : undefined;
  const tree = useMemo(() => {
    if (!picked || !pickedGroup) return null;
    const levels = pickedGroup.exits.flatMap((e) => (e.level == null ? [] : [e.level]));
    return afterHit(pickedGroup.rows, picked.level, lots, levels);
  }, [picked, pickedGroup, lots]);

  if (!rows.length) {
    return (
      <div className="px-3 py-6 text-[12px] text-[var(--text-muted)]">No trades to look at.</div>
    );
  }
  if (!ready) {
    return (
      <div className="px-3 py-6 text-[12px] text-[#f59e0b]">
        This server predates the Losses view — restart it (Ctrl+C, then npm start) and run again.
      </div>
    );
  }

  return (
    <div className="space-y-5 px-3 py-2 text-[11px]">
      <div className="text-[var(--text-muted)]">
        Losses only, ₹ per lot. Each exit level is a worst point that share of the days actually
        reached; "average" is the average worst point. An exit fills at its level, or worse when the
        loss jumped past it inside a minute. Click a level to see what the loss did after it was
        hit.
        {filterLabel && (
          <span className="text-[var(--accent)]">
            {' '}
            Only the days the filter keeps: {filterLabel}.
          </span>
        )}
      </div>
      {groups.map((g) => (
        <section key={g.key}>
          <GroupTable
            g={g}
            picked={picked?.group === g.key ? picked.level : null}
            onPick={(level) =>
              setPicked((p) =>
                p?.group === g.key && p.level === level ? null : { group: g.key, level },
              )
            }
          />
          {picked?.group === g.key && (
            <div className="mt-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)]/40 p-2">
              {tree ? (
                <TreeView t={tree} groupLabel={g.label} onOpenDay={onOpenDay} />
              ) : (
                <span className="text-[var(--text-muted)]">No day reached this level.</span>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function GroupTable({
  g,
  picked,
  onPick,
}: {
  g: LossGroup;
  picked: number | null;
  onPick: (level: number) => void;
}) {
  const label = (e: ExitRow) =>
    e.kind === 'hold'
      ? 'hold (no exit)'
      : e.kind === 'mean'
        ? 'average worst point'
        : `${Math.round(e.share! * 100)}% of days`;
  return (
    <>
      <div className="mb-1 text-[12px]">
        <span className="font-semibold">{g.label}</span>{' '}
        <span className="text-[var(--text-muted)]">
          · {g.rows.length} days · median max loss{' '}
          <b className="text-[var(--text-primary)]">{rs(g.medianMaxLoss)}</b> (mean{' '}
          {rs(g.meanMaxLoss)})
        </span>
      </div>
      <table className="border-collapse">
        <thead className="text-[var(--text-muted)]">
          <tr className="border-b border-[var(--border)] text-right">
            <th className={`${thCls} text-left`}>Exit at</th>
            <th className={`${thCls} text-left`}>Reached by</th>
            <th className={thCls}>Red days</th>
            <th className={thCls}>Money lost</th>
            <th className={thCls}>Avg loss</th>
            <th className={thCls}>Median loss</th>
            <th className={thCls}>Worst day</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {g.exits.map((e) => {
            const clickable = e.level != null;
            const chosen = clickable && picked === e.level;
            return (
              <tr
                key={e.level ?? 'hold'}
                onClick={clickable ? () => onPick(e.level!) : undefined}
                title={clickable ? 'Show what the loss did after this level was hit' : undefined}
                className={`border-b border-[var(--border)]/40 text-right ${clickable ? 'cursor-pointer hover:bg-[var(--bg-secondary)]' : 'text-[var(--text-muted)]'} ${chosen ? 'bg-[var(--accent)]/15' : ''}`}
              >
                <td className={`${tdCls} text-left font-semibold`}>
                  {e.level == null ? '—' : `−${rs(e.level)}`}
                  {clickable && (
                    <span className="ml-1 font-normal text-[var(--text-muted)]">
                      {chosen ? '▾' : '▸'}
                    </span>
                  )}
                </td>
                <td className={`${tdCls} text-left font-sans`}>{label(e)}</td>
                <td className={tdCls}>
                  {e.redDays}{' '}
                  <span className="text-[var(--text-muted)]">({pctText(e.redPct)})</span>
                </td>
                <td className={tdCls} style={{ color: LOSS }}>
                  {rs(e.lost)}
                </td>
                <td className={tdCls}>{rs(e.avg)}</td>
                <td className={tdCls}>{rs(e.median)}</td>
                <td className={tdCls}>{rs(e.worst)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const MOVE_LABEL: Record<TreeNode['kind'], (level: string) => string> = {
  hit: (l) => `Hit −${l}`,
  further: (l) => `Fell further, past −${l}`,
  newLow: (l) => `Fell deeper than before, past −${l}`,
  fellBack: (l) => `Fell back past −${l}, no deeper than before`,
  reloss: (l) => `Fell back into loss, past −${l}`,
  zero: () => 'Recovered to zero',
  back: (l) => `Came back to −${l}`,
  close: () => 'No further move — held to the close',
  more: () => 'Kept swinging',
};

function TreeView({
  t,
  groupLabel,
  onOpenDay,
}: {
  t: AfterHit;
  groupLabel: string;
  onOpenDay: (date: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12px] font-semibold">
          {groupLabel}: after −{rs(t.level)} was hit — {t.days} days
        </span>
        <span className="text-[var(--text-muted)]">usually hit around {hhmm(t.hitMinute)}</span>
      </div>
      <div className="mb-1.5 font-mono">
        <span className="font-sans text-[var(--text-muted)]">Rest of the day: </span>
        deepest after the hit −{rs(t.summary.deepest.median)}{' '}
        <span className="text-[var(--text-muted)]">(−{rs(t.summary.deepest.mean)})</span>
        <span className="font-sans text-[var(--text-muted)]"> · back to zero at some point: </span>
        {t.summary.backToZero} days ({pctText((t.summary.backToZero / t.days) * 100)})
        <span className="font-sans text-[var(--text-muted)]"> · closed </span>
        {lossText(t.summary.close.median)}{' '}
        <span className="text-[var(--text-muted)]">({lossText(t.summary.close.mean)})</span>
      </div>
      <div className="mb-1 text-[10px] text-[var(--text-muted)]">
        Told in this table's levels: {t.levels.map((l) => (l ? `−${rs(l)}` : '0')).join(', ')}. A
        move is the loss reaching the next level; it turns when the loss comes back a whole level.
        Each line: days and share of the line above · the furthest the loss got on that move
        (median, mean in brackets) · median time. Profit counts as zero loss. Click "dates" to list
        the days and open one.
      </div>
      <ul>
        {t.root.children.map((c) => (
          <Node key={c.path} node={c} depth={0} onOpenDay={onOpenDay} />
        ))}
      </ul>
    </div>
  );
}

function Node({
  node,
  depth,
  onOpenDay,
}: {
  node: TreeNode;
  depth: number;
  onOpenDay: (date: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const [showDates, setShowDates] = useState(false);
  const isMove = node.kind !== 'close' && node.kind !== 'more';
  const grows =
    node.kind === 'further' ||
    node.kind === 'newLow' ||
    node.kind === 'fellBack' ||
    node.kind === 'reloss';
  return (
    <li className="py-0.5" style={{ paddingLeft: depth ? 14 : 0 }}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        {node.children.length > 0 ? (
          <button
            type="button"
            className="w-3 text-[var(--text-muted)]"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? 'Fold' : 'Unfold'}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className="font-semibold" style={grows ? { color: LOSS } : undefined}>
          {MOVE_LABEL[node.kind](rs(node.level))}
        </span>
        <span>
          <b>{node.days}</b> days{' '}
          <span className="text-[var(--text-muted)]">({pctText(node.pct)})</span>
        </span>
        {isMove && node.ext && node.kind !== 'zero' && (
          <span className="font-mono">
            {grows ? 'lowest' : 'best'} −{rs(node.ext.median)}{' '}
            <span className="text-[var(--text-muted)]">(−{rs(node.ext.mean)})</span>
          </span>
        )}
        {isMove && node.minute != null && (
          <span className="text-[var(--text-muted)]">
            {hhmm(node.minute)}, {node.minutesAfterHit} min after the hit
          </span>
        )}
        {!isMove && node.close && (
          <span className="font-mono">
            closed {lossText(node.close.median)}{' '}
            <span className="text-[var(--text-muted)]">({lossText(node.close.mean)})</span>
            {node.closedAtOrAboveZero ? (
              <span className="font-sans text-[var(--text-muted)]">
                {' '}
                · {node.closedAtOrAboveZero} at or above zero
              </span>
            ) : null}
            {node.kind === 'more' && node.extraMoves != null && (
              <span className="font-sans text-[var(--text-muted)]">
                {' '}
                · median {node.extraMoves} more moves
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          className="text-[var(--accent)] hover:underline"
          onClick={() => setShowDates((s) => !s)}
        >
          dates {showDates ? '▴' : '▾'}
        </button>
      </div>
      {showDates && (
        <div className="ml-5 mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
          {node.dates.map((d) => (
            <button
              key={d}
              type="button"
              className="text-[var(--accent)] hover:underline"
              onClick={() => onOpenDay(d)}
              title="Open this day's chart"
            >
              {d}
            </button>
          ))}
        </div>
      )}
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <Node key={c.path} node={c} depth={depth + 1} onOpenDay={onOpenDay} />
          ))}
        </ul>
      )}
    </li>
  );
}
