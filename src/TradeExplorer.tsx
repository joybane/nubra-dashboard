/**
 * Trade Explorer: every Signal Backtest day in one table, read from a run saved on disk so nothing
 * recalculates. Each column filters and sorts in its own header; grouping sits in one bar above the
 * table and shows its figures in the same columns. Clicking a day opens its chart and the option
 * chain at the signal minute beside the table.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import './tradeExplorer.css';
import TradeExplorerDetail from './components/TradeExplorerDetail';
import TradeExplorerCharts from './components/TradeExplorerCharts';
import { IV_LEVELS } from './lib/ivSignal';
import {
  COLUMNS,
  PICKABLE_COLUMNS,
  REPORT_GROUPS,
  COLUMN_BY_KEY,
  DEFAULT_COLUMN_KEYS,
  DEFAULT_SIMILAR_KEYS,
  SIMILAR_KEY,
  SMALL_SAMPLE,
  aggregate,
  allGroupIds,
  applyFilters,
  buildDayRows,
  buildItems,
  categoryValues,
  filterActive,
  formatCell,
  lossSummary,
  money,
  share,
  nearest,
  withSimilarity,
  type Aggregate,
  type Column,
  type ColumnFilter,
  type DayRow,
  type Filters,
  type GroupPlan,
  type LossSummary,
  type SavedRow,
  type SimilarPlan,
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
  /** The last choice for "similar days": which columns to compare and how many days to keep. */
  similarKeys?: string[];
  similarKeep?: number;
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
    // The distance column only exists while a similar-days search is running, which is not saved.
    const known = (k: string) => COLUMN_BY_KEY.has(k) && k !== SIMILAR_KEY;
    const columns = Array.isArray(raw.columns) ? raw.columns.filter(known) : DEFAULT_COLUMN_KEYS;
    const filters = raw.filters && typeof raw.filters === 'object' ? { ...raw.filters } : {};
    delete filters[SIMILAR_KEY];
    return {
      underlying: raw.underlying === 'SENSEX' ? 'SENSEX' : 'NIFTY',
      columns: columns.length ? columns : DEFAULT_COLUMN_KEYS,
      detailColumns: Array.isArray(raw.detailColumns) ? raw.detailColumns.filter(known) : undefined,
      filters,
      sort:
        raw.sort &&
        (raw.sort.key === '' || known(raw.sort.key)) &&
        (raw.sort.dir === 1 || raw.sort.dir === -1)
          ? raw.sort
          : DEFAULT_SETTINGS.sort,
      plan: { ...DEFAULT_SETTINGS.plan, ...raw.plan },
      similarKeys: Array.isArray(raw.similarKeys) ? raw.similarKeys.filter(known) : undefined,
      similarKeep: typeof raw.similarKeep === 'number' ? raw.similarKeep : undefined,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const signedMoney = (v: number | null) =>
  v == null
    ? '–'
    : `${v < 0 ? '−' : v > 0 ? '+' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const signColor = (v: number | null) =>
  v == null || v === 0 ? undefined : v < 0 ? 'var(--red)' : 'var(--green)';
/**
 * The risk figures every group row carries, whatever "Group rows show" is set to: one figure is
 * not enough to judge a group.
 */
const RISK_COLUMNS: Array<{
  key: string;
  label: string;
  title: string;
  width: number;
  cell: (s: LossSummary) => string;
  color?: (s: LossSummary) => string | undefined;
  /** What a single day shows in this column, so the space is not wasted under an open group. */
  day?: (v: DayRow['values']) => string;
  dayColor?: (v: DayRow['values']) => string | undefined;
}> = [
  {
    key: 'median',
    label: 'Median loss',
    title: "The group's median max loss, ₹ per lot",
    width: 88,
    cell: (s) => money(s.median),
    day: (v) => (typeof v.maxLoss === 'number' ? money(v.maxLoss) : ''),
  },
  {
    key: 'oneInTen',
    label: '1 in 10',
    title: 'One day in ten in the group went past this max loss',
    width: 80,
    cell: (s) => money(s.oneInTen),
  },
  {
    key: 'worst',
    label: 'Worst',
    title: "The group's largest max loss",
    width: 80,
    cell: (s) => money(s.worst),
    color: () => 'var(--red)',
  },
  {
    key: 'red',
    label: 'Red',
    title: 'Share of the group that closed in loss at 15:29',
    width: 56,
    cell: (s) => share(s.closedRed),
    day: (v) => (v.red === 'Yes' ? 'red' : ''),
    dayColor: () => 'var(--red)',
  },
  {
    key: 'pnl',
    label: 'Med. 15:29',
    title: "The group's median result at the 15:29 exit",
    width: 84,
    cell: (s) => signedMoney(s.medianPnl),
    color: (s) => signColor(s.medianPnl),
    day: (v) => (typeof v.pnl === 'number' ? signedMoney(v.pnl) : ''),
    dayColor: (v) => (typeof v.pnl === 'number' ? signColor(v.pnl) : undefined),
  },
];
const RISK_WIDTH = RISK_COLUMNS.reduce((a, r) => a + r.width, 0);

const summaries = new WeakMap<DayRow[], LossSummary>();
function summaryOf(rows: DayRow[]): LossSummary {
  let s = summaries.get(rows);
  if (!s) {
    s = lossSummary(rows);
    summaries.set(rows, s);
  }
  return s;
}

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

/** A day clicked in the Strangle Max Loss report, to open here with the report's strike choice. */
export interface ReportOpenRequest {
  underlying: SignalUnderlying;
  date: string;
  /** The report's combination key: `otm0`…`otm7` or `band<n>`, the same keys as the trade sets. */
  key: string;
  seq: number;
}

/** The report's OTM 2 is the saved run itself (with the report's groups), so open that. */
const reportSetKey = (key: string) =>
  key === 'otm2' ? 'saved' : /^(otm[0-7]|band\d{1,2})$/.test(key) ? key : 'saved';

export default function TradeExplorer({
  theme,
  openRequest = null,
}: {
  theme: Theme;
  openRequest?: ReportOpenRequest | null;
}) {
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
  const [gridBy, setGridBy] = useState<[string, string]>(['dte', 'ivLevel']);
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
  /** Which underlying|set the rows in `days` belong to, so a report click waits for the right ones. */
  const [daysKey, setDaysKey] = useState('');
  const pendingOpen = useRef<ReportOpenRequest | null>(null);
  const [openNotice, setOpenNotice] = useState<string | null>(null);
  const loadedUnderlying = useRef(settings.underlying);
  const underlying = settings.underlying;
  const [similar, setSimilar] = useState<SimilarPlan | null>(null);
  const sortBeforeSimilar = useRef<SortState | null>(null);

  useEffect(() => {
    setSelected(null);
    setSimilar(null);
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
          setDaysKey(`${underlying}|${tradeSet}`);
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
    on.delete(SIMILAR_KEY);
    // While a similar-days search runs, the distance and the compared columns are always in view.
    if (similar) for (const k of similar.keys) on.add(k);
    const list = COLUMNS.filter((c) => on.has(c.key));
    if (similar) list.splice(1, 0, COLUMN_BY_KEY.get(SIMILAR_KEY) as Column);
    return list;
  }, [columnKeys, similar]);

  const scored = useMemo(() => (days ? withSimilarity(days, similar) : []), [days, similar]);
  const filtered = useMemo(() => {
    const kept = applyFilters(scored, filters);
    return similar ? nearest(kept, similar.keep) : kept;
  }, [scored, filters, similar]);
  const items = useMemo(() => buildItems(filtered, sort, plan, open), [filtered, sort, plan, open]);
  const summary = useMemo(() => lossSummary(filtered), [filtered]);
  const baseline = useMemo(() => lossSummary(days ?? []), [days]);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setView((v) => ({ ...v, top: 0 }));
  }, [filters, plan, compact, underlying, similar]);
  const dayItems = useMemo(
    () => items.flatMap((it) => (it.kind === 'day' ? [it.row] : [])),
    [items],
  );
  const selectedRow = useMemo(
    () => scored.find((d) => d.raw.date === selected) ?? null,
    [scored, selected],
  );
  const similarRow = useMemo(
    () => (similar ? (scored.find((d) => d.raw.date === similar.date) ?? null) : null),
    [scored, similar],
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
  /** Rank every day by how close it is to `date` on the compared columns, closest first. */
  const startSimilar = (date: string) => {
    if (!similar) sortBeforeSimilar.current = sort;
    setSimilar({
      date,
      keys: similar?.keys ?? settings.similarKeys ?? DEFAULT_SIMILAR_KEYS,
      keep: similar?.keep ?? settings.similarKeep ?? 25,
    });
    update({ sort: { key: SIMILAR_KEY, dir: 1 } });
  };
  const changeSimilar = (patch: Partial<SimilarPlan>) => {
    if (!similar) return;
    const next = { ...similar, ...patch };
    setSimilar(next);
    update({ similarKeys: next.keys, similarKeep: next.keep });
  };
  const stopSimilar = () => {
    setSimilar(null);
    setSettings((s) => {
      const next = { ...s.filters };
      delete next[SIMILAR_KEY];
      return {
        ...s,
        filters: next,
        sort:
          s.sort.key === SIMILAR_KEY
            ? (sortBeforeSimilar.current ?? DEFAULT_SETTINGS.sort)
            : s.sort,
      };
    });
  };
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
  // A day clicked in the report: switch to its index and strike choice, then open it once those
  // rows have loaded (a price-band set is recalculated on the server first).
  useEffect(() => {
    if (!openRequest) return;
    pendingOpen.current = openRequest;
    setOpenNotice(null);
    setSimilar(null);
    if (openRequest.underlying !== underlying) {
      setSelected(null);
      update({ underlying: openRequest.underlying });
    }
    const set = reportSetKey(openRequest.key);
    if (set !== tradeSet) chooseTradeSet(set);
    // Only a new click should run this; the rest is read as it was at that click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.seq]);
  useEffect(() => {
    const want = pendingOpen.current;
    if (!want || !days || loadingSet) return;
    if (daysKey !== `${want.underlying}|${reportSetKey(want.key)}`) return;
    pendingOpen.current = null;
    if (days.some((d) => d.raw.date === want.date)) {
      setSelected(want.date);
      setTimeout(() => reveal(want.date), 0);
    } else {
      setSelected(null);
      setOpenNotice(`${want.date} has no trade in ${setLabel}, so it can't be opened here.`);
    }
  }, [days, daysKey, loadingSet, setLabel, reveal, openRequest?.seq]);

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
  const riskColumns = grouped ? RISK_COLUMNS : [];
  const tableWidth =
    columns.reduce((a, c, i) => a + (i === 0 ? firstWidth : c.width), 0) +
    (grouped ? RISK_WIDTH : 0);
  const colWidth = (px: number) => (splitView ? `${(px / tableWidth) * 100}%` : px);
  const groupable = PICKABLE_COLUMNS.filter(
    (c) => c.type === 'cat' || c.type === 'num' || c.type === 'time',
  );
  const sections = [...new Set(PICKABLE_COLUMNS.map((c) => c.section))];
  const estimatedDays = filtered.filter((r) => r.raw.estimated).length;
  const missingDays = filtered.filter((r) =>
    columns.some((c) => c.key !== SIMILAR_KEY && r.values[c.key] == null),
  ).length;
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
          {columns.flatMap((c, i) =>
            i === 0
              ? [
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
                    <span
                      className="font-normal"
                      style={{
                        color:
                          it.rows.length < SMALL_SAMPLE ? 'var(--yellow)' : 'var(--text-muted)',
                      }}
                      title={
                        it.rows.length < SMALL_SAMPLE
                          ? `Small sample: fewer than ${SMALL_SAMPLE} days, so one day moves these figures a lot`
                          : undefined
                      }
                    >
                      ({it.rows.length}
                      {it.rows.length < SMALL_SAMPLE ? ' · few' : ''})
                    </span>
                  </td>,
                  ...riskColumns.map((r) => (
                    <td
                      key={`risk-${r.key}`}
                      title={r.title}
                      style={{ color: r.color?.(summaryOf(it.rows)) }}
                      className="te-risk-cell truncate border-b border-[var(--border)] px-1.5 text-right font-mono"
                    >
                      {r.cell(summaryOf(it.rows))}
                    </td>
                  )),
                ]
              : [
                  <td
                    key={c.key}
                    className="truncate border-b border-[var(--border)] px-1.5 text-right font-mono"
                  >
                    {groupCell(c, it.rows, plan.how)}
                  </td>,
                ],
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
        {columns.flatMap((c, i) => {
          const v = it.row.values[c.key];
          return i === 0
            ? [
                <td
                  key={c.key}
                  style={{ ...pinned, paddingLeft: 6 + it.depth * 14, background: bg }}
                  className="truncate border-b border-[var(--border)] pr-1 font-semibold"
                >
                  {date}
                  {similar?.date === date && (
                    <span title="The day the others are compared with" className="te-ref-tag">
                      ★
                    </span>
                  )}
                  {it.row.raw.estimated && (
                    <span
                      title="Includes estimated option prices"
                      className="ml-1 text-[var(--yellow)]"
                    >
                      ≈
                    </span>
                  )}
                </td>,
                ...riskColumns.map((r) => (
                  <td
                    key={`risk-${r.key}`}
                    title={r.day ? "This day's own figure" : undefined}
                    style={{ color: r.dayColor?.(it.row.values) }}
                    className="te-risk-cell truncate border-b border-[var(--border)] px-1.5 text-right font-mono"
                  >
                    {r.day?.(it.row.values) ?? ''}
                  </td>
                )),
              ]
            : [
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
                </td>,
              ];
        })}
      </tr>
    );
  };

  return (
    <div
      className={`trade-explorer flex h-full min-h-0 flex-col text-[13px] text-[var(--text-primary)] ${detailFullscreen ? 'te-detail-fullscreen' : ''}`}
      data-palette={palette}
    >
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
          Trade set{' '}
          <select
            aria-label="Trade set"
            className={select}
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
        <div className="te-theme">
          {['midnight', 'paper'].map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={palette === p}
              title={`Appearance: ${p === 'midnight' ? 'Midnight' : 'Paper'}`}
              onClick={() => {
                setPalette(p);
                localStorage.setItem('explorer-palette', p);
              }}
            >
              {p === 'midnight' ? '◐' : '☀'}
            </button>
          ))}
        </div>
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
                onClick={() => setColumns(PICKABLE_COLUMNS.map((c) => c.key))}
              >
                All columns
              </button>
            </div>
            {sections.map((s) => (
              <div key={s} className="mb-1">
                <div className="font-semibold text-[var(--text-muted)]">{s}</div>
                {PICKABLE_COLUMNS.filter((c) => c.section === s && c.key !== 'date').map((c) => (
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

      <div className="te-grouping flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--bg-card)] p-3">
        <span>Group by</span>
        <div className="te-group-shortcuts">
          <button
            type="button"
            aria-pressed={!grouped}
            onClick={() => setPlan({ first: null, second: null })}
          >
            None
          </button>
        </div>
        {(
          [
            [
              'entry',
              'Known at entry',
              'Known when the trade is placed: these can guide a decision',
            ],
            [
              'after',
              'What happened after',
              'How the day went: these explain a loss but cannot predict it',
            ],
          ] as const
        ).map(([when, label, title]) => (
          <div key={when} className="te-group-set" data-when={when} title={title}>
            <span>{label}</span>
            <div className="te-group-shortcuts">
              {REPORT_GROUPS.filter((g) => g.when === when).map((g) => (
                <button
                  key={g.key}
                  type="button"
                  aria-pressed={plan.first === g.key}
                  onClick={() => setPlan({ first: g.key })}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>
        ))}
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
      {similar && (
        <div className="te-similar">
          <span>
            Days most like <b>{similar.date}</b> on
          </span>
          {similar.keys.map((k) => {
            const c = COLUMN_BY_KEY.get(k);
            if (!c) return null;
            const v = similarRow?.values[k] ?? null;
            const measured = c.type === 'num' || c.type === 'time';
            return (
              <button
                key={k}
                type="button"
                className="te-similar-chip"
                title={`${c.title}. ${measured ? 'Closer values rank higher' : 'Must be the same'}. Click to stop comparing on it`}
                onClick={() => changeSimilar({ keys: similar.keys.filter((x) => x !== k) })}
              >
                {measured ? '' : 'same '}
                {c.label} <b>{formatCell(c, v)}</b> ×
              </button>
            );
          })}
          <select
            aria-label="Compare on another column"
            className={select}
            value=""
            onChange={(e) =>
              e.target.value && changeSimilar({ keys: [...similar.keys, e.target.value] })
            }
          >
            <option value="">+ Add column…</option>
            {sections.map((s) => (
              <optgroup key={s} label={s}>
                {PICKABLE_COLUMNS.filter(
                  (c) =>
                    c.section === s &&
                    c.type !== 'date' &&
                    c.type !== 'text' &&
                    !similar.keys.includes(c.key),
                ).map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.type === 'cat' ? `Same ${c.title}` : c.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label>
            Show closest
            <select
              className={select}
              value={similar.keep}
              onChange={(e) => changeSimilar({ keep: Number(e.target.value) })}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value={0}>All</option>
            </select>
          </label>
          {selected && selected !== similar.date && (
            <button
              type="button"
              className="te-similar-action"
              onClick={() => startSimilar(selected)}
            >
              Compare with {selected} instead
            </button>
          )}
          <button type="button" className="te-similar-action" onClick={stopSimilar}>
            Stop ×
          </button>
          {!similar.keys.length ? (
            <span className="te-similar-note">Add a column to compare on.</span>
          ) : similarRow &&
            similar.keys.some((k) => {
              const c = COLUMN_BY_KEY.get(k);
              return (
                (c?.type === 'num' || c?.type === 'time') &&
                typeof similarRow.values[k] !== 'number'
              );
            }) ? (
            <span className="te-similar-note">
              {similar.date} has no reading on one of these columns, so nothing can be ranked.
              Remove that column.
            </span>
          ) : (
            <span className="te-similar-note">
              Distance 0 is identical; 1 is about one typical spread away on each column. The
              figures below describe these days only.
            </span>
          )}
        </div>
      )}
      {activeFilters > 0 && (
        <div className="flex flex-wrap gap-2 px-1 pt-1.5">
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
      )}
      <div className="te-metrics">
        {(
          [
            ['Days', String(summary.days), String(days.length)],
            ['Median max loss', money(summary.median), money(baseline.median)],
            ['Average max loss', money(summary.mean), money(baseline.mean)],
            ['1 in 10 past', money(summary.oneInTen), money(baseline.oneInTen)],
            ['Worst loss', money(summary.worst), money(baseline.worst), 'var(--red)'],
            ['Closed red', share(summary.closedRed), share(baseline.closedRed)],
            [
              'Median 15:29',
              signedMoney(summary.medianPnl),
              signedMoney(baseline.medianPnl),
              signColor(summary.medianPnl),
            ],
            [
              'Total 15:29',
              signedMoney(summary.totalPnl),
              signedMoney(baseline.totalPnl),
              signColor(summary.totalPnl),
            ],
          ] as Array<[string, string, string, string?]>
        ).map(([label, value, whole, color]) => (
          <div key={label} className="te-metric" title={`All ${days.length} days: ${whole}`}>
            <div className="text-xs text-[var(--text-muted)]">{label}</div>
            <div className="te-metric-value" style={{ color }}>
              {value}
            </div>
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
          <TradeExplorerCharts
            rows={filtered}
            bands={plan.bands}
            onFilter={(picks) => {
              // Show the days behind the bar, row or cell that was clicked.
              for (const [key, f] of picks) setFilter(key, f);
              setShowCharts(false);
            }}
            compareBy={compareBy}
            onCompare={setCompareBy}
            gridBy={gridBy}
            onGrid={setGridBy}
          />
        </div>
      )}
      <div className="te-status">
        <span>
          <b>{setLabel}</b> · {loadingSet ? 'loading the selected set… · ' : ''}
          {summary.days.toLocaleString('en-IN')} of {days.length.toLocaleString('en-IN')} days ·
          data through {days[days.length - 1]?.raw.date} · ₹ for 1 lot of {days[0]?.raw.trade.qty}
          {estimatedDays > 0 && ` · ${estimatedDays} estimated-price days`}
          {missingDays > 0 && ` · ${missingDays} days missing a visible reading`}
          {unavailableDays > 0 && ` · ${unavailableDays} days unavailable for this set`}
          {openNotice && <span className="text-[var(--red)]"> · {openNotice}</span>}
        </span>
        {activeFilters > 0 && (
          <button type="button" onClick={() => update({ filters: {} })}>
            Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
          </button>
        )}
        {sort.key && !similar && (
          <button type="button" onClick={() => update({ sort: { key: '', dir: 1 } })}>
            Clear sorting
          </button>
        )}
        <details>
          <summary>About this data</summary>
          <p>
            Both legs sold, entry one minute after the signal, exit 15:29. All amounts use today's
            lot size in every year. Signal, IV and Greeks describe information at the signal. Path,
            losing leg and loss figures describe later outcomes. Price bands apply to each leg and
            vary by days to expiry. Worst set uses hindsight across pairs with stored prices. Click
            a column heading to sort and again to reverse; click a day for its chart and chain.
          </p>
        </details>
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
              minWidth: splitView
                ? Math.max(760, (columns.length + riskColumns.length) * 60)
                : undefined,
            }}
          >
            <colgroup>
              {columns.flatMap((c, i) =>
                i === 0
                  ? [
                      <col key={c.key} style={{ width: colWidth(firstWidth) }} />,
                      ...riskColumns.map((r) => (
                        <col key={`risk-${r.key}`} style={{ width: colWidth(r.width) }} />
                      )),
                    ]
                  : [<col key={c.key} style={{ width: colWidth(c.width) }} />],
              )}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--bg-card)]">
              <tr>
                {columns.flatMap((c, i) => [
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
                  </th>,
                  ...(i === 0
                    ? riskColumns.map((r) => (
                        <th
                          key={`risk-${r.key}`}
                          title={`${r.title} (shown on group rows)`}
                          className="te-risk-head px-1.5 py-1 text-right font-semibold"
                        >
                          <span className="block truncate">{r.label}</span>
                        </th>
                      ))
                    : []),
                ])}
              </tr>
              <tr>
                {columns.flatMap((c, i) => [
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
                  </th>,
                  ...(i === 0
                    ? riskColumns.map((r) => (
                        <th
                          key={`risk-${r.key}`}
                          className="te-risk-head border-b border-[var(--border)]"
                        />
                      ))
                    : []),
                ])}
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
              <span className="flex-1" />
              <button
                type="button"
                className="te-similar-action"
                disabled={similar?.date === selectedRow.raw.date}
                title="Rank every day by how close it is to this one on the columns you choose"
                onClick={(e) => {
                  e.preventDefault();
                  startSimilar(selectedRow.raw.date);
                }}
              >
                {similar?.date === selectedRow.raw.date
                  ? 'Showing similar days'
                  : 'Find similar days'}
              </button>
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
