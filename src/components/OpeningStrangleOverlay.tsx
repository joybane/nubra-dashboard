import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  OPENING_SESSION_MINUTES,
  formatPnl,
  openingTime,
  type OpeningGrid,
  type OpeningUnit,
} from '../lib/openingStrangle';

export interface OpeningOverlayPath {
  date: string;
  values: OpeningGrid;
  color: string;
}

export interface OpeningOverlayRange {
  median: OpeningGrid;
  p10: OpeningGrid;
  p90: OpeningGrid;
}

type Viewport = { width: number; height: number };
const FULL_OFFSETS = { left: 75, right: 18, top: 14, bottom: 30 };
const COMPACT_OFFSETS = { left: 72, right: 12, top: 12, bottom: 26 };
const LAST_MINUTE = OPENING_SESSION_MINUTES - 1;
const X_TICKS = [0, 45, 105, 165, 225, 285, 345, LAST_MINUTE];
const COMPACT_X_TICKS = [0, 105, 225, LAST_MINUTE];

export type OpeningOverlayExtent = { low: number; high: number };

export function openingOverlayExtent(paths: OpeningOverlayPath[]): OpeningOverlayExtent {
  let low = 0;
  let high = 0;
  for (const { values } of paths) {
    for (const value of values) {
      if (value == null) continue;
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  return { low, high };
}

function plotGeometry(size: Viewport, { low, high }: OpeningOverlayExtent, compact: boolean) {
  const offsets = compact ? COMPACT_OFFSETS : FULL_OFFSETS;
  const padding = (high - low) * 0.06 || 1;
  const minimum = low - padding;
  const maximum = high + padding;
  const width = Math.max(1, size.width - offsets.left - offsets.right);
  const height = Math.max(1, size.height - offsets.top - offsets.bottom);
  return {
    minimum,
    maximum,
    width,
    height,
    offsets,
    x: (minute: number) => offsets.left + (width * minute) / LAST_MINUTE,
    y: (value: number) => offsets.top + (height * (maximum - value)) / (maximum - minimum),
  };
}

type Plot = ReturnType<typeof plotGeometry>;

function trace(ctx: CanvasRenderingContext2D, plot: Plot, values: OpeningGrid) {
  let length = 0;
  let lastX = 0;
  let lastY = 0;
  ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value == null) {
      if (length === 1) ctx.lineTo(lastX + 0.75, lastY);
      length = 0;
      continue;
    }
    const x = plot.x(i);
    const y = plot.y(value);
    if (length > 0) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    length++;
    lastX = x;
    lastY = y;
  }
  if (length === 1) ctx.lineTo(lastX + 0.75, lastY);
  ctx.stroke();
}

function draw(
  canvas: HTMLCanvasElement,
  size: Viewport,
  plot: Plot,
  paths: OpeningOverlayPath[],
  range: OpeningOverlayRange | undefined,
  unit: OpeningUnit,
  compact: boolean,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx || size.width === 0 || size.height === 0) return;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  const style = getComputedStyle(canvas);
  const color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
  const axis = color('--text-muted', '#a4aec3');
  const text = color('--text-primary', '#eff3ff');
  const grid = color('--border', '#343c4e');
  const { left, top } = plot.offsets;
  ctx.font = '11px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  ctx.fillStyle = axis;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridSteps = compact ? 3 : 5;
  for (let i = 0; i <= gridSteps; i++) {
    const value = plot.minimum + ((plot.maximum - plot.minimum) * i) / gridSteps;
    const y = plot.y(value);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plot.width, y);
    ctx.stroke();
    if (Math.abs(y - plot.y(0)) > 12) ctx.fillText(formatPnl(value, unit), left - 7, y);
  }
  ctx.textBaseline = 'top';
  const ticks = compact || size.width < 480 ? COMPACT_X_TICKS : X_TICKS;
  for (const minute of ticks) {
    const x = plot.x(minute);
    ctx.textAlign = minute === 0 ? 'left' : minute === LAST_MINUTE ? 'right' : 'center';
    ctx.fillText(openingTime(minute), x, top + plot.height + 9);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, plot.width, plot.height);
  ctx.clip();
  ctx.lineWidth = compact ? 0.65 : 0.75;
  ctx.globalAlpha = paths.length > 700 ? 0.105 : paths.length > 220 ? 0.14 : 0.24;
  for (const path of paths) {
    ctx.strokeStyle = path.color;
    trace(ctx, plot, path.values);
  }

  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = axis;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, plot.y(0));
  ctx.lineTo(left + plot.width, plot.y(0));
  ctx.stroke();
  if (range) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = text;
    ctx.setLineDash([2, 5]);
    trace(ctx, plot, range.p10);
    trace(ctx, plot, range.p90);
    ctx.setLineDash([]);
    ctx.lineWidth = 1.75;
    trace(ctx, plot, range.median);
  }
  ctx.restore();
  ctx.fillStyle = text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatPnl(0, unit), left - 7, plot.y(0));
}

export default function OpeningStrangleOverlay({
  paths,
  range,
  unit,
  onOpen,
  label,
  mode = 'full',
  extent,
}: {
  paths: OpeningOverlayPath[];
  range?: OpeningOverlayRange;
  unit: OpeningUnit;
  onOpen: (date: string) => void;
  label: string;
  mode?: 'full' | 'compact';
  extent?: OpeningOverlayExtent;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<Viewport>({ width: 0, height: 0 });
  const [themeRevision, setThemeRevision] = useState(0);
  const [hover, setHover] = useState<{
    date: string;
    minute: number;
    value: number;
    color: string;
  }>();
  const compact = mode === 'compact';
  const bounds = useMemo(() => extent ?? openingOverlayExtent(paths), [extent, paths]);
  const plot = useMemo(() => plotGeometry(size, bounds, compact), [size, bounds, compact]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    resize.observe(element);
    const theme = new MutationObserver(() => setThemeRevision((value) => value + 1));
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const frame = window.requestAnimationFrame(() =>
      draw(element, size, plot, paths, range, unit, compact),
    );
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [size, plot, paths, range, unit, compact, themeRevision]);

  function nearest(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const { left, top } = plot.offsets;
    if (x < left || x > left + plot.width || y < top || y > top + plot.height) return undefined;
    const minute = Math.round(((x - left) * LAST_MINUTE) / plot.width);
    let closest: typeof hover;
    let minDistance = 16;
    for (const path of paths) {
      const value = path.values[minute];
      if (value == null) continue;
      const distance = Math.abs(plot.y(value) - y);
      if (distance < minDistance) {
        minDistance = distance;
        closest = { date: path.date, value, minute, color: path.color };
      }
    }
    return closest;
  }

  const active =
    hover &&
    paths.some((path) => path.date === hover.date && path.values[hover.minute] === hover.value)
      ? hover
      : undefined;
  return (
    <div className="relative mt-2 overflow-hidden rounded bg-[var(--chart-bg)]">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`${label}, ${paths.length} session curves. Use the trade tables to open any date.`}
        className={`block w-full cursor-crosshair ${compact ? 'h-[12rem]' : 'h-[25rem]'}`}
        onPointerMove={(event) => setHover(nearest(event))}
        onPointerLeave={() => setHover(undefined)}
        onPointerUp={(event) => {
          const point = nearest(event);
          if (point) onOpen(point.date);
        }}
      />
      {active && (
        <>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute h-2.5 w-2.5 rounded-full border-2 border-[var(--text-primary)]"
            style={{
              left: plot.x(active.minute) - 5,
              top: plot.y(active.value) - 5,
              background: active.color,
            }}
          />
          <div
            className="pointer-events-none absolute z-10 rounded border border-[var(--border)] bg-[var(--bg-card)] px-2 py-1 text-xs tabular-nums shadow"
            style={{
              left: Math.max(5, Math.min(size.width - 163, plot.x(active.minute) + 8)),
              top: Math.max(3, plot.y(active.value) - 43),
            }}
          >
            <b>{active.date}</b> · {openingTime(active.minute)} IST
            <br />
            {formatPnl(active.value, unit)} · click to open
          </div>
        </>
      )}
    </div>
  );
}
