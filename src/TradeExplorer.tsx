/**
 * Trade Explorer: every Signal Backtest day in one table, read from a run saved on disk so nothing
 * recalculates. Each column filters and sorts in its own header; grouping sits in one bar above the
 * table and shows its figures in the same columns. Clicking a day opens its chart and the option
 * chain at the signal minute beside the table.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import './tradeExplorer.css';
import TradeExplorerDetail from './components/TradeExplorerDetail';
import { IV_LEVELS } from './lib/ivSignal';
import {
  COLUMNS,
  REPORT_GROUPS,
  COLUMN_BY_KEY,
  DEFAULT_COLUMN_KEYS,
  aggregate,
  bucketRows,
  allGroupIds,
  applyFilters,
  buildDayRows,
  buildItems,
  categoryValues,
  filterActive,
  formatCell,
  lossSummary,
  type Aggregate,
  type Column,
  type ColumnFilter,
  type DayRow,
  type Filters,
  type GroupPlan,
  type SavedRow,
  type SortState,
  type TableItem,
} from './lib/tradeExplorer';
import type { SignalUnderlying } from './lib/signalBacktest';
import type { Theme } from './types';

const UNDERLYINGS: SignalUnderlying[] = ['NIFTY', 'SENSEX'];
const SETTINGS_KEY = 'nubra-trade-explorer-v2';
const OVERSCAN = 12;
const GROUPED_DATE_WIDTH = 230;

interface Settings {
  underlying: SignalUnderlying;
  columns: string[];
  detailColumns?: string[];
  filters: Filters;
  sort: SortState;
  plan: GroupPlan;
}

const DEFAULT_SETTINGS: Settings = {
  underlying: 'NIFTY',
  columns: DEFAULT_COLUMN_KEYS,
  filters: {},
  sort: { key: 'maxLoss', dir: -1 },
  plan: { first: null, second: null, bands: 5, sortGroups: false, how: 'median' },
};

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? 'null',
    ) as Partial<Settings> | null;
    if (!raw) return DEFAULT_SETTINGS;
    const columns = Array.isArray(raw.columns)
      ? raw.columns.filter((k) => COLUMN_BY_KEY.has(k))
      : DEFAULT_COLUMN_KEYS;
    return {
      underlying: raw.underlying === 'SENSEX' ? 'SENSEX' : 'NIFTY',
      columns: columns.length ? columns : DEFAULT_COLUMN_KEYS,
      detailColumns: Array.isArray(raw.detailColumns)
        ? raw.detailColumns.filter((k) => COLUMN_BY_KEY.has(k))
        : undefined,
      filters: raw.filters && typeof raw.filters === 'object' ? raw.filters : {},
      sort:
        raw.sort &&
        (raw.sort.key === '' || COLUMN_BY_KEY.has(raw.sort.key)) &&
        (raw.sort.dir === 1 || raw.sort.dir === -1)
          ? raw.sort
          : DEFAULT_SETTINGS.sort,
      plan: { ...DEFAULT_SETTINGS.plan, ...raw.plan },
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const money = (v: number | null) => (v == null ? '–' : `₹${Math.round(v).toLocaleString('en-IN')}`);

const fieldClass =
  'rounded border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-primary)]';

const LEVEL_COLOR: Record<string, string> = {
  [IV_LEVELS[4]]: 'var(--red)',
  [IV_LEVELS[3]]: 'var(--yellow)',
  [IV_LEVELS[1]]: 'var(--cyan)',
  [IV_LEVELS[0]]: 'var(--blue)',
};

function cellColor(c: Column, v: unknown): string | undefined {
  if (c.key === 'ivLevel' && typeof v === 'string') return LEVEL_COLOR[v];
  if (c.signed && typeof v === 'number' && v !== 0) return v < 0 ? 'var(--red)' : 'var(--green)';
  return undefined;
}

const isYesNo = (c: Column) => c.type === 'cat' && c.order?.[0] === 'Yes';

function groupCell(c: Column, rows: DayRow[], how: Aggregate): string {
  if (c.noFigure) return '';
  if (c.type === 'num' || c.type === 'time') {
    const v = aggregate(rows, c.key, how);
    return v == null ? '–' : formatCell(c, v);
  }
  if (isYesNo(c)) {
    return `${Math.round((rows.filter((r) => r.values[c.key] === 'Yes').length / rows.length) * 100)}%`;
  }
  return '';
}

/** Closes on an outside press or Escape; placed by the button that opened it, so tables cannot clip it. */
function Popover({
  anchor,
  onClose,
  children,
}: {
  anchor: DOMRect;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const style: CSSProperties = {
    position: 'fixed',
    top: Math.min(anchor.bottom + 2, window.innerHeight - 340),
    left: Math.min(anchor.left, window.innerWidth - 300),
    zIndex: 60,
  };
  return (
    <div
      ref={box}
      style={style}
      className="max-h-[330px] overflow-auto rounded border border-[var(--border)] bg-[var(--bg-card)] p-2 text-[11px] shadow-lg"
    >
      {children}
    </div>
  );
}

function CategoryFilter({
  column,
  rows,
  filter,
  onChange,
}: {
  column: Column;
  rows: DayRow[];
  filter: ColumnFilter | undefined;
  onChange: (f: ColumnFilter | undefined) => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const all = useMemo(() => categoryValues(column, rows), [column, rows]);
  const counts = useMemo(() => {
    const m = new Map<unknown, number>();
    for (const r of rows) m.set(r.values[column.key], (m.get(r.values[column.key]) ?? 0) + 1);
    return m;
  }, [column, rows]);
  const allowed = filter?.values ?? all;
  const toggle = (v: string | number | null) => {
    const next = allowed.includes(v) ? allowed.filter((x) => x !== v) : [...allowed, v];
    onChange(next.length === all.length ? undefined : { values: next });
  };
  return (
    <>
      <button
        type="button"
        className={`h-[38px] w-full truncate ${fieldClass} px-1 text-[10px]`}
        style={
          filter?.values ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined
        }
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        {filter?.values ? `${allowed.length} of ${all.length}` : 'All'} ▾
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close}>
          <div className="mb-1 flex gap-3">
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() => onChange(undefined)}
            >
              All
            </button>
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() => onChange({ values: [] })}
            >
              None
            </button>
          </div>
          {all.map((v) => (
            <label key={String(v)} className="flex min-w-[150px] items-center gap-1.5 py-0.5">
              <input type="checkbox" checked={allowed.includes(v)} onChange={() => toggle(v)} />
              <span className="flex-1">{v == null ? 'No reading' : formatCell(column, v)}</span>
              <span className="text-[var(--text-muted)]">{counts.get(v) ?? 0}</span>
            </label>
          ))}
        </Popover>
      )}
    </>
  );
}

function RangeFilter({
  column,
  filter,
  onChange,
}: {
  column: Column;
  filter: ColumnFilter | undefined;
  onChange: (f: ColumnFilter | undefined) => void;
}) {
  const set = (side: 'min' | 'max', text: string) => {
    const next = { min: filter?.min ?? '', max: filter?.max ?? '', [side]: text };
    onChange(next.min || next.max ? next : undefined);
  };
  const isDate = column.type === 'date';
  const box = `h-[18px] w-full ${fieldClass} px-1 font-mono text-[10px]`;
  const hint = column.type === 'time' ? 'hh:mm' : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      {(['min', 'max'] as const).map((side) => (
        <input
          key={side}
          aria-label={`${column.title}: ${side === 'min' ? 'from' : 'to'}`}
          type={isDate ? 'date' : 'text'}
          inputMode={isDate || column.type === 'time' ? undefined : 'decimal'}
          placeholder={hint ?? (side === 'min' ? 'from' : 'to')}
          className={box}
          value={filter?.[side] ?? ''}
          onChange={(e) => set(side, e.target.value)}
        />
      ))}
    </div>
  );
}

export default function TradeExplorer({ theme }: { theme: Theme }) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const [palette, setPalette] = useState(
    () => localStorage.getItem('explorer-palette') ?? 'midnight',
  );
  useEffect(() => {
    // Follow the app into light mode; the local appearance buttons still work independently.
    if (theme === 'light') setPalette('paper');
  }, [theme]);
  const [compareBy, setCompareBy] = useState('dte');
  const [compact, setCompact] = useState(false);
  const [detailWidth, setDetailWidth] = useState(46);
  const [detailFullscreen, setDetailFullscreen] = useState(false);
  const [showCharts, setShowCharts] = useState(false);
  const ROW_HEIGHT = compact ? 27 : 36;
  const [days, setDays] = useState<DayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [columnsAnchor, setColumnsAnchor] = useState<DOMRect | null>(null);
  const closeColumns = useCallback(() => setColumnsAnchor(null), []);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [tradeSet, setTradeSet] = useState('saved');
  const [setOptions, setSetOptions] = useState([{ key: 'saved', label: 'Saved run · OTM 2' }]);
  const [setLabel, setSetLabel] = useState('Saved run · OTM 2');
  const [unavailableDays, setUnavailableDays] = useState(0);
  const [loadingSet, setLoadingSet] = useState(false);
  const loadedUnderlying = useRef(settings.underlying);
  const underlying = settings.underlying;

  useEffect(() => {
    setSelected(null);
  }, [underlying]);

  useEffect(() => {
    if (!selected) setDetailFullscreen(false);
  }, [selected]);

  useEffect(() => {
    if (!detailFullscreen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"], [role="menu"]'))
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setDetailFullscreen(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [detailFullscreen]);

  useEffect(() => {
    setError(null);
    setOpen(new Set());
    setLoadingSet(true);
    if (loadedUnderlying.current !== underlying) setDays(null);
    loadedUnderlying.current = underlying;
    const ctl = new AbortController();
    fetch(`/api/signal-backtest/explorer-sets?underlying=${underlying}&set=${tradeSet}`, {
      signal: ctl.signal,
    })
      .then(async (res) => {
        const body = (await res.json()) as {
          ok: boolean;
          rows?: SavedRow[];
          setOptions?: Array<{ key: string; label: string }>;
          setLabel?: string;
          skipped?: unknown[];
          error?: string;
        };
        if (body.ok && body.rows) {
          const built = buildDayRows(body.rows, underlying);
          if (body.setOptions) setSetOptions(body.setOptions);
          setSetLabel(body.setLabel ?? tradeSet);
          setUnavailableDays(body.skipped?.length ?? 0);
          setDays(built);
          setLoadingSet(false);
        } else setError(body.error ?? 'The saved run could not be read.');
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoadingSet(false);
        if (!ctl.signal.aborted) setError(`The saved run could not be read: ${String(e)}`);
      });
    return () => ctl.abort();
  }, [underlying, tradeSet]);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* the view still works without remembering */
    }
  }, [settings]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, [days]);

  const { filters, sort, plan } = settings;
  const splitView = !!selected;
  const detailDefaults = DEFAULT_COLUMN_KEYS.filter(
    (k) => !['t1', 'gapPct', 'ivNow', 'ivRatio', 'ceSold', 'peSold', 'premium'].includes(k),
  );
  const columnKeys = splitView ? (settings.detailColumns ?? detailDefaults) : settings.columns;
  const setColumns = (keys: string[]) =>
    update(splitView ? { detailColumns: keys } : { columns: keys });
  const chooseTradeSet = (key: string) => {
    setTradeSet(key);
    if (key === 'worst')
      setSettings((current) => ({
        ...current,
        columns: [...new Set([...current.columns, 'tradeSet'])],
        detailColumns: [...new Set([...(current.detailColumns ?? detailDefaults), 'tradeSet'])],
      }));
  };
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = 0;
  }, [splitView]);
  const columns = useMemo(() => {
    const on = new Set(columnKeys);
    on.add('date');
    return COLUMNS.filter((c) => on.has(c.key));
  }, [columnKeys]);

  const filtered = useMemo(() => (days ? applyFilters(days, filters) : []), [days, filters]);
  const items = useMemo(() => buildItems(filtered, sort, plan, open), [filtered, sort, plan, open]);
  const summary = useMemo(() => lossSummary(filtered), [filtered]);
  const baseline = useMemo(() => lossSummary(days ?? []), [days]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setView((v) => ({ ...v, top: 0 }));
  }, [filters, plan, compact, underlying]);
  const dayItems = useMemo(
    () => items.flatMap((it) => (it.kind === 'day' ? [it.row] : [])),
    [items],
  );
  const selectedRow = useMemo(
    () => days?.find((d) => d.raw.date === selected) ?? null,
    [days, selected],
  );
  const selectedIndex = dayItems.findIndex((d) => d.raw.date === selected);

  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const setPlan = (patch: Partial<GroupPlan>) => {
    setSettings((s) => ({ ...s, plan: { ...s.plan, ...patch } }));
    if (patch.first !== undefined || patch.second !== undefined || patch.bands !== undefined) {
      setOpen(new Set());
    }
  };
  const setFilter = (key: string, f: ColumnFilter | undefined) =>
    setSettings((s) => {
      const next = { ...s.filters };
      if (f) next[key] = f;
      else delete next[key];
      return { ...s, filters: next };
    });
  const clickSort = (c: Column) =>
    update({
      sort:
        sort.key === c.key
          ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 }
          : { key: c.key, dir: c.type === 'cat' ? 1 : -1 },
    });
  const toggleGroup = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reveal = useCallback(
    (date: string) => {
      const el = scroller.current;
      const n = items.findIndex((it) => it.kind === 'day' && it.row.raw.date === date);
      if (!el || n < 0) return;
      const header = el.querySelector('thead')?.getBoundingClientRect().height ?? 0;
      const top = n * ROW_HEIGHT;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_HEIGHT + header > el.scrollTop + el.clientHeight) {
        el.scrollTop = top + ROW_HEIGHT + header - el.clientHeight;
      }
    },
    [items],
  );
  const step = (dir: -1 | 1) => {
    const next = dayItems[selectedIndex + dir];
    if (!next) return;
    setSelected(next.raw.date);
    reveal(next.raw.date);
  };

  if (error) {
    return <div className="p-4 text-[12px] text-[var(--red)]">{error}</div>;
  }
  if (!days) {
    return (
      <div className="p-4 text-[12px] text-[var(--text-muted)]">
        Loading stored prices and comparing trade sets… The first load can take a few minutes.
      </div>
    );
  }

  const activeFilters = Object.values(filters).filter(filterActive).length;
  const grouped = plan.first != null;
  const firstWidth = grouped ? GROUPED_DATE_WIDTH : columns[0].width;
  const tableWidth = columns.reduce((a, c, i) => a + (i === 0 ? firstWidth : c.width), 0);
  const groupable = COLUMNS.filter(
    (c) => c.type === 'cat' || c.type === 'num' || c.type === 'time',
  );
  const sections = [...new Set(COLUMNS.map((c) => c.section))];
  const groupOptions = sections.map((s) => (
    <optgroup key={s} label={s}>
      {groupable
        .filter((c) => c.section === s)
        .map((c) => (
          <option key={c.key} value={c.key}>
            {c.title}
          </option>
        ))}
    </optgroup>
  ));

  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(items.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const pinned: CSSProperties = { position: 'sticky', left: 0, zIndex: 2 };
  const select = `h-6 ${fieldClass} px-1 text-[11px]`;

  const renderItem = (it: TableItem, n: number) => {
    if (it.kind === 'group') {
      return (
        <tr
          key={`g-${it.id}`}
          style={{ height: ROW_HEIGHT }}
          className="cursor-pointer bg-[var(--bg-secondary)] font-semibold hover:bg-[var(--bg-hover)]"
          onClick={() => toggleGroup(it.id)}
        >
          {columns.map((c, i) =>
            i === 0 ? (
              <td
                key={c.key}
                style={{ ...pinned, paddingLeft: 6 + it.depth * 14 }}
                className="truncate border-b border-[var(--border)] bg-[var(--bg-secondary)] pr-1"
                title={it.label}
              >
                <span className="mr-1 inline-block w-3 text-[var(--text-muted)]">
                  {it.open ? '▾' : '▸'}
                </span>
                {it.label}{' '}
                <span className="font-normal text-[var(--text-muted)]">({it.rows.length})</span>
              </td>
            ) : (
              <td
                key={c.key}
                className="truncate border-b border-[var(--border)] px-1.5 text-right font-mono"
              >
                {groupCell(c, it.rows, plan.how)}
              </td>
            ),
          )}
        </tr>
      );
    }
    const date = it.row.raw.date;
    const on = date === selected;
    const bg = on ? 'var(--accent-dim)' : n % 2 ? 'var(--bg-secondary)' : 'var(--bg-primary)';
    return (
      <tr
        key={`d-${date}-${n}`}
        style={{
          height: ROW_HEIGHT,
          background: bg,
          boxShadow: on ? 'inset 3px 0 var(--accent)' : undefined,
        }}
        className="cursor-pointer hover:bg-[var(--bg-hover)]"
        onClick={() => setSelected(date)}
      >
        {columns.map((c, i) => {
          const v = it.row.values[c.key];
          return i === 0 ? (
            <td
              key={c.key}
              style={{ ...pinned, paddingLeft: 6 + it.depth * 14, background: bg }}
              className="truncate border-b border-[var(--border)] pr-1 font-semibold"
            >
              {date}
              {it.row.raw.estimated && (
                <span
                  title="Includes estimated option prices"
                  className="ml-1 text-[var(--yellow)]"
                >
                  ≈
                </span>
              )}
            </td>
          ) : (
            <td
              key={c.key}
              style={{ color: cellColor(c, v) }}
              title={
                c.key === 'ivLevel' && v == null
                  ? it.row.values.ivNow == null
                    ? 'IV missing at the signal minute'
                    : Number(it.row.values.ivHistoryCount) < 4
                      ? `Baseline building: ${it.row.values.ivHistoryCount} of 4 required earlier matching days`
                      : 'No calibrated thresholds for this distance to expiry; see IV now and IV ratio'
                  : undefined
              }
              className={`truncate border-b border-[var(--border)] px-1.5 ${c.type === 'cat' ? 'text-left' : 'text-right font-mono'}`}
            >
              {formatCell(c, v)}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <div
      className={`trade-explorer flex h-full min-h-0 flex-col text-[13px] text-[var(--text-primary)] ${detailFullscreen ? 'te-detail-fullscreen' : ''}`}
      data-palette={palette}
    >
      <header className="te-masthead">
        <div>
          <div className="te-eyebrow">
            RESEARCH WORKSPACE <span> / SIGNAL BACKTEST</span>
          </div>
          <h1>
            Trade Explorer
            <span className="te-live-dot" />
          </h1>
          <p>Find the pattern. Understand the risk. Inspect the trade.</p>
        </div>
        <div className="te-theme">
          <span>Appearance</span>
          {['midnight', 'paper'].map((p) => (
            <button
              key={p}
              aria-pressed={palette === p}
              onClick={() => {
                setPalette(p);
                localStorage.setItem('explorer-palette', p);
              }}
            >
              {p === 'midnight' ? '◐ Midnight' : '☀ Paper'}
            </button>
          ))}
        </div>
      </header>
      <div className="te-toolbar flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex overflow-hidden rounded border border-[var(--border)]">
          {UNDERLYINGS.map((u) => (
            <button
              key={u}
              type="button"
              className="border-r border-[var(--border)] px-2 py-1 font-semibold last:border-r-0"
              style={
                u === underlying
                  ? { background: 'var(--accent)', color: 'var(--bg-primary)' }
                  : undefined
              }
              aria-pressed={u === underlying}
              onClick={() => {
                setSelected(null);
                if (u !== underlying) setTradeSet('saved');
                update({ underlying: u });
              }}
            >
              {u}
            </button>
          ))}
        </div>
        <label>
          Date from{' '}
          <input
            aria-label="Date from"
            type="date"
            className={fieldClass}
            value={filters.date?.min ?? ''}
            onChange={(e) => setFilter('date', { ...filters.date, min: e.target.value })}
          />
        </label>
        <label>
          to{' '}
          <input
            aria-label="Date to"
            type="date"
            className={fieldClass}
            value={filters.date?.max ?? ''}
            onChange={(e) => setFilter('date', { ...filters.date, max: e.target.value })}
          />
        </label>
        <label>
          View{' '}
          <select
            className={select}
            defaultValue=""
            onChange={(e) => {
              const presets: Record<string, string[]> = {
                overview: ['date', 'dte', 'ivLevel', 'premium', 'maxLoss', 'pnl', 'red'],
                signal: COLUMNS.filter((c) =>
                  ['Signal', 'IV signal', 'Greeks'].includes(c.section),
                ).map((c) => c.key),
                loss: [
                  'date',
                  'dte',
                  'maxLoss',
                  'maxLossPct',
                  'maxLossAt',
                  'pnl',
                  'red',
                  'lossGroup',
                  'path',
                ],
                sales: [
                  'date',
                  'dte',
                  'tradeSet',
                  'ceSold',
                  'ceEntry',
                  'peSold',
                  'peEntry',
                  'premium',
                  'maxLoss',
                  'maxLossAt',
                  'pnl',
                  'worstSet',
                  'worstLoss',
                ],
                quality: ['date', 'source', 'dataEnd', 'maxLoss', 'pnl'],
              };
              if (presets[e.target.value]) setColumns(presets[e.target.value]);
            }}
          >
            <option value="">Choose columns…</option>
            <option value="overview">Overview</option>
            <option value="signal">Signal & IV</option>
            <option value="loss">Loss Analysis</option>
            <option value="quality">Data Quality</option>
            <option value="sales">Sale prices & premiums</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} />{' '}
          Compact
        </label>
        <label>
          <input
            type="checkbox"
            checked={showCharts}
            onChange={(e) => setShowCharts(e.target.checked)}
          />{' '}
          Analysis charts
        </label>
        <span className="flex-1" />
        <button
          type="button"
          className={`h-6 ${fieldClass} px-2`}
          onClick={(e) => setColumnsAnchor(e.currentTarget.getBoundingClientRect())}
        >
          {splitView ? 'Detail view columns' : 'Columns'} ({columns.length}) ▾
        </button>
        {columnsAnchor && (
          <Popover anchor={columnsAnchor} onClose={closeColumns}>
            <div className="mb-1 flex gap-3">
              <button
                type="button"
                className="text-[var(--accent)]"
                onClick={() => setColumns(splitView ? detailDefaults : DEFAULT_COLUMN_KEYS)}
              >
                Key columns
              </button>
              <button
                type="button"
                className="text-[var(--accent)]"
                onClick={() => setColumns(COLUMNS.map((c) => c.key))}
              >
                All columns
              </button>
            </div>
            {sections.map((s) => (
              <div key={s} className="mb-1">
                <div className="font-semibold text-[var(--text-muted)]">{s}</div>
                {COLUMNS.filter((c) => c.section === s && c.key !== 'date').map((c) => (
                  <label key={c.key} className="flex items-center gap-1.5 py-0.5">
                    <input
                      type="checkbox"
                      checked={columnKeys.includes(c.key)}
                      onChange={(e) =>
                        setColumns(
                          e.target.checked
                            ? [...columnKeys, c.key]
                            : columnKeys.filter((k) => k !== c.key),
                        )
                      }
                    />
                    {c.title}
                  </label>
                ))}
              </div>
            ))}
          </Popover>
        )}
      </div>

      <div className="te-set-context">
        <label>
          Trade set
          <select
            aria-label="Trade set"
            value={tradeSet}
            onChange={(e) => chooseTradeSet(e.target.value)}
          >
            {setOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span>
          <b>{setLabel}</b> · both legs sold · entry signal + 1 minute · exit 15:29 · 1 current lot
        </span>
        <div className="mt-1 text-[var(--text-muted)]">
          {loadingSet
            ? 'Loading selected set… currently displayed data stays unchanged until ready. '
            : ''}
          {days
            ? `${days.length.toLocaleString()} days · ${unavailableDays} days unavailable for this selection`
            : 'Loading stored prices and comparing trade sets… first load may take a moment.'}
          {
            ' · Price bands apply to each leg and vary by days to expiry. Worst set uses hindsight across pairs with stored prices.'
          }
        </div>
      </div>

      <div className="te-grouping flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-card)] p-3">
        <span>Group by</span>
        <div className="te-group-shortcuts">
          {[{ key: '', label: 'None' }, ...REPORT_GROUPS].map((g) => {
            const active = (plan.first ?? '') === g.key;
            return (
              <button
                key={g.key}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  setPlan({ first: g.key || null, second: g.key ? plan.second : null })
                }
              >
                {g.label}
              </button>
            );
          })}
        </div>
        <select
          aria-label="Group by another column"
          className={select}
          value={plan.first && !REPORT_GROUPS.some((g) => g.key === plan.first) ? plan.first : ''}
          onChange={(e) => e.target.value && setPlan({ first: e.target.value })}
        >
          <option value="">Other column…</option>
          {groupOptions}
        </select>
        {grouped && (
          <>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">
              then
              <select
                className={select}
                value={plan.second ?? ''}
                onChange={(e) => setPlan({ second: e.target.value || null })}
              >
                <option value="">Nothing</option>
                {groupOptions}
              </select>
            </label>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">
              Numbers in
              <select
                className={select}
                value={plan.bands}
                onChange={(e) => setPlan({ bands: Number(e.target.value) })}
              >
                <option value={3}>thirds</option>
                <option value={5}>fifths</option>
                <option value={10}>tenths</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">
              Group rows show
              <select
                className={select}
                value={plan.how}
                onChange={(e) => setPlan({ how: e.target.value as Aggregate })}
              >
                <option value="median">Median</option>
                <option value="mean">Average</option>
                <option value="max">Highest</option>
                <option value="min">Lowest</option>
              </select>
            </label>
            <label className="flex items-center gap-1 text-[var(--text-muted)]">
              <input
                type="checkbox"
                checked={plan.sortGroups}
                onChange={(e) => setPlan({ sortGroups: e.target.checked })}
              />
              Sort groups too
            </label>
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() => setOpen(new Set(allGroupIds(filtered, plan)))}
            >
              Expand all
            </button>
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() => setOpen(new Set())}
            >
              Collapse all
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2 px-3 py-2">
        {Object.entries(filters)
          .filter(([, f]) => filterActive(f))
          .map(([key, f]) => {
            const c = COLUMN_BY_KEY.get(key);
            return (
              <button
                key={key}
                className={`${fieldClass} px-2 py-1`}
                onClick={() => setFilter(key, undefined)}
                title="Remove filter"
              >
                {c?.title ?? key}:{' '}
                {f.values
                  ? f.values.length
                    ? f.values.map((v) => (c ? formatCell(c, v) : String(v))).join(', ')
                    : 'None'
                  : `${f.min || 'Any'} → ${f.max || 'Any'}`}{' '}
                ×
              </button>
            );
          })}
      </div>
      <div className="te-metrics">
        {[
          ['Days analyzed', String(summary.days), String(days.length)],
          ['Median max loss', money(summary.median), money(baseline.median)],
          ['Average max loss', money(summary.mean), money(baseline.mean)],
          ['1 in 10 past', money(summary.oneInTen), money(baseline.oneInTen)],
          ['Worst loss', money(summary.worst), money(baseline.worst)],
          [
            'Closed red',
            summary.closedRed == null ? '–' : `${Math.round(summary.closedRed * 100)}%`,
            baseline.closedRed == null ? '–' : `${Math.round(baseline.closedRed! * 100)}%`,
          ],
        ].map(([label, value, baseline]) => (
          <div key={label} className="te-metric">
            <div className="text-xs text-[var(--text-muted)]">{label}</div>
            <div className="te-metric-value">{value}</div>
            <div className="text-xs text-[var(--text-muted)]">Full sample: {baseline}</div>
          </div>
        ))}
      </div>
      {showCharts && (
        <div className="te-analysis-overlay">
          <div className="te-analysis-overlay-heading">
            <strong>Analysis charts</strong>
            <button onClick={() => setShowCharts(false)} aria-label="Close analysis charts">
              Close ×
            </button>
          </div>
          <ExplorerCharts
            rows={filtered}
            plan={{ ...plan, first: compareBy }}
            onFilter={setFilter}
            compareBy={compareBy}
            onCompare={setCompareBy}
          />
        </div>
      )}
      <div className="te-quality">
        <span className="te-quality-dot" /> {filtered.filter((r) => r.raw.estimated).length}{' '}
        estimated-price days <span>•</span>{' '}
        {filtered.filter((r) => columns.some((c) => r.values[c.key] == null)).length} days missing a
        visible reading{' '}
        <details>
          <summary>About this data</summary>
          <p>
            Signal, IV and Greeks describe information at the signal. Path, losing leg and loss
            figures describe later outcomes. All amounts use today's lot size across every year.
          </p>
        </details>
      </div>
      <div className="te-table-heading">
        <div>
          <span className="te-eyebrow">TRADE JOURNAL</span>
          <strong>{summary.days.toLocaleString('en-IN')} trading days</strong>
          <span>Click any day to inspect its chart and signal</span>
        </div>
        {sort.key && (
          <button type="button" onClick={() => update({ sort: { key: '', dir: 1 } })}>
            Clear sorting
          </button>
        )}
        <span className="te-sort-hint">
          Click a column heading to sort · click again to reverse
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1">
        <span className="text-[var(--text-muted)]">
          {setLabel} · data through {days[days.length - 1]?.raw.date} · all ₹ for 1 lot of{' '}
          {days[0]?.raw.trade.qty}, today's lot size in every year
        </span>
        {activeFilters > 0 && (
          <button
            type="button"
            className="text-[var(--accent)]"
            onClick={() => update({ filters: {} })}
          >
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
      </div>

      <div className="te-table-workspace flex min-h-0 flex-1">
        <div
          ref={scroller}
          tabIndex={0}
          className="min-w-0 flex-1 overflow-auto outline-none"
          onScroll={(e) => {
            const top = e.currentTarget.scrollTop;
            setView((v) => (v.top === top ? v : { ...v, top }));
          }}
          onKeyDown={(e) => {
            if (!selected || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
            if ((e.target as HTMLElement).tagName === 'INPUT') return;
            e.preventDefault();
            step(e.key === 'ArrowDown' ? 1 : -1);
          }}
        >
          <table
            className="border-collapse"
            style={{
              tableLayout: 'fixed',
              width: splitView ? '100%' : tableWidth,
              minWidth: splitView ? Math.max(760, columns.length * 60) : undefined,
            }}
          >
            <colgroup>
              {columns.map((c, i) => (
                <col
                  key={c.key}
                  style={{
                    width: splitView
                      ? `${((i === 0 ? firstWidth : c.width) / tableWidth) * 100}%`
                      : i === 0
                        ? firstWidth
                        : c.width,
                  }}
                />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)]">
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={c.key}
                    title={c.title}
                    aria-sort={
                      sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'
                    }
                    style={i === 0 ? { ...pinned, zIndex: 3 } : undefined}
                    className="bg-[var(--bg-card)] p-0 font-semibold"
                  >
                    <div className="flex items-center">
                      <button
                        type="button"
                        className={`flex min-w-0 flex-1 items-center gap-0.5 truncate px-1.5 py-1 ${c.type === 'cat' || i === 0 ? 'justify-start' : 'justify-end'}`}
                        style={sort.key === c.key ? { color: 'var(--accent)' } : undefined}
                        onClick={() => clickSort(c)}
                      >
                        <span className="truncate">{c.label}</span>
                        {sort.key === c.key && <span>{sort.dir === -1 ? '↓' : '↑'}</span>}
                      </button>
                      {sort.key === c.key && (
                        <button
                          type="button"
                          className="te-column-clear"
                          aria-label={`Clear sorting for ${c.title}`}
                          title={`Clear sorting for ${c.title}`}
                          onClick={() => update({ sort: { key: '', dir: 1 } })}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
              <tr>
                {columns.map((c, i) => (
                  <th
                    key={c.key}
                    style={i === 0 ? { ...pinned, zIndex: 3 } : undefined}
                    className="border-b border-[var(--border)] bg-[var(--bg-card)] px-0.5 pb-1 font-normal"
                  >
                    <div className="flex items-center gap-0.5">
                      <div className="min-w-0 flex-1">
                        {c.type === 'cat' ? (
                          <CategoryFilter
                            column={c}
                            rows={days}
                            filter={filters[c.key]}
                            onChange={(f) => setFilter(c.key, f)}
                          />
                        ) : (
                          <RangeFilter
                            column={c}
                            filter={filters[c.key]}
                            onChange={(f) => setFilter(c.key, f)}
                          />
                        )}
                      </div>
                      {filterActive(filters[c.key]) && (
                        <button
                          type="button"
                          className="te-column-clear"
                          aria-label={`Clear filter for ${c.title}`}
                          title={`Clear filter for ${c.title}`}
                          onClick={() => setFilter(c.key, undefined)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {first > 0 && <tr style={{ height: first * ROW_HEIGHT }} />}
              {items.slice(first, last).map((it, i) => renderItem(it, first + i))}
              {last < items.length && <tr style={{ height: (items.length - last) * ROW_HEIGHT }} />}
            </tbody>
          </table>
          {items.length === 0 && (
            <div className="p-4 text-[12px] text-[var(--text-muted)]">
              No day passes these filters.
            </div>
          )}
        </div>
        {selectedRow && (
          <div className="te-detail min-w-0 shrink-0" style={{ width: `${detailWidth}%` }}>
            <label className="te-detail-width flex items-center gap-2 px-3 py-1 text-xs">
              Detail width{' '}
              <input
                aria-label="Detail width"
                type="range"
                min="30"
                max="75"
                value={detailWidth}
                onChange={(e) => setDetailWidth(Number(e.target.value))}
              />
            </label>
            <TradeExplorerDetail
              row={selectedRow}
              onSelectSet={chooseTradeSet}
              fullscreen={detailFullscreen}
              onToggleFullscreen={() => setDetailFullscreen((value) => !value)}
              theme={mobile || palette === 'paper' ? 'light' : 'dark'}
              underlying={underlying}
              position={
                selectedIndex >= 0
                  ? `Day ${selectedIndex + 1} of ${dayItems.length} in this list · ↑ ↓ for the previous / next day`
                  : 'Not in the current list'
              }
              onClose={() => setSelected(null)}
              onStep={step}
              canStep={{
                prev: selectedIndex > 0,
                next: selectedIndex >= 0 && selectedIndex < dayItems.length - 1,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ExplorerCharts({
  rows,
  plan,
  onFilter,
  compareBy,
  onCompare,
}: {
  rows: DayRow[];
  plan: GroupPlan;
  onFilter: (key: string, filter: ColumnFilter) => void;
  compareBy: string;
  onCompare: (key: string) => void;
}) {
  const values = rows.flatMap((r) =>
    typeof r.values.maxLoss === 'number' ? [r.values.maxLoss] : [],
  );
  const ceiling = Math.max(1, ...values);
  const step = ceiling / 8;
  const bins = Array.from({ length: 8 }, (_, i) => {
    const lo = i * step,
      hi = (i + 1) * step;
    return { lo, hi, count: values.filter((v) => v >= lo && (i === 7 ? v <= hi : v < hi)).length };
  });
  const largest = Math.max(1, ...bins.map((b) => b.count));
  const groupColumn = COLUMN_BY_KEY.get(compareBy)!;
  const groups = bucketRows(rows, groupColumn, plan.bands).map((g) => ({
    ...g,
    summary: lossSummary(g.rows),
  }));
  const peak = Math.max(1, ...groups.map((g) => g.summary.median ?? 0));
  return (
    <div className="te-analysis">
      <section className="te-chart-card">
        <div className="te-card-heading">
          <div>
            <span className="te-eyebrow">RISK PROFILE</span>
            <h2>Where do losses concentrate?</h2>
          </div>
          <span className="te-badge">{values.length} readings</span>
        </div>
        <p className="te-caption">Maximum intraday loss · select a range to explore its days</p>
        <div className="te-histogram">
          {bins.map((b, i) => (
            <button
              key={i}
              disabled={!b.count}
              title={`${money(b.lo)} to ${money(b.hi)}: ${b.count} days`}
              onClick={() =>
                onFilter('maxLoss', {
                  min: String(b.lo),
                  max: String(i === 7 ? b.hi : b.hi - Math.max(Number.EPSILON * b.hi, 1e-9)),
                })
              }
            >
              <span className="te-bin-count">{b.count}</span>
              <span className="te-bin-track">
                <span className="te-bin-fill" style={{ height: `${(b.count / largest) * 100}%` }} />
              </span>
              <span className="te-bin-label">{money(b.lo)}</span>
            </button>
          ))}
        </div>
        <div className="te-chart-foot">
          <span>Lower loss</span>
          <span>Maximum loss per lot →</span>
          <span>{money(ceiling)}</span>
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
            {[
              'dte',
              'ivLevel',
              'year',
              'lossGroup',
              'path',
              'warnGroup',
              'direction',
              'losingLeg',
            ].map((k) => (
              <option key={k} value={k}>
                {COLUMN_BY_KEY.get(k)?.title}
              </option>
            ))}
          </select>
        </div>
        <p className="te-caption">Median max loss by condition · click a row to filter</p>
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
              className="te-compare-row"
              onClick={() =>
                onFilter(groupColumn.key, {
                  values: [...new Set(g.rows.map((r) => r.values[groupColumn.key]))],
                })
              }
            >
              <span className="te-condition">
                <span>{g.label}</span>
                <i style={{ width: `${((g.summary.median ?? 0) / peak) * 100}%` }} />
              </span>
              <span
                className={g.rows.length < 20 ? 'te-small-sample' : ''}
                title={g.rows.length < 20 ? 'Small sample: fewer than 20 days' : 'Sample size'}
              >
                {g.rows.length}
              </span>
              <span>{money(g.summary.median)}</span>
              <span>{money(g.summary.oneInTen)}</span>
              <span>
                {g.summary.closedRed == null ? '–' : `${Math.round(g.summary.closedRed * 100)}%`}
              </span>
            </button>
          ))}
        </div>
        <div className="te-chart-foot">
          Amber counts indicate fewer than 20 days. Outcome groups describe hindsight.
        </div>
      </section>
    </div>
  );
}
