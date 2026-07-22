import React, { useState, useRef, useImperativeHandle, memo, forwardRef } from 'react';

function fmtPrice(p: number) {
  return p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface PriceTooltipRef {
  setData: (timeStr: string, ohlc: any, legPrices: any[], underlying: string) => void;
  setPosition: (x: number, y: number) => void;
  setVisibility: (visible: boolean) => void;
}

export const PriceTooltip = memo(forwardRef<PriceTooltipRef, {}>((props, ref) => {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState({timeStr: '', ohlc: null as any, legPrices: [] as any[], underlying: ''});

  useImperativeHandle(ref, () => ({
    setData: (timeStr, ohlc, legPrices, underlying) => setData({timeStr, ohlc, legPrices, underlying}),
    setPosition: (x, y) => {
      if (containerRef.current) {
        containerRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    },
    setVisibility: (v) => setVisible(v)
  }));

  const { timeStr, ohlc, legPrices, underlying } = data;

  return (
    <div ref={containerRef} className="absolute z-50 pointer-events-none top-0 left-0" style={{ display: visible && (ohlc || legPrices.length > 0) ? 'block' : 'none' }}>
      <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]">
        {timeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">{timeStr}</div>}
        {ohlc && (
          <div className="text-[11px] mb-1">
            <span className="text-[#fbbf24] font-semibold mr-2">{underlying}</span>
            <span className="text-[var(--text-muted)]">O</span> <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.o)}</span>
            {' '}<span className="text-[var(--text-muted)]">H</span> <span className="text-[var(--green)]">{fmtPrice(ohlc.h)}</span>
            {' '}<span className="text-[var(--text-muted)]">L</span> <span className="text-[var(--red)]">{fmtPrice(ohlc.l)}</span>
            {' '}<span className="text-[var(--text-muted)]">C</span> <span className={ohlc.c >= ohlc.o ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{fmtPrice(ohlc.c)}</span>
          </div>
        )}
        {legPrices.map(l => (
          <div key={l.name} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              <span className="truncate max-w-[120px]">{l.name}</span>
            </span>
            <span className="text-[var(--text-primary)] font-medium tabular-nums">₹{fmtPrice(l.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}));

export interface PnlTooltipRef {
  setData: (timeStr: string, values: { legs: any[], total: number } | null) => void;
  setPosition: (x: number, y: number) => void;
  setVisibility: (visible: boolean) => void;
}

export const PnlTooltip = memo(forwardRef<PnlTooltipRef, { strategyMargin: number }>((props, ref) => {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState({timeStr: '', values: null as any});

  useImperativeHandle(ref, () => ({
    setData: (timeStr, values) => setData({timeStr, values}),
    setPosition: (x, y) => {
      if (containerRef.current) {
        containerRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    },
    setVisibility: (v) => setVisible(v)
  }));

  const { timeStr, values } = data;

  return (
    <div ref={containerRef} className="absolute z-50 pointer-events-none top-0 left-0" style={{ display: visible && values ? 'block' : 'none' }}>
      <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md min-w-[190px]">
        {timeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-1.5 font-mono tracking-wide">{timeStr}</div>}
        {values && values.legs.map((l: any) => (
          <div key={l.name} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
            <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              <span className="truncate max-w-[120px]">{l.name}</span>
            </span>
            <span className={`font-medium tabular-nums ${l.value >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
              {l.value >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(l.value))}
            </span>
          </div>
        ))}
        {values && (
          <>
            <div className="flex items-center justify-between gap-4 text-[11px] pt-1 mt-1 border-t border-[#ffffff0a] font-semibold">
              <span className="text-[var(--text-secondary)]">Total P&L</span>
              <span className={values.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}>
                {values.total >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(values.total))}
              </span>
            </div>
            {props.strategyMargin > 0 && (
              <>
                <div className="flex items-center justify-between gap-4 text-[11px] pt-0.5">
                  <span className="text-[var(--text-muted)]">Margin</span>
                  <span className="text-[var(--text-secondary)] tabular-nums">₹{fmtPrice(props.strategyMargin)}</span>
                </div>
                <div className="flex items-center justify-between gap-4 text-[11px] pt-0.5">
                  <span className="text-[var(--text-muted)]">ROI</span>
                  <span className={`font-medium tabular-nums ${values.total >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                    {((values.total) / props.strategyMargin * 100).toFixed(2)}%
                  </span>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}));

export interface GreeksTooltipRef {
  setData: (timeStr: string, values: Record<string, any> | null) => void;
  setPosition: (x: number, y: number) => void;
  setVisibility: (visible: boolean) => void;
}

export const GreeksTooltip = memo(forwardRef<GreeksTooltipRef, { selectedGreeks: Set<string>, greeksLegFilter: Set<string>, colors: Record<string, string> }>((props, ref) => {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState({timeStr: '', values: null as any});

  useImperativeHandle(ref, () => ({
    setData: (timeStr, values) => setData({timeStr, values}),
    setPosition: (x, y) => {
      if (containerRef.current) {
        containerRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
    },
    setVisibility: (v) => setVisible(v)
  }));

  const { timeStr, values } = data;
  const { selectedGreeks, greeksLegFilter, colors } = props;

  const show = visible && values && Object.keys(values).length > 0;
  return (
    <div ref={containerRef} className="absolute z-50 pointer-events-none top-0 left-0" style={{ display: show ? 'block' : 'none' }}>
      <div className="bg-[#1a1e24]/75 border border-[#ffffff08] rounded-lg px-3 py-2 shadow-xl backdrop-blur-md">
        {timeStr && <div className="text-[10px] text-[var(--text-muted)] border-b border-[#ffffff0a] pb-1 mb-2 font-mono tracking-wide">{timeStr}</div>}
        {values && (
          greeksLegFilter.size > 1 ? (
            <table className="w-full text-left border-collapse text-[10px]">
              <thead>
                <tr className="border-b border-[#ffffff0a] text-[var(--text-muted)]">
                  <th className="font-normal pb-1">Src</th>
                  {['delta', 'gamma', 'theta', 'vega'].map(h => selectedGreeks.has(h) && (
                    <th key={h} className="text-right font-normal pb-1 px-1">
                      {h === 'delta' ? 'Δ' : h === 'gamma' ? 'Γ' : h === 'theta' ? 'Θ' : 'V'}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(['net', 'CE', 'PE'] as const).map(src => {
                  const d = values?.[src];
                  if (!d) return null;
                  const label = src === 'net' ? 'Net' : `${src} Leg`;
                  return (
                    <tr key={src} className="border-b border-[#ffffff05] last:border-0">
                      <td className="py-1 font-semibold text-[#a78bfa]">{label}</td>
                      {['delta', 'gamma', 'theta', 'vega'].map(k => {
                        if (!selectedGreeks.has(k)) return null;
                        const val = d[k] ?? 0;
                        const formatted = k === 'gamma' ? val.toFixed(4) : val.toFixed(2);
                        return (
                          <td key={k} className={`text-right font-semibold py-1 px-1 font-mono ${val >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                            {val >= 0 ? '+' : ''}{formatted}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {Array.from(greeksLegFilter).map(refId => {
                  if (refId === 'net' || refId === 'CE' || refId === 'PE') return null;
                  const d = values?.[refId];
                  if (!d) return null;
                  return (
                    <tr key={refId} className="border-b border-[#ffffff05] last:border-0">
                      <td className="py-1 font-semibold text-[#a78bfa]">Leg {refId.slice(0,4)}</td>
                      {['delta', 'gamma', 'theta', 'vega'].map(k => {
                        if (!selectedGreeks.has(k)) return null;
                        const val = d[k] ?? 0;
                        const formatted = k === 'gamma' ? val.toFixed(4) : val.toFixed(2);
                        return (
                          <td key={k} className={`text-right font-semibold py-1 px-1 font-mono ${val >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                            {val >= 0 ? '+' : ''}{formatted}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            (() => {
              const activeSrc = Array.from(greeksLegFilter)[0] || 'net';
              const d = values?.[activeSrc] || { delta: 0, gamma: 0, theta: 0, vega: 0 };
              return (['delta', 'gamma', 'theta', 'vega'] as const).filter(k => selectedGreeks.has(k) && d[k] != null).map(k => {
                const val = d[k] ?? 0;
                const formatted = k === 'gamma' ? val.toFixed(4) : val.toFixed(2);
                return (
                  <div key={k} className="flex items-center justify-between gap-4 text-[11px] py-0.5">
                    <span className="flex items-center gap-1.5 text-[var(--text-secondary)]">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors[k] }} />
                      {k.charAt(0).toUpperCase() + k.slice(1)}
                    </span>
                    <span className={`font-semibold tabular-nums ${val >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                      {val >= 0 ? '+' : ''}{formatted}
                    </span>
                  </div>
                );
              });
            })()
          )
        )}
      </div>
    </div>
  );
}));
