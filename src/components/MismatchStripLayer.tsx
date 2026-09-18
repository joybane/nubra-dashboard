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
  /**
   * Jump straight to one of the active case's earlier (superseded) versions. Optional: when
   * omitted, the open case's history simply isn't drawn on the axis.
   */
  onPickVersion?: (caseNo: number, versionIdx: number) => void;
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
  onPickVersion,
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
  // Coordinate of a chart-minute (already the IST-baked seconds nsToChartMinute produces), not a
  // raw ns instant — callers round to the minute themselves so cases sharing a minute group up.
  const xOfMinute = (minuteSec: number): number | null => {
    try {
      const c = chart.timeScale().timeToCoordinate(minuteSec as UTCTimestamp);
      return c == null || !Number.isFinite(c) ? null : c + leftScale;
    } catch {
      return null;
    }
  };

  type Member = { c: MismatchCaseDto; v: MismatchVersionDto };
  // Two cases' strongest versions often round to the same chart minute (a live tick every second
  // vs. a 1-minute bar), which would stack their tabs on the identical pixel. Group by minute so
  // a stack renders as one clickable tab that cycles through its members instead of only ever
  // reaching whichever case was drawn last.
  const groups = new Map<number, Member[]>();
  for (const c of cases) {
    const v = strongestVersion(c);
    if (!v) continue;
    for (const ns of [v.t1_ns, v.t2_ns]) {
      const minute = nsToChartMinute(ns);
      const list = groups.get(minute);
      if (list) list.push({ c, v });
      else groups.set(minute, [{ c, v }]);
    }
  }

  const strips: Array<{ key: string; x: number; members: Member[] }> = [];
  for (const [minute, members] of groups) {
    const x = xOfMinute(minute);
    if (x != null) strips.push({ key: String(minute), x, members });
  }

  // The active case's whole trail, so a reading you saw earlier (before a stronger near-copy
  // took over its tab) never just vanishes — it stays as a faint mark you can click back to.
  const activeCaseObj = activeCase != null ? cases.find((c) => c.case_no === activeCase) : undefined;
  const historyTicks: Array<{ key: string; x: number; versionIdx: number }> = [];
  if (activeCaseObj && onPickVersion) {
    const strongestIdx = activeCaseObj.versions.length - 1;
    const seen = new Set<number>();
    activeCaseObj.versions.forEach((v, idx) => {
      if (idx === strongestIdx) return; // already drawn as the bold tab above
      for (const ns of [v.t1_ns, v.t2_ns]) {
        const minute = nsToChartMinute(ns);
        if (seen.has(minute)) continue;
        seen.add(minute);
        const x = xOfMinute(minute);
        if (x != null) historyTicks.push({ key: `hist-${minute}`, x, versionIdx: idx });
      }
    });
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-30 overflow-hidden">
      {activeCaseObj &&
        onPickVersion &&
        historyTicks.map(({ key, x, versionIdx }) => {
          const v = activeCaseObj.versions[versionIdx];
          return (
            <button
              key={key}
              type="button"
              className="absolute pointer-events-auto"
              style={{
                left: x - 3,
                bottom: 0,
                width: 6,
                height: 2,
                background: mismatchColor(activeCaseObj.color_idx),
                opacity: 0.5,
              }}
              title={`Mismatch #${activeCaseObj.case_no} · superseded reading · ${mismatchClock(
                v.t1_ns,
              ).slice(0, 5)} → ${mismatchClock(v.t2_ns)} · gap ${inr(v.gap).slice(1)} — click to view`}
              onClick={(e) => {
                e.stopPropagation();
                onPickVersion(activeCaseObj.case_no, versionIdx);
              }}
            />
          );
        })}
      {strips.map(({ key, x, members }) => {
        const topIdx = members.length - 1;
        const activeIdx = members.findIndex((m) => m.c.case_no === activeCase);
        const shownIdx = activeIdx === -1 ? topIdx : activeIdx;
        const shown = members[shownIdx];
        const active = activeCase === shown.c.case_no;
        const stacked = members.length > 1;
        const baseTitle = `Mismatch #${shown.c.case_no} · ${mismatchClock(shown.v.t1_ns).slice(0, 5)} → ${mismatchClock(
          shown.v.t2_ns,
        )} · PE ${inr(shown.v.pe_delta)} · CE ${inr(shown.v.ce_delta)}`;
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
              background: mismatchColor(shown.c.color_idx),
              outline: active
                ? '1px solid var(--text-primary)'
                : stacked
                  ? '1px dashed rgba(255,255,255,0.6)'
                  : undefined,
              opacity: activeCase == null || active ? 1 : 0.55,
            }}
            title={
              stacked
                ? `${members.length} cases stacked here — showing #${shown.c.case_no} (${
                    shownIdx + 1
                  }/${members.length}), click to cycle · ${baseTitle}`
                : baseTitle
            }
            onClick={(e) => {
              e.stopPropagation();
              const nextIdx = activeIdx === -1 ? topIdx : (activeIdx - 1 + members.length) % members.length;
              onPick(members[nextIdx].c.case_no);
            }}
          >
            {stacked && (
              <span
                className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 text-white leading-none px-1"
                style={{ fontSize: 8 }}
              >
                {members.length}
              </span>
            )}
          </button>
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
