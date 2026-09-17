import { describe, expect, it } from 'vitest';
import {
  MISMATCH_COLORS,
  mismatchClock,
  mismatchColor,
  nsToChartMinute,
  strongestVersion,
  upsertMismatchCase,
  type MismatchCaseDto,
} from './mismatchCases';

const version = (t2: number, gap: number) => ({
  t1_ns: 0,
  t2_ns: t2,
  spot1: 0,
  spot2: 0,
  ce1: 0,
  ce2: 0,
  pe1: 0,
  pe2: 0,
  ce_delta: 0,
  pe_delta: 0,
  gap,
});

describe('mismatch case helpers', () => {
  it('maps a tick to the 1-minute chart bar that holds it (IST-baked seconds)', () => {
    const ns = Date.parse('2026-09-16T06:19:23Z') * 1_000_000; // 11:49:23 IST
    const t = nsToChartMinute(ns);
    expect(new Date(t * 1000).toISOString().slice(11, 19)).toBe('11:49:00');
    expect(mismatchClock(ns)).toBe('11:49:23');
  });

  it('colours cycle and never reuse the pin or leg colours', () => {
    expect(mismatchColor(0)).toBe(MISMATCH_COLORS[0]);
    expect(mismatchColor(MISMATCH_COLORS.length + 2)).toBe(MISMATCH_COLORS[2]);
    for (const reserved of ['#38bdf8', '#fb923c', '#22c55e', '#ef4444', '#fbbf24']) {
      expect(MISMATCH_COLORS).not.toContain(reserved);
    }
    expect(new Set(MISMATCH_COLORS).size).toBe(MISMATCH_COLORS.length);
  });

  it('a pushed case replaces its older copy and keeps case order', () => {
    const a: MismatchCaseDto = { case_no: 1, color_idx: 0, versions: [version(1, 10)] };
    const b: MismatchCaseDto = { case_no: 2, color_idx: 1, versions: [version(2, 5)] };
    const a2: MismatchCaseDto = { ...a, versions: [version(1, 10), version(3, 20)] };
    const out = upsertMismatchCase(upsertMismatchCase([b], a), a2);
    expect(out.map((c) => c.case_no)).toEqual([1, 2]);
    expect(strongestVersion(out[0])?.gap).toBe(20);
  });
});
