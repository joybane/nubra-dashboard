import { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import type { Instrument } from './types';
import { getSymbol } from './types';
import { payoffAtExpiry } from './lib/GexService';
import { fmtPrice, generateId } from './lib/utils';

interface Leg {
  id:      string;
  type:    'CE' | 'PE';
  side:    'BUY' | 'SELL';
  strike:  number;
  premium: number;
  qty:     number;
}

interface Props {
  instrument: Instrument | null;
}

const TEMPLATES: { label: string; legs: Omit<Leg,'id'>[] }[] = [
  {
    label: 'Bull Call Spread',
    legs: [
      { type: 'CE', side: 'BUY',  strike: 22000, premium: 200, qty: 1 },
      { type: 'CE', side: 'SELL', strike: 22500, premium: 80,  qty: 1 },
    ],
  },
  {
    label: 'Bear Put Spread',
    legs: [
      { type: 'PE', side: 'BUY',  strike: 22000, premium: 150, qty: 1 },
      { type: 'PE', side: 'SELL', strike: 21500, premium: 60,  qty: 1 },
    ],
  },
  {
    label: 'Long Straddle',
    legs: [
      { type: 'CE', side: 'BUY', strike: 22000, premium: 200, qty: 1 },
      { type: 'PE', side: 'BUY', strike: 22000, premium: 150, qty: 1 },
    ],
  },
  {
    label: 'Short Straddle',
    legs: [
      { type: 'CE', side: 'SELL', strike: 22000, premium: 200, qty: 1 },
      { type: 'PE', side: 'SELL', strike: 22000, premium: 150, qty: 1 },
    ],
  },
  {
    label: 'Iron Condor',
    legs: [
      { type: 'PE', side: 'BUY',  strike: 21000, premium: 30,  qty: 1 },
      { type: 'PE', side: 'SELL', strike: 21500, premium: 80,  qty: 1 },
      { type: 'CE', side: 'SELL', strike: 22500, premium: 80,  qty: 1 },
      { type: 'CE', side: 'BUY',  strike: 23000, premium: 30,  qty: 1 },
    ],
  },
];

export default function StrategyChart({ instrument }: Props) {
  const [legs, setLegs] = useState<Leg[]>([]);
  const [spot, setSpot] = useState(22000);

  const sym = instrument ? getSymbol(instrument) : 'Position';

  function addLeg() {
    setLegs((prev) => [
      ...prev,
      { id: generateId(), type: 'CE', side: 'BUY', strike: spot, premium: 0, qty: 1 },
    ]);
  }

  function removeLeg(id: string) {
    setLegs((prev) => prev.filter((l) => l.id !== id));
  }

  function updateLeg(id: string, updates: Partial<Leg>) {
    setLegs((prev) => prev.map((l) => l.id === id ? { ...l, ...updates } : l));
  }

  function loadTemplate(tmpl: typeof TEMPLATES[0]) {
    setLegs(tmpl.legs.map((l) => ({ ...l, id: generateId() })));
  }

  // Build P&L curve
  const chartData = useMemo(() => {
    if (!legs.length) return [];
    const strikes = legs.map((l) => l.strike);
    const minS = Math.min(...strikes) * 0.85;
    const maxS = Math.max(...strikes) * 1.15;
    const step = (maxS - minS) / 100;
    return Array.from({ length: 101 }, (_, i) => {
      const s   = minS + i * step;
      const pnl = payoffAtExpiry(s, legs);
      return { spot: Math.round(s), pnl: Math.round(pnl * 100) / 100 };
    });
  }, [legs]);

  const maxProfit = chartData.length ? Math.max(...chartData.map((d) => d.pnl)) : 0;
  const maxLoss   = chartData.length ? Math.min(...chartData.map((d) => d.pnl)) : 0;
  const breakevenPoints = useMemo(() => {
    const bps: number[] = [];
    for (let i = 1; i < chartData.length; i++) {
      if ((chartData[i-1].pnl < 0 && chartData[i].pnl >= 0) || (chartData[i-1].pnl >= 0 && chartData[i].pnl < 0)) {
        bps.push(Math.round((chartData[i-1].spot + chartData[i].spot) / 2));
      }
    }
    return bps;
  }, [chartData]);

  if (!instrument) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[14px]">
        Select an instrument and build your strategy
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="h-10 bg-[var(--bg-secondary)] border-b border-[var(--border)] flex items-center gap-2 px-3 shrink-0">
        <span className="font-bold text-[var(--text-primary)]">{sym} — Strategy Builder</span>
        <span className="text-[var(--text-muted)] text-[12px]">
          Spot: ₹
          <input
            type="number"
            value={spot}
            onChange={(e) => setSpot(Number(e.target.value))}
            className="w-20 bg-transparent border-b border-[var(--border)] text-[var(--text-primary)] text-[12px] focus:outline-none focus:border-[var(--accent)] mx-1"
          />
        </span>
        <div className="flex gap-1 ml-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => loadTemplate(t)}
              className="px-2 py-0.5 rounded text-[11px] bg-[var(--bg-hover)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
            >
              {t.label}
            </button>
          ))}
        </div>
        <button onClick={addLeg} className="ml-auto px-3 py-1 rounded bg-[var(--accent)] text-white text-[12px] font-semibold hover:bg-[var(--accent-dim)]">
          + Add Leg
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Legs panel */}
        <div className="w-[340px] shrink-0 border-r border-[var(--border)] overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Strategy Legs</div>
          {legs.length === 0 && (
            <div className="text-[var(--text-muted)] text-[13px] text-center py-8">No legs yet. Add a leg or load a template.</div>
          )}
          {legs.map((leg) => (
            <div key={leg.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-2.5 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <select value={leg.side} onChange={(e) => updateLeg(leg.id, { side: e.target.value as 'BUY'|'SELL' })}
                  className="flex-1 px-1.5 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none">
                  <option value="BUY">BUY</option><option value="SELL">SELL</option>
                </select>
                <select value={leg.type} onChange={(e) => updateLeg(leg.id, { type: e.target.value as 'CE'|'PE' })}
                  className="flex-1 px-1.5 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none">
                  <option value="CE">CE</option><option value="PE">PE</option>
                </select>
                <button onClick={() => removeLeg(leg.id)} className="text-[var(--red)] hover:text-red-400 text-[14px] font-bold">✕</button>
              </div>
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="text-[10px] text-[var(--text-muted)]">Strike</span>
                  <input type="number" value={leg.strike} onChange={(e) => updateLeg(leg.id, { strike: Number(e.target.value) })}
                    className="w-full px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
                </label>
                <label className="flex-1">
                  <span className="text-[10px] text-[var(--text-muted)]">Premium</span>
                  <input type="number" value={leg.premium} onChange={(e) => updateLeg(leg.id, { premium: Number(e.target.value) })}
                    className="w-full px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
                </label>
                <label className="w-14">
                  <span className="text-[10px] text-[var(--text-muted)]">Qty</span>
                  <input type="number" min={1} value={leg.qty} onChange={(e) => updateLeg(leg.id, { qty: Number(e.target.value) })}
                    className="w-full px-2 py-0.5 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
                </label>
              </div>
              <div className={`text-[11px] font-semibold ${leg.side === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                {leg.side} {leg.qty}× {leg.strike}{leg.type} @ ₹{leg.premium}
              </div>
            </div>
          ))}

          {legs.length > 0 && (
            <div className="mt-2 p-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[12px] space-y-1">
              <div className="flex justify-between"><span className="text-[var(--text-muted)]">Max Profit</span><span className="text-green-400 font-semibold">{maxProfit === Infinity ? '∞' : `₹${fmtPrice(maxProfit)}`}</span></div>
              <div className="flex justify-between"><span className="text-[var(--text-muted)]">Max Loss</span><span className="text-red-400 font-semibold">{maxLoss === -Infinity ? '-∞' : `₹${fmtPrice(maxLoss)}`}</span></div>
              {breakevenPoints.map((bp) => (
                <div key={bp} className="flex justify-between"><span className="text-[var(--text-muted)]">Breakeven</span><span className="text-yellow-400 font-semibold">₹{bp.toLocaleString('en-IN')}</span></div>
              ))}
            </div>
          )}
        </div>

        {/* Payoff chart */}
        <div className="flex-1 p-4">
          {chartData.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-[13px]">Add strategy legs to see payoff diagram</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 30, left: 10, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="spot" tickFormatter={(v) => v.toLocaleString('en-IN')} tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                  label={{ value: 'Underlying at Expiry', position: 'insideBottom', offset: -10, fill: 'var(--text-secondary)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                  label={{ value: 'P&L (₹)', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 11 }} />
                <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(v) => `Spot: ₹${v}`} formatter={(v: number) => [`₹${fmtPrice(v)}`, 'P&L']} />
                <ReferenceLine y={0} stroke="var(--border)" strokeWidth={2} />
                <ReferenceLine x={spot} stroke="var(--accent)" strokeDasharray="4 4"
                  label={{ value: 'Current Spot', position: 'top', fill: 'var(--accent)', fontSize: 11 }} />
                {breakevenPoints.map((bp) => (
                  <ReferenceLine key={bp} x={bp} stroke="#facc15" strokeDasharray="4 4"
                    label={{ value: 'BE', position: 'top', fill: '#facc15', fontSize: 10 }} />
                ))}
                <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-secondary)' }} />
                <Line type="monotone" dataKey="pnl" stroke="#2962ff" dot={false} strokeWidth={2.5} name="Strategy P&L"
                  strokeOpacity={1}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
