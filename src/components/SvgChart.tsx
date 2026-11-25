import { useEffect, useId, useRef, useState } from 'react';
import { finiteSegments, nearestPointIndex } from '../lib/svgChartGeometry';

type YAxis = 'left' | 'right';

interface Series {
  dataKey: string;
  color: string;
  yAxis?: YAxis;
  strokeWidth?: number | string;
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
export interface SvgChartLinkedHover {
  index: number | null;
  active: boolean;
  onChange: (index: number | null) => void;
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
  xTickSpacing?: number;
  yLabel?: string;
  rightAxis?: { label: string; formatter?: (value: number) => string };
  showLegend?: boolean;
  legendLabels?: Record<string, string>;
  margin?: Partial<{ top: number; right: number; bottom: number; left: number }>;
  gridColor?: string;
  bgColor?: string;
  axisColor?: string;
  frameColor?: string;
  linkedHover?: SvgChartLinkedHover;
}

function niceTicks(min: number, max: number, count: number) {
  const rough = (max - min) / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const ratio = rough / magnitude;
  const step = (ratio <= 1.5 ? 1 : ratio <= 3.5 ? 2 : ratio <= 7.5 ? 5 : 10) * magnitude;
  if (!Number.isFinite(step) || step <= 0) return [];
  const first = Math.ceil(min / step) * step;
  return Array.from(
    { length: Math.min(100, Math.max(0, Math.floor((max - first) / step) + 1)) },
    (_, i) => first + i * step,
  );
}

function paddedDomain([min, max]: [number, number]): [number, number] | undefined {
  if (!Number.isFinite(min)) return undefined;
  const padding = (max - min) * 0.1 || Math.max(Math.abs(min) * 0.01, 1);
  return [min - padding, max + padding];
}

export default function SvgChart({
  data,
  xKey,
  series,
  refLines,
  xFormatter,
  yFormatter,
  tooltipFormatter,
  xLabel,
  xTickSpacing = 95,
  yLabel,
  rightAxis,
  showLegend,
  legendLabels,
  margin,
  gridColor = 'var(--chart-grid)',
  bgColor = 'var(--chart-bg)',
  axisColor = 'var(--text-muted)',
  frameColor,
  linkedHover,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const clipId = useId().replace(/:/g, '');
  const [size, setSize] = useState({ w: 400, h: 300 });
  const [localHoverIndex, setLocalHoverIndex] = useState<number | null>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);
  const [tipSize, setTipSize] = useState({ w: 180, h: 90 });
  const hoverIndex = linkedHover ? linkedHover.index : localHoverIndex;
  const active = linkedHover?.active ?? true;
  const setHoverIndex = linkedHover?.onChange ?? setLocalHoverIndex;
  const clearHover = () => {
    setCursorY(null);
    setHoverIndex(null);
  };
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setTipSize({ w: el.offsetWidth, h: el.offsetHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [active, hoverIndex]);

  const m = {
    top: 18,
    right: rightAxis ? 76 : 24,
    bottom: xLabel ? 46 : 28,
    left: yLabel ? 76 : 64,
    ...margin,
  };
  const plotW = Math.max(0, size.w - m.left - m.right);
  const plotH = Math.max(0, size.h - m.top - m.bottom);
  const numeric = typeof data[0]?.[xKey] === 'number';
  const xs = data.map((d, i) => (numeric ? Number(d[xKey]) : i));
  let xMin = Infinity,
    xMax = -Infinity;
  xs.forEach((x) => {
    if (Number.isFinite(x)) {
      xMin = Math.min(xMin, x);
      xMax = Math.max(xMax, x);
    }
  });
  const extents: Record<YAxis, [number, number]> = {
    left: [Infinity, -Infinity],
    right: [Infinity, -Infinity],
  };
  const axisFor = (s: Series): YAxis => (rightAxis && s.yAxis === 'right' ? 'right' : 'left');
  for (const s of series) {
    const extent = extents[axisFor(s)];
    for (const d of data) {
      const value = d[s.dataKey];
      if (typeof value === 'number' && Number.isFinite(value)) {
        extent[0] = Math.min(extent[0], value);
        extent[1] = Math.max(extent[1], value);
      }
    }
  }
  refLines?.forEach((line) => {
    if (line.axis === 'y' && Number.isFinite(line.value) && Number.isFinite(extents.left[0])) {
      extents.left[0] = Math.min(extents.left[0], line.value);
      extents.left[1] = Math.max(extents.left[1], line.value);
    }
  });
  const domains = { left: paddedDomain(extents.left), right: paddedDomain(extents.right) };
  const hasData = Number.isFinite(xMin) && Boolean(domains.left || domains.right);
  if (xMin === xMax) {
    xMin -= 0.5;
    xMax += 0.5;
  }
  const toX = (value: number) => m.left + ((value - xMin) / (xMax - xMin)) * plotW;
  const toY = (value: number, axis: YAxis = 'left') => {
    const [min, max] = domains[axis] ?? [0, 1];
    return m.top + (1 - (value - min) / (max - min)) * plotH;
  };
  const fmtX =
    xFormatter ||
    ((value: any) =>
      typeof value === 'number'
        ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
        : String(value));
  const fmtY =
    yFormatter || ((value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
  const fmtRightY = rightAxis?.formatter ?? fmtY;
  const xTicks = niceTicks(xMin, xMax, Math.max(2, Math.floor(plotW / xTickSpacing)));
  const yTicks = (axis: YAxis) => {
    const domain = domains[axis];
    return domain ? niceTicks(...domain, Math.max(2, Math.floor(plotH / 55))) : [];
  };
  const hover =
    hoverIndex !== null && data[hoverIndex] && Number.isFinite(xs[hoverIndex]) ? hoverIndex : null;
  const hoverX = hover !== null ? toX(xs[hover]) : 0;
  const horizontalY =
    linkedHover &&
    active &&
    hover !== null &&
    cursorY !== null &&
    cursorY >= m.top &&
    cursorY <= m.top + plotH
      ? cursorY
      : null;
  const tooltipLeft =
    linkedHover && hoverX + 16 + tipSize.w > size.w - 8 ? hoverX - 16 - tipSize.w : hoverX + 16;
  const axisLabels = [yLabel, rightAxis?.label].filter(Boolean).join(' and ');
  const chartLabel =
    (axisLabels || series.map((s) => legendLabels?.[s.dataKey] || s.dataKey).join(', ')) + ' chart';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, position: 'relative', background: bgColor }}
      >
        {!hasData || !plotW || !plotH ? (
          <div
            className="h-full flex items-center justify-center text-[12px] text-[var(--text-muted)]"
            role="status"
          >
            No chart data to display
          </div>
        ) : (
          <>
            <svg
              width={size.w}
              height={size.h}
              role="img"
              aria-label={chartLabel + '. Use left and right arrow keys to inspect points.'}
              tabIndex={0}
              style={{
                display: 'block',
                overflow: 'hidden',
                cursor: linkedHover ? 'crosshair' : undefined,
              }}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left,
                  y = e.clientY - rect.top;
                if (x < m.left || x > m.left + plotW || y < m.top || y > m.top + plotH) {
                  clearHover();
                  return;
                }
                const index = nearestPointIndex(xs, xMin + ((x - m.left) / plotW) * (xMax - xMin));
                if (linkedHover) setCursorY(y);
                setHoverIndex(index < 0 ? null : index);
              }}
              onMouseLeave={clearHover}
              onBlur={clearHover}
              onKeyDown={(e) => {
                if (e.key === 'Escape') clearHover();
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  setCursorY(null);
                  setHoverIndex(
                    Math.max(
                      0,
                      Math.min(
                        data.length - 1,
                        (hover ?? (e.key === 'ArrowRight' ? -1 : data.length)) +
                          (e.key === 'ArrowRight' ? 1 : -1),
                      ),
                    ),
                  );
                }
              }}
            >
              {!linkedHover && <title>{chartLabel}</title>}
              <defs>
                <clipPath id={clipId}>
                  <rect x={m.left} y={m.top} width={plotW} height={plotH} />
                </clipPath>
              </defs>
              {yTicks('left').map((v) => (
                <g key={'y' + v}>
                  <line
                    x1={m.left}
                    x2={m.left + plotW}
                    y1={toY(v)}
                    y2={toY(v)}
                    stroke={gridColor}
                  />
                  <text
                    x={m.left - 10}
                    y={toY(v) + 4}
                    textAnchor="end"
                    fill={axisColor}
                    fontSize={11}
                  >
                    {fmtY(v)}
                  </text>
                </g>
              ))}
              {yTicks('right').map((v) => (
                <g key={'right-y' + v}>
                  <line
                    x1={m.left + plotW}
                    x2={m.left + plotW + 5}
                    y1={toY(v, 'right')}
                    y2={toY(v, 'right')}
                    stroke={axisColor}
                  />
                  <text
                    x={m.left + plotW + 9}
                    y={toY(v, 'right') + 4}
                    fill={axisColor}
                    fontSize={11}
                  >
                    {fmtRightY(v)}
                  </text>
                </g>
              ))}
              {numeric
                ? xTicks.map((v) => (
                    <g key={'x' + v}>
                      <line
                        x1={toX(v)}
                        x2={toX(v)}
                        y1={m.top}
                        y2={m.top + plotH}
                        stroke={gridColor}
                      />
                      <text
                        x={toX(v)}
                        y={m.top + plotH + 20}
                        textAnchor="middle"
                        fill={axisColor}
                        fontSize={11}
                      >
                        {fmtX(v)}
                      </text>
                    </g>
                  ))
                : data.map((d, i) =>
                    i % Math.max(1, Math.ceil(data.length / Math.max(2, plotW / 100))) === 0 ? (
                      <text
                        key={i}
                        x={toX(xs[i])}
                        y={m.top + plotH + 20}
                        textAnchor="middle"
                        fill={axisColor}
                        fontSize={11}
                      >
                        {fmtX(d[xKey])}
                      </text>
                    ) : null,
                  )}
              {frameColor && (
                <rect
                  x={m.left}
                  y={m.top}
                  width={plotW}
                  height={plotH}
                  fill="none"
                  stroke={frameColor}
                  shapeRendering="crispEdges"
                />
              )}
              <g clipPath={'url(#' + clipId + ')'}>
                {refLines
                  ?.filter((r) => Number.isFinite(r.value) && (r.axis === 'x' || domains.left))
                  .map((r, i) => {
                    const horizontal = r.axis === 'y';
                    const x = horizontal ? m.left : toX(r.value),
                      y = horizontal ? toY(r.value) : m.top;
                    return (
                      <g key={i}>
                        <line
                          className="svg-chart-reference-line"
                          x1={x}
                          x2={horizontal ? m.left + plotW : x}
                          y1={y}
                          y2={horizontal ? y : m.top + plotH}
                          stroke={r.color || 'var(--text-muted)'}
                          strokeDasharray={r.dashed ? '5 4' : undefined}
                        />
                        {r.label && (
                          <text
                            className="svg-chart-reference-label"
                            x={horizontal ? m.left + plotW - 5 : x + 5}
                            y={horizontal ? y - 6 : y + 12}
                            textAnchor={horizontal ? 'end' : 'start'}
                            fill={r.labelColor || r.color || axisColor}
                            fontSize={11}
                          >
                            {r.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                {series.map((s) =>
                  finiteSegments(
                    xs,
                    data.map((d) => d[s.dataKey]),
                  ).map((segment, n) => {
                    const axis = axisFor(s);
                    const points = segment
                      .map((i) => toX(xs[i]) + ',' + toY(data[i][s.dataKey], axis))
                      .join(' ');
                    const baseline = Math.min(m.top + plotH, Math.max(m.top, toY(0, axis)));
                    return (
                      <g key={s.dataKey + n}>
                        {s.fill && (
                          <polygon
                            points={
                              toX(xs[segment[0]]) +
                              ',' +
                              baseline +
                              ' ' +
                              points +
                              ' ' +
                              toX(xs[segment[segment.length - 1]]) +
                              ',' +
                              baseline
                            }
                            fill={s.fill}
                          />
                        )}
                        {segment.length === 1 ? (
                          <circle
                            cx={toX(xs[segment[0]])}
                            cy={toY(data[segment[0]][s.dataKey], axis)}
                            r={3}
                            fill={s.color}
                          />
                        ) : (
                          <polyline
                            points={points}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={s.strokeWidth || 2}
                            strokeDasharray={s.dashed ? '6 4' : undefined}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                        )}
                      </g>
                    );
                  }),
                )}
                {hover !== null && (
                  <g>
                    <line
                      x1={hoverX}
                      x2={hoverX}
                      y1={m.top}
                      y2={m.top + plotH}
                      stroke={axisColor}
                      strokeWidth={linkedHover ? 1.5 : undefined}
                      strokeDasharray="4 4"
                    />
                    {horizontalY !== null && (
                      <line
                        x1={m.left}
                        x2={m.left + plotW}
                        y1={horizontalY}
                        y2={horizontalY}
                        stroke={axisColor}
                        strokeWidth={1.5}
                        strokeDasharray="4 4"
                      />
                    )}
                    {series.map((s) => {
                      const v = data[hover][s.dataKey];
                      return typeof v === 'number' && Number.isFinite(v) ? (
                        <circle
                          key={s.dataKey}
                          cx={hoverX}
                          cy={toY(v, axisFor(s))}
                          r={4}
                          fill={s.color}
                          stroke={bgColor}
                          strokeWidth={2}
                        />
                      ) : null;
                    })}
                  </g>
                )}
              </g>
              {xLabel && (
                <text
                  x={m.left + plotW / 2}
                  y={size.h - 5}
                  textAnchor="middle"
                  fill={axisColor}
                  fontSize={11}
                >
                  {xLabel}
                </text>
              )}
              {yLabel && domains.left && (
                <text
                  x={15}
                  y={m.top + plotH / 2}
                  textAnchor="middle"
                  fill={axisColor}
                  fontSize={11}
                  transform={'rotate(-90,15,' + (m.top + plotH / 2) + ')'}
                >
                  {yLabel}
                </text>
              )}
              {rightAxis && domains.right && (
                <text
                  x={size.w - 15}
                  y={m.top + plotH / 2}
                  textAnchor="middle"
                  fill={axisColor}
                  fontSize={11}
                  transform={`rotate(90,${size.w - 15},${m.top + plotH / 2})`}
                >
                  {rightAxis.label}
                </text>
              )}
            </svg>
            {horizontalY !== null &&
              (['left', 'right'] as const).map((axis) => {
                const domain = domains[axis];
                if (!domain) return null;
                const [min, max] = domain;
                const value = max - ((horizontalY - m.top) / plotH) * (max - min);
                const isLeft = axis === 'left';
                return (
                  <span
                    key={axis}
                    aria-hidden="true"
                    data-crosshair-axis={axis}
                    style={{
                      position: 'absolute',
                      top: horizontalY,
                      right: isLeft ? size.w - m.left : undefined,
                      left: isLeft ? undefined : m.left + plotW,
                      transform: 'translateY(-50%)',
                      zIndex: 11,
                      pointerEvents: 'none',
                      padding: '0 4px',
                      border: '1px solid var(--chart-crosshair-border, #8294a9)',
                      borderRadius: 4,
                      background: 'var(--chart-crosshair-bg, #31435a)',
                      color: 'var(--chart-crosshair-text, #fff)',
                      fontSize: 11,
                      fontWeight: 600,
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: '16px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {(isLeft ? fmtY : fmtRightY)(value)}
                  </span>
                );
              })}
            {active && hover !== null && (
              <div
                ref={tooltipRef}
                role="status"
                style={{
                  position: 'absolute',
                  left: Math.max(8, Math.min(tooltipLeft, size.w - tipSize.w - 8)),
                  top: Math.max(8, Math.min(m.top + 8, size.h - tipSize.h - 8)),
                  maxWidth: Math.max(40, size.w - 16),
                  maxHeight: Math.max(40, size.h - 16),
                  overflow: 'hidden',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '9px 12px',
                  fontSize: 12,
                  color: 'var(--text-primary)',
                  pointerEvents: 'none',
                  zIndex: 10,
                  boxShadow: 'var(--shadow-md)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {tooltipFormatter ? (
                  <div style={{ whiteSpace: 'pre-line' }}>{tooltipFormatter(data[hover])}</div>
                ) : (
                  <>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>
                      {fmtX(data[hover][xKey])}
                    </div>
                    {series.map((s) => (
                      <div
                        key={s.dataKey}
                        style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}
                      >
                        <span
                          style={{ width: 7, height: 7, borderRadius: 2, background: s.color }}
                        />
                        <span style={{ color: 'var(--text-secondary)' }}>
                          {legendLabels?.[s.dataKey] || s.dataKey}
                        </span>
                        <strong style={{ marginLeft: 'auto', paddingLeft: 12 }}>
                          {typeof data[hover][s.dataKey] === 'number' &&
                          Number.isFinite(data[hover][s.dataKey])
                            ? (axisFor(s) === 'right' ? fmtRightY : fmtY)(data[hover][s.dataKey])
                            : '—'}
                        </strong>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {showLegend && (
        <div className="svg-chart-legend">
          {series.map((s) => (
            <span key={s.dataKey}>
              <i style={{ background: s.color }} />
              {legendLabels?.[s.dataKey] || s.dataKey}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
