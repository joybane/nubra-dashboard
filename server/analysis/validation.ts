/**
 * How far the local parquet tree can be trusted, measured against Nubra on every date both hold.
 *
 * Three readings, from rawest to the one that actually matters for this feature:
 *
 *  1. Spot — the tree's `spot` column against the index close, minute by minute.
 *  2. Leg prices — the OTM±2 closes Nubra's own entry selects, read from both sources.
 *  3. Replay — every case found on Nubra data, re-measured on local data at the same two minutes
 *     and the same strikes. This is the question "would the local years report the same ₹ mismatch
 *     for the same moment", which is what deciding whether to include them hinges on.
 *
 * Case-selection overlap (would the top-10 list be the same) is reported too, but it is not part of
 * the verdict: two lists ranked by amount reshuffle on sub-rupee noise even when every amount agrees.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { DEFAULT_FINDER_PARAMS, findCases, pickLegs, type FinderParams } from './caseFinder.ts';
import {
  isEmptyDay,
  minuteIndex,
  round2,
  type DaySeries,
  type DayStore,
  type Grid,
} from './daySeries.ts';

export interface DiffStats {
  n: number;
  meanAbs: number;
  maxAbs: number;
}

export interface DayValidation {
  date: string;
  spot: DiffStats;
  ceStrike: number | null;
  peStrike: number | null;
  ce: DiffStats;
  pe: DiffStats;
  nubraCases: number;
  localCases: number;
  matchedCases: number;
  replayed: number;
  replayMeanAbsDiff: number;
  replayMaxAbsDiff: number;
}

export interface ValidationReport {
  v: 1;
  underlying: string;
  generatedAt: string;
  params: FinderParams;
  from: string | null;
  to: string | null;
  days: number;
  summary: {
    spotMeanAbsMedian: number;
    spotMaxAbsP95: number;
    legMeanAbsMedian: number;
    legMaxAbsP95: number;
    /** Share of minutes where the two sources' leg closes are within ₹0.50. */
    legWithin50PaisePct: number;
    replayCases: number;
    replayAbsDiffMedian: number;
    replayAbsDiffP90: number;
    /** Σ|local Δ − Nubra Δ| / Σ|Nubra Δ| over every replayed case. */
    replayRelativeError: number;
    caseOverlapPct: number;
  };
  verdict: {
    ok: boolean;
    criteria: Array<{ label: string; value: number; limit: number; ok: boolean }>;
  };
  perDay: DayValidation[];
}

/** The limits a report must meet for the local-only years to be included by default. */
export const VERDICT_LIMITS = {
  legMeanAbsMedian: 0.5,
  replayRelativeError: 0.15,
};

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function diff(
  a: Grid | undefined,
  b: Grid | undefined,
  within?: { count: number; total: number },
): DiffStats {
  let n = 0;
  let sum = 0;
  let max = 0;
  if (a && b) {
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x == null || y == null) continue;
      const d = Math.abs(x - y);
      n++;
      sum += d;
      if (d > max) max = d;
      if (within) {
        within.total++;
        if (d <= 0.5) within.count++;
      }
    }
  }
  return { n, meanAbs: n ? round2(sum / n) : 0, maxAbs: round2(max) };
}

export function validateDay(
  nubra: DaySeries,
  local: DaySeries,
  params: FinderParams,
  within: { count: number; total: number },
  replayDiffs: number[],
  replayTotals: { diff: number; base: number },
): DayValidation {
  const spot = diff(nubra.spot, local.spot);
  const legs = pickLegs(nubra, params);
  const ceStrike = typeof legs === 'string' ? null : legs.ceStrike;
  const peStrike = typeof legs === 'string' ? null : legs.peStrike;
  const ce = diff(
    ceStrike == null ? undefined : nubra.ce[String(ceStrike)],
    ceStrike == null ? undefined : local.ce[String(ceStrike)],
    within,
  );
  const pe = diff(
    peStrike == null ? undefined : nubra.pe[String(peStrike)],
    peStrike == null ? undefined : local.pe[String(peStrike)],
    within,
  );

  const scanN = findCases(nubra, params);
  const scanL = findCases(local, params);
  const nCases = scanN.ok ? scanN.cases : [];
  const lCases = scanL.ok ? scanL.cases : [];

  const matched = nCases.filter((c) =>
    lCases.some(
      (l) =>
        Math.abs(minuteIndex(l.t1) - minuteIndex(c.t1)) <= 5 &&
        Math.abs(minuteIndex(l.t2) - minuteIndex(c.t2)) <= 5,
    ),
  ).length;

  let replayed = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  if (scanN.ok) {
    const lce = local.ce[String(scanN.legs.ceStrike)];
    const lpe = local.pe[String(scanN.legs.peStrike)];
    const k = (params.side === 'SELL' ? 1 : -1) * params.qty;
    for (const c of nCases) {
      const i = minuteIndex(c.t1);
      const j = minuteIndex(c.t2);
      const vals = [lce?.[i], lce?.[j], lpe?.[i], lpe?.[j]];
      if (vals.some((v) => v == null)) continue;
      const [c1, c2, p1, p2] = vals as number[];
      const localTotal = (c1 - c2 + (p1 - p2)) * k;
      const d = Math.abs(localTotal - c.totalDelta);
      replayed++;
      sumAbs += d;
      if (d > maxAbs) maxAbs = d;
      replayDiffs.push(d);
      replayTotals.diff += d;
      replayTotals.base += Math.abs(c.totalDelta);
    }
  }

  return {
    date: nubra.date,
    spot,
    ceStrike,
    peStrike,
    ce,
    pe,
    nubraCases: nCases.length,
    localCases: lCases.length,
    matchedCases: matched,
    replayed,
    replayMeanAbsDiff: replayed ? round2(sumAbs / replayed) : 0,
    replayMaxAbsDiff: round2(maxAbs),
  };
}

export function validationFile(store: DayStore, underlying: string): string {
  return path.join(store.dir(underlying), 'validation.json');
}

export async function readValidationReport(
  store: DayStore,
  underlying: string,
): Promise<ValidationReport | null> {
  try {
    return JSON.parse(
      await fs.readFile(validationFile(store, underlying), 'utf8'),
    ) as ValidationReport;
  } catch {
    return null;
  }
}

export async function buildValidationReport(
  store: DayStore,
  underlying: string,
  params: FinderParams = DEFAULT_FINDER_PARAMS,
  onProgress?: (done: number, total: number) => void,
): Promise<ValidationReport> {
  const localDates = new Set(await store.list(underlying, 'local'));
  const dates = (await store.list(underlying, 'nubra')).filter((d) => localDates.has(d));

  const perDay: DayValidation[] = [];
  const within = { count: 0, total: 0 };
  const replayDiffs: number[] = [];
  const replayTotals = { diff: 0, base: 0 };

  for (let n = 0; n < dates.length; n++) {
    onProgress?.(n, dates.length);
    const [nd, ld] = await Promise.all([
      store.read(underlying, 'nubra', dates[n]),
      store.read(underlying, 'local', dates[n]),
    ]);
    if (!nd || !ld || isEmptyDay(nd) || isEmptyDay(ld)) continue;
    perDay.push(validateDay(nd, ld, params, within, replayDiffs, replayTotals));
  }
  onProgress?.(dates.length, dates.length);

  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const spotMeans = sorted(perDay.filter((d) => d.spot.n).map((d) => d.spot.meanAbs));
  const spotMaxes = sorted(perDay.filter((d) => d.spot.n).map((d) => d.spot.maxAbs));
  const legMeans = sorted(
    perDay
      .flatMap((d) => [d.ce, d.pe])
      .filter((s) => s.n)
      .map((s) => s.meanAbs),
  );
  const legMaxes = sorted(
    perDay
      .flatMap((d) => [d.ce, d.pe])
      .filter((s) => s.n)
      .map((s) => s.maxAbs),
  );
  const replay = sorted(replayDiffs);
  const nubraCases = perDay.reduce((s, d) => s + d.nubraCases, 0);
  const matchedCases = perDay.reduce((s, d) => s + d.matchedCases, 0);

  const summary = {
    spotMeanAbsMedian: round2(percentile(spotMeans, 50)),
    spotMaxAbsP95: round2(percentile(spotMaxes, 95)),
    legMeanAbsMedian: round2(percentile(legMeans, 50)),
    legMaxAbsP95: round2(percentile(legMaxes, 95)),
    legWithin50PaisePct: within.total ? round2((100 * within.count) / within.total) : 0,
    replayCases: replay.length,
    replayAbsDiffMedian: round2(percentile(replay, 50)),
    replayAbsDiffP90: round2(percentile(replay, 90)),
    replayRelativeError: replayTotals.base
      ? Math.round((replayTotals.diff / replayTotals.base) * 1000) / 1000
      : 0,
    caseOverlapPct: nubraCases ? round2((100 * matchedCases) / nubraCases) : 0,
  };

  const criteria = [
    {
      label: 'Median per-day mean |leg close difference| (₹)',
      value: summary.legMeanAbsMedian,
      limit: VERDICT_LIMITS.legMeanAbsMedian,
      ok: summary.legMeanAbsMedian <= VERDICT_LIMITS.legMeanAbsMedian,
    },
    {
      label: 'Replay relative error on case ₹ amounts',
      value: summary.replayRelativeError,
      limit: VERDICT_LIMITS.replayRelativeError,
      ok: summary.replayRelativeError <= VERDICT_LIMITS.replayRelativeError,
    },
  ];

  const report: ValidationReport = {
    v: 1,
    underlying,
    generatedAt: new Date().toISOString(),
    params,
    from: perDay[0]?.date ?? null,
    to: perDay[perDay.length - 1]?.date ?? null,
    days: perDay.length,
    summary,
    verdict: { ok: perDay.length > 0 && criteria.every((c) => c.ok), criteria },
    perDay,
  };

  const file = validationFile(store, underlying);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report));
  return report;
}
