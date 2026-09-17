/**
 * Client side of the live mismatch tracker (server/mismatchRoutes.ts): shapes, fetches, colours
 * and the chart-time conversion the strategy chart's strips use.
 */
import { IST_OFFSET } from './utils';

export interface MismatchVersionDto {
  /** Start of the earlier minute, epoch ns. */
  t1_ns: number;
  /** The live tick the case was read at, epoch ns. */
  t2_ns: number;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  ce_delta: number;
  pe_delta: number;
  gap: number;
}

export interface MismatchCaseDto {
  case_no: number;
  color_idx: number;
  /** Oldest first; the last is the strongest. */
  versions: MismatchVersionDto[];
}

export interface MismatchTrackerState {
  basket_group_id: string;
  enabled: boolean;
  eligible: boolean;
  reason?: string;
  tracking: boolean;
  case_count: number;
}

/**
 * Case colours. None of them is a pin colour (#38bdf8, #fb923c), the CE green or PE red, or the
 * underlying's amber, so a strip is never mistaken for any of those.
 */
export const MISMATCH_COLORS = [
  '#a78bfa',
  '#f472b6',
  '#2dd4bf',
  '#a3e635',
  '#e879f9',
  '#818cf8',
  '#fde047',
  '#94a3b8',
  '#c2410c',
  '#db2777',
  '#0d9488',
  '#7c3aed',
];

export function mismatchColor(colorIdx: number): string {
  const n = MISMATCH_COLORS.length;
  return MISMATCH_COLORS[((colorIdx % n) + n) % n];
}

/** The strategy chart's 1-minute bar time (IST-baked seconds) that contains an epoch-ns instant. */
export function nsToChartMinute(ns: number): number {
  return Math.floor(ns / 1e9 / 60) * 60 + IST_OFFSET;
}

export function strongestVersion(c: MismatchCaseDto): MismatchVersionDto | undefined {
  return c.versions[c.versions.length - 1];
}

/** IST HH:MM:SS of an epoch-ns instant. */
export function mismatchClock(ns: number): string {
  return new Date(ns / 1e6 + IST_OFFSET * 1000).toISOString().slice(11, 19);
}

/** Insert or replace a case pushed over the socket, keeping case order. */
export function upsertMismatchCase(
  cases: MismatchCaseDto[],
  incoming: MismatchCaseDto,
): MismatchCaseDto[] {
  const rest = cases.filter((c) => c.case_no !== incoming.case_no);
  return [...rest, incoming].sort((a, b) => a.case_no - b.case_no);
}

export async function fetchMismatchCases(
  basketGroupId: string,
  signal?: AbortSignal,
): Promise<MismatchCaseDto[]> {
  const res = await fetch(
    `/paper/mismatch/cases?basket_group_id=${encodeURIComponent(basketGroupId)}`,
    { signal },
  );
  if (!res.ok) return [];
  const d = (await res.json()) as { cases?: MismatchCaseDto[] };
  return d.cases ?? [];
}

export async function fetchMismatchTrackers(): Promise<MismatchTrackerState[]> {
  const res = await fetch('/paper/mismatch/trackers');
  if (!res.ok) return [];
  const d = (await res.json()) as { trackers?: MismatchTrackerState[] };
  return d.trackers ?? [];
}

export async function setMismatchTracker(
  basketGroupId: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/paper/mismatch/trackers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ basket_group_id: basketGroupId, enabled }),
    });
    if (res.ok) return { ok: true };
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: d.error || `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
