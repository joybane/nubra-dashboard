import { chartTheme } from './lib/chartTheme';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type IChartApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Instrument, Theme, ViewType } from './types';
import { useWorkspaceState } from './workspace/useWorkspaceState';
import { isChartLive, removeChart } from './lib/chartLifecycle';
import { syncChartPanes } from './lib/syncChartPanes';
import { bindPinTrigger, usePinnedTimes } from './lib/chartPins';
import { setNubraBtHandoff } from './lib/nubraBtHandoff';
import PinnedCrosshairLayer from './components/PinnedCrosshairLayer';
import PinCompareStrip, { type CompareRow } from './components/PinCompareStrip';
import { PnlTooltipBody, PriceTooltipBody } from './components/ChartTooltips';

// ── Server shapes — mirrors of server/analysis/*.ts (the two tsconfigs are disjoint) ─────────

type DaySource = 'nubra' | 'local';
type RankBy = 'total' | 'legGap';

interface FinderParams {
  entryTime: string;
  exitTime: string;
  /** Largest allowed gap, in index points, between the two minutes' NIFTY closes. */
  closeTolerance: number;
  minGapMinutes: number;
  maxCasesPerDay: number;
  spacingMinutes: number;
  minAbsPnl: number;
  qty: number;
  side: 'SELL' | 'BUY';
  strikeOffset: number;
  rankBy: RankBy;
  /** How far apart the legs must move, as a % of the bigger leg's change. */
  legMismatchPct: number;
}

interface DayLegs {
  ceStrike: number;
  peStrike: number;
  entryTime: string;
  entrySpot: number;
  ceEntry: number;
  peEntry: number;
}

interface AnalysisCase {
  t1: string;
  t2: string;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  ceDelta: number;
  peDelta: number;
  totalDelta: number;
}

interface ScanDay {
  date: string;
  source: DaySource;
  expiry: string;
  legs: DayLegs;
  cases: AnalysisCase[];
}

interface ScanResponse {
  ok: boolean;
  error?: string;
  params: FinderParams;
  days: ScanDay[];
  summary: {
    daysScanned: number;
    daysWithCases: number;
    cases: number;
    nubraDays: number;
    localDays: number;
    skipped: Record<string, number>;
    ms: number;
  };
}

interface Coverage {
  days: number;
  empty: number;
  from: string | null;
  to: string | null;
}

interface SyncProgress {
  done: number;
  total: number;
  built: number;
  empty: number;
  failed: number;
}

interface Criterion {
  label: string;
  value: number;
  limit: number;
  ok: boolean;
}

interface ValidationSummary {
  spotMeanAbsMedian: number;
  spotMaxAbsP95: number;
  legMeanAbsMedian: number;
  legMaxAbsP95: number;
  legWithin50PaisePct: number;
  replayCases: number;
  replayAbsDiffMedian: number;
  replayAbsDiffP90: number;
  replayRelativeError: number;
  caseOverlapPct: number;
}

interface StatusResponse {
  ok: boolean;
  error?: string;
  coverage: { nubra: Coverage; local: Coverage; localOnly: Coverage };
  sync: {
    running: boolean;
    phase: string;
    finishedAt: number | null;
    local: SyncProgress;
    nubra: SyncProgress & { start: string | null; skipped: string | null };
    validation: { running: boolean; done: number; total: number; ok: boolean | null };
    errors: string[];
  };
  brokerSession: boolean;
  validation: null | {
    generatedAt: string;
    days: number;
    from: string | null;
    to: string | null;
    summary: ValidationSummary;
    verdict: { ok: boolean; criteria: Criterion[] };
  };
}

interface DayValidation {
  date: string;
  spot: { n: number; meanAbs: number; maxAbs: number };
  ceStrike: number | null;
  peStrike: number | null;
  ce: { n: number; meanAbs: number; maxAbs: number };
  pe: { n: number; meanAbs: number; maxAbs: number };
  nubraCases: number;
  localCases: number;
  matchedCases: number;
  replayed: number;
  replayMeanAbsDiff: number;
  replayMaxAbsDiff: number;
}

type Grid = (number | null)[];

interface DayResponse {
  ok: boolean;
  error?: string;
  date: string;
  source: DaySource;
  expiry: string;
  legs: DayLegs;
  minutes: string[];
  spot: Grid;
  spotOhlc: { o: Grid; h: Grid; l: Grid } | null;
  ce: Grid;
  pe: Grid;
}

// ── Constants & helpers ───────────────────────────────────────────────────────

const UNDERLYING = 'NIFTY';
const LOT = 65;

const DEFAULT_PARAMS: FinderParams = {
  entryTime: '09:15',
  exitTime: '15:29',
  closeTolerance: 1,
  minGapMinutes: 30,
  maxCasesPerDay: 10,
  spacingMinutes: 30,
  minAbsPnl: 0,
  qty: 65,
  side: 'SELL',
  strikeOffset: 2,
  rankBy: 'legGap',
  legMismatchPct: 50,
};

const NIFTY_INSTRUMENT: Instrument = {
  stock_name: 'NIFTY 50',
  nubra_name: 'NIFTY',
  exchange: 'NSE',
  derivative_type: 'INDEX',
  lot_size: LOT,
};

const CE_COLOR = '#22c55e';
const PE_COLOR = '#ef4444';
const SESSION_OPEN_MIN = 9 * 60 + 15;

const SETTINGS_KEY = 'nubra-analysis-settings';
/** v2: ranking defaults to the CE/PE gap. Older saves carry the old `total` default, so it is dropped. */
const SETTINGS_VERSION = 2;

interface Settings {
  params: FinderParams;
  from: string;
  to: string;
  /** null = follow the data check's verdict. */
  localOnly: boolean | null;
  sort: 'date' | 'biggest';
  version?: number;
}

function loadSettings(): Settings {
  const fallback: Settings = {
    params: DEFAULT_PARAMS,
    from: '',
    to: '',
    localOnly: null,
    sort: 'date',
    version: SETTINGS_VERSION,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Settings>;
    const savedParams: Partial<FinderParams> = { ...(saved.params ?? {}) };
    if ((saved.version ?? 1) < SETTINGS_VERSION) delete savedParams.rankBy;
    return {
      ...fallback,
      ...saved,
      version: SETTINGS_VERSION,
      params: { ...DEFAULT_PARAMS, ...savedParams },
    };
  } catch {
    return fallback;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

function inr(n: number | null | undefined, signed = true): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '-' : '') : n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pnlClass(n: number | null | undefined): string {
  if (n == null || n === 0) return 'text-[var(--text-muted)]';
  return n > 0 ? 'text-[#22c55e]' : 'text-[#ef4444]';
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function minuteOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m - SESSION_OPEN_MIN;
}

/** Chart time for 09:15 IST on `date`: IST wall-clock expressed as UTC, the app-wide convention. */
function sessionStart(date: string): number {
  return Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 9, 15) / 1000;
}

function caseScore(c: AnalysisCase, rankBy: RankBy): number {
  return rankBy === 'legGap' ? Math.abs(c.ceDelta - c.peDelta) : Math.abs(c.totalDelta);
}

function progressText(p: { done: number; total: number }): string {
  return p.total ? `${p.done}/${p.total}` : '—';
}

const inputCls =
  'h-7 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';
const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';

// ── View ──────────────────────────────────────────────────────────────────────

interface Props {
  theme: Theme;
  onChangeView?: (view: ViewType) => void;
}

export default function Analysis({ theme, onChangeView }: Props) {
  const { loadInstrumentInActivePane } = useWorkspaceState();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const { params } = settings;

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const updateParam = useCallback(
    <K extends keyof FinderParams>(key: K, value: FinderParams[K]) => {
      setSettings((prev) => {
        const next = { ...prev, params: { ...prev.params, [key]: value } };
        saveSettings(next);
        return next;
      });
    },
    [],
  );

  // ── Status & sync ──
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const res = await fetch(`/api/analysis/status?underlying=${UNDERLYING}`);
      if (res.status === 404) {
        setStatusError(
          'This server has no Analysis routes yet. Restart the server so it loads them, then reopen this tab.',
        );
        return null;
      }
      const data = (await res.json()) as StatusResponse;
      if (!data.ok) {
        setStatusError(data.error || 'Could not read analysis status.');
        return null;
      }
      setStatusError(null);
      setStatus(data);
      return data;
    } catch (e) {
      setStatusError((e as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const syncRunning = !!status?.sync.running;
  useEffect(() => {
    if (!syncRunning) return;
    const id = window.setInterval(() => void refreshStatus(), 3000);
    return () => window.clearInterval(id);
  }, [syncRunning, refreshStatus]);

  const startSync = useCallback(async () => {
    try {
      await fetch('/api/analysis/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying: UNDERLYING }),
      });
    } finally {
      void refreshStatus();
    }
  }, [refreshStatus]);

  const verdictOk = status?.validation?.verdict.ok ?? false;
  const includeLocalOnly = settings.localOnly ?? verdictOk;

  // ── Scan ──
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanSeq = useRef(0);

  const runScan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setScanLoading(true);
    setScanError(null);
    try {
      const res = await fetch('/api/analysis/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying: UNDERLYING,
          params,
          from: settings.from || undefined,
          to: settings.to || undefined,
          includeLocalOnly,
        }),
      });
      const data = (await res.json()) as ScanResponse;
      if (seq !== scanSeq.current) return;
      if (!data.ok) {
        setScanError(data.error || 'Scan failed.');
        return;
      }
      setScan(data);
    } catch (e) {
      if (seq === scanSeq.current) setScanError((e as Error).message);
    } finally {
      if (seq === scanSeq.current) setScanLoading(false);
    }
  }, [params, settings.from, settings.to, includeLocalOnly]);

  // First scan once the status says there is something to scan; again whenever a sync finishes.
  const autoScanned = useRef(false);
  const prevRunning = useRef(false);
  useEffect(() => {
    if (!status) return;
    const hasData = status.coverage.nubra.days + status.coverage.local.days > 0;
    if (!autoScanned.current && hasData) {
      autoScanned.current = true;
      void runScan();
    } else if (prevRunning.current && !status.sync.running && hasData) {
      void runScan();
    }
    prevRunning.current = status.sync.running;
  }, [status, runScan]);

  // ── Results list ──
  const [onlyWithCases, setOnlyWithCases] = useState(true);
  const [visibleDays, setVisibleDays] = useState(120);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<{ date: string; index: number } | null>(null);

  const rankBy = scan?.params.rankBy ?? params.rankBy;
  const sortedDays = useMemo(() => {
    const days = (scan?.days ?? []).filter((d) => !onlyWithCases || d.cases.length > 0);
    const best = (d: ScanDay) => d.cases.reduce((m, c) => Math.max(m, caseScore(c, rankBy)), 0);
    return settings.sort === 'biggest'
      ? [...days].sort((a, b) => best(b) - best(a) || (a.date < b.date ? 1 : -1))
      : [...days].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [scan, onlyWithCases, settings.sort, rankBy]);

  // A new scan resets the list and selects its first case.
  useEffect(() => {
    setVisibleDays(120);
    const first = sortedDays.find((d) => d.cases.length);
    if (first) {
      setSelected({ date: first.date, index: 0 });
      setExpanded(new Set([first.date]));
    } else {
      setSelected(null);
    }
    // Only on a new scan result, not on every re-sort.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan]);

  const selectedDay = useMemo(
    () => (selected ? (scan?.days.find((d) => d.date === selected.date) ?? null) : null),
    [scan, selected],
  );
  const selectedCase = selectedDay && selected ? (selectedDay.cases[selected.index] ?? null) : null;

  const nubraFrom = status?.coverage.nubra.from ?? null;
  const nubraAvailable = (day: ScanDay) =>
    day.source === 'nubra' || (!!nubraFrom && day.date >= nubraFrom);

  const openInNubraBt = useCallback(
    (day: ScanDay) => {
      const p = scan?.params ?? params;
      const lots = Math.max(1, Math.round(p.qty / LOT));
      setNubraBtHandoff({
        underlying: UNDERLYING,
        date: day.date,
        expiry: day.expiry,
        entryTime: day.legs.entryTime,
        exitTime: p.exitTime,
        legs: [
          { strike: day.legs.peStrike, optionType: 'PE', side: p.side, lots },
          { strike: day.legs.ceStrike, optionType: 'CE', side: p.side, lots },
        ],
      });
      loadInstrumentInActivePane(NIFTY_INSTRUMENT);
      onChangeView?.('nubrabacktest');
    },
    [scan, params, loadInstrumentInActivePane, onChangeView],
  );

  const [reportOpen, setReportOpen] = useState(false);

  // ── Render ──
  const cov = status?.coverage;
  const sync = status?.sync;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Header: what this is, what data it has, and whether the local data can be trusted */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold">Analysis</span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {UNDERLYING} · {params.side === 'SELL' ? 'short' : 'long'} strangle OTM±
            {params.strikeOffset} · profit mismatch at the same NIFTY close
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {cov && (
            <>
              <span
                className="rounded bg-[var(--bg-secondary)] px-2 py-0.5"
                title="Days served from Nubra's own 1-minute history"
              >
                Nubra {cov.nubra.days.toLocaleString('en-IN')} days
                {cov.nubra.from && ` · ${cov.nubra.from} → ${cov.nubra.to}`}
              </span>
              <span
                className="rounded bg-[var(--bg-secondary)] px-2 py-0.5"
                title="Days only the local ATM Wise parquet data covers"
              >
                Local-only {cov.localOnly.days.toLocaleString('en-IN')} days
                {cov.localOnly.from && ` · ${cov.localOnly.from} → ${cov.localOnly.to}`}
              </span>
            </>
          )}
          <button
            type="button"
            onClick={() => setReportOpen((o) => !o)}
            className={`rounded px-2 py-0.5 font-medium ${
              !status?.validation
                ? 'bg-[var(--bg-secondary)] text-[var(--text-muted)]'
                : verdictOk
                  ? 'bg-[#22c55e]/15 text-[#22c55e]'
                  : 'bg-[#ef4444]/15 text-[#ef4444]'
            }`}
            title="Local data compared with Nubra on every date both have"
          >
            {!status?.validation
              ? 'Data check: pending'
              : verdictOk
                ? `✓ Local data matches Nubra (${status.validation.days} days)`
                : `✗ Local data check failed (${status.validation.days} days)`}
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          {sync?.running ? (
            <span className="text-[var(--text-muted)]">
              <span className="spinner mr-1 inline-block h-3 w-3 align-middle" />
              {sync.phase === 'validation'
                ? `Checking local data ${progressText(sync.validation)}`
                : `Updating · local ${progressText(sync.local)} · Nubra ${progressText(sync.nubra)}`}
            </span>
          ) : (
            status &&
            !status.brokerSession && (
              <span className="text-[var(--text-muted)]">Log in to download Nubra days</span>
            )
          )}
          <button
            type="button"
            disabled={!status || sync?.running}
            onClick={() => void startSync()}
            className="h-7 rounded border border-[var(--border)] px-3 text-[12px] hover:border-[var(--accent)] disabled:opacity-40"
          >
            Update data
          </button>
        </div>
      </div>

      {statusError && (
        <div className="border-b border-[var(--border)] bg-[#ef4444]/10 px-3 py-1.5 text-[12px] text-[#ef4444]">
          {statusError}
        </div>
      )}

      {/* Settings */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-[var(--border)] px-3 py-2">
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Entry</span>
          <input
            type="time"
            className={`${inputCls} w-[92px]`}
            value={params.entryTime}
            min="09:15"
            max="15:29"
            onChange={(e) => e.target.value && updateParam('entryTime', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Exit</span>
          <input
            type="time"
            className={`${inputCls} w-[92px]`}
            value={params.exitTime}
            min="09:16"
            max="15:29"
            onChange={(e) => e.target.value && updateParam('exitTime', e.target.value)}
          />
        </label>
        <NumberField
          label="Close ± pts"
          value={params.closeTolerance}
          step={0.5}
          min={0}
          onChange={(v) => updateParam('closeTolerance', Math.max(0, v))}
        />
        <NumberField
          label="Min gap (min)"
          value={params.minGapMinutes}
          step={5}
          min={1}
          onChange={(v) => updateParam('minGapMinutes', v)}
        />
        <NumberField
          label="Spacing (min)"
          value={params.spacingMinutes}
          step={5}
          min={0}
          title="Kept cases must start, and end, at least this far apart"
          onChange={(v) => updateParam('spacingMinutes', v)}
        />
        <NumberField
          label="Max / day"
          value={params.maxCasesPerDay}
          step={1}
          min={1}
          onChange={(v) => updateParam('maxCasesPerDay', v)}
        />
        <NumberField
          label="Min |Δ| ₹"
          value={params.minAbsPnl}
          step={100}
          min={0}
          onChange={(v) => updateParam('minAbsPnl', v)}
        />
        <NumberField
          label="Legs differ ≥ %"
          value={params.legMismatchPct}
          step={10}
          min={0}
          title="CE and PE P&L changes must be at least this far apart, as a % of the bigger leg's change. 50 = opposite directions, or one leg moved at least twice the other. 100 = opposite directions only. 0 = off."
          onChange={(v) => updateParam('legMismatchPct', Math.max(0, v))}
        />
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>Rank by</span>
          <select
            className={`${inputCls} w-[132px]`}
            value={params.rankBy}
            onChange={(e) => updateParam('rankBy', e.target.value as RankBy)}
          >
            <option value="total">Total P&L change</option>
            <option value="legGap">CE vs PE gap</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>From</span>
          <input
            type="date"
            className={`${inputCls} w-[130px]`}
            value={settings.from}
            onChange={(e) => updateSettings({ from: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>To</span>
          <input
            type="date"
            className={`${inputCls} w-[130px]`}
            value={settings.to}
            onChange={(e) => updateSettings({ to: e.target.value })}
          />
        </label>
        <label
          className="flex h-7 cursor-pointer items-center gap-1.5 text-[12px]"
          title={
            settings.localOnly === null
              ? 'Following the data check: included when local data matches Nubra'
              : 'Set by you — click Reset to follow the data check again'
          }
        >
          <input
            type="checkbox"
            checked={includeLocalOnly}
            onChange={(e) => updateSettings({ localOnly: e.target.checked })}
          />
          Local-only years
          {settings.localOnly !== null && (
            <button
              type="button"
              className="text-[10px] text-[var(--accent)]"
              onClick={(e) => {
                e.preventDefault();
                updateSettings({ localOnly: null });
              }}
            >
              reset
            </button>
          )}
        </label>
        <button
          type="button"
          className="ml-auto h-7 rounded bg-[var(--accent)] px-4 text-[12px] font-semibold text-white disabled:opacity-50"
          disabled={scanLoading}
          onClick={() => void runScan()}
        >
          {scanLoading ? 'Scanning…' : 'Scan'}
        </button>
        <button
          type="button"
          className="h-7 rounded border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => updateSettings({ params: DEFAULT_PARAMS })}
          title="Restore default settings"
        >
          Defaults
        </button>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Day list */}
        <div className="flex w-[430px] shrink-0 flex-col border-r border-[var(--border)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
            {scan ? (
              <span>
                <b className="text-[var(--text-primary)]">
                  {scan.summary.cases.toLocaleString('en-IN')}
                </b>{' '}
                cases on {scan.summary.daysWithCases.toLocaleString('en-IN')} of{' '}
                {scan.summary.daysScanned.toLocaleString('en-IN')} days · {scan.summary.nubraDays}{' '}
                Nubra · {scan.summary.localDays} local
              </span>
            ) : scanLoading ? (
              <span>Scanning…</span>
            ) : (
              <span>No scan yet</span>
            )}
            <select
              className="ml-auto h-6 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1 text-[11px]"
              value={settings.sort}
              onChange={(e) => updateSettings({ sort: e.target.value as Settings['sort'] })}
            >
              <option value="date">Newest first</option>
              <option value="biggest">Biggest mismatch</option>
            </select>
            <label className="flex items-center gap-1" title="Hide days with no case">
              <input
                type="checkbox"
                checked={onlyWithCases}
                onChange={(e) => setOnlyWithCases(e.target.checked)}
              />
              With cases
            </label>
          </div>
          {scanError && <div className="px-3 py-2 text-[12px] text-[#ef4444]">{scanError}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {sortedDays.slice(0, visibleDays).map((day) => {
              const open = expanded.has(day.date);
              const best = day.cases.reduce((m, c) => Math.max(m, caseScore(c, rankBy)), 0);
              return (
                <div key={day.date} className="border-b border-[var(--border)]">
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--bg-secondary)]"
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(day.date)) next.delete(day.date);
                        else next.add(day.date);
                        return next;
                      })
                    }
                  >
                    <span className="w-3 text-[var(--text-muted)]">{open ? '▾' : '▸'}</span>
                    <span className="w-[112px] font-medium">{fmtDate(day.date)}</span>
                    <span
                      className={`rounded px-1 text-[9px] font-bold ${
                        day.source === 'nubra'
                          ? 'bg-[var(--accent)]/20 text-[var(--accent)]'
                          : 'bg-[#f59e0b]/20 text-[#f59e0b]'
                      }`}
                      title={day.source === 'nubra' ? 'Nubra data' : 'Local ATM Wise data'}
                    >
                      {day.source === 'nubra' ? 'NUBRA' : 'LOCAL'}
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">
                      {day.legs.peStrike}PE / {day.legs.ceStrike}CE
                    </span>
                    <span className="ml-auto text-[11px] text-[var(--text-muted)]">
                      {day.cases.length} ·{' '}
                      <span className="text-[var(--text-primary)]">{inr(best, false)}</span>
                    </span>
                  </button>
                  {open && (
                    <div className="pb-1">
                      {day.cases.map((c, index) => {
                        const isSel = selected?.date === day.date && selected.index === index;
                        return (
                          <div
                            key={`${c.t1}-${c.t2}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelected({ date: day.date, index })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setSelected({ date: day.date, index });
                            }}
                            className={`mx-2 grid cursor-pointer grid-cols-[88px_1fr_1fr_1fr] items-center gap-1 rounded px-2 py-1 text-[11px] ${
                              isSel ? 'bg-[var(--accent)]/15' : 'hover:bg-[var(--bg-secondary)]'
                            }`}
                          >
                            <span className="font-mono">
                              {c.t1}→{c.t2}
                            </span>
                            <span className={pnlClass(c.peDelta)} title="PE leg P&L change">
                              PE {inr(c.peDelta)}
                            </span>
                            <span className={pnlClass(c.ceDelta)} title="CE leg P&L change">
                              CE {inr(c.ceDelta)}
                            </span>
                            <span
                              className={`text-right font-semibold ${pnlClass(c.totalDelta)}`}
                              title={`Spot ${num(c.spot1)} → ${num(c.spot2)}`}
                            >
                              {inr(c.totalDelta)}
                            </span>
                          </div>
                        );
                      })}
                      {day.cases.length === 0 && (
                        <div className="px-8 py-1 text-[11px] text-[var(--text-muted)]">
                          No pair met the settings on this day.
                        </div>
                      )}
                      <div className="flex justify-end px-3 pt-1">
                        <button
                          type="button"
                          disabled={!nubraAvailable(day)}
                          onClick={() => openInNubraBt(day)}
                          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] hover:border-[var(--accent)] disabled:opacity-40"
                          title={
                            nubraAvailable(day)
                              ? 'Open this day in Nubra BT with these legs'
                              : `Nubra has no history for this date${nubraFrom ? ` (it starts ${nubraFrom})` : ''}`
                          }
                        >
                          Open in Nubra BT ↗
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {sortedDays.length > visibleDays && (
              <button
                type="button"
                className="w-full py-2 text-[12px] text-[var(--accent)]"
                onClick={() => setVisibleDays((n) => n + 200)}
              >
                Show more ({(sortedDays.length - visibleDays).toLocaleString('en-IN')} more days)
              </button>
            )}
            {scan && sortedDays.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
                No cases. Try a wider spot tolerance or a smaller minimum gap.
              </div>
            )}
          </div>
        </div>

        {/* Case chart / data check */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {reportOpen ? (
            <ValidationPanel onClose={() => setReportOpen(false)} status={status} />
          ) : selectedDay && scan ? (
            <CaseChart
              theme={theme}
              day={selectedDay}
              selected={selectedCase}
              params={scan.params}
              nubraAvailable={nubraAvailable(selectedDay)}
              onOpenNubraBt={() => openInNubraBt(selectedDay)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
              {scanLoading ? <div className="spinner" /> : 'Select a case to chart it.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  step,
  min,
  title,
  onChange,
}: {
  label: string;
  value: number;
  step: number;
  min: number;
  title?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className={lblCls}>{label}</span>
      <input
        type="number"
        className={`${inputCls} w-[78px]`}
        value={value}
        step={step}
        min={min}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v >= min) onChange(v);
        }}
      />
    </label>
  );
}

// ── Data check panel ──────────────────────────────────────────────────────────

function ValidationPanel({
  status,
  onClose,
}: {
  status: StatusResponse | null;
  onClose: () => void;
}) {
  const [perDay, setPerDay] = useState<DayValidation[] | null>(null);
  const v = status?.validation;

  useEffect(() => {
    if (!v) return;
    let cancelled = false;
    fetch(`/api/analysis/validation?underlying=${UNDERLYING}`)
      .then((r) => r.json())
      .then((d: { ok: boolean; report?: { perDay: DayValidation[] } }) => {
        if (!cancelled && d.ok && d.report) setPerDay(d.report.perDay);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [v]);

  const worst = useMemo(
    () => [...(perDay ?? [])].sort((a, b) => b.replayMaxAbsDiff - a.replayMaxAbsDiff).slice(0, 25),
    [perDay],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 text-[12px]">
      <div className="mb-3 flex items-center">
        <span className="text-[14px] font-semibold">Local data vs Nubra</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-[var(--border)] px-2 py-0.5 text-[11px]"
        >
          Back to chart
        </button>
      </div>
      {!v ? (
        <div className="text-[var(--text-muted)]">
          No report yet. It is produced at the end of “Update data”, from every date both sources
          hold.
        </div>
      ) : (
        <>
          <p className="mb-3 text-[var(--text-muted)]">
            {v.days} dates held by both sources ({v.from} → {v.to}). Local-only years are included
            by default only when every criterion below passes.
          </p>
          <table className="mb-4 w-full max-w-[720px] border-collapse">
            <tbody>
              {v.verdict.criteria.map((c) => (
                <tr key={c.label} className="border-b border-[var(--border)]">
                  <td className="py-1.5 pr-3">{c.label}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{c.value}</td>
                  <td className="py-1.5 pr-3 text-right text-[var(--text-muted)]">
                    limit {c.limit}
                  </td>
                  <td
                    className={`py-1.5 font-semibold ${c.ok ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}
                  >
                    {c.ok ? 'pass' : 'fail'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mb-4 grid max-w-[720px] grid-cols-2 gap-x-6 gap-y-1">
            <Stat
              label="Spot: median per-day mean |diff|"
              value={`${v.summary.spotMeanAbsMedian} pts`}
            />
            <Stat
              label="Spot: 95th pct per-day max |diff|"
              value={`${v.summary.spotMaxAbsP95} pts`}
            />
            <Stat
              label="Legs: median per-day mean |diff|"
              value={`₹${v.summary.legMeanAbsMedian}`}
            />
            <Stat label="Legs: 95th pct per-day max |diff|" value={`₹${v.summary.legMaxAbsP95}`} />
            <Stat label="Leg minutes within ₹0.50" value={`${v.summary.legWithin50PaisePct}%`} />
            <Stat
              label="Cases replayed on local data"
              value={v.summary.replayCases.toLocaleString('en-IN')}
            />
            <Stat label="Replay |Δ₹ diff| median" value={`₹${v.summary.replayAbsDiffMedian}`} />
            <Stat label="Replay |Δ₹ diff| 90th pct" value={`₹${v.summary.replayAbsDiffP90}`} />
            <Stat
              label="Replay relative error"
              value={`${(v.summary.replayRelativeError * 100).toFixed(1)}%`}
            />
            <Stat
              label="Same cases found (±5 min) — informational"
              value={`${v.summary.caseOverlapPct}%`}
            />
          </div>
          <div className="mb-1 font-semibold">Largest disagreements</div>
          {perDay ? (
            <table className="w-full max-w-[860px] border-collapse text-[11px]">
              <thead className="text-[var(--text-muted)]">
                <tr className="border-b border-[var(--border)] text-left">
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2 text-right">Spot mean / max</th>
                  <th className="py-1 pr-2 text-right">CE mean / max</th>
                  <th className="py-1 pr-2 text-right">PE mean / max</th>
                  <th className="py-1 pr-2 text-right">Cases N / L / same</th>
                  <th className="py-1 text-right">Replay mean / max ₹</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((d) => (
                  <tr key={d.date} className="border-b border-[var(--border)]">
                    <td className="py-1 pr-2">{d.date}</td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {d.spot.meanAbs} / {d.spot.maxAbs}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {d.ce.meanAbs} / {d.ce.maxAbs}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {d.pe.meanAbs} / {d.pe.maxAbs}
                    </td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {d.nubraCases} / {d.localCases} / {d.matchedCases}
                    </td>
                    <td className="py-1 text-right font-mono">
                      {d.replayMeanAbsDiff} / {d.replayMaxAbsDiff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="spinner" />
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-[var(--border)] py-1">
      <span className="text-[var(--text-muted)]">{label}</span>
      <span className="font-mono">{value}</span>
    </div>
  );
}

// ── Case chart ────────────────────────────────────────────────────────────────

function chartOptions(theme: Theme) {
  return {
    autoSize: true,
    ...chartTheme(theme),
    leftPriceScale: { visible: true, borderVisible: false, minimumWidth: 70 },
    rightPriceScale: { visible: true, borderVisible: false, minimumWidth: 75 },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
  };
}

interface CaseChartProps {
  theme: Theme;
  day: ScanDay;
  selected: AnalysisCase | null;
  params: FinderParams;
  nubraAvailable: boolean;
  onOpenNubraBt: () => void;
}

function CaseChart({
  theme,
  day,
  selected,
  params,
  nubraAvailable,
  onOpenNubraBt,
}: CaseChartProps) {
  const isDark = theme !== 'light';
  const [data, setData] = useState<DayResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams({
      underlying: UNDERLYING,
      date: day.date,
      source: day.source,
      entryTime: params.entryTime,
      strikeOffset: String(params.strikeOffset),
    });
    fetch(`/api/analysis/day?${qs}`, { signal: ctrl.signal })
      .then((r) => r.json() as Promise<DayResponse>)
      .then((d) => {
        if (d.ok) setData(d);
        else {
          setData(null);
          setError(d.error || 'Could not load this day.');
        }
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [day.date, day.source, params.entryTime, params.strikeOffset]);

  /** Everything the panes draw, precomputed once per day. P&L exists only from entry to exit. */
  const built = useMemo(() => {
    if (!data) return null;
    const start = sessionStart(data.date);
    const k = (params.side === 'SELL' ? 1 : -1) * params.qty;
    const entryIdx = minuteOf(data.legs.entryTime);
    const exitIdx = minuteOf(params.exitTime);
    const candles: Array<{
      time: UTCTimestamp;
      open: number;
      high: number;
      low: number;
      close: number;
    }> = [];
    const spotLine: Array<{ time: UTCTimestamp; value: number }> = [];
    const ce: Array<{ time: UTCTimestamp; value: number }> = [];
    const pe: Array<{ time: UTCTimestamp; value: number }> = [];
    const cePnl: Array<{ time: UTCTimestamp; value: number }> = [];
    const pePnl: Array<{ time: UTCTimestamp; value: number }> = [];
    const total: Array<{ time: UTCTimestamp; value: number }> = [];
    const cePnlAt: Grid = [];
    const pePnlAt: Grid = [];
    const totalAt: Grid = [];
    for (let i = 0; i < data.minutes.length; i++) {
      const time = (start + i * 60) as UTCTimestamp;
      const s = data.spot[i];
      if (s != null) {
        if (data.spotOhlc) {
          candles.push({
            time,
            open: data.spotOhlc.o[i] ?? s,
            high: data.spotOhlc.h[i] ?? s,
            low: data.spotOhlc.l[i] ?? s,
            close: s,
          });
        } else {
          spotLine.push({ time, value: s });
        }
      }
      const c = data.ce[i];
      const p = data.pe[i];
      if (c != null) ce.push({ time, value: c });
      if (p != null) pe.push({ time, value: p });
      let cp: number | null = null;
      let pp: number | null = null;
      let tp: number | null = null;
      if (i >= entryIdx && i <= exitIdx) {
        if (c != null) {
          cp = Math.round((data.legs.ceEntry - c) * k * 100) / 100;
          cePnl.push({ time, value: cp });
        }
        if (p != null) {
          pp = Math.round((data.legs.peEntry - p) * k * 100) / 100;
          pePnl.push({ time, value: pp });
        }
        if (cp != null && pp != null) {
          tp = Math.round((cp + pp) * 100) / 100;
          total.push({ time, value: tp });
        }
      }
      cePnlAt.push(cp);
      pePnlAt.push(pp);
      totalAt.push(tp);
    }
    return { start, candles, spotLine, ce, pe, cePnl, pePnl, total, cePnlAt, pePnlAt, totalAt };
  }, [data, params.side, params.qty, params.exitTime]);

  const priceEl = useRef<HTMLDivElement>(null);
  const pnlEl = useRef<HTMLDivElement>(null);
  const [charts, setCharts] = useState<{ price: IChartApi; pnl: IChartApi } | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const hoverTimeRef = useRef<number | null>(null);

  const { pins, togglePinAt, removePin, clearPins } = usePinnedTimes(2);
  const togglePinRef = useRef(togglePinAt);
  togglePinRef.current = togglePinAt;

  useEffect(() => {
    const priceBox = priceEl.current;
    const pnlBox = pnlEl.current;
    if (!built || !priceBox || !pnlBox) return;
    const price = createChart(priceBox, chartOptions(theme));
    const pnl = createChart(pnlBox, chartOptions(theme));

    if (built.candles.length) {
      price
        .addSeries(CandlestickSeries, {
          upColor: '#22c55e',
          downColor: '#ef4444',
          borderVisible: false,
          wickUpColor: '#22c55e',
          wickDownColor: '#ef4444',
          priceScaleId: 'right',
        })
        .setData(built.candles);
    } else {
      price
        .addSeries(LineSeries, {
          color: isDark ? '#e5e7eb' : '#111827',
          lineWidth: 2,
          priceScaleId: 'right',
        })
        .setData(built.spotLine);
    }
    price
      .addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, priceScaleId: 'left' })
      .setData(built.pe);
    price
      .addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, priceScaleId: 'left' })
      .setData(built.ce);
    pnl
      .addSeries(LineSeries, { color: PE_COLOR, lineWidth: 1, priceScaleId: 'right' })
      .setData(built.pePnl);
    pnl
      .addSeries(LineSeries, { color: CE_COLOR, lineWidth: 1, priceScaleId: 'right' })
      .setData(built.cePnl);
    pnl
      .addSeries(LineSeries, {
        color: isDark ? '#f3f4f6' : '#111827',
        lineWidth: 2,
        priceScaleId: 'right',
      })
      .setData(built.total);
    price.timeScale().fitContent();
    pnl.timeScale().fitContent();

    const unsync = syncChartPanes([price, pnl]);
    const onMove = (param: MouseEventParams<Time>) => {
      const t = typeof param.time === 'number' ? param.time : null;
      hoverTimeRef.current = t;
      setHoverIdx(t == null ? null : Math.round((t - built.start) / 60));
    };
    price.subscribeCrosshairMove(onMove);
    pnl.subscribeCrosshairMove(onMove);
    const resolve = () => hoverTimeRef.current;
    const onPin = (t: number | null) => togglePinRef.current(t);
    const unbindPrice = bindPinTrigger(priceBox.parentElement, resolve, onPin);
    const unbindPnl = bindPinTrigger(pnlBox.parentElement, resolve, onPin);

    setCharts({ price, pnl });
    setEpoch((e) => e + 1);
    return () => {
      unbindPrice();
      unbindPnl();
      unsync();
      if (isChartLive(price)) price.unsubscribeCrosshairMove(onMove);
      if (isChartLive(pnl)) pnl.unsubscribeCrosshairMove(onMove);
      setCharts(null);
      removeChart(price);
      removeChart(pnl);
    };
  }, [built, theme]);

  // Pin the selected case's two minutes, so its cards and Δ strips are up without a click.
  useEffect(() => {
    clearPins();
    if (!built || !selected) return;
    togglePinAt(built.start + minuteOf(selected.t1) * 60);
    togglePinAt(built.start + minuteOf(selected.t2) * 60);
  }, [built, selected, clearPins, togglePinAt]);

  const valuesAt = useCallback(
    (i: number) => {
      if (!data || !built || i < 0 || i >= data.minutes.length) return null;
      const s = data.spot[i];
      return {
        hhmm: data.minutes[i],
        spot: s,
        ohlc:
          s == null
            ? null
            : {
                o: data.spotOhlc?.o[i] ?? s,
                h: data.spotOhlc?.h[i] ?? s,
                l: data.spotOhlc?.l[i] ?? s,
                c: s,
              },
        ce: data.ce[i],
        pe: data.pe[i],
        cePnl: built.cePnlAt[i],
        pePnl: built.pePnlAt[i],
        total: built.totalAt[i],
      };
    },
    [data, built],
  );

  const indexOfTime = useCallback(
    (time: number) => (built ? Math.round((time - built.start) / 60) : -1),
    [built],
  );

  const ceName = data ? `${UNDERLYING} ${data.legs.ceStrike} CE` : '';
  const peName = data ? `${UNDERLYING} ${data.legs.peStrike} PE` : '';

  const compare = useMemo(() => {
    if (pins.length !== 2) return null;
    const a = valuesAt(indexOfTime(pins[0].time));
    const b = valuesAt(indexOfTime(pins[1].time));
    if (!a || !b) return null;
    const diff = (x: number | null, y: number | null) => (x == null || y == null ? null : y - x);
    const rows = (pairs: Array<[string, number | null, CompareRow['kind']]>): CompareRow[] =>
      pairs
        .filter((p): p is [string, number, CompareRow['kind']] => p[1] != null)
        .map(([label, value, kind]) => ({ label, value, kind }));
    return {
      dt: pins[1].time - pins[0].time,
      colors: [pins[0].color, pins[1].color] as [string, string],
      price: rows([
        [UNDERLYING, diff(a.spot, b.spot), 'price'],
        [peName, diff(a.pe, b.pe), 'price'],
        [ceName, diff(a.ce, b.ce), 'price'],
      ]),
      pnl: rows([
        ['Total P&L', diff(a.total, b.total), 'money'],
        [peName, diff(a.pePnl, b.pePnl), 'money'],
        [ceName, diff(a.cePnl, b.cePnl), 'money'],
      ]),
    };
  }, [pins, valuesAt, indexOfTime, ceName, peName]);

  const hover = hoverIdx != null ? valuesAt(hoverIdx) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Case header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] px-3 py-1.5 text-[12px]">
        <span className="font-semibold">{fmtDate(day.date)}</span>
        <span className="text-[11px] text-[var(--text-muted)]">
          {day.source === 'nubra' ? 'Nubra data' : 'Local data'} · expiry {day.expiry} · entry{' '}
          {day.legs.entryTime} @ {num(day.legs.entrySpot)} ·{' '}
          <span style={{ color: PE_COLOR }}>
            {params.side} {day.legs.peStrike} PE @ {num(day.legs.peEntry)}
          </span>{' '}
          ·{' '}
          <span style={{ color: CE_COLOR }}>
            {params.side} {day.legs.ceStrike} CE @ {num(day.legs.ceEntry)}
          </span>{' '}
          · qty {params.qty}
        </span>
        {selected && (
          <span className="text-[11px]">
            <span className="font-mono">
              {selected.t1} → {selected.t2}
            </span>{' '}
            · spot {num(selected.spot1)} → {num(selected.spot2)} · PE{' '}
            <span className={pnlClass(selected.peDelta)}>{inr(selected.peDelta)}</span> · CE{' '}
            <span className={pnlClass(selected.ceDelta)}>{inr(selected.ceDelta)}</span> · Total{' '}
            <span className={`font-semibold ${pnlClass(selected.totalDelta)}`}>
              {inr(selected.totalDelta)}
            </span>
          </span>
        )}
        <button
          type="button"
          disabled={!nubraAvailable}
          onClick={onOpenNubraBt}
          className="ml-auto rounded bg-[var(--accent)] px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
          title={
            nubraAvailable
              ? 'Open this day in Nubra BT with these legs'
              : 'Nubra has no history for this date'
          }
        >
          Open in Nubra BT ↗
        </button>
      </div>
      <div className="flex h-6 items-center gap-3 border-b border-[var(--border)] px-3 text-[11px] text-[var(--text-muted)]">
        {hover ? (
          <>
            <span className="font-mono text-[var(--text-primary)]">{hover.hhmm}</span>
            <span>
              {UNDERLYING} {num(hover.spot)}
            </span>
            <span style={{ color: PE_COLOR }}>PE {num(hover.pe)}</span>
            <span style={{ color: CE_COLOR }}>CE {num(hover.ce)}</span>
            <span>
              P&L PE <span className={pnlClass(hover.pePnl)}>{inr(hover.pePnl)}</span>
            </span>
            <span>
              CE <span className={pnlClass(hover.cePnl)}>{inr(hover.cePnl)}</span>
            </span>
            <span>
              Total <span className={pnlClass(hover.total)}>{inr(hover.total)}</span>
            </span>
          </>
        ) : (
          <span>
            Hover to read values · middle-click (or Alt+click) to move a pin · Esc clears pins
          </span>
        )}
      </div>

      {error && <div className="px-3 py-2 text-[12px] text-[#ef4444]">{error}</div>}

      <div className="relative min-h-0 flex-[3]">
        <div ref={priceEl} className="absolute inset-0" />
        {loading && (
          <div className="absolute inset-0 z-50 flex items-center justify-center">
            <div className="spinner" />
          </div>
        )}
        <PinnedCrosshairLayer
          pins={pins}
          chart={charts?.price ?? null}
          epoch={epoch}
          onRemove={removePin}
          renderCard={(pin) => {
            const v = valuesAt(indexOfTime(pin.time));
            if (!v) return null;
            return (
              <PriceTooltipBody
                timeStr={v.hhmm}
                ohlc={v.ohlc}
                legPrices={[
                  ...(v.pe != null ? [{ name: peName, color: PE_COLOR, value: v.pe }] : []),
                  ...(v.ce != null ? [{ name: ceName, color: CE_COLOR, value: v.ce }] : []),
                ]}
                underlying={UNDERLYING}
              />
            );
          }}
          compare={
            compare && (
              <PinCompareStrip
                dtSeconds={compare.dt}
                rows={compare.price}
                colors={compare.colors}
              />
            )
          }
        />
      </div>
      <div className="h-px shrink-0 bg-[var(--border)]" />
      <div className="relative min-h-0 flex-[2]">
        <div ref={pnlEl} className="absolute inset-0" />
        <PinnedCrosshairLayer
          pins={pins}
          chart={charts?.pnl ?? null}
          epoch={epoch}
          onRemove={removePin}
          renderCard={(pin) => {
            const v = valuesAt(indexOfTime(pin.time));
            if (!v) return null;
            return (
              <PnlTooltipBody
                timeStr={v.hhmm}
                values={{
                  legs: [
                    ...(v.pePnl != null ? [{ name: peName, color: PE_COLOR, value: v.pePnl }] : []),
                    ...(v.cePnl != null ? [{ name: ceName, color: CE_COLOR, value: v.cePnl }] : []),
                  ],
                  total: v.total ?? 0,
                }}
                strategyMargin={0}
              />
            );
          }}
          compare={
            compare && (
              <PinCompareStrip dtSeconds={compare.dt} rows={compare.pnl} colors={compare.colors} />
            )
          }
        />
      </div>
    </div>
  );
}
