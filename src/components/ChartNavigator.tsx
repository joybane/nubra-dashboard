import { useEffect, useRef, useState } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { OhlcBar } from '../types';
import { indexToTime, MINUTE, timeToIndex } from '../lib/navigatorMath';

/**
 * Overview strip under a chart: the whole loaded history as a thin line, with the chart's visible
 * window drawn on it as a box you can drag, resize and click to jump.
 *
 * Built for the Tracker, whose today-section is 1-second bars. lightweight-charts pans one bar per
 * dragged pixel, so a session there is ~22,000 bars wide and getting from 09:20 to 14:00 zoomed in
 * took dozens of drags. Here the same trip is one drag — and the span buttons set a zoom level
 * directly instead of hunting for it with the wheel.
 *
 * The strip is laid out on the MINUTE grid (`bars`), whatever resolution the chart is showing, so
 * its geometry does not jump when the host swaps 1m and 1s data. All times are the chart's own
 * IST-baked UTCTimestamp seconds.
 */

const EDGE_PX = 6; // grab zone for resizing either side of the window
const MIN_SPAN_SEC = 30;
const SPANS: Array<{ label: string; sec: number }> = [
  { label: '1m', sec: 60 },
  { label: '5m', sec: 5 * 60 },
  { label: '15m', sec: 15 * 60 },
  { label: '30m', sec: 30 * 60 },
  { label: '1h', sec: 60 * 60 },
  { label: '3h', sec: 3 * 60 * 60 },
];
type Scope = 'day' | 'all';

const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

interface Props {
  chart: IChartApi | null;
  /** Minute bars covering everything loaded; read fresh on every paint. */
  bars: () => readonly OhlcBar[];
  /** Bump when `bars` has materially changed (a load, a page of older history). */
  version: number;
}

export default function ChartNavigator({ chart, bars, version }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scope, setScope] = useState<Scope>('day');
  const scopeRef = useRef<Scope>(scope);
  scopeRef.current = scope;
  // The day 'day' scope shows. Follows the view unless a drag is in progress, so the strip does
  // not change under the pointer mid-gesture.
  const dayRef = useRef('');
  const dragRef = useRef<{
    mode: 'move' | 'l' | 'r';
    grabIdx: number;
    from: number;
    to: number;
  } | null>(null);
  // What the last paint laid out, for the pointer handlers to invert.
  const layoutRef = useRef<{ times: number[]; width: number }>({ times: [], width: 0 });

  function visibleRange(): { from: number; to: number } | null {
    if (!chart) return null;
    try {
      const r = chart.timeScale().getVisibleRange();
      if (!r) return null;
      return { from: Number(r.from), to: Number(r.to) };
    } catch {
      return null; // chart already removed
    }
  }

  function domainTimes(): number[] {
    const all: number[] = [];
    for (const b of bars()) if (typeof b.time === 'number') all.push(b.time);
    if (scopeRef.current === 'all' || !all.length) return all;
    const view = visibleRange();
    if (!dragRef.current && view) dayRef.current = dayOf((view.from + view.to) / 2);
    const day = dayRef.current || dayOf(all[all.length - 1]);
    const inDay = all.filter((t) => dayOf(t) === day);
    return inDay.length ? inDay : all;
  }

  function paint() {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(wrap);
    const muted = css.getPropertyValue('--text-muted').trim() || '#707983';
    const border = css.getPropertyValue('--border').trim() || '#262d34';
    const accent = css.getPropertyValue('--blue').trim() || '#4c8dff';

    const times = domainTimes();
    layoutRef.current = { times, width };
    const n = times.length;
    if (!n || width <= 0) return;
    const xOf = (idx: number) => (idx / n) * width;

    // Overview line of closes.
    const closeByTime = new Map<number, number>();
    for (const b of bars()) if (typeof b.time === 'number') closeByTime.set(b.time, b.close);
    let lo = Infinity,
      hi = -Infinity;
    for (const t of times) {
      const c = closeByTime.get(t);
      if (c == null) continue;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    const pad = 4;
    const yOf = (v: number) =>
      hi > lo ? pad + (1 - (v - lo) / (hi - lo)) * (height - 2 * pad) : height / 2;
    ctx.strokeStyle = muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    let prevDay = '';
    for (let i = 0; i < n; i++) {
      const c = closeByTime.get(times[i]);
      if (c == null) continue;
      const day = dayOf(times[i]);
      const x = xOf(i + 0.5);
      if (!started || day !== prevDay) ctx.moveTo(x, yOf(c));
      else ctx.lineTo(x, yOf(c));
      started = true;
      prevDay = day;
    }
    ctx.stroke();

    // Day boundaries + labels, and hour ticks inside a single day.
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillStyle = muted;
    ctx.strokeStyle = border;
    let lastDay = '';
    let lastHour = -1;
    const singleDay = dayOf(times[0]) === dayOf(times[n - 1]);
    for (let i = 0; i < n; i++) {
      const t = times[i];
      const day = dayOf(t);
      const x = xOf(i);
      if (day !== lastDay) {
        if (i > 0) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, height);
          ctx.stroke();
        }
        const d = new Date(t * 1000);
        if (!singleDay)
          ctx.fillText(
            `${d.getUTCDate()} ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`,
            x + 3,
            2,
          );
        lastDay = day;
      }
      if (singleDay) {
        const hour = new Date(t * 1000).getUTCHours();
        if (hour !== lastHour) {
          if (lastHour !== -1) ctx.fillText(`${String(hour).padStart(2, '0')}:00`, x + 3, 2);
          lastHour = hour;
        }
      }
    }

    // The chart's visible window.
    const view = visibleRange();
    if (!view) return;
    const x0 = Math.max(0, xOf(timeToIndex(times, view.from)));
    const x1 = Math.min(width, Math.max(x0 + 2, xOf(timeToIndex(times, view.to))));
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = accent;
    ctx.fillRect(x0, 0, x1 - x0, height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + 0.75, 0.75, Math.max(1, x1 - x0 - 1.5), height - 1.5);
  }

  const paintRef = useRef(paint);
  paintRef.current = paint;

  // Repaint on every view change, data change, resize and theme flip.
  useEffect(() => {
    if (!chart) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        paintRef.current();
      });
    };
    const ts = chart.timeScale();
    ts.subscribeVisibleTimeRangeChange(schedule);
    const ro = new ResizeObserver(schedule);
    if (wrapRef.current) ro.observe(wrapRef.current);
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    schedule();
    return () => {
      try {
        ts.unsubscribeVisibleTimeRangeChange(schedule);
      } catch {
        /* chart already removed */
      }
      ro.disconnect();
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [chart]);

  useEffect(() => {
    paintRef.current();
  }, [version, scope]);

  function setView(from: number, to: number) {
    if (!chart || !(to > from)) return;
    try {
      chart.timeScale().setVisibleRange({ from: from as Time, to: to as Time });
    } catch {
      /* chart removed mid-gesture */
    }
  }

  // ── Pointer: drag the window, drag its edges, or click elsewhere to jump there ──
  function idxAtClientX(clientX: number): number {
    const canvas = canvasRef.current;
    const { times, width } = layoutRef.current;
    if (!canvas || !width || !times.length) return 0;
    const x = clientX - canvas.getBoundingClientRect().left;
    return Math.max(0, Math.min(times.length, (x / width) * times.length));
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const view = visibleRange();
    const { times, width } = layoutRef.current;
    if (!view || !times.length || !width) return;
    const n = times.length;
    const i0 = timeToIndex(times, view.from);
    const i1 = timeToIndex(times, view.to);
    const idx = idxAtClientX(e.clientX);
    const px = (i: number) => (i / n) * width;
    const x = (idx / n) * width;
    let mode: 'move' | 'l' | 'r' = 'move';
    let from = i0,
      to = i1;
    if (Math.abs(x - px(i0)) <= EDGE_PX && px(i1) - px(i0) > 2 * EDGE_PX) mode = 'l';
    else if (Math.abs(x - px(i1)) <= EDGE_PX) mode = 'r';
    else if (x < px(i0) || x > px(i1)) {
      // Jump: centre the window on the click, keeping its width.
      const half = (i1 - i0) / 2;
      from = Math.max(0, Math.min(n - 2 * half, idx - half));
      to = from + 2 * half;
      setView(indexToTime(times, from), indexToTime(times, to));
    }
    dragRef.current = { mode, grabIdx: idx, from, to };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const drag = dragRef.current;
    const { times, width } = layoutRef.current;
    if (!canvas || !times.length) return;
    const n = times.length;
    const idx = idxAtClientX(e.clientX);
    if (!drag) {
      // Cursor hint only.
      const view = visibleRange();
      if (!view) return;
      const px = (i: number) => (i / n) * width;
      const x = (idx / n) * width;
      const x0 = px(timeToIndex(times, view.from));
      const x1 = px(timeToIndex(times, view.to));
      canvas.style.cursor =
        Math.abs(x - x0) <= EDGE_PX || Math.abs(x - x1) <= EDGE_PX
          ? 'ew-resize'
          : x > x0 && x < x1
            ? 'grab'
            : 'pointer';
      return;
    }
    const minSpan = MIN_SPAN_SEC / MINUTE;
    const delta = idx - drag.grabIdx;
    let from = drag.from,
      to = drag.to;
    if (drag.mode === 'move') {
      const span = drag.to - drag.from;
      from = Math.max(0, Math.min(n - span, drag.from + delta));
      to = from + span;
    } else if (drag.mode === 'l') {
      from = Math.max(0, Math.min(drag.to - minSpan, drag.from + delta));
    } else {
      to = Math.min(n, Math.max(drag.from + minSpan, drag.to + delta));
    }
    setView(indexToTime(times, from), indexToTime(times, to));
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    paintRef.current();
  }

  // ── Buttons ──
  function zoomTo(spanSec: number) {
    const view = visibleRange();
    const all = bars();
    if (!view || !all.length) return;
    const first = Number(all[0].time);
    const last = Number(all[all.length - 1].time) + MINUTE;
    // Anchor the right edge when the view is at the live end, otherwise keep the centre.
    const atEnd = view.to >= last - MINUTE;
    let to = atEnd ? last : (view.from + view.to) / 2 + spanSec / 2;
    to = Math.min(last, to);
    const from = Math.max(first, to - spanSec);
    setView(from, Math.max(to, from + MIN_SPAN_SEC));
  }

  /** The visible day's whole session. */
  function zoomDay() {
    const view = visibleRange();
    const all = bars();
    if (!view || !all.length) return;
    const day = dayOf((view.from + view.to) / 2);
    const inDay = all.filter((b) => dayOf(Number(b.time)) === day);
    if (!inDay.length) return;
    setView(Number(inDay[0].time), Number(inDay[inDay.length - 1].time) + MINUTE);
  }

  /** Page left/right by one window width, not past the loaded ends. */
  function page(dir: -1 | 1) {
    const view = visibleRange();
    const all = bars();
    if (!view || !all.length) return;
    // The full minute grid, not the strip's: paging must cross into the previous/next day even
    // while the strip is scoped to one.
    const grid = all.map((b) => Number(b.time));
    const i0 = timeToIndex(grid, view.from);
    const i1 = timeToIndex(grid, view.to);
    const span = i1 - i0;
    const from = Math.max(0, Math.min(grid.length - span, i0 + dir * span));
    setView(indexToTime(grid, from), indexToTime(grid, from + span));
  }

  const btn =
    'px-1.5 h-6 rounded text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]';

  return (
    <div className="h-9 shrink-0 flex items-center gap-1 px-2 border-t border-[var(--border)] bg-[var(--bg-secondary)]">
      <button type="button" className={btn} onClick={() => page(-1)} title="Back one window">
        ◀
      </button>
      <button type="button" className={btn} onClick={() => page(1)} title="Forward one window">
        ▶
      </button>
      <span className="w-px h-4 bg-[var(--border)] mx-1" />
      {SPANS.map((s) => (
        <button
          key={s.label}
          type="button"
          className={btn}
          onClick={() => zoomTo(s.sec)}
          title={`Show ${s.label}`}
        >
          {s.label}
        </button>
      ))}
      <button type="button" className={btn} onClick={zoomDay} title="Show the whole session">
        Day
      </button>
      <span className="w-px h-4 bg-[var(--border)] mx-1" />
      <div ref={wrapRef} className="relative flex-1 h-7 min-w-0 rounded bg-[var(--bg-primary)]">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <button
        type="button"
        className={btn}
        onClick={() => setScope((s) => (s === 'day' ? 'all' : 'day'))}
        title="Strip shows the visible day, or every loaded day — click to switch"
      >
        {scope === 'day' ? 'Strip: day' : 'Strip: all'}
      </button>
    </div>
  );
}
