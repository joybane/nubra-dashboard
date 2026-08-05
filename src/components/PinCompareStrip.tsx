import React from 'react';

export interface CompareRow {
  label: string;
  /** pin 2 minus pin 1. */
  value: number;
  kind?: 'money' | 'price' | 'percent' | 'plain';
  digits?: number;
}

function fmtDelta(row: CompareRow): string {
  const { value, kind = 'plain' } = row;
  const digits = row.digits ?? (kind === 'percent' ? 2 : 2);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const num = abs.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (kind === 'money') return `${sign}₹${num}`;
  if (kind === 'percent') return `${sign}${num}%`;
  return `${sign}${num}`;
}

function fmtGap(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * The difference between the two pinned moments, shown once per pane. Deliberately Δ-only —
 * the absolute values live in the pinned cards, and repeating them here would just be noise.
 */
export default function PinCompareStrip({
  dtSeconds,
  rows,
  colors,
}: {
  dtSeconds: number;
  rows: CompareRow[];
  colors: [string, string];
}) {
  if (rows.length === 0) return null;
  // Unpositioned by design: PinnedCrosshairLayer places it midway between the two pinned lines,
  // where it reads as belonging to both of them.
  return (
    <div className="pointer-events-none">
      <div className="flex items-center gap-2 flex-nowrap whitespace-nowrap bg-[#1a1e24]/80 border border-[#ffffff10] rounded-md px-2 py-1 shadow-lg backdrop-blur-md text-[10px]">
        <span className="flex items-center gap-1 font-semibold text-[var(--text-muted)]">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors[0] }} />
          <span>→</span>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: colors[1] }} />
          <span className="ml-0.5 font-mono">{fmtGap(dtSeconds)}</span>
        </span>
        {rows.map((r) => (
          <span key={r.label} className="flex items-center gap-1">
            <span className="text-[var(--text-muted)]">{r.label}</span>
            <span
              className={`font-semibold tabular-nums ${
                r.value >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'
              }`}
            >
              {fmtDelta(r)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
