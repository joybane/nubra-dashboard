/**
 * Which days the results table shows: by weekday, and by how close the day is to its expiry
 * ("expiry day", "1 day before", "2 days before"…). Choosing nothing on an axis means every day on
 * it; choosing on both shows the days that satisfy both. It only changes what is shown — the run and
 * its saved settings are untouched.
 */
import { useEffect, useRef, useState } from 'react';
import {
  NO_FILTER,
  WEEKDAYS,
  WEEKDAY_NAMES,
  dteLabel,
  filterActive,
  filterRows,
  weekdayIndex,
  type RowFilter as Filter,
  type SignalBacktestRow,
} from '../lib/signalBacktest';

interface Props {
  /** Every row of the run — the chips and their counts come from these, not from the filtered list. */
  rows: SignalBacktestRow[];
  value: Filter;
  onChange: (next: Filter) => void;
}

const toggled = (list: number[], n: number) =>
  list.includes(n) ? list.filter((v) => v !== n) : [...list, n].sort((a, b) => a - b);

export default function RowFilter({ rows, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  // Each axis counts the days the other axis lets through, so a chip says how many it would show.
  const underDte = filterRows(rows, { weekdays: [], dte: value.dte });
  const underWeekday = filterRows(rows, { weekdays: value.weekdays, dte: [] });
  const weekdayCount = WEEKDAYS.map(
    (_, i) => underDte.filter((r) => weekdayIndex(r.date) === i).length,
  );
  const dteValues = [
    ...new Set(rows.map((r) => r.dte).filter((d): d is number => typeof d === 'number')),
  ].sort((a, b) => a - b);
  const dteCount = (d: number) => underWeekday.filter((r) => r.dte === d).length;
  const knownDte = rows.some((r) => typeof r.dte === 'number');

  const active = filterActive(value);
  const picked = value.weekdays.length + value.dte.length;

  const chip = (on: boolean, empty: boolean) =>
    `rounded border px-2 py-1 text-[11px] ${
      on
        ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
        : empty
          ? 'border-[var(--border)] text-[var(--text-muted)]/50'
          : 'border-[var(--border)] text-[var(--text-primary)] hover:border-[var(--accent)]/60'
    }`;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Show only some weekdays, or only days at a set distance from expiry"
        className={`h-6 rounded border px-2 text-[11px] ${
          active
            ? 'border-[var(--accent)] text-[var(--accent)]'
            : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)]'
        }`}
      >
        Filter days{active ? ` · ${picked}` : ''} ▾
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter days"
          className="absolute right-0 top-full z-40 mt-1 w-[min(430px,92vw)] rounded border border-[var(--border)] bg-[var(--bg-card)] p-3 text-[var(--text-primary)] shadow-xl"
        >
          <div className="mb-1 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
            Weekday
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d, i) => {
              const on = value.weekdays.includes(i);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  title={WEEKDAY_NAMES[i]}
                  onClick={() => onChange({ ...value, weekdays: toggled(value.weekdays, i) })}
                  className={chip(on, weekdayCount[i] === 0 && !on)}
                >
                  {d} <span className="font-mono text-[10px] opacity-70">{weekdayCount[i]}</span>
                </button>
              );
            })}
          </div>

          <div className="mb-1 flex items-baseline gap-2 text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
            Days to expiry
            <span className="normal-case tracking-normal">trading days, not calendar days</span>
          </div>
          {knownDte ? (
            <>
              <div className="flex flex-wrap gap-1.5">
                {dteValues.map((d) => {
                  const on = value.dte.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onChange({ ...value, dte: toggled(value.dte, d) })}
                      className={chip(on, dteCount(d) === 0 && !on)}
                    >
                      {dteLabel(d)}{' '}
                      <span className="font-mono text-[10px] opacity-70">{dteCount(d)}</span>
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="mt-1.5 text-[11px] text-[var(--accent)]"
                onClick={() => onChange({ ...value, dte: [0, 1] })}
              >
                expiry day + the day before
              </button>
            </>
          ) : (
            <p className="text-[11px] text-[#f59e0b]">
              This server does not report days to expiry — restart it (Ctrl+C, then npm start) and
              run again.
            </p>
          )}

          <div className="mt-3 flex items-center border-t border-[var(--border)] pt-2 text-[11px]">
            <span className="text-[var(--text-muted)]">
              Showing {filterRows(rows, value).length} of {rows.length} trades
            </span>
            <button
              type="button"
              disabled={!active}
              onClick={() => onChange(NO_FILTER)}
              className="ml-auto text-[var(--accent)] disabled:text-[var(--text-muted)]/50"
            >
              clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="ml-3 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
