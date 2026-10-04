/**
 * Signal Backtest: on each day, the first profit-mismatch case (the Analysis tab's definition, but
 * as seen live — no hindsight) triggers one option trade a set number of minutes later, held to the
 * exit time. Shows every trade's values plus the max profit / max loss it went through.
 *
 * Reads the same data as the Analysis tab through its own endpoint; it never changes that tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PremiumSetsPicker from './components/PremiumSetsPicker';
import RowFilter from './components/RowFilter';
import SignalDayChart from './components/SignalDayChart';
import type { Theme } from './types';
import {
  DEFAULT_SIGNAL_PARAMS,
  DEFAULT_DTES,
  DEFAULT_TRADE_PARAMS,
  GREEKS,
  LOT_SIZE,
  NO_FILTER,
  buildCsv,
  cleanRangeMap,
  cleanStepMap,
  describeFilter,
  dteBadge,
  dteLabel,
  dteShort,
  filterActive,
  filterRows,
  fmtGreek,
  greekChange,
  inr,
  num,
  pnlClass,
  strikeRule,
  tradeStats,
  type LegChoice,
  type RowFilter as DayFilter,
  type SignalBacktestResponse,
  type SignalBacktestRow,
  type SignalParams,
  type SignalUnderlying,
  type TradeParams,
  type WideStatus,
} from './lib/signalBacktest';

const SETTINGS_KEY = 'nubra-signal-backtest-settings';
const SETTINGS_VERSION = 1;

type LocalOnly = 'auto' | 'include' | 'exclude';
type SortBy = 'oldest' | 'newest' | 'best' | 'worst';

interface Settings {
  underlying: SignalUnderlying;
  signal: SignalParams;
  trade: TradeParams;
  from: string;
  to: string;
  localOnly: LocalOnly;
  /** Price extremes from parquet high/low (slow over long ranges) or from closes only (fast). */
  useHighLow: boolean;
  sort: SortBy;
  /**
   * Show the reference strangle's greeks columns (t1, t2 and the change) in the table. Off until
   * asked for: they are wide, and the table should fit the screen without them. (Named apart from
   * the earlier `showGreeks`, which defaulted on and is still in many saved settings.)
   */
  showGreekColumns: boolean;
  /** The Signal and Trade rows. Folded away they leave the table and the day chart the screen. */
  settingsOpen: boolean;
  version: number;
}

function defaultSettings(underlying: SignalUnderlying = 'NIFTY'): Settings {
  return {
    underlying,
    signal: { ...DEFAULT_SIGNAL_PARAMS, qty: LOT_SIZE[underlying] },
    trade: { ...DEFAULT_TRADE_PARAMS },
    from: '',
    to: '',
    localOnly: 'auto',
    useHighLow: true,
    sort: 'oldest',
    showGreekColumns: false,
    settingsOpen: true,
    version: SETTINGS_VERSION,
  };
}

function loadSettings(): Settings {
  const fallback = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw) as Partial<Settings>;
    if (saved.version !== SETTINGS_VERSION) return fallback;
    const underlying: SignalUnderlying = saved.underlying === 'SENSEX' ? 'SENSEX' : 'NIFTY';
    return {
      ...defaultSettings(underlying),
      ...saved,
      underlying,
      signal: { ...defaultSettings(underlying).signal, ...(saved.signal ?? {}) },
      trade: normalizeTrade({ ...DEFAULT_TRADE_PARAMS, ...(saved.trade ?? {}) }),
    };
  } catch {
    return fallback;
  }
}

/**
 * Saved settings (or a hand edit) get clean overrides by days to expiry. Settings from when the
 * overrides were keyed by weekday carry the old keys; they are dropped, since a Monday's range does
 * not say which distance from expiry it was meant for.
 */
function normalizeTrade(t: TradeParams): TradeParams {
  const {
    otmStepsByWeekday: _a,
    cePremiumByWeekday: _b,
    pePremiumByWeekday: _c,
    premiumWeekdaysOnly: _d,
    ...rest
  } = t as TradeParams & Record<string, unknown>;
  return {
    ...rest,
    otmStepsByDte: cleanStepMap(t.otmStepsByDte),
    cePremiumByDte: cleanRangeMap(t.cePremiumByDte),
    pePremiumByDte: cleanRangeMap(t.pePremiumByDte),
    // Premium mode is data-first: only distances with a chosen tier trade. There is no typed range.
    premiumTiersOnly: true,
  };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* private mode / quota — settings just won't persist */
  }
}

function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function fmtDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** An expiry distance beyond the usual 0 – 4 gets a button only if the run saw it on this many days. */
const MIN_DAYS_FOR_BUTTON = 5;

const inputCls =
  'h-7 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]';
const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';
const groupCls =
  'flex flex-wrap items-end gap-x-3 gap-y-2 border-b border-[var(--border)] px-3 py-2';
const groupTitleCls =
  'w-[64px] self-center text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]';

export default function SignalBacktest({ theme }: { theme: Theme }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [result, setResult] = useState<SignalBacktestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  /** The row whose day chart is open, by date (one trade per day). */
  const [chartDate, setChartDate] = useState<string | null>(null);
  /**
   * Which days the table shows. Only a view: the run covers every day, and the filter is not saved,
   * so a reload never leaves days hidden without saying so.
   */
  const [dayFilter, setDayFilter] = useState<DayFilter>(NO_FILTER);
  const tableBox = useRef<HTMLDivElement>(null);
  const runSeq = useRef(0);
  const [wide, setWide] = useState<WideStatus | null>(null);
  const [wideError, setWideError] = useState<string | null>(null);

  const { underlying, signal, trade } = settings;

  const loadWide = useCallback(async () => {
    try {
      const res = await fetch(`/api/signal-backtest/wide/status?underlying=${underlying}`);
      if (!res.ok) return;
      setWide((await res.json()) as WideStatus);
    } catch {
      /* status is informational; the Run button does not depend on it */
    }
  }, [underlying]);

  useEffect(() => {
    void loadWide();
  }, [loadWide]);

  // Poll while a download runs, so the progress count moves.
  const wideRunning = wide?.sync.running ?? false;
  useEffect(() => {
    if (!wideRunning) return;
    const id = setInterval(() => void loadWide(), 3000);
    return () => clearInterval(id);
  }, [wideRunning, loadWide]);

  const startWide = async () => {
    setWideError(null);
    try {
      const res = await fetch('/api/signal-backtest/wide/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ underlying }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) setWideError(data.error ?? 'could not start the download');
    } catch (e) {
      setWideError((e as Error).message);
    }
    void loadWide();
  };

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const setSignal = <K extends keyof SignalParams>(key: K, value: SignalParams[K]) =>
    update({ signal: { ...signal, [key]: value } });
  const setTrade = <K extends keyof TradeParams>(key: K, value: TradeParams[K]) =>
    update({ trade: { ...trade, [key]: value } });
  /** Merge into the latest trade settings, not the ones this render saw, so updates cannot race. */
  const patchTrade = useCallback((patch: Partial<TradeParams>) => {
    setSettings((prev) => {
      const next = { ...prev, trade: { ...prev.trade, ...patch } };
      saveSettings(next);
      return next;
    });
  }, []);

  const run = useCallback(async () => {
    const seq = ++runSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/signal-backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          underlying,
          signalParams: signal,
          tradeParams: trade,
          from: settings.from || undefined,
          to: settings.to || undefined,
          includeLocalOnly:
            settings.localOnly === 'auto' ? undefined : settings.localOnly === 'include',
          useHighLow: settings.useHighLow,
        }),
      });
      if (res.status === 404) {
        throw new Error('This server has no Signal Backtest route yet — restart the server.');
      }
      const data = (await res.json()) as SignalBacktestResponse | { ok: false; error: string };
      if (seq !== runSeq.current) return;
      if (!data.ok) throw new Error(data.error);
      // A server started before this page was built ignores settings it does not know (it merges
      // known keys over its defaults) and would silently run something else. Refuse to show that.
      const unknown = (Object.keys(trade) as Array<keyof TradeParams>).filter(
        (k) => data.tradeParams[k] === undefined,
      );
      if (unknown.length) {
        setResult(null);
        throw new Error(
          `The server is running an older version and ignored: ${unknown.join(', ')}. ` +
            'Restart it (Ctrl+C, then npm start) and run again.',
        );
      }
      setResult(data);
    } catch (e) {
      if (seq === runSeq.current) setError((e as Error).message);
    } finally {
      if (seq === runSeq.current) setLoading(false);
    }
  }, [
    underlying,
    signal,
    trade,
    settings.from,
    settings.to,
    settings.localOnly,
    settings.useHighLow,
  ]);

  const shownRows = useMemo(() => filterRows(result?.rows ?? [], dayFilter), [result, dayFilter]);
  // The expiry distances the pickers offer: 0 – 4 always; a further one only when the run saw it on
  // enough days to be worth a button (one stray day in three years is not), or when a choice is
  // already saved for it so that choice is never hidden.
  const dtes = useMemo(() => {
    const saved = [trade.otmStepsByDte, trade.cePremiumByDte, trade.pePremiumByDte].flatMap((m) =>
      Object.keys(m).map(Number),
    );
    const seen = (result?.premiumSets?.expiryDays ?? [])
      .filter((d) => d.days >= MIN_DAYS_FOR_BUTTON)
      .map((d) => d.dte);
    return [...new Set<number>([...DEFAULT_DTES, ...seen, ...saved])].sort((a, b) => a - b);
  }, [result, trade.otmStepsByDte, trade.cePremiumByDte, trade.pePremiumByDte]);
  const rows = useMemo(() => {
    const list = [...shownRows];
    const by: Record<SortBy, (a: SignalBacktestRow, b: SignalBacktestRow) => number> = {
      oldest: (a, b) => (a.date < b.date ? -1 : 1),
      newest: (a, b) => (a.date < b.date ? 1 : -1),
      best: (a, b) => b.trade.pnl - a.trade.pnl,
      worst: (a, b) => a.trade.pnl - b.trade.pnl,
    };
    return list.sort(by[settings.sort]);
  }, [shownRows, settings.sort]);
  const filtered = filterActive(dayFilter);
  const filteredStats = useMemo(() => tradeStats(shownRows), [shownRows]);
  // A new run, or a filter, may leave the day out; then there is simply no chart.
  const chartIdx = rows.findIndex((r) => r.date === chartDate);
  const chartRow = chartIdx >= 0 ? rows[chartIdx] : null;
  const stepChart = (delta: -1 | 1) => {
    const next = rows[chartIdx + delta];
    if (next) setChartDate(next.date);
  };
  // Stepping to a day should bring its row into view (the header is sticky, hence the margin).
  useEffect(() => {
    if (!chartDate) return;
    tableBox.current
      ?.querySelector(`tr[data-date="${chartDate}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [chartDate]);
  const greeksMissing = rows.length > 0 && !rows.some((r) => r.signal.greeks);
  /** The greeks block needs a second header row for its t1 / t2 / change sub-columns. */
  const headRows = settings.showGreekColumns ? 2 : 1;

  const exportCsv = () => {
    if (!result) return;
    // What the filter leaves, in date order.
    const list = filterRows(result.rows, dayFilter);
    const range = `${list[0]?.date ?? 'none'}_${list.at(-1)?.date ?? 'none'}`;
    downloadFile(
      `signal_backtest_${result.underlying}_${range}${filtered ? '_filtered' : ''}.csv`,
      buildCsv(list),
      'text/csv',
    );
  };

  const s = result?.summary;
  const legLabel = `${trade.legs === 'BOTH' ? 'CE+PE' : trade.legs} ${strikeRule(trade)}`;
  const topSkips = s
    ? Object.entries(s.skipped)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];
  const pts = underlying === 'SENSEX' ? 100 : 50;

  return (
    <div className="signal-backtest-view flex h-full flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] font-semibold">Signal Backtest</span>
          <select
            aria-label="Signal backtest underlying"
            className="h-6 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1.5 text-[11px] font-semibold"
            value={underlying}
            onChange={(e) => {
              const next = e.target.value as SignalUnderlying;
              update({ underlying: next, signal: { ...signal, qty: LOT_SIZE[next] } });
            }}
          >
            <option value="NIFTY">NIFTY</option>
            <option value="SENSEX">SENSEX</option>
          </select>
          <span className="text-[11px] text-[var(--text-muted)]">
            first mismatch case of the day → {trade.side} {legLabel}, {trade.delayMinutes} min later
            → exit {trade.exitTime}
          </span>
        </div>
        <button
          type="button"
          aria-expanded={settings.settingsOpen}
          onClick={() => update({ settingsOpen: !settings.settingsOpen })}
          title="Fold away the Signal and Trade rows to give the table and the day chart more room. The line beside the title still says what is set."
          className="ml-auto h-6 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 text-[11px] text-[var(--text-primary)]"
        >
          {settings.settingsOpen ? 'Hide' : 'Show'} signal &amp; trade settings{' '}
          {settings.settingsOpen ? '▴' : '▾'}
        </button>
      </div>

      {settings.settingsOpen && (
        <>
          {/* Signal settings (the Analysis definition) */}
          <div className={groupCls}>
            <span className={groupTitleCls} title="The Analysis tab's mismatch rules">
              Signal
            </span>
            <TimeField
              label="Ref entry"
              value={signal.entryTime}
              onChange={(v) => setSignal('entryTime', v)}
            />
            <TimeField
              label="Search until"
              value={signal.exitTime}
              title="No signal is taken after this minute"
              onChange={(v) => setSignal('exitTime', v)}
            />
            <NumberField
              label="Close ± pts"
              value={signal.closeTolerance}
              step={0.5}
              min={0}
              onChange={(v) => setSignal('closeTolerance', v)}
            />
            <NumberField
              label="Min gap (min)"
              value={signal.minGapMinutes}
              step={5}
              min={1}
              onChange={(v) => setSignal('minGapMinutes', v)}
            />
            <NumberField
              label="Legs differ ≥ %"
              value={signal.legMismatchPct}
              step={10}
              min={0}
              title="CE and PE P&L changes must be at least this far apart, as a % of the bigger leg's change. 50 = opposite directions, or one leg moved at least twice the other."
              onChange={(v) => setSignal('legMismatchPct', v)}
            />
            <NumberField
              label="Min |Δ| ₹"
              value={signal.minAbsPnl}
              step={100}
              min={0}
              onChange={(v) => setSignal('minAbsPnl', v)}
            />
            <SelectField
              label="Measure"
              value={signal.rankBy}
              options={[
                ['legGap', 'CE vs PE gap'],
                ['total', 'Total P&L change'],
              ]}
              onChange={(v) => setSignal('rankBy', v)}
            />
            <NumberField
              label="Ref OTM ±"
              value={signal.strikeOffset}
              step={1}
              min={0}
              title="Reference strangle: ATM ± this many strikes at the ref entry minute"
              onChange={(v) => setSignal('strikeOffset', v)}
            />
            <SelectField
              label="Ref side"
              value={signal.side}
              options={[
                ['SELL', 'SELL'],
                ['BUY', 'BUY'],
              ]}
              onChange={(v) => setSignal('side', v)}
            />
            <NumberField
              label="Ref qty"
              value={signal.qty}
              step={LOT_SIZE[underlying]}
              min={1}
              onChange={(v) => setSignal('qty', v)}
            />
          </div>

          {/* Trade settings */}
          <div className={groupCls}>
            <span className={groupTitleCls}>Trade</span>
            <SelectField
              label="Legs"
              value={trade.legs}
              options={[
                ['BOTH', 'CE + PE'],
                ['CE', 'CE only'],
                ['PE', 'PE only'],
              ]}
              onChange={(v) => setTrade('legs', v as LegChoice)}
            />
            <SelectField
              label="Side"
              value={trade.side}
              options={[
                ['SELL', 'SELL'],
                ['BUY', 'BUY'],
              ]}
              onChange={(v) => setTrade('side', v)}
            />
            <SelectField
              label="Strike by"
              value={trade.strikeMode}
              options={[
                ['OTM', 'OTM steps'],
                ['PREMIUM', 'Premium range'],
              ]}
              title="OTM steps: a fixed number of strikes from ATM. Premium range: pick, for each weekday, a price tier found in the data; the strike priced inside it, closest to its middle, is sold."
              onChange={(v) => setTrade('strikeMode', v)}
            />
            {trade.strikeMode === 'OTM' ? (
              <>
                <NumberField
                  label="OTM steps"
                  value={trade.otmSteps}
                  step={1}
                  min={0}
                  title={`Strikes away from ATM at the entry minute (${pts} points each). 0 = ATM. OTM 2 → CE at ATM + ${2 * pts}, PE at ATM − ${2 * pts}. Beyond 3 needs the wide Nubra data on days after the parquet data ends.`}
                  onChange={(v) => setTrade('otmSteps', Math.round(v))}
                />
                <ExpiryStepsField
                  dtes={dtes}
                  value={trade.otmStepsByDte}
                  fallback={trade.otmSteps}
                  onChange={(v) => setTrade('otmStepsByDte', v)}
                />
              </>
            ) : (
              <>
                <PremiumSetsPicker
                  sets={result?.premiumSets ?? null}
                  builtFor={
                    result ? `last run ${result.from ?? 'start'} → ${result.to ?? 'end'}` : ''
                  }
                  legs={trade.legs}
                  dtes={dtes}
                  ce={trade.cePremiumByDte}
                  pe={trade.pePremiumByDte}
                  onChange={patchTrade}
                />
              </>
            )}
            <NumberField
              label="Delay (min)"
              value={trade.delayMinutes}
              step={1}
              min={0}
              title="Minutes after the signal minute to enter"
              onChange={(v) => setTrade('delayMinutes', Math.round(v))}
            />
            <NumberField
              label={`Lots (×${LOT_SIZE[underlying]})`}
              value={trade.lots}
              step={1}
              min={1}
              onChange={(v) => setTrade('lots', Math.round(v))}
            />
            <TimeField
              label="Exit"
              value={trade.exitTime}
              onChange={(v) => setTrade('exitTime', v)}
            />
          </div>
        </>
      )}

      {/* Range and actions */}
      <div className={groupCls}>
        <span className={groupTitleCls}>Range</span>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>From</span>
          <input
            type="date"
            className={`${inputCls} w-[130px]`}
            value={settings.from}
            onChange={(e) => update({ from: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className={lblCls}>To</span>
          <input
            type="date"
            className={`${inputCls} w-[130px]`}
            value={settings.to}
            onChange={(e) => update({ to: e.target.value })}
          />
        </label>
        <SelectField
          label="Local-only days"
          value={settings.localOnly}
          options={[
            ['auto', 'Auto (data check)'],
            ['include', 'Include'],
            ['exclude', 'Exclude'],
          ]}
          title="Days only the local parquet data covers. Auto includes them while the Analysis data check passes."
          onChange={(v) => update({ localOnly: v })}
        />
        <label
          className="flex h-7 cursor-pointer items-center gap-1.5 self-end text-[12px]"
          title="Local parquet data (up to Jun 2026). On: entry, max profit/loss and far strikes use its open/high/low — about 5 minutes for the full history. Off: closes and near strikes only — seconds. Downloaded wide Nubra data is always used, whatever this says."
        >
          <input
            type="checkbox"
            checked={settings.useHighLow}
            onChange={(e) => update({ useHighLow: e.target.checked })}
          />
          Use high/low
        </label>
        {wide && (
          <div
            className="flex h-7 items-center gap-2 self-end text-[11px] text-[var(--text-muted)]"
            title="Open/high/low for ±10 strikes on Nubra days, downloaded into this tab's own folder (.signal-cache). Needed for far strikes, premium ranges and highs/lows after the parquet data ends. The Analysis data is not touched."
          >
            <span>
              Wide Nubra data{' '}
              <b className="text-[var(--text-primary)]">
                {wide.wideDays}/{wide.nubraDays}
              </b>{' '}
              days
              {wide.sync.running &&
                ` · downloading ${wide.sync.done}/${wide.sync.total}${wide.sync.failed ? ` (${wide.sync.failed} failed)` : ''}`}
            </span>
            {!wide.sync.running && wide.wideDays < wide.nubraDays && (
              <button
                type="button"
                className="h-6 rounded border border-[var(--border)] px-2 text-[11px] hover:border-[var(--accent)] disabled:opacity-40"
                disabled={!wide.brokerSession}
                title={wide.brokerSession ? undefined : 'Log in to the broker to download'}
                onClick={() => void startWide()}
              >
                Download
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className="ml-auto h-7 rounded bg-[var(--accent)] px-4 text-[12px] font-semibold text-white disabled:opacity-50"
          disabled={loading}
          onClick={() => void run()}
        >
          {loading ? 'Running…' : 'Run'}
        </button>
        <button
          type="button"
          className="h-7 rounded border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40"
          disabled={!result?.rows.length}
          onClick={exportCsv}
        >
          Export CSV
        </button>
        <button
          type="button"
          className="h-7 rounded border border-[var(--border)] px-2 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() =>
            update({
              signal: defaultSettings(underlying).signal,
              trade: { ...DEFAULT_TRADE_PARAMS },
            })
          }
          title="Restore default settings"
        >
          Defaults
        </button>
      </div>

      {error && (
        <div className="border-b border-[var(--border)] bg-[#ef4444]/10 px-3 py-1.5 text-[12px] text-[#ef4444]">
          {error}
        </div>
      )}
      {(wideError || (wide && !wide.sync.running && wide.sync.lastError)) && (
        <div className="border-b border-[var(--border)] bg-[#ef4444]/10 px-3 py-1.5 text-[12px] text-[#ef4444]">
          Wide data download: {wideError ?? wide?.sync.lastError}
        </div>
      )}

      {/* What the shown result was run with — the form may have changed since. */}
      {result && (
        <div className="border-b border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-muted)]">
          Results for:{' '}
          <span className="text-[var(--text-primary)]">
            {result.underlying} · {result.tradeParams.side}{' '}
            {result.tradeParams.legs === 'BOTH' ? 'CE+PE' : result.tradeParams.legs}{' '}
            {strikeRule(result.tradeParams)} · {result.tradeParams.delayMinutes} min after signal ·
            exit {result.tradeParams.exitTime} · {result.from ?? 'start'} → {result.to ?? 'end'} ·
            high/low {result.useHighLow ? 'on' : 'off'}
          </span>
          {topSkips.length > 0 && (
            <span>
              {' '}
              · skipped:{' '}
              {topSkips.map(([reason, n]) => `${reason.replace(/^trade: /, '')} ×${n}`).join(', ')}
            </span>
          )}
        </div>
      )}

      {/* Summary */}
      {s && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-[var(--border)] px-3 py-2 text-[11px]">
          <Stat label="Days" value={`${s.daysWithSignal} signal / ${s.daysScanned} scanned`} />
          <Stat label="Trades" value={`${s.trades} · ${s.wins}W ${s.losses}L · ${s.winRate}%`} />
          <Stat label="Total P&L" value={inr(s.totalPnl)} cls={pnlClass(s.totalPnl)} />
          <Stat label="Avg P&L" value={inr(s.avgPnl)} cls={pnlClass(s.avgPnl)} />
          <Stat label="Best / worst day" value={`${inr(s.best?.value)} / ${inr(s.worst?.value)}`} />
          <Stat
            label="Avg max profit / loss"
            value={`${inr(s.avgMaxProfit)} / ${inr(s.avgMaxLoss)}`}
          />
          <Stat
            label="Biggest max profit"
            value={
              s.biggestMaxProfit
                ? `${inr(s.biggestMaxProfit.value)} (${s.biggestMaxProfit.date})`
                : '—'
            }
          />
          <Stat
            label="Biggest max loss"
            value={
              s.biggestMaxLoss ? `${inr(s.biggestMaxLoss.value)} (${s.biggestMaxLoss.date})` : '—'
            }
          />
          <Stat
            label="Price basis"
            value={`${s.ohlcTrades} high/low · ${s.closeTrades} close only`}
          />
          <Stat
            label="Source"
            value={`${s.nubraDays} Nubra · ${s.localDays} local · ${(s.ms / 1000).toFixed(1)}s`}
          />
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
            <span>
              {rows.length}
              {filtered && ` of ${result.rows.length}`} trades · max profit / loss are
              mark-to-market extremes between entry and exit
              {trade.legs === 'BOTH' ? ' (both legs: per-minute best/worst case)' : ''}
              {' · click a row for its day chart'}
            </span>
            <span className="ml-auto">
              <RowFilter rows={result.rows} value={dayFilter} onChange={setDayFilter} />
            </span>
            <label
              className="flex items-center gap-1"
              title="The reference CE and PE greeks at t1 and t2 and how much each moved between them, next to the Ref ΔCE / ΔPE column. Per option unit; rebuilt with Black-76 off the put-call-parity forward."
            >
              <input
                type="checkbox"
                checked={settings.showGreekColumns}
                onChange={(e) => update({ showGreekColumns: e.target.checked })}
              />
              Greeks
            </label>
            <select
              className="h-6 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-1 text-[11px]"
              value={settings.sort}
              onChange={(e) => update({ sort: e.target.value as SortBy })}
            >
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
              <option value="best">Best P&L</option>
              <option value="worst">Worst P&L</option>
            </select>
          </div>
          {filtered && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-y border-[var(--border)] bg-[var(--accent)]/5 px-3 py-1 text-[11px]">
              <span className="font-semibold text-[var(--accent)]">
                {describeFilter(dayFilter)}
              </span>
              <span>
                {filteredStats.trades} of {result.rows.length} trades
              </span>
              <span className="text-[var(--text-muted)]">
                {filteredStats.wins}W {filteredStats.losses}L · {filteredStats.winRate}% wins
              </span>
              <span>
                P&L{' '}
                <span className={`font-mono font-semibold ${pnlClass(filteredStats.totalPnl)}`}>
                  {inr(filteredStats.totalPnl)}
                </span>
              </span>
              <span>
                avg{' '}
                <span className={`font-mono ${pnlClass(filteredStats.avgPnl)}`}>
                  {inr(filteredStats.avgPnl)}
                </span>
              </span>
              <button
                type="button"
                className="text-[var(--accent)]"
                onClick={() => setDayFilter(NO_FILTER)}
              >
                show all days
              </button>
            </div>
          )}
          {settings.showGreekColumns && greeksMissing && (
            <div className="px-3 pb-1 text-[11px] text-[#f59e0b]">
              This server predates the greeks columns — restart it (Ctrl+C, then npm start) and run
              again.
            </div>
          )}
        </>
      )}
      <div ref={tableBox} className="min-h-0 flex-1 overflow-auto">
        {!result ? (
          <div className="px-3 py-6 text-[12px] text-[var(--text-muted)]">
            {loading
              ? settings.useHighLow
                ? 'Running… with high/low on, the full history takes about 5 minutes.'
                : 'Running…'
              : 'Set the parameters and press Run.'}
          </div>
        ) : (
          <>
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-30 bg-[var(--bg-primary)] text-[var(--text-muted)]">
                <tr className="border-b border-[var(--border)] text-left">
                  <th
                    className="sticky left-0 z-30 bg-[var(--bg-primary)] px-2 py-1"
                    rowSpan={headRows}
                  >
                    Date
                  </th>
                  <th className="px-2 py-1" rowSpan={headRows}>
                    Signal t1 → t2
                  </th>
                  <th className="px-2 py-1 text-right" rowSpan={headRows}>
                    Spot t1 / t2
                  </th>
                  <th className="px-2 py-1 text-right" rowSpan={headRows}>
                    Ref ΔCE / ΔPE
                  </th>
                  {settings.showGreekColumns && (
                    <>
                      <th
                        className="border-l border-[var(--border)] px-2 py-1"
                        rowSpan={2}
                        title="The reference contracts the signal is measured on (ATM ± the Ref OTM setting at the Ref entry time) — not necessarily the strikes the trade sells"
                      >
                        Ref contract
                      </th>
                      {GREEKS.map((g) => (
                        <th
                          key={g.key}
                          colSpan={3}
                          className="border-l border-[var(--border)] px-2 py-1 text-center"
                        >
                          {g.label}
                        </th>
                      ))}
                    </>
                  )}
                  <th className="border-l border-[var(--border)] px-2 py-1" rowSpan={headRows}>
                    Entry
                  </th>
                  <th className="px-2 py-1 text-right" rowSpan={headRows}>
                    Spot / ATM
                  </th>
                  <th className="px-2 py-1" rowSpan={headRows}>
                    Legs: entry (open/close) → exit
                  </th>
                  <th className="px-2 py-1 text-right" rowSpan={headRows}>
                    Max profit
                  </th>
                  <th className="px-2 py-1 text-right" rowSpan={headRows}>
                    Max loss
                  </th>
                  <th
                    className="sticky right-0 z-30 bg-[var(--bg-primary)] px-2 py-1 text-right"
                    rowSpan={headRows}
                  >
                    P&L
                  </th>
                </tr>
                {settings.showGreekColumns && (
                  <tr className="border-b border-[var(--border)] text-right text-[10px]">
                    {GREEKS.flatMap((g) =>
                      GREEK_WHEN.map((w, i) => (
                        <th
                          key={`${g.key}-${w.key}`}
                          className={`whitespace-nowrap px-1 pb-1 font-normal ${
                            i === 0 ? 'border-l border-[var(--border)]' : ''
                          }`}
                          title={w.title}
                        >
                          {w.label}
                        </th>
                      )),
                    )}
                  </tr>
                )}
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.date}
                    data-date={r.date}
                    onClick={() => setChartDate((d) => (d === r.date ? null : r.date))}
                    className={`scroll-mt-14 cursor-pointer border-b border-[var(--border)] align-top hover:bg-[var(--bg-secondary)] ${
                      r.date === chartDate ? 'bg-[var(--bg-secondary)]' : 'bg-[var(--bg-primary)]'
                    }`}
                  >
                    <td
                      className="sticky left-0 z-10 whitespace-nowrap bg-inherit px-2 py-1"
                      // A bar down the left edge marks the two days an expiry trader watches; the
                      // hairline on the right shows where the pinned column ends when the rest scrolls.
                      style={{
                        boxShadow: [
                          r.dte === 0
                            ? `inset 3px 0 0 ${EXPIRY_COLOR}`
                            : r.dte === 1
                              ? `inset 3px 0 0 ${PRE_EXPIRY_COLOR}`
                              : '',
                          'inset -1px 0 0 var(--border)',
                        ]
                          .filter(Boolean)
                          .join(', '),
                      }}
                      title={
                        r.dte == null
                          ? undefined
                          : `${dteLabel(r.dte)}: ${r.dte} trading day${r.dte === 1 ? '' : 's'} to the ${r.expiry} expiry`
                      }
                    >
                      {fmtDate(r.date)}
                      {dteBadge(r.dte) && (
                        <span
                          className="ml-1.5 rounded px-1 text-[9px] font-semibold"
                          style={
                            r.dte === 0
                              ? { color: EXPIRY_COLOR, background: 'rgba(245,158,11,0.15)' }
                              : { color: PRE_EXPIRY_COLOR, background: 'rgba(56,189,248,0.15)' }
                          }
                        >
                          {dteBadge(r.dte)}
                        </span>
                      )}
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {r.source === 'nubra' ? 'Nubra' : 'Local'} · exp {r.expiry}
                        {r.dte != null && r.dte > 1 && ` · ${r.dte}d to go`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">
                      {r.signal.t1} → {r.signal.t2}
                      <div className="text-[10px] text-[var(--text-muted)]">
                        ref {r.signal.legs.ceStrike} CE / {r.signal.legs.peStrike} PE
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      {num(r.signal.spot1)}
                      <div>{num(r.signal.spot2)}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      <span className={pnlClass(r.signal.ceDelta)}>{inr(r.signal.ceDelta)}</span>
                      <div className={pnlClass(r.signal.peDelta)}>{inr(r.signal.peDelta)}</div>
                    </td>
                    {settings.showGreekColumns && (
                      <>
                        <td className="whitespace-nowrap border-l border-[var(--border)] px-2 py-1 font-mono">
                          <div style={{ color: CE_COLOR }}>CE {r.signal.legs.ceStrike}</div>
                          <div style={{ color: PE_COLOR }}>PE {r.signal.legs.peStrike}</div>
                        </td>
                        {GREEKS.flatMap((g) =>
                          GREEK_WHEN.map((w, i) => {
                            const cell = (side: 'CE' | 'PE') => {
                              const a = r.signal.greeks?.t1[side] ?? null;
                              const b = r.signal.greeks?.t2[side] ?? null;
                              if (w.key === 't1') return fmtGreek(g.key, a?.[g.key]);
                              if (w.key === 't2') return fmtGreek(g.key, b?.[g.key]);
                              return fmtGreek(g.key, greekChange(a, b, g.key), true);
                            };
                            return (
                              <td
                                key={`${g.key}-${w.key}`}
                                className={`whitespace-nowrap px-1 py-1 text-right font-mono ${
                                  i === 0 ? 'border-l border-[var(--border)]' : ''
                                } ${w.key === 't1' ? 'text-[var(--text-muted)]' : ''} ${
                                  w.key === 'chg' ? 'font-semibold' : ''
                                }`}
                              >
                                <div>{cell('CE')}</div>
                                <div>{cell('PE')}</div>
                              </td>
                            );
                          }),
                        )}
                      </>
                    )}
                    <td className="whitespace-nowrap px-2 py-1 font-mono">
                      {r.trade.entryTime}
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {r.trade.side} {r.trade.qty}
                        {r.trade.otmSteps != null &&
                          ` · ${r.trade.otmSteps === 0 ? 'ATM' : `OTM ${r.trade.otmSteps}`}`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      {num(r.trade.entrySpot)}
                      <div>{r.trade.atm}</div>
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {r.trade.legs.map((l) => (
                        <div key={l.kind}>
                          {/* Two chunks that wrap apart when the screen is narrow, never mid-number. */}
                          <span className="whitespace-nowrap">
                            {l.strike} {l.kind}: {num(l.entryPrice)}
                            <span className="text-[var(--text-muted)]">
                              {' '}
                              ({l.entryOpen == null ? '—' : num(l.entryOpen)}/{num(l.entryClose)})
                            </span>
                          </span>{' '}
                          <span className="whitespace-nowrap">
                            → {num(l.exitPrice)}
                            {l.exitFallback && (
                              <span
                                className="text-[var(--text-muted)]"
                                title="No price at the exit minute; last earlier close used"
                              >
                                {' '}
                                @{l.exitTime}
                              </span>
                            )}{' '}
                            <span className={pnlClass(l.pnl)}>{inr(l.pnl)}</span>{' '}
                            <span
                              className="text-[10px] text-[var(--text-muted)]"
                              title={
                                l.basis === 'ohlc'
                                  ? r.ohlcSource === 'nubra-wide'
                                    ? 'Open/high/low from the downloaded wide Nubra data'
                                    : 'Open/high/low from the local parquet data'
                                  : 'Closes only — no open/high/low for this day'
                              }
                            >
                              {l.basis === 'ohlc' ? 'H/L' : 'close'}
                            </span>
                          </span>
                        </div>
                      ))}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      <span className={pnlClass(r.trade.maxProfit)}>{inr(r.trade.maxProfit)}</span>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {r.trade.maxProfitTime}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-right font-mono">
                      <span className={pnlClass(r.trade.maxLoss)}>{inr(r.trade.maxLoss)}</span>
                      <div className="text-[10px] text-[var(--text-muted)]">
                        {r.trade.maxLossTime}
                      </div>
                    </td>
                    <td
                      className={`sticky right-0 z-10 whitespace-nowrap bg-inherit px-2 py-1 text-right font-mono font-semibold shadow-[inset_1px_0_0_var(--border)] ${pnlClass(r.trade.pnl)}`}
                    >
                      {inr(r.trade.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <div className="px-3 py-4 text-[12px] text-[var(--text-muted)]">
                {filtered ? 'No trade falls on those days.' : 'The run made no trades.'}
              </div>
            )}
            {result.skipped.length > 0 && (
              <div className="px-3 py-2 text-[11px]">
                <button
                  type="button"
                  className="text-[var(--accent)]"
                  onClick={() => setShowSkipped((v) => !v)}
                >
                  {showSkipped ? '▾' : '▸'} {result.skipped.length} days without a trade
                </button>
                {showSkipped && (
                  <ul className="mt-1 space-y-0.5 font-mono text-[var(--text-muted)]">
                    {result.skipped.map((d) => (
                      <li key={d.date}>
                        {d.date} ({d.source}) — {d.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {chartRow && (
        <div className="h-[46%] min-h-[260px] shrink-0">
          <SignalDayChart
            theme={theme}
            underlying={underlying}
            row={chartRow}
            onClose={() => setChartDate(null)}
            onStep={stepChart}
            canStep={{ prev: chartIdx > 0, next: chartIdx < rows.length - 1 }}
          />
        </div>
      )}
    </div>
  );
}

const CE_COLOR = '#22c55e';
const PE_COLOR = '#ef4444';
const EXPIRY_COLOR = '#f59e0b';
const PRE_EXPIRY_COLOR = '#38bdf8';

/** The three sub-columns under each greek, in the order they are read. */
const GREEK_WHEN = [
  { key: 't1', label: 't1', title: 'Value at t1, the first minute of the signal pair' },
  { key: 't2', label: 't2', title: 'Value at t2, the minute the signal fired' },
  { key: 'chg', label: 'change', title: 'How much it changed from t1 to t2 (t2 − t1)' },
] as const;

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col">
      <span className={lblCls}>{label}</span>
      <span className={`font-mono ${cls ?? ''}`}>{value}</span>
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

/** OTM steps by trading days to expiry (Exp = the expiry day); a blank box uses the main OTM steps value. */
function ExpiryStepsField({
  dtes,
  value,
  fallback,
  onChange,
}: {
  dtes: number[];
  value: Record<string, number>;
  fallback: number;
  onChange: (v: Record<string, number>) => void;
}) {
  const set = (dte: number, raw: string) => {
    const next = { ...value };
    if (raw.trim() === '') delete next[String(dte)];
    else {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n < 0 || n > 10) return;
      next[String(dte)] = n;
    }
    onChange(next);
  };
  const any = Object.keys(value).length > 0;
  return (
    <div
      className="flex flex-col gap-0.5"
      title={`OTM steps for a particular distance from expiry, in trading days: Exp is the expiry day, Exp−1 the day before it, and so on. Blank = that day uses OTM steps (${fallback}).`}
    >
      <span className={lblCls}>
        By days to expiry
        {any && (
          <button
            type="button"
            className="ml-1.5 normal-case tracking-normal text-[var(--accent)]"
            onClick={() => onChange({})}
          >
            clear
          </button>
        )}
      </span>
      <div className="flex gap-1">
        {dtes.map((d) => (
          <label key={d} className="relative">
            <span className="pointer-events-none absolute left-1 top-0.5 text-[8px] uppercase text-[var(--text-muted)]">
              {dteShort(d)}
            </span>
            <input
              type="number"
              aria-label={`${dteLabel(d)} OTM steps`}
              // No spinners: at this width they cover most of the box and swallow clicks.
              className={`${inputCls} w-[48px] pt-2.5 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
              value={value[String(d)] ?? ''}
              placeholder={String(fallback)}
              step={1}
              min={0}
              max={10}
              onChange={(e) => set(d, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function TimeField({
  label,
  value,
  title,
  onChange,
}: {
  label: string;
  value: string;
  title?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className={lblCls}>{label}</span>
      <input
        type="time"
        className={`${inputCls} w-[92px]`}
        value={value}
        min="09:15"
        max="15:29"
        onChange={(e) => e.target.value && onChange(e.target.value)}
      />
    </label>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  title,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  title?: string;
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className={lblCls}>{label}</span>
      <select
        className={`${inputCls} min-w-[88px]`}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
