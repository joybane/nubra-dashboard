import { useEffect, useMemo, useState } from 'react';
import { PIN_COLORS, type ChartPin } from './chartPins';
import { nsToChartMinute, type MismatchCaseDto } from './mismatchCases';

/**
 * Hovering a row of the Decay cases list shows that case on the chart without picking it: the two
 * pins, the versions card and the highlighted strips a click would produce, standing in for the
 * held ones only while the pointer is on the row. The held pins and pick are never touched, so
 * leaving the row (or the list) puts back exactly what was there — a manual pin pair included.
 */
export interface MismatchPreview {
  /** Same shape as the view's own pick, so the card and strips take it unchanged. */
  pick: { caseNo: number; version: number };
  pins: ChartPin[];
}

/** The strongest reading, as the list row shows it and as a click pins it. */
export function casePreview(c: MismatchCaseDto | undefined): MismatchPreview | null {
  if (!c) return null;
  const version = c.versions.length - 1;
  const v = c.versions[version];
  if (!v) return null;
  return {
    pick: { caseNo: c.case_no, version },
    // Negative ids can never collide with a held pin's (usePinnedTimes counts up from 1).
    pins: [v.t1_ns, v.t2_ns].map((ns, i) => ({
      id: -(i + 1),
      time: nsToChartMinute(ns),
      color: PIN_COLORS[i],
    })),
  };
}

export function useMismatchPreview(cases: MismatchCaseDto[], listOpen: boolean) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Closing the list from outside (a click elsewhere, the ▾) fires no mouseleave from the row under
  // the pointer, so the hover would otherwise outlive the list and resurface the next time it opens.
  useEffect(() => {
    if (!listOpen) setHovered(null);
  }, [listOpen]);
  const preview = useMemo(
    () =>
      listOpen && hovered != null ? casePreview(cases.find((c) => c.case_no === hovered)) : null,
    [cases, hovered, listOpen],
  );
  return { preview, setHovered };
}
