import { useCallback, useEffect, useRef, useState } from 'react';

interface Series {
  dataKey: string;
  color: string;
  strokeWidth?: number;
  dashed?: boolean;
  fill?: string;
}

interface RefLine {
  axis: 'x' | 'y';
  value: number;
  color?: string;
  dashed?: boolean;
  label?: string;
  labelColor?: string;
}

interface Props {
  data: Record<string, any>[];
  xKey: string;
  series: Series[];
  refLines?: RefLine[];
  xFormatter?: (v: number) => string;
  yFormatter?: (v: number) => string;
  tooltipFormatter?: (dataPoint: Record<string, number>) => string;
  xLabel?: string;
  yLabel?: string;
  showLegend?: boolean;
  legendLabels?: Record<string, string>;
  margin?: { top: number; right: number; bottom: number; left: number };
  gridColor?: string;
  bgColor?: string;
  axisColor?: string;
}

const DEFAULT_MARGIN = { top: 10, right: 20, bottom: 28, left: 56 };

export default function SvgChart({
  data, xKey, series, refLines, xFormatter, yFormatter, tooltipFormatter,
  xLabel, yLabel, showLegend, legendLabels, margin: marginProp, gridColor = '#1e2030',
  bgColor, axisColor = '#6b6f85',
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [hover, setHover] = useState<{ idx: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([e]) => {
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    obs.observe(containerRef.current);
    setSize({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
    return () => obs.disconnect();
  }, []);

  const m = { ...DEFAULT_MARGIN, ...marginProp };
  const legendH = showLegend ? 24 : 0;
  const plotW = size.w - m.left - m.right;
  const plotH = size.h - m.top - m.bottom - legendH;
  if (plotW <= 0 || plotH <= 0 || !data.length) {
    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
  }

  const xIsNumeric = typeof data[0]?.[xKey] === 'number';
  const xs = xIsNumeric ? data.map(d => d[xKey] as number) : data.map((_, i) => i);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const xRange = xMax - xMin || 1;

  let yMin = Infinity, yMax = -Infinity;
  for (const d of data) for (const s of series) {
    const v = d[s.dataKey];
    if (v != null) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
  }
  if (refLines) for (const r of refLines) {
    if (r.axis === 'y') { if (r.value < yMin) yMin = r.value; if (r.value > yMax) yMax = r.value; }
  }
  const yPad = (yMax - yMin) * 0.08 || 1;
  yMin -= yPad; yMax += yPad;
  const yRange = yMax - yMin || 1;

  const toX = (v: number) => m.left + ((v - xMin) / xRange) * plotW;
  const dataToX = (d: Record<string, any>, i: number) => toX(xIsNumeric ? d[xKey] : i);
  const toY = (v: number) => m.top + (1 - (v - yMin) / yRange) * plotH;

  // Ticks
  function niceStep(range: number, maxTicks: number): number {
    const rough = range / maxTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const res = rough / mag;
    if (res <= 1.5) return mag;
    if (res <= 3.5) return 2 * mag;
    if (res <= 7.5) return 5 * mag;
    return 10 * mag;
  }

  const xStep = niceStep(xRange, Math.max(4, Math.floor(plotW / 80)));
  const yStep = niceStep(yRange, Math.max(3, Math.floor(plotH / 50)));
  const xTicks: number[] = [];
  const yTicks: number[] = [];
  for (let v = Math.ceil(xMin / xStep) * xStep; v <= xMax; v += xStep) xTicks.push(v);
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) yTicks.push(v);

  const fmtX = xFormatter || ((v: any) => typeof v === 'number' ? v.toLocaleString('en-IN') : String(v));
  const fmtY = yFormatter || (v => v.toLocaleString('en-IN'));

  // Paths
  const paths = series.map(s => {
    const pts: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const v = data[i][s.dataKey];
      if (v == null) continue;
      pts.push(`${dataToX(data[i], i)},${toY(v)}`);
    }
    return { ...s, points: pts.join(' ') };
  });

  // Hover
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < m.left || mx > m.left + plotW) { setHover(null); return; }
    const ratio = (mx - m.left) / plotW;
    const idx = Math.round(ratio * (data.length - 1));
    const clamped = Math.max(0, Math.min(data.length - 1, idx));
    const d = data[clamped];
    const firstSeries = series[0];
    const cy = toY(d[firstSeries.dataKey] ?? 0);
    setHover({ idx: clamped, cx: dataToX(d, clamped), cy });
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <svg
        width={size.w} height={size.h}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHover(null)}
        style={{ display: 'block' }}
      >
        {bgColor && <rect width={size.w} height={size.h} fill={bgColor} />}

        {/* Grid */}
        {yTicks.map(v => (
          <line key={`gy${v}`} x1={m.left} x2={m.left + plotW} y1={toY(v)} y2={toY(v)} stroke={gridColor} strokeDasharray="3 3" />
        ))}
        {xTicks.map(v => (
          <line key={`gx${v}`} x1={toX(v)} x2={toX(v)} y1={m.top} y2={m.top + plotH} stroke={gridColor} strokeDasharray="3 3" />
        ))}

        {/* Reference lines */}
        {refLines?.map((r, i) => {
          if (r.axis === 'y') {
            const y = toY(r.value);
            if (y < m.top || y > m.top + plotH) return null;
            return <g key={`ref${i}`}>
              <line x1={m.left} x2={m.left + plotW} y1={y} y2={y} stroke={r.color || '#2a2d42'} strokeWidth={1} strokeDasharray={r.dashed ? '4 4' : undefined} />
              {r.label && <text x={m.left + plotW - 4} y={y - 4} textAnchor="end" fill={r.labelColor || r.color || axisColor} fontSize={10}>{r.label}</text>}
            </g>;
          }
          const x = toX(r.value);
          if (x < m.left || x > m.left + plotW) return null;
          return <g key={`ref${i}`}>
            <line x1={x} x2={x} y1={m.top} y2={m.top + plotH} stroke={r.color || '#5865f2'} strokeWidth={1} strokeDasharray={r.dashed ? '4 4' : undefined} />
            {r.label && <text x={x + 4} y={m.top + 12} fill={r.labelColor || r.color || '#5865f2'} fontSize={10}>{r.label}</text>}
          </g>;
        })}

        {/* Series fills */}
        {paths.map(p => p.fill && p.points.length > 0 && (
          <polygon
            key={`fill_${p.dataKey}`}
            points={`${dataToX(data[0], 0)},${toY(0)} ${p.points} ${dataToX(data[data.length - 1], data.length - 1)},${toY(0)}`}
            fill={p.fill}
          />
        ))}

        {/* Series lines */}
        {paths.map(p => (
          <polyline
            key={`line_${p.dataKey}`}
            points={p.points}
            fill="none"
            stroke={p.color}
            strokeWidth={p.strokeWidth || 2}
            strokeDasharray={p.dashed ? '6 3' : undefined}
          />
        ))}

        {/* X axis labels */}
        {xIsNumeric
          ? xTicks.map(v => (
            <text key={`xl${v}`} x={toX(v)} y={m.top + plotH + 16} textAnchor="middle" fill={axisColor} fontSize={10}>{fmtX(v)}</text>
          ))
          : (() => {
            const maxLabels = Math.max(4, Math.floor(plotW / 60));
            const step = Math.max(1, Math.ceil(data.length / maxLabels));
            return data.filter((_, i) => i % step === 0).map((d, _, arr) => {
              const i = data.indexOf(d);
              return <text key={`xl${i}`} x={dataToX(d, i)} y={m.top + plotH + 16} textAnchor="middle" fill={axisColor} fontSize={10}>{fmtX(d[xKey])}</text>;
            });
          })()
        }
        {xLabel && <text x={m.left + plotW / 2} y={size.h - 2} textAnchor="middle" fill={axisColor} fontSize={11}>{xLabel}</text>}

        {/* Y axis labels */}
        {yTicks.map(v => (
          <text key={`yl${v}`} x={m.left - 6} y={toY(v) + 4} textAnchor="end" fill={axisColor} fontSize={10}>{fmtY(v)}</text>
        ))}
        {yLabel && <text x={14} y={m.top + plotH / 2} textAnchor="middle" fill={axisColor} fontSize={11} transform={`rotate(-90, 14, ${m.top + plotH / 2})`}>{yLabel}</text>}

        {/* Hover crosshair + dot */}
        {hover && (
          <>
            <line x1={hover.cx} x2={hover.cx} y1={m.top} y2={m.top + plotH} stroke={axisColor} strokeWidth={0.5} strokeDasharray="3 3" />
            {series.map(s => {
              const v = data[hover.idx][s.dataKey];
              if (v == null) return null;
              return <circle key={s.dataKey} cx={hover.cx} cy={toY(v)} r={3.5} fill={s.color} stroke="#0f0f14" strokeWidth={1.5} />;
            })}
          </>
        )}

        {/* Legend */}
        {showLegend && (
          <g transform={`translate(${m.left + 8}, ${size.h - legendH + 4})`}>
            {series.map((s, i) => (
              <g key={s.dataKey} transform={`translate(${i * 120}, 0)`}>
                <line x1={0} x2={14} y1={6} y2={6} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '4 2' : undefined} />
                <text x={18} y={10} fill={axisColor} fontSize={10}>{legendLabels?.[s.dataKey] || s.dataKey}</text>
              </g>
            ))}
          </g>
        )}
      </svg>

      {/* Tooltip */}
      {hover && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(hover.cx + 12, size.w - 180),
            top: Math.max(hover.cy - 40, 8),
            background: '#181a25',
            border: '1px solid #2a2d42',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 11,
            color: '#e2e4f0',
            pointerEvents: 'none',
            zIndex: 10,
            minWidth: 100,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {tooltipFormatter ? (
            <div style={{ whiteSpace: 'pre-line' }}>{tooltipFormatter(data[hover.idx])}</div>
          ) : (
            <>
              <div style={{ fontWeight: 600, marginBottom: 2, color: '#8b8fa3' }}>{fmtX(data[hover.idx]?.[xKey])}</div>
              {series.map(s => (
                <div key={s.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
                  <span style={{ color: '#8b8fa3' }}>{legendLabels?.[s.dataKey] || s.dataKey}:</span>
                  <span style={{ fontWeight: 600 }}>{data[hover.idx][s.dataKey]?.toFixed(2) ?? '—'}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
