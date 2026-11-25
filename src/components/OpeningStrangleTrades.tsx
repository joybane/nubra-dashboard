import { useMemo, useState } from 'react';
import {
  formatPnl,
  openingPnlInUnit,
  openingTime,
  plainAmount,
  type OpeningDaySummary,
  type OpeningUnit,
} from '../lib/openingStrangle';
import { sortOpeningDays, type OpeningSort } from '../lib/openingStrangleReport';

const CELL = 'whitespace-nowrap border-b border-[var(--border)] px-2 py-1.5 text-right';
const BUTTON =
  'rounded border border-[var(--border)] px-2 py-1 font-medium hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40';
const LINK = 'text-[var(--accent)] hover:underline';
const PAGE_SIZE = 50;

export interface OpeningTradeActions {
  days: OpeningDaySummary[];
  unit: OpeningUnit;
  open: (date: string) => void;
  pin: (date: string) => void;
  pins: string[];
}

const COLUMNS = [
  { label: 'Session', key: 'date' },
  { label: 'Entry IST' },
  { label: 'Expiry' },
  { label: 'DTE' },
  { label: 'Source' },
  { label: 'Call strike / premium' },
  { label: 'Put strike / premium' },
  { label: 'Entry credit' },
  { label: '15:29 close', key: 'close' },
  { label: 'Worst mark', key: 'worst' },
  { label: 'Worst at IST' },
  { label: 'Drawdown', key: 'drawdown' },
  { label: 'Marks' },
  { label: 'Compare' },
] as const satisfies ReadonlyArray<{ label: string; key?: OpeningSort }>;

export function OpeningStrangleTrades({
  days,
  unit,
  open,
  pin,
  pins,
  compact = false,
  searchable = false,
}: OpeningTradeActions & { compact?: boolean; searchable?: boolean }) {
  const [sort, setSort] = useState<{ key: OpeningSort; direction: 'asc' | 'desc' }>(() =>
    compact ? { key: 'worst', direction: 'asc' } : { key: 'date', direction: 'desc' },
  );
  const [requestedPage, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const ordered = useMemo(
    () =>
      sortOpeningDays(
        query.trim() ? days.filter((day) => day.date.includes(query.trim())) : days,
        sort.key,
        sort.direction,
        unit,
      ),
    [days, query, sort, unit],
  );
  const pages = compact ? 1 : Math.max(1, Math.ceil(ordered.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const visible = compact ? ordered : ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const search = searchable && (
    <label className="my-2 flex flex-wrap items-center gap-2 text-xs">
      Search by session date
      <input
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(0);
        }}
        placeholder="YYYY-MM-DD"
        className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 text-xs"
      />
    </label>
  );
  if (visible.length === 0)
    return (
      <>
        {search}
        <p className="py-4 text-[var(--text-muted)]">
          {query.trim() ? 'No sessions match the date search.' : 'No sessions to show.'}
        </p>
      </>
    );
  return (
    <>
      {search}
      <div className="overflow-x-auto">
        <table
          aria-label={compact ? 'Worst observed sessions' : 'All replayed trades'}
          className="w-full text-xs tabular-nums"
        >
          <thead>
            <tr>
              {COLUMNS.map((column, index) => {
                const key = 'key' in column ? column.key : undefined;
                const selected = key != null && sort.key === key;
                return (
                  <th
                    key={column.label}
                    scope="col"
                    aria-sort={
                      key
                        ? selected
                          ? sort.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                        : undefined
                    }
                    className={`${CELL} ${index === 0 ? 'text-left' : ''}`}
                  >
                    {key ? (
                      <button
                        type="button"
                        className={LINK}
                        onClick={() => {
                          const direction = selected
                            ? sort.direction === 'asc'
                              ? 'desc'
                              : 'asc'
                            : key === 'worst' || key === 'close'
                              ? 'asc'
                              : 'desc';
                          setSort({ key, direction });
                          setPage(0);
                        }}
                      >
                        {column.label}
                        {selected ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                      </button>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((day) => {
              const pinned = pins.includes(day.date);
              const amount = (value: number | null) =>
                formatPnl(openingPnlInUnit(value, day.entryCredit, unit), unit);
              return (
                <tr key={day.date} className="hover:bg-[var(--bg-secondary)]">
                  <th scope="row" className={`${CELL} text-left`}>
                    <button type="button" className={LINK} onClick={() => open(day.date)}>
                      {day.date}
                    </button>
                  </th>
                  <td className={CELL}>{openingTime(day.entry)}</td>
                  <td className={CELL}>
                    {day.expiry} · {day.monthly ? 'Monthly' : 'Weekly'}
                  </td>
                  <td className={CELL}>{day.dte}</td>
                  <td className={CELL}>{day.source === 'nubra' ? 'Nubra' : 'Local'}</td>
                  <td className={CELL}>
                    {plainAmount(day.ceStrike)} / {formatPnl(day.ceEntry, 'rupees')}
                  </td>
                  <td className={CELL}>
                    {plainAmount(day.peStrike)} / {formatPnl(day.peEntry, 'rupees')}
                  </td>
                  <td className={CELL}>{formatPnl(day.entryCredit, 'rupees')}</td>
                  <td className={CELL}>{amount(day.close)}</td>
                  <td className={CELL}>{amount(day.worst.pnl)}</td>
                  <td className={CELL}>
                    {day.worst.pnl < 0 ? openingTime(day.worst.minute) : '—'}
                  </td>
                  <td className={CELL}>{amount(day.drawdown)}</td>
                  <td className={CELL}>
                    {day.marked}/{day.possible}
                  </td>
                  <td className={CELL}>
                    <button
                      type="button"
                      className={BUTTON}
                      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${day.date}`}
                      aria-pressed={pinned}
                      disabled={!pinned && pins.length === 6}
                      onClick={() => pin(day.date)}
                    >
                      {pinned ? 'Unpin' : 'Pin'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!compact && (
        <nav
          aria-label="Trade pages"
          className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs"
        >
          <span>
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, ordered.length)} of{' '}
            {ordered.length} sessions
          </span>
          <div className="flex gap-1.5">
            <button
              type="button"
              className={BUTTON}
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous page
            </button>
            <button
              type="button"
              className={BUTTON}
              disabled={page >= pages - 1}
              onClick={() => setPage(page + 1)}
            >
              Next page
            </button>
          </div>
        </nav>
      )}
    </>
  );
}
