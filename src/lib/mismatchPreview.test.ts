import { describe, expect, it } from 'vitest';
import { PIN_COLORS } from './chartPins';
import { nsToChartMinute, type MismatchCaseDto, type MismatchVersionDto } from './mismatchCases';
import { casePreview } from './mismatchPreview';

const at = (iso: string) => Date.parse(iso) * 1_000_000;

const version = (t1: string, t2: string, gap: number): MismatchVersionDto => ({
  t1_ns: at(t1),
  t2_ns: at(t2),
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

describe('decay case hover preview', () => {
  const c: MismatchCaseDto = {
    case_no: 7,
    color_idx: 3,
    versions: [
      version('2026-09-30T04:00:10Z', '2026-09-30T05:05:00Z', 40),
      version('2026-09-30T04:02:30Z', '2026-09-30T05:12:45Z', 90),
    ],
  };

  it('pins the two instants of the strongest version, as a click would', () => {
    const p = casePreview(c);
    expect(p?.pick).toEqual({ caseNo: 7, version: 1 });
    expect(p?.pins.map((pin) => pin.time)).toEqual([
      nsToChartMinute(c.versions[1].t1_ns),
      nsToChartMinute(c.versions[1].t2_ns),
    ]);
  });

  it('uses the pin slot colours and ids no held pin can have', () => {
    const p = casePreview(c);
    expect(p?.pins.map((pin) => pin.color)).toEqual([PIN_COLORS[0], PIN_COLORS[1]]);
    expect(p?.pins.every((pin) => pin.id < 0)).toBe(true);
    expect(new Set(p?.pins.map((pin) => pin.id)).size).toBe(2);
  });

  it('has nothing to show for an unknown case or one with no readings', () => {
    expect(casePreview(undefined)).toBeNull();
    expect(casePreview({ case_no: 1, color_idx: 0, versions: [] })).toBeNull();
  });
});
