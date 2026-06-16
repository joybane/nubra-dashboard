import { useCallback, useEffect, useRef, useState } from 'react';
import { useWs } from './hooks/useWsContext';
import type { Instrument, OptionChainData, OptionLeg, WsMessage } from './types';
import { getSymbol } from './types';
import { fmtPrice, fmtLakh, formatExpiry, strikeRs } from './lib/utils';

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

const QUICK_PICKS: { sym: string; exch: string }[] = [
  { sym: 'NIFTY', exch: 'NSE' }, { sym: 'BANKNIFTY', exch: 'NSE' },
  { sym: 'FINNIFTY', exch: 'NSE' }, { sym: 'MIDCPNIFTY', exch: 'NSE' },
  { sym: 'SENSEX', exch: 'BSE' },
];

function g(row: unknown, field: string): number | null {
  const row_ = row as Record<string, unknown>;
  const aliases: Record<string, string[]> = {
    ltp:    ['ltp', 'last_traded_price'],
    ltpchg: ['ltpchg', 'last_traded_price_change'],
    oi:     ['oi', 'open_interest'],
    volume: ['volume'],
    iv:     ['iv'],
    delta:  ['delta'], gamma: ['gamma'], theta: ['theta'], vega: ['vega'],
  };
  for (const k of (aliases[field] || [field])) {
    const v = row_[k];
    if (v !== undefined && v !== null) return Number(v);
  }
  return null;
}

interface Props {
  instrument: Instrument | null;
  onNavigateToChart?: (inst: Instrument) => void;
}

export default function OptionChain({ instrument, onNavigateToChart }: Props) {
  const [symbol,   setSymbol]   = useState('');
  const [exchange, setExchange] = useState('NSE');
  const [expiry,   setExpiry]   = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [spot,     setSpot]     = useState<number | null>(null);
  const [chain,    setChain]    = useState<OptionChainData | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Instrument[]>([]);
  const [showSug, setShowSug]   = useState(false);
  const [symInput, setSymInput] = useState('');
  const [activeQuick, setActiveQuick] = useState<string | null>(null);

  // Cell refs for direct DOM updates (no re-render on each tick)
  const cellMapRef = useRef(new Map<string, HTMLTableCellElement>());
  const maxCeOiRef = useRef(1);
  const maxPeOiRef = useRef(1);
  const currentSymRef   = useRef('');
  const currentExchRef  = useRef('NSE');
  const currentExpRef   = useRef('');
  const pollRef         = useRef<number | null>(null);
  const sugTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { subscribe, subscribeOC, unsubscribeOC } = useWs();

  // Load from instrument prop
  useEffect(() => {
    if (!instrument) return;
    const sym = getSymbol(instrument).toUpperCase();
    setSymInput(sym);
    setSymbol(sym);
    setExchange(instrument.exchange || 'NSE');
    loadExpiryThenChain(sym, instrument.exchange || 'NSE');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument]);

  // WS subscription for live updates
  useEffect(() => {
    const unsub = subscribe('option_chain', (msg: WsMessage) => {
      if (msg.type !== 'option_chain') return;
      const data = msg.data as OptionChainData;
      const asset  = (data.asset || '').toUpperCase();
      const exp    = data.expiry || '';
      if (asset !== currentSymRef.current || exp !== currentExpRef.current) return;
      updateCells(data);
    });
    return unsub;
  }, [subscribe]);

  function startPoll(sym: string, exch: string, exp: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      if (!sym || !exp) return;
      try {
        const data = await fetchChainApi(sym, exch, exp);
        if (data.chain) updateCells(data.chain);
      } catch { /* ignore */ }
    }, 3000);
  }

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  const startLiveFeed = useCallback((sym: string, exp: string, exch: string) => {
    stopPoll();
    if (sym && exp) subscribeOC(sym, exp, exch);
    startPoll(sym, exch, exp);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribeOC]);

  function stopLiveFeed() {
    stopPoll();
    if (currentSymRef.current && currentExpRef.current) {
      unsubscribeOC(currentSymRef.current, currentExpRef.current, currentExchRef.current);
    }
  }

  async function loadExpiryThenChain(sym: string, exch: string) {
    stopLiveFeed();
    cellMapRef.current.clear();
    setLoading(true);
    setError(null);
    setChain(null);
    try {
      const data  = await fetchChainApi(sym, exch, '');
      const rawExps = data.chain?.all_expiries || [];
      // Sort ascending and prefer upcoming expiries
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const sorted = [...rawExps].sort();
      const future = sorted.filter((e) => e >= today);
      const exps   = future.length ? future : sorted;
      setExpiries(exps);
      const firstExp = exps[0] || '';
      setExpiry(firstExp);
      currentSymRef.current  = sym;
      currentExchRef.current = exch;
      currentExpRef.current  = firstExp;

      const data2 = await fetchChainApi(sym, exch, firstExp);
      setChain(data2.chain || null);
      const cp2 = data2.chain?.cp ?? data2.chain?.currentprice;
      if (cp2) setSpot(Number(cp2) / 100);
      startLiveFeed(sym, firstExp, exch);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadChain(exp: string) {
    stopLiveFeed();
    cellMapRef.current.clear();
    setLoading(true);
    setError(null);
    currentExpRef.current = exp;
    try {
      const data = await fetchChainApi(currentSymRef.current, currentExchRef.current, exp);
      setChain(data.chain || null);
      const cp = data.chain?.cp ?? data.chain?.currentprice;
      if (cp) setSpot(Number(cp) / 100);
      startLiveFeed(currentSymRef.current, exp, currentExchRef.current);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Incremental DOM cell update -- avoids full React re-render on every tick
  function updateCells(data: OptionChainData) {
    const ceList = data.ce || [];
    const peList = data.pe || [];
    const cp = data.cp ?? data.currentprice;
    if (cp) setSpot(Number(cp) / 100);

    for (const ce of ceList) {
      const sp = strikeRs(ce);
      setCellHtml(`${sp}-ce-ltp`,   ltpHtml(ce, 'ce'));
      setCellHtml(`${sp}-ce-oi`,    fmtLakh(g(ce, 'oi')));
      setCellHtml(`${sp}-ce-vol`,   fmtLakh(g(ce, 'volume')));
      setCellHtml(`${sp}-ce-iv`,    fmtDec(g(ce, 'iv'), 2));
      setCellHtml(`${sp}-ce-delta`, fmtDec(g(ce, 'delta'), 4));
      setCellHtml(`${sp}-ce-gamma`, fmtDec(g(ce, 'gamma'), 4));
      setCellHtml(`${sp}-ce-theta`, fmtDec(g(ce, 'theta'), 2));
      setCellHtml(`${sp}-ce-vega`,  fmtDec(g(ce, 'vega'), 4));
    }
    for (const pe of peList) {
      const sp = strikeRs(pe);
      setCellHtml(`${sp}-pe-ltp`,   ltpHtml(pe, 'pe'));
      setCellHtml(`${sp}-pe-oi`,    fmtLakh(g(pe, 'oi')));
      setCellHtml(`${sp}-pe-vol`,   fmtLakh(g(pe, 'volume')));
      setCellHtml(`${sp}-pe-iv`,    fmtDec(g(pe, 'iv'), 2));
      setCellHtml(`${sp}-pe-delta`, fmtDec(g(pe, 'delta'), 4));
      setCellHtml(`${sp}-pe-gamma`, fmtDec(g(pe, 'gamma'), 4));
      setCellHtml(`${sp}-pe-theta`, fmtDec(g(pe, 'theta'), 2));
      setCellHtml(`${sp}-pe-vega`,  fmtDec(g(pe, 'vega'), 4));
    }
  }

  function setCellHtml(key: string, html: string) {
    const td = cellMapRef.current.get(key);
    if (td && td.innerHTML !== html) td.innerHTML = html;
  }

  function ltpHtml(row: OptionLeg, _side: string): string {
    const ltp = g(row, 'ltp');
    if (ltp == null) return '—';
    const price = ltp / 100;
    const chg   = g(row, 'ltpchg');
    const up    = chg == null ? true : chg >= 0;
    const pct   = chg != null ? `<div style="font-size:10px;color:${up?'var(--green)':'var(--red)'}">${up?'+':''}${chg.toFixed(2)}%</div>` : '';
    return `₹${fmtPrice(price)}${pct}`;
  }

  function fmtDec(v: number | null, dp: number): string {
    return v == null ? '—' : v.toFixed(dp);
  }

  // Suggestions search
  function onSymInput(e: React.ChangeEvent<HTMLInputElement>) {
    setSymInput(e.target.value);
    if (sugTimerRef.current) clearTimeout(sugTimerRef.current);
    const q = e.target.value.trim();
    if (q.length < 1) { setSuggestions([]); setShowSug(false); return; }
    sugTimerRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=10`);
        const data = await res.json() as { results: Instrument[] };
        const items = (data.results || []).filter((it) => (it.derivative_type || '').toUpperCase() !== 'OPT');
        setSuggestions(items.slice(0, 8));
        setShowSug(true);
      } catch { /* ignore */ }
    }, 200);
  }

  function selectSuggestion(item: Instrument) {
    const sym = getSymbol(item).toUpperCase();
    setSymInput(sym);
    setSymbol(sym);
    setExchange(item.exchange || 'NSE');
    setSuggestions([]);
    setShowSug(false);
    loadExpiryThenChain(sym, item.exchange || 'NSE');
  }

  async function navigateToChart(strike: number, optType: 'CE' | 'PE') {
    if (!onNavigateToChart) return;
    try {
      const q   = `${symbol}${strike}${optType}`;
      const res  = await fetch(`/api/instruments/search?q=${encodeURIComponent(q)}&limit=50`);
      const data = await res.json() as { results: Instrument[] };
      const match = (data.results || []).find((it) => {
        if ((it.derivative_type || '').toUpperCase() !== 'OPT') return false;
        if ((it.option_type || '').toUpperCase() !== optType) return false;
        const itemExpiry = String(it.expiry ?? '');
        if (currentExpRef.current && itemExpiry && itemExpiry !== currentExpRef.current) return false;
        const sp = Number(it.strike_price);
        return sp === strike || sp === strike * 100 || Math.round(sp / 100) === strike;
      });
      if (match) { onNavigateToChart(match); return; }
    } catch { /* fallback */ }
    // Fallback construct
    const exp  = currentExpRef.current;
    const yr   = exp.slice(2, 4);
    const mo   = exp.length >= 6 ? MONTHS[parseInt(exp.slice(4, 6)) - 1] : '';
    const name = `${symbol}${yr}${mo}${strike}${optType}`;
    onNavigateToChart({ stock_name: name, nubra_name: name, exchange: currentExchRef.current, derivative_type: 'OPT' });
  }

  // Render chain table rows
  const renderRows = () => {
    if (!chain) return null;
    const ceList = chain.ce || [];
    const peList = chain.pe || [];
    const map: Record<number, { ce: OptionLeg | null; pe: OptionLeg | null }> = {};
    for (const ce of ceList) {
      const sp = strikeRs(ce);
      if (!map[sp]) map[sp] = { ce: null, pe: null };
      map[sp].ce = ce;
    }
    for (const pe of peList) {
      const sp = strikeRs(pe);
      if (!map[sp]) map[sp] = { ce: null, pe: null };
      map[sp].pe = pe;
    }
    const strikes = Object.keys(map).map(Number).sort((a, b) => a - b);
    maxCeOiRef.current = Math.max(1, ...ceList.map((c) => g(c, 'oi') || 0));
    maxPeOiRef.current = Math.max(1, ...peList.map((p) => g(p, 'oi') || 0));

    const chainCp  = chain.cp ?? chain.currentprice;
    const refPrice = spot ?? (chainCp ? chainCp / 100 : null) ?? (chain.atm ? chain.atm / 100 : null);
    const atm = refPrice != null
      ? strikes.reduce((b, s) => Math.abs(s - refPrice) < Math.abs(b - refPrice) ? s : b, strikes[0])
      : null;

    // Register cell refs after render via callback ref
    const registerCell = (sp: number, key: string) => (el: HTMLTableCellElement | null) => {
      if (el) cellMapRef.current.set(`${sp}-${key}`, el);
    };

    return strikes.map((sp) => {
      const { ce, pe } = map[sp];
      const isAtm = sp === atm;
      const ceOi  = g(ce, 'oi') || 0;
      const peOi  = g(pe, 'oi') || 0;

      return (
        <tr key={sp} className={isAtm ? 'atm-row' : ''} data-strike={sp}>
          {/* CE Greeks */}
          <td ref={registerCell(sp,'ce-vega')}  className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'vega'), 4) : '—'}</td>
          <td ref={registerCell(sp,'ce-gamma')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'gamma'), 4) : '—'}</td>
          <td ref={registerCell(sp,'ce-theta')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'theta'), 2) : '—'}</td>
          <td ref={registerCell(sp,'ce-delta')} className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtDec(g(ce, 'delta'), 4) : '—'}</td>
          {/* CE OI */}
          <td ref={registerCell(sp,'ce-oi')} className="ce-side text-right px-2 py-1.5 text-[12px]">
            {ce ? <><div>{fmtLakh(g(ce, 'oi'))}</div><div className="oi-bar-wrap"><div className="oi-bar oi-bar-ce" style={{ width: `${Math.min(100, (ceOi / maxCeOiRef.current) * 100)}%` }} /></div></> : '—'}
          </td>
          <td ref={registerCell(sp,'ce-vol')}   className="ce-side text-right px-2 py-1.5 text-[12px]">{ce ? fmtLakh(g(ce, 'volume')) : '—'}</td>
          {/* CE LTP */}
          <td
            ref={registerCell(sp,'ce-ltp')}
            className="ce-side ltp-cell text-right px-2 py-1.5 text-[12px] cursor-pointer font-semibold"
            onClick={() => navigateToChart(sp, 'CE')}
            dangerouslySetInnerHTML={{ __html: ce ? ltpHtml(ce, 'ce') : '—' }}
          />
          {/* Strike / IV */}
          <td className="strike-cell text-center px-2 py-1.5 text-[13px] font-bold relative">
            {isAtm && <span className="absolute top-0.5 left-1/2 -translate-x-1/2 text-[9px] font-semibold text-yellow-400 tracking-wide">ATM</span>}
            {sp.toLocaleString('en-IN')}
          </td>
          <td ref={registerCell(sp,'ce-iv')} className="iv-cell text-center px-2 py-1.5 text-[11px]">{ce ? fmtDec(g(ce, 'iv'), 2) : '—'}</td>
          {/* PE LTP */}
          <td
            ref={registerCell(sp,'pe-ltp')}
            className="pe-side ltp-cell text-right px-2 py-1.5 text-[12px] cursor-pointer font-semibold"
            onClick={() => navigateToChart(sp, 'PE')}
            dangerouslySetInnerHTML={{ __html: pe ? ltpHtml(pe, 'pe') : '—' }}
          />
          <td ref={registerCell(sp,'pe-vol')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtLakh(g(pe, 'volume')) : '—'}</td>
          {/* PE OI */}
          <td ref={registerCell(sp,'pe-oi')} className="pe-side text-right px-2 py-1.5 text-[12px]">
            {pe ? <><div>{fmtLakh(g(pe, 'oi'))}</div><div className="oi-bar-wrap"><div className="oi-bar oi-bar-pe" style={{ width: `${Math.min(100, (peOi / maxPeOiRef.current) * 100)}%` }} /></div></> : '—'}
          </td>
          <td ref={registerCell(sp,'pe-delta')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'delta'), 4) : '—'}</td>
          <td ref={registerCell(sp,'pe-theta')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'theta'), 2) : '—'}</td>
          <td ref={registerCell(sp,'pe-gamma')} className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'gamma'), 4) : '—'}</td>
          <td ref={registerCell(sp,'pe-vega')}  className="pe-side text-right px-2 py-1.5 text-[12px]">{pe ? fmtDec(g(pe, 'vega'), 4) : '—'}</td>
        </tr>
      );
    });
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-12 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 overflow-x-auto shrink-0">
        {/* Quick picks */}
        <div className="flex gap-1 shrink-0">
          {QUICK_PICKS.map(({ sym, exch }) => (
            <button
              key={sym}
              onClick={() => {
                setActiveQuick(sym);
                setSymInput(sym);
                setSymbol(sym);
                setExchange(exch);
                loadExpiryThenChain(sym, exch);
              }}
              className={`px-2.5 py-1 rounded text-[12px] font-semibold border transition-all ${
                activeQuick === sym
                  ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                  : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {sym}
            </button>
          ))}
        </div>
        <div className="w-px h-5 bg-[var(--border)] shrink-0 mx-1" />

        {/* Symbol input with suggestions */}
        <div className="relative shrink-0">
          <input
            type="text"
            value={symInput}
            onChange={onSymInput}
            onKeyDown={(e) => { if (e.key === 'Enter') { setSymbol(symInput.toUpperCase()); loadExpiryThenChain(symInput.toUpperCase(), exchange); } if (e.key === 'Escape') setShowSug(false); }}
            placeholder="Symbol"
            className="w-[110px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none focus:border-[var(--accent)]"
          />
          {showSug && suggestions.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-[200px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg shadow-2xl z-50 max-h-[240px] overflow-y-auto">
              {suggestions.map((it, i) => (
                <div
                  key={i}
                  onMouseDown={(e) => { e.preventDefault(); selectSuggestion(it); }}
                  className="flex justify-between items-center px-3 py-2 cursor-pointer hover:bg-[var(--bg-hover)] text-[13px] border-b border-[var(--border)]/50 last:border-0"
                >
                  <span className="font-semibold text-[var(--text-primary)]">{getSymbol(it).toUpperCase()}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-400">{it.exchange}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <select
          value={exchange}
          onChange={(e) => setExchange(e.target.value)}
          className="px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none"
        >
          <option value="NSE">NSE</option>
          <option value="BSE">BSE</option>
        </select>

        <select
          value={expiry}
          onChange={(e) => { setExpiry(e.target.value); loadChain(e.target.value); }}
          className="w-[130px] px-2 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-primary)] text-[12px] focus:outline-none"
        >
          {expiries.map((exp) => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
        </select>

        <button
          onClick={() => loadExpiryThenChain(symInput.toUpperCase() || symbol, exchange)}
          className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[12px] font-semibold hover:bg-[var(--accent-dim)] transition-colors shrink-0"
        >
          Load
        </button>

        {spot && (
          <div className="ml-auto text-[13px] font-semibold text-[var(--text-primary)] shrink-0">
            Spot: <span className="text-[var(--accent)]">₹{fmtPrice(spot)}</span>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto bg-[var(--bg-primary)]">
        {loading && <div className="flex items-center justify-center h-40 text-[var(--text-secondary)] text-[14px]">Loading...</div>}
        {error   && <div className="flex items-center justify-center h-40 text-[var(--red)] text-[14px]">{error}</div>}
        {!loading && !error && (
          <table className="oc-table w-full text-[12px] border-collapse" style={{ tableLayout: 'fixed' }}>
            <thead>
              <tr className="sticky top-0 z-10">
                <th colSpan={7} className="oc-calls-th text-center py-1.5 text-[13px] font-bold">Calls</th>
                <th colSpan={2} className="bg-[var(--bg-card)] border-b-2 border-[var(--border)]" />
                <th colSpan={7} className="oc-puts-th text-center py-1.5 text-[13px] font-bold">Puts</th>
              </tr>
              <tr className="sticky top-8 z-10 bg-[var(--bg-secondary)]">
                {['Vega','Gamma','Theta','Delta','OI (L)','Vol (L)','LTP'].map((h) => (
                  <th key={h} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                ))}
                <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">Strike</th>
                <th className="text-center px-2 py-1.5 text-[11px] font-medium text-[var(--text-secondary)] border-b border-[var(--border)] bg-[var(--bg-card)]">IV</th>
                {['LTP','Vol (L)','OI (L)','Delta','Theta','Gamma','Vega'].map((h) => (
                  <th key={h} className="text-right px-2 py-1.5 text-[11px] font-medium text-[var(--text-muted)] border-b border-[var(--border)] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{renderRows()}</tbody>
          </table>
        )}
        {!loading && !error && !chain && (
          <div className="flex items-center justify-center h-40 text-[var(--text-muted)] text-[14px]">
            Select a symbol and click Load
          </div>
        )}
      </div>
    </div>
  );
}

async function fetchChainApi(symbol: string, exchange: string, expiry: string): Promise<{ chain?: OptionChainData }> {
  const params = new URLSearchParams({ exchange });
  if (expiry) params.set('expiry', expiry);
  const res  = await fetch(`/api/optionchain/${encodeURIComponent(symbol)}?${params}`);
  const data = await res.json() as { chain?: OptionChainData; error?: string };
  if (data.error) throw new Error(data.error);
  return data;
}


