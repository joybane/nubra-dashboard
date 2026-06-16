import { useState } from 'react';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { fmtPrice, generateId, formatExpiry } from './lib/utils';

interface Leg {
  id:         string;
  symbol:     string;
  optionType: 'CE' | 'PE';
  side:       'BUY' | 'SELL';
  strike:     number;
  expiry:     string;
  qty:        number;
  ltp:        number;
}

interface Props {
  instrument: Instrument | null;
}

export default function BasketOrder({ instrument }: Props) {
  const [legs, setLegs] = useState<Leg[]>([]);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [chainRows, setChainRows] = useState<{ strike: number; ceLtp: number; peLtp: number }[]>([]);
  const [placed, setPlaced] = useState<{ ok: boolean; msg: string } | null>(null);

  const sym = instrument ? getSymbol(instrument) : null;

  async function loadChain() {
    if (!sym) return;
    setLoading(true);
    setError(null);
    try {
      const exch = instrument!.exchange || 'NSE';
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; ce?: Array<Record<string,unknown>>; pe?: Array<Record<string,unknown>>; cp?: number } };
      const chain = data.chain;
      if (!chain) return;
      const exps = chain.all_expiries || [];
      setExpiries(exps);
      const firstExp = exps[0] || '';
      setExpiry(firstExp);
      buildChainRows(chain.ce || [], chain.pe || []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function changeExpiry(exp: string) {
    if (!sym) return;
    setExpiry(exp);
    setLoading(true);
    try {
      const exch = instrument!.exchange || 'NSE';
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}&expiry=${exp}`);
      const data = await res.json() as { chain?: { ce?: Array<Record<string,unknown>>; pe?: Array<Record<string,unknown>> } };
      if (data.chain) buildChainRows(data.chain.ce || [], data.chain.pe || []);
    } catch { /* ignore */ }
    setLoading(false);
  }

  function buildChainRows(ceList: Array<Record<string,unknown>>, peList: Array<Record<string,unknown>>) {
    const map: Record<number, { strike: number; ceLtp: number; peLtp: number }> = {};
    for (const ce of ceList) {
      const sp  = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
      const ltp = ce.ltp != null ? Number(ce.ltp) / 100 : 0;
      if (!map[sp]) map[sp] = { strike: sp, ceLtp: 0, peLtp: 0 };
      map[sp].ceLtp = ltp;
    }
    for (const pe of peList) {
      const sp  = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
      const ltp = pe.ltp != null ? Number(pe.ltp) / 100 : 0;
      if (!map[sp]) map[sp] = { strike: sp, ceLtp: 0, peLtp: 0 };
      map[sp].peLtp = ltp;
    }
    setChainRows(Object.values(map).sort((a, b) => a.strike - b.strike));
  }

  function addLeg(strike: number, optionType: 'CE' | 'PE', ltp: number) {
    setLegs((prev) => [
      ...prev,
      {
        id: generateId(),
        symbol: sym!,
        optionType,
        side: 'BUY',
        strike,
        expiry,
        qty: 1,
        ltp,
      },
    ]);
  }

  function removeLeg(id: string) { setLegs((prev) => prev.filter((l) => l.id !== id)); }
  function updateLeg(id: string, u: Partial<Leg>) { setLegs((prev) => prev.map((l) => l.id === id ? { ...l, ...u } : l)); }

  const totalPremium = legs.reduce((acc, l) => {
    const sign = l.side === 'BUY' ? -1 : 1;
    return acc + sign * l.ltp * l.qty;
  }, 0);

  function placeOrders() {
    // Simulate order placement (no live broker integration yet)
    setPlaced({ ok: true, msg: `${legs.length} order(s) queued. Connect broker API to place live orders.` });
    setTimeout(() => setPlaced(null), 5000);
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="font-bold text-[var(--text-primary)]">
          {sym ? `${sym} — Basket Orders` : 'Basket Orders'}
        </span>
        {sym && (
          <>
            <select
              value={expiry}
              onChange={(e) => changeExpiry(e.target.value)}
              className="px-2 py-0.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none ml-2"
            >
              {expiries.map((exp) => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
            </select>
            <button
              onClick={loadChain}
              disabled={loading}
              className="px-3 py-1 rounded bg-[var(--accent)] text-white text-[12px] font-semibold hover:bg-[var(--accent-dim)] disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load Chain'}
            </button>
          </>
        )}
      </div>

      {!instrument && (
        <div className="flex items-center justify-center flex-1 text-[var(--text-muted)] text-[14px]">
          Select an F&O instrument to build basket orders
        </div>
      )}

      {instrument && (
        <div className="flex flex-1 overflow-hidden">
          {/* Strike picker */}
          <div className="w-[320px] shrink-0 border-r border-[var(--border)] overflow-y-auto">
            <div className="sticky top-0 bg-[var(--bg-secondary)] border-b border-[var(--border)] px-3 py-1.5">
              <div className="grid grid-cols-4 text-[11px] font-medium text-[var(--text-muted)]">
                <span>Strike</span><span className="text-right">CE LTP</span><span className="text-right">PE LTP</span><span />
              </div>
            </div>
            {error && <div className="p-3 text-[var(--red)] text-[13px]">{error}</div>}
            {chainRows.map((row) => (
              <div key={row.strike} className="grid grid-cols-4 items-center px-3 py-1.5 border-b border-[var(--border)]/50 hover:bg-[var(--bg-hover)] text-[12px]">
                <span className="font-semibold text-[var(--text-primary)]">{row.strike.toLocaleString('en-IN')}</span>
                <button
                  onClick={() => addLeg(row.strike, 'CE', row.ceLtp)}
                  className="text-right text-green-400 hover:text-green-300 font-medium"
                >
                  {fmtPrice(row.ceLtp)}
                </button>
                <button
                  onClick={() => addLeg(row.strike, 'PE', row.peLtp)}
                  className="text-right text-red-400 hover:text-red-300 font-medium"
                >
                  {fmtPrice(row.peLtp)}
                </button>
                <div />
              </div>
            ))}
            {!loading && !error && chainRows.length === 0 && (
              <div className="p-4 text-[var(--text-muted)] text-center text-[13px]">Click "Load Chain" to view strikes</div>
            )}
          </div>

          {/* Basket */}
          <div className="relative flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-2">Basket Legs</div>
              {legs.length === 0 && (
                <div className="text-center py-10 text-[var(--text-muted)] text-[13px]">Click a CE/PE price to add a leg</div>
              )}
              {legs.map((leg) => (
                <div key={leg.id} className="flex items-center gap-2 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 mb-2">
                  <div className={`w-12 text-center py-0.5 rounded text-[11px] font-bold ${leg.optionType === 'CE' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                    {leg.optionType}
                  </div>
                  <span className="font-semibold text-[var(--text-primary)] text-[13px] w-16">{leg.strike.toLocaleString('en-IN')}</span>
                  <select
                    value={leg.side}
                    onChange={(e) => updateLeg(leg.id, { side: e.target.value as 'BUY'|'SELL' })}
                    className="px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none"
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                  <input
                    type="number"
                    min={1}
                    value={leg.qty}
                    onChange={(e) => updateLeg(leg.id, { qty: Number(e.target.value) })}
                    className="w-14 px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none text-center"
                  />
                  <span className="text-[var(--text-muted)] text-[12px]">@ ₹{fmtPrice(leg.ltp)}</span>
                  <span className={`ml-auto text-[12px] font-semibold ${leg.side === 'BUY' ? 'text-red-400' : 'text-green-400'}`}>
                    {leg.side === 'BUY' ? '-' : '+'}₹{fmtPrice(leg.ltp * leg.qty)}
                  </span>
                  <button onClick={() => removeLeg(leg.id)} className="text-[var(--text-muted)] hover:text-[var(--red)] ml-2">✕</button>
                </div>
              ))}
            </div>

            {/* Footer summary */}
            {legs.length > 0 && (
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 flex items-center gap-4">
                <div>
                  <span className="text-[11px] text-[var(--text-muted)]">Net Premium</span>
                  <div className={`text-[15px] font-bold ${totalPremium >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {totalPremium >= 0 ? '+' : ''}₹{fmtPrice(Math.abs(totalPremium))}
                  </div>
                </div>
                <div>
                  <span className="text-[11px] text-[var(--text-muted)]">Legs</span>
                  <div className="text-[15px] font-bold text-[var(--text-primary)]">{legs.length}</div>
                </div>
                <button
                  onClick={placeOrders}
                  className="ml-auto px-5 py-2 rounded-lg bg-[var(--accent)] text-white font-semibold text-[14px] hover:bg-[var(--accent-dim)] transition-colors"
                >
                  Place Orders
                </button>
                <button
                  onClick={() => setLegs([])}
                  className="px-3 py-2 rounded-lg bg-[var(--bg-hover)] text-[var(--text-secondary)] text-[12px] hover:text-[var(--text-primary)]"
                >
                  Clear
                </button>
              </div>
            )}

            {placed && (
              <div className={`absolute bottom-4 right-4 px-4 py-2.5 rounded-lg text-[13px] font-medium shadow-xl ${placed.ok ? 'bg-green-500/15 text-green-400 border border-green-500/30' : 'bg-red-500/15 text-red-400 border border-red-500/30'}`}>
                {placed.msg}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
