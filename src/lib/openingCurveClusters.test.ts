import { describe, expect, it } from 'vitest';
import { clusterOpeningCurves, type OpeningCurveSession } from './openingCurveClusters';
import { OPENING_SESSION_MINUTES } from './openingStrangle';

function sessions(
  count: number,
  value: (minute: number, session: number) => number,
): OpeningCurveSession[] {
  return Array.from({ length: count }, (_, i) => ({
    date: `2025-01-${`${i + 1}`.padStart(2, '0')}`,
    entry: 0,
    entryCredit: 100,
    pnl: Array.from({ length: OPENING_SESSION_MINUTES }, (_, minute) => value(minute, i)),
  }));
}

function twoDips() {
  return sessions(24, (minute, i) => {
    const middle = i < 12 ? 105 : 270;
    return -Math.max(0, (68 + (i % 3)) * (1 - Math.abs(minute - middle) / 65));
  });
}

describe('similar opening P&L curves', () => {
  it('separates early and late dips despite an identical close', () => {
    const rows = twoDips();
    const groups = clusterOpeningCurves(rows);
    expect(groups.map(({ dates }) => dates)).toEqual([
      rows.slice(0, 12).map(({ date }) => date),
      rows.slice(12).map(({ date }) => date),
    ]);
    for (const { dates, representative } of groups) expect(dates).toContain(representative);
  });

  it('groups similar timed paths without labels and is stable under input order and credit scale', () => {
    const rows = twoDips();
    const scaled = rows.map((row, i) => {
      const factor = i % 2 ? 5 : 1;
      return {
        ...row,
        entryCredit: factor * row.entryCredit,
        pnl: row.pnl.map((p) => (p == null ? null : factor * p)),
      };
    });
    expect(clusterOpeningCurves(scaled.reverse())).toEqual(clusterOpeningCurves(rows));
  });

  it('keeps a close cohort together when it cannot support a separate outlier group', () => {
    expect(
      clusterOpeningCurves(sessions(24, (minute, i) => minute * (i === 23 ? 3 : 0.0001 * i))),
    ).toEqual([]);
    expect(
      clusterOpeningCurves(
        sessions(24, (minute, i) => minute * 0.01 + Math.sin(i + minute) * 0.02),
      ),
    ).toEqual([]);
    expect(clusterOpeningCurves(twoDips().slice(0, 23))).toEqual([]);
  });

  it('omits sparse windows when there is enough shared coverage and rejects invalid rows', () => {
    const rows = twoDips();
    const baseline = clusterOpeningCurves(rows);
    for (const row of rows) row.pnl.fill(null, 45, 60);
    expect(clusterOpeningCurves(rows).map(({ dates }) => dates)).toEqual(
      baseline.map(({ dates }) => dates),
    );
    const invalid = [
      { ...rows[0], date: '2025-02-01', entryCredit: 0 },
      { ...rows[0], date: '2025-02-02', pnl: [...rows[0].pnl.slice(0, -1), null] },
      { ...rows[0], date: '2025-02-03', pnl: rows[0].pnl.map((mark, i) => (i < 70 ? null : mark)) },
    ];
    expect(clusterOpeningCurves([...rows, ...invalid]).flatMap(({ dates }) => dates)).toHaveLength(
      rows.length,
    );
  });
});
