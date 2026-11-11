/**
 * The Trade Explorer tab: the Strangle Max Loss report in full, and the trade-by-trade explorer.
 * Clicking any day in the report (its tables, charts, day tiles) opens that day here in the
 * explorer, with the report's strike choice (OTM step or price band) as the trade set. Both views
 * stay loaded, so going back to the report keeps its place.
 */
import { useEffect, useRef, useState } from 'react';
import TradeExplorer, { type ReportOpenRequest } from './TradeExplorer';
import type { SignalUnderlying } from './lib/signalBacktest';
import type { Theme } from './types';

const OPEN_DAY_MESSAGE = 'max-loss-report:open-day';
const VIEW_KEY = 'nubra-trade-explorer-view';
const UNDERLYINGS: SignalUnderlying[] = ['NIFTY', 'SENSEX'];

type View = 'report' | 'trades';

const remembered = (): { view: View; underlying: SignalUnderlying } => {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}');
    return {
      view: raw.view === 'trades' ? 'trades' : 'report',
      underlying: raw.underlying === 'SENSEX' ? 'SENSEX' : 'NIFTY',
    };
  } catch {
    return { view: 'report', underlying: 'NIFTY' };
  }
};

export default function TradeExplorerHost({ theme }: { theme: Theme }) {
  const [view, setView] = useState<View>(() => remembered().view);
  const [reportUnderlying, setReportUnderlying] = useState<SignalUnderlying>(
    () => remembered().underlying,
  );
  // A report is only fetched once it is first shown (NIFTY's is about 15 MB), then kept.
  const [mounted, setMounted] = useState<ReadonlySet<SignalUnderlying>>(() =>
    remembered().view === 'report' ? new Set([remembered().underlying]) : new Set(),
  );
  const [ready, setReady] = useState<ReadonlySet<SignalUnderlying>>(new Set());
  const frames = useRef(new Map<SignalUnderlying, HTMLIFrameElement>());
  const [request, setRequest] = useState<ReportOpenRequest | null>(null);
  const [from, setFrom] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ view, underlying: reportUnderlying }));
    } catch {
      /* works without remembering */
    }
  }, [view, reportUnderlying]);

  useEffect(() => {
    if (view === 'report' && !mounted.has(reportUnderlying))
      setMounted((m) => new Set([...m, reportUnderlying]));
  }, [view, reportUnderlying, mounted]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; date?: unknown; key?: unknown } | null;
      if (!data || data.type !== OPEN_DAY_MESSAGE || typeof data.date !== 'string') return;
      const underlying = UNDERLYINGS.find(
        (u) => frames.current.get(u)?.contentWindow === event.source,
      );
      if (!underlying || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return;
      const key = typeof data.key === 'string' ? data.key : 'otm2';
      setRequest({ underlying, date: data.date, key, seq: Date.now() });
      setFrom(`${underlying} ${data.date}`);
      setView('trades');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // The report reads data-theme on its root and redraws; keep it with the app's theme.
  useEffect(() => {
    for (const u of ready) {
      const root = frames.current.get(u)?.contentDocument?.documentElement;
      if (root) root.dataset.theme = theme === 'light' ? 'light' : 'dark';
    }
  }, [theme, ready]);

  const segButton = (on: boolean) =>
    on ? { background: 'var(--accent)', color: 'var(--bg-primary)' } : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border)] px-2 py-1 text-[12px]">
        <div className="flex overflow-hidden rounded border border-[var(--border)]" role="group">
          {(
            [
              ['report', 'Report'],
              ['trades', 'Trade by trade'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              className="border-r border-[var(--border)] px-3 py-1 font-semibold last:border-r-0"
              style={segButton(view === v)}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </div>
        {view === 'report' ? (
          <>
            <div
              className="flex overflow-hidden rounded border border-[var(--border)]"
              role="group"
            >
              {UNDERLYINGS.map((u) => (
                <button
                  key={u}
                  type="button"
                  className="border-r border-[var(--border)] px-2 py-1 font-semibold last:border-r-0"
                  style={segButton(reportUnderlying === u)}
                  aria-pressed={reportUnderlying === u}
                  onClick={() => setReportUnderlying(u)}
                >
                  {u}
                </button>
              ))}
            </div>
            <span className="text-[var(--text-muted)]">
              Strangle Max Loss report · click any day in it to open that trade here
            </span>
          </>
        ) : (
          from && (
            <button
              type="button"
              className="rounded border border-[var(--border)] px-2 py-1"
              onClick={() => setView('report')}
            >
              ← Back to the report <span className="text-[var(--text-muted)]">({from})</span>
            </button>
          )
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {[...mounted].map((u) => (
          <div
            key={u}
            className="absolute inset-0"
            style={{ display: view === 'report' && reportUnderlying === u ? 'block' : 'none' }}
          >
            {!ready.has(u) && (
              <div className="absolute inset-0 p-4 text-[12px] text-[var(--text-muted)]">
                Loading the {u} report…
              </div>
            )}
            <iframe
              ref={(el) => {
                if (el) frames.current.set(u, el);
                else frames.current.delete(u);
              }}
              title={`${u} Strangle Max Loss report`}
              src={`/api/signal-backtest/max-loss-report?underlying=${u}`}
              className="h-full w-full border-0"
              onLoad={() => setReady((r) => new Set([...r, u]))}
            />
          </div>
        ))}
        <div className="absolute inset-0" style={{ display: view === 'trades' ? 'block' : 'none' }}>
          <TradeExplorer theme={theme} openRequest={request} />
        </div>
      </div>
    </div>
  );
}
