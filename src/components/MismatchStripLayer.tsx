import { useEffect, useState } from 'react';
import type { IChartApi, UTCTimestamp } from 'lightweight-charts';
import { isChartLive } from '../lib/chartLifecycle';
import {
  mismatchClock,
  mismatchColor,
  nsToChartMinute,
  strongestVersion,
  type MismatchCaseDto,
  type MismatchVersionDto,
} from '../lib/mismatchCases';

interface StripProps {
  cases: MismatchCaseDto[];
  /** The pane's chart. Read-only here. */
  chart: IChartApi | null;
  /** Bump when the chart instance is recreated. */
  epoch?: number;
  activeCase: number | null;
  onPick: (caseNo: number) => void;
}

const STRIP_W = 10;
const STRIP_H = 5;

function inr(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * Live mismatch cases on one pane's time axis: each case is two strips in its own colour, one at the
 * earlier minute and one at the live moment. Clicking either picks the case. Renders nothing when
 * the strategy has no cases, so a pane without the tracker is exactly what it was.
 */
export default function MismatchStripLayer({
  cases,
  chart,
  epoch = 0,
  activeCase,
  onPick,
}: StripProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isChartLive(chart) || cases.length === 0) return;
    let raf: number | null = null;
    const bump = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        setTick((t) => t + 1);
      });
    };
    let ts: ReturnType<IChartApi['timeScale']> | null = null;
    try {
      ts = chart.timeScale();
      ts.subscribeVisibleLogicalRangeChange(bump);
    } catch {
      ts = null;
    }
    const el = chart.chartElement?.();
    const ro = new ResizeObserver(bump);
    if (el) ro.observe(el);
    bump();
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      ro.disconnect();
      try {
        ts?.unsubscribeVisibleLogicalRangeChange(bump);
      } catch {
        /* chart already gone */
      }
    };
  }, [chart, epoch, cases.length]);

  if (cases.length === 0 || !isChartLive(chart)) return null;

  let leftScale = 0;
  try {
    leftScale = chart.priceScale('left').width() ?? 0;
  } catch {
    leftScale = 0;
  }
  const xOf = (ns: number): number | null => {
    try {
      const c = chart.timeScale().timeToCoordinate(nsToChartMinute(ns) as UTCTimestamp);
      return c == null || !Number.isFinite(c) ? null : c + leftScale;
    } catch {
      return null;
    }
  };

  const strips: Array<{ key: string; x: number; c: MismatchCaseDto; v: MismatchVersionDto }> = [];
  for (const c of cases) {
    const v = strongestVersion(c);
    if (!v) continue;
    for (const [end, ns] of [
      ['a', v.t1_ns],
      ['b', v.t2_ns],
    ] as const) {
      const x = xOf(ns);
      if (x != null) strips.push({ key: `${c.case_no}${end}`, x, c, v });
    }
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
      {strips.map(({ key, x, c, v }) => {
        const active = activeCase === c.case_no;
        return (
          <button
            key={key}
            type="button"
            className="absolute pointer-events-auto rounded-sm"
            style={{
              left: x - STRIP_W / 2,
              bottom: 0,
              width: STRIP_W,
              height: active ? STRIP_H + 4 : STRIP_H,
              background: mismatchColor(c.color_idx),
              outline: active ? '1px solid var(--text-primary)' : undefined,
              opacity: activeCase == null || active ? 1 : 0.55,
            }}
            title={`Mismatch #${c.case_no} · ${mismatchClock(v.t1_ns).slice(0, 5)} → ${mismatchClock(
              v.t2_ns,
            )} · PE ${inr(v.pe_delta)} · CE ${inr(v.ce_delta)}`}
            onClick={(e) => {
              e.stopPropagation();
              onPick(c.case_no);
            }}
          />
        );
      })}
    </div>
  );
}

interface CardProps {
  c: MismatchCaseDto;
  /** Index into `c.versions` that is pinned. */
  pinnedVersion: number;
  onPinVersion: (index: number) => void;
  onClose: () => void;
}

/** Every version of one case, newest (strongest) first. Clicking a version pins its two minutes. */
export function MismatchCaseCard({ c, pinnedVersion, onPinVersion, onClose }: CardProps) {
  const color = mismatchColor(c.color_idx);
  const rows = c.versions.map((v, i) => ({ v, i })).reverse();
  return (
    <div
      className="absolute z-50 pointer-events-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card,var(--bg-secondary))] shadow-2xl text-[11px]"
      style={{ top: 8, right: 84, borderLeft: `3px solid ${color}`, maxHeight: '60%', width: 360 }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[var(--border)]">
        <span className="font-semibold" style={{ color }}>
          Mismatch #{c.case_no}
          <span className="ml-2 font-normal text-[var(--text-muted)]">
            {c.versions.length} version{c.versions.length === 1 ? '' : 's'} · recorded tick values
          </span>
        </span>
        <button
          type="button"
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] leading-none text-sm"
          onClick={onClose}
          title="Close this case and its pins"
        >
          ×
        </button>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 'calc(60vh - 40px)' }}>
        <table className="w-full tabular-nums">
          <thead className="text-[10px] text-[var(--text-muted)]">
            <tr>
              <th className="text-left font-normal px-2 py-1">Earlier → live</th>
              <th className="text-right font-normal px-1 py-1">NIFTY</th>
              <th className="text-right font-normal px-1 py-1">PE Δ</th>
              <th className="text-right font-normal px-1 py-1">CE Δ</th>
              <th className="text-right font-normal px-2 py-1">Gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, i }) => (
              <tr
                key={i}
                className={`cursor-pointer hover:bg-[var(--bg-hover)] ${
                  i === pinnedVersion ? 'bg-[var(--bg-hover)]' : ''
                }`}
                onClick={() => onPinVersion(i)}
                title="Pin this version's two minutes"
              >
                <td className="px-2 py-0.5 whitespace-nowrap">
                  {mismatchClock(v.t1_ns).slice(0, 5)} → {mismatchClock(v.t2_ns)}
                  {i === c.versions.length - 1 && (
                    <span className="ml-1 text-[9px] text-[var(--text-muted)]">strongest</span>
                  )}
                </td>
                <td className="px-1 py-0.5 text-right text-[var(--text-secondary)]">
                  {v.spot2.toFixed(2)}
                </td>
                <td
                  className={`px-1 py-0.5 text-right whitespace-nowrap ${v.pe_delta >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
                >
                  {inr(v.pe_delta)}
                </td>
                <td
                  className={`px-1 py-0.5 text-right whitespace-nowrap ${v.ce_delta >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}
                >
                  {inr(v.ce_delta)}
                </td>
                <td className="px-2 py-0.5 text-right font-semibold">{inr(v.gap).slice(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
