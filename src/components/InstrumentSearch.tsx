import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instrument, InstrumentType } from '../types';
import { getInstrumentType } from '../types';
import { fetchRefdata } from '../db';
import NubraWorker from '../workers/nubraSearch.worker?worker';

const POPULAR_INDICES: Instrument[] = [
  { stock_name: 'NIFTY 50',   nubra_name: 'NIFTY',      exchange: 'NSE', derivative_type: 'INDEX' },
  { stock_name: 'BANKNIFTY',  nubra_name: 'BANKNIFTY',  exchange: 'NSE', derivative_type: 'INDEX' },
  { stock_name: 'FINNIFTY',   nubra_name: 'FINNIFTY',   exchange: 'NSE', derivative_type: 'INDEX' },
  { stock_name: 'MIDCPNIFTY', nubra_name: 'MIDCPNIFTY', exchange: 'NSE', derivative_type: 'INDEX' },
  { stock_name: 'SENSEX',     nubra_name: 'SENSEX',     exchange: 'BSE', derivative_type: 'INDEX' },
  { stock_name: 'BANKEX',     nubra_name: 'BANKEX',     exchange: 'BSE', derivative_type: 'INDEX' },
  { stock_name: 'INDIA VIX',  nubra_name: 'INDIA_VIX',   exchange: 'NSE', derivative_type: 'INDEX' },
];

const FILTER_TABS: { label: string; types: InstrumentType[] }[] = [
  { label: 'All',     types: [] },
  { label: 'Equity',  types: ['STOCK'] },
  { label: 'Indices', types: ['INDEX'] },
  { label: 'F&O',     types: ['FUT', 'OPT'] },
  { label: 'ETFs',    types: ['ETF'] },
];

const BADGE_COLORS: Record<InstrumentType, string> = {
  STOCK: 'bg-green-500/10 text-green-400',
  INDEX: 'bg-blue-500/10 text-blue-400',
  FUT:   'bg-yellow-500/10 text-yellow-400',
  OPT:   'bg-purple-500/10 text-purple-400',
  ETF:   'bg-teal-500/10 text-teal-400',
};

interface InstrumentSearchProps {
  placeholder?: string;
  onSelect: (item: Instrument) => void;
}

export default function InstrumentSearch({ placeholder = 'Search symbol…', onSelect }: InstrumentSearchProps) {
  const [query,        setQuery]        = useState('');
  const [results,      setResults]      = useState<Instrument[]>([]);
  const [open,         setOpen]         = useState(false);
  const [filter,       setFilter]       = useState('All');
  const [workerReady,  setWorkerReady]  = useState(false);
  const workerRef  = useRef<Worker | null>(null);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const dropRef    = useRef<HTMLDivElement>(null);
  const queryRef   = useRef('');

  // Boot Web Worker and pre-load refdata
  useEffect(() => {
    const worker = new NubraWorker();
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<{ type: string; results?: Instrument[]; count?: number }>) => {
      if (e.data.type === 'loaded') setWorkerReady(true);
      if (e.data.type === 'results') {
        const res = e.data.results || [];
        const q2  = queryRef.current.toLowerCase();
        if (q2.length < 2) { setResults(res); return; }
        const matched = POPULAR_INDICES.filter((p) =>
          (p.stock_name || '').toLowerCase().includes(q2) ||
          (p.nubra_name || '').toLowerCase().includes(q2),
        );
        const combined = [...matched, ...res.filter((r) =>
          !matched.some((m) => m.nubra_name === r.nubra_name),
        )];
        setResults(combined);
      }
    };

    // Load NSE refdata into worker
    fetchRefdata('NSE').then((items) => {
      worker.postMessage({ type: 'load', items });
    }).catch(console.error);

    return () => worker.terminate();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSearch = useCallback((q: string) => {
    if (!workerRef.current || !workerReady) {
      // Fallback: server search
      fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=20`)
        .then((r) => r.json() as Promise<{ results: Instrument[] }>)
        .then(({ results: r }) => setResults([...POPULAR_INDICES.filter((p) =>
          (p.stock_name || '').toLowerCase().includes(q.toLowerCase()) ||
          (p.nubra_name || '').toLowerCase().includes(q.toLowerCase()),
        ), ...r]))
        .catch(() => setResults([]));
      return;
    }
    workerRef.current.postMessage({ type: 'search', q, limit: 30 });
  }, [workerReady]);

  function handleInput(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    setQuery(q);
    queryRef.current = q;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (q.length < 2) {
      setResults(POPULAR_INDICES);
      setOpen(true);
      return;
    }
    timerRef.current = setTimeout(() => doSearch(q), 200);
    setOpen(true);
  }

  function handleFocus() {
    if (query.length < 2) setResults(POPULAR_INDICES);
    setOpen(true);
  }

  function handleSelect(item: Instrument) {
    setQuery('');
    queryRef.current = '';
    setOpen(false);
    onSelect(item);
  }

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        !inputRef.current?.contains(e.target as Node) &&
        !dropRef.current?.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  const activeFilter = FILTER_TABS.find((t) => t.label === filter)!;
  const filtered = activeFilter.types.length
    ? results.filter((r) => activeFilter.types.includes(getInstrumentType(r)))
    : results;

  return (
    <div className="relative w-full">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none text-sm">⌕</span>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={handleInput}
        onFocus={handleFocus}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full pl-8 pr-3 py-[7px] bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-primary)] text-[13px] focus:outline-none focus:border-[var(--accent)] transition-colors"
      />

      {open && (
        <div
          ref={dropRef}
          className="absolute top-[calc(100%+6px)] left-[-60px] right-0 min-w-[340px] bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl max-h-[420px] overflow-y-auto z-[200]"
        >
          {/* Filter tabs */}
          <div className="flex gap-1 px-2.5 pt-2.5 pb-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-card)] z-10">
            {FILTER_TABS.map(({ label }) => (
              <button
                key={label}
                onMouseDown={(e) => { e.preventDefault(); setFilter(label); }}
                className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
                  label === filter
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Results */}
          {!filtered.length ? (
            <div className="px-4 py-5 text-center text-[var(--text-muted)] text-[13px]">No results</div>
          ) : filtered.slice(0, 15).map((item, i) => {
            const name  = item.stock_name || item.asset || item.symbol || 'Unknown';
            const nname = item.nubra_name || item.zanskar_name || '';
            const exch  = (item.exchange || 'NSE').toUpperCase();
            const type  = getInstrumentType(item);
            return (
              <div
                key={i}
                tabIndex={0}
                onClick={() => handleSelect(item)}
                onKeyDown={(e) => e.key === 'Enter' && handleSelect(item)}
                className="flex items-center justify-between px-3.5 py-2.5 cursor-pointer border-b border-[var(--border)]/60 hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-hover)] focus:outline-none transition-colors last:border-0"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <span className="font-semibold text-[var(--text-primary)] text-[13px] truncate">{name}</span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400 shrink-0">{exch}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {nname && nname !== name && (
                    <span className="text-[11px] text-[var(--text-muted)]">{nname}</span>
                  )}
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${BADGE_COLORS[type]}`}>{type}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
