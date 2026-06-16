import { useEffect, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { fmtPrice, formatExpiry } from './lib/utils';

interface ChainRow {
  sp:   number;
  ceLtp: number | null;
  peLtp: number | null;
  straddle: number | null;
  iv:   number | null;
}

interface Props {
  instrument: Instrument | null;
}

export default function StraddleChart({ instrument }: Props) {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selExpiry, setSelExpiry] = useState('');
  const [rows,  setRows]    = useState<ChainRow[]>([]);
  const [spot,  setSpot]    = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [mode, setMode] = useState<'straddle' | 'iv_skew'>('straddle');

  const sym = instrument ? getSymbol(instrument) : null;

  useEffect(() => {
    if (!sym) return;
    loadExpiries(sym, instrument!.exchange || 'NSE');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym]);

  async function loadExpiries(sym: string, exch: string) {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?exchange=${exch}`);
      const data = await res.json() as { chain?: { all_expiries?: string[]; cp?: number } };
      const exps = data.chain?.all_expiries || [];
      setExpiries(exps);
      if (exps.length) {
        setSelExpiry(exps[0]);
        await loadChain(sym, exch, exps[0], data.chain?.cp);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function loadChain(sym: string, exch: string, expiry: string, cpRaw?: number) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ exchange: exch, expiry });
      const res    = await fetch(`/api/optionchain/${encodeURIComponent(sym)}?${params}`);
      const data   = await res.json() as {
        chain?: {
          ce?: Array<Record<string,unknown>>;
          pe?: Array<Record<string,unknown>>;
          cp?: number;
        }
      };
      const chain = data.chain;
      if (!chain) return;

      const spotVal = cpRaw ?? chain.cp;
      if (spotVal) setSpot(Number(spotVal) / 100);

      const ceList = chain.ce || [];
      const peList = chain.pe || [];
      const map: Record<number, ChainRow> = {};

      for (const ce of ceList) {
        const sp  = Number(ce.sp) > 10000 ? Number(ce.sp) / 100 : Number(ce.sp);
        const ltp = ce.ltp != null ? Number(ce.ltp) / 100 : null;
        const iv  = ce.iv  != null ? Number(ce.iv) : null;
        if (!map[sp]) map[sp] = { sp, ceLtp: null, peLtp: null, straddle: null, iv: null };
        map[sp].ceLtp = ltp;
        map[sp].iv    = iv;
      }
      for (const pe of peList) {
        const sp  = Number(pe.sp) > 10000 ? Number(pe.sp) / 100 : Number(pe.sp);
        const ltp = pe.ltp != null ? Number(pe.ltp) / 100 : null;
        if (!map[sp]) map[sp] = { sp, ceLtp: null, peLtp: null, straddle: null, iv: null };
        map[sp].peLtp = ltp;
        if (map[sp].ceLtp != null && ltp != null) map[sp].straddle = map[sp].ceLtp! + ltp;
      }

      const sorted = Object.values(map).sort((a, b) => a.sp - b.sp);
      setRows(sorted);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const chartData = rows.map((r) => ({
    strike:   r.sp,
    straddle: r.straddle,
    CE_LTP:   r.ceLtp,
    PE_LTP:   r.peLtp,
    IV:       r.iv,
  }));

  const dataKey  = mode === 'straddle' ? 'straddle' : 'IV';
  const yLabel   = mode === 'straddle' ? 'Premium (₹)' : 'IV (%)';

  if (!instrument) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[14px]">
        Select an F&O instrument to view straddle chart
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="font-bold text-[var(--text-primary)]">{sym}</span>
        {spot && <span className="text-[var(--accent)] text-[13px]">Spot ₹{fmtPrice(spot)}</span>}

        <select
          value={selExpiry}
          onChange={(e) => {
            setSelExpiry(e.target.value);
            loadChain(sym!, instrument!.exchange || 'NSE', e.target.value);
          }}
          className="px-2 py-0.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none ml-2"
        >
          {expiries.map((exp) => <option key={exp} value={exp}>{formatExpiry(exp)}</option>)}
        </select>

        <div className="flex gap-1 ml-2">
          {(['straddle', 'iv_skew'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-0.5 rounded text-[12px] font-medium transition-all ${
                mode === m ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {m === 'straddle' ? 'Straddle Premium' : 'IV Skew'}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="flex-1 p-4">
        {loading && <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading…</div>}
        {error   && <div className="flex items-center justify-center h-full text-[var(--red)]">{error}</div>}
        {!loading && !error && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="strike"
                tickFormatter={(v) => v.toLocaleString('en-IN')}
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                label={{ value: 'Strike', position: 'insideBottom', offset: -5, fill: 'var(--text-secondary)', fontSize: 11 }}
              />
              <YAxis
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => `Strike: ₹${v}`}
                formatter={(v: number, name: string) => [v?.toFixed(2), name]}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
              {spot && <ReferenceLine x={spot} stroke="var(--accent)" strokeDasharray="4 4" label={{ value: 'Spot', fill: 'var(--accent)', fontSize: 11 }} />}
              {mode === 'straddle' ? (
                <Line type="monotone" dataKey={dataKey} stroke="#2962ff" dot={false} strokeWidth={2} name="Straddle Premium" connectNulls />
              ) : (
                <Line type="monotone" dataKey="IV" stroke="#f59e0b" dot={false} strokeWidth={2} name="IV %" connectNulls />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
